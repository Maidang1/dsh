/** What the control service can run: executable stages, scenarios and model scripts. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Composition, ModelScript, Scenario } from '@harness-explorer/contracts'
import type { ExecutableStageDefinition, JsonValue, PluginResponsibility } from '@harness-explorer/contracts'
import { devStages, responsibilities } from '@harness-explorer/teaching-plugins'
import { LessonBuild, sha256 } from '@harness-explorer/lesson-kit'
import type { BuiltStage } from '@harness-explorer/lesson-kit'
import { readFile } from 'node:fs/promises'
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
  /**
   * Refuse stages whose shown code, current source or bundled module no longer
   * match the lesson build (docs/02 §2). Absent for the development catalog.
   */
  verifyStages?(stages: readonly ExecutableStageDefinition[]): Promise<void>
}

/** The lesson build is out of date for a stage a run would load. */
export class StaleBuildError extends Error {
  override name = 'StaleBuildError'
}

const filesHash = (files: ReadonlyArray<{ path: string; content: string }>) => sha256(files.map(file => `${file.path}\0${file.content}\0`).join(''))

export async function verifyBuiltStages(root: string, built: ReadonlyMap<string, BuiltStage>, stages: readonly ExecutableStageDefinition[]) {
  const rebuild = 'run pnpm lessons:build and restart pnpm explorer'
  for (const stage of stages) {
    const entry = built.get(stage.id)
    if (!entry) throw new StaleBuildError(`stage ${stage.id} is not in the lesson build; ${rebuild}`)
    if (filesHash(entry.files) !== entry.definition.sourceHash) {
      throw new StaleBuildError(`the code shown for stage ${stage.id} does not match its sourceHash; ${rebuild}`)
    }
    const onDisk = await Promise.all(entry.files.map(async file => ({ path: file.path, content: await readFile(join(root, file.path), 'utf8').catch(() => '') })))
    if (filesHash(onDisk) !== entry.definition.sourceHash) {
      throw new StaleBuildError(`the source of stage ${stage.id} changed after the lesson build; ${rebuild}`)
    }
    const module = await readFile(stage.module, 'utf8').catch(() => null)
    if (!entry.moduleHash || module === null || sha256(module) !== entry.moduleHash) {
      throw new StaleBuildError(`the built module of stage ${stage.id} differs from the lesson build; ${rebuild}`)
    }
  }
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
  const parsed = LessonBuild.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`${path.slice(root.length)} does not match this version (${issue?.path.join('.')}: ${issue?.message}); run pnpm lessons:build`)
  }
  const lessons = parsed.data
  const dev = loadDevCatalog(root)
  if (lessons.upstreamCommit !== dev.upstreamCommit) {
    throw new Error(`lessons.json was built for ${lessons.upstreamCommit}, upstream-lock.json pins ${dev.upstreamCommit}`)
  }
  const built = new Map(lessons.stages.map(stage => [stage.definition.id, stage]))
  return {
    ...dev,
    lessons,
    contentVersion: lessons.contentVersion,
    verifyStages: stages => verifyBuiltStages(root, built, stages),
    stages: lessons.stages.map(stage => ({
      ...stage.definition,
      module: isAbsolute(stage.modulePath) ? stage.modulePath : join(root, stage.modulePath),
    })),
  }
}
