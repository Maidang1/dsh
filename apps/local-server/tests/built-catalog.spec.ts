/**
 * BUILD-01 end to end: a run of the built catalog executes the bundled modules
 * and records the same sourceHash the lesson shows.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildLessons } from '@harness-explorer/lesson-kit'
import type { LessonBuild } from '@harness-explorer/lesson-kit'
import type { Composition } from '@harness-explorer/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildOptions, repoRoot } from '../../../scripts/lesson-env.ts'
import { loadDevCatalog, verifyBuiltStages } from '../src/catalog.ts'
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

describe('stage integrity before a run (docs/02 §2)', () => {
  const definitions = () => lessons.stages.map(stage => ({ ...stage.definition, module: join(repoRoot, stage.modulePath) }))
  const built = () => new Map(lessons.stages.map(stage => [stage.definition.id, stage]))
  const contributor = () => definitions().filter(stage => stage.id === 'prompt-contributor@02-section')

  it('accepts a fresh build', async () => {
    await expect(verifyBuiltStages(repoRoot, built(), definitions())).resolves.toBeUndefined()
  })

  it('refuses shown code that no longer matches its sourceHash', async () => {
    const tampered = built()
    const entry = structuredClone(tampered.get('prompt-contributor@02-section')!)
    entry.files[0]!.content += '\n// edited'
    tampered.set(entry.definition.id, entry)
    await expect(verifyBuiltStages(repoRoot, tampered, contributor())).rejects.toThrow(/code shown for stage prompt-contributor@02-section/)
  })

  it('refuses a stage whose source changed after the build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'explorer-source-'))
    try {
      for (const file of built().get('prompt-contributor@02-section')!.files) {
        await mkdir(dirname(join(root, file.path)), { recursive: true })
        await writeFile(join(root, file.path), file.content)
      }
      await expect(verifyBuiltStages(root, built(), contributor())).resolves.toBeUndefined()
      const entry = built().get('prompt-contributor@02-section')!.files[0]!
      await writeFile(join(root, entry.path), `${entry.content}\n// edited after the build`)
      await expect(verifyBuiltStages(root, built(), contributor())).rejects.toThrow(/source of stage prompt-contributor@02-section changed/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a run whose bundled module was changed, before spawning anything', async () => {
    const module = contributor()[0]!.module
    const original = await readFile(module, 'utf8')
    await writeFile(module, `${original}\n// edited bundle`)
    try {
      const catalog = { ...loadDevCatalog(), lessons, contentVersion: lessons.contentVersion, stages: definitions(), verifyStages: (stages: ReturnType<typeof definitions>) => verifyBuiltStages(repoRoot, built(), stages) }
      const store = new RunStore(await mkdtemp(join(tmpdir(), 'explorer-stale-')))
      const composition: Composition = JSON.parse(await readFile(join(repoRoot, 'fixtures/compositions/minimal-chat.json'), 'utf8'))
      const draft = await store.saveDraft({ id: 'd', parentRevisionId: null, composition, scenarioId: 'prompt-section-lifecycle', seed: 1 }, null)
      const revision = await commitDraft(store, catalog, draft)
      const controller = new RunController({ store, catalog })
      await expect(controller.run(revision.id, 'deterministic')).rejects.toMatchObject({ code: 'stale', message: expect.stringContaining('built module of stage prompt-contributor@02-section') })
      expect(await store.listRuns()).toEqual([])
      expect(controller.phase).toBe('idle')
    } finally {
      await writeFile(module, original)
    }
  })
})
