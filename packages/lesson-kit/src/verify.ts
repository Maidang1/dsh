import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Composition, ModelScript, RunOutcome, Scenario } from '@harness-explorer/contracts'
import { runScenario } from '@harness-explorer/teaching-runtime'
import { excerptHash } from './anchors.ts'
import type { LessonBuild } from './schema.ts'

export interface StageRunReport {
  lessonId: string
  stageId: string
  scenarioId: string
  outcome: RunOutcome
  error: string | null
}

export interface VerifyOptions {
  repoRoot: string
  compositions: Readonly<Record<string, Composition>>
  scenarios: Readonly<Record<string, Scenario>>
  modelScripts: Readonly<Record<string, ModelScript>>
  compositionOf: (lessonId: string) => string
}

/**
 * Run every executable lesson stage's scenarios against the built modules,
 * with the lesson plugin's instances switched to that stage. Early stages
 * are verified too, not only the final one.
 */
export async function verifyStageRuns(lessonBuild: LessonBuild, options: VerifyOptions): Promise<StageRunReport[]> {
  const stages = lessonBuild.stages.map(stage => ({
    ...stage.definition,
    module: isAbsolute(stage.modulePath) ? stage.modulePath : join(options.repoRoot, stage.modulePath),
  }))
  const reports: StageRunReport[] = []
  for (const lesson of lessonBuild.lessons) {
    const base = options.compositions[options.compositionOf(lesson.id)]!
    for (const stage of lesson.stages.filter(item => item.kind === 'executable')) {
      const composition: Composition = {
        ...base,
        instances: base.instances.map(instance => instance.definitionId === lesson.pluginDefinitionId
          ? { ...instance, stageId: stage.codeStageId }
          : instance),
      }
      for (const scenarioId of stage.scenarioIds) {
        const result = await runScenario({
          runId: `verify-${stage.id}-${scenarioId}`,
          composition,
          scenario: options.scenarios[scenarioId]!,
          modelScripts: options.modelScripts,
          stages,
          adapterMode: 'deterministic',
        })
        reports.push({
          lessonId: lesson.id,
          stageId: stage.id,
          scenarioId,
          outcome: result.outcome,
          error: result.error ? `${result.error.name}: ${result.error.message}` : null,
        })
      }
    }
  }
  return reports
}

export interface UpstreamMismatch {
  id: string
  path: string
  reason: string
}

/** Check every upstream excerpt against a checkout of the pinned commit. */
export async function verifyUpstreamRefs(lessonBuild: LessonBuild, upstreamDir: string): Promise<UpstreamMismatch[]> {
  const mismatches: UpstreamMismatch[] = []
  for (const ref of lessonBuild.lessons.flatMap(lesson => lesson.upstreamRefs)) {
    let source: string
    try {
      source = await readFile(join(upstreamDir, ref.path), 'utf8')
    } catch {
      mismatches.push({ id: ref.id, path: ref.path, reason: 'file does not exist at the pinned commit' })
      continue
    }
    try {
      const actual = excerptHash(source, ref.startLine, ref.endLine)
      if (actual !== ref.contentHash) mismatches.push({ id: ref.id, path: ref.path, reason: `content hash is ${actual}` })
    } catch (error) {
      mismatches.push({ id: ref.id, path: ref.path, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return mismatches
}
