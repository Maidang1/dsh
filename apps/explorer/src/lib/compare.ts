/**
 * Run-to-run comparison beyond model requests (docs/01 §7): registry,
 * execution process and session records, each read from the recorded trace
 * up to the scenario's end. Nothing here infers what was not recorded.
 */
import { replayAll, scenarioPart } from '@harness-explorer/trace/browser'
import type { ViewRegistration } from '@harness-explorer/trace/browser'
import type { JsonValue, TraceRecord } from '@harness-explorer/contracts'
import type { RunData } from './store'

type Trace = Pick<RunData, 'records' | 'payloads'>

/** Records of the scenario itself; settlement (unloading everything) is left out. */
export const scenarioRecords = (data: Trace): readonly TraceRecord[] => scenarioPart(data.records)

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

/**
 * Durable session events, one line each, grouped by session in recorded order.
 * Upstream stamps assistant stream records with the wall clock (`time` on raw
 * chunks, `time0`/`dt` on packed runs — `AssistantStreamRecord` in dsh-llm),
 * so two runs of the same conversation still differ there; those fields are
 * left out and the lines compare stream content only.
 */
export function sessionLines(data: Trace): string[] {
  return scenarioRecords(data)
    .filter(record => record.name === 'session/event')
    .map(record => {
      const event = payload(data, record) as { sessionId: string; type: string; data: JsonValue } | undefined
      return event ? `${event.sessionId} · ${event.type}${compact(withoutStreamTimes(event.data))}` : ''
    })
    .filter(Boolean)
}

/** Event data without the assistant stream's wall-clock stamps; other events pass through unchanged. */
function withoutStreamTimes(data: JsonValue): JsonValue {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data
  const { stream, ...rest } = data as { stream?: JsonValue } & Record<string, JsonValue>
  if (!Array.isArray(stream)) return data
  return {
    ...rest,
    stream: stream.map(record =>
      record !== null && typeof record === 'object' && !Array.isArray(record)
        ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'time' && key !== 'time0' && key !== 'dt'))
        : record),
  }
}
