/**
 * `pnpm lesson:new <plugin-id> [title]`: scaffold a lesson that builds and
 * verifies as-is (docs/04 P4-04). It writes a runnable 00 stage with an
 * anchor, lesson content, a composition and scenario that mount the plugin,
 * and registers the stage in the development catalog. Nothing existing is
 * overwritten.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ScaffoldOptions {
  repoRoot: string
  id: string
  title: string
}

const ID = /^[a-z][a-z0-9-]*$/

export async function scaffoldLesson({ repoRoot, id, title }: ScaffoldOptions): Promise<string[]> {
  if (!ID.test(id)) throw new Error(`plugin id "${id}" must match ${ID}`)
  const paths = {
    stage: join(repoRoot, 'packages/teaching-plugins', id, 'stages/00-entry/index.ts'),
    content: join(repoRoot, 'content/plugins', id),
    composition: join(repoRoot, 'fixtures/compositions', `${id}.json`),
    scenario: join(repoRoot, 'fixtures/scenarios', `${id}.json`),
    catalog: join(repoRoot, 'packages/teaching-plugins/src/catalog.ts'),
  }
  for (const path of [paths.stage, paths.content, paths.composition, paths.scenario]) {
    if (existsSync(path)) throw new Error(`${path.slice(repoRoot.length)} already exists`)
  }
  const catalog = await readFile(paths.catalog, 'utf8')
  if (catalog.includes(`stage('${id}',`)) throw new Error(`the catalog already lists stages of "${id}"`)

  const written: string[] = []
  const write = async (path: string, text: string) => {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, text)
    written.push(path.slice(repoRoot.length).replace(/^[/\\]/, ''))
  }

  await write(paths.stage, `/**
 * Stage 00 — ${title}: the smallest plugin. Replace this description with what
 * the stage teaches, and keep each later stage a complete, runnable copy.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = '${id}'

export function apply(ctx: Context) {
  // lesson:entry
  ctx.logger('${id}').debug('mounted')
  // end lesson:entry
}
`)

  await write(join(paths.content, 'manifest.ts'), `import type { AuthoredLesson } from '@harness-explorer/lesson-kit'

const lesson: AuthoredLesson & { compositionId: string } = {
  id: '${id}',
  title: '${title}',
  summary: 'TODO: one sentence on what the learner will understand.',
  pluginDefinitionId: '${id}',
  compositionId: '${id}',
  prerequisites: [],
  supportLevel: 'draft',
  stages: [
    {
      id: '00-entry',
      title: '最小插件入口',
      objective: 'TODO: what this stage shows, as an observable change.',
      kind: 'executable',
      codeStageId: '${id}@00-entry',
      focusAnchors: ['entry'],
      architectureNodeIds: ['entry'],
      contractIds: ['CTX-02'],
      scenarioIds: ['${id}'],
      expectedObservations: ['插件进入 active'],
      upstreamRefIds: [],
      simplifications: [],
    },
  ],
}

export default lesson
`)

  await write(join(paths.content, 'architecture.ts'), `import type { Architecture } from '@harness-explorer/lesson-kit'

const architecture: Architecture = {
  nodes: [
    {
      id: 'entry',
      kind: 'entry',
      label: '${id}',
      responsibility: 'TODO: the plugin\\'s responsibility',
      sourceRefIds: ['${id}@00-entry#entry'],
      introducedAtStageId: '00-entry',
    },
  ],
  edges: [],
}

export default architecture
`)

  await write(join(paths.content, 'upstream-map.ts'), `import type { UpstreamRef } from '@harness-explorer/lesson-kit'

/**
 * Excerpts of deepseek-harness at the commit pinned in upstream-lock.json.
 * Add { id, path, symbol, startLine, endLine, contentHash } entries and check
 * them with \`pnpm lessons:verify-upstream\`.
 */
const refs: UpstreamRef[] = []

export default refs
`)

  await write(join(paths.content, 'lesson.mdx'), `# ${title}

TODO: 本课解决的问题，以及学习者最后能观察到的变化。

## 00 最小插件入口

TODO: 这一阶段的代码做了什么，轨迹里应看到什么。区分代码事实与设计解读。
`)

  const base = JSON.parse(await readFile(join(repoRoot, 'fixtures/compositions/minimal-chat.json'), 'utf8')) as {
    scopes: unknown[]
    instances: Array<{ definitionId: string }>
  }
  base.instances = base.instances.filter(instance => instance.definitionId !== 'prompt-contributor')
  base.instances.push({ id, definitionId: id, stageId: `${id}@00-entry`, scopeId: 'root', parentId: null, enabled: true, config: {} } as never)
  await write(paths.composition, JSON.stringify(base, null, 2) + '\n')

  await write(paths.scenario, JSON.stringify({
    id,
    title: `${title}：运行一次固定输入`,
    modelScriptId: 'greeting',
    memoryFiles: {},
    adapterModes: ['deterministic', 'real'],
    steps: [{ kind: 'input', id: 'ask', sessionId: 's', text: '你好' }],
  }, null, 2) + '\n')

  const closing = catalog.lastIndexOf('\n]')
  if (closing < 0) throw new Error('could not find the end of devStages in the catalog')
  await writeFile(paths.catalog, `${catalog.slice(0, closing)}\n  stage('${id}', '00-entry', [], []),${catalog.slice(closing)}`)
  written.push('packages/teaching-plugins/src/catalog.ts (stage registered)')
  return written
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [id, ...titleWords] = process.argv.slice(2)
  if (!id) {
    console.error('usage: pnpm lesson:new <plugin-id> [title]')
    process.exit(1)
  }
  const repoRoot = fileURLToPath(new URL('../', import.meta.url))
  const written = await scaffoldLesson({ repoRoot, id, title: titleWords.join(' ') || id })
  console.log(['created:', ...written.map(path => `  ${path}`), '', 'next: pnpm lessons:build && pnpm lessons:verify', 'guide: docs/authoring.md'].join('\n'))
}
