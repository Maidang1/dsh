import { readFileSync } from 'node:fs'
import { Composition, ModelScript, Scenario, TraceName } from '@harness-explorer/contracts'
import type { ExecutableStageDefinition, ModelRequestPayload, ScenarioStep, SessionEventPayload, TraceRecord } from '@harness-explorer/contracts'
import type { Plugin } from '@deepseek-ai/cordis'
import { devStages } from '@harness-explorer/teaching-plugins'
import { replayAll } from '@harness-explorer/trace'
import { importStageLoader, runScenario } from '../src/index.ts'
import type { RunInput, RunResult } from '../src/index.ts'

const fixture = (path: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), 'utf8'))

/** What upstream SystemPrompt puts before the fixtures' persona: its harness identity section. */
export const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
/** The system text of the minimal-chat preset without contributions. */
export const PERSONA = `${IDENTITY}\n\n你是一个助手`

export const minimalChat = (): Composition => Composition.parse(fixture('compositions/minimal-chat.json'))
export const greetingScript = (): ModelScript => ModelScript.parse(fixture('model-scripts/greeting.json'))
export const lifecycleScenario = (): Scenario => Scenario.parse(fixture('scenarios/prompt-section-lifecycle.json'))
export const scopedChat = (): Composition => Composition.parse(fixture('compositions/scoped-chat.json'))
export const promptScopeScenario = (): Scenario => Scenario.parse(fixture('scenarios/prompt-scope.json'))
export const toolChat = (): Composition => Composition.parse(fixture('compositions/tool-chat.json'))
export const calculatorScript = (): ModelScript => ModelScript.parse(fixture('model-scripts/calculator.json'))
export const toolGuardScenario = (): Scenario => Scenario.parse(fixture('scenarios/tool-guard.json'))

export function scenario(steps: ScenarioStep[], modelScriptId = 'greeting'): Scenario {
  return Scenario.parse({ id: 'inline', title: 'inline', steps, modelScriptId, memoryFiles: {}, adapterModes: ['deterministic'] })
}

export function run(overrides: Partial<RunInput> & Pick<RunInput, 'scenario'>): Promise<RunResult> {
  return runScenario({
    runId: 'run-test',
    composition: minimalChat(),
    modelScripts: { greeting: greetingScript() },
    stages: devStages,
    adapterMode: 'deterministic',
    ...overrides,
  })
}

/** Records whose scenarioStepId is `stepId`. */
export function recordsOf(result: RunResult, stepId: string): TraceRecord[] {
  return result.recorder.records.filter(record => record.scenarioStepId === stepId)
}

export function requestsOf(result: RunResult, stepId: string): ModelRequestPayload[] {
  return recordsOf(result, stepId)
    .filter(record => record.name === TraceName.modelRequest)
    .map(record => result.recorder.payloads.get(record.payloadRef!) as ModelRequestPayload)
}

export function finalView(result: RunResult) {
  return replayAll(result.recorder.records, ref => result.recorder.payloads.get(ref))
}

export function payloadOf<T>(result: RunResult, record: TraceRecord): T {
  return result.recorder.payloads.get(record.payloadRef!) as T
}

export function sessionEvents(result: RunResult, sessionId: string): SessionEventPayload[] {
  return result.recorder.records
    .filter(record => record.name === TraceName.sessionEvent && record.sessionId === sessionId)
    .map(record => payloadOf<SessionEventPayload>(result, record))
}

export const sessionTypes = (result: RunResult, sessionId: string) => sessionEvents(result, sessionId).map(event => event.type)

/** A project plugin given inline, for probing one behavior without a lesson stage. */
export function inlineStage(id: string, requires: string[], plugin: Plugin) {
  const definition: ExecutableStageDefinition = {
    id: `${id}@inline`,
    pluginDefinitionId: id,
    origin: 'teaching',
    module: `/inline/${id}`,
    sourceHash: 'inline',
    requires,
    provides: [],
    upstreamCommit: null,
  }
  return { definition, plugin }
}

/** Add inline plugins to the root scope of a composition, with a loader that serves them. */
export function withInline(composition: Composition, ...inline: Array<ReturnType<typeof inlineStage>>) {
  for (const { definition } of inline) {
    composition.instances.push({
      id: definition.pluginDefinitionId,
      definitionId: definition.pluginDefinitionId,
      stageId: definition.id,
      scopeId: 'root',
      parentId: null,
      enabled: true,
      config: {},
    })
  }
  const plugins = new Map(inline.map(({ definition, plugin }) => [definition.id, plugin]))
  return {
    composition,
    stages: [...devStages, ...inline.map(({ definition }) => definition)],
    loadStage: async (stage: ExecutableStageDefinition) => plugins.get(stage.id) ?? importStageLoader(stage),
  }
}
