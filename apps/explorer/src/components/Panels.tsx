'use client'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { TimelineRows } from './TimelineRows'
import type { AdapterMode, EnvironmentSnapshot, PluginInstance, RuntimeState } from '@harness-explorer/contracts'
import type { ViewSnapshot } from '@harness-explorer/trace/browser'
import type { Draft, LessonsResponse, PublicCatalog, PublicStage } from '@/lib/api'
import type { RunData } from '@/lib/store'
import { phaseOf } from './PluginTree'

const PHASE_TEXT: Record<RuntimeState['phase'], string> = {
  idle: '空闲',
  validating: '校验中',
  starting: '启动运行子进程',
  running: '运行中',
  stopping: '停止中',
  settling: '结算中',
}

const OUTCOME_TEXT: Record<string, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  terminated: '已强制终止（清理未确认）',
  interrupted: '服务中断',
}

export function outcomeText(outcome: string) {
  return OUTCOME_TEXT[outcome] ?? outcome
}

interface RunBarProps {
  catalog: PublicCatalog
  draft: Draft
  runtime: RuntimeState | null
  connected: boolean
  adapterMode: AdapterMode
  environment: Record<AdapterMode, EnvironmentSnapshot> | null
  onAdapterMode(mode: AdapterMode): void
  onScenario(id: string): void
  onRun(): void
  onCancel(): void
}

export function RunBar({ catalog, draft, runtime, connected, adapterMode, environment, onAdapterMode, onScenario, onRun, onCancel }: RunBarProps) {
  const busy = runtime !== null && runtime.phase !== 'idle'
  const missing = environment?.real.variables.filter(variable => variable.sensitive && !variable.present).map(variable => variable.name) ?? ['DEEPSEEK_API_KEY']
  const scenario = catalog.scenarios.find(item => item.id === draft.scenarioId)
  const realAllowed = missing.length === 0 && scenario?.adapterModes.includes('real')
  return (
    <div className="run-bar" role="toolbar" aria-label="运行控制">
      <label>
        场景
        <select value={draft.scenarioId} onChange={event => onScenario(event.target.value)}>
          {catalog.scenarios.map(scenario => <option key={scenario.id} value={scenario.id}>{scenario.title}</option>)}
        </select>
      </label>
      <button type="button" className="primary" onClick={onRun} disabled={busy} title={busy ? '当前运行结束后才能再次运行' : undefined}>
        运行教学代码
      </button>
      <label>
        模型
        <select value={adapterMode} onChange={event => onAdapterMode(event.target.value as AdapterMode)}>
          <option value="deterministic">确定性模型（无需 API Key）</option>
          <option value="real" disabled={!realAllowed}>
            真实模型 DeepSeek{missing.length ? `（需在启动环境设置 ${missing.join('、')}）` : scenario?.adapterModes.includes('real') ? '' : '（当前场景不支持）'}
          </option>
        </select>
      </label>
      <span className="badge">{adapterMode === 'real' ? '真实模型 · 结果不可严格复现 · 环境来自本机' : '确定性模型 · 可重复'}</span>
      {busy ? <button type="button" onClick={onCancel}>停止运行</button> : null}
      <span className="run-bar__phase" aria-live="polite">
        控制器：{PHASE_TEXT[runtime?.phase ?? 'idle']}
        {runtime?.error ? ` · ${runtime.error.message}` : ''}
      </span>
      <span className={`badge ${connected ? '' : 'badge--muted'}`}>{connected ? '已连接' : '未订阅'}</span>
    </div>
  )
}

interface InspectorProps {
  instance: PluginInstance | undefined
  stage: PublicStage | undefined
  snapshot: ViewSnapshot
  lessons: LessonsResponse | null
  editable: boolean
  stagesOfDefinition: PublicStage[]
  onRemove(id: string): void
  onStage(id: string, stageId: string): void
  onEnabled(id: string, enabled: boolean): void
}

export function Inspector({ instance, stage, snapshot, lessons, editable, stagesOfDefinition, onRemove, onStage, onEnabled }: InspectorProps) {
  if (!instance) return <aside className="inspector"><p className="muted">选择插件树中的一个实例查看状态与依赖。</p></aside>
  const plugin = snapshot.plugins[instance.id]
  const phase = phaseOf(plugin)
  const registrations = Object.values(snapshot.registrations).filter(item => item.instanceId === instance.id)
  const lesson = lessons?.lessons.find(item => item.pluginDefinitionId === instance.definitionId)
  return (
    <aside className="inspector" aria-label="实例摘要">
      <h2>{instance.id}</h2>
      <dl>
        <dt>插件定义</dt><dd>{instance.definitionId}</dd>
        <dt>阶段</dt><dd>{instance.stageId}</dd>
        <dt>作用域</dt><dd>{instance.scopeId}</dd>
        <dt>状态</dt><dd>{phase.mark} {phase.text}</dd>
        {plugin ? <><dt>依赖</dt><dd>{{ resolved: '已解析', missing: '缺失', unknown: '未知' }[plugin.dependencyStatus]}</dd></> : null}
        {plugin?.reason ? <><dt>原因</dt><dd>{plugin.reason}</dd></> : null}
        {plugin?.error ? <><dt>错误</dt><dd className="error-text">{plugin.error.name}: {plugin.error.message}</dd></> : null}
        <dt>需要</dt><dd>{stage?.requires.join('、') || '无'}</dd>
        <dt>提供</dt><dd>{stage?.provides.join('、') || '无'}</dd>
      </dl>
      <h3>当前注册项</h3>
      {registrations.length
        ? <ul>{registrations.map(item => <li key={item.registrationId}>{item.kind} · {item.name}（作用域 {item.scopeId}）</li>)}</ul>
        : <p className="muted">回放位置上没有注册项。</p>}
      {lesson ? <p><Link className="button primary" href={`/plugin/${lesson.id}?instance=${encodeURIComponent(instance.id)}`}>进入插件实现</Link></p> : null}
      {editable ? (
        <div className="inspector__edit">
          <h3>编辑草稿</h3>
          {stagesOfDefinition.length > 1 ? (
            <label>
              阶段
              <select value={instance.stageId} onChange={event => onStage(instance.id, event.target.value)}>
                {stagesOfDefinition.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
              </select>
            </label>
          ) : null}
          <label className="checkbox">
            <input type="checkbox" checked={instance.enabled} onChange={event => onEnabled(instance.id, event.target.checked)} />
            运行开始时挂载（否则由场景步骤挂载）
          </label>
          <button type="button" onClick={() => onRemove(instance.id)}>从组合中移除</button>
          <p className="muted">修改只影响草稿；下次运行会生成新的实验版本，历史运行保持不变。</p>
        </div>
      ) : <p className="muted">正在查看历史运行绑定的版本，返回草稿后才能编辑。</p>}
    </aside>
  )
}

interface LibraryProps {
  stages: readonly PublicStage[]
  draft: Draft
  onAdd(stage: PublicStage): void
}

export function PluginLibrary({ stages, draft, onAdd }: LibraryProps) {
  const [open, setOpen] = useState(false)
  const definitions = useMemo(() => {
    const byDefinition = new Map<string, PublicStage[]>()
    for (const stage of stages) byDefinition.set(stage.pluginDefinitionId, [...byDefinition.get(stage.pluginDefinitionId) ?? [], stage])
    return [...byDefinition]
  }, [stages])
  const providers = new Set(draft.composition.instances.flatMap(instance => stages.find(stage => stage.id === instance.stageId)?.provides ?? []))
  return (
    <div className="library">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>添加插件</button>
      {open ? (
        <ul className="library__list">
          {definitions.map(([definitionId, versions]) => {
            const latest = versions.at(-1)!
            const missing = latest.requires.filter(service => !providers.has(service))
            return (
              <li key={definitionId}>
                <strong>{definitionId}</strong> <span className="muted">{latest.id}</span>
                <div className="muted">需要：{latest.requires.join('、') || '无'} · 提供：{latest.provides.join('、') || '无'}</div>
                {missing.length ? <div className="warning-text">当前草稿缺少：{missing.join('、')}（添加后实例会停在等待状态）</div> : null}
                <button type="button" onClick={() => { onAdd(latest); setOpen(false) }}>添加到根作用域</button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

interface TimelineProps {
  data: RunData | undefined
  seq: number
  lastSeq: number
  onCursor(seq: number | null): void
}

const KIND_FILTERS = ['全部', 'checkpoint', 'lifecycle', 'session', 'data', 'service', 'diagnostic'] as const

export function Timeline({ data, seq, lastSeq, onCursor }: TimelineProps) {
  const [filter, setFilter] = useState<(typeof KIND_FILTERS)[number]>('全部')
  const count = data?.records.length ?? 0
  const records = useMemo(
    () => (data ? (filter === '全部' ? data.records : data.records.filter(record => record.kind === filter)) : []),
    // Records only grow; their count identifies the contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data?.runId, count, filter],
  )
  if (!data) return <section className="timeline"><p className="muted">还没有运行。点击“运行教学代码”。</p></section>
  const step = (direction: 1 | -1) => {
    // Records are sorted by seq: the first one after the cursor, or the last one before it.
    const after = records.findIndex(record => record.seq > seq)
    const end = after < 0 ? records.length : after
    const before = records[end - 1]?.seq === seq ? end - 2 : end - 1
    const target = direction > 0 ? records[after] : records[before]
    if (target) onCursor(target.seq)
    else if (direction < 0) onCursor(-1)
  }
  return (
    <section className="timeline" aria-label="执行轨迹">
      <div className="timeline__controls">
        <button type="button" onClick={() => step(-1)} aria-label="上一条记录">上一步</button>
        <button type="button" onClick={() => step(1)} aria-label="下一条记录">下一步</button>
        <button type="button" onClick={() => onCursor(null)}>场景结束时</button>
        <button type="button" onClick={() => onCursor(lastSeq)}>到最新（含结算）</button>
        <input
          type="range"
          min={-1}
          max={Math.max(lastSeq, -1)}
          value={seq}
          onChange={event => onCursor(Number(event.target.value))}
          aria-label="回放位置"
        />
        <span>回放位置 {seq} / {lastSeq}</span>
        <label>
          类型
          <select value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
            {KIND_FILTERS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
          </select>
        </label>
        <span className="muted">回放只移动游标，不会重新执行插件。</span>
      </div>
      {data.gaps.length ? <p className="warning-text">轨迹缺口：{data.gaps.map(gap => `${gap.fromSeq}–${gap.toSeq}`).join('，')}，结果不完整。</p> : null}
      {data.settled ? <p className="muted">运行结果：{outcomeText(data.settled.outcome)}，最后序号 {data.settled.finalSeq}</p> : <p className="muted">运行未结算，结果尚不完整。</p>}
      {data.settled?.completeness === 'truncated' ? <p className="warning-text">轨迹不完整：达到采集上限、写盘失败或运行中断，缺失的尾部不能视为成功。</p> : null}
      <TimelineRows records={records} payloads={data.payloads} seq={seq} onCursor={onCursor} />
    </section>
  )
}
