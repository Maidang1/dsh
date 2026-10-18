/**
 * Domain entities shared by the runtime, the local server and the UI.
 * See docs/02-technical-architecture.md §5. These are project types, not upstream APIs.
 */
import { z } from 'zod'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export const JsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(JsonValue),
  z.record(z.string(), JsonValue),
]))

const Id = z.string().min(1)

export const SourceRef = z.object({
  id: Id,
  origin: z.enum(['teaching', 'upstream']),
  revision: Id,
  path: Id,
  symbol: z.string().optional(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  contentHash: Id,
}).refine(ref => ref.endLine >= ref.startLine, { message: 'endLine must not precede startLine' })
export type SourceRef = z.infer<typeof SourceRef>

export const PluginInstance = z.object({
  id: Id,
  definitionId: Id,
  stageId: Id,
  scopeId: Id,
  parentId: Id.nullable(),
  enabled: z.boolean(),
  config: JsonValue,
})
export type PluginInstance = z.infer<typeof PluginInstance>

export const ScopeDefinition = z.object({
  id: Id,
  parentId: Id.nullable(),
})
export type ScopeDefinition = z.infer<typeof ScopeDefinition>

export const Composition = z.object({
  instances: z.array(PluginInstance),
  scopes: z.array(ScopeDefinition),
})
export type Composition = z.infer<typeof Composition>

export const PluginDefinition = z.object({
  id: Id,
  title: z.string(),
  origin: z.enum(['teaching', 'upstream']),
  lessonId: Id.nullable(),
  executableStageIds: z.array(Id),
})
export type PluginDefinition = z.infer<typeof PluginDefinition>

export const ExecutableStageDefinition = z.object({
  id: Id,
  pluginDefinitionId: Id,
  origin: z.enum(['teaching', 'upstream']),
  module: Id,
  sourceHash: Id,
  requires: z.array(Id),
  provides: z.array(Id),
  /** Config keys the stage's Config schema names, recorded by the lesson build; absent for development stages. */
  configKeys: z.array(Id).optional(),
  upstreamCommit: Id.nullable(),
}).refine(stage => stage.origin === 'teaching' || stage.upstreamCommit !== null, {
  message: 'upstream stages must pin an upstreamCommit',
})
export type ExecutableStageDefinition = z.infer<typeof ExecutableStageDefinition>

export const ExperimentRevision = z.object({
  id: Id,
  parentRevisionId: Id.nullable(),
  contentVersion: Id,
  runtimeVersion: Id,
  upstreamCommit: Id,
  composition: Composition,
  scenarioId: Id,
  scenarioHash: Id,
  seed: z.number().int(),
  revisionHash: Id,
})
export type ExperimentRevision = z.infer<typeof ExperimentRevision>

export const RuntimeError = z.object({
  name: z.string(),
  message: z.string(),
  sourceRefIds: z.array(Id),
})
export type RuntimeError = z.infer<typeof RuntimeError>

export const PluginPhase = z.enum(['pending', 'loading', 'active', 'failed', 'unloading']).nullable()
export type PluginPhase = z.infer<typeof PluginPhase>

export const PluginRuntimeState = z.object({
  instanceId: Id,
  phase: PluginPhase,
  dependencyStatus: z.enum(['unknown', 'missing', 'resolved']),
  reason: z.string().nullable(),
  lastError: RuntimeError.nullable(),
  resourceIds: z.array(Id),
})
export type PluginRuntimeState = z.infer<typeof PluginRuntimeState>

export const RuntimePhase = z.enum(['idle', 'validating', 'starting', 'running', 'stopping', 'settling'])
export type RuntimePhase = z.infer<typeof RuntimePhase>

export const RuntimeState = z.object({
  phase: RuntimePhase,
  runId: Id.nullable(),
  revisionId: Id.nullable(),
  plugins: z.record(Id, PluginRuntimeState),
  error: RuntimeError.nullable(),
})
export type RuntimeState = z.infer<typeof RuntimeState>

export const EnvironmentSnapshot = z.object({
  nodeVersion: z.string(),
  platform: z.string(),
  cwd: z.string(),
  modelProvider: z.string().nullable(),
  variables: z.array(z.object({
    name: z.string(),
    present: z.boolean(),
    sensitive: z.boolean(),
  })),
})
export type EnvironmentSnapshot = z.infer<typeof EnvironmentSnapshot>

/** What a plugin definition is for; the plugin library filters by it (docs/01 §5.1). */
export const PluginResponsibility = z.enum(['session', 'prompt', 'tool', 'event-policy', 'model', 'agent-loop'])
export type PluginResponsibility = z.infer<typeof PluginResponsibility>

export const AdapterMode = z.enum(['deterministic', 'real'])
export type AdapterMode = z.infer<typeof AdapterMode>
