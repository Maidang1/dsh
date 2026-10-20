import type { TraceKind, TraceRecord } from '@harness-explorer/contracts'
import { PayloadStore, toJsonSnapshot } from './payload.ts'

export interface RecordInput {
  kind: TraceKind
  name: string
  instanceId?: string
  scopeId?: string
  scenarioStepId?: string
  spanId?: string
  parentSpanId?: string
  causeSeq?: number
  sessionId?: string
  turnId?: string
  stepId?: string
  sourceRefIds?: string[]
  before?: unknown
  after?: unknown
  payload?: unknown
}

export interface RecorderOptions {
  runId: string
  /** Logical clock; deterministic runs pass a virtual clock. */
  now: () => number
  maxRecords?: number
  maxPayloadBytes?: number
  /** Called synchronously for each record, with the store holding its payloads. */
  onRecord?: (record: TraceRecord, payloads: PayloadStore) => void
}

/**
 * The single writer of a run's trace. Every observation goes through `record`,
 * which assigns the run-wide monotonic seq. Seq is the observed total order,
 * not a causality proof; causality travels in span/parentSpan/causeSeq.
 */
export class Recorder {
  readonly records: TraceRecord[] = []
  readonly payloads = new PayloadStore()
  private nextSeq = 0
  private spanCounter = 0
  private _truncated = false

  constructor(private readonly options: RecorderOptions) {}

  get truncated() {
    return this._truncated
  }

  get lastSeq() {
    return this.nextSeq - 1
  }

  newSpanId(prefix = 'span') {
    return `${prefix}-${++this.spanCounter}`
  }

  record(input: RecordInput): TraceRecord | null {
    if (this._truncated) return null
    const { maxRecords = Infinity, maxPayloadBytes = Infinity } = this.options
    const put = (value: unknown) => value === undefined ? undefined : this.payloads.put(toJsonSnapshot(value))
    const beforeRef = put(input.before)
    const afterRef = put(input.after)
    const payloadRef = put(input.payload)
    if (this.records.length >= maxRecords || this.payloads.totalBytes > maxPayloadBytes) {
      this._truncated = true
      return null
    }

    const record: TraceRecord = {
      schemaVersion: 1,
      runId: this.options.runId,
      seq: this.nextSeq++,
      logicalTime: this.options.now(),
      kind: input.kind,
      name: input.name,
      sourceRefIds: input.sourceRefIds ?? [],
    }
    const optional = ['instanceId', 'scopeId', 'scenarioStepId', 'spanId', 'parentSpanId', 'causeSeq', 'sessionId', 'turnId', 'stepId'] as const
    for (const key of optional) {
      if (input[key] !== undefined) (record as Record<string, unknown>)[key] = input[key]
    }
    if (beforeRef) record.beforeRef = beforeRef
    if (afterRef) record.afterRef = afterRef
    if (payloadRef) record.payloadRef = payloadRef
    Object.freeze(record)
    this.records.push(record)
    this.options.onRecord?.(record, this.payloads)
    return record
  }
}
