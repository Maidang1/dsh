'use client'
/** 整体组合 workspace: tree, selection summary, timeline and request comparison (docs/01 §3.1, §4). */
import { useEffect, useState } from 'react'
import { useExplorer, shownComposition, instanceById } from '@/lib/store'
import { phaseHistory, useReplay } from '@/lib/replay'
import { PluginList, PluginTree } from './PluginTree'
import { Inspector, PluginLibrary, ReplayPosition, RunBar, Timeline, outcomeText } from './Panels'
import { RequestDiff } from './RequestDiff'
import { NarrowTabs, narrowPane } from './NarrowTabs'
import { affectedConsumers, instancesFor, planAddition } from '@/lib/library'

type BottomTab = 'timeline' | 'diff'

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

export function Workbench() {
  const state = useExplorer()
  const [tab, setTab] = useState<BottomTab>('timeline')
  const [pane, setPane] = useState<'tree' | 'inspector'>('tree')
  useEffect(() => { void useExplorer.getState().init() }, [])

  const selected = state.selectedRunId ? state.runData[state.selectedRunId] : undefined
  const replay = useReplay(selected, state.cursor)
  const { composition, source } = shownComposition(state)

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

  // On narrow screens selecting an instance shows its summary; wide screens show both panes anyway.
  const select = (id: string | null) => {
    state.selectInstance(id)
    if (id) setPane('inspector')
  }

  const updateInstances = (update: (instances: typeof draft.composition.instances) => typeof draft.composition.instances) =>
    state.editDraft(current => ({ ...current, composition: { ...current.composition, instances: update(current.composition.instances) } }))

  return (
    <div className="workbench">
      <header className="workbench__header">
        <h1>Harness Explorer</h1>
        <RunBar
          catalog={catalog}
          draft={draft}
          runtime={state.runtime}
          connected={state.connected}
          adapterMode={state.adapterMode}
          environment={state.environment}
          onAdapterMode={state.setAdapterMode}
          onScenario={scenarioId => state.editDraft(current => ({ ...current, scenarioId }))}
          onRun={() => void state.run()}
          onCancel={() => void state.cancel()}
        />
      </header>

      {state.error ? (
        <div className="banner banner--error" role="alert">
          {state.error} <button type="button" onClick={state.dismissError}>知道了</button>
        </div>
      ) : null}

      <div className="workbench__subbar">
        <label>
          查看运行
          <select value={state.selectedRunId ?? ''} onChange={event => void state.selectRun(event.target.value || null)}>
            <option value="">（草稿，尚未运行）</option>
            {state.runs.map(run => <option key={run.runId} value={run.runId}>{run.runId} · {outcomeText(run.outcome)}</option>)}
          </select>
        </label>
        {selected ? <ReplayPosition revisionId={selected.revision?.id} seq={replay.seq} lastSeq={replay.lastSeq} atScenarioEnd={state.cursor === null} /> : null}
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
        {state.storage ? <StorageNote storage={state.storage} /> : null}
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
        <div className="segmented" role="group" aria-label="图层">
          {(['composition', 'dependency', 'data'] as const).map(layer => (
            <button key={layer} type="button" aria-pressed={state.layer === layer} onClick={() => state.setLayer(layer)}>
              {{ composition: '组合', dependency: '依赖', data: '运行数据' }[layer]}
            </button>
          ))}
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={state.listView} onChange={event => state.setListView(event.target.checked)} />
          列表视图
        </label>
        <PluginLibrary
          stages={catalog.stages}
          responsibilities={catalog.responsibilities}
          draft={draft}
          onAdd={selected => void updateInstances(instances => [...instances, ...instancesFor(selected, instances)])}
        />
      </div>

      {source === 'run' ? (
        <div className={`banner ${draftDiffers ? 'banner--warning' : ''}`}>
          正在查看运行 {state.selectedRunId} 绑定的版本 {selected?.revision?.id}。
          {draftDiffers ? ' 当前草稿与它不同，下一次运行会使用草稿。' : ''}
        </div>
      ) : null}

      <NarrowTabs<'tree' | 'inspector'>
        label="主区域"
        panes={[{ id: 'tree', title: '插件树' }, { id: 'inspector', title: instance ? `实例摘要（${instance.id}）` : '实例摘要' }]}
        current={pane}
        onSelect={setPane}
      />
      <div className="workbench__main">
        <section className={`workbench__tree${narrowPane(pane === 'tree')}`}>
          {state.listView
            ? <PluginList composition={composition} snapshot={replay.snapshot} selectedInstanceId={state.selectedInstanceId} onSelect={select} />
            : <PluginTree composition={composition} stages={catalog.stages} snapshot={replay.snapshot} layer={state.layer} selectedInstanceId={state.selectedInstanceId} onSelect={select} />}
        </section>
        <div className={`workbench__inspector${narrowPane(pane === 'inspector')}`}>
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
            history={phaseHistory(selected, instance?.id)}
            seq={replay.seq}
            onCursor={state.setCursor}
          />
        </div>
      </div>

      <section className="workbench__bottom">
        <div className="segmented" role="tablist" aria-label="底部面板">
          <button type="button" role="tab" aria-selected={tab === 'timeline'} onClick={() => setTab('timeline')}>执行轨迹</button>
          <button type="button" role="tab" aria-selected={tab === 'diff'} onClick={() => setTab('diff')}>请求对比</button>
        </div>
        {tab === 'timeline'
          ? <Timeline data={selected} seq={replay.seq} lastSeq={replay.lastSeq} onCursor={state.setCursor} lessons={state.lessons} onSelectInstance={select} />
          : <RequestDiff runs={state.runs} selected={selected} compare={state.compareRunId ? state.runData[state.compareRunId] : undefined} compareRunId={state.compareRunId} onCompareRun={runId => void state.setCompareRun(runId)} />}
      </section>
    </div>
  )
}
