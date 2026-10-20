/** docs/01 §7 comparisons, on two real runs: stage 00 (no section) and stage 02 (registers one). */
import { devStages } from '@harness-explorer/teaching-plugins'
// The explorer app does not depend on the runtime; the test reaches it by path.
import { runScenario } from '../../../packages/teaching-runtime/src/index.ts'
import { beforeAll, describe, expect, it } from 'vitest'
import { compositions, modelScripts, scenarios } from '../../../scripts/lesson-env.ts'
import { processLines, registryDiff, sessionLines } from '../src/lib/compare'
import { diffLines } from '../src/lib/replay'

type Trace = Parameters<typeof processLines>[0]

async function run(stageId: string): Promise<Trace> {
  const base = compositions['minimal-chat']!
  const result = await runScenario({
    runId: `compare-${stageId}`,
    composition: { ...base, instances: base.instances.map(item => item.definitionId === 'prompt-contributor' ? { ...item, stageId } : item) },
    scenario: scenarios['prompt-section-lifecycle']!,
    modelScripts: Object.fromEntries(Object.values(modelScripts).map(script => [script.id, script])),
    stages: devStages,
    adapterMode: 'deterministic',
  })
  expect(result.outcome).toBe('completed')
  return { records: result.recorder.records, payloads: Object.fromEntries(result.recorder.payloads.entries()) }
}

describe('run comparison', () => {
  let entry: Trace
  let section: Trace
  beforeAll(async () => {
    entry = await run('prompt-contributor@00-entry')
    section = await run('prompt-contributor@02-section')
  })

  it('registry: the section stage adds one prompt section by the scenario end', () => {
    // The scenario remounts the contributor last, so its section is present at the end.
    expect(registryDiff(entry, section)).toEqual([expect.objectContaining({ change: 'added', label: expect.stringContaining('prompt-section') })])
    expect(registryDiff(section, section)).toEqual([])
  })

  it('process: lines carry steps, not sequence numbers, so identical runs line up', () => {
    expect(processLines(entry)).toContain('[mount] prompt-contributor → active')
    expect(diffLines(processLines(section).join('\n'), processLines(section).join('\n')).every(line => line.kind === 'same')).toBe(true)
    expect(processLines(section).join('\n')).not.toMatch(/#\d+/)
  })

  it('session: only the sessions asked while the section is registered persist a different system message', () => {
    const changed = diffLines(sessionLines(entry).join('\n'), sessionLines(section).join('\n')).filter(line => line.kind !== 'same')
    const sessions = new Set(changed.map(line => line.text.split(' · ')[0]))
    expect([...sessions].sort()).toEqual(['s-b', 's-d'])
    expect(changed).toContainEqual({ kind: 'added', text: 's-b · system/message {"text":"你是一个助手\\n\\n回答时使用短句"}' })
  })
})
