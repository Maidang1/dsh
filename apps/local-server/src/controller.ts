/**
 * Run controller: one run at a time, one fresh subprocess per run
 * (docs/02-technical-architecture.md §6.1 and §10). XState owns the legal
 * transitions; this class performs the side effects of each one.
 */
import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { TraceName } from '@harness-explorer/contracts'
import type {
  AdapterMode,
  ExperimentRevision,
  JsonValue,
  PluginRuntimeState,
  RunManifest,
  RunOutcome,
  RuntimeError,
  RuntimePhase,
  RuntimeState,
  TraceRecord,
} from '@harness-explorer/contracts'
import { compositionForMode, validateComposition } from '@harness-explorer/teaching-runtime'
import { emptySnapshot, reduceTrace } from '@harness-explorer/trace'
import type { ViewSnapshot } from '@harness-explorer/trace'
import { createActor, setup } from 'xstate'
import { scenarioHash } from './catalog.ts'
import type { Catalog } from './catalog.ts'
import { captureEnvironment, redactText, RUN_VARIABLES, secretValues } from './environment.ts'
import { ChildMessage } from './ipc.ts'
import type { StartMessage } from './ipc.ts'
import type { RunStore } from './store.ts'

type ControlEvent =
  | { type: 'RUN' }
  | { type: 'VALID' }
  | { type: 'INVALID' }
  | { type: 'READY' }
  | { type: 'START_FAILED' }
  | { type: 'ENDED' }
  | { type: 'CANCEL' }
  | { type: 'STOPPED' }
  | { type: 'SETTLED' }

export const runControlMachine = setup({ types: { events: {} as ControlEvent } }).createMachine({
  id: 'run-control',
  initial: 'idle',
  states: {
    idle: { on: { RUN: 'validating' } },
    validating: { on: { INVALID: 'idle', VALID: 'starting' } },
    starting: { on: { READY: 'running', CANCEL: 'stopping', START_FAILED: 'settling' } },
    running: { on: { ENDED: 'settling', CANCEL: 'stopping' } },
    stopping: { on: { STOPPED: 'settling' } },
    settling: { on: { SETTLED: 'idle' } },
  },
})

export class ControlError extends Error {
  constructor(readonly code: 'busy' | 'invalid' | 'not-found' | 'internal', message: string) {
    super(message)
    this.name = 'ControlError'
  }
}

export type ControllerEvent =
  | { type: 'state'; state: RuntimeState }
  | { type: 'trace'; runId: string; records: TraceRecord[] }
  | { type: 'settled'; runId: string; finalSeq: number; outcome: RunOutcome }

export interface ControllerOptions {
  store: RunStore
  catalog: Catalog
  /** Worker entry; defaults to the TypeScript source loaded through tsx. */
  workerPath?: string
  execArgv?: string[]
  runTimeoutMs?: number
  cleanupTimeoutMs?: number
  limits?: StartMessage['limits']
  env?: NodeJS.ProcessEnv
}

interface ActiveRun {
  runId: string
  revision: ExperimentRevision
  child: ChildProcess | null
  records: TraceRecord[]
  payloads: Map<string, JsonValue>
  view: ViewSnapshot
  settled: { outcome: Exclude<RunOutcome, 'running' | 'interrupted'>; truncated: boolean; error: RuntimeError | null } | null
  killed: boolean
  /** Set once the run is settled and written; reconnecting clients get it replayed. */
  finished: { finalSeq: number; outcome: RunOutcome } | null
  writes: Promise<void>
  timers: NodeJS.Timeout[]
  done: Promise<void>
  resolveDone: () => void
}

export class RunController {
  private readonly actor = createActor(runControlMachine).start()
  private readonly listeners = new Set<(event: ControllerEvent) => void>()
  private active: ActiveRun | null = null
  private error: RuntimeError | null = null

  constructor(private readonly options: ControllerOptions) {}

  get phase(): RuntimePhase {
    return this.actor.getSnapshot().value as RuntimePhase
  }

  subscribe(listener: (event: ControllerEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The current (or most recent) run kept in memory for reconnection. */
  get current() {
    return this.active
  }

  state(): RuntimeState {
    const run = this.active
    const plugins: Record<string, PluginRuntimeState> = {}
    for (const [instanceId, plugin] of Object.entries(run?.view.plugins ?? {})) {
      plugins[instanceId] = {
        instanceId,
        phase: plugin.phase,
        dependencyStatus: plugin.dependencyStatus,
        reason: plugin.reason,
        lastError: plugin.error ? { ...plugin.error, sourceRefIds: [] } : null,
        resourceIds: Object.values(run!.view.registrations)
          .filter(registration => registration.instanceId === instanceId)
          .map(registration => registration.registrationId),
      }
    }
    return { phase: this.phase, runId: run?.runId ?? null, revisionId: run?.revision.id ?? null, plugins, error: this.error }
  }

  private transition(event: ControlEvent) {
    const snapshot = this.actor.getSnapshot()
    if (!snapshot.can(event)) throw new ControlError('internal', `illegal transition ${event.type} from ${String(snapshot.value)}`)
    this.actor.send(event)
    this.emit({ type: 'state', state: this.state() })
  }

  private emit(event: ControllerEvent) {
    for (const listener of this.listeners) listener(event)
  }

  /** Validate and start a run. Resolves with the runId once the subprocess is spawned. */
  async run(revisionId: string, adapterMode: AdapterMode): Promise<string> {
    if (!this.actor.getSnapshot().can({ type: 'RUN' })) {
      throw new ControlError('busy', `a run is already ${this.phase}; wait for it to settle or cancel it`)
    }
    this.error = null
    this.transition({ type: 'RUN' })

    let revision: ExperimentRevision
    let start: StartMessage
    try {
      revision = await this.options.store.getRevision(revisionId).catch((error: Error) => {
        throw new ControlError(error.name === 'NotFoundError' ? 'not-found' : 'invalid', error.message)
      })
      start = this.validate(revision, adapterMode)
    } catch (error) {
      this.error = { name: 'ValidationError', message: error instanceof Error ? error.message : String(error), sourceRefIds: [] }
      this.transition({ type: 'INVALID' })
      throw error instanceof ControlError ? error : new ControlError('invalid', this.error.message)
    }

    const runId = start.runId
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => { resolveDone = resolve })
    this.active = {
      runId,
      revision,
      child: null,
      records: [],
      payloads: new Map(),
      view: emptySnapshot(),
      settled: null,
      killed: false,
      finished: null,
      writes: Promise.resolve(),
      timers: [],
      done,
      resolveDone,
    }
    const manifest: RunManifest = {
      runId,
      experimentRevisionId: revision.id,
      revisionHash: revision.revisionHash,
      loadedSourceHashes: Object.fromEntries(start.stages.map(stage => [stage.id, stage.sourceHash])),
      environmentSnapshotRef: `runs/${runId}/environment.json`,
      adapterMode,
      mode: 'teaching',
      startedAt: new Date().toISOString(),
      outcome: 'running',
      lastSeq: -1,
      completeness: 'complete',
    }
    this.transition({ type: 'VALID' })
    await this.options.store.createRun(manifest, captureEnvironment(adapterMode, this.options.env))
    await this.options.store.saveRunScenario(runId, start.scenario)
    this.spawn(this.active, start)
    return runId
  }

  /** Wait until the given run has settled and been written. */
  async whenSettled(runId: string) {
    if (this.active?.runId === runId) await this.active.done
  }

  private validate(revision: ExperimentRevision, adapterMode: AdapterMode): StartMessage {
    const { catalog } = this.options
    const scenario = catalog.scenarios[revision.scenarioId]
    if (!scenario) throw new ControlError('invalid', `unknown scenario "${revision.scenarioId}"`)
    if (scenarioHash(scenario) !== revision.scenarioHash) {
      throw new ControlError('invalid', `scenario "${scenario.id}" changed since revision ${revision.id} was created`)
    }
    if (!scenario.adapterModes.includes(adapterMode)) {
      throw new ControlError('invalid', `scenario "${scenario.id}" does not support ${adapterMode} mode`)
    }
    if (adapterMode === 'real') {
      const env = this.options.env ?? process.env
      const missing = RUN_VARIABLES.real.filter(variable => variable.sensitive && !env[variable.name]).map(variable => variable.name)
      if (missing.length) throw new ControlError('invalid', `real mode needs ${missing.join(', ')} in the environment that started pnpm explorer`)
    }
    const executed = compositionForMode(revision.composition, adapterMode)
    const used = new Set(executed.instances.map(instance => instance.stageId))
    const stages = catalog.stages.filter(stage => used.has(stage.id))
    validateComposition(executed, scenario, catalog.stages)
    return {
      type: 'START',
      runId: `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      composition: revision.composition,
      scenario,
      modelScripts: scenario.modelScriptId && catalog.modelScripts[scenario.modelScriptId]
        ? { [scenario.modelScriptId]: catalog.modelScripts[scenario.modelScriptId]! }
        : {},
      stages,
      adapterMode,
      limits: this.options.limits ?? { maxRecords: 50_000, maxPayloadBytes: 10 * 1024 * 1024 },
    }
  }

  private spawn(run: ActiveRun, start: StartMessage) {
    const workerPath = this.options.workerPath ?? new URL('./run-worker.ts', import.meta.url).pathname
    const execArgv = this.options.execArgv ?? ['--import', import.meta.resolve('tsx')]
    const child = fork(workerPath, [], { execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: this.options.env ?? process.env })
    run.child = child
    const secrets = secretValues(this.options.env)
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000) })

    child.on('message', (raw) => {
      const parsed = ChildMessage.safeParse(raw)
      if (!parsed.success || parsed.data.runId !== run.runId || this.active !== run) return
      const message = parsed.data
      if (message.type === 'READY') {
        if (this.phase === 'starting') this.transition({ type: 'READY' })
      } else if (message.type === 'TRACE_BATCH') {
        this.acceptBatch(run, message.records, new Map(message.payloads))
      } else {
        run.settled = {
          outcome: message.outcome,
          truncated: message.truncated,
          error: message.error ? { ...message.error, message: redactText(message.error.message, secrets), sourceRefIds: [] } : null,
        }
      }
    })

    child.on('exit', (code) => {
      for (const timer of run.timers) clearTimeout(timer)
      if (!run.settled) {
        run.settled = run.killed
          ? { outcome: 'terminated', truncated: true, error: { name: 'Terminated', message: 'run subprocess was terminated before cleanup finished', sourceRefIds: [] } }
          : { outcome: 'failed', truncated: true, error: { name: 'SubprocessExit', message: redactText(`run subprocess exited with code ${code}: ${stderr.trim()}`, secrets), sourceRefIds: [] } }
      }
      void this.settle(run)
    })

    if (this.options.runTimeoutMs) {
      run.timers.push(setTimeout(() => this.cancel(), this.options.runTimeoutMs))
    }
    child.send(start)
  }

  private acceptBatch(run: ActiveRun, records: TraceRecord[], payloads: Map<string, JsonValue>) {
    const fresh: TraceRecord[] = []
    for (const [ref, value] of payloads) run.payloads.set(ref, value)
    for (const record of records) {
      if (record.seq !== run.records.length) continue // duplicates and gaps are not applied out of order
      run.records.push(record)
      run.view = reduceTrace(run.view, record, ref => run.payloads.get(ref)!)
      fresh.push(record)
    }
    if (!fresh.length) return
    const toWrite = new Map([...payloads].filter(([ref]) => fresh.some(record => [record.payloadRef, record.beforeRef, record.afterRef].includes(ref))))
    run.writes = run.writes.then(() => this.options.store.appendTrace(run.runId, fresh, toWrite))
    this.emit({ type: 'trace', runId: run.runId, records: fresh })
    if (fresh.some(record => record.name === TraceName.pluginPhase || record.name.startsWith('registration/'))) {
      this.emit({ type: 'state', state: this.state() })
    }
  }

  /** Cooperative cancel first; force-terminate after the cleanup deadline. */
  cancel() {
    const run = this.active
    if (!run || !this.actor.getSnapshot().can({ type: 'CANCEL' })) return false
    this.transition({ type: 'CANCEL' })
    run.child?.send({ type: 'CANCEL' })
    run.timers.push(setTimeout(() => {
      if (run.child && run.child.exitCode === null) {
        run.killed = true
        run.child.kill('SIGKILL')
      }
    }, this.options.cleanupTimeoutMs ?? 5000))
    return true
  }

  private async settle(run: ActiveRun) {
    const settled = run.settled!
    if (this.phase === 'starting') this.transition({ type: 'START_FAILED' })
    else if (this.phase === 'running') this.transition({ type: 'ENDED' })
    else if (this.phase === 'stopping') this.transition({ type: 'STOPPED' })
    const finalSeq = run.records.length - 1
    try {
      await run.writes
      await this.options.store.updateManifest(run.runId, {
        outcome: settled.outcome,
        lastSeq: finalSeq,
        completeness: settled.truncated ? 'truncated' : 'complete',
      })
    } catch (error) {
      this.error = { name: 'StoreError', message: `run ${run.runId} was not saved: ${error instanceof Error ? error.message : String(error)}`, sourceRefIds: [] }
    }
    this.error ??= settled.error
    run.finished = { finalSeq, outcome: settled.outcome }
    this.transition({ type: 'SETTLED' })
    this.emit({ type: 'settled', runId: run.runId, finalSeq, outcome: settled.outcome })
    run.resolveDone()
  }
}
