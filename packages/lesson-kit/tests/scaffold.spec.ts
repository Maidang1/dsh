/**
 * P4-04: `pnpm lesson:new` writes a lesson skeleton with the same structure as
 * the existing courses and never overwrites one.
 */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAnchors } from '../src/index.ts'
import { scaffoldLesson } from '../../../scripts/new-lesson.ts'
import { repoRoot } from '../../../scripts/lesson-env.ts'

describe('lesson scaffold', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'scaffold-'))
    for (const path of ['packages/teaching-plugins/src/catalog.ts', 'fixtures/compositions/minimal-chat.json']) {
      await cp(join(repoRoot, path), join(root, path), { recursive: true })
    }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes a stage, lesson content, fixtures and a catalog entry', async () => {
    const written = await scaffoldLesson({ repoRoot: root, id: 'echo-note', title: '回声' })
    expect(written).toContain('packages/teaching-plugins/echo-note/stages/00-entry/index.ts')
    for (const file of ['manifest.ts', 'architecture.ts', 'upstream-map.ts', 'lesson.mdx']) {
      expect(existsSync(join(root, 'content/plugins/echo-note', file))).toBe(true)
    }

    const stage = await readFile(join(root, 'packages/teaching-plugins/echo-note/stages/00-entry/index.ts'), 'utf8')
    expect(parseAnchors(stage, 'index.ts').map(anchor => anchor.name)).toEqual(['entry'])

    const catalog = await readFile(join(root, 'packages/teaching-plugins/src/catalog.ts'), 'utf8')
    expect(catalog).toMatch(/stage\('tool-guard', '02-deny', \['tools'\], \[\]\),\n {2}stage\('echo-note', '00-entry', \[\], \[\]\),\n\]/)

    const composition = JSON.parse(await readFile(join(root, 'fixtures/compositions/echo-note.json'), 'utf8')) as {
      instances: Array<{ definitionId: string, stageId: string }>
    }
    expect(composition.instances.map(instance => instance.definitionId)).not.toContain('prompt-contributor')
    expect(composition.instances.at(-1)).toMatchObject({ definitionId: 'echo-note', stageId: 'echo-note@00-entry' })

    const scenario = JSON.parse(await readFile(join(root, 'fixtures/scenarios/echo-note.json'), 'utf8')) as { id: string, modelScriptId: string }
    expect(scenario).toMatchObject({ id: 'echo-note', modelScriptId: 'greeting' })
  })

  it('refuses invalid ids and existing lessons', async () => {
    await expect(scaffoldLesson({ repoRoot: root, id: 'Echo', title: 'x' })).rejects.toThrow(/must match/)
    await scaffoldLesson({ repoRoot: root, id: 'echo-note', title: 'x' })
    const catalog = await readFile(join(root, 'packages/teaching-plugins/src/catalog.ts'), 'utf8')
    await expect(scaffoldLesson({ repoRoot: root, id: 'echo-note', title: 'x' })).rejects.toThrow(/already exists/)
    await expect(scaffoldLesson({ repoRoot: root, id: 'tool-guard', title: 'x' })).rejects.toThrow(/already lists/)
    expect(await readFile(join(root, 'packages/teaching-plugins/src/catalog.ts'), 'utf8')).toBe(catalog)
  })
})
