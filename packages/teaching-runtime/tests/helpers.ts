import { readFileSync } from 'node:fs'
import { Composition, ModelScript, Scenario, TraceName } from '@harness-explorer/contracts'
import type { ModelRequestPayload, ScenarioStep, TraceRecord } from '@harness-explorer/contracts'
import { devStages } from '@harness-explorer/teaching-plugins'
import { replayAll } from '@harness-explorer/trace'
import { runScenario } from '../src/index.ts'
import type { RunInput, RunResult } from '../src/index.ts'

const fixture = (path: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), 'utf8'))

export const minimalChat = (): Composition => Composition.parse(fixture('compositions/minimal-chat.json'))
export const greetingScript = (): ModelScript => ModelScript.parse(fixture('model-scripts/greeting.json'))
export const lifecycleScenario = (): Scenario => Scenario.parse(fixture('scenarios/prompt-section-lifecycle.json'))

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
