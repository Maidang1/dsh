/** What the control service can run: executable stages, scenarios and model scripts. */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ModelScript, Scenario } from '@harness-explorer/contracts'
import type { ExecutableStageDefinition, JsonValue } from '@harness-explorer/contracts'
import { devStages } from '@harness-explorer/teaching-plugins'
import { hashJson } from '@harness-explorer/trace'

export interface Catalog {
  contentVersion: string
  runtimeVersion: string
  upstreamCommit: string
  stages: readonly ExecutableStageDefinition[]
  scenarios: Readonly<Record<string, Scenario>>
  modelScripts: Readonly<Record<string, ModelScript>>
}

export function scenarioHash(scenario: Scenario) {
  return hashJson(scenario as unknown as JsonValue)
}

function readDir<T>(dir: string, parse: (value: unknown) => T & { id: string }): Record<string, T> {
  const result: Record<string, T> = {}
  for (const name of readdirSync(dir).filter(file => file.endsWith('.json')).sort()) {
    const value = parse(JSON.parse(readFileSync(join(dir, name), 'utf8')))
    result[value.id] = value
  }
  return result
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** Development catalog: stages loaded from source, fixtures from the repository. */
export function loadDevCatalog(root = repoRoot): Catalog {
  const lock = JSON.parse(readFileSync(join(root, 'upstream-lock.json'), 'utf8')) as { commit: string }
  return {
    contentVersion: 'dev',
    runtimeVersion: 'dev',
    upstreamCommit: lock.commit,
    stages: devStages,
    scenarios: readDir(join(root, 'fixtures/scenarios'), value => Scenario.parse(value)),
    modelScripts: readDir(join(root, 'fixtures/model-scripts'), value => ModelScript.parse(value)),
  }
}
