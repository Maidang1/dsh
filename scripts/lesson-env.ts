/** Shared inputs of the lesson scripts: repository paths, fixtures and contracts. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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

/**
 * A checkout of the pinned upstream commit: UPSTREAM_DIR when set, otherwise
 * a cached clone in .cache/upstream, fetched on first use. Lessons that read
 * upstream source are built from it, and their excerpts are checked against it.
 */
export function ensureUpstream(): string {
  let dir = process.env.UPSTREAM_DIR
  if (!dir) {
    dir = join(repoRoot, '.cache/upstream')
    if (!existsSync(dir)) {
      execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', 'https://github.com/deepseek-ai/deepseek-harness', dir], { stdio: 'inherit' })
    }
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    if (head !== upstreamCommit) execFileSync('git', ['-C', dir, 'checkout', '--quiet', upstreamCommit], { stdio: 'inherit' })
  }
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (head !== upstreamCommit) throw new Error(`${dir} is at ${head}, expected ${upstreamCommit}`)
  return dir
}

export async function buildOptions(): Promise<BuildOptions> {
  return {
    upstreamDir: ensureUpstream(),
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
