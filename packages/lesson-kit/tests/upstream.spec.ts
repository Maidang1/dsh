import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kernelStages } from '@harness-explorer/teaching-plugins'
import { afterEach, describe, expect, it } from 'vitest'
import { buildLessons, excerptHash, sha256, verifyUpstreamRefs } from '../src/index.ts'
import type { BuildOptions } from '../src/build.ts'

const upstreamStage = kernelStages().find(stage => stage.pluginDefinitionId === 'system-prompt')!
const packageDir = 'packages/core/system-prompt'
const sourcePath = `${packageDir}/src/index.ts`
const source = 'export const upstreamSource = true\n'

const roots: string[] = []

async function fixture(options: { packageName?: string; version?: string; content?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'upstream-lesson-'))
  roots.push(root)
  const upstreamDir = join(root, 'upstream')
  const contentDir = join(root, 'content')
  const lessonDir = join(contentDir, 'system-prompt')
  const outDir = join(root, 'dist')
  await mkdir(join(upstreamDir, packageDir, 'src'), { recursive: true })
  await mkdir(lessonDir, { recursive: true })
  await writeFile(join(upstreamDir, packageDir, 'package.json'), JSON.stringify({
    name: options.packageName ?? upstreamStage.package!.name,
    version: options.version ?? upstreamStage.package!.version,
  }))
  await writeFile(join(upstreamDir, sourcePath), options.content ?? source)

  const ref = {
    id: 'excerpt',
    path: sourcePath,
    symbol: 'upstream excerpt',
    startLine: 1,
    endLine: 1,
    contentHash: excerptHash(options.content ?? source, 1, 1),
  }
  const lesson = {
    id: 'system-prompt',
    title: 'System prompt',
    summary: 'A pinned upstream source lesson.',
    pluginDefinitionId: 'system-prompt',
    compositionId: 'minimal-chat',
    prerequisites: [],
    supportLevel: 'draft',
    stages: [{
      id: '00-source',
      title: 'Source',
      objective: 'Read the pinned source.',
      kind: 'executable',
      codeStageId: upstreamStage.id,
      focusAnchors: ['excerpt'],
      architectureNodeIds: ['service'],
      contractIds: ['CTX-04'],
      scenarioIds: ['chat-greeting'],
      expectedObservations: [],
      upstreamRefIds: ['excerpt'],
      simplifications: [],
    }],
  }
  await writeFile(join(lessonDir, 'manifest.ts'), `export default ${JSON.stringify(lesson)}\n`)
  await writeFile(join(lessonDir, 'architecture.ts'), `export default ${JSON.stringify({
    nodes: [{
      id: 'service',
      kind: 'class',
      label: 'SystemPrompt',
      responsibility: 'Owns prompt registrations.',
      sourceRefIds: [`${upstreamStage.id}#excerpt`],
    }],
    edges: [],
  })}\n`)
  await writeFile(join(lessonDir, 'upstream-map.ts'), `export default ${JSON.stringify([ref])}\n`)
  await writeFile(join(lessonDir, 'lesson.mdx'), '# System prompt\n')

  const buildOptions: BuildOptions = {
    repoRoot: root,
    stages: [upstreamStage],
    contentDir,
    outDir,
    upstreamCommit: upstreamStage.upstreamCommit!,
    scenarioIds: new Set(['chat-greeting']),
    contractIds: new Set(['CTX-04']),
    compositionIds: new Set(['minimal-chat']),
    upstreamDir,
  }
  return { root, upstreamDir, sourcePath, outDir, buildOptions }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('upstream lesson stages', () => {
  it('shows only the entry and referenced upstream files, with pinned anchors and the package source hash', async () => {
    const { buildOptions, outDir, sourcePath } = await fixture()
    const build = await buildLessons(buildOptions)
    const stage = build.upstreamStages?.[0]!

    expect(stage.files.map(file => file.path)).toEqual([sourcePath])
    expect(stage.files[0]?.content).toBe(source)
    expect(stage.sourceRefs).toMatchObject([{
      id: `${upstreamStage.id}#excerpt`,
      origin: 'upstream',
      revision: upstreamStage.upstreamCommit,
      path: sourcePath,
      startLine: 1,
      endLine: 1,
    }])
    expect(build.lessons[0]?.stages[0]?.sourceHash).toBe(upstreamStage.sourceHash)
    expect(await verifyUpstreamRefs(build, buildOptions.upstreamDir!)).toEqual([])
    expect(JSON.parse(await readFile(join(outDir, 'lessons.json'), 'utf8')).upstreamStages).toHaveLength(1)
  })

  it('rejects a checkout whose package name or version differs from the executed package', async () => {
    const wrongName = await fixture({ packageName: '@deepseek-ai/dsh-not-system-prompt' })
    await expect(buildLessons(wrongName.buildOptions)).rejects.toThrow(/is not in the upstream checkout/)

    const wrongVersion = await fixture({ version: '0.0.0' })
    await expect(buildLessons(wrongVersion.buildOptions)).rejects.toThrow(/the run loads 0\.2\.1-rc\.2/)
  })

  it('rejects stale excerpt hashes and missing source files', async () => {
    const stale = await fixture()
    const lessonMap = join(stale.buildOptions.contentDir, 'system-prompt', 'upstream-map.ts')
    const map = JSON.parse((await readFile(lessonMap, 'utf8')).replace(/^export default /, ''))
    map[0].contentHash = sha256('not the pinned excerpt')
    await writeFile(lessonMap, `export default ${JSON.stringify(map)}\n`)
    await expect(buildLessons(stale.buildOptions)).rejects.toThrow(/no longer matches the pinned commit/)

    const missing = await fixture()
    await rm(join(missing.upstreamDir, sourcePath))
    await expect(buildLessons(missing.buildOptions)).rejects.toThrow(/does not exist at the pinned commit/)
  })

  it('requires an upstream checkout when a lesson reads an upstream stage', async () => {
    const { buildOptions } = await fixture()
    const withoutCheckout = { ...buildOptions }
    delete withoutCheckout.upstreamDir
    await expect(buildLessons(withoutCheckout)).rejects.toThrow(/the build needs a checkout/)
  })

  it('reports displayed source that no longer matches the pinned checkout', async () => {
    const { buildOptions, upstreamDir, sourcePath } = await fixture()
    const build = await buildLessons(buildOptions)
    await writeFile(join(upstreamDir, sourcePath), 'export const changed = true\n')

    expect(await verifyUpstreamRefs(build, upstreamDir)).toContainEqual({
      id: upstreamStage.id,
      path: sourcePath,
      reason: 'shown source differs from the pinned commit',
    })
  })
})
