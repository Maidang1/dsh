/**
 * Scenario executor: mounts a composition on a fresh Cordis root, runs the
 * scenario steps against the upstream agent kernel, and records everything
 * through one Recorder. See docs/02-technical-architecture.md §5.2, §8 and §9.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Fiber, Plugin } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ROOT_SCOPE, TraceName, unsupportedConfigKeys } from '@harness-explorer/contracts'
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
import { SCRIPTED_PROVIDER, UPSTREAM_VERSION } from '@harness-explorer/teaching-plugins'
import { Recorder } from '@harness-explorer/trace'
import type { RecorderOptions } from '@harness-explorer/trace'
import { useSeededRandomness } from './determinism.ts'
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
  /** Turn observation off entirely (OBS-01); the trace then holds only scenario checkpoints. */
  observe?: boolean
  /** Inspect the live Cordis root after the scenario and before settlement (tests only). */
  beforeSettle?: (root: Context) => void
}

export interface RunResult {
  outcome: Exclude<RunOutcome, 'running' | 'interrupted'>
  recorder: Recorder
  error: { name: string; message: string } | null
}

/** Plugin definition whose config receives the scenario's model script. */
export const SCRIPTED_ADAPTER_DEFINITION = 'llm-scripted'
/** Real-mode replacement for the scripted adapter: upstream's DeepSeek API-key provider. */
export const REAL_ADAPTER_STAGE = { definitionId: 'llm-deepseek', stageId: `llm-deepseek@${UPSTREAM_VERSION}` } as const
/** The provider route `@deepseek-ai/dsh-llm-deepseek-api-key` registers, and its first default model. */
export const REAL_PROVIDER = 'deepseek-official'
export const REAL_MODEL = 'deepseek-flash'

/**
 * The composition a run actually executes. In real mode every scripted
 * adapter instance becomes the real adapter, keeping its id, scope and place;
 * the run manifest records the swap through adapterMode and loaded stages.
 */
export function compositionForMode(composition: Composition, mode: AdapterMode): Composition {
  if (mode === 'deterministic') return composition
  return {
    ...composition,
    instances: composition.instances.map(instance => instance.definitionId === SCRIPTED_ADAPTER_DEFINITION
      ? { ...instance, ...REAL_ADAPTER_STAGE, config: {} }
      : instance),
  }
}

/**
 * Cordis validates values against a stage's `Config` schema but keeps keys the
 * schema does not name. The explorer refuses those instead (docs/02 §8): a
 * typo or an option of another version would otherwise be silently ignored.
 */
function checkConfigKeys(instance: PluginInstance, plugin: Plugin) {
  const schema = (plugin as { Config?: { type?: string; dict?: Record<string, unknown> } }).Config
  if (schema && (schema.type !== 'object' || !schema.dict)) return
  checkSupportedKeys(instance, Object.keys(schema?.dict ?? {}))
}

function checkSupportedKeys(instance: PluginInstance, supported: readonly string[]) {
  const unsupported = unsupportedConfigKeys(instance.config, supported)
  if (unsupported.length) {
    throw new CompositionError(`instance "${instance.id}" (${instance.stageId}) does not support config ${unsupported.map(key => `"${key}"`).join(', ')}; supported: ${supported.join(', ') || 'none'}`)
  }
}

export class CompositionError extends Error {
  override name = 'CompositionError'
}

export class CleanupError extends Error {
  override name = 'CleanupError'
}

export class TraceLimitError extends Error {
  override name = 'TraceLimitError'
}

/** A turn the upstream loop ended with an error; the scenario cannot continue as written. */
export class TurnError extends Error {
  override name = 'TurnError'
}

/** The scope whose agent serves `sessionId`: the one that lists it, else root. */
export function sessionScope(composition: Composition, sessionId: string): string {
  return composition.scopes.find(scope => scope.sessions?.includes(sessionId))?.id ?? ROOT_SCOPE
}

/** Static checks that do not need to run any plugin code (docs/02 §7). */
export function validateComposition(composition: Composition, scenario: Scenario, stages: readonly ExecutableStageDefinition[]) {
  const stageById = new Map(stages.map(stage => [stage.id, stage]))
  const instanceIds = new Set<string>()
  const scopeIds = new Set(composition.scopes.map(scope => scope.id))
  if (!scopeIds.has(ROOT_SCOPE)) throw new CompositionError(`composition has no "${ROOT_SCOPE}" scope`)
  const sessionOwners = new Map<string, string>()
  for (const scope of composition.scopes) {
    // scopeChain would otherwise end the chain at a missing parent and treat the scope as top-level.
    if (scope.parentId !== null && !scopeIds.has(scope.parentId)) throw new CompositionError(`scope "${scope.id}" has unknown parent "${scope.parentId}"`)
    if (scope.id === ROOT_SCOPE && scope.parentId !== null) throw new CompositionError(`scope "${ROOT_SCOPE}" cannot have a parent`)
    scopeChain(composition, scope.id)
    for (const session of scope.sessions ?? []) {
      const owner = sessionOwners.get(session)
      if (owner !== undefined) throw new CompositionError(`session "${session}" is listed by both scope "${owner}" and scope "${scope.id}"`)
      sessionOwners.set(session, scope.id)
    }
  }
  for (const instance of composition.instances) {
    if (instanceIds.has(instance.id)) throw new CompositionError(`duplicate instance id "${instance.id}"`)
    instanceIds.add(instance.id)
    const stage = stageById.get(instance.stageId)
    if (!stage) throw new CompositionError(`instance "${instance.id}" uses unknown executable stage "${instance.stageId}"`)
    if (stage.pluginDefinitionId !== instance.definitionId) {
      throw new CompositionError(`instance "${instance.id}" stage "${stage.id}" belongs to "${stage.pluginDefinitionId}", not "${instance.definitionId}"`)
    }
    if (!scopeIds.has(instance.scopeId)) throw new CompositionError(`instance "${instance.id}" uses unknown scope "${instance.scopeId}"`)
    // Built stages carry their config keys, so a draft is refused before it becomes a revision.
    if (stage.configKeys) checkSupportedKeys(instance, stage.configKeys)
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
    // A child context inherits its parent's scope tag, so it can only narrow into a nested scope.
    const parent = composition.instances.find(item => item.id === instance.parentId)
    if (parent && !scopeChain(composition, instance.scopeId).includes(parent.scopeId)) {
      throw new CompositionError(`instance "${instance.id}" is in scope "${instance.scopeId}", outside the scope "${parent.scopeId}" of its parent "${parent.id}"`)
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

const errorOf = (reason: unknown) => (reason instanceof Error ? { name: reason.name, message: reason.message } : { name: 'Error', message: String(reason) })

export async function runScenario(input: RunInput): Promise<RunResult> {
  const { scenario, stages } = input
  const composition = compositionForMode(input.composition, input.adapterMode)
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
    checkConfigKeys(instance, plugins.get(instance.stageId)!)
  }

  const script = scenario.modelScriptId ? input.modelScripts[scenario.modelScriptId] : undefined
  const agentOptions: AgentOptions = input.adapterMode === 'deterministic'
    ? { provider: SCRIPTED_PROVIDER, model: script?.id ?? 'unscripted' }
    : { provider: REAL_PROVIDER, model: REAL_MODEL }

  // Each composition scope is an upstream scope key; nested scopes link to their parent once.
  const scopeKeys = new Map(composition.scopes.filter(scope => scope.id !== ROOT_SCOPE).map(scope => [scope.id, { scopeId: scope.id }]))
  for (const scope of composition.scopes) {
    if (scope.parentId !== null && scope.parentId !== ROOT_SCOPE) bindScopeParent(scopeKeys.get(scope.id)!, scopeKeys.get(scope.parentId)!)
  }

  const root = new Context()
  const observer = new Observer(root, recorder, new Set(stages.flatMap(stage => stage.provides)), input.observe ?? true, scopeKeys)
  const fibers = new Map<string, Fiber>()
  const agents = new Map<string, AgentHandle>()

  const configFor = (instance: PluginInstance) => {
    if (instance.definitionId !== SCRIPTED_ADAPTER_DEFINITION) return instance.config
    if (!script) throw new CompositionError(`scenario "${scenario.id}" has no model script for "${instance.id}"`)
    return { ...(instance.config as object), script }
  }

  const mount = (instance: PluginInstance) => {
    if (fibers.has(instance.id)) throw new Error(`instance "${instance.id}" is already mounted`)
    const parent = instance.parentId ? fibers.get(instance.parentId)?.ctx : root
    if (!parent) throw new Error(`parent "${instance.parentId}" of "${instance.id}" is not mounted`)
    // Registrations made through a scoped context land in that scope's layer (upstream dsh-scope).
    const key = scopeKeys.get(instance.scopeId)
    const ctx = key ? createScope(parent, key).ctx : parent
    const fiber = observer.mount(instance.id, () => ctx.plugin(plugins.get(instance.stageId)!, configFor(instance)))
    fibers.set(instance.id, fiber)
  }

  /** Instances mounted under `instanceId`; Cordis disposes them with their parent. */
  const descendants = (instanceId: string): string[] => composition.instances
    .filter(instance => instance.parentId === instanceId)
    .flatMap(instance => [instance.id, ...descendants(instance.id)])

  const unmount = async (instanceId: string) => {
    const fiber = fibers.get(instanceId)
    if (!fiber) throw new Error(`instance "${instanceId}" is not mounted`)
    fibers.delete(instanceId)
    for (const id of descendants(instanceId)) fibers.delete(id)
    observer.drainLoggedErrors()
    await fiber.dispose()
    await settle()
    // Cordis contains disposer failures and only logs them; surface them (LIFE-02).
    const failures = observer.drainLoggedErrors()
    if (failures.length) {
      throw new CleanupError(`cleanup of "${instanceId}" failed: ${failures.map(failure => failure.message).join('; ')}`)
    }
  }

  /**
   * The live agent of a session, created on first input through the upstream
   * agent registry. An agent in a non-root scope is linked under that scope's
   * key before it is published, so its prompt assembly sees the scope's layers.
   */
  const agentFor = async (sessionId: string): Promise<Agent> => {
    const live = root.get('agents')?.get(SessionId(sessionId))
    if (live) return live
    if (!root.get('agentLoop')) throw new Error('agentLoop is not active; check the plugin tree for missing services')
    const key = scopeKeys.get(sessionScope(composition, sessionId))
    const handle = await root.agents.create({
      sessionId: SessionId(sessionId),
      agentOptions,
      ...key ? { setup: (_agentCtx: Context, agent: Agent) => { bindScopeParent(agent, key) } } : {},
    })
    agents.set(sessionId, handle)
    return handle.agent
  }

  // A cancel step arms a trigger; the next turn is cancelled when it reaches that checkpoint or session event.
  let armedCancel = null as { stepId: string; checkpoint: string; fired: boolean } | null
  let runningAgent: Agent | undefined
  const fire = (name: string) => {
    if (armedCancel && !armedCancel.fired && name === armedCancel.checkpoint && runningAgent) {
      armedCancel.fired = true
      runningAgent.cancel({ kind: 'user' })
    }
  }
  observer.onCheckpoint = fire
  observer.onSessionEvent = (sessionId, type) => {
    if (runningAgent && String(runningAgent.id) === sessionId) fire(type)
  }

  const runStep = async (step: ScenarioStep) => {
    switch (step.kind) {
      case 'input': {
        const agent = await agentFor(step.sessionId)
        const from = agent.session.snapshotEvents().length
        const cancelRun = () => agent.cancel({ kind: 'user' })
        input.signal?.addEventListener('abort', cancelRun, { once: true })
        runningAgent = agent
        try {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: step.text }], source: { kind: 'user' } }))
          await agent.whenIdle()
        } finally {
          runningAgent = undefined
          input.signal?.removeEventListener('abort', cancelRun)
        }
        input.signal?.throwIfAborted()
        const cancel = armedCancel
        if (cancel?.fired) armedCancel = null
        // The loop settles a failed turn into turn/end instead of throwing; a scenario cannot go on past one.
        const ended = (agent.session.snapshotEvents() as readonly SessionEvent[]).slice(from).filter(event => event.type === 'turn/end')
        for (const event of ended) {
          const reason = (event.data as { reason: { kind: string; error?: { message?: string; code?: string } } }).reason
          if (reason.kind === 'error') throw new TurnError(`turn of session "${step.sessionId}" ended with an error: ${reason.error?.message ?? reason.error?.code ?? 'unknown'}`)
          if (reason.kind === 'aborted' && !cancel?.fired) throw new TurnError(`turn of session "${step.sessionId}" was aborted`)
        }
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
        if (armedCancel) throw new Error(`cancel step "${step.id}" while "${armedCancel.stepId}" is still armed`)
        armedCancel = { stepId: step.id, checkpoint: step.afterCheckpoint, fired: false }
        break
    }
  }

  // Past the record or payload limit the tail would be missing, so stop rather than report success.
  const checkLimits = () => {
    if (recorder.truncated) throw new TraceLimitError(`trace limit reached after seq ${recorder.lastSeq}; the run was stopped`)
  }

  const restoreRandomness = input.adapterMode === 'deterministic' ? useSeededRandomness() : () => {}
  let outcome: RunResult['outcome'] = 'completed'
  let error: RunResult['error'] = null
  try {
    for (const instance of composition.instances) {
      if (instance.enabled) mount(instance)
    }
    await settle()
    checkLimits()
    for (const step of scenario.steps) {
      input.signal?.throwIfAborted()
      observer.currentStepId = step.id
      recorder.record({ kind: 'checkpoint', name: TraceName.scenarioStep, scenarioStepId: step.id, payload: step })
      await runStep(step)
      await settle()
      checkLimits()
    }
    input.beforeSettle?.(root)
    if (armedCancel) throw new Error(`checkpoint "${armedCancel.checkpoint}" of cancel step "${armedCancel.stepId}" was never reached`)
  } catch (reason) {
    outcome = input.signal?.aborted ? 'cancelled' : 'failed'
    error = errorOf(reason)
    recorder.record({ kind: 'diagnostic', name: TraceName.diagnostic, payload: { level: 'error', message: `${error.name}: ${error.message}` } })
  } finally {
    observer.currentStepId = undefined
    recorder.record({ kind: 'checkpoint', name: TraceName.runSettle, payload: { outcome } })
    // Run settlement: stop the agents, then unload in reverse mount order so cleanup is recorded.
    // Unload everything even when one cleanup fails, then report every failure.
    const cleanupFailures: string[] = []
    for (const [sessionId, handle] of [...agents].reverse()) {
      try {
        await handle.dispose()
      } catch (reason) {
        cleanupFailures.push(`agent of session "${sessionId}": ${errorOf(reason).message}`)
      }
    }
    for (const instanceId of [...fibers.keys()].reverse()) {
      try {
        await unmount(instanceId)
      } catch (reason) {
        cleanupFailures.push(errorOf(reason).message)
      }
    }
    if (cleanupFailures.length) {
      outcome = 'failed'
      error ??= { name: 'CleanupError', message: cleanupFailures.join('; ') }
      recorder.record({ kind: 'diagnostic', name: TraceName.diagnostic, payload: { level: 'error', message: `settlement cleanup failed: ${cleanupFailures.join('; ')}` } })
    }
    observer.dispose()
    restoreRandomness()
  }
  return { outcome, recorder, error }
}
