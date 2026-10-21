'use client'
/**
 * 插件实现页 (docs/design/explorer-redesign.md §3)：顶栏（← 插件树、层面包屑、支持等级、
 * 阶段位置、运行此阶段/解释徽章）、树位置条（inject/被读取链条 + 对应运行徽章 + 版本不对应
 * 警告横幅）、三栏主区——阶段叙述（340px）/ Code Hike（自适应）/ 状态与数据·内部架构·
 * 上游对照（440px）。一屏高，栏内各自滚动。行级联动（§5.3）不做：定位只到阶段文件里的锚点。
 */
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ArchitectureNode, BuiltLesson } from '@harness-explorer/lesson-kit/schema'
import type { Composition, ModelRequestPayload, SourceRef } from '@harness-explorer/contracts'
import type { LessonSourceFileView, LessonStageView } from '@/lib/lesson-data'
import { phaseHistory, useReplay } from '@/lib/replay'
import { assignLayers, LAYER_META } from '@/lib/dataflow'
import { PHASE_LABEL, phaseOf } from '@/lib/phase'
import { recordedCheckpoints } from '@harness-explorer/trace/browser'
import { shownComposition, useExplorer } from '@/lib/store'
import type { RunData } from '@/lib/store'
import { LessonCode } from './CodePanel'
import { outcomeText } from './Panels'
import { NarrowTabs, narrowPane } from './NarrowTabs'

type SideTab = 'state' | 'architecture' | 'upstream'

/** Expected checkpoints next to the recorded ones, in order; a mismatch is spelled out, not just coloured. */
function CheckpointCheck({ expected, recorded }: { expected: readonly string[]; recorded: readonly string[] }) {
  const same = expected.length === recorded.length && expected.every((name, index) => name === recorded[index])
  return (
    <div aria-label="检查点对照">
      <p className={same ? '' : 'warning-text'}>{same ? '✓ 记录的检查点与预期一致' : '✕ 记录的检查点与预期不同'}</p>
      <ol>
        {expected.map((name, index) => (
          <li key={`${index}-${name}`}>
            {name}{recorded[index] === name ? ' ✓' : ` ✕ 实际：${recorded[index] ?? '（没有记录）'}`}
          </li>
        ))}
      </ol>
      {recorded.length > expected.length ? <p className="warning-text">多出：{recorded.slice(expected.length).join('、')}</p> : null}
    </div>
  )
}

const NODE_KIND: Record<ArchitectureNode['kind'], string> = {
  'entry': '入口',
  'type': '类型',
  'function': '函数',
  'class': '类',
  'registry': '注册表',
  'event': '事件',
  'resource': '资源',
  'external-service': '外部服务',
}

const SUPPORT_LABEL: Record<BuiltLesson['supportLevel'], string> = {
  'contract-verified': '已通过契约验证',
  'upstream-compared': '已与上游对照',
  'draft': '草稿',
}

interface Props {
  lesson: Omit<BuiltLesson, 'mdx'>
  views: LessonStageView[]
  sourceFiles: Record<string, LessonSourceFileView[]>
  intro: ReactNode
  sections: Record<string, ReactNode>
}

const UPSTREAM_REPO = 'https://github.com/deepseek-ai/deepseek-harness'

/** One link of the tree-position chain: scope → inject providers → this instance → readers. */
interface ChainItem {
  key: string
  text: string
  layer: number | null
  /** Label of the connector from the previous item (挂载 / inject / 被读取). */
  rel: string | null
  /** The connector is inferred from declared dependencies, not observed in the trace. */
  inferred: boolean
  self: boolean
}

/** The instance's own lifecycle entries: phase transitions plus its registration add/remove records. */
interface LifeEntry {
  seq: number
  key: string
  mark: string
  text: string
  detail: string | null
  stepId: string | undefined
}

function lifecycleOf(data: RunData, instanceId: string): LifeEntry[] {
  const entries: LifeEntry[] = phaseHistory(data, instanceId).map(change => ({
    seq: change.seq,
    key: `phase:${change.seq}`,
    mark: (PHASE_LABEL[change.phase] ?? PHASE_LABEL.none!).mark,
    text: (PHASE_LABEL[change.phase] ?? PHASE_LABEL.none!).text,
    detail: change.reason ?? change.error,
    stepId: change.stepId,
  }))
  const names = new Map<string, string>()
  for (const record of data.records) {
    if (record.instanceId !== instanceId || !record.payloadRef) continue
    if (record.name === 'registration/add') {
      const payload = data.payloads[record.payloadRef] as { registrationId: string; name: string }
      names.set(payload.registrationId, payload.name)
      entries.push({ seq: record.seq, key: `add:${record.seq}`, mark: '＋', text: `注册 ${payload.name}`, detail: null, stepId: record.scenarioStepId })
    } else if (record.name === 'registration/remove') {
      const payload = data.payloads[record.payloadRef] as { registrationId: string }
      entries.push({ seq: record.seq, key: `remove:${record.seq}`, mark: '－', text: `移除 ${names.get(payload.registrationId) ?? payload.registrationId}`, detail: null, stepId: record.scenarioStepId })
    }
  }
  return entries.sort((a, b) => a.seq - b.seq)
}

/** Segments this instance contributed to the prompt registry (its prompt-section texts). */
function contributionsOf(data: RunData | undefined, instanceId: string | undefined): string[] {
  if (!data || !instanceId) return []
  const texts = new Set<string>()
  for (const record of data.records) {
    if (record.name !== 'registration/add' || record.instanceId !== instanceId || !record.payloadRef) continue
    const payload = data.payloads[record.payloadRef] as { kind: string; detail: unknown }
    const text = (payload.detail as { text?: unknown } | null)?.text
    if (payload.kind === 'prompt-section' && typeof text === 'string' && text) texts.add(text)
  }
  return [...texts]
}

/** Request system text with the segments this plugin contributed wrapped in <mark>. */
function SystemText({ system, contributions }: { system: string; contributions: readonly string[] }) {
  const ranges: Array<readonly [number, number]> = []
  for (const text of contributions) {
    let at = system.indexOf(text)
    while (at >= 0) {
      ranges.push([at, at + text.length])
      at = system.indexOf(text, at + text.length)
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const parts: ReactNode[] = []
  let cursor = 0
  for (const [from, to] of ranges) {
    if (from < cursor) continue
    if (from > cursor) parts.push(system.slice(cursor, from))
    parts.push(<mark key={from} className="stage-state__contrib">{system.slice(from, to)}</mark>)
    cursor = to
  }
  parts.push(system.slice(cursor))
  return <>{parts}</>
}

export function LessonView({ lesson, views, sourceFiles, intro, sections }: Props) {
  const state = useExplorer()
  const [index, setIndex] = useState(0)
  const [fileKey, setFileKey] = useState('entry')
  const [pane, setPane] = useState<'code' | 'side'>('code')
  const [tab, setTab] = useState<SideTab>('state')
  const [located, setLocated] = useState<SourceRef | null>(null)
  /** Lesson-local replay cursor for the state tab; null follows the scenario end. */
  const [cursor, setCursor] = useState<number | null>(null)
  /** Mid-width layouts (960–1280px) collapse the stage narrative to a rail; this opens it as an overlay. */
  const [navOpen, setNavOpen] = useState(false)
  useEffect(() => { void useExplorer.getState().init() }, [])

  // Restore the reading position once progress is loaded, then save every move.
  const lessonProgress = state.progress?.lessons[lesson.id]
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !state.progress) return
    restored.current = true
    // A link from a run names the stage that ran; it wins over the saved reading position.
    const linked = new URLSearchParams(window.location.search).get('stage')
    const fromLink = linked ? views.findIndex(item => item.stage.kind === 'executable' && item.stage.codeStageId === linked) : -1
    const saved = views.findIndex(item => item.stage.id === lessonProgress?.lastStageId)
    if (fromLink >= 0) setIndex(fromLink)
    else if (saved > 0) setIndex(saved)
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
      if (event.key === 'Escape') setNavOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [views.length])

  // A stage pick on the collapsed rail also opens the narrative overlay; picking the
  // current stage toggles it. Wide layouts show the narrative inline and ignore navOpen.
  const pickStage = (position: number) => {
    if (position === index) setNavOpen(open => !open)
    else { setIndex(position); setNavOpen(true) }
  }

  const view = views[index]!
  const stage = view.stage
  const file = view.files.find(item => item.key === fileKey) ?? view.files[0]!
  const sourceFile = sourceFiles[stage.codeStageId]!.find(item => item.key === file.key)!
  const code = { ...sourceFile.code, annotations: [...sourceFile.code.annotations, ...file.annotations] }
  // Diff numbers live on the lesson stage that introduced this codeStageId; explanation
  // stages reuse them so the chip never says +0 −0 for code the previous stage introduced.
  const introducedAt = views.findIndex(item => item.stage.codeStageId === stage.codeStageId)
  const diffView = views[introducedAt]!
  const previousCode = introducedAt > 0 ? views[introducedAt - 1]!.stage.codeStageId : null
  const diffFile = diffView.files.find(item => item.key === file.key) ?? file

  // The selected run counts as this stage's run only if it ran this stage with the code shown:
  // same stage id and, from its manifest, the same sourceHash (docs/02 §11).
  const selected = state.selectedRunId ? state.runData[state.selectedRunId] : undefined
  const runStage = selected?.revision?.composition.instances.find(instance => instance.definitionId === lesson.pluginDefinitionId)?.stageId
  // The run's own manifest says which code it ran; a run without a recorded hash for the stage is not this code.
  const ranHash = selected?.loadedSourceHashes?.[stage.codeStageId]
  const codeVersion = runStage !== stage.codeStageId ? 'other-stage'
    : selected?.loadedSourceHashes == null ? 'loading'
      : ranHash === undefined ? 'unrecorded'
        : ranHash === stage.sourceHash ? 'match' : 'other'
  const otherCode = codeVersion === 'other' || codeVersion === 'unrecorded'
  const runMatches = codeVersion === 'match'
  const replay = useReplay(runMatches ? selected : undefined, cursor)
  const busy = state.runtime !== null && state.runtime.phase !== 'idle'
  const completedStages = useMemo(() => new Set(lessonProgress?.completed.map(item => item.stageId)), [lessonProgress])

  // A completed run of this stage's own code counts as having run the stage.
  const settledOk = runMatches && selected?.settled?.outcome === 'completed'
  useEffect(() => {
    if (stage.kind !== 'executable' || !settledOk || !selected || completedStages.has(stage.id)) return
    void useExplorer.getState().updateLessonProgress(lesson.id, { completed: { stageId: stage.id, runId: selected.runId } })
  }, [settledOk, stage.id, stage.kind, selected, lesson.id, completedStages])

  const runThisStage = () => void state.runLessonStage(lesson.id, lesson.pluginDefinitionId, stage.codeStageId, stage.scenarioIds[0]!)

  // ---- 顶栏：层面包屑（层名来自 catalog.layers + LAYER_META） ----
  const layer = state.catalog?.layers[lesson.pluginDefinitionId] ?? null
  const layerName = layer !== null ? LAYER_META.find(meta => meta.layer === layer)?.name ?? null : null

  // ---- 树位置条：作用域 → inject 提供者 → 本实例 → 读取它的下游消费者 ----
  // One chain per instance of the lesson's plugin (scoped-chat has a root and
  // a scoped prompt-contributor); each row starts with the instance's scope.
  const chains = useMemo((): ChainItem[][] => {
    const composition = shownComposition(state).composition
    const catalogStages = state.catalog?.stages ?? []
    if (!composition || !catalogStages.length) return []
    const mine = composition.instances.filter(instance => instance.definitionId === lesson.pluginDefinitionId)
    if (!mine.length) return []
    const layers = assignLayers(composition.instances, catalogStages, state.catalog?.layers ?? {})
    const stageOf = (stageId: string) => catalogStages.find(item => item.id === stageId)
    const chainFor = (me: Composition['instances'][number]): ChainItem[] => {
      const myStage = stageOf(me.stageId)
      const myLayer = layers.get(me.id) ?? 1
      const items: ChainItem[] = [{ key: `scope:${me.scopeId}`, text: me.scopeId, layer: 0, rel: null, inferred: false, self: false }]
      const providers: string[] = []
      for (const service of myStage?.requires ?? []) {
        const provider = composition.instances.find(candidate =>
          candidate.id !== me.id && !providers.includes(candidate.id) && stageOf(candidate.stageId)?.provides.includes(service))
        if (provider) providers.push(provider.id)
      }
      providers.sort((a, b) => (layers.get(a) ?? 1) - (layers.get(b) ?? 1))
      for (const id of providers) items.push({ key: id, text: id, layer: layers.get(id) ?? null, rel: '挂载', inferred: false, self: false })
      items.push({ key: me.id, text: me.id, layer: myLayer, rel: providers.length ? 'inject' : '挂载', inferred: false, self: true })
      // Consumers: deeper-layer instances reading a service this one injects into or
      // provides. Inferred from declared dependencies, not observed in the trace.
      const touched = new Set([...myStage?.requires ?? [], ...myStage?.provides ?? []])
      const consumers = composition.instances
        .filter(candidate => candidate.id !== me.id
          && (layers.get(candidate.id) ?? 1) > myLayer
          && (stageOf(candidate.stageId)?.requires ?? []).some(service => touched.has(service)))
        .sort((a, b) => (layers.get(a.id) ?? 1) - (layers.get(b.id) ?? 1))
      for (const consumer of consumers) items.push({ key: consumer.id, text: consumer.id, layer: layers.get(consumer.id) ?? null, rel: '被读取', inferred: true, self: false })
      return items
    }
    return mine.map(chainFor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.catalog, state.draft, state.selectedRunId, state.runData, lesson.pluginDefinitionId])

  const correspondence = !selected ? '尚无运行'
    : runMatches ? `运行 ${selected.runId} · 回放 #${replay.seq}${cursor === null ? '（场景结束时）' : ''}`
      : codeVersion === 'loading' ? `正在读取运行 ${selected.runId} 的代码版本`
        : codeVersion === 'other' ? `所选运行 ${selected.runId} 执行的是此阶段的另一版代码`
          : codeVersion === 'unrecorded' ? `所选运行 ${selected.runId} 没有记录此阶段的代码版本`
            : `所选运行 ${selected.runId} 未执行此阶段`

  // 版本不对应：整条横幅 + 「运行此阶段」（02c）；同样的文案也留在状态与数据页里。
  const mismatch = !selected || runMatches || codeVersion === 'loading' ? null
    : codeVersion === 'unrecorded'
      ? `所选运行 ${selected.runId} 没有记录 ${stage.codeStageId} 的代码版本，不能确认它执行的是当前展示的代码，结果不对应到当前代码。运行此阶段以查看当前代码的结果。`
      : otherCode
        ? `所选运行 ${selected.runId} 执行的 ${stage.codeStageId} 来自另一版代码（sourceHash ${ranHash?.slice(7, 19)}，当前展示 ${stage.sourceHash.slice(7, 19)}），它的结果不对应到当前代码。可在整体组合中只读回放它；运行此阶段以查看当前代码的结果。`
        : `所选运行 ${selected.runId} 执行的是 ${runStage ?? '（无此插件）'}，与当前阅读阶段 ${stage.codeStageId} 不同。运行此阶段以查看它的结果。`

  const introduced = useMemo(() => new Set(lesson.stages.slice(0, index + 1).map(item => item.id)), [lesson.stages, index])
  const isIntroduced = (nodeId: string) => {
    const node = lesson.architecture.nodes.find(item => item.id === nodeId)
    return !node?.introducedAtStageId || introduced.has(node.introducedAtStageId)
  }
  // A node cites anchors as "<stage>#<anchor>"; locate the same anchor in the files this stage shows.
  const locateNode = (sourceRefIds: readonly string[]) => sourceRefIds
    .map(id => id.split('#')[1])
    .map(anchor => view.sourceRefs.find(ref => anchor && ref.symbol === anchor && view.files.some(item => item.path === ref.path)))
    .find(Boolean)
  const locate = (ref: SourceRef) => {
    setFileKey(view.files.find(item => item.path === ref.path)!.key)
    setPane('code')
    // A fresh object, so locating the same anchor again scrolls again.
    setLocated({ ...ref })
  }
  // Upstream files run to thousands of lines: entering a stage brings its first focused excerpt into view.
  useEffect(() => {
    const first = view.sourceRefs
      .filter(ref => stage.focusAnchors.includes(ref.symbol ?? ''))
      .sort((a, b) => view.files.findIndex(file => file.path === a.path) - view.files.findIndex(file => file.path === b.path) || a.startLine - b.startLine)[0]
    if (!first) return
    setFileKey(view.files.find(item => item.path === first.path)!.key)
    setLocated({ ...first })
  }, [view, stage])
  useEffect(() => {
    if (!located) return
    // Code Hike renders one child per source line under the <pre>'s wrapper.
    const line = document.querySelector(`.lesson-code > div > :nth-child(${located.startLine})`)
    line?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [located])
  const upstream = lesson.upstreamRefs.filter(ref => stage.upstreamRefIds.includes(ref.id))
  // This plugin's own checkpoints during the scenario, read the way lessons:verify reads them.
  const recorded = useMemo(
    () => (runMatches && selected ? recordedCheckpoints(selected.records, lesson.pluginDefinitionId) : []),
    [runMatches, selected, lesson.pluginDefinitionId],
  )
  const lessonInstance = runMatches && selected
    ? selected.revision?.composition.instances.find(instance => instance.definitionId === lesson.pluginDefinitionId)
    : undefined
  const lifecycle = useMemo(
    () => (runMatches && selected && lessonInstance ? lifecycleOf(selected, lessonInstance.id) : []),
    [runMatches, selected, lessonInstance],
  )
  const contributions = useMemo(() => contributionsOf(selected, lessonInstance?.id), [selected, lessonInstance])
  const requests = runMatches && selected
    ? selected.records
      .filter(record => record.name === 'model/request' && record.seq <= replay.seq)
      .map(record => ({ step: record.scenarioStepId, request: selected.payloads[record.payloadRef!] as unknown as ModelRequestPayload }))
    : []
  const registry = useMemo(
    () => Object.values(replay.snapshot.registrations)
      .filter(item => item.kind === 'prompt-section')
      .sort((a, b) => ((a.detail as { order?: number }).order ?? 0) - ((b.detail as { order?: number }).order ?? 0)),
    [replay.snapshot],
  )

  const hashState = runMatches ? '与运行版本一致'
    : !selected ? '尚无运行'
      : codeVersion === 'loading' ? '正在读取运行版本'
        : '与运行版本不一致'

  return (
    <div className="lesson">
      <header className="lesson__header">
        <Link href="/" className="button lesson__back">← 插件树</Link>
        <nav className="lesson__crumb" aria-label="面包屑">
          {layerName ? <span className="muted">{layerName}</span> : null}
          {layerName ? <span className="muted" aria-hidden>›</span> : null}
          <span className="lesson__crumb-id">◇ {lesson.pluginDefinitionId}</span>
        </nav>
        <span className={`badge${lesson.supportLevel === 'contract-verified' ? ' badge--ok' : ''}`}>{SUPPORT_LABEL[lesson.supportLevel]}</span>
        <span className="spacer" />
        <span className="lesson__stage-pos">阶段 {index + 1}/{views.length} · {stage.title}</span>
        {stage.kind === 'executable' ? (
          <button type="button" className="primary" disabled={busy || !state.ready} onClick={runThisStage}>
            ▶ 运行此阶段
          </button>
        ) : <span className="badge">解释阶段 · 展示 {stage.codeStageId} 的代码，不单独运行</span>}
      </header>

      <div className="lesson__treebar">
        <span className="muted lesson__treebar-label">在树中的位置</span>
        {chains.length ? (
          <div className="lesson__chains">
            {chains.map((chain, row) => (
              <ol className="lesson__chain" key={chain.find(item => item.self)?.key ?? row}>
                {chain.map(item => (
                  <li key={item.key}>
                    {item.rel ? (
                      <span
                        className={`lesson__chain-rel${item.inferred ? ' lesson__chain-rel--inferred' : ''}`}
                        title={item.inferred ? '由依赖声明推断，不是轨迹记录' : undefined}
                      >
                        — {item.rel} →
                      </span>
                    ) : null}
                    <span className={`lesson__chain-node${item.self ? ' is-self' : ''}`}>
                      {item.layer !== null ? `L${item.layer} ` : ''}{item.text}
                    </span>
                  </li>
                ))}
              </ol>
            ))}
          </div>
        ) : <span className="muted">组合中没有 {lesson.pluginDefinitionId} 的实例；运行此阶段会使用课程自带的组合。</span>}
        <span className="spacer" />
        <span className="badge" aria-label="对应运行">{correspondence}</span>
      </div>

      {mismatch ? (
        <div className="banner banner--warning" role="alert">
          <span className="banner__icon" aria-hidden>⚠</span>
          <span className="banner__text">{mismatch}</span>
          {stage.kind === 'executable' ? (
            <button type="button" className="primary" disabled={busy || !state.ready} onClick={runThisStage}>运行此阶段</button>
          ) : null}
        </div>
      ) : null}

      {state.error ? <div className="banner banner--error" role="alert">{state.error} <button type="button" onClick={state.dismissError}>知道了</button></div> : null}

      <NarrowTabs<'code' | 'side'>
        label="主区域"
        panes={[{ id: 'code', title: '代码' }, { id: 'side', title: '架构、状态与上游' }]}
        current={pane}
        onSelect={setPane}
      />

      <div className="lesson__main">
        {navOpen ? <button type="button" className="lesson__nav-backdrop" aria-label="关闭阶段叙述" onClick={() => setNavOpen(false)} /> : null}
        <nav className={`lesson__stages${navOpen ? ' is-open' : ''}`} aria-label="阶段导航">
          <button type="button" className="lesson__stages-expand" aria-label={navOpen ? '收起阶段叙述' : '展开阶段叙述'} aria-expanded={navOpen} onClick={() => setNavOpen(open => !open)}>
            {navOpen ? '«' : '»'}
          </button>
          <div className="lesson__stages-scroll">
            <p className="lesson__kicker">实现步骤</p>
            <h1 className="lesson__title">{lesson.title}</h1>
            <p className="lesson__summary">{lesson.summary}</p>
            <ol className="lesson__stage-list">
              {views.map((item, position) => {
                const current = position === index
                const done = completedStages.has(item.stage.id)
                return (
                  <li key={item.stage.id} className={`stage-card${current ? ' is-current' : ''}`}>
                    <button
                      type="button"
                      className="stage-card__head"
                      aria-current={current ? 'step' : undefined}
                      aria-expanded={current}
                      onClick={() => pickStage(position)}
                    >
                      <span className="stage-card__num">{String(position).padStart(2, '0')}</span>
                      <span className="stage-card__name">{item.stage.title}</span>
                      <span className="stage-card__flags">
                        {item.stage.kind === 'explanation' ? <span className="badge badge--muted">解释</span> : null}
                        {done ? <span className="stage-card__done" title="该阶段已有一次成功运行">✓</span> : null}
                      </span>
                    </button>
                    {current ? (
                      <div className="stage-card__body">
                        <p>{stage.objective}</p>
                        {sections[stage.id] ?? null}
                        {index === 0 ? <details><summary>课程简介</summary>{intro}</details> : null}
                        {stage.expectedObservations.length ? (
                          <div className="stage-card__expect">
                            <h4>{stage.kind === 'executable' ? '运行此阶段后应看到' : '应观察到'}</h4>
                            <ul>
                              {stage.expectedObservations.map(text => <li key={text}>{text}</li>)}
                            </ul>
                            <p className="muted">「应观察到」是引导与验收说明，不是生成轨迹的数据来源。</p>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ol>
          </div>
          <div className="lesson__stages-nav">
            <button type="button" onClick={() => setIndex(Math.max(index - 1, 0))} disabled={index === 0}>← 上一阶段</button>
            <button type="button" onClick={() => setIndex(Math.min(index + 1, views.length - 1))} disabled={index === views.length - 1}>下一阶段 →</button>
            <span className="muted">← → 切换</span>
          </div>
        </nav>

        <section className={`lesson__code${narrowPane(pane === 'code')}`} aria-label="代码">
          <div className="lesson__code-head">
            {view.files.length > 1 ? (
              <div className="segmented" role="tablist" aria-label="文件">
                {view.files.map((item) => {
                  const stats = diffView.files.find(candidate => candidate.key === item.key) ?? item
                  return (
                    <button key={item.key} type="button" role="tab" aria-selected={item.key === file.key} onClick={() => setFileKey(item.key)}>
                      {item.path.split('/').slice(-3).join('/')}{stats.added ? ` +${stats.added}` : ''}
                    </button>
                  )
                })}
              </div>
            ) : <span className="lesson__file-chip"><code>{file.path.split('/').slice(-3).join('/')}</code></span>}
            <span className="spacer" />
            {previousCode ? (
              <span className="lesson__diff">
                相对 {previousCode.split('@')[1]} <span className="lesson__diff-added">+{diffFile.added}</span> <span className="lesson__diff-removed">−{diffFile.removed}</span>
              </span>
            ) : null}
          </div>
          <LessonCode key={file.key} code={code} />
          <div className="lesson__code-foot">
            <span className="code-legend"><i className="code-legend__added" aria-hidden />新增</span>
            <span className="code-legend"><i className="code-legend__modified" aria-hidden />修改</span>
            <span className="code-legend"><i className="code-legend__focus" aria-hidden />焦点 · 本步讲解</span>
            <span className="spacer" />
            {view.origin === 'upstream' ? (
              <span className="muted">上游原文 · commit {lesson.upstreamCommit.slice(0, 8)} · 运行发布包 {view.package?.name}@{view.package?.version}</span>
            ) : null}
            <span className={`lesson__hash${runMatches ? ' is-match' : ''}`}>sourceHash {stage.sourceHash.slice(7, 13)} · {hashState}</span>
          </div>
          <p className="sr-only" aria-live="polite">{located ? `已定位到 ${located.path} 第 ${located.startLine}–${located.endLine} 行（${located.symbol}）` : ''}</p>
        </section>

        <aside className={`lesson__side${narrowPane(pane === 'side')}`}>
          <div className="segmented lesson__side-tabs" role="tablist" aria-label="旁侧面板">
            {(['state', 'architecture', 'upstream'] as const).map(item => (
              <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>
                {{ state: '状态与数据', architecture: '内部架构', upstream: '上游对照' }[item]}
              </button>
            ))}
          </div>

          {tab === 'state' ? (
            <div className="stage-state">
              {!selected ? <p className="muted">当前阶段尚未运行。点击“运行此阶段”。</p> : codeVersion === 'loading' ? (
                <p className="muted">正在读取运行 {selected.runId} 的代码版本。</p>
              ) : mismatch ? (
                <p className="warning-text">{mismatch}</p>
              ) : (
                <>
                  <div className="stage-state__head">
                    <h3>systemPrompt 注册表</h3>
                    <span className="muted">游标 #{replay.seq} 时的状态</span>
                  </div>
                  {registry.length ? (
                    <table className="registry">
                      <thead><tr><th scope="col">order</th><th scope="col">name</th><th scope="col">来源插件</th></tr></thead>
                      <tbody>
                        {registry.map(item => (
                          <tr key={item.registrationId} className={item.instanceId === lessonInstance?.id ? 'is-self' : ''}>
                            <td>{(item.detail as { order?: number }).order ?? '—'}</td>
                            <td><code>{item.name}</code></td>
                            <td>{item.instanceId ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="muted">回放位置上没有 prompt-section 注册项。</p>}

                  <div className="stage-state__head">
                    <h3>生命周期 · 本次运行</h3>
                    <span className="muted">{selected.runId} · {selected.settled ? outcomeText(selected.settled.outcome) : '运行中'}</span>
                  </div>
                  {lessonInstance ? (
                    <p className="muted">{lessonInstance.id}：{phaseOf(replay.snapshot.plugins[lessonInstance.id]).text}{replay.snapshot.plugins[lessonInstance.id]?.reason ? ` · ${replay.snapshot.plugins[lessonInstance.id]!.reason}` : ''}</p>
                  ) : null}
                  {lifecycle.length ? (
                    <ol className="lifecycle" aria-label="生命周期（点击移动回放游标）">
                      {lifecycle.map((entry) => {
                        const current = entry.seq <= replay.seq && !lifecycle.some(later => later.seq > entry.seq && later.seq <= replay.seq)
                        return (
                          <li key={entry.key} className={entry.seq > replay.seq ? 'is-future' : ''}>
                            <button
                              type="button"
                              aria-current={current ? 'step' : undefined}
                              title="点击把回放游标移到这条记录；再点一次回到场景结束"
                              onClick={() => setCursor(current && cursor !== null ? null : entry.seq)}
                            >
                              <span aria-hidden>{entry.mark}</span> {entry.text}
                              <span className="muted"> · #{entry.seq}{entry.stepId ? ` · 步骤 ${entry.stepId}` : ' · 初始挂载'}</span>
                              {current ? <span className="badge lesson__cursor-badge">游标</span> : null}
                            </button>
                            {entry.detail ? <div className="muted">{entry.detail}</div> : null}
                          </li>
                        )
                      })}
                    </ol>
                  ) : <p className="muted">本次运行没有记录到该实例的状态。</p>}

                  {stage.expectedCheckpoints ? (
                    <>
                      <div className="stage-state__head"><h3>检查点对照</h3><span className="muted">预期 vs 记录</span></div>
                      {!selected.settled ? <p className="muted">运行中，结束后核对检查点。</p>
                        : selected.gaps.length ? <p className="warning-text">轨迹有缺口，检查点无法完整核对。</p>
                          : <CheckpointCheck expected={stage.expectedCheckpoints} recorded={recorded} />}
                    </>
                  ) : null}

                  <div className="stage-state__head"><h3>模型请求的 system 文本</h3></div>
                  <ol className="stage-state__requests">
                    {requests.map(({ step, request }) => (
                      <li key={request.requestId}>
                        <span className="muted">步骤 {step}</span>
                        <pre><SystemText system={request.system} contributions={contributions} /></pre>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          ) : null}

          {tab === 'architecture' ? (
            <div className="architecture">
              <p className="muted architecture__caption">节点 · 本阶段高亮</p>
              <ul className="architecture__nodes">
                {lesson.architecture.nodes.map((node) => {
                  const visible = isIntroduced(node.id)
                  const highlighted = stage.architectureNodeIds.includes(node.id)
                  const target = visible ? locateNode(node.sourceRefIds) : undefined
                  const external = node.kind === 'external-service'
                  return (
                    <li key={node.id} className={`${visible ? '' : 'is-later'} ${highlighted ? 'is-highlighted' : ''} ${external ? 'is-external' : ''}`}>
                      <div className="architecture__node-head">
                        <strong>{node.label}</strong> <span className="badge">{NODE_KIND[node.kind]}</span>
                      </div>
                      {!visible ? <span className="muted">（后续阶段引入）</span> : null}
                      <div className="muted">{node.responsibility}</div>
                      {target ? (
                        <button type="button" className="link-button" onClick={() => locate(target)}>
                          定位代码：{target.symbol}（第 {target.startLine}–{target.endLine} 行）
                        </button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
              <h3>关系</h3>
              <ul className="architecture__edges">
                {lesson.architecture.edges.map((edge) => {
                  const from = lesson.architecture.nodes.find(node => node.id === edge.from)?.label
                  const to = lesson.architecture.nodes.find(node => node.id === edge.to)?.label
                  const later = !isIntroduced(edge.from) || !isIntroduced(edge.to)
                  return (
                    <li key={edge.id} className={later ? 'is-later' : ''}>
                      <span className="architecture__edge-node">{from}</span>
                      <em className="badge architecture__edge-rel">{{ calls: '调用', implements: '实现', registers: '注册', reads: '读取', subscribes: '订阅', disposes: '清理', requires: '依赖' }[edge.relation]}</em>
                      <span className="architecture__edge-node">{to}</span>
                      <span className="muted architecture__edge-ev">依据：{{ source: '源码', observed: '运行观测', explanation: '解释' }[edge.evidence]}{later ? '（后续阶段引入）' : ''}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}

          {tab === 'upstream' ? (
            <div className="upstream">
              <p className="muted architecture__caption">本阶段对应的上游片段</p>
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
              {view.origin === 'upstream' ? (
                <>
                  {stage.simplifications.length ? <><h3>运行环境说明</h3><ul>{stage.simplifications.map(item => <li key={item}>{item}</li>)}</ul></> : null}
                  <p className="muted">左侧是上游原文（commit {lesson.upstreamCommit.slice(0, 8)}），未经改写；运行此阶段执行的是该 commit 发布的 npm 包 {view.package?.name}@{view.package?.version}。</p>
                </>
              ) : (
                <>
                  <h3>精简说明</h3>
                  {stage.simplifications.length ? <ul>{stage.simplifications.map(item => <li key={item}>{item}</li>)}</ul> : <p className="muted">无</p>}
                  <p className="muted">左侧是本项目的精简教学实现，不是上游原文。行为对照（P5-04）尚未实现，因此这里只给出源码引用。</p>
                </>
              )}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  )
}
