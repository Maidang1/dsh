/** Messages between the control service and a run subprocess (one subprocess per run). */
import { AdapterMode, Composition, ExecutableStageDefinition, JsonValue, ModelScript, Scenario, TraceRecord } from '@harness-explorer/contracts'
import { z } from 'zod'

export const StartMessage = z.object({
  type: z.literal('START'),
  runId: z.string().min(1),
  composition: Composition,
  scenario: Scenario,
  modelScripts: z.record(z.string(), ModelScript),
  stages: z.array(ExecutableStageDefinition),
  adapterMode: AdapterMode,
  limits: z.object({ maxRecords: z.number().int().positive(), maxPayloadBytes: z.number().int().positive() }),
})
export type StartMessage = z.infer<typeof StartMessage>

export const ParentMessage = z.discriminatedUnion('type', [
  StartMessage,
  z.object({ type: z.literal('CANCEL') }),
])
export type ParentMessage = z.infer<typeof ParentMessage>

export const ChildMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('READY'), runId: z.string().min(1) }),
  z.object({
    type: z.literal('TRACE_BATCH'),
    runId: z.string().min(1),
    records: z.array(TraceRecord),
    payloads: z.array(z.tuple([z.string(), JsonValue])),
  }),
  z.object({
    type: z.literal('SETTLED'),
    runId: z.string().min(1),
    outcome: z.enum(['completed', 'failed', 'cancelled']),
    error: z.object({ name: z.string(), message: z.string() }).nullable(),
    lastSeq: z.number().int().min(-1),
    truncated: z.boolean(),
  }),
])
export type ChildMessage = z.infer<typeof ChildMessage>
