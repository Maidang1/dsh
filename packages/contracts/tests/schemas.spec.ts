import { describe, expect, it } from 'vitest'
import { ExecutableStageDefinition, RunCommand, RunResponse, Scenario, TraceRecord } from '../src/index.ts'

const record = {
  schemaVersion: 1,
  runId: 'run-1',
  seq: 0,
  logicalTime: 0,
  kind: 'lifecycle',
  name: 'plugin/active',
  sourceRefIds: [],
}

describe('protocol schemas', () => {
  it('accepts a well-formed trace record', () => {
    expect(TraceRecord.parse(record)).toEqual(record)
  })

  it('rejects an unknown schema version', () => {
    expect(TraceRecord.safeParse({ ...record, schemaVersion: 2 }).success).toBe(false)
  })

  it('rejects a missing run id', () => {
    expect(TraceRecord.safeParse({ ...record, runId: '' }).success).toBe(false)
  })

  it('rejects an unknown protocol version and payload type', () => {
    const command = { protocolVersion: 1, commandId: 'c1', runId: null, payload: { type: 'CANCEL' } }
    expect(RunCommand.safeParse(command).success).toBe(true)
    expect(RunCommand.safeParse({ ...command, protocolVersion: 2 }).success).toBe(false)
    expect(RunCommand.safeParse({ ...command, payload: { type: 'EVAL', code: '1+1' } }).success).toBe(false)
  })

  it('rejects trace batches carrying malformed records', () => {
    const response = {
      protocolVersion: 1,
      runId: 'run-1',
      payload: { type: 'TRACE_BATCH', fromSeq: 0, records: [{ ...record, kind: 'animation' }] },
    }
    expect(RunResponse.safeParse(response).success).toBe(false)
  })
})

describe('content schemas', () => {
  it('requires upstream stages to pin a commit', () => {
    const stage = {
      id: 'system-prompt@upstream',
      pluginDefinitionId: 'system-prompt',
      origin: 'upstream',
      module: '@deepseek-ai/dsh-system-prompt',
      sourceHash: 'h',
      requires: [],
      provides: ['systemPrompt'],
      upstreamCommit: null,
    }
    expect(ExecutableStageDefinition.safeParse(stage).success).toBe(false)
  })

  it('rejects duplicate step ids and deterministic scenarios without a script', () => {
    const scenario = {
      id: 's',
      title: 't',
      steps: [
        { kind: 'input', id: 'a', sessionId: 'main', text: 'hi' },
        { kind: 'snapshot', id: 'a', label: 'dup' },
      ],
      modelScriptId: null,
      memoryFiles: {},
      adapterModes: ['deterministic'],
    }
    const result = Scenario.safeParse(scenario)
    expect(result.success).toBe(false)
    expect(result.error?.issues.map(issue => issue.message)).toEqual([
      'duplicate step id "a"',
      'deterministic scenarios need a modelScriptId',
    ])
  })
})
