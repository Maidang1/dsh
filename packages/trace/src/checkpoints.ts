/** Teaching checkpoints as lessons read them, shared by lessons:verify and the explorer. */
import { TraceName } from '@harness-explorer/contracts'
import type { TraceRecord } from '@harness-explorer/contracts'

const PREFIX = 'checkpoint/'

/** Records before run/settle: the scenario itself, not the settlement that unloads everything. */
export function scenarioPart(records: readonly TraceRecord[]): readonly TraceRecord[] {
  const settle = records.findIndex(record => record.name === TraceName.runSettle)
  return settle < 0 ? records : records.slice(0, settle)
}

/**
 * The checkpoints one plugin recorded during the scenario, in order, without
 * the "checkpoint/" prefix. Each plugin names its own "<plugin>:<name>".
 */
export function recordedCheckpoints(records: readonly TraceRecord[], pluginDefinitionId: string): string[] {
  return scenarioPart(records)
    .filter(record => record.kind === 'checkpoint' && record.name.startsWith(`${PREFIX}${pluginDefinitionId}:`))
    .map(record => record.name.slice(PREFIX.length))
}
