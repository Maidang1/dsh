/** What the control service can run: executable stages, scenarios and model scripts. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Composition, ModelScript, Scenario } from '@harness-explorer/contracts'
import type { ExecutableStageDefinition, JsonValue, PluginResponsibility } from '@harness-explorer/contracts'
import { devStages, responsibilities } from '@harness-explorer/teaching-plugins'
import { LessonBuild } from '@harness-explorer/lesson-kit'
import { hashJson } from '@harness-explorer/trace'

export interface Catalog {
  /** Built lessons with stage code, when the catalog comes from `pnpm lessons:build`. */
  lessons?: LessonBuild
  contentVersion: string
  runtimeVersion: string
  upstreamCommit: string
  stages: readonly ExecutableStageDefinition[]
  /** Responsibility per plugin definition, for filtering the plugin library. */
  responsibilities: Readonly<Record<string, PluginResponsibility>>
  scenarios: Readonly<Record<string, Scenario>>
  modelScripts: Readonly<Record<string, ModelScript>>
  /** Preset compositions a learner can start a draft from. */
  compositions: Readonly<Record<string, Composition>>
}

export function scenarioHash(scenario: Scenario) {
  return hashJson(scenario as unknown as JsonValue)
}

function readDir<T>(dir: string, parse: (value: unknown) => T, key: (value: T, file: string) => string): Record<string, T> {
  const result: Record<string, T> = {}
  for (const name of readdirSync(dir).filter(file => file.endsWith('.json')).sort()) {
    const value = parse(JSON.parse(readFileSync(join(dir, name), 'utf8')))
    result[key(value, name.replace(/\.json$/, ''))] = value
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
    responsibilities,
    scenarios: readDir(join(root, 'fixtures/scenarios'), value => Scenario.parse(value), value => value.id),
    modelScripts: readDir(join(root, 'fixtures/model-scripts'), value => ModelScript.parse(value), value => value.id),
    compositions: readDir(join(root, 'fixtures/compositions'), value => Composition.parse(value), (_value, file) => file),
  }
}

/**
 * Built catalog: executable stages are the bundled modules from lessons.json,
 * so the code a lesson shows and the code a run executes share one sourceHash.
 */
export function loadBuiltCatalog(root = repoRoot): Catalog | null {
  const path = join(root, 'packages/teaching-plugins/dist/lessons.json')
  if (!existsSync(path)) return null
  const lessons = LessonBuild.parse(JSON.parse(readFileSync(path, 'utf8')))
  const dev = loadDevCatalog(root)
  if (lessons.upstreamCommit !== dev.upstreamCommit) {
    throw new Error(`lessons.json was built for ${lessons.upstreamCommit}, upstream-lock.json pins ${dev.upstreamCommit}`)
  }
  return {
    ...dev,
    lessons,
    contentVersion: lessons.contentVersion,
    stages: lessons.stages.map(stage => ({
      ...stage.definition,
      module: isAbsolute(stage.modulePath) ? stage.modulePath : join(root, stage.modulePath),
    })),
  }
}
