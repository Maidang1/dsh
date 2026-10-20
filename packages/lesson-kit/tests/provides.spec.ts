/**
 * Declared `provides` are checked against the services a run observed each
 * active instance provide, including services no stage declares.
 */
import { devStages } from '@harness-explorer/teaching-plugins'
import { runScenario } from '@harness-explorer/teaching-runtime'
import type { ExecutableStageDefinition } from '@harness-explorer/contracts'
import { describe, expect, it } from 'vitest'
import { checkProvides } from '../src/index.ts'
import { compositions, modelScripts, scenarios } from '../../../scripts/lesson-env.ts'

async function mismatches(stages: readonly ExecutableStageDefinition[]) {
  const composition = compositions['minimal-chat']!
  const result = await runScenario({
    runId: 'provides',
    composition,
    scenario: scenarios['prompt-section-lifecycle']!,
    modelScripts: Object.fromEntries(Object.values(modelScripts).map(script => [script.id, script])),
    stages,
    adapterMode: 'deterministic',
  })
  expect(result.outcome).toBe('completed')
  return checkProvides(result.recorder, composition, stages)
}

describe('provides check', () => {
  it('accepts the catalog as declared', async () => {
    expect(await mismatches(devStages)).toEqual([])
  })

  it('reports undeclared and missing services', async () => {
    const stages = devStages.map(stage => {
      if (stage.id === 'session@main') return { ...stage, provides: [] }
      if (stage.id === 'llm@main') return { ...stage, provides: ['llm', 'embeddings'] }
      return stage
    })
    expect(await mismatches(stages)).toEqual([
      'session (session@main) provides [sessions] but the catalog lists []',
      'llm (llm@main) provides [llm] but the catalog lists [embeddings, llm]',
    ])
  })
})
