/**
 * Run-to-run comparison beyond model requests (docs/01 §7): registry,
 * execution process and session records, each read from the recorded trace
 * up to the scenario's end. Nothing here infers what was not recorded.
 */
import { replayAll } from '@harness-explorer/trace/browser'
import type { ViewRegistration } from '@harness-explorer/trace/browser'
import type { JsonValue, TraceRecord } from '@harness-explorer/contracts'
import type { RunData } from './store'

type Trace = Pick<RunData, 'records' | 'payloads'>

/** Index of the run/settle record: what follows is settlement (unloading everything), not the scenario. */
export function settleIndex(records: readonly TraceRecord[]): number {
  return records.findIndex(record => record.name === 'run/settle')
}

/** Records of the scenario itself. */
export function scenarioRecords(data: Trace): readonly TraceRecord[] {
  const settle = settleIndex(data.records)
  return settle < 0 ? data.records : data.records.slice(0, settle)
}

const payload = (data: Trace, record: TraceRecord) => (record.payloadRef ? data.payloads[record.payloadRef] : undefined)
const compact = (value: JsonValue | undefined) => (value === undefined ? '' : ` ${JSON.stringify(value)}`)

export interface RegistryChange {
  registrationId: string
  label: string
  change: 'added' | 'removed' | 'changed'
}

/** Registrations at the end of each scenario: added, removed, or with other details. */
export function registryDiff(a: Trace, b: Trace): RegistryChange[] {
  const at = (data: Trace) => {
    return replayAll(scenarioRecords(data), ref => data.payloads[ref]!).registrations
  }
  const before = at(a)
  const after = at(b)
  const label = (item: ViewRegistration) => `${item.kind} · ${item.name}（作用域 ${item.scopeId}）`
  const changes: RegistryChange[] = []
  for (const [id, item] of Object.entries(before)) {
    if (!after[id]) changes.push({ registrationId: id, label: label(item), change: 'removed' })
    else if (JSON.stringify(after[id]!.detail) !== JSON.stringify(item.detail)) changes.push({ registrationId: id, label: label(item), change: 'changed' })
  }
  for (const [id, item] of Object.entries(after)) {
    if (!before[id]) changes.push({ registrationId: id, label: label(item), change: 'added' })
  }
  return changes
}

/**
 * The execution process as text lines: lifecycle transitions, dispatches,
 * checkpoints and diagnostics, labelled by scenario step. Sequence numbers
 * are left out so two runs line up by content.
 */
export function processLines(data: Trace): string[] {
  return scenarioRecords(data).flatMap(record => {
    const step = `[${record.scenarioStepId ?? '初始'}]`
    const value = payload(data, record)
    switch (record.kind) {
      case 'lifecycle':
        return [`${step} ${record.instanceId} → ${String((value as { phase?: unknown } | undefined)?.phase ?? null)}`]
      case 'dispatch':
        return [`${step} ${record.name} ${record.instanceId ?? ''}`.trimEnd()]
      case 'checkpoint':
        return [`${step} ${record.name}${compact(value)}`]
      case 'diagnostic':
        return [`${step} 诊断${compact(value)}`]
      default:
        return []
    }
  })
}

/** Durable session events, one line each, grouped by session in recorded order. */
export function sessionLines(data: Trace): string[] {
  return scenarioRecords(data)
    .filter(record => record.name === 'session/event')
    .map(record => {
      const event = payload(data, record) as { sessionId: string; type: string; data: JsonValue } | undefined
      return event ? `${event.sessionId} · ${event.type}${compact(event.data)}` : ''
    })
    .filter(Boolean)
}
