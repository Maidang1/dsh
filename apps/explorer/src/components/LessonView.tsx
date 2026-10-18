'use client'
/**
 * 插件实现 workspace (docs/01 §3.2): Code Hike code takes the main width, the
 * architecture, state and upstream mapping sit beside it, and the stage
 * navigator plus the stage's own run sit below.
 */
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { BuiltLesson } from '@harness-explorer/lesson-kit/schema'
import type { ModelRequestPayload } from '@harness-explorer/contracts'
import type { LessonStageView } from '@/lib/lesson-data'
import { useReplay } from '@/lib/replay'
import { useExplorer } from '@/lib/store'
import { LessonCode } from './CodePanel'
import { phaseOf } from './PluginTree'
import { outcomeText } from './Panels'
import { NarrowTabs, narrowPane } from './NarrowTabs'

type SideTab = 'architecture' | 'state' | 'upstream'

interface Props {
  lesson: Omit<BuiltLesson, 'mdx'>
  views: LessonStageView[]
  intro: ReactNode
  sections: Record<string, ReactNode>
}

const UPSTREAM_REPO = 'https://github.com/deepseek-ai/deepseek-harness'

export function LessonView({ lesson, views, intro, sections }: Props) {
  const state = useExplorer()
  const [index, setIndex] = useState(0)
  const [fileKey, setFileKey] = useState('entry')
  const [pane, setPane] = useState<'code' | 'side'>('code')
  const [tab, setTab] = useState<SideTab>('architecture')
  useEffect(() => { void useExplorer.getState().init() }, [])

  // Restore the reading position once progress is loaded, then save every move.
  const lessonProgress = state.progress?.lessons[lesson.id]
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !state.progress) return
    restored.current = true
    const saved = views.findIndex(item => item.stage.id === lessonProgress?.lastStageId)
    if (saved > 0) setIndex(saved)
  }, [state.progress, lessonProgress, views])
  useEffect(() => {
    if (!restored.current) return
    const stageId = views[index]!.stage.id
    if (stageId !== useExplorer.getState().progress?.lessons[lesson.id]?.lastStageId) {
      void useExplorer.getState().updateLessonProgress(lesson.id, { lastStageId: stageId })
    }
  }, [index, views, lesson.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
      if (event.key === 'ArrowRight') setIndex(current => Math.min(current + 1, views.length - 1))
      if (event.key === 'ArrowLeft') setIndex(current => Math.max(current - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [views.length])

  const view = views[index]!
  const stage = view.stage
  const file = view.files.find(item => item.key === fileKey) ?? view.files[0]!

  // The selected run counts as this stage's run only if its revision ran this stage's code.
  const selected = state.selectedRunId ? state.runData[state.selectedRunId] : undefined
  const runStage = selected?.revision?.composition.instances.find(instance => instance.definitionId === lesson.pluginDefinitionId)?.stageId
  const runMatches = runStage === stage.codeStageId
  const replay = useReplay(runMatches ? selected : undefined, null)
  const busy = state.runtime !== null && state.runtime.phase !== 'idle'
  const completedStages = useMemo(() => new Set(lessonProgress?.completed.map(item => item.stageId)), [lessonProgress])

  // A completed run of this stage's own code counts as having run the stage.
  const settledOk = runMatches && selected?.settled?.outcome === 'completed'
  useEffect(() => {
    if (stage.kind !== 'executable' || !settledOk || !selected || completedStages.has(stage.id)) return
    void useExplorer.getState().updateLessonProgress(lesson.id, { completed: { stageId: stage.id, runId: selected.runId } })
  }, [settledOk, stage.id, stage.kind, selected, lesson.id, completedStages])

  const introduced = useMemo(() => new Set(lesson.stages.slice(0, index + 1).map(item => item.id)), [lesson.stages, index])
  const upstream = lesson.upstreamRefs.filter(ref => stage.upstreamRefIds.includes(ref.id))
  const requests = runMatches && selected
    ? selected.records
      .filter(record => record.name === 'model/request' && record.seq <= replay.seq)
      .map(record => ({ step: record.scenarioStepId, request: selected.payloads[record.payloadRef!] as unknown as ModelRequestPayload }))
    : []
  const lessonInstance = selected?.revision?.composition.instances.find(instance => instance.definitionId === lesson.pluginDefinitionId)

  return (
    <div className="lesson">
      <header className="lesson__header">
        <Link href="/" className="button">返回组合</Link>
        <h1>{lesson.title}</h1>
        <span className="muted">阶段 {index + 1}/{views.length} · {stage.title}</span>
        <span className="badge" aria-label="对应运行">
          {!selected ? '尚无运行' : runMatches ? `运行 ${selected.runId} · 回放 #${replay.seq}（场景结束时）` : `所选运行 ${selected.runId} 未执行此阶段`}
        </span>
        {stage.kind === 'executable' ? (
          <button
            type="button"
            className="primary"
            disabled={busy || !state.ready}
            onClick={() => void state.runLessonStage(lesson.id, lesson.pluginDefinitionId, stage.codeStageId, stage.scenarioIds[0]!)}
          >
            运行此阶段
          </button>
        ) : <span className="badge">解释阶段 · 展示 {stage.codeStageId} 的代码，不单独运行</span>}
        <span className="badge">{{ 'contract-verified': '已通过契约验证', 'upstream-compared': '已与上游对照', draft: '草稿' }[lesson.supportLevel]}</span>
      </header>

      {state.error ? <div className="banner banner--error" role="alert">{state.error} <button type="button" onClick={state.dismissError}>知道了</button></div> : null}

      <NarrowTabs<'code' | 'side'>
        label="主区域"
        panes={[{ id: 'code', title: '代码' }, { id: 'side', title: '架构、状态与上游' }]}
        current={pane}
        onSelect={setPane}
      />
      <div className="lesson__main">
        <section className={`lesson__code${narrowPane(pane === 'code')}`} aria-label="代码">
          {view.files.length > 1 ? (
            <div className="segmented" role="tablist" aria-label="文件">
              {view.files.map(item => (
                <button key={item.key} type="button" role="tab" aria-selected={item.key === file.key} onClick={() => setFileKey(item.key)}>
                  {item.path.split('/').slice(-3).join('/')}{item.added ? ` +${item.added}` : ''}
                </button>
              ))}
            </div>
          ) : null}
          <p className="lesson__file">
            <code>{file.path}</code>
            <span className="muted"> · 相对上一阶段：新增 {file.added} 行，删除 {file.removed} 行 · sourceHash {stage.sourceHash.slice(7, 19)}</span>
          </p>
          <LessonCode key={file.key} code={file.code} />
        </section>

        <aside className={`lesson__side${narrowPane(pane === 'side')}`}>
          <div className="segmented" role="tablist" aria-label="旁侧面板">
            {(['architecture', 'state', 'upstream'] as const).map(item => (
              <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>
                {{ architecture: '内部架构', state: '状态与数据', upstream: '上游对照' }[item]}
              </button>
            ))}
          </div>

          {tab === 'architecture' ? (
            <div className="architecture">
              <ul>
                {lesson.architecture.nodes.map((node) => {
                  const visible = !node.introducedAtStageId || introduced.has(node.introducedAtStageId)
                  const highlighted = stage.architectureNodeIds.includes(node.id)
                  return (
                    <li key={node.id} className={`${visible ? '' : 'is-later'} ${highlighted ? 'is-highlighted' : ''}`}>
                      <strong>{node.label}</strong> <span className="badge">{node.kind}</span>
                      {!visible ? <span className="muted">（后续阶段引入）</span> : null}
                      <div className="muted">{node.responsibility}</div>
                    </li>
                  )
                })}
              </ul>
              <h3>关系</h3>
              <ul>
                {lesson.architecture.edges.map((edge) => {
                  const from = lesson.architecture.nodes.find(node => node.id === edge.from)?.label
                  const to = lesson.architecture.nodes.find(node => node.id === edge.to)?.label
                  return (
                    <li key={edge.id}>
                      {from} <em>{{ calls: '调用', implements: '实现', registers: '注册', reads: '读取', subscribes: '订阅', disposes: '清理', requires: '依赖' }[edge.relation]}</em> {to}
                      <span className="muted"> · 依据：{{ source: '源码', observed: '运行观测', explanation: '解释' }[edge.evidence]}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}

          {tab === 'state' ? (
            <div className="stage-state">
              {!selected ? <p className="muted">当前阶段尚未运行。点击“运行此阶段”。</p> : !runMatches ? (
                <p className="warning-text">所选运行 {selected.runId} 执行的是 {runStage ?? '（无此插件）'}，与当前阅读阶段 {stage.codeStageId} 不同。运行此阶段以查看它的结果。</p>
              ) : (
                <>
                  <p>运行 {selected.runId} · {selected.settled ? outcomeText(selected.settled.outcome) : '运行中'}</p>
                  {lessonInstance ? (
                    <p>{lessonInstance.id}：{phaseOf(replay.snapshot.plugins[lessonInstance.id]).text}{replay.snapshot.plugins[lessonInstance.id]?.reason ? ` · ${replay.snapshot.plugins[lessonInstance.id]!.reason}` : ''}</p>
                  ) : null}
                  <h3>注册项（场景结束时）</h3>
                  <ul>{Object.values(replay.snapshot.registrations).map(item => <li key={item.registrationId}>{item.name} · {item.instanceId ?? '—'}</li>)}</ul>
                  <h3>模型请求的 system 文本</h3>
                  <ol className="stage-state__requests">
                    {requests.map(({ step, request }) => <li key={request.requestId}><span className="muted">步骤 {step}</span><pre>{request.system}</pre></li>)}
                  </ol>
                </>
              )}
              <h3>应观察到</h3>
              <ul>{stage.expectedObservations.map(item => <li key={item}>{item}</li>)}</ul>
              <p className="muted">以上是引导与验收说明，不是生成轨迹的数据来源。</p>
            </div>
          ) : null}

          {tab === 'upstream' ? (
            <div className="upstream">
              {upstream.length ? (
                <ul>
                  {upstream.map(ref => (
                    <li key={ref.id}>
                      <a href={`${UPSTREAM_REPO}/blob/${ref.revision}/${ref.path}#L${ref.startLine}-L${ref.endLine}`} target="_blank" rel="noreferrer">
                        {ref.symbol ?? ref.path}
                      </a>
                      <div className="muted"><code>{ref.path}</code> 第 {ref.startLine}–{ref.endLine} 行 · commit {ref.revision.slice(0, 8)}</div>
                    </li>
                  ))}
                </ul>
              ) : <p className="muted">本阶段没有对应的上游片段。</p>}
              <h3>精简说明</h3>
              {stage.simplifications.length ? <ul>{stage.simplifications.map(item => <li key={item}>{item}</li>)}</ul> : <p className="muted">无</p>}
              <p className="muted">左侧是本项目的精简教学实现，不是上游原文。</p>
            </div>
          ) : null}
        </aside>
      </div>

      <section className="lesson__bottom">
        <nav className="stage-nav" aria-label="阶段导航">
          <button type="button" onClick={() => setIndex(Math.max(index - 1, 0))} disabled={index === 0}>上一阶段</button>
          <ol>
            {views.map((item, position) => (
              <li key={item.stage.id}>
                <button type="button" aria-current={position === index ? 'step' : undefined} onClick={() => setIndex(position)}>
                  {item.stage.id} {item.stage.kind === 'explanation' ? '（解释）' : ''}{completedStages.has(item.stage.id) ? ' ✓' : ''}
                </button>
              </li>
            ))}
          </ol>
          <button type="button" onClick={() => setIndex(Math.min(index + 1, views.length - 1))} disabled={index === views.length - 1}>下一阶段</button>
          <span className="muted">也可以用 ← → 切换；切换阶段不会运行代码。✓ 表示该阶段已有一次成功运行。</span>
        </nav>
        <div className="stage-text">
          <h2>{stage.title}</h2>
          <p>{stage.objective}</p>
          {sections[stage.id] ?? null}
          {index === 0 ? <details><summary>课程简介</summary>{intro}</details> : null}
        </div>
      </section>
    </div>
  )
}
