'use client'
/**
 * Trace drawer over the lower half of the canvas (docs/design/explorer-redesign.md
 * §2.7, screen 01f): title, record count and keyboard hint, a TraceKind filter,
 * the current record row, and the virtualized record list with ↑↓ cursor moves.
 */
import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PluginInstance, TraceKind } from '@harness-explorer/contracts'
import type { LessonsResponse } from '@/lib/api'
import type { RunData } from '@/lib/store'
import { TimelineRows } from './TimelineRows'
import { lessonHref, outcomeText } from './Panels'

const KIND_FILTERS: ReadonlyArray<'全部' | TraceKind> = ['全部', 'lifecycle', 'service', 'dispatch', 'session', 'checkpoint', 'data', 'diagnostic']

/**
 * The record at the cursor and the instance it belongs to, with the stage
 * taken from the run's own revision rather than the current draft.
 */
function CurrentRecord({ data, seq, lessons, onSelectInstance }: { data: RunData; seq: number; lessons: LessonsResponse | null; onSelectInstance(id: string): void }) {
  const record = data.records[seq]
  if (!record) return null
  const instance = record.instanceId ? data.revision?.composition.instances.find(item => item.id === record.instanceId) : undefined
  const lesson = instance ? lessons?.lessons.find(item => item.pluginDefinitionId === instance.definitionId) : undefined
  const ranStage = lesson?.stages.some(stage => stage.codeStageId === instance?.stageId)
  return (
    <p className="timeline__current" aria-label="当前记录">
      当前记录 #{record.seq} <code>{record.name}</code>
      {instance ? (
        <>
          {' '}· 实例 {instance.id}（本次运行的阶段 {instance.stageId}）
          {' '}<button type="button" className="link-button" onClick={() => onSelectInstance(instance.id)}>在插件树中选中</button>
          {lesson && ranStage ? <>{' '}<Link className="link-button" href={lessonHref(lesson.id, instance as PluginInstance)}>查看该阶段代码</Link></> : null}
        </>
      ) : record.instanceId ? ` · 实例 ${record.instanceId}` : null}
    </p>
  )
}

interface Props {
  data: RunData
  seq: number
  onCursor(seq: number | null): void
  lessons: LessonsResponse | null
  onSelectInstance(id: string): void
  onClose(): void
}

/**
 * Drawer content shared by the floating drawer (wide) and the 轨迹 tab pane
 * (narrow, §4): head with count/filter, current record, gaps, the virtualized
 * list. `actions` is the head's trailing slot (the drawer's close button).
 */
export function TraceContent({ data, seq, onCursor, lessons, onSelectInstance, actions }: Omit<Props, 'onClose'> & { actions?: ReactNode }) {
  const [filter, setFilter] = useState<(typeof KIND_FILTERS)[number]>('全部')
  const count = data.records.length
  const records = useMemo(
    () => (filter === '全部' ? data.records : data.records.filter(record => record.kind === filter)),
    // Records only grow; their count identifies the contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.runId, count, filter],
  )
  return (
    <>
      <div className="trace-drawer__head">
        <span className="trace-drawer__title">执行轨迹 · {records.length} 条</span>
        <span className="muted">↑↓ 移动回放位置</span>
        <label>
          类型
          <select value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
            {KIND_FILTERS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
          </select>
        </label>
        <span className="spacer" style={{ flex: 1 }} />
        {actions}
      </div>
      <div className="trace-drawer__body">
        <CurrentRecord data={data} seq={seq} lessons={lessons} onSelectInstance={onSelectInstance} />
        {data.gaps.length ? <p className="warning-text">轨迹缺口：{data.gaps.map(gap => `${gap.fromSeq}–${gap.toSeq}`).join('，')}，结果不完整。</p> : null}
        {data.settled ? <p className="muted">结算结果：{outcomeText(data.settled.outcome)}，最后序号 {data.settled.finalSeq}</p> : <p className="muted">运行未结算，结果尚不完整。</p>}
        {data.settled?.completeness === 'truncated' ? <p className="warning-text">轨迹不完整：达到采集上限、写盘失败或运行中断，缺失的尾部不能视为成功。</p> : null}
        <TimelineRows records={records} payloads={data.payloads} seq={seq} onCursor={onCursor} />
      </div>
    </>
  )
}

export function TraceDrawer({ onClose, ...props }: Props) {
  return (
    <section className="trace-drawer" aria-label="执行轨迹">
      <TraceContent {...props} actions={<button type="button" aria-label="关闭轨迹抽屉" onClick={onClose}>✕</button>} />
    </section>
  )
}
