/** Shared inputs of the lesson scripts: repository paths, fixtures and contracts. */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Composition, ModelScript, Scenario } from '@harness-explorer/contracts'
import { readContractIds } from '@harness-explorer/lesson-kit'
import type { BuildOptions } from '@harness-explorer/lesson-kit'
import { devStages } from '@harness-explorer/teaching-plugins'

export const repoRoot = fileURLToPath(new URL('../', import.meta.url))
export const outDir = join(repoRoot, 'packages/teaching-plugins/dist')
export const upstreamCommit = (JSON.parse(readFileSync(join(repoRoot, 'upstream-lock.json'), 'utf8')) as { commit: string }).commit

function fixtures<T>(dir: string, parse: (value: unknown) => T): Record<string, T> {
  const result: Record<string, T> = {}
  for (const name of readdirSync(join(repoRoot, 'fixtures', dir)).filter(file => file.endsWith('.json'))) {
    result[name.replace(/\.json$/, '')] = parse(JSON.parse(readFileSync(join(repoRoot, 'fixtures', dir, name), 'utf8')))
  }
  return result
}

export const compositions = fixtures('compositions', value => Composition.parse(value))
export const scenarios = fixtures('scenarios', value => Scenario.parse(value))
export const modelScripts = fixtures('model-scripts', value => ModelScript.parse(value))

export async function buildOptions(): Promise<BuildOptions> {
  return {
    repoRoot,
    stages: devStages,
    contentDir: join(repoRoot, 'content/plugins'),
    outDir,
    upstreamCommit,
    scenarioIds: new Set(Object.values(scenarios).map(scenario => scenario.id)),
    contractIds: await readContractIds(join(repoRoot, 'docs/contracts')),
    compositionIds: new Set(Object.keys(compositions)),
  }
}
