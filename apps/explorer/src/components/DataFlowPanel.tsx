'use client'
/**
 * Right-panel 数据流 tab (docs/design/explorer-redesign.md §2.5, screen 01):
 * the request window at the cursor as a numbered step timeline, the current
 * model request's system paragraphs compared with the previous request, and
 * the lesson's expected observations for the current step.
 */
import Link from 'next/link'
import { TraceName } from '@harness-explorer/contracts'
import type { Composition, PluginInstance } from '@harness-explorer/contracts'
import type { LessonsResponse } from '@/lib/api'
import type { RunData } from '@/lib/store'
import type { RequestFlow } from '@/lib/dataflow'
import { diffSystemParagraphs, requestPayloadOf } from '@/lib/dataflow'
import { lessonHref } from './Panels'

interface Props {
  data: RunData | undefined
  flow: RequestFlow | null
  seq: number
  /** Cursor null = following the scenario end. */
  following: boolean
  lessons: LessonsResponse | null
  /** The composition on screen (the selected run's revision or the draft). */
  composition: Composition
  /** Instance selected in the tree; the observe card falls back to its lesson. */
  selectedInstanceId: string | null
  onCursor(seq: number): void
  onSelectInstance(id: string): void
}

function lessonFor(lessons: LessonsResponse | null, instance: PluginInstance | undefined) {
  return instance ? lessons?.lessons.find(item => item.pluginDefinitionId === instance.definitionId) : undefined
}

/** The expanded payload of the current step; only model/request expands for now (§2.5). */
function CurrentStepDetail({ data, seq, lessons, composition }: { data: RunData; seq: number; lessons: LessonsResponse | null; composition: Composition }) {
  const record = data.records[seq]
  if (!record) return null
  const request = requestPayloadOf(data, record)
  if (!request) return null
  const paragraphs = diffSystemParagraphs(data, seq, request)
  const addedCount = paragraphs.filter(paragraph => paragraph.added).length
  const instanceOf = (id: string) => composition.instances.find(item => item.id === id)
  return (
    <div className="flow-request">
      <div className="flow-request__row">
        <span>request.system</span>
        <span className="flow-request__delta">+{addedCount} 段 vs 上一次请求</span>
      </div>
      {paragraphs.map((paragraph, index) => {
        const source = paragraph.source ? instanceOf(paragraph.source.instanceId) : undefined
        const lesson = lessonFor(lessons, source)
        return (
          <div key={index}>
            <div className={`flow-paragraph${paragraph.added ? ' flow-paragraph--added' : ''}`}>
              {paragraph.added ? '+ ' : '§ '}{paragraph.text}
            </div>
            {paragraph.source ? (
              <div className="flow-paragraph__source">
                <span>来自 {paragraph.source.instanceId} · {paragraph.source.registrationName}</span>
                {lesson && source ? <Link className="link-button" href={lessonHref(lesson.id, source)}>看源码 →</Link> : null}
              </div>
            ) : null}
          </div>
        )
      })}
      <div className="flow-request__row">
        <span>messages {request.messages.length} 条 · tools [{request.tools.map(tool => tool.name).join(', ') || '无'}]</span>
      </div>
    </div>
  )
}

/** 「这一步要观察」: the lesson's expectedObservations, labelled as authored guidance, not trace (§2.5). */
function ObserveCard({ data, seq, lessons, composition, flow, selectedInstanceId }: {
  data: RunData
  seq: number
  lessons: LessonsResponse | null
  composition: Composition
  flow: RequestFlow | null
  selectedInstanceId: string | null
}) {
  const byId = (id: string | null | undefined) => (id ? composition.instances.find(item => item.id === id) : undefined)
  const matchFor = (instance: PluginInstance | undefined) => {
    const lesson = lessonFor(lessons, instance)
    const stage = lesson?.stages.find(item => item.codeStageId === instance?.stageId)
    return lesson && stage && stage.expectedObservations.length > 0 ? { lesson, stage } : null
  }
  // The current record's instance first; on model/request that is agent-loop
  // (no lesson), so fall back to the tree selection, then to the lesson
  // instances that produced records in this request window (window order).
  const windowInstances = flow ? [...new Set(flow.steps.map(step => step.instanceId).filter((id): id is string => id !== null))] : []
  const candidates = [byId(data.records[seq]?.instanceId), byId(selectedInstanceId), ...windowInstances.map(byId)]
  const match = candidates.map(matchFor).find(found => found !== null) ?? null
  if (!match) return null
  const { lesson, stage } = match
  return (
    <div className="flow-observe">
      <h4>这一步要观察</h4>
      {stage.expectedObservations.map((observation, index) => <p key={index}>{observation}</p>)}
      <p className="muted">来自课程「{lesson.title} · {stage.title}」的预期观察点，不是轨迹记录。</p>
    </div>
  )
}

export function DataFlowPanel({ data, flow, seq, following, lessons, composition, selectedInstanceId, onCursor, onSelectInstance }: Props) {
  if (!data || !flow) {
    return <div className="panel-body"><p className="muted">还没有运行。运行后这里按一次请求展示数据流经的步骤。</p></div>
  }
  return (
    <div className="panel-body">
      <div className="flow-panel__head">
        <h2 className="flow-panel__title">
          {flow.title} · {flow.steps.length} 步
          {!following ? <span className="flow-panel__live">● 回放中</span> : null}
        </h2>
        <span className="flow-panel__sub">{flow.subtitle}</span>
      </div>
      <ol className="flow-steps" aria-label="数据流步骤">
        {flow.steps.map((step, index) => (
          <li key={step.seq} className={`flow-step flow-step--${step.state}`}>
            <button type="button" className="flow-step__row" onClick={() => onCursor(step.seq)} aria-label={`跳到步骤记录 #${step.seq}`}>
              <span className="flow-step__num" aria-hidden>{index + 1}</span>
              <span className="flow-step__name" title={step.name}>{step.name}</span>
              {step.instanceId ? <span className="flow-step__instance">{step.instanceId}</span> : null}
              <span className="flow-step__summary">{step.summary}</span>
            </button>
            {step.state !== 'upcoming' && step.seq === seq && step.name === TraceName.modelRequest ? (
              <CurrentStepDetail data={data} seq={seq} lessons={lessons} composition={composition} />
            ) : null}
          </li>
        ))}
      </ol>
      <ObserveCard data={data} seq={seq} lessons={lessons} composition={composition} flow={flow} selectedInstanceId={selectedInstanceId} />
      <div className="flow-legend" aria-label="图例">
        <span><span className="swatch swatch--dep" aria-hidden />依赖 inject</span>
        <span><span className="swatch swatch--flown" aria-hidden />已流经</span>
        <span><span className="swatch swatch--current" aria-hidden />当前数据</span>
      </div>
    </div>
  )
}
