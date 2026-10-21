'use client'
/**
 * Replay bar floating over the canvas bottom (docs/design/explorer-redesign.md
 * §2.6): playback, stepping, a progress bar segmented by scenario steps, speed,
 * jumps to scenario end/latest, and the trace-drawer toggle. Playback only
 * moves the cursor; it never re-executes plugins.
 */
import { useEffect, useMemo, useState } from 'react'
import { TraceName } from '@harness-explorer/contracts'
import type { ScenarioStep } from '@harness-explorer/contracts'
import type { RunData } from '@/lib/store'

/** Cursor step interval at 1× playback. */
const PLAYBACK_MS = 400

interface Segment {
  seq: number
  endSeq: number
  name: string
  title: string
}

const STEP_NAME: Record<ScenarioStep['kind'], string> = {
  input: '请求',
  mount: '挂载',
  unmount: '卸载',
  snapshot: '快照',
  cancel: '取消',
}

/** One progress segment per scenario step; the head covers the initial mount. */
export function segmentsOf(data: RunData | undefined): Segment[] {
  if (!data || data.records.length === 0) return []
  const steps = data.records.filter(record => record.name === TraceName.scenarioStep && record.payloadRef)
  const segments: Segment[] = []
  const first = steps[0]
  if (first && first.seq > 0) segments.push({ seq: 0, endSeq: first.seq - 1, name: '初始挂载', title: '初始挂载' })
  let inputs = 0
  steps.forEach((record, index) => {
    const step = data.payloads[record.payloadRef!] as ScenarioStep
    if (step.kind === 'input') inputs++
    const name = step.kind === 'input' ? `请求 #${inputs}` : `${STEP_NAME[step.kind]}${'instanceId' in step ? ` ${step.instanceId}` : ''}`
    segments.push({ seq: record.seq, endSeq: (steps[index + 1]?.seq ?? data.records.at(-1)!.seq + 1) - 1, name, title: `步骤 ${step.id}` })
  })
  return segments
}

interface Props {
  data: RunData | undefined
  seq: number
  lastSeq: number
  traceOpen: boolean
  /** `请求 #N` / `初始挂载`, shown in the narrow mini bar next to 步骤 x/y (§4). */
  requestTitle?: string | null
  onCursor(seq: number | null): void
  onToggleTrace(): void
}

export function ReplayBar({ data, seq, lastSeq, traceOpen, requestTitle = null, onCursor, onToggleTrace }: Props) {
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const records = data?.records ?? []
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      const next = records.find(record => record.seq > seq)
      if (next) onCursor(next.seq)
      else setPlaying(false)
    }, PLAYBACK_MS / speed)
    return () => clearInterval(timer)
  }, [playing, speed, records, seq, onCursor])
  useEffect(() => setPlaying(false), [data?.runId])

  const segments = useMemo(() => segmentsOf(data), [data])

  if (!data) {
    return (
      <div className="replay-bar">
        <span className="muted">还没有运行。点击「运行教学代码」。</span>
      </div>
    )
  }

  const togglePlayback = () => {
    if (playing) return setPlaying(false)
    if (!records.some(record => record.seq > seq)) onCursor(-1)
    setPlaying(true)
  }
  const step = (direction: 1 | -1) => {
    const after = records.findIndex(record => record.seq > seq)
    const end = after < 0 ? records.length : after
    const before = records[end - 1]?.seq === seq ? end - 2 : end - 1
    const target = direction > 0 ? records[after] : records[before]
    if (target) onCursor(target.seq)
    else if (direction < 0) onCursor(-1)
  }
  const currentSegment = segments.findIndex(segment => seq >= segment.seq && seq <= segment.endSeq)

  return (
    <div className="replay-bar" title="回放只移动游标，不重新执行">
      <span className="sr-only">回放只移动游标，不重新执行。</span>
      <button type="button" className="replay-bar__play" onClick={togglePlayback} aria-pressed={playing} aria-label={playing ? '暂停回放' : '播放回放'}>
        {playing ? '⏸' : '▶'}
      </button>
      <button type="button" onClick={() => step(-1)} aria-label="上一条记录">⏮</button>
      <button type="button" onClick={() => step(1)} aria-label="下一条记录">⏭</button>
      <div className="replay-bar__position">
        {currentSegment >= 0 ? <span className="replay-bar__step">步骤 {currentSegment + 1} / {segments.length}</span> : null}
        <span className="replay-bar__seq">回放位置 {seq} / {lastSeq}</span>
        {requestTitle ? <span className="replay-bar__request">{requestTitle}</span> : null}
      </div>
      <div className="replay-bar__segments" role="group" aria-label="回放分段进度">
        {segments.map((segment, index) => (
          <button
            key={segment.seq}
            type="button"
            className="replay-segment"
            style={{ ['--grow' as never]: Math.max(1, segment.endSeq - segment.seq + 1) }}
            title={`${segment.name} · ${segment.title}（#${segment.seq}–${segment.endSeq}）`}
            aria-current={index === currentSegment ? 'step' : undefined}
            onClick={() => onCursor(segment.seq)}
          >
            <span className="replay-segment__bar">
              <span className="replay-segment__fill" style={{ width: `${Math.min(100, Math.max(0, ((seq - segment.seq + 1) / (segment.endSeq - segment.seq + 1)) * 100))}%` }} />
            </span>
            <span className="replay-segment__name">{segment.name}</span>
          </button>
        ))}
        {/* The scrub slider is an invisible track over the segment bars: the
            segments are the visual control, the slider keeps keyboard/AT and
            fine-grained access (e2e drives it by label). */}
        <input
          type="range"
          className="replay-bar__scrub"
          min={-1}
          max={Math.max(lastSeq, -1)}
          value={seq}
          // The trace streams in after the manifest; until the first record lands there is nowhere to slide to.
          disabled={records.length === 0}
          onChange={event => onCursor(Number(event.target.value))}
          aria-label="回放位置"
        />
      </div>
      <label className="replay-bar__speed">
        速度
        <select value={speed} onChange={event => setSpeed(Number(event.target.value))}>
          {[1, 2, 4].map(value => <option key={value} value={value}>{value}×</option>)}
        </select>
      </label>
      <button type="button" className="replay-bar__jump" onClick={() => onCursor(null)}>场景结束</button>
      <button type="button" className="replay-bar__jump" onClick={() => onCursor(lastSeq)}>到最新（含结算）</button>
      <button type="button" className="tool-button replay-bar__trace" aria-pressed={traceOpen} onClick={onToggleTrace}>轨迹</button>
    </div>
  )
}
