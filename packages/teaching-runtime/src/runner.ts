/**
 * Scenario executor: mounts a composition on a fresh Cordis root, runs the
 * scenario steps in order, and records everything through one Recorder.
 * See docs/02-technical-architecture.md §5.2, §8 and §9.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Fiber, Plugin } from '@deepseek-ai/cordis'
import { TraceName } from '@harness-explorer/contracts'
import type {
  AdapterMode,
  Composition,
  ExecutableStageDefinition,
  ModelScript,
  PluginInstance,
  RunOutcome,
  Scenario,
  ScenarioStep,
} from '@harness-explorer/contracts'
import { ROOT_SCOPE, withScopeChain } from '@harness-explorer/teaching-plugins'
import { Recorder } from '@harness-explorer/trace'
import type { RecorderOptions } from '@harness-explorer/trace'
import { Observer } from './observe.ts'
import { importStageLoader } from './stages.ts'
import type { StageLoader } from './stages.ts'

export interface RunInput {
  runId: string
  composition: Composition
  scenario: Scenario
  modelScripts: Readonly<Record<string, ModelScript>>
  stages: readonly ExecutableStageDefinition[]
  adapterMode: AdapterMode
  loadStage?: StageLoader
  signal?: AbortSignal
  limits?: Pick<RecorderOptions, 'maxRecords' | 'maxPayloadBytes'>
  onRecord?: RecorderOptions['onRecord']
}

export interface RunResult {
  outcome: Exclude<RunOutcome, 'running' | 'interrupted'>
  recorder: Recorder
  error: { name: string; message: string } | null
}

/** Plugin definition whose config receives the scenario's model script. */
export const SCRIPTED_ADAPTER_DEFINITION = 'llm-scripted'

export class CompositionError extends Error {
  override name = 'CompositionError'
}

/** Static checks that do not need to run any plugin code (docs/02 §7). */
export function validateComposition(composition: Composition, scenario: Scenario, stages: readonly ExecutableStageDefinition[]) {
  const stageById = new Map(stages.map(stage => [stage.id, stage]))
  const instanceIds = new Set<string>()
  const scopeIds = new Set(composition.scopes.map(scope => scope.id))
  if (!scopeIds.has(ROOT_SCOPE)) throw new CompositionError(`composition has no "${ROOT_SCOPE}" scope`)
  for (const instance of composition.instances) {
    if (instanceIds.has(instance.id)) throw new CompositionError(`duplicate instance id "${instance.id}"`)
    instanceIds.add(instance.id)
    const stage = stageById.get(instance.stageId)
    if (!stage) throw new CompositionError(`instance "${instance.id}" uses unknown executable stage "${instance.stageId}"`)
    if (stage.pluginDefinitionId !== instance.definitionId) {
      throw new CompositionError(`instance "${instance.id}" stage "${stage.id}" belongs to "${stage.pluginDefinitionId}", not "${instance.definitionId}"`)
    }
    if (!scopeIds.has(instance.scopeId)) throw new CompositionError(`instance "${instance.id}" uses unknown scope "${instance.scopeId}"`)
  }
  for (const instance of composition.instances) {
    if (instance.parentId !== null && !instanceIds.has(instance.parentId)) {
      throw new CompositionError(`instance "${instance.id}" has unknown parent "${instance.parentId}"`)
    }
    const seen = new Set<string>()
    for (let cursor: PluginInstance | undefined = instance; cursor?.parentId; cursor = composition.instances.find(i => i.id === cursor!.parentId)) {
      if (seen.has(cursor.id)) throw new CompositionError(`plugin tree has a cycle through "${instance.id}"`)
      seen.add(cursor.id)
    }
  }
  for (const step of scenario.steps) {
    if ((step.kind === 'mount' || step.kind === 'unmount') && !instanceIds.has(step.instanceId)) {
      throw new CompositionError(`scenario step "${step.id}" references unknown instance "${step.instanceId}"`)
    }
  }
}

function scopeChain(composition: Composition, scopeId: string): string[] {
  const chain: string[] = []
  for (let id: string | null = scopeId; id !== null;) {
    if (chain.includes(id)) throw new CompositionError(`scope tree has a cycle through "${scopeId}"`)
    chain.unshift(id)
    id = composition.scopes.find(scope => scope.id === id)?.parentId ?? null
  }
  return chain
}

/** Let Cordis finish activation and disposal chains before the next step. */
const settle = async () => {
  for (let index = 0; index < 3; index++) await new Promise(resolve => setImmediate(resolve))
}

export async function runScenario(input: RunInput): Promise<RunResult> {
  const { composition, scenario, stages } = input
  validateComposition(composition, scenario, stages)

  // Deterministic virtual clock: one tick per record, independent of wall time.
  let tick = 0
  const recorder = new Recorder({
    runId: input.runId,
    now: input.adapterMode === 'deterministic' ? () => tick++ : (() => { const start = performance.now(); return () => Math.round(performance.now() - start) })(),
    ...input.limits,
    ...input.onRecord ? { onRecord: input.onRecord } : {},
  })
  const loadStage = input.loadStage ?? importStageLoader
  const stageById = new Map(stages.map(stage => [stage.id, stage]))
  const plugins = new Map<string, Plugin>()
  for (const instance of composition.instances) {
    if (!plugins.has(instance.stageId)) plugins.set(instance.stageId, await loadStage(stageById.get(instance.stageId)!))
  }

  const root = new Context()
  const observer = new Observer(root, recorder, new Set(stages.flatMap(stage => stage.provides)))
  const fibers = new Map<string, Fiber>()

  const configFor = (instance: PluginInstance) => {
    if (instance.definitionId !== SCRIPTED_ADAPTER_DEFINITION) return instance.config
    const script = scenario.modelScriptId ? input.modelScripts[scenario.modelScriptId] : undefined
    if (!script) throw new CompositionError(`scenario "${scenario.id}" has no model script for "${instance.id}"`)
    return { ...(instance.config as object), script }
  }

  const mount = (instance: PluginInstance) => {
    if (fibers.has(instance.id)) throw new Error(`instance "${instance.id}" is already mounted`)
    const parent = instance.parentId ? fibers.get(instance.parentId)?.ctx : root
    if (!parent) throw new Error(`parent "${instance.parentId}" of "${instance.id}" is not mounted`)
    const ctx = withScopeChain(parent, scopeChain(composition, instance.scopeId))
    const fiber = observer.mount(instance.id, () => ctx.plugin(plugins.get(instance.stageId)!, configFor(instance)))
    fibers.set(instance.id, fiber)
  }

  const unmount = async (instanceId: string) => {
    const fiber = fibers.get(instanceId)
    if (!fiber) throw new Error(`instance "${instanceId}" is not mounted`)
    fibers.delete(instanceId)
    await fiber.dispose()
  }

  const runStep = async (step: ScenarioStep) => {
    switch (step.kind) {
      case 'input': {
        const agentLoop = root.get('agentLoop')
        if (!agentLoop) throw new Error('agentLoop is not active; check the plugin tree for missing services')
        await agentLoop.submit(step.sessionId, step.text, input.signal)
        break
      }
      case 'mount':
        mount(composition.instances.find(instance => instance.id === step.instanceId)!)
        break
      case 'unmount':
        await unmount(step.instanceId)
        break
      case 'snapshot':
        break
      case 'cancel':
        throw new Error('cancel steps are not supported by this runtime version')
    }
  }

  let outcome: RunResult['outcome'] = 'completed'
  let error: RunResult['error'] = null
  try {
    for (const instance of composition.instances) {
      if (instance.enabled) mount(instance)
    }
    await settle()
    for (const step of scenario.steps) {
      input.signal?.throwIfAborted()
      observer.currentStepId = step.id
      recorder.record({ kind: 'checkpoint', name: TraceName.scenarioStep, scenarioStepId: step.id, payload: step })
      await runStep(step)
      await settle()
    }
  } catch (reason) {
    outcome = input.signal?.aborted ? 'cancelled' : 'failed'
    error = reason instanceof Error ? { name: reason.name, message: reason.message } : { name: 'Error', message: String(reason) }
    recorder.record({ kind: 'diagnostic', name: TraceName.diagnostic, payload: { level: 'error', message: `${error.name}: ${error.message}` } })
  } finally {
    observer.currentStepId = undefined
    // Run settlement: unload in reverse mount order so cleanup is recorded.
    try {
      for (const instanceId of [...fibers.keys()].reverse()) await unmount(instanceId)
      await settle()
    } catch (reason) {
      outcome = 'failed'
      error ??= { name: 'CleanupError', message: reason instanceof Error ? reason.message : String(reason) }
      recorder.record({ kind: 'diagnostic', name: TraceName.diagnostic, payload: { level: 'error', message: `cleanup failed: ${error.message}` } })
    }
    observer.dispose()
  }
  return { outcome, recorder, error }
}
