/**
 * Lesson content schema (docs/03-code-hike-and-plugin-lessons.md §3 and §6).
 * Authors write the `Authored*` shapes; the builder adds generated fields.
 */
import { ExecutableStageDefinition, SourceRef } from '@harness-explorer/contracts'
import { z } from 'zod'

const Id = z.string().min(1)

export const AuthoredLessonStage = z.object({
  id: Id,
  title: z.string().min(1),
  objective: z.string().min(1),
  kind: z.enum(['executable', 'explanation']),
  /** Executable stage whose complete source this lesson stage shows (and runs, when executable). */
  codeStageId: Id,
  focusAnchors: z.array(Id),
  architectureNodeIds: z.array(Id),
  contractIds: z.array(Id),
  scenarioIds: z.array(Id),
  expectedObservations: z.array(z.string()),
  /**
   * The checkpoint names (without "checkpoint/") the stage's scenarios must
   * record, in order: the machine-checked part of expectedObservations.
   */
  expectedCheckpoints: z.array(Id).optional(),
  upstreamRefIds: z.array(Id),
  simplifications: z.array(z.string()),
})
export type AuthoredLessonStage = z.infer<typeof AuthoredLessonStage>

export const AuthoredLesson = z.object({
  id: Id,
  title: z.string().min(1),
  summary: z.string().min(1),
  pluginDefinitionId: Id,
  /** Preset composition (fixtures/compositions) a stage run starts from when the selected run has no instance of the plugin. */
  compositionId: Id,
  prerequisites: z.array(Id),
  supportLevel: z.enum(['contract-verified', 'upstream-compared', 'draft']),
  stages: z.array(AuthoredLessonStage).min(1),
})
export type AuthoredLesson = z.infer<typeof AuthoredLesson>

export const ArchitectureNode = z.object({
  id: Id,
  kind: z.enum(['entry', 'type', 'function', 'class', 'registry', 'event', 'resource', 'external-service']),
  label: z.string().min(1),
  responsibility: z.string().min(1),
  sourceRefIds: z.array(Id),
  introducedAtStageId: Id.optional(),
})
export type ArchitectureNode = z.infer<typeof ArchitectureNode>

export const ArchitectureEdge = z.object({
  id: Id,
  from: Id,
  to: Id,
  relation: z.enum(['calls', 'implements', 'registers', 'reads', 'subscribes', 'disposes', 'requires']),
  evidence: z.enum(['source', 'observed', 'explanation']),
  sourceRefIds: z.array(Id),
})
export type ArchitectureEdge = z.infer<typeof ArchitectureEdge>

export const Architecture = z.object({
  nodes: z.array(ArchitectureNode),
  edges: z.array(ArchitectureEdge),
})
export type Architecture = z.infer<typeof Architecture>

/** An upstream excerpt pinned by path, line range and content hash. */
export const UpstreamRef = z.object({
  id: Id,
  path: Id,
  symbol: z.string().optional(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  contentHash: Id,
})
export type UpstreamRef = z.infer<typeof UpstreamRef>

export const CodeFile = z.object({
  path: Id,
  content: z.string(),
})
export type CodeFile = z.infer<typeof CodeFile>

export const BuiltStage = z.object({
  definition: ExecutableStageDefinition,
  /** Repository-relative module path; the server resolves it against the build directory. */
  modulePath: Id,
  /** sha256 of the bundled module, checked before every run (docs/02 §2). Builds that predate it parse but are refused at run time until rebuilt. */
  moduleHash: Id.optional(),
  files: z.array(CodeFile),
  sourceRefs: z.array(SourceRef),
})
export type BuiltStage = z.infer<typeof BuiltStage>

export const BuiltLessonStage = AuthoredLessonStage.extend({
  sourceFiles: z.array(Id),
  sourceHash: Id,
})
export type BuiltLessonStage = z.infer<typeof BuiltLessonStage>

export const BuiltLesson = AuthoredLesson.extend({
  upstreamCommit: Id,
  stages: z.array(BuiltLessonStage),
  architecture: Architecture,
  upstreamRefs: z.array(SourceRef),
  mdx: z.string(),
})
export type BuiltLesson = z.infer<typeof BuiltLesson>

export const LessonBuild = z.object({
  schemaVersion: z.literal(1),
  contentVersion: Id,
  upstreamCommit: Id,
  stages: z.array(BuiltStage),
  /**
   * Upstream stages a lesson reads: the package's TypeScript source at the
   * pinned commit, shown beside the published module that runs. Nothing here
   * is bundled, and the run catalog never takes stages from this list.
   */
  upstreamStages: z.array(BuiltStage).optional(),
  lessons: z.array(BuiltLesson),
})
export type LessonBuild = z.infer<typeof LessonBuild>
