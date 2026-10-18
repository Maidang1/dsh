/** P7-01 learning progress, and STORE writes that must not race: drafts, progress and pins. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ConflictError, RunStore } from '../src/store.ts'

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

it('keeps both of two concurrent updates', async () => {
  await Promise.all([
    store.updateLessonProgress('lesson', { lastStageId: '02' }),
    store.updateLessonProgress('lesson', { completed: { stageId: '01', runId: 'run-1' } }),
    store.updateLessonProgress('other', { lastStageId: '00' }),
  ])
  expect(await store.getLearningProgress()).toEqual({
    lessons: {
      lesson: { lastStageId: '02', completed: [{ stageId: '01', runId: 'run-1' }] },
      other: { lastStageId: '00', completed: [] },
    },
  })
})

it('lets only one of two concurrent draft saves at the same version through', async () => {
  const draft = { id: 'main', parentRevisionId: null, composition: { scopes: [{ id: 'root', parentId: null }], instances: [] }, scenarioId: 's', seed: 1 }
  await store.saveDraft(draft, null)
  const results = await Promise.allSettled([store.saveDraft({ ...draft, seed: 2 }, 1), store.saveDraft({ ...draft, seed: 3 }, 1)])
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  // The loser is refused by the version check, not by a clash between the two writes.
  expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError)
  expect((await store.getDraft('main')).version).toBe(2)
})

it('keeps every pin when runs are pinned concurrently', async () => {
  const manifest = await store.getManifest('run-1')
  await store.createRun({ ...manifest, runId: 'run-2' }, { nodeVersion: 'v', platform: 'p', cwd: '<workspace>', modelProvider: null, variables: [] })
  await Promise.all([store.setPinned('run-1', true), store.setPinned('run-2', true)])
  expect([...await store.pinnedRuns()].sort()).toEqual(['run-1', 'run-2'])
})
