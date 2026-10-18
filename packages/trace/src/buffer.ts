import type { TraceRecord } from '@harness-explorer/contracts'

export interface Gap {
  fromSeq: number
  toSeq: number
}

/**
 * Receiver-side buffer for TRACE_BATCH delivery: drops duplicates, accepts
 * out-of-order batches, and reports gaps instead of interpolating them.
 */
export class TraceBuffer {
  private readonly bySeq = new Map<number, TraceRecord>()
  private finalSeq: number | null = null

  constructor(readonly runId: string) {}

  add(records: readonly TraceRecord[]) {
    let added = 0
    for (const record of records) {
      if (record.runId !== this.runId) {
        throw new Error(`record of run ${record.runId} delivered to buffer of ${this.runId}`)
      }
      if (this.bySeq.has(record.seq)) continue
      this.bySeq.set(record.seq, record)
      added++
    }
    return added
  }

  settle(finalSeq: number) {
    this.finalSeq = finalSeq
  }

  /** Highest seq such that every seq up to it has arrived; -1 when none. */
  get lastContiguousSeq() {
    let seq = -1
    while (this.bySeq.has(seq + 1)) seq++
    return seq
  }

  gaps(): Gap[] {
    const known = [...this.bySeq.keys()].sort((a, b) => a - b)
    const end = this.finalSeq ?? known.at(-1) ?? -1
    const gaps: Gap[] = []
    let expected = 0
    for (const seq of known) {
      if (seq > expected) gaps.push({ fromSeq: expected, toSeq: seq - 1 })
      expected = seq + 1
    }
    if (end >= expected) gaps.push({ fromSeq: expected, toSeq: end })
    return gaps
  }

  /** A run is complete only after settlement with every record through finalSeq. */
  get complete() {
    return this.finalSeq !== null && this.lastContiguousSeq === this.finalSeq
  }

  contiguous(): TraceRecord[] {
    const result: TraceRecord[] = []
    for (let seq = 0; this.bySeq.has(seq); seq++) result.push(this.bySeq.get(seq)!)
    return result
  }
}
