'use client'
/**
 * Before/after comparison (docs/01 §7): model requests, and between two runs
 * also the registry, execution process and session records. It shows whether
 * the two sides are strictly comparable before attributing a difference.
 */
import { useEffect, useMemo, useState } from 'react'
import type { RunManifest } from '@harness-explorer/contracts'
import { diffLines, requestsOf } from '@/lib/replay'
import { processLines, registryDiff, sessionLines } from '@/lib/compare'
import type { DiffLine, RequestEntry } from '@/lib/replay'
import type { RunData } from '@/lib/store'

interface Props {
  runs: RunManifest[]
  selected: RunData | undefined
  compare: RunData | undefined
  compareRunId: string | null
  onCompareRun(runId: string | null): void
}

function DiffView({ lines }: { lines: readonly DiffLine[] }) {
  return (
    <pre className="diff">
      {lines.map((line, index) => (
        <div key={index} className={`diff__${line.kind}`}>
          <span aria-hidden>{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}</span>
          <span className="sr-only">{line.kind === 'added' ? '新增：' : line.kind === 'removed' ? '删除：' : ''}</span>
          {line.text || ' '}
        </div>
      ))}
    </pre>
  )
}

function Diff({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after)
  if (lines.every(line => line.kind === 'same')) return <p className="muted">无差异</p>
  return <DiffView lines={lines} />
}

/**
 * Sections start collapsed. Whole-trace lines can be long, so the diff is only
 * computed once a section is opened; diffLines bounds its own cost.
 */
function Section({ title, before, after }: { title: string; before: string[]; after: string[] }) {
  const [open, setOpen] = useState(false)
  const identical = useMemo(() => before.length === after.length && before.every((line, index) => line === after[index]), [before, after])
  const lines = useMemo(() => (open && !identical ? diffLines(before.join('\n'), after.join('\n')) : null), [open, identical, before, after])
  const added = lines?.filter(line => line.kind === 'added').length ?? 0
  const removed = lines?.filter(line => line.kind === 'removed').length ?? 0
  const status = identical ? '无差异' : lines ? `新增 ${added} 行，删除 ${removed} 行` : '有差异，展开查看'
  return (
    <details className="run-diff__section" onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>{title}：{status}（A {before.length} 行，B {after.length} 行）</summary>
      {!open ? null : <DiffView lines={lines ?? after.map(text => ({ kind: 'same' as const, text }))} />}
    </details>
  )
}

/** Registry, process and session differences between the selected run (A) and the comparison run (B). */
function RunDiff({ a, b }: { a: RunData; b: RunData }) {
  const registry = useMemo(() => registryDiff(a, b), [a, b])
  const process = useMemo(() => [processLines(a), processLines(b)] as const, [a, b])
  const sessions = useMemo(() => [sessionLines(a), sessionLines(b)] as const, [a, b])
  const CHANGE = { added: '新增', removed: '移除', changed: '内容变化' } as const
  return (
    <section className="run-diff" aria-label="运行对比">
      <h3>运行对比：{a.runId}（A）→ {b.runId}（B），截至场景结束</h3>
      <h4>注册表</h4>
      {registry.length
        ? <ul>{registry.map(item => <li key={item.registrationId} className={`diff__${item.change === 'removed' ? 'removed' : 'added'}`}>{CHANGE[item.change]}：{item.label}</li>)}</ul>
        : <p className="muted">无差异</p>}
      <Section title="执行过程（状态变化、分发、检查点、诊断）" before={process[0]} after={process[1]} />
      <Section title="会话记录（持久事件）" before={sessions[0]} after={sessions[1]} />
    </section>
  )
}

export function RequestDiff({ runs, selected, compare, compareRunId, onCompareRun }: Props) {
  const entries = useMemo<RequestEntry[]>(() => [
    ...requestsOf(selected),
    ...compare && compare.runId !== selected?.runId ? requestsOf(compare, '对照 · ') : [],
  ], [selected, compare])
  const [left, setLeft] = useState<string | null>(null)
  const [right, setRight] = useState<string | null>(null)

  useEffect(() => {
    setLeft(current => current && entries.some(entry => entry.key === current) ? current : entries[0]?.key ?? null)
    setRight(current => current && entries.some(entry => entry.key === current) ? current : entries[1]?.key ?? entries[0]?.key ?? null)
  }, [entries])

  const a = entries.find(entry => entry.key === left)
  const b = entries.find(entry => entry.key === right)
  const runOf = (entry: RequestEntry | undefined) => (entry?.key.startsWith(`${compare?.runId}:`) && compare?.runId !== selected?.runId ? compare : selected)
  const revisionA = runOf(a)?.revision
  const revisionB = runOf(b)?.revision
  const modeOf = (data: RunData | undefined) => runs.find(run => run.runId === data?.runId)?.adapterMode
  const real = [runOf(a), runOf(b)].some(data => modeOf(data) === 'real')
  const conditions = revisionA && revisionB ? [
    { label: '场景版本', same: revisionA.scenarioHash === revisionB.scenarioHash },
    { label: '种子', same: revisionA.seed === revisionB.seed },
    { label: '内容版本', same: revisionA.contentVersion === revisionB.contentVersion },
    { label: '组合', same: JSON.stringify(revisionA.composition) === JSON.stringify(revisionB.composition) },
  ] : []

  return (
    <section className="request-diff" aria-label="请求对比">
      <div className="request-diff__pickers">
        <label>
          对照运行
          <select value={compareRunId ?? ''} onChange={event => onCompareRun(event.target.value || null)}>
            <option value="">（仅当前运行）</option>
            {runs.filter(run => run.runId !== selected?.runId).map(run => <option key={run.runId} value={run.runId}>{run.runId}</option>)}
          </select>
        </label>
        <label>
          请求 A
          <select value={left ?? ''} onChange={event => setLeft(event.target.value)}>
            {entries.map(entry => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
          </select>
        </label>
        <label>
          请求 B
          <select value={right ?? ''} onChange={event => setRight(event.target.value)}>
            {entries.map(entry => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
          </select>
        </label>
      </div>
      {!a || !b ? <p className="muted">至少需要一次模型请求。</p> : (
        <>
          {conditions.length ? (
            <p className={!real && conditions.every(item => item.same || item.label === '组合') ? 'muted' : 'warning-text'}>
              对照条件：{conditions.map(item => `${item.label}${item.same ? '相同' : '不同'}`).join('，')}。
              {conditions.some(item => !item.same && item.label !== '组合') ? '条件不一致，差异不能只归因于插件变化。' : ''}
              {real ? '包含真实模型的运行无法保证输出一致，只作带环境说明的观察对比。' : ''}
            </p>
          ) : null}
          <h3>system</h3>
          <Diff before={a.request.system} after={b.request.system} />
          <h3>messages</h3>
          <Diff before={JSON.stringify(a.request.messages, null, 2)} after={JSON.stringify(b.request.messages, null, 2)} />
          <h3>tools</h3>
          <Diff before={JSON.stringify(a.request.tools.map(tool => tool.name), null, 2)} after={JSON.stringify(b.request.tools.map(tool => tool.name), null, 2)} />
        </>
      )}
      {selected && compare && compare.runId !== selected.runId ? <RunDiff a={selected} b={compare} /> : null}
    </section>
  )
}
