/** P7-01 learning progress: merged per lesson, completions backed by real runs. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { RunStore } from '../src/store.ts'

let root: string
let store: RunStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'explorer-progress-'))
  store = new RunStore(root)
  await store.createRun({
    runId: 'run-1', experimentRevisionId: 'rev-1', revisionHash: 'h', loadedSourceHashes: {}, environmentSnapshotRef: 'e',
    adapterMode: 'deterministic', mode: 'teaching', startedAt: new Date().toISOString(), outcome: 'completed', lastSeq: -1, completeness: 'complete',
  }, { nodeVersion: 'v', platform: 'p', cwd: '<workspace>', modelProvider: null, variables: [] })
})
afterEach(() => rm(root, { recursive: true, force: true }))

it('merges reading position and records each stage completion once', async () => {
  await store.updateLessonProgress('lesson', { lastStageId: '01' })
  await store.updateLessonProgress('lesson', { completed: { stageId: '01', runId: 'run-1' } })
  await store.updateLessonProgress('lesson', { completed: { stageId: '01', runId: 'run-1' } })
  await store.updateLessonProgress('lesson', { lastStageId: '02' })
  expect(await store.getLearningProgress()).toEqual({
    lessons: { lesson: { lastStageId: '02', completed: [{ stageId: '01', runId: 'run-1' }] } },
  })
})

it('refuses a completion that points at a run which does not exist', async () => {
  await expect(store.updateLessonProgress('lesson', { completed: { stageId: '01', runId: 'run-ghost' } })).rejects.toThrow(/not found/)
  expect(await store.getLearningProgress()).toEqual({ lessons: {} })
})

it('starts over instead of failing when the progress file is unreadable as progress', async () => {
  await writeFile(join(root, 'progress.json'), JSON.stringify({ unexpected: true }))
  expect(await store.getLearningProgress()).toEqual({ lessons: {} })
})
