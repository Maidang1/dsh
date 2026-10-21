'use client'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ROOT_SCOPE, sameJson } from '@harness-explorer/contracts'
import type { AdapterMode, Composition, EnvironmentSnapshot, JsonValue, PluginInstance, PluginPhasePayload, PluginResponsibility, RuntimeState, ScopeDefinition } from '@harness-explorer/contracts'
import type { ViewRegistration, ViewSnapshot } from '@harness-explorer/trace/browser'
import { api } from '@/lib/api'
import type { Draft, InstalledPackage, LessonsResponse, PackageSearchResult, PublicCatalog, PublicStage } from '@/lib/api'
import { describeFailure } from '@/lib/errors'
import { useExplorer } from '@/lib/store'
import { PHASE_LABEL, phaseOf } from './PluginTree'
import type { PhaseChange } from '@/lib/replay'
import { latestStages, parseConfig, planAddition, scopeIdProblem, scopeRemovalProblem, scopeSessionProblem } from '@/lib/library'
import type { AffectedConsumer } from '@/lib/library'

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

/**
 * Which run version and replay position the views show (docs/01 §10), kept in
 * the replay bar so it stays visible whichever side tab is open.
 */
export function ReplayPosition({ revisionId, seq, lastSeq, atScenarioEnd }: { revisionId: string | undefined; seq: number; lastSeq: number; atScenarioEnd: boolean }) {
  // The full revision id lives in the run row; the bar shows enough to tell revisions apart.
  const short = revisionId && revisionId.length > 12 ? revisionId.slice(0, 12) : revisionId
  return (
    <span className="badge" aria-label="当前位置">
      {short ? `版本 ${short} · ` : ''}回放 #{seq} / #{lastSeq}{atScenarioEnd ? '（场景结束时）' : ''}
    </span>
  )
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
  /** Secondary line under the scenario on narrow screens: `run id · 回放 #seq` (§4). */
  runMeta: string | null
  onAdapterMode(mode: AdapterMode): void
  onScenario(id: string): void
  onRun(): void
  onCancel(): void
}

/** Top bar: brand, scenario and model selectors, controller status capsule, the run button (§2.1). On narrow screens it compresses to scenario + meta + an icon run button (§4). */
export function RunBar({ catalog, draft, runtime, connected, adapterMode, environment, runMeta, onAdapterMode, onScenario, onRun, onCancel }: RunBarProps) {
  const busy = runtime !== null && runtime.phase !== 'idle'
  const missing = environment?.real.variables.filter(variable => variable.sensitive && !variable.present).map(variable => variable.name) ?? ['DEEPSEEK_API_KEY']
  const scenario = catalog.scenarios.find(item => item.id === draft.scenarioId)
  const realAllowed = missing.length === 0 && scenario?.adapterModes.includes('real')
  return (
    <div className="run-bar" role="toolbar" aria-label="运行控制">
      <label className="run-bar__scenario">
        <span className="run-bar__label-text">场景</span>
        <select aria-label="场景" value={draft.scenarioId} onChange={event => onScenario(event.target.value)}>
          {catalog.scenarios.map(scenario => <option key={scenario.id} value={scenario.id}>{scenario.title}</option>)}
        </select>
      </label>
      <span className="run-bar__meta">{runMeta}</span>
      <label className="run-bar__model">
        <span className="run-bar__label-text">模型</span>
        <select aria-label="模型" value={adapterMode} onChange={event => onAdapterMode(event.target.value as AdapterMode)}>
          <option value="deterministic">确定性模型 · 无需 API Key</option>
          <option value="real" disabled={!realAllowed}>
            真实模型 DeepSeek{missing.length ? `（需在启动环境设置 ${missing.join('、')}）` : scenario?.adapterModes.includes('real') ? '' : '（当前场景不支持）'}
          </option>
        </select>
      </label>
      <span className="badge">{adapterMode === 'real' ? '结果不可严格复现 · 环境来自本机' : '确定性模型 · 可重复'}</span>
      <span className={`run-bar__phase${connected ? '' : ' is-off'}`} aria-live="polite">
        <span className="dot" aria-hidden />
        控制器{PHASE_TEXT[runtime?.phase ?? 'idle']} · {connected ? '已连接' : '未订阅'}
        {runtime?.error ? ` · ${runtime.error.message}` : ''}
      </span>
      <span className="run-bar__actions">
        {busy ? <button type="button" onClick={onCancel}>停止运行</button> : null}
        <button type="button" className="primary run-bar__run" aria-label="运行教学代码" onClick={onRun} disabled={busy} title={busy ? '当前运行结束后才能再次运行' : undefined}>
          <span aria-hidden>▶ </span><span className="run-bar__run-text">运行教学代码</span>
        </button>
      </span>
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
  /** Consumers that would lose a provider if this instance were removed from the draft. */
  consumers: AffectedConsumer[]
  /** Stages that would provide the services this instance's stage lacks in the draft. */
  missingProviders: PublicStage[]
  onAddProviders(): void
  onRemove(id: string): void
  onStage(id: string, stageId: string): void
  onEnabled(id: string, enabled: boolean): void
  scopes: readonly ScopeDefinition[]
  onScope(id: string, scopeId: string): void
  onConfig(id: string, config: { [key: string]: JsonValue }): void
  history: PhaseChange[]
  seq: number
  onCursor(seq: number): void
}

/**
 * Removing from the composition lists who is affected before it edits the
 * draft (docs/01 §5.2). It is not the scenario's unmount step: the next run
 * never loads the instance, so it shows no cleanup.
 */
function RemoveControl({ instanceId, consumers, registrations, onRemove }: {
  instanceId: string
  consumers: AffectedConsumer[]
  registrations: ViewRegistration[]
  onRemove(id: string): void
}) {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) return <button type="button" className="danger" onClick={() => setConfirming(true)}>从组合中移除…</button>
  return (
    <div className="remove-confirm" role="group" aria-label="确认从组合中移除">
      <p><strong>从组合中移除 {instanceId}</strong></p>
      <p>受影响的消费者：{consumers.length
        ? consumers.map(item => `${item.instanceId}（需要 ${item.services.join('、')}）`).join('；')
        : '无（没有实例只依赖它提供的服务）'}</p>
      <p>回放位置上它的注册项：{registrations.length ? registrations.map(item => `${item.kind} · ${item.name}`).join('；') : '无'}</p>
      <p className="muted">新运行里它从未加载，只能与旧运行对比结果；消费者会等待还是停用以运行器报告为准。要观察清理过程，请运行包含卸载步骤的场景。历史运行保留可回放。</p>
      <button type="button" className="danger" onClick={() => onRemove(instanceId)}>确认移除</button>
      <button type="button" onClick={() => setConfirming(false)}>取消</button>
    </div>
  )
}

/** Where to go next for a non-active instance (docs/01 §5.3). */
function StateFix({ plugin, enabled, unavailable, editable, missingProviders, onAddProviders }: {
  plugin: PluginPhasePayload | undefined
  enabled: boolean
  unavailable: string[]
  editable: boolean
  missingProviders: PublicStage[]
  onAddProviders(): void
}) {
  let fix: ReactNode = null
  if (!plugin && !enabled) {
    fix = <>勾选下方“运行开始时挂载”，或运行包含挂载步骤的场景。</>
  } else if (plugin?.phase === 'pending' && plugin.dependencyStatus === 'missing') {
    fix = missingProviders.length ? (
      <>
        缺少服务 {unavailable.join('、') || '（见原因）'}。
        {editable
          ? <button type="button" onClick={onAddProviders}>添加提供者：{missingProviders.map(item => item.pluginDefinitionId).join('、')}</button>
          : '返回草稿后可以添加提供者。'}
      </>
    ) : <>草稿中已有提供 {unavailable.join('、') || '所需服务'} 的实例；重新运行后查看是否解析，或检查提供者自身的状态。</>
  } else if (plugin?.phase === 'failed') {
    fix = <>在下方时间线中查看该实例的诊断记录，切换到其他阶段，或进入插件实现阅读代码。</>
  }
  return fix ? <p className="state-fix" aria-label="修复建议">修复：{fix}</p> : null
}

/** Empty-state legend for the 实例 tab when nothing is selected (§2.5). */
function InspectorLegend() {
  return (
    <div className="inspector__empty">
      <p className="muted">选择插件树中的一个实例查看状态与依赖。</p>
      <h3>节点状态</h3>
      <ul className="inspector__legend">
        {Object.values(PHASE_LABEL).map(label => <li key={label.text}><span aria-hidden>{label.mark}</span> {label.text}</li>)}
        <li><span aria-hidden>◐</span> 等待服务 / 等待中（原因未知）</li>
        <li><span aria-hidden>·</span> 未启用（由场景挂载）</li>
      </ul>
      <h3>图层</h3>
      <ul className="inspector__legend">
        <li>组合：父子挂载关系与 root → L1 服务</li>
        <li>依赖：consumer → provider，标注「已解析 / 声明」</li>
        <li>数据流：回放游标所在一次请求里真实流经的注册与模型调用</li>
      </ul>
    </div>
  )
}

export function Inspector({ instance, stage, snapshot, lessons, editable, stagesOfDefinition, consumers, missingProviders, onAddProviders, onRemove, onStage, onEnabled, history, seq, onCursor, scopes, onScope, onConfig }: InspectorProps) {
  if (!instance) return <aside className="inspector"><InspectorLegend /></aside>
  const plugin = snapshot.plugins[instance.id]
  const phase = phaseOf(plugin, instance.enabled)
  const unavailable = (stage?.requires ?? []).filter(service => !snapshot.services[service]?.available)
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
        {plugin && (plugin.phase === 'pending' || plugin.phase === 'failed') && !plugin.reason && !plugin.error
          ? <><dt>原因</dt><dd className="muted">未知（运行器没有报告原因）</dd></>
          : null}
        {plugin?.error ? <><dt>错误</dt><dd className="error-text">{plugin.error.name}: {plugin.error.message}</dd></> : null}
        <dt>需要</dt><dd>{stage?.requires.join('、') || '无'}</dd>
        <dt>提供</dt><dd>{stage?.provides.join('、') || '无'}</dd>
      </dl>
      <StateFix
        plugin={plugin}
        enabled={instance.enabled}
        unavailable={unavailable}
        editable={editable}
        missingProviders={missingProviders}
        onAddProviders={onAddProviders}
      />
      <h3>状态变化</h3>
      {history.length ? (
        <ol className="phase-history" aria-label="状态变化（点击跳到该位置）">
          {history.map(change => (
            <li key={change.seq} className={change.seq > seq ? 'is-future' : ''}>
              <button type="button" aria-current={change.seq <= seq && !history.some(later => later.seq > change.seq && later.seq <= seq) ? 'step' : undefined} onClick={() => onCursor(change.seq)}>
                <span aria-hidden>{(PHASE_LABEL[change.phase] ?? PHASE_LABEL.none!).mark}</span> {(PHASE_LABEL[change.phase] ?? PHASE_LABEL.none!).text}
                <span className="muted"> · #{change.seq}{change.stepId ? ` · 步骤 ${change.stepId}` : ' · 初始挂载'}</span>
              </button>
              {change.reason ? <div className="muted">{change.reason}</div> : null}
              {change.error ? <div className="error-text">{change.error}</div> : null}
            </li>
          ))}
        </ol>
      ) : <p className="muted">本次运行没有记录到该实例的状态。</p>}
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
          {scopes.length > 1 ? (
            <label>
              作用域
              <select value={instance.scopeId} onChange={event => onScope(instance.id, event.target.value)}>
                {scopes.some(scope => scope.id === instance.scopeId) ? null : <option value={instance.scopeId}>{instance.scopeId}（组合中不存在）</option>}
                {scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.id}{scope.parentId ? `（父：${scope.parentId}）` : ''}</option>)}
              </select>
            </label>
          ) : null}
          <ConfigEditor key={`config:${instance.id}`} config={instance.config} configKeys={stage?.configKeys} onApply={config => onConfig(instance.id, config)} />
          <RemoveControl key={`remove:${instance.id}`} instanceId={instance.id} consumers={consumers} registrations={registrations} onRemove={onRemove} />
          <p className="muted">修改只影响草稿；下次运行会生成新的实验版本，历史运行保持不变。</p>
        </div>
      ) : <p className="muted">正在查看历史运行绑定的版本，返回草稿后才能编辑。</p>}
    </aside>
  )
}

/**
 * Edit an instance's config as JSON; unsupported keys are named before commit
 * would refuse them. A config changed elsewhere replaces the text unless the
 * learner has unsaved edits, which are kept until they choose.
 */
function ConfigEditor({ config, configKeys, onApply }: { config: JsonValue; configKeys: readonly string[] | undefined; onApply(config: { [key: string]: JsonValue }): void }) {
  const show = (value: JsonValue) => JSON.stringify(value ?? {}, null, 2)
  const [text, setText] = useState(() => show(config))
  // The config the text started from or last applied.
  const [base, setBase] = useState<JsonValue>(config)
  const result = parseConfig(text, configKeys)
  const dirty = !('config' in result) || !sameJson(result.config, base)
  const external = !sameJson(config, base)
  const reload = () => { setText(show(config)); setBase(config) }
  useEffect(() => {
    if (external && !dirty) reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])
  const changed = 'config' in result && !sameJson(result.config, config)
  return (
    <div className="config-editor">
      <label>
        配置（JSON）{configKeys ? <span className="muted">支持：{configKeys.join('、') || '无'}</span> : null}
        <textarea value={text} rows={Math.min(8, text.split('\n').length + 1)} spellCheck={false} onChange={event => setText(event.target.value)} />
      </label>
      {'problem' in result ? <p className="error-text" role="status">{result.problem}</p> : null}
      {external && dirty ? (
        <p className="warning-text">配置已在别处更新，上面是尚未应用的修改。 <button type="button" onClick={reload}>载入最新配置</button></p>
      ) : null}
      <button type="button" disabled={!changed} onClick={() => { if ('config' in result) { setBase(result.config); onApply(result.config) } }}>应用配置</button>
    </div>
  )
}

/**
 * Start the draft over from a preset composition (fixtures/compositions), as a
 * popover over the canvas (§2.3). It replaces the draft's composition, so it
 * asks first; runs keep their own revisions.
 */
export function PresetPicker({ presets, scenarios, onLoad }: {
  presets: Readonly<Record<string, Composition>>
  /** The scenario written for each preset; loading a preset switches to it. */
  scenarios: Readonly<Record<string, string>>
  onLoad(id: string, scenarioId: string | undefined): void
}) {
  const ids = Object.keys(presets)
  const [open, setOpen] = useState(false)
  const [id, setId] = useState(ids[0] ?? '')
  const [confirming, setConfirming] = useState(false)
  if (!ids.length) return null
  const close = () => { setOpen(false); setConfirming(false) }
  return (
    <div className="preset-popover">
      <button type="button" className="tool-button" onClick={() => setOpen(!open)} aria-expanded={open}>预设…</button>
      {open ? (
        <div className="popover popover--presets">
          <div className="preset-picker" role="group" aria-label="从预设开始">
            <h3>从预设开始</h3>
            <label>
              预设组合
              <select value={id} onChange={(event) => { setId(event.target.value); setConfirming(false) }}>
                {ids.map(item => <option key={item} value={item}>{item}（{presets[item]!.instances.length} 个实例）</option>)}
              </select>
            </label>
            {confirming ? (
              <span>
                草稿的组合将被 {id} 替换{scenarios[id] ? `，场景切换为 ${scenarios[id]}` : '，场景保持不变'}；历史运行不受影响。
                <button type="button" className="danger" onClick={() => { onLoad(id, scenarios[id]); close() }}>确认载入</button>
                <button type="button" onClick={() => setConfirming(false)}>取消</button>
              </span>
            ) : <button type="button" onClick={() => setConfirming(true)}>载入预设…</button>}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Scopes of the draft and a form to add one; instances choose their scope in the inspector. */
export function ScopeEditor({ composition, onCreate, onRemove, onAddSession, onRemoveSession }: {
  composition: { scopes: readonly ScopeDefinition[]; instances: readonly PluginInstance[] }
  onCreate(id: string, parentId: string): Promise<boolean>
  onRemove(id: string): void
  onAddSession(scopeId: string, sessionId: string): Promise<boolean>
  onRemoveSession(scopeId: string, sessionId: string): void
}) {
  const scopes = composition.scopes
  // One pass per draft change, not per scope on every render.
  const problems = useMemo(() => new Map(scopes.map(scope => [scope.id, scopeRemovalProblem(scope.id, composition)])), [composition, scopes])
  const [id, setId] = useState('')
  const [parentId, setParentId] = useState(ROOT_SCOPE)
  const [saving, setSaving] = useState(false)
  // A parent picked earlier may have gone with a reloaded draft; never submit one that is not there.
  const parent = scopes.some(scope => scope.id === parentId) ? parentId : ROOT_SCOPE
  const problem = id ? scopeIdProblem(id, scopes) : null
  return (
    <details className="scope-editor">
      <summary>作用域（{scopes.length}）</summary>
      <div className="popover popover--scopes">
        <h3>作用域</h3>
        <ul>
          {scopes.map((scope) => {
            const problem = problems.get(scope.id)
            return (
              <li key={scope.id}>
                {scope.id}{scope.parentId ? <span className="muted">（父：{scope.parentId}）</span> : <span className="muted">（根）</span>}
                {problem
                  ? <span className="muted"> · 不能删除：{problem}</span>
                  : <> <button type="button" className="link-button" onClick={() => onRemove(scope.id)}>删除</button></>}
                {scope.id === ROOT_SCOPE ? null : (
                  <ScopeSessions scope={scope} scopes={scopes} onAdd={onAddSession} onRemove={onRemoveSession} />
                )}
              </li>
            )
          })}
        </ul>
        <p className="muted">作用域是上游 dsh-scope 的注册层：作用域里的实例注册的提示词片段与工具只对住在该作用域的会话可见；会话由作用域的 sessions 列出，未列出的会话住在根作用域。服务在整个组合中解析。</p>
        <label>
          新作用域
          <input value={id} onChange={event => setId(event.target.value.trim())} placeholder="例如 agent-b" />
        </label>
        <label>
          父作用域
          <select value={parent} onChange={event => setParentId(event.target.value)}>
            {scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.id}</option>)}
          </select>
        </label>
        {problem ? <p className="error-text" role="status">{problem}</p> : null}
        <button
          type="button"
          disabled={!id || problem !== null || saving}
          onClick={async () => {
            setSaving(true)
            // Keep the name if the save did not take, e.g. the draft changed in another tab.
            if (await onCreate(id, parent)) setId('')
            setSaving(false)
          }}
        >
          新建作用域
        </button>
      </div>
    </details>
  )
}

/**
 * The sessions whose agent lives in `scope`, with add/remove. The add input
 * keeps whitespace so the inline error can name it, mirroring the scope-name
 * validation above; only the committed value is trimmed.
 */
function ScopeSessions({ scope, scopes, onAdd, onRemove }: {
  scope: ScopeDefinition
  scopes: readonly ScopeDefinition[]
  onAdd(scopeId: string, sessionId: string): Promise<boolean>
  onRemove(scopeId: string, sessionId: string): void
}) {
  const sessions = scope.sessions ?? []
  const [id, setId] = useState('')
  const [saving, setSaving] = useState(false)
  const problem = id ? scopeSessionProblem(id, scopes, scope.id) : null
  return (
    <div className="scope-sessions">
      {sessions.length ? (
        <ul>
          {sessions.map(session => (
            <li key={session}>
              {session} <button type="button" className="link-button" onClick={() => onRemove(scope.id, session)}>移出</button>
            </li>
          ))}
        </ul>
      ) : <p className="muted">没有会话住在这里；未列出的会话住在根作用域。</p>}
      <label>
        添加会话
        <input value={id} onChange={event => setId(event.target.value)} placeholder="例如 s-b" />
      </label>
      {problem ? <p className="error-text" role="status">{problem}</p> : null}
      <button
        type="button"
        disabled={!id || problem !== null || saving}
        onClick={async () => {
          setSaving(true)
          // Keep the id if the save did not take, e.g. the draft changed in another tab.
          if (await onAdd(scope.id, id.trim())) setId('')
          setSaving(false)
        }}
      >
        添加会话
      </button>
    </div>
  )
}

const RESPONSIBILITY_LABEL: Record<PluginResponsibility, string> = {
  'session': '会话',
  'prompt': '提示词',
  'tool': '工具',
  'event-policy': '事件策略',
  'model': '模型适配',
  'agent-loop': '执行循环',
  'other': '其他',
}

const responsibilityLabel = (responsibility: PluginResponsibility | undefined) => responsibility ? RESPONSIBILITY_LABEL[responsibility] : '未分类'

/** npm 附加包：搜索 registry 上的 @deepseek-ai/dsh-* 包并装入或移出插件库。 */
function NpmPackages() {
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState<string | null>(null)
  const [results, setResults] = useState<PackageSearchResult[] | null>(null)
  const [installed, setInstalled] = useState<InstalledPackage[] | null>(null)
  const [busy, setBusy] = useState<{ action: 'install' | 'uninstall'; name: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const refreshCatalog = useExplorer(state => state.refreshCatalog)

  const loadInstalled = async () => setInstalled(await api.packages())
  useEffect(() => { void loadInstalled().catch(() => {}) }, [])

  const search = async (text: string) => {
    setResults((await api.searchPackages(text)).results)
    setSearched(text)
  }

  // A new stage only appears in the library below once the catalog is refetched;
  // re-running the current search keeps its 已安装 flags in step.
  const changed = async () => {
    await loadInstalled()
    await refreshCatalog()
    if (searched !== null) await search(searched)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setProblem(null)
    try {
      await search(query)
    } catch (error) {
      setProblem(describeFailure('searchPackages', error))
    }
  }

  const run = async (action: 'install' | 'uninstall', name: string) => {
    setBusy({ action, name })
    setProblem(null)
    try {
      await (action === 'install' ? api.installPackage(name) : api.uninstallPackage(name))
      await changed()
    } catch (error) {
      setProblem(describeFailure(action === 'install' ? 'installPackage' : 'uninstallPackage', error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <details>
      <summary>从 npm 安装</summary>
      <form onSubmit={event => void submit(event)}>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索 @deepseek-ai/dsh-* 包" aria-label="搜索 npm 包" />
        <button type="submit" disabled={busy !== null}>搜索</button>
      </form>
      {busy ? <p className="muted" role="status">{busy.action === 'install' ? '正在安装' : '正在卸载'} {busy.name}…</p> : null}
      {problem ? <p className="error-text" role="status">{problem}</p> : null}
      {results !== null ? (
        results.length ? (
          <ul className="library__list">
            {results.map(item => (
              <li key={item.name}>
                <strong>{item.name}</strong> <span className="muted">{item.version}</span>
                <div className="muted">{item.description || '（无描述）'}</div>
                <button type="button" disabled={busy !== null || item.installed || item.available === false} onClick={() => void run('install', item.name)}>安装</button>
                {item.installed ? <span className="muted">已安装</span>
                  : item.available === false ? <span className="muted">没有与内核匹配的发布版本</span>
                    : null}
              </li>
            ))}
          </ul>
        ) : <p className="muted">没有找到匹配的包</p>
      ) : null}
      <p><strong>已安装（{installed?.length ?? 0}）</strong></p>
      {installed?.length ? (
        <ul className="library__list">
          {installed.map(item => (
            <li key={item.name}>
              <strong>{item.name}</strong> <span className="muted">{item.version}</span>
              <button type="button" disabled={busy !== null} onClick={() => void run('uninstall', item.name)}>卸载</button>
            </li>
          ))}
        </ul>
      ) : installed !== null ? <p className="muted">尚未安装任何 npm 包</p> : null}
    </details>
  )
}

interface LibraryProps {
  stages: readonly PublicStage[]
  responsibilities: Readonly<Record<string, PluginResponsibility>>
  draft: Draft
  /** Stages to add to `scopeId`, dependencies first. */
  onAdd(stages: PublicStage[], scopeId: string): void
}

/**
 * Plugin library: the trigger lives in the canvas tools, the drawer panel and
 * its overlay are rendered by the workbench as siblings of the canvas (§2.3,
 * screen 01c) — inside .canvas-tools an absolute panel would size against the
 * tool strip instead of the tree section.
 */
export function PluginLibraryTrigger({ open, onToggle }: { open: boolean; onToggle(): void }) {
  return <button type="button" className="tool-button tool-button--accent" onClick={onToggle} aria-expanded={open}>＋ 添加插件</button>
}

export function PluginLibraryPanel({ stages, responsibilities, draft, onAdd, onClose }: LibraryProps & { onClose(): void }) {
  const scopes = draft.composition.scopes
  const [scopeId, setScopeId] = useState(ROOT_SCOPE)
  const target = scopes.some(scope => scope.id === scopeId) ? scopeId : ROOT_SCOPE
  const [filter, setFilter] = useState<PluginResponsibility | null>(null)
  const definitions = useMemo(() => latestStages(stages), [stages])
  const present = (Object.keys(RESPONSIBILITY_LABEL) as PluginResponsibility[])
    .filter(responsibility => definitions.some(stage => responsibilities[stage.pluginDefinitionId] === responsibility))
  const add = (selected: PublicStage[]) => { onAdd(selected, target); onClose() }
  return (
    <>
      <button type="button" className="library__overlay" aria-label="关闭插件库" onClick={onClose} />
      <div className="library__panel">
        <div className="library__head">
          <h3>插件库</h3>
          <button type="button" aria-label="关闭插件库面板" onClick={onClose}>✕</button>
        </div>
        <NpmPackages />
        {scopes.length > 1 ? (
          <label>
            加入作用域
            <select value={target} onChange={event => setScopeId(event.target.value)}>
              {scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.id}</option>)}
            </select>
          </label>
        ) : null}
        <div className="segmented" role="group" aria-label="按职责筛选">
          <button type="button" aria-pressed={filter === null} onClick={() => setFilter(null)}>全部</button>
          {present.map(responsibility => (
            <button key={responsibility} type="button" aria-pressed={filter === responsibility} onClick={() => setFilter(responsibility)}>
              {RESPONSIBILITY_LABEL[responsibility]}
            </button>
          ))}
        </div>
        <ul className="library__list">
          {definitions.filter(latest => filter === null || responsibilities[latest.pluginDefinitionId] === filter).map(latest => {
            const plan = planAddition(stages, draft.composition.instances, latest)
            const missing = [...plan.providers.map(item => item.service), ...plan.unresolved]
            return (
              <li key={latest.pluginDefinitionId}>
                <strong>{latest.pluginDefinitionId}</strong> <span className="muted">{latest.id} · {responsibilityLabel(responsibilities[latest.pluginDefinitionId])}</span>
                <div className="muted">需要：{latest.requires.join('、') || '无'} · 提供：{latest.provides.join('、') || '无'}</div>
                <div className="muted">
                  阶段：{stages.filter(stage => stage.pluginDefinitionId === latest.pluginDefinitionId).map(stage => stage.id.split('@')[1]).join('、')}
                  {latest.configKeys ? ` · 配置项：${latest.configKeys.join('、') || '无'}` : ''}
                  {' · 来源：'}{latest.origin === 'teaching' ? '本项目教学插件' : `npm ${latest.package?.name ?? ''}@${latest.package?.version ?? latest.upstreamCommit?.slice(0, 8)}`}
                </div>
                {missing.length ? (
                  <div className="warning-text">
                    组合中缺少：{missing.join('、')}（只添加此插件时，实例会停在等待状态）
                    {plan.providers.length ? <div>可同时添加：{plan.providers.map(item => `${item.stage.pluginDefinitionId}（提供 ${item.service}）`).join('、')}</div> : null}
                    {plan.unresolved.length ? <div>插件库中没有提供 {plan.unresolved.join('、')} 的插件</div> : null}
                  </div>
                ) : null}
                <button type="button" onClick={() => add([latest])}>{missing.length ? '只添加此插件' : target === ROOT_SCOPE ? '添加到根作用域' : `添加到作用域 ${target}`}</button>
                {plan.providers.length ? (
                  <button type="button" onClick={() => add(plan.stages)}>同时添加依赖（共 {plan.stages.length} 个实例）</button>
                ) : null}
              </li>
            )
          })}
        </ul>
      </div>
    </>
  )
}

/**
 * Link to a lesson opened at the stage an instance ran, so the code shown is
 * the code that ran. Entering from the tree keeps the learner's reading position instead.
 */
export const lessonHref = (lessonId: string, instance: PluginInstance) =>
  `/plugin/${lessonId}?instance=${encodeURIComponent(instance.id)}&stage=${encodeURIComponent(instance.stageId)}`
