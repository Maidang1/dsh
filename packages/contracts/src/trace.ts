/**
 * Trace records, run manifests and the Node protocol envelope.
 * See docs/02-technical-architecture.md §9 and §10.
 */
import { z } from 'zod'
import { AdapterMode, RuntimeError, RuntimeState } from './domain.ts'

const Id = z.string().min(1)

export const TraceKind = z.enum(['lifecycle', 'service', 'dispatch', 'session', 'checkpoint', 'data', 'diagnostic'])
export type TraceKind = z.infer<typeof TraceKind>

export const TraceRecord = z.object({
  schemaVersion: z.literal(1),
  runId: Id,
  seq: z.number().int().nonnegative(),
  logicalTime: z.number().nonnegative(),
  kind: TraceKind,
  name: z.string().min(1),
  instanceId: Id.optional(),
  scopeId: Id.optional(),
  scenarioStepId: Id.optional(),
  spanId: Id.optional(),
  parentSpanId: Id.optional(),
  causeSeq: z.number().int().nonnegative().optional(),
  sessionId: Id.optional(),
  turnId: Id.optional(),
  stepId: Id.optional(),
  sourceRefIds: z.array(Id),
  beforeRef: Id.optional(),
  afterRef: Id.optional(),
  payloadRef: Id.optional(),
})
export type TraceRecord = z.infer<typeof TraceRecord>

export const RunOutcome = z.enum(['running', 'completed', 'failed', 'cancelled', 'terminated', 'interrupted'])
export type RunOutcome = z.infer<typeof RunOutcome>

export const RunManifest = z.object({
  runId: Id,
  experimentRevisionId: Id,
  revisionHash: Id,
  loadedSourceHashes: z.record(Id, Id),
  environmentSnapshotRef: Id,
  adapterMode: AdapterMode,
  mode: z.enum(['teaching', 'upstream-reference']),
  startedAt: z.iso.datetime(),
  outcome: RunOutcome,
  lastSeq: z.number().int().min(-1),
  completeness: z.enum(['complete', 'truncated']),
})
export type RunManifest = z.infer<typeof RunManifest>

export const PROTOCOL_VERSION = 1

export const RunCommand = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  commandId: Id,
  runId: Id.nullable(),
  payload: z.discriminatedUnion('type', [
    z.object({ type: z.literal('RUN'), revisionId: Id, adapterMode: AdapterMode }),
    z.object({ type: z.literal('CANCEL') }),
  ]),
})
export type RunCommand = z.infer<typeof RunCommand>

export const RunResponse = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  runId: Id.nullable(),
  payload: z.discriminatedUnion('type', [
    z.object({ type: z.literal('ACK'), commandId: Id }),
    z.object({ type: z.literal('TRACE_BATCH'), fromSeq: z.number().int().nonnegative(), records: z.array(TraceRecord) }),
    z.object({ type: z.literal('SNAPSHOT'), state: RuntimeState }),
    z.object({ type: z.literal('RUN_SETTLED'), finalSeq: z.number().int().min(-1), outcome: RunOutcome }),
    z.object({ type: z.literal('ERROR'), code: z.enum(['busy', 'invalid', 'not-found', 'internal']), error: RuntimeError }),
  ]),
})
export type RunResponse = z.infer<typeof RunResponse>
