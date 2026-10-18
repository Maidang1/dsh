import {
  DiagnosticPayload,
  ModelRequestPayload,
  PluginPhasePayload,
  RegistrationAddPayload,
  RegistrationRemovePayload,
  ServiceChangePayload,
  SessionEventPayload,
  TraceName,
} from '@harness-explorer/contracts'
import type { JsonValue, TraceRecord } from '@harness-explorer/contracts'

export interface ViewRegistration extends RegistrationAddPayload {
  instanceId: string | null
  addedAtSeq: number
}

/** Pure projection of a trace up to `seq`. Plain JSON so it can be cloned and compared. */
export interface ViewSnapshot {
  seq: number
  plugins: Record<string, PluginPhasePayload>
  services: Record<string, ServiceChangePayload>
  registrations: Record<string, ViewRegistration>
  requests: ModelRequestPayload[]
  sessionEvents: SessionEventPayload[]
  diagnostics: Array<DiagnosticPayload & { seq: number }>
}

export type PayloadResolver = (ref: string) => JsonValue

export function emptySnapshot(): ViewSnapshot {
  return { seq: -1, plugins: {}, services: {}, registrations: {}, requests: [], sessionEvents: [], diagnostics: [] }
}

/**
 * Fold one record into a snapshot without mutating the previous snapshot.
 * Records must arrive in seq order; unknown names only advance the cursor.
 */
export function reduceTrace(previous: ViewSnapshot, record: TraceRecord, resolve: PayloadResolver): ViewSnapshot {
  if (record.seq !== previous.seq + 1) {
    throw new Error(`replay expects seq ${previous.seq + 1}, received ${record.seq}`)
  }
  const next: ViewSnapshot = { ...previous, seq: record.seq }
  const payload = () => {
    if (!record.payloadRef) throw new Error(`${record.name} #${record.seq} has no payload`)
    return resolve(record.payloadRef)
  }

  switch (record.name) {
    case TraceName.pluginPhase: {
      if (!record.instanceId) throw new Error(`plugin/phase #${record.seq} has no instanceId`)
      next.plugins = { ...previous.plugins, [record.instanceId]: PluginPhasePayload.parse(payload()) }
      break
    }
    case TraceName.serviceChange: {
      const change = ServiceChangePayload.parse(payload())
      next.services = { ...previous.services, [change.name]: change }
      break
    }
    case TraceName.registrationAdd: {
      const added = RegistrationAddPayload.parse(payload())
      next.registrations = {
        ...previous.registrations,
        [added.registrationId]: { ...added, instanceId: record.instanceId ?? null, addedAtSeq: record.seq },
      }
      break
    }
    case TraceName.registrationRemove: {
      const { registrationId } = RegistrationRemovePayload.parse(payload())
      const { [registrationId]: _removed, ...rest } = previous.registrations
      next.registrations = rest
      break
    }
    case TraceName.modelRequest:
      next.requests = [...previous.requests, ModelRequestPayload.parse(payload())]
      break
    case TraceName.sessionEvent:
      next.sessionEvents = [...previous.sessionEvents, SessionEventPayload.parse(payload())]
      break
    case TraceName.diagnostic:
      next.diagnostics = [...previous.diagnostics, { ...DiagnosticPayload.parse(payload()), seq: record.seq }]
      break
  }
  return next
}

/**
 * Replay index with periodic snapshots: jumping loads the nearest earlier
 * snapshot and folds forward, never running reverse business operations.
 */
export class ReplayIndex {
  private readonly checkpoints: ViewSnapshot[] = []

  constructor(
    private readonly records: readonly TraceRecord[],
    private readonly resolve: PayloadResolver,
    private readonly interval = 100,
  ) {
    let snapshot = emptySnapshot()
    this.checkpoints.push(snapshot)
    for (const record of records) {
      snapshot = reduceTrace(snapshot, record, resolve)
      if ((record.seq + 1) % interval === 0) this.checkpoints.push(snapshot)
    }
  }

  get lastSeq() {
    return this.records.length - 1
  }

  at(seq: number): ViewSnapshot {
    if (seq < -1 || seq > this.lastSeq) throw new RangeError(`seq ${seq} outside replay range -1..${this.lastSeq}`)
    const checkpoint = this.checkpoints[Math.floor((seq + 1) / this.interval)]!
    let snapshot = checkpoint
    for (let index = checkpoint.seq + 1; index <= seq; index++) {
      snapshot = reduceTrace(snapshot, this.records[index]!, this.resolve)
    }
    return snapshot
  }
}

export function replayAll(records: readonly TraceRecord[], resolve: PayloadResolver): ViewSnapshot {
  return records.reduce((snapshot, record) => reduceTrace(snapshot, record, resolve), emptySnapshot())
}
