'use client'
import { useMemo } from 'react'
import { ReplayIndex, emptySnapshot } from '@harness-explorer/trace/browser'
import type { ViewSnapshot } from '@harness-explorer/trace/browser'
import type { ModelRequestPayload } from '@harness-explorer/contracts'
import type { RunData } from './store'

export interface Replay {
  index: ReplayIndex | null
  lastSeq: number
  seq: number
  snapshot: ViewSnapshot
}

/** Project the selected run at the replay cursor. Moving the cursor never re-executes anything. */
export function useReplay(data: RunData | undefined, cursor: number | null): Replay {
  const count = data?.records.length ?? 0
  const index = useMemo(
    () => (data && count ? new ReplayIndex(data.records, ref => data.payloads[ref]!, 100) : null),
    // Records only grow; their count identifies the contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data?.runId, count],
  )
  const lastSeq = count - 1
  // By default show the scenario's final state, before settlement unloads everything.
  const settleSeq = data?.records.find(record => record.name === 'run/settle')?.seq
  const seq = cursor === null ? (settleSeq !== undefined ? settleSeq - 1 : lastSeq) : Math.min(cursor, lastSeq)
  const snapshot = useMemo(() => (index && seq >= 0 ? index.at(seq) : emptySnapshot()), [index, seq])
  return { index, lastSeq, seq, snapshot }
}

export interface RequestEntry {
  key: string
  label: string
  request: ModelRequestPayload
}

/** Every model request in a run, labelled by the scenario step that sent it. */
export function requestsOf(data: RunData | undefined, prefix = ''): RequestEntry[] {
  if (!data) return []
  return data.records
    .filter(record => record.name === 'model/request' && record.payloadRef)
    .map(record => {
      const request = data.payloads[record.payloadRef!] as unknown as ModelRequestPayload
      return {
        key: `${data.runId}:${record.seq}`,
        label: `${prefix}${record.scenarioStepId ?? '—'} · ${request.requestId} · #${record.seq}`,
        request,
      }
    })
}

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string }

/** Line diff by longest common subsequence; inputs are small (prompts, messages). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ kind: 'removed', text: a[i++]! })
    } else {
      lines.push({ kind: 'added', text: b[j++]! })
    }
  }
  while (i < a.length) lines.push({ kind: 'removed', text: a[i++]! })
  while (j < b.length) lines.push({ kind: 'added', text: b[j++]! })
  return lines
}
