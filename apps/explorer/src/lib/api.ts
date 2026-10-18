/** Same-origin client for the local control service. The session cookie travels automatically. */
import type {
  AdapterMode,
  Composition,
  EnvironmentSnapshot,
  ExecutableStageDefinition,
  ExperimentRevision,
  JsonValue,
  PluginResponsibility,
  RunManifest,
  RuntimeState,
  Scenario,
  TraceRecord,
} from '@harness-explorer/contracts'
import type { BuiltLesson, BuiltStage } from '@harness-explorer/lesson-kit/schema'

export type PublicStage = Omit<ExecutableStageDefinition, 'module'>

export interface PublicCatalog {
  contentVersion: string
  upstreamCommit: string
  stages: PublicStage[]
  responsibilities: Record<string, PluginResponsibility>
  scenarios: Scenario[]
}

export interface LessonsResponse {
  contentVersion: string
  upstreamCommit: string
  lessons: BuiltLesson[]
  stages: Array<Omit<BuiltStage, 'modulePath' | 'definition'> & { definition: PublicStage }>
}

export interface Draft {
  id: string
  version: number
  parentRevisionId: string | null
  composition: Composition
  scenarioId: string
  seed: number
}

export interface TracePage {
  records: TraceRecord[]
  payloads: Record<string, JsonValue>
}

export interface StorageUsage {
  runs: number
  records: number
  bytes: number
  pinned: string[]
  retention: { maxRuns: number; maxBytes: number } | null
}

export interface LearningProgress {
  lessons: Record<string, { lastStageId: string | null; completed: Array<{ stageId: string; runId: string }> }>
}

export interface LessonProgressUpdate {
  lastStageId?: string
  completed?: { stageId: string; runId: string }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init
  const response = await fetch(path, {
    ...rest,
    headers: { ...json !== undefined ? { 'content-type': 'application/json' } : {}, ...rest.headers },
    ...json !== undefined ? { body: JSON.stringify(json) } : {},
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new ApiError(response.status, body?.error?.message ?? response.statusText)
  }
  return response.json() as Promise<T>
}

export const api = {
  catalog: () => request<PublicCatalog>('/api/catalog'),
  lessons: () => request<LessonsResponse>('/api/lessons'),
  compositions: () => request<Record<string, Composition>>('/api/compositions'),
  state: () => request<RuntimeState>('/api/state'),
  environment: () => request<Record<AdapterMode, EnvironmentSnapshot>>('/api/environment'),
  runs: () => request<RunManifest[]>('/api/runs'),
  run: (runId: string) => request<{ manifest: RunManifest; environment: EnvironmentSnapshot }>(`/api/runs/${encodeURIComponent(runId)}`),
  trace: (runId: string) => request<TracePage>(`/api/runs/${encodeURIComponent(runId)}/trace`),
  revision: (id: string) => request<ExperimentRevision>(`/api/revisions/${encodeURIComponent(id)}`),
  draft: (id: string) => request<Draft>(`/api/drafts/${encodeURIComponent(id)}`),
  saveDraft: (draft: Omit<Draft, 'version'>, expectedVersion: number | null) =>
    request<Draft>(`/api/drafts/${encodeURIComponent(draft.id)}`, { method: 'PUT', json: { expectedVersion, draft } }),
  commitDraft: (id: string) => request<ExperimentRevision>(`/api/drafts/${encodeURIComponent(id)}/commit`, { method: 'POST' }),
  startRun: (revisionId: string, adapterMode: AdapterMode) =>
    request<{ runId: string }>('/api/runs', { method: 'POST', json: { revisionId, adapterMode } }),
  storage: () => request<StorageUsage>('/api/storage'),
  progress: () => request<LearningProgress>('/api/progress'),
  updateLessonProgress: (lessonId: string, update: LessonProgressUpdate) =>
    request<LearningProgress>(`/api/lessons/${encodeURIComponent(lessonId)}/progress`, { method: 'PUT', json: update }),
  deleteRun: (runId: string) => request<{ deleted: string }>(`/api/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' }),
  pinRun: (runId: string, pinned: boolean) => request<{ pinned: boolean }>(`/api/runs/${encodeURIComponent(runId)}/pin`, { method: 'PUT', json: { pinned } }),
  importRun: (bundle: unknown) => request<RunManifest>('/api/imports', { method: 'POST', json: bundle }),
  cancelRun: (runId: string) => request<{ cancelling: string }>(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
}

export interface StreamHandlers {
  onState(state: RuntimeState): void
  onTrace(records: TraceRecord[], payloads: Record<string, JsonValue>): void
  onSettled(settled: { runId: string; finalSeq: number; outcome: RunManifest['outcome']; completeness: RunManifest['completeness'] }): void
  onConnection(connected: boolean): void
}

/**
 * Subscribe to a run over SSE. EventSource reconnects by itself and sends the
 * last seq as Last-Event-ID, so the server only resends the missing tail.
 */
export function subscribeRun(runId: string | null, handlers: StreamHandlers): () => void {
  const source = new EventSource(`/api/events${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`)
  source.addEventListener('open', () => handlers.onConnection(true))
  source.addEventListener('error', () => handlers.onConnection(false))
  source.addEventListener('state', event => handlers.onState(JSON.parse((event as MessageEvent).data)))
  source.addEventListener('trace', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as { records: TraceRecord[]; payloads: Record<string, JsonValue> }
    handlers.onTrace(data.records, data.payloads)
  })
  source.addEventListener('settled', event => handlers.onSettled(JSON.parse((event as MessageEvent).data)))
  return () => source.close()
}
