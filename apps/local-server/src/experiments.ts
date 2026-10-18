import type { ExperimentRevision } from '@harness-explorer/contracts'
import { validateComposition } from '@harness-explorer/teaching-runtime'
import { scenarioHash } from './catalog.ts'
import type { Catalog } from './catalog.ts'
import { ControlError } from './controller.ts'
import type { Draft, RunStore } from './store.ts'

/** Compile a draft and store it as an immutable, content-addressed revision. */
export async function commitDraft(store: RunStore, catalog: Catalog, draft: Draft): Promise<ExperimentRevision> {
  const scenario = catalog.scenarios[draft.scenarioId]
  if (!scenario) throw new ControlError('invalid', `unknown scenario "${draft.scenarioId}"`)
  try {
    validateComposition(draft.composition, scenario, catalog.stages)
  } catch (error) {
    throw new ControlError('invalid', error instanceof Error ? error.message : String(error))
  }
  return store.putRevision({
    parentRevisionId: draft.parentRevisionId,
    contentVersion: catalog.contentVersion,
    runtimeVersion: catalog.runtimeVersion,
    upstreamCommit: catalog.upstreamCommit,
    composition: draft.composition,
    scenarioId: scenario.id,
    scenarioHash: scenarioHash(scenario),
    seed: draft.seed,
  })
}
