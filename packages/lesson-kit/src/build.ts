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
import { parseAnchors, sha256 } from './anchors.ts'
import { Architecture, AuthoredLesson, LessonBuild, UpstreamRef } from './schema.ts'
import type { BuiltLesson, BuiltStage, CodeFile } from './schema.ts'

export class LessonBuildError extends Error {
  override name = 'LessonBuildError'
}

export interface BuildOptions {
  repoRoot: string
  /** Stages to build; `module` points at the stage entry source. */
  stages: readonly ExecutableStageDefinition[]
  contentDir: string
  outDir: string
  upstreamCommit: string
  scenarioIds: ReadonlySet<string>
  contractIds: ReadonlySet<string>
  compositionIds: ReadonlySet<string>
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
    external: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'],
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

  await checkDeclaredRequires(stage)
  const configKeys = await checkConfigSchema(stage, files[0]!.content)
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
async function checkDeclaredRequires(stage: ExecutableStageDefinition) {
  const module = await import(pathToFileURL(stage.module).href) as { inject?: unknown; default?: { inject?: unknown } }
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
async function checkConfigSchema(stage: ExecutableStageDefinition, entrySource: string): Promise<string[]> {
  type Schema = { dict?: Record<string, unknown> }
  const module = await import(pathToFileURL(stage.module).href) as { Config?: Schema; default?: { Config?: Schema } }
  const schema = module.Config ?? module.default?.Config
  if (/export interface Config\b/.test(entrySource) && !schema) {
    throw new LessonBuildError(`stage ${stage.id} declares interface Config but exports no Config schema`)
  }
  // The keys commit-time validation accepts; a stage without a schema takes none.
  return Object.keys(schema?.dict ?? {})
}

async function importData(path: string): Promise<unknown> {
  const module = await import(pathToFileURL(path).href) as { default?: unknown }
  if (module.default === undefined) throw new LessonBuildError(`${path} has no default export`)
  return module.default
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LessonBuildError(message)
}

async function buildLesson(dir: string, options: BuildOptions, stages: ReadonlyMap<string, BuiltStage>): Promise<BuiltLesson> {
  const lesson = AuthoredLesson.parse(await importData(join(dir, 'manifest.ts')))
  const architecture = Architecture.parse(await importData(join(dir, 'architecture.ts')))
  const upstream = UpstreamRef.array().parse(await importData(join(dir, 'upstream-map.ts')))
  const mdx = await readFile(join(dir, 'lesson.mdx'), 'utf8')
  const where = `lesson ${lesson.id}`

  check(options.compositionIds.has(lesson.compositionId), `${where}: unknown composition "${lesson.compositionId}"`)
  const upstreamIds = new Set(upstream.map(ref => ref.id))
  const nodeIds = new Set(architecture.nodes.map(node => node.id))
  const teachingRefIds = new Set([...stages.values()].flatMap(stage => stage.sourceRefs.map(ref => ref.id)))
  const knownRef = (id: string) => teachingRefIds.has(id) || upstreamIds.has(id)

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
    // docs/05 §7: every stage says what it leaves out, and teaching checkpoints keep their plugin's namespace.
    check(stage.simplifications.length > 0, `${at}: list at least one simplification against upstream`)
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
  for (const stage of options.stages) stages.set(stage.id, await buildStage(stage, options))

  const lessons: BuiltLesson[] = []
  if (existsSync(options.contentDir)) {
    for (const entry of (await readdir(options.contentDir, { withFileTypes: true })).filter(item => item.isDirectory())) {
      lessons.push(await buildLesson(join(options.contentDir, entry.name), options, stages))
    }
  }
  for (const lesson of lessons) {
    for (const stage of lesson.stages) {
      check(stages.get(stage.codeStageId)!.definition.pluginDefinitionId === lesson.pluginDefinitionId,
        `lesson ${lesson.id} stage ${stage.id}: code stage belongs to another plugin`)
    }
  }

  const stageList = [...stages.values()]
  // Definitions include requires/provides, so a dependency change is a content change too.
  const contentVersion = sha256(JSON.stringify({ stages: stageList.map(stage => stage.definition), lessons }))
  const result = LessonBuild.parse({ schemaVersion: 1, contentVersion, upstreamCommit: options.upstreamCommit, stages: stageList, lessons })
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
