import type { TraceRecord } from '@harness-explorer/contracts'

export interface Gap {
  fromSeq: number
  toSeq: number
}

/**
 * Receiver-side buffer for TRACE_BATCH delivery: drops duplicates, accepts
 * out-of-order batches, and reports gaps instead of interpolating them.
 * Work per batch is proportional to the batch, not to the whole trace.
 */
export class TraceBuffer {
  /** Records 0..n-1 with no hole; only ever appended to. */
  private readonly prefix: TraceRecord[] = []
  /** Records that arrived ahead of a hole. */
  private readonly ahead = new Map<number, TraceRecord>()
  private finalSeq: number | null = null

  constructor(readonly runId: string) {}

  add(records: readonly TraceRecord[]) {
    let added = 0
    for (const record of records) {
      if (record.runId !== this.runId) {
        throw new Error(`record of run ${record.runId} delivered to buffer of ${this.runId}`)
      }
      if (record.seq < this.prefix.length || this.ahead.has(record.seq)) continue
      this.ahead.set(record.seq, record)
      added++
    }
    while (this.ahead.has(this.prefix.length)) {
      const next = this.ahead.get(this.prefix.length)!
      this.ahead.delete(next.seq)
      this.prefix.push(next)
    }
    return added
  }

  settle(finalSeq: number) {
    this.finalSeq = finalSeq
  }

  /** Highest seq such that every seq up to it has arrived; -1 when none. */
  get lastContiguousSeq() {
    return this.prefix.length - 1
  }

  gaps(): Gap[] {
    const ahead = [...this.ahead.keys()].sort((a, b) => a - b)
    const end = this.finalSeq ?? ahead.at(-1) ?? this.prefix.length - 1
    const gaps: Gap[] = []
    let expected = this.prefix.length
    for (const seq of ahead) {
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

  /** The contiguous prefix as a live, append-only view (no copy). */
  get records(): readonly TraceRecord[] {
    return this.prefix
  }

  contiguous(): TraceRecord[] {
    return [...this.prefix]
  }
}
