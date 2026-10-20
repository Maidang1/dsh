'use client'
/**
 * Windowed trace list (docs/02 §14): rows have a fixed height and only the
 * visible slice plus an overscan margin is rendered, so a long trace costs
 * the same as a short one. The current replay position is kept in view.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { JsonValue, TraceRecord } from '@harness-explorer/contracts'

export const ROW_HEIGHT = 24
const OVERSCAN = 10

interface Props {
  records: readonly TraceRecord[]
  payloads: Readonly<Record<string, JsonValue>>
  seq: number
  onCursor(seq: number): void
}

/** Index of the record with this seq in a seq-sorted list, or -1. */
export function indexOfSeq(records: readonly TraceRecord[], seq: number) {
  let low = 0
  let high = records.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const value = records[middle]!.seq
    if (value === seq) return middle
    if (value < seq) low = middle + 1
    else high = middle - 1
  }
  return -1
}

function label(record: TraceRecord, payloads: Props['payloads']) {
  if (record.name === 'run/settle') return 'run/settle · 运行结算：逆序卸载全部实例'
  if (record.name === 'session/event' && record.payloadRef) {
    return `session/event · ${String((payloads[record.payloadRef] as { type?: string } | undefined)?.type)}`
  }
  return record.name
}

export function TimelineRows({ records, payloads, seq, onCursor }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(320)

  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(() => setHeight(element.clientHeight))
    observer.observe(element)
    setHeight(element.clientHeight)
    return () => observer.disconnect()
  }, [])

  // Keep the current position visible when the cursor moves.
  const current = indexOfSeq(records, seq)
  useEffect(() => {
    const element = container.current
    if (!element || current < 0) return
    const top = current * ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + ROW_HEIGHT - element.clientHeight
  }, [current])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const from = current >= 0 ? current : records.findIndex(record => record.seq > seq) - (event.key === 'ArrowDown' ? 1 : 0)
    const target = records[Math.min(Math.max(from + (event.key === 'ArrowDown' ? 1 : -1), 0), records.length - 1)]
    if (target) onCursor(target.seq)
  }

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(records.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)

  return (
    <div
      ref={container}
      className="timeline__list"
      role="list"
      aria-label="轨迹记录（↑↓ 移动回放位置）"
      tabIndex={0}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      <div style={{ height: records.length * ROW_HEIGHT, position: 'relative' }}>
        {records.slice(start, end).map((record, offset) => {
          const index = start + offset
          return (
            <div
              key={record.seq}
              role="listitem"
              aria-setsize={records.length}
              aria-posinset={index + 1}
              aria-current={record.seq === seq ? 'step' : undefined}
              className={`timeline__row ${record.seq === seq ? 'is-current' : record.seq > seq ? 'is-future' : ''}`}
              style={{ top: index * ROW_HEIGHT }}
            >
              <button type="button" tabIndex={-1} onClick={() => onCursor(record.seq)}>
                <span className="timeline__seq">#{record.seq}</span>
                <span className={`kind kind-${record.kind}`}>{record.kind}</span>
                <span>{label(record, payloads)}</span>
                {record.instanceId ? <span className="muted">{record.instanceId}</span> : null}
                {record.scenarioStepId ? <span className="muted">步骤 {record.scenarioStepId}</span> : null}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
