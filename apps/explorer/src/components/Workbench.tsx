'use client'
/**
 * Overall composition workbench (docs/design/explorer-redesign.md §2): top bar
 * → run row → (error banner) → main area (layered tree canvas + right panel
 * with 数据流 / 实例 / 对比 tabs). One screen tall on wide screens.
 */
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { PluginInstance } from '@harness-explorer/contracts'
import { useExplorer, shownComposition, instanceById } from '@/lib/store'
import { phaseHistory, useReplay } from '@/lib/replay'
import { computeRequestFlow, serviceProviders } from '@/lib/dataflow'
import { PluginList, PluginTree } from './PluginTree'
import { Inspector, PluginLibraryPanel, PluginLibraryTrigger, PresetPicker, ReplayPosition, RunBar, ScopeEditor, lessonHref, outcomeText } from './Panels'
import { RequestDiff } from './RequestDiff'
import { ReplayBar } from './ReplayBar'
import { TraceContent, TraceDrawer } from './TraceDrawer'
import { DataFlowPanel } from './DataFlowPanel'
import { NarrowTabs, narrowPane } from './NarrowTabs'
import { affectedConsumers, instancesFor, planAddition, scopeRemovalProblem, scopeSessionProblem } from '@/lib/library'

type PanelTab = 'flow' | 'instance' | 'compare'
/** Narrow main-area tabs (§4): 插件树 | 详情 | 轨迹. */
type NarrowPane = 'tree' | 'inspector' | 'trace'

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Capacity hint (docs/02 §13): usage against the retention limits. */
function StorageNote({ storage }: { storage: NonNullable<ReturnType<typeof useExplorer.getState>['storage']> }) {
  const limits = storage.retention
  const nearLimit = limits !== null && (storage.runs >= limits.maxRuns * 0.8 || storage.bytes >= limits.maxBytes * 0.8)
  return (
    <span className={nearLimit ? 'warning-text' : 'muted'}>
      运行记录 {storage.runs} 个 · {megabytes(storage.bytes)}
      {limits ? `（上限 ${limits.maxRuns} 个 / ${megabytes(limits.maxBytes)}${nearLimit ? '，接近上限：结算后会自动删除最旧的未保留运行' : ''}）` : ''}
    </span>
  )
}

const LAYER_LABEL = { composition: '组合', dependency: '依赖', data: '数据流' } as const

export function Workbench() {
  const state = useExplorer()
  const router = useRouter()
  const [pane, setPane] = useState<NarrowPane>('tree')
  const [panelTab, setPanelTab] = useState<PanelTab>('flow')
  const [traceOpen, setTraceOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  // The workbench owns the canvas container and the replay bar elements; the
  // tree measures them through these refs instead of document.querySelector.
  const [treeElement, setTreeElement] = useState<HTMLDivElement | null>(null)
  const [replayBarElement, setReplayBarElement] = useState<HTMLDivElement | null>(null)
  useEffect(() => { void useExplorer.getState().init() }, [])
  // Narrow screens start on the layer-grouped list view (§4); once, at mount.
  useEffect(() => {
    if (window.matchMedia('(max-width: 960px)').matches) useExplorer.getState().setListView(true)
  }, [])

  const selected = state.selectedRunId ? state.runData[state.selectedRunId] : undefined
  const replay = useReplay(selected, state.cursor)
  const { composition, source } = shownComposition(state)

  const providers = useMemo(
    () => (composition && state.catalog ? serviceProviders(composition.instances, state.catalog.stages) : {}),
    [composition, state.catalog],
  )
  const flow = useMemo(
    () => (composition ? computeRequestFlow(selected, replay.seq, replay.snapshot, providers, composition.instances) : null),
    [selected, replay.seq, replay.snapshot, providers, composition],
  )

  if (state.error && !state.ready) {
    return (
      <main className="centered">
        <h1>Harness Explorer</h1>
        <p className="error-text">{state.error}</p>
        <p>请使用 <code>pnpm explorer</code> 在终端打印的启动链接打开本页面。</p>
      </main>
    )
  }
  if (!state.ready || !state.catalog || !state.draft || !composition) return <main className="centered"><p>正在连接本地控制服务…</p></main>

  const { catalog, draft } = state
  const instance = instanceById(composition, state.selectedInstanceId)
  const stage = catalog.stages.find(item => item.id === instance?.stageId)
  const draftDiffers = source === 'run' && JSON.stringify(composition) !== JSON.stringify(draft.composition)
  // Instances the draft added relative to the revision on screen («+ 新增» tag).
  const addedIds = new Set(
    source === 'draft' && selected?.revision
      ? draft.composition.instances.filter(item => !selected.revision!.composition.instances.some(other => other.id === item.id)).map(item => item.id)
      : [],
  )

  // On narrow screens selecting an instance shows its summary; wide screens show both panes anyway.
  const select = (id: string | null) => {
    state.selectInstance(id)
    if (id) {
      setPane('inspector')
      setPanelTab('instance')
    }
  }

  const openLesson = (target: PluginInstance) => {
    const lesson = state.lessons?.lessons.find(item => item.pluginDefinitionId === target.definitionId)
    if (lesson) router.push(lessonHref(lesson.id, target))
  }

  const updateInstances = (update: (instances: typeof draft.composition.instances) => typeof draft.composition.instances) =>
    state.editDraft(current => ({ ...current, composition: { ...current.composition, instances: update(current.composition.instances) } }))

  return (
    <div className="workbench">
      <header className="workbench__header">
        <div className="brand">
          <span className="brand__mark" aria-hidden>◇</span>
          <h1>Harness Explorer</h1>
        </div>
        <RunBar
          catalog={catalog}
          draft={draft}
          runtime={state.runtime}
          connected={state.connected}
          adapterMode={state.adapterMode}
          environment={state.environment}
          runMeta={selected ? `${selected.runId} · 回放 #${replay.seq}` : '草稿 · 尚未运行'}
          onAdapterMode={state.setAdapterMode}
          onScenario={scenarioId => state.editDraft(current => ({ ...current, scenarioId }))}
          onRun={() => void state.run()}
          onCancel={() => void state.cancel()}
        />
      </header>

      <div className="workbench__subbar">
        <label>
          查看运行
          <select value={state.selectedRunId ?? ''} onChange={event => void state.selectRun(event.target.value || null)}>
            <option value="">（草稿，尚未运行）</option>
            {state.runs.map(run => <option key={run.runId} value={run.runId}>{run.runId} · {outcomeText(run.outcome)}</option>)}
          </select>
        </label>
        {selected?.settled ? <span className="badge badge--ok">运行结果：{outcomeText(selected.settled.outcome)}</span> : null}
        {selected?.revision ? <span className="rev-id">{selected.revision.id}</span> : null}
        {selected ? <ReplayPosition revisionId={selected.revision?.id} seq={replay.seq} lastSeq={replay.lastSeq} atScenarioEnd={state.cursor === null} /> : null}
        {draftDiffers ? <span className="draft-drift" role="status">⚠ 草稿与此运行的版本不同 · 下次运行使用草稿</span> : null}
        {state.runtime?.runId && state.runtime.phase !== 'idle' && state.runtime.runId !== state.selectedRunId ? (
          <button type="button" onClick={() => void state.selectRun(state.runtime!.runId)}>观看正在进行的运行 {state.runtime.runId}</button>
        ) : null}
        <span className="spacer" />
        {state.selectedRunId ? (
          <>
            <a className="button" href={`/api/runs/${encodeURIComponent(state.selectedRunId)}/export`} download>导出运行</a>
            <label className="checkbox" title="保留的运行不会被自动清理">
              <input
                type="checkbox"
                checked={state.storage?.pinned.includes(state.selectedRunId) ?? false}
                onChange={event => void state.pinRun(state.selectedRunId!, event.target.checked)}
              />
              保留
            </label>
            <button
              type="button"
              disabled={state.runtime?.phase !== 'idle'}
              onClick={() => {
                if (window.confirm(`删除运行 ${state.selectedRunId}？删除后无法回放。`)) void state.deleteRun(state.selectedRunId!)
              }}
            >
              删除运行
            </button>
          </>
        ) : null}
        <label className="button">
          导入运行
          <input
            type="file"
            accept="application/json"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void state.importRun(file)
              event.target.value = ''
            }}
          />
        </label>
        {state.storage ? <StorageNote storage={state.storage} /> : null}
      </div>

      {state.error ? (
        <div className="banner banner--error" role="alert">
          <span className="banner__icon" aria-hidden>⊗</span>
          <span className="banner__text">{state.error}</span>
          <button type="button" onClick={state.dismissError}>知道了</button>
        </div>
      ) : null}

      <NarrowTabs<NarrowPane>
        label="主区域"
        panes={[{ id: 'tree', title: '插件树' }, { id: 'inspector', title: '详情' }, { id: 'trace', title: '轨迹' }]}
        current={pane}
        onSelect={setPane}
      />
      <div className="workbench__main">
        <section className={`workbench__tree${narrowPane(pane === 'tree')}`}>
          <div className="canvas-tools">
            <div className="segmented canvas-tools__layers" role="group" aria-label="图层">
              {(['composition', 'dependency', 'data'] as const).map(layer => (
                <button key={layer} type="button" aria-pressed={state.layer === layer} onClick={() => state.setLayer(layer)}>
                  {LAYER_LABEL[layer]}
                </button>
              ))}
            </div>
            <div className="segmented" role="group" aria-label="视图">
              <button type="button" aria-pressed={!state.listView} onClick={() => state.setListView(false)}>图</button>
              <button type="button" aria-pressed={state.listView} onClick={() => state.setListView(true)}>列表</button>
            </div>
            <span className="spacer" />
            <ScopeEditor
              composition={draft.composition}
              // Checked again on the draft the edit applies to: an earlier queued edit may have started using the scope.
              onRemove={id => void state.editDraft(current => (scopeRemovalProblem(id, current.composition) ? current : {
                ...current,
                composition: { ...current.composition, scopes: current.composition.scopes.filter(scope => scope.id !== id) },
              }))}
              onCreate={async (id, parentId) => {
                await state.editDraft(current => ({
                  ...current,
                  composition: { ...current.composition, scopes: [...current.composition.scopes, { id, parentId }] },
                }))
                return useExplorer.getState().draft?.composition.scopes.some(scope => scope.id === id) ?? false
              }}
              // Checked again on the draft the edit applies to: another tab may have listed the session meanwhile.
              onAddSession={async (scopeId, sessionId) => {
                await state.editDraft(current => (scopeSessionProblem(sessionId, current.composition.scopes, scopeId) ? current : {
                  ...current,
                  composition: {
                    ...current.composition,
                    scopes: current.composition.scopes.map(scope => (scope.id === scopeId ? { ...scope, sessions: [...(scope.sessions ?? []), sessionId] } : scope)),
                  },
                }))
                return useExplorer.getState().draft?.composition.scopes.some(scope => scope.id === scopeId && scope.sessions?.includes(sessionId)) ?? false
              }}
              onRemoveSession={(scopeId, sessionId) => void state.editDraft(current => ({
                ...current,
                composition: {
                  ...current.composition,
                  scopes: current.composition.scopes.map(scope => (scope.id === scopeId ? { ...scope, sessions: (scope.sessions ?? []).filter(item => item !== sessionId) } : scope)),
                },
              }))}
            />
            <PresetPicker
              presets={state.compositions}
              scenarios={catalog.presetScenarios}
              onLoad={async (id, scenarioId) => {
                await state.editDraft(current => ({
                  ...current,
                  parentRevisionId: null,
                  composition: structuredClone(state.compositions[id]!),
                  ...scenarioId ? { scenarioId } : {},
                }))
                // Show the draft that was just replaced, not a run of the old composition.
                state.selectInstance(null)
                await state.selectRun(null)
              }}
            />
            <PluginLibraryTrigger open={libraryOpen} onToggle={() => setLibraryOpen(!libraryOpen)} />
          </div>
          {state.listView
            ? <PluginList composition={composition} stages={catalog.stages} catalogLayers={catalog.layers} snapshot={replay.snapshot} flow={flow} selectedInstanceId={state.selectedInstanceId} onSelect={select} />
            : (
              <PluginTree
                composition={composition}
                stages={catalog.stages}
                catalogLayers={catalog.layers}
                snapshot={replay.snapshot}
                layer={state.layer}
                flow={flow}
                addedIds={addedIds}
                lessons={state.lessons}
                selectedInstanceId={state.selectedInstanceId}
                drawerOpen={traceOpen}
                treeElement={treeElement}
                replayBarElement={replayBarElement}
                onTreeElement={setTreeElement}
                onSelect={select}
                onOpenLesson={openLesson}
              />
            )}
          {libraryOpen ? (
            <PluginLibraryPanel
              stages={catalog.stages}
              responsibilities={catalog.responsibilities}
              draft={draft}
              onAdd={(selected, scopeId) => void updateInstances(instances => [...instances, ...instancesFor(selected, instances, scopeId)])}
              onClose={() => setLibraryOpen(false)}
            />
          ) : null}
          {traceOpen && selected ? (
            <TraceDrawer data={selected} seq={replay.seq} onCursor={state.setCursor} lessons={state.lessons} onSelectInstance={select} onClose={() => setTraceOpen(false)} />
          ) : null}
        </section>
        <div className={`workbench__inspector${narrowPane(pane === 'inspector')}`}>
          <div className="panel-tabs" role="tablist" aria-label="详情面板">
            {([['flow', '数据流'], ['instance', '实例'], ['compare', '对比']] as const).map(([id, title]) => (
              <button key={id} type="button" role="tab" aria-selected={panelTab === id} onClick={() => setPanelTab(id)}>{title}</button>
            ))}
          </div>
          {panelTab === 'flow' ? (
            <DataFlowPanel
              data={selected}
              flow={flow}
              seq={replay.seq}
              following={state.cursor === null}
              lessons={state.lessons}
              composition={composition}
              selectedInstanceId={state.selectedInstanceId}
              onCursor={state.setCursor}
              onSelectInstance={select}
            />
          ) : null}
          {panelTab === 'instance' ? (
            <div className="panel-body">
              <Inspector
                instance={instance}
                stage={stage}
                snapshot={replay.snapshot}
                lessons={state.lessons}
                editable={source === 'draft' || !draftDiffers}
                stagesOfDefinition={catalog.stages.filter(item => item.pluginDefinitionId === instance?.definitionId)}
                consumers={instance ? affectedConsumers(catalog.stages, composition.instances, instance.id) : []}
                missingProviders={stage ? planAddition(catalog.stages, composition.instances, stage).stages.slice(0, -1) : []}
                onAddProviders={() => {
                  if (stage) void updateInstances(instances => [...instances, ...instancesFor(planAddition(catalog.stages, instances, stage).stages.slice(0, -1), instances)])
                }}
                onRemove={id => void updateInstances(instances => instances.filter(item => item.id !== id))}
                onStage={(id, stageId) => void updateInstances(instances => instances.map(item => (item.id === id ? { ...item, stageId } : item)))}
                onEnabled={(id, enabled) => void updateInstances(instances => instances.map(item => (item.id === id ? { ...item, enabled } : item)))}
                scopes={composition.scopes}
                onScope={(id, scopeId) => void updateInstances(instances => instances.map(item => (item.id === id ? { ...item, scopeId } : item)))}
                onConfig={(id, config) => void updateInstances(instances => instances.map(item => (item.id === id ? { ...item, config } : item)))}
                history={phaseHistory(selected, instance?.id)}
                seq={replay.seq}
                onCursor={state.setCursor}
              />
            </div>
          ) : null}
          {panelTab === 'compare' ? (
            <div className="panel-body">
              <RequestDiff runs={state.runs} selected={selected} compare={state.compareRunId ? state.runData[state.compareRunId] : undefined} compareRunId={state.compareRunId} onCompareRun={runId => void state.setCompareRun(runId)} />
            </div>
          ) : null}
        </div>
        {/* The 轨迹 narrow tab shows the same content as the wide floating drawer.
            Mount it only while the tab is current so the drawer's copy (wide)
            never duplicates these rows in the accessibility tree. */}
        <section className={`workbench__trace${narrowPane(pane === 'trace')}`} aria-label="执行轨迹">
          {pane === 'trace' ? (
            selected ? (
              <TraceContent data={selected} seq={replay.seq} onCursor={state.setCursor} lessons={state.lessons} onSelectInstance={select} />
            ) : (
              <p className="muted workbench__trace-empty">还没有运行。点击顶部的 ▶ 按钮运行教学代码。</p>
            )
          ) : null}
        </section>
      </div>
      {/* Wide: floats over the canvas bottom; narrow (§4): the mini transport
          bar pinned below the main area, visible on every tab. */}
      <ReplayBar
        data={selected}
        seq={replay.seq}
        lastSeq={replay.lastSeq}
        traceOpen={traceOpen}
        requestTitle={flow?.title ?? null}
        barRef={setReplayBarElement}
        onCursor={state.setCursor}
        onToggleTrace={() => setTraceOpen(!traceOpen)}
      />
    </div>
  )
}
