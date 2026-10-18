/**
 * BUILD-01 end to end: a run of the built catalog executes the bundled modules
 * and records the same sourceHash the lesson shows.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildLessons } from '@harness-explorer/lesson-kit'
import type { LessonBuild } from '@harness-explorer/lesson-kit'
import type { Composition } from '@harness-explorer/contracts'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { buildOptions, repoRoot } from '../../../scripts/lesson-env.ts'
import { loadDevCatalog } from '../src/catalog.ts'
import { RunController } from '../src/controller.ts'
import { commitDraft } from '../src/experiments.ts'
import { RunStore } from '../src/store.ts'

// Bundles keep '@deepseek-ai/cordis' external, so they must live where it resolves.
const outDir = join(repoRoot, 'packages/teaching-plugins/dist', `test-${randomUUID().slice(0, 8)}`)
let storeDir: string
let lessons: LessonBuild

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'explorer-built-'))
  lessons = await buildLessons({ ...await buildOptions(), outDir })
})
afterAll(async () => {
  await rm(outDir, { recursive: true, force: true })
  await rm(storeDir, { recursive: true, force: true })
})

it('runs bundled stage modules and records the hashes the lesson shows', async () => {
  const catalog = {
    ...loadDevCatalog(),
    lessons,
    contentVersion: lessons.contentVersion,
    stages: lessons.stages.map(stage => ({ ...stage.definition, module: join(repoRoot, stage.modulePath) })),
  }
  const store = new RunStore(storeDir)
  const composition: Composition = JSON.parse(await readFile(join(repoRoot, 'fixtures/compositions/minimal-chat.json'), 'utf8'))
  const draft = await store.saveDraft({ id: 'd', parentRevisionId: null, composition, scenarioId: 'prompt-section-lifecycle', seed: 1 }, null)
  const revision = await commitDraft(store, catalog, draft)
  expect(revision.contentVersion).toBe(lessons.contentVersion)

  const controller = new RunController({ store, catalog })
  const runId = await controller.run(revision.id, 'deterministic')
  await controller.whenSettled(runId)
  const manifest = await store.getManifest(runId)
  expect(manifest.outcome).toBe('completed')
  const shown = lessons.lessons[0]!.stages.find(stage => stage.id === '02-section')!.sourceHash
  expect(manifest.loadedSourceHashes['prompt-contributor@02-section']).toBe(shown)
  expect(Object.values(manifest.loadedSourceHashes)).not.toContain('dev')
})
