import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { PluginPhasePayload, ServiceChangePayload, TraceName } from '@harness-explorer/contracts'
import type { Composition, ExecutableStageDefinition, ModelScript, RunOutcome, Scenario } from '@harness-explorer/contracts'
import { kernelStages } from '@harness-explorer/teaching-plugins'
import { runScenario } from '@harness-explorer/teaching-runtime'
import { recordedCheckpoints } from '@harness-explorer/trace'
import type { RunResult } from '@harness-explorer/teaching-runtime'
import { excerptHash } from './anchors.ts'
import type { LessonBuild } from './schema.ts'

export interface StageRunReport {
  lessonId: string
  stageId: string
  scenarioId: string
  outcome: RunOutcome
  error: string | null
  /** Instances whose observed services differ from their stage's declared `provides`. */
  providesMismatches: string[]
  /** Set when the recorded checkpoints differ from the stage's expectedCheckpoints. */
  checkpointMismatch: string | null
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
  const stages = [
    ...kernelStages(),
    ...lessonBuild.stages.map(stage => ({
      ...stage.definition,
      module: isAbsolute(stage.modulePath) ? stage.modulePath : join(options.repoRoot, stage.modulePath),
    })),
  ]
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
          providesMismatches: checkProvides(result.recorder, composition, stages),
          checkpointMismatch: checkCheckpoints(result.recorder, lesson.pluginDefinitionId, stage.expectedCheckpoints),
        })
      }
    }
  }
  return reports
}

function checkCheckpoints(recorder: RunResult['recorder'], pluginDefinitionId: string, expected: readonly string[] | undefined): string | null {
  if (!expected) return null
  const recorded = recordedCheckpoints(recorder.records, pluginDefinitionId)
  return recorded.join(',') === expected.join(',') ? null : `expected checkpoints [${expected.join(', ')}] but recorded [${recorded.join(', ')}]`
}

/**
 * Compare each instance that became active with the services the trace saw
 * it provide. `provides` is declared in the catalog (docs/02 §5.1); this is
 * where a declaration that disagrees with the code is caught, since the
 * dependency layer and composition validation trust it.
 */
export function checkProvides(recorder: RunResult['recorder'], composition: Composition, stages: readonly ExecutableStageDefinition[]): string[] {
  const active = new Set<string>()
  const observed = new Map<string, Set<string>>()
  for (const record of recorder.records) {
    if (record.name === TraceName.pluginPhase && record.instanceId && record.payloadRef) {
      if (PluginPhasePayload.parse(recorder.payloads.get(record.payloadRef)).phase === 'active') active.add(record.instanceId)
    } else if (record.name === TraceName.serviceChange && record.payloadRef) {
      const change = ServiceChangePayload.parse(recorder.payloads.get(record.payloadRef))
      if (!change.available || !change.providerInstanceId) continue
      const names = observed.get(change.providerInstanceId) ?? new Set<string>()
      observed.set(change.providerInstanceId, names.add(change.name))
    }
  }
  const mismatches: string[] = []
  for (const instance of composition.instances.filter(item => active.has(item.id))) {
    const declared = [...stages.find(stage => stage.id === instance.stageId)?.provides ?? []].sort()
    const actual = [...observed.get(instance.id) ?? []].sort()
    if (declared.join(',') !== actual.join(',')) {
      mismatches.push(`${instance.id} (${instance.stageId}) provides [${actual.join(', ')}] but the catalog lists [${declared.join(', ')}]`)
    }
  }
  return mismatches
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
