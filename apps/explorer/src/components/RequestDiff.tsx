'use client'
/**
 * Before/after comparison of model requests (docs/01 §7). It shows whether the
 * two sides are strictly comparable before attributing a difference.
 */
import { useEffect, useMemo, useState } from 'react'
import type { RunManifest } from '@harness-explorer/contracts'
import { diffLines, requestsOf } from '@/lib/replay'
import type { RequestEntry } from '@/lib/replay'
import type { RunData } from '@/lib/store'

interface Props {
  runs: RunManifest[]
  selected: RunData | undefined
  compare: RunData | undefined
  compareRunId: string | null
  onCompareRun(runId: string | null): void
}

function Diff({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after)
  if (lines.every(line => line.kind === 'same')) return <p className="muted">无差异</p>
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
            <p className={conditions.every(item => item.same || item.label === '组合') ? 'muted' : 'warning-text'}>
              对照条件：{conditions.map(item => `${item.label}${item.same ? '相同' : '不同'}`).join('，')}。
              {conditions.some(item => !item.same && item.label !== '组合') ? '条件不一致，差异不能只归因于插件变化。' : ''}
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
    </section>
  )
}
