/**
 * Lesson build: one set of stage source files produces both the executable
 * module and the code shown in Code Hike, bound by one sourceHash (BUILD-01).
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import type { ExecutableStageDefinition, SourceRef } from '@harness-explorer/contracts'
import { excerptHash, parseAnchors, sha256 } from './anchors.ts'
import { Architecture, AuthoredLesson, LessonBuild, UpstreamRef } from './schema.ts'
import type { BuiltLesson, BuiltStage, CodeFile } from './schema.ts'

export class LessonBuildError extends Error {
  override name = 'LessonBuildError'
}

export interface BuildOptions {
  repoRoot: string
  /** Stages to build; `module` points at the stage entry source. Upstream stages run as published and are skipped. */
  stages: readonly ExecutableStageDefinition[]
  contentDir: string
  outDir: string
  upstreamCommit: string
  scenarioIds: ReadonlySet<string>
  contractIds: ReadonlySet<string>
  compositionIds: ReadonlySet<string>
  /** Checkout of upstreamCommit. A lesson that reads an upstream stage needs it; with it, every upstream ref is checked at build time. */
  upstreamDir?: string
}

const toPosix = (path: string) => path.split(sep).join('/')

async function buildStage(stage: ExecutableStageDefinition, options: BuildOptions): Promise<BuiltStage> {
  const outfile = join(options.outDir, 'stages', `${stage.id.replace(/[^\w.-]/g, '_')}.mjs`)
  const result = await build({
    absWorkingDir: options.repoRoot,
    entryPoints: [stage.module],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    // Upstream packages stay external: a stage and the kernel must share one Cordis and one copy of each service.
    external: ['@deepseek-ai/*'],
    metafile: true,
    sourcemap: 'linked',
    logLevel: 'silent',
  }).catch((error: Error) => {
    throw new LessonBuildError(`stage ${stage.id} failed to build: ${error.message}`)
  })

  // Every repository file that reached the bundle is part of the stage source.
  const entry = toPosix(relative(options.repoRoot, stage.module))
  const inputs = Object.keys(result.metafile.inputs)
    .filter(path => !path.includes('node_modules/'))
    .sort((a, b) => (a === entry ? -1 : b === entry ? 1 : a.localeCompare(b)))
  const files: CodeFile[] = []
  for (const path of inputs) files.push({ path, content: await readFile(join(options.repoRoot, path), 'utf8') })
  const sourceHash = sha256(files.map(file => `${file.path}\0${file.content}\0`).join(''))

  const sourceRefs: SourceRef[] = []
  for (const file of files) {
    for (const anchor of parseAnchors(file.content, file.path)) {
      const id = `${stage.id}#${anchor.name}`
      if (sourceRefs.some(ref => ref.id === id)) throw new LessonBuildError(`anchor "${anchor.name}" appears twice in stage ${stage.id}`)
      sourceRefs.push({
        id,
        origin: 'teaching',
        revision: sourceHash,
        path: file.path,
        symbol: anchor.name,
        startLine: anchor.startLine,
        endLine: anchor.endLine,
        contentHash: sha256(anchor.text),
      })
    }
  }

  // One import of the stage's source module serves both checks.
  const module = await import(pathToFileURL(stage.module).href) as StageModule
  checkDeclaredRequires(stage, module)
  const configKeys = checkConfigSchema(stage, module, files[0]!.content)
  const modulePath = toPosix(relative(options.repoRoot, outfile))
  const moduleHash = sha256(await readFile(outfile, 'utf8'))
  return { definition: { ...stage, module: modulePath, sourceHash, configKeys }, modulePath, moduleHash, files, sourceRefs }
}

/**
 * The services a stage requires come from its source (docs/02 §5.1): the
 * `inject` it exports, or the static `inject` of a default-exported plugin
 * class. A catalog entry that disagrees fails the build instead of drawing
 * wrong dependency edges and validating compositions against stale needs.
 */
type ConfigSchema = { type?: string; dict?: Record<string, unknown> }
type StageModule = { inject?: unknown; Config?: ConfigSchema; default?: { inject?: unknown; Config?: ConfigSchema } }

function checkDeclaredRequires(stage: ExecutableStageDefinition, module: StageModule) {
  const declared = module.inject ?? module.default?.inject ?? []
  if (!Array.isArray(declared)) throw new LessonBuildError(`stage ${stage.id} declares inject as an object; only service lists are supported`)
  const actual = [...declared].map(String).sort()
  const listed = [...stage.requires].sort()
  if (actual.join(',') !== listed.join(',')) {
    throw new LessonBuildError(`stage ${stage.id} injects [${actual.join(', ')}] but the catalog lists requires [${listed.join(', ')}]`)
  }
}

/**
 * A stage that takes config declares a Config schema (CTX-04): the runner
 * refuses every key of a stage without one, so a config interface with no
 * schema would make all of its options unusable. Returns the schema's keys.
 */
function checkConfigSchema(stage: ExecutableStageDefinition, module: StageModule, entrySource: string): string[] | undefined {
  const schema = module.Config ?? module.default?.Config
  if (/export interface Config\b/.test(entrySource) && !schema) {
    throw new LessonBuildError(`stage ${stage.id} declares interface Config but exports no Config schema`)
  }
  // The keys commit-time validation accepts: none without a schema. A schema that is not a
  // plain object schema records nothing, so only the runner's own validation applies, as there.
  if (!schema) return []
  return schema.type === 'object' && schema.dict ? Object.keys(schema.dict) : undefined
}

interface UpstreamPackage {
  /** Directory of the package in the upstream repository, e.g. packages/core/tools. */
  dir: string
  version: string
}

/** Every package of the upstream checkout (packages/<group>/<name>), by package name. */
async function upstreamPackages(upstreamDir: string): Promise<Map<string, UpstreamPackage>> {
  const result = new Map<string, UpstreamPackage>()
  for (const group of await readdir(join(upstreamDir, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const entry of await readdir(join(upstreamDir, 'packages', group.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = `packages/${group.name}/${entry.name}`
      const manifest = await readFile(join(upstreamDir, dir, 'package.json'), 'utf8').catch(() => null)
      if (manifest === null) continue
      const { name, version } = JSON.parse(manifest) as { name?: string; version?: string }
      if (name) result.set(name, { dir, version: version ?? '' })
    }
  }
  return result
}

async function readUpstream(upstreamDir: string, path: string, commit: string) {
  return readFile(join(upstreamDir, path), 'utf8').catch(() => {
    throw new LessonBuildError(`${path} does not exist at the pinned commit ${commit.slice(0, 8)}`)
  })
}

/** Check one excerpt against the checkout; returns the file's content. */
async function checkUpstreamRef(ref: UpstreamRef, options: BuildOptions & { upstreamDir: string }, where: string) {
  const content = await readUpstream(options.upstreamDir, ref.path, options.upstreamCommit)
  let actual: string
  try {
    actual = excerptHash(content, ref.startLine, ref.endLine)
  } catch (error) {
    throw new LessonBuildError(`${where}: upstream ref "${ref.id}" (${ref.path}): ${error instanceof Error ? error.message : String(error)}`)
  }
  check(actual === ref.contentHash, `${where}: upstream ref "${ref.id}" (${ref.path}:${ref.startLine}-${ref.endLine}) no longer matches the pinned commit; its content hash is ${actual}`)
  return content
}

/**
 * An upstream stage as a lesson shows it: the package's TypeScript source at
 * the pinned commit beside the published module that runs. Source and module
 * are bound by package name and version — the npm release is the pinned
 * commit's tag (docs/decisions/0002). The lesson's upstream refs that fall in
 * this package become the stage's anchors (`<stage id>#<ref id>`); the shown
 * files are the entry plus every file those refs cite.
 */
async function buildUpstreamStage(
  stage: ExecutableStageDefinition,
  refs: readonly UpstreamRef[],
  packages: ReadonlyMap<string, UpstreamPackage>,
  options: BuildOptions & { upstreamDir: string },
): Promise<BuiltStage> {
  const where = `upstream stage ${stage.id}`
  check(stage.package, `${where} names no npm package`)
  const source = packages.get(stage.package.name)
  check(source, `${where}: ${stage.package.name} is not in the upstream checkout at ${options.upstreamCommit.slice(0, 8)}`)
  check(source.version === stage.package.version, `${where}: the checkout has ${stage.package.name}@${source.version}, but the run loads ${stage.package.version}`)
  const entry = `${source.dir}/src/index.ts`
  const own = refs.filter(ref => ref.path.startsWith(`${source.dir}/src/`))
  const paths = [entry, ...new Set(own.map(ref => ref.path).filter(path => path !== entry).sort())]
  const files: CodeFile[] = []
  for (const path of paths) files.push({ path, content: await readUpstream(options.upstreamDir, path, options.upstreamCommit) })
  const sourceRefs: SourceRef[] = []
  for (const ref of own) {
    await checkUpstreamRef(ref, options, where)
    sourceRefs.push({
      id: `${stage.id}#${ref.id}`,
      origin: 'upstream',
      revision: options.upstreamCommit,
      path: ref.path,
      symbol: ref.id,
      startLine: ref.startLine,
      endLine: ref.endLine,
      contentHash: ref.contentHash,
    })
  }
  const modulePath = toPosix(relative(options.repoRoot, stage.module))
  // The shown files are not what runs, so the module keeps its own hash as the stage's sourceHash.
  return { definition: { ...stage, module: modulePath }, modulePath, moduleHash: stage.sourceHash, files, sourceRefs }
}

async function importData(path: string): Promise<unknown> {
  const module = await import(pathToFileURL(path).href) as { default?: unknown }
  if (module.default === undefined) throw new LessonBuildError(`${path} has no default export`)
  return module.default
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LessonBuildError(message)
}

interface LessonContent {
  lesson: AuthoredLesson
  architecture: Architecture
  upstream: UpstreamRef[]
  mdx: string
}

async function loadLesson(dir: string): Promise<LessonContent> {
  return {
    lesson: AuthoredLesson.parse(await importData(join(dir, 'manifest.ts'))),
    architecture: Architecture.parse(await importData(join(dir, 'architecture.ts'))),
    upstream: UpstreamRef.array().parse(await importData(join(dir, 'upstream-map.ts'))),
    mdx: await readFile(join(dir, 'lesson.mdx'), 'utf8'),
  }
}

function buildLesson({ lesson, architecture, upstream, mdx }: LessonContent, options: BuildOptions, stages: ReadonlyMap<string, BuiltStage>): BuiltLesson {
  const where = `lesson ${lesson.id}`

  check(options.compositionIds.has(lesson.compositionId), `${where}: unknown composition "${lesson.compositionId}"`)
  const upstreamIds = new Set(upstream.map(ref => ref.id))
  check(upstreamIds.size === upstream.length, `${where}: duplicate upstream ref id`)
  const nodeIds = new Set(architecture.nodes.map(node => node.id))
  const stageRefIds = new Set([...stages.values()].flatMap(stage => stage.sourceRefs.map(ref => ref.id)))
  const knownRef = (id: string) => stageRefIds.has(id) || upstreamIds.has(id)

  for (const node of architecture.nodes) {
    for (const ref of node.sourceRefIds) check(knownRef(ref), `${where}: architecture node "${node.id}" cites unknown source ref "${ref}"`)
  }
  for (const edge of architecture.edges) {
    check(nodeIds.has(edge.from) && nodeIds.has(edge.to), `${where}: architecture edge "${edge.id}" joins unknown nodes`)
    for (const ref of edge.sourceRefIds) check(knownRef(ref), `${where}: architecture edge "${edge.id}" cites unknown source ref "${ref}"`)
    check(edge.evidence === 'explanation' || edge.sourceRefIds.length > 0, `${where}: edge "${edge.id}" claims ${edge.evidence} evidence without a source ref`)
  }

  const seen = new Set<string>()
  const builtStages = lesson.stages.map((stage) => {
    const at = `${where} stage ${stage.id}`
    check(!seen.has(stage.id), `${where}: duplicate stage id "${stage.id}"`)
    seen.add(stage.id)
    const code = stages.get(stage.codeStageId)
    check(code, `${at}: codeStageId "${stage.codeStageId}" is not an executable stage`)
    const anchors = new Set(code.sourceRefs.map(ref => ref.symbol))
    for (const anchor of stage.focusAnchors) check(anchors.has(anchor), `${at}: focus anchor "${anchor}" does not exist in ${stage.codeStageId}`)
    for (const id of stage.scenarioIds) check(options.scenarioIds.has(id), `${at}: unknown scenario "${id}"`)
    for (const id of stage.contractIds) check(options.contractIds.has(id), `${at}: unknown contract "${id}"`)
    for (const id of stage.upstreamRefIds) check(upstreamIds.has(id), `${at}: unknown upstream ref "${id}"`)
    for (const id of stage.architectureNodeIds) check(nodeIds.has(id), `${at}: unknown architecture node "${id}"`)
    if (stage.kind === 'executable') {
      check(stage.scenarioIds.length > 0 && stage.contractIds.length > 0, `${at}: executable stages need scenarios and contracts`)
    }
    // docs/05 §7: every teaching stage says what it leaves out against upstream; upstream code leaves nothing out.
    if (code.definition.origin === 'teaching') check(stage.simplifications.length > 0, `${at}: list at least one simplification against upstream`)
    for (const name of stage.expectedCheckpoints ?? []) {
      check(name.startsWith(`${lesson.pluginDefinitionId}:`), `${at}: checkpoint "${name}" is outside the "${lesson.pluginDefinitionId}:" namespace`)
    }
    return { ...stage, sourceFiles: code.files.map(file => file.path), sourceHash: code.definition.sourceHash }
  })

  const upstreamRefs: SourceRef[] = upstream.map(ref => ({ ...ref, origin: 'upstream', revision: options.upstreamCommit }))
  return { ...lesson, upstreamCommit: options.upstreamCommit, stages: builtStages, architecture, upstreamRefs, mdx }
}

export async function buildLessons(options: BuildOptions): Promise<LessonBuild> {
  const stages = new Map<string, BuiltStage>()
  for (const stage of options.stages.filter(item => item.origin === 'teaching')) stages.set(stage.id, await buildStage(stage, options))

  const contents: LessonContent[] = []
  if (existsSync(options.contentDir)) {
    for (const entry of (await readdir(options.contentDir, { withFileTypes: true })).filter(item => item.isDirectory())) {
      contents.push(await loadLesson(join(options.contentDir, entry.name)))
    }
  }

  // Upstream stages are shown from the pinned checkout, so they exist only once a lesson reads them.
  const upstreamStages = new Map<string, BuiltStage>()
  const upstreamDir = options.upstreamDir
  if (upstreamDir) {
    const withDir = { ...options, upstreamDir }
    const packages = await upstreamPackages(upstreamDir)
    for (const { lesson, upstream } of contents) {
      for (const ref of upstream) await checkUpstreamRef(ref, withDir, `lesson ${lesson.id}`)
      const read = new Set(lesson.stages.map(stage => stage.codeStageId))
      for (const stage of options.stages.filter(item => item.origin === 'upstream' && read.has(item.id))) {
        check(!upstreamStages.has(stage.id), `lesson ${lesson.id}: upstream stage ${stage.id} is already read by another lesson`)
        upstreamStages.set(stage.id, await buildUpstreamStage(stage, upstream, packages, withDir))
      }
    }
  } else {
    for (const { lesson } of contents) {
      const upstream = lesson.stages.find(stage => options.stages.some(item => item.id === stage.codeStageId && item.origin === 'upstream'))
      check(!upstream, `lesson ${lesson.id} reads upstream stage ${upstream?.codeStageId}; the build needs a checkout of ${options.upstreamCommit.slice(0, 8)} (upstreamDir)`)
    }
  }

  const shown = new Map([...stages, ...upstreamStages])
  const lessons = contents.map(content => buildLesson(content, options, shown))
  for (const lesson of lessons) {
    for (const stage of lesson.stages) {
      check(shown.get(stage.codeStageId)!.definition.pluginDefinitionId === lesson.pluginDefinitionId,
        `lesson ${lesson.id} stage ${stage.id}: code stage belongs to another plugin`)
    }
  }

  const stageList = [...stages.values()]
  const upstreamList = [...upstreamStages.values()]
  // Definitions include requires/provides, so a dependency change is a content change too.
  const contentVersion = sha256(JSON.stringify({ stages: stageList.map(stage => stage.definition), upstreamStages: upstreamList.map(stage => stage.definition), lessons }))
  const result = LessonBuild.parse({ schemaVersion: 1, contentVersion, upstreamCommit: options.upstreamCommit, stages: stageList, upstreamStages: upstreamList, lessons })
  await mkdir(options.outDir, { recursive: true })
  await writeFile(join(options.outDir, 'lessons.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}

/** Contract ids declared as `### <ID>` headings under docs/contracts. */
export async function readContractIds(dir: string): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const name of (await readdir(dir)).filter(file => file.endsWith('.md'))) {
    for (const match of (await readFile(join(dir, name), 'utf8')).matchAll(/^### ([A-Z]+-\d+)\b/gm)) ids.add(match[1]!)
  }
  return ids
}
