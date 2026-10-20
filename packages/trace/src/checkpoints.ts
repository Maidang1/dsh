/** Teaching checkpoints as lessons read them, shared by lessons:verify and the explorer. */
import { TraceName } from '@harness-explorer/contracts'
import type { TraceRecord } from '@harness-explorer/contracts'

const PREFIX = 'checkpoint/'

/** Index of the run/settle record, or -1: what follows is settlement (unloading everything), not the scenario. */
export function settleIndex(records: readonly TraceRecord[]): number {
  return records.findIndex(record => record.name === TraceName.runSettle)
}

/** Records before run/settle: the scenario itself. */
export function scenarioPart(records: readonly TraceRecord[]): readonly TraceRecord[] {
  const settle = settleIndex(records)
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
