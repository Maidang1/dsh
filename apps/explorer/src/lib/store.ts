'use client'
/**
 * View state (Zustand). It holds selections, the draft being edited and
 * received traces; it never advances execution on its own — run facts come
 * from the Node control service (docs/02-technical-architecture.md §6.4).
 */
import { create } from 'zustand'
import type {
  AdapterMode,
  Composition,
  EnvironmentSnapshot,
  ExperimentRevision,
  JsonValue,
  PluginInstance,
  RunManifest,
  RuntimeState,
  TraceRecord,
} from '@harness-explorer/contracts'
import { TraceBuffer } from '@harness-explorer/trace/browser'
import { api, ApiError, subscribeRun, subscribeState } from './api'
import { describeFailure } from './errors'
import type { Draft, LearningProgress, LessonProgressUpdate, LessonsResponse, PublicCatalog, StorageUsage } from './api'

export const DRAFT_ID = 'main'
const DEFAULT_COMPOSITION = 'minimal-chat'

export interface RunData {
  runId: string
  records: readonly TraceRecord[]
  payloads: Record<string, JsonValue>
  gaps: Array<{ fromSeq: number; toSeq: number }>
  settled: { finalSeq: number; outcome: RunManifest['outcome']; completeness: RunManifest['completeness'] } | null
  revision: ExperimentRevision | null
}

export type Layer = 'composition' | 'dependency' | 'data'

interface ExplorerState {
  ready: boolean
  error: string | null
  connected: boolean
  catalog: PublicCatalog | null
  lessons: LessonsResponse | null
  compositions: Record<string, Composition>
  draft: Draft | null
  runtime: RuntimeState | null
  runs: RunManifest[]
  runData: Record<string, RunData>
  selectedRunId: string | null
  compareRunId: string | null
  /** Replay cursor (seq) in the selected run; null follows the latest record. */
  cursor: number | null
  selectedInstanceId: string | null
  layer: Layer
  listView: boolean
  adapterMode: AdapterMode
  environment: Record<AdapterMode, EnvironmentSnapshot> | null
  storage: StorageUsage | null
  progress: LearningProgress | null

  init(): Promise<void>
  selectRun(runId: string | null): Promise<void>
  setCompareRun(runId: string | null): Promise<void>
  setCursor(cursor: number | null): void
  selectInstance(id: string | null): void
  setLayer(layer: Layer): void
  setListView(listView: boolean): void
  setAdapterMode(mode: AdapterMode): void
  editDraft(edit: (draft: Draft) => Omit<Draft, 'version'>): Promise<void>
  run(): Promise<void>
  /**
   * Run one lesson stage: derive a revision from the selected run's (or the
   * draft's) composition with the plugin switched to `stageId` (docs/02 §5.4).
   * The main draft is left untouched.
   */
  runLessonStage(lessonId: string, definitionId: string, stageId: string, scenarioId: string): Promise<void>
  cancel(): Promise<void>
  /** Save reading position or a stage completion; applied locally at once. */
  updateLessonProgress(lessonId: string, update: LessonProgressUpdate): Promise<void>
  refreshRuns(): Promise<void>
  deleteRun(runId: string): Promise<void>
  pinRun(runId: string, pinned: boolean): Promise<void>
  /** Import an exported run; it is stored as data and selected, never executed. */
  importRun(file: File): Promise<void>
  dismissError(): void
}

let unsubscribe: (() => void) | null = null
let stopStateWatch: (() => void) | null = null
/**
 * Draft edits are saved one after another, each applied to the draft the
 * previous save returned; two quick edits would otherwise both claim the
 * same version and the second would be refused as a conflict and lost.
 */
let draftEdits: Promise<void> = Promise.resolve()
const buffers = new Map<string, TraceBuffer>()

export const useExplorer = create<ExplorerState>((set, get) => {
  const ingest = (runId: string, records: TraceRecord[], payloads: Record<string, JsonValue>) => {
    const buffer = buffers.get(runId) ?? new TraceBuffer(runId)
    buffers.set(runId, buffer)
    buffer.add(records)
    set(state => {
      const previous = state.runData[runId]
      return {
        runData: {
          ...state.runData,
          [runId]: {
            runId,
            revision: previous?.revision ?? null,
            settled: previous?.settled ?? null,
            // Append-only view of the buffer's contiguous prefix; no per-batch copy.
            records: buffer.records,
            payloads: { ...previous?.payloads, ...payloads },
            gaps: buffer.gaps(),
          },
        },
      }
    })
  }

  const settle = (runId: string, settled: RunData['settled']) => {
    buffers.get(runId)?.settle(settled!.finalSeq)
    set(state => {
      const data = state.runData[runId]
      if (!data) return {}
      return { runData: { ...state.runData, [runId]: { ...data, settled, gaps: buffers.get(runId)?.gaps() ?? [] } } }
    })
  }

  const loadRevision = async (runId: string, revisionId: string) => {
    const revision = await api.revision(revisionId)
    set(state => {
      const data = state.runData[runId]
      return data ? { runData: { ...state.runData, [runId]: { ...data, revision } } } : {}
    })
  }

  /** Load a run: a live run streams over SSE; a settled run is read from the store. */
  const loadRun = async (runId: string, live: boolean) => {
    if (!get().runData[runId]) {
      set(state => ({ runData: { ...state.runData, [runId]: { runId, records: [], payloads: {}, gaps: [], settled: null, revision: null } } }))
    }
    const { manifest } = await api.run(runId)
    void loadRevision(runId, manifest.experimentRevisionId)
    if (live) {
      unsubscribe?.()
      unsubscribe = subscribeRun(runId, {
        onState: runtime => set({ runtime }),
        onTrace: (records, payloads) => ingest(runId, records, payloads),
        onSettled: (settled) => {
          settle(runId, settled)
          void get().refreshRuns()
        },
        onConnection: connected => set({ connected }),
      })
    } else if (!get().runData[runId]?.settled) {
      const page = await api.trace(runId)
      ingest(runId, page.records, page.payloads)
      settle(runId, { finalSeq: manifest.lastSeq, outcome: manifest.outcome, completeness: manifest.completeness })
    }
  }

  return {
    ready: false,
    error: null,
    connected: false,
    catalog: null,
    lessons: null,
    compositions: {},
    draft: null,
    runtime: null,
    runs: [],
    runData: {},
    selectedRunId: null,
    compareRunId: null,
    cursor: null,
    selectedInstanceId: null,
    layer: 'composition',
    listView: false,
    adapterMode: 'deterministic',
    environment: null,
    storage: null,
    progress: null,

    async init() {
      try {
        const [catalog, compositions, runtime, runs] = await Promise.all([api.catalog(), api.compositions(), api.state(), api.runs()])
        const lessons = await api.lessons().catch(() => null)
        const environment = await api.environment().catch(() => null)
        let draft: Draft
        try {
          draft = await api.draft(DRAFT_ID)
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error
          const composition = compositions[DEFAULT_COMPOSITION] ?? Object.values(compositions)[0]!
          draft = await api.saveDraft({
            id: DRAFT_ID,
            parentRevisionId: null,
            composition,
            scenarioId: catalog.scenarios[0]!.id,
            seed: 1,
          }, null)
        }
        const storage = await api.storage().catch(() => null)
        const progress = await api.progress().catch(() => ({ lessons: {} }))
        set({ ready: true, catalog, compositions, runtime, runs, draft, lessons, environment, storage, progress })
        // Compare with what this stream saw last: the run stream also writes `runtime`, so the store may already hold `next`.
        let before: RuntimeState | null = runtime
        stopStateWatch ??= subscribeState((next) => {
          const seen = before
          before = next
          set({ runtime: next })
          // A run started or settled elsewhere (another tab, a lesson page) appears in the list without a reload.
          if (next.runId !== seen?.runId || (next.phase === 'idle') !== (seen?.phase === 'idle')) {
            void get().refreshRuns().catch(() => {})
          }
        })
        // Moving between the workbench and a lesson keeps the selected run (docs/01 §3.2);
        // a fresh page starts from the current or latest run.
        const kept = get().selectedRunId
        const latest = (kept && runs.some(run => run.runId === kept) ? kept : null) ?? runtime.runId ?? runs[0]?.runId ?? null
        if (latest) await get().selectRun(latest)
      } catch (error) {
        set({ error: describeFailure('load', error) })
      }
    },

    async selectRun(runId) {
      set({ selectedRunId: runId, cursor: null })
      if (!runId) return
      try {
        await loadRun(runId, get().runtime?.runId === runId)
      } catch (error) {
        set({ error: describeFailure('openRun', error) })
      }
    },

    async setCompareRun(runId) {
      set({ compareRunId: runId })
      if (runId) await loadRun(runId, false).catch(error => set({ error: describeFailure('compareRun', error) }))
    },

    setCursor: cursor => set({ cursor }),
    selectInstance: selectedInstanceId => set({ selectedInstanceId }),
    setLayer: layer => set({ layer }),
    setListView: listView => set({ listView }),
    setAdapterMode: adapterMode => set({ adapterMode }),
    dismissError: () => set({ error: null }),

    editDraft(edit) {
      draftEdits = draftEdits.catch(() => {}).then(async () => {
        const draft = get().draft
        if (!draft) return
        try {
          const saved = await api.saveDraft(edit(draft), draft.version)
          set({ draft: saved })
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            set({ draft: await api.draft(DRAFT_ID), error: `草稿已在其他标签页修改，已载入最新版本：${error.message}` })
          } else {
            set({ error: describeFailure('saveDraft', error) })
          }
        }
      })
      return draftEdits
    },

    async run() {
      try {
        // Run what the learner last edited, not a draft with a save still in flight.
        await draftEdits.catch(() => {})
        const revision = await api.commitDraft(DRAFT_ID)
        const { runId } = await api.startRun(revision.id, get().adapterMode)
        set(state => ({ selectedRunId: runId, cursor: null, runData: { ...state.runData } }))
        await loadRun(runId, true)
        await get().refreshRuns()
      } catch (error) {
        set({ error: describeFailure('run', error) })
      }
    },

    async runLessonStage(lessonId, definitionId, stageId, scenarioId) {
      const state = get()
      const base = state.selectedRunId ? state.runData[state.selectedRunId]?.revision : null
      const composition = base?.composition ?? state.draft?.composition
      if (!composition) return
      if (!composition.instances.some(instance => instance.definitionId === definitionId)) {
        set({ error: `组合中没有 ${definitionId} 的实例，请先在整体组合中添加` })
        return
      }
      const draftId = `lesson-${lessonId}`
      try {
        const existing = await api.draft(draftId).catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 404) return null
          throw error
        })
        await api.saveDraft({
          id: draftId,
          parentRevisionId: base?.id ?? null,
          composition: {
            ...composition,
            instances: composition.instances.map(instance => (instance.definitionId === definitionId ? { ...instance, stageId } : instance)),
          },
          scenarioId,
          seed: base?.seed ?? 1,
        }, existing?.version ?? null)
        const revision = await api.commitDraft(draftId)
        const { runId } = await api.startRun(revision.id, 'deterministic')
        set({ selectedRunId: runId, cursor: null })
        await loadRun(runId, true)
        await get().refreshRuns()
      } catch (error) {
        set({ error: describeFailure('runStage', error) })
      }
    },

    async updateLessonProgress(lessonId, update) {
      const previous = get().progress ?? { lessons: {} }
      const lesson = previous.lessons[lessonId] ?? { lastStageId: null, completed: [] }
      const completed = update.completed && !lesson.completed.some(item => item.stageId === update.completed!.stageId)
        ? [...lesson.completed, update.completed]
        : lesson.completed
      set({ progress: { lessons: { ...previous.lessons, [lessonId]: { lastStageId: update.lastStageId ?? lesson.lastStageId, completed } } } })
      try {
        set({ progress: await api.updateLessonProgress(lessonId, update) })
      } catch (error) {
        set({ progress: previous, error: describeFailure('progress', error) })
      }
    },

    async refreshRuns() {
      const [runs, storage] = await Promise.all([api.runs(), api.storage().catch(() => null)])
      set({ runs, storage })
    },

    async deleteRun(runId) {
      try {
        await api.deleteRun(runId)
        buffers.delete(runId)
        set(state => {
          const { [runId]: _removed, ...runData } = state.runData
          return {
            runData,
            selectedRunId: state.selectedRunId === runId ? null : state.selectedRunId,
            compareRunId: state.compareRunId === runId ? null : state.compareRunId,
          }
        })
        await get().refreshRuns()
      } catch (error) {
        set({ error: describeFailure('deleteRun', error) })
      }
    },

    async pinRun(runId, pinned) {
      // Optimistic: the checkbox reflects the click at once and rolls back on failure.
      const previous = get().storage
      const withPin = (pins: string[]) => (pinned ? [...new Set([...pins, runId])] : pins.filter(id => id !== runId))
      if (previous) set({ storage: { ...previous, pinned: withPin(previous.pinned) } })
      try {
        await api.pinRun(runId, pinned)
        await get().refreshRuns()
      } catch (error) {
        set({ storage: previous, error: describeFailure('pinRun', error) })
      }
    },

    async importRun(file) {
      try {
        const manifest = await api.importRun(JSON.parse(await file.text()))
        await get().refreshRuns()
        await get().selectRun(manifest.runId)
      } catch (error) {
        set({ error: describeFailure('importRun', error) })
      }
    },

    async cancel() {
      const runId = get().runtime?.runId
      if (runId) await api.cancelRun(runId).catch(error => set({ error: describeFailure('cancel', error) }))
    },
  }
})

/** Composition the tree should show: the selected run's revision, else the draft. */
export function shownComposition(state: Pick<ExplorerState, 'selectedRunId' | 'runData' | 'draft'>): {
  composition: Composition | null
  source: 'run' | 'draft'
} {
  const revision = state.selectedRunId ? state.runData[state.selectedRunId]?.revision : null
  if (revision) return { composition: revision.composition, source: 'run' }
  return { composition: state.draft?.composition ?? null, source: 'draft' }
}

export function instanceById(composition: Composition | null, id: string | null): PluginInstance | undefined {
  return composition?.instances.find(instance => instance.id === id)
}
