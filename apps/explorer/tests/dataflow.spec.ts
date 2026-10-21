/**
 * Data-flow layer (docs/design/explorer-redesign.md §2.3–2.4): layers from the
 * catalog or dependency depth, and the request window/edges/badges derived only
 * from records that exist in the trace.
 */
import { describe, expect, it } from 'vitest'
import { replayAll } from '@harness-explorer/trace/browser'
import type { JsonValue, TraceRecord } from '@harness-explorer/contracts'
import { assignLayers, computeRequestFlow, diffSystemParagraphs, fallbackLayer, flowStepsByInstance, serviceProviders, summarizeRecord } from '../src/lib/dataflow'
import type { PublicStage } from '../src/lib/api'
import type { RunData } from '../src/lib/store'

const stage = (id: string, requires: string[], provides: string[]): PublicStage => ({
  id,
  pluginDefinitionId: id.split('@')[0]!,
  origin: 'teaching',
  sourceHash: 'dev',
  requires,
  provides,
  upstreamCommit: null,
})

describe('layers', () => {
  const stages = [
    stage('session@main', [], ['sessions']),
    stage('system-prompt@main', [], ['systemPrompt']),
    stage('llm@main', [], ['llm']),
    stage('tools@main', ['systemPrompt'], ['tools']),
    stage('agent-loop@main', ['sessions', 'llm', 'tools', 'systemPrompt'], ['agentLoop']),
  ]

  it('falls back to dependency depth: no requires is L1, deepest provider + 1 otherwise', () => {
    expect(fallbackLayer(stage('a@main', [], ['a']), stages)).toBe(1)
    expect(fallbackLayer(stage('tools@main', ['systemPrompt'], ['tools']), stages)).toBe(2)
    expect(fallbackLayer(stage('deep@main', ['tools'], []), stages)).toBe(3)
    expect(fallbackLayer(stage('agent-loop@main', ['sessions', 'llm', 'tools', 'systemPrompt'], []), stages)).toBe(3)
  })

  it('clamps the fallback to L4 and survives cycles', () => {
    const cyclic = [stage('x@main', ['y'], ['x']), stage('y@main', ['x'], ['y'])]
    // A cycle contributes no depth; what matters is that it terminates with a sane layer.
    for (const cyclicStage of cyclic) {
      const layer = fallbackLayer(cyclicStage, cyclic)
      expect(layer).toBeGreaterThanOrEqual(1)
      expect(layer).toBeLessThanOrEqual(4)
    }
    let requires: string[] = []
    let chain: PublicStage[] = []
    for (let depth = 1; depth <= 6; depth++) {
      chain = [...chain, stage(`c${depth}@main`, requires, [`s${depth}`])]
      requires = [`s${depth}`]
    }
    expect(fallbackLayer(chain.at(-1)!, chain)).toBe(4)
  })

  it('prefers the declared catalog layer over the depth fallback', () => {
    const instances = [
      { id: 'agent-loop', definitionId: 'agent-loop', stageId: 'agent-loop@main', scopeId: 'root', parentId: null, enabled: true, config: {} },
      { id: 'custom', definitionId: 'custom', stageId: 'tools@main', scopeId: 'root', parentId: null, enabled: true, config: {} },
    ]
    const assigned = assignLayers(instances, stages, { 'agent-loop': 4 })
    expect(assigned.get('agent-loop')).toBe(4)
    expect(assigned.get('custom')).toBe(2)
  })
})

/** A trace shaped like a real prompt-section-lifecycle run (see apps/local-server). */
function makeTrace() {
  const payloads: Record<string, JsonValue> = {}
  let seq = 0
  const rec = (kind: TraceRecord['kind'], name: string, extra: Partial<TraceRecord> & { payload?: JsonValue } = {}): TraceRecord => {
    const { payload, ...rest } = extra
    const record: TraceRecord = { schemaVersion: 1, runId: 'run-test', seq, logicalTime: seq, kind, name, sourceRefIds: [], ...rest }
    if (payload !== undefined) {
      record.payloadRef = `p${seq}`
      payloads[record.payloadRef] = payload
    }
    seq++
    return record
  }
  const step = (payload: JsonValue, scenarioStepId: string) => rec('checkpoint', 'scenario/step', { payload, scenarioStepId })
  const records: TraceRecord[] = [
    rec('lifecycle', 'plugin/phase', { instanceId: 'session', payload: { phase: 'active', dependencyStatus: 'resolved', reason: null, error: null } }),
    rec('data', 'registration/add', { instanceId: 'system-prompt', payload: { registrationId: 'prompt-section:root:deployment:persona', kind: 'prompt-section', name: 'deployment:persona', scopeId: 'root', detail: { order: 0, text: '你是一个助手' } } }),
    step({ kind: 'input', id: 'baseline', sessionId: 's-a', text: '你好' }, 'baseline'),
    rec('checkpoint', 'checkpoint/agent-loop:request-prepared', { scenarioStepId: 'baseline', payload: { requestId: 'request-1' } }),
    rec('data', 'model/request', { instanceId: 'agent-loop', scenarioStepId: 'baseline', payload: { requestId: 'request-1', system: '你是一个助手', messages: [{ role: 'user', content: '你好' }], tools: [] } }),
    rec('data', 'model/response', { instanceId: 'agent-loop', scenarioStepId: 'baseline', payload: { requestId: 'request-1', text: '你好！', toolCalls: [] } }),
    step({ kind: 'mount', id: 'mount', instanceId: 'prompt-contributor' }, 'mount'),
    rec('data', 'registration/add', { instanceId: 'prompt-contributor', scenarioStepId: 'mount', payload: { registrationId: 'prompt-section:root:lesson:style', kind: 'prompt-section', name: 'lesson:style', scopeId: 'root', detail: { order: 100, text: '回答时使用短句' } } }),
    step({ kind: 'input', id: 'with-section', sessionId: 's-b', text: '你好' }, 'with-section'),
    rec('checkpoint', 'checkpoint/agent-loop:request-prepared', { scenarioStepId: 'with-section', payload: { requestId: 'request-2' } }),
    rec('data', 'model/request', { instanceId: 'agent-loop', scenarioStepId: 'with-section', payload: { requestId: 'request-2', system: '你是一个助手\n\n回答时使用短句', messages: [{ role: 'user', content: '你好' }], tools: [] } }),
    rec('data', 'model/response', { instanceId: 'agent-loop', scenarioStepId: 'with-section', payload: { requestId: 'request-2', text: '你好！', toolCalls: [] } }),
    rec('session', 'session/event', { scenarioStepId: 'with-section', payload: { sessionId: 's-b', type: 'turn/end', data: {} } }),
    rec('checkpoint', 'run/settle', { payload: { outcome: 'completed' } }),
  ]
  const data: RunData = { runId: 'run-test', records, payloads, gaps: [], settled: null, revision: null, loadedSourceHashes: null }
  return data
}

const INSTANCES = ['session', 'system-prompt', 'tools', 'llm', 'llm-scripted', 'agent-loop', 'prompt-contributor']
  .map(id => ({ id, definitionId: id }))
const PROVIDERS = { sessions: 'session', systemPrompt: 'system-prompt', tools: 'tools', llm: 'llm', agentLoop: 'agent-loop' }

function flowAt(data: RunData, seq: number) {
  const snapshot = replayAll(data.records.slice(0, seq + 1), ref => data.payloads[ref]!)
  return computeRequestFlow(data, seq, snapshot, PROVIDERS, INSTANCES)
}

describe('request flow', () => {
  it('is null without records', () => {
    const empty: RunData = { runId: 'r', records: [], payloads: {}, gaps: [], settled: null, revision: null, loadedSourceHashes: null }
    expect(computeRequestFlow(empty, -1, replayAll([], () => ({})), PROVIDERS, INSTANCES)).toBeNull()
  })

  it('numbers the window from the previous input step to the next scenario step', () => {
    const flow = flowAt(makeTrace(), 10)!
    expect(flow.title).toBe('请求 #2')
    expect(flow.subtitle).toBe('挂载 prompt-contributor 之后的第 2 次请求')
    expect(flow.steps.map(step => step.seq)).toEqual([8, 9, 10, 11, 12])
    expect(flow.steps.find(step => step.seq === 10)?.state).toBe('current')
    expect(flow.steps.find(step => step.seq === 12)?.state).toBe('upcoming')
    expect(flow.steps.find(step => step.seq === 8)?.summary).toBe('接收用户输入「你好」')
    expect(flow.inputText).toBe('你好')
  })

  it('shows the initial mount window before the first input', () => {
    const flow = flowAt(makeTrace(), 1)!
    expect(flow.title).toBe('初始挂载')
    expect(flow.steps.map(step => step.seq)).toEqual([0, 1])
    expect(flow.edges).toEqual([])
  })

  it('draws registration edges only for registrations effective at the cursor', () => {
    const atTen = flowAt(makeTrace(), 10)!
    const registration = atTen.edges.find(edge => edge.id.includes('lesson:style'))
    // Registered during the mount step, which precedes this window's input: flown, no window step number.
    expect(registration).toMatchObject({ source: 'prompt-contributor', target: 'system-prompt', label: 'registration · lesson:style', state: 'flown', step: null })
    // The persona section is provided by system-prompt itself: no self-edge.
    expect(atTen.edges.find(edge => edge.id.includes('persona'))).toBeUndefined()
    const beforeMount = flowAt(makeTrace(), 5)!
    expect(beforeMount.edges.some(edge => edge.id.includes('lesson:style'))).toBe(false)
  })

  it('draws the request edge initiator → llm with the packet only while the call is current', () => {
    const flow = flowAt(makeTrace(), 10)!
    const request = flow.edges.find(edge => edge.label === 'llm/request')
    expect(request).toMatchObject({ source: 'agent-loop', target: 'llm', state: 'current', packet: true, step: 3 })
    const afterResponse = flowAt(makeTrace(), 11)!
    expect(afterResponse.edges.find(edge => edge.label === 'llm/request')).toMatchObject({ state: 'flown', packet: false })
    const beforeRequest = flowAt(makeTrace(), 9)!
    expect(beforeRequest.edges.find(edge => edge.label === 'llm/request')).toMatchObject({ state: 'pending', packet: false })
  })

  it('highlights the llm node when the request record has no instanceId', () => {
    const data = makeTrace()
    const request = data.records.find(record => record.name === 'model/request' && record.scenarioStepId === 'with-section')!
    data.records = data.records.map(record => (record.seq === request.seq ? { ...record, instanceId: undefined } : record))
    const flow = flowAt(data, request.seq)!
    expect(flow.edges.some(edge => edge.label === 'llm/request')).toBe(false)
    expect(flow.highlighted).toEqual(['llm'])
  })

  it('puts input, checkpoint and session labels next to their nodes, capped at the cursor', () => {
    const flow = flowAt(makeTrace(), 10)!
    expect(flow.badges).toEqual([
      expect.objectContaining({ instanceId: 'agent-loop', label: 'input「你好」', step: 1 }),
      expect.objectContaining({ instanceId: 'agent-loop', label: 'request-prepared', step: 2 }),
    ])
    const atEnd = flowAt(makeTrace(), 12)!
    expect(atEnd.badges).toContainEqual(expect.objectContaining({ instanceId: 'session', label: 'session/event', step: 5 }))
  })

  it('marks everything flown once the window has passed', () => {
    const flow = flowAt(makeTrace(), 13)!
    // seq 13 is run/settle: the cursor sits past the window, so the second request's edge has flown.
    expect(flow.edges.find(edge => edge.label === 'llm/request')).toMatchObject({ state: 'flown', packet: false })
  })

  it('pairs every model request with its response as its own edge, packet only on the edge at the cursor', () => {
    const payloads: Record<string, JsonValue> = {}
    let seq = 0
    const rec = (kind: TraceRecord['kind'], name: string, extra: Partial<TraceRecord> & { payload?: JsonValue } = {}): TraceRecord => {
      const { payload, ...rest } = extra
      const record: TraceRecord = { schemaVersion: 1, runId: 'run-tools', seq, logicalTime: seq, kind, name, sourceRefIds: [], ...rest }
      if (payload !== undefined) {
        record.payloadRef = `p${seq}`
        payloads[record.payloadRef] = payload
      }
      seq++
      return record
    }
    // A tool-call window: the loop asks the model twice inside one request window.
    const records: TraceRecord[] = [
      rec('checkpoint', 'scenario/step', { payload: { kind: 'input', id: 'calc', sessionId: 's-a', text: '1+1?' }, scenarioStepId: 'calc' }),
      rec('data', 'model/request', { instanceId: 'agent-loop', scenarioStepId: 'calc', payload: { requestId: 'request-1', system: '', messages: [], tools: [] } }),
      rec('data', 'model/response', { instanceId: 'agent-loop', scenarioStepId: 'calc', payload: { requestId: 'request-1', text: '', toolCalls: [{ id: 'c1', name: 'calculator', arguments: {} }] } }),
      rec('data', 'model/request', { instanceId: 'agent-loop', scenarioStepId: 'calc', payload: { requestId: 'request-2', system: '', messages: [], tools: [] } }),
      rec('data', 'model/response', { instanceId: 'agent-loop', scenarioStepId: 'calc', payload: { requestId: 'request-2', text: '2', toolCalls: [] } }),
      rec('checkpoint', 'run/settle', { payload: { outcome: 'completed' } }),
    ]
    const data: RunData = { runId: 'run-tools', records, payloads, gaps: [], settled: null, revision: null, loadedSourceHashes: null }
    // Cursor on the second request: pair 1 has flown, request 2 is current, response 2 pending.
    const flow = flowAt(data, 3)!
    const requests = flow.edges.filter(edge => edge.label === 'llm/request')
    const responses = flow.edges.filter(edge => edge.label === 'model/response')
    expect(requests).toHaveLength(2)
    expect(responses).toHaveLength(2)
    expect(requests[0]).toMatchObject({ source: 'agent-loop', target: 'llm', step: 2, state: 'flown', packet: false })
    expect(responses[0]).toMatchObject({ source: 'llm', target: 'agent-loop', step: 3, state: 'flown', packet: false })
    expect(requests[1]).toMatchObject({ step: 4, state: 'current', packet: true })
    expect(responses[1]).toMatchObject({ step: 5, state: 'pending', packet: false })
    // Cursor on the first response: only that edge carries the packet.
    const atFirstResponse = flowAt(data, 2)!
    expect(atFirstResponse.edges.filter(edge => edge.packet)).toEqual([
      expect.objectContaining({ label: 'model/response', step: 3, state: 'current' }),
    ])
    // Cursor on the second response: only that edge carries the packet, the rest has flown.
    const atSecondResponse = flowAt(data, 4)!
    expect(atSecondResponse.edges.filter(edge => edge.packet)).toEqual([
      expect.objectContaining({ id: 'flow:res:4', state: 'current' }),
    ])
  })

  it('resolves checkpoint badges by instanceId first, then by definition id through the composition', () => {
    const data = makeTrace()
    // The with-section checkpoint without an instanceId; the prefix is a definition id.
    const records = data.records.map(record =>
      record.name === 'checkpoint/agent-loop:request-prepared' && record.scenarioStepId === 'with-section'
        ? { ...record, instanceId: undefined }
        : record)
    const withoutIds: RunData = { ...data, records }
    const at = (seq: number, instances: typeof INSTANCES) =>
      computeRequestFlow(withoutIds, seq, replayAll(withoutIds.records.slice(0, seq + 1), ref => withoutIds.payloads[ref]!), PROVIDERS, instances)!
    // The prefix happens to also be an instance id here.
    expect(at(10, INSTANCES).badges).toContainEqual(expect.objectContaining({ instanceId: 'agent-loop', label: 'request-prepared', step: 2 }))
    // A scoped instance whose id differs from its definition: the prefix maps through the composition.
    const scopedInstances = INSTANCES.map(item => (item.id === 'agent-loop' ? { id: 'main-loop', definitionId: 'agent-loop' } : item))
    expect(at(10, scopedInstances).badges).toContainEqual(expect.objectContaining({ instanceId: 'main-loop', label: 'request-prepared', step: 2 }))
    // An explicit instanceId wins over the name prefix, even when they disagree.
    const explicit: RunData = {
      ...data,
      records: data.records.map(record =>
        record.name === 'checkpoint/agent-loop:request-prepared' && record.scenarioStepId === 'with-section'
          ? { ...record, instanceId: 'tools' }
          : record),
    }
    const flow = computeRequestFlow(explicit, 10, replayAll(explicit.records.slice(0, 11), ref => explicit.payloads[ref]!), PROVIDERS, INSTANCES)!
    expect(flow.badges).toContainEqual(expect.objectContaining({ instanceId: 'tools', label: 'request-prepared' }))
    expect(flow.badges.some(badge => badge.instanceId === 'agent-loop' && badge.label === 'request-prepared')).toBe(false)
    // A checkpoint whose definition has no instance in the composition yields no badge.
    const noLoop = INSTANCES.filter(item => item.definitionId !== 'agent-loop')
    expect(at(10, noLoop).badges.some(badge => badge.label === 'request-prepared')).toBe(false)
  })

  it('merges window session events into one badge on the session node with a count', () => {
    const data = makeTrace()
    const extra: TraceRecord = { schemaVersion: 1, runId: 'run-test', seq: 0, logicalTime: 0, kind: 'session', name: 'session/event', sourceRefIds: [], scenarioStepId: 'with-section', payloadRef: 'extra' }
    const payloads = { ...data.payloads, extra: { sessionId: 's-b', type: 'step/start', data: {} } }
    // Two session events inside the second window.
    const records = [...data.records.slice(0, 12), extra, ...data.records.slice(12)].map((record, index) => ({ ...record, seq: index, logicalTime: index }))
    const merged: RunData = { ...data, records, payloads }
    const flow = flowAt(merged, 13)!
    const sessionBadges = flow.badges.filter(badge => badge.instanceId === 'session')
    expect(sessionBadges).toHaveLength(1)
    expect(sessionBadges[0]).toMatchObject({ label: 'session/event', count: 2, step: 6 })
    // Events after the cursor are not counted.
    const earlier = flowAt(merged, 10)!
    expect(earlier.badges.some(badge => badge.instanceId === 'session')).toBe(false)
  })
})

describe('flow steps by instance (narrow list badges, §4)', () => {
  it('collects the window steps that touched each instance, capped at the cursor', () => {
    // Window at seq 10: 1 input, 2 checkpoint (both badge agent-loop),
    // 3 llm/request agent-loop → llm (current), 4 model/response (pending),
    // 5 session/event (past the cursor: no badge at all).
    const steps = flowStepsByInstance(flowAt(makeTrace(), 10))
    expect(steps.get('agent-loop')).toEqual([1, 2, 3])
    expect(steps.get('llm')).toEqual([3])
    expect(steps.get('session')).toBeUndefined()
    // Past the response: both ends of both edges have flown.
    const later = flowStepsByInstance(flowAt(makeTrace(), 12))
    expect(later.get('llm')).toEqual([3, 4])
    expect(later.get('session')).toEqual([5])
  })

  it('is empty without a flow', () => {
    expect(flowStepsByInstance(null).size).toBe(0)
  })
})

describe('system paragraph comparison', () => {
  it('marks paragraphs new against the previous request and names the contributing instance', () => {
    const data = makeTrace()
    const requestSeq = 10
    const request = data.payloads[data.records[requestSeq]!.payloadRef!] as { requestId: string }
    expect(request.requestId).toBe('request-2')
    const paragraphs = diffSystemParagraphs(data, requestSeq, request as never)
    expect(paragraphs).toEqual([
      { text: '你是一个助手', added: false, source: { instanceId: 'system-prompt', registrationName: 'deployment:persona' } },
      { text: '回答时使用短句', added: true, source: { instanceId: 'prompt-contributor', registrationName: 'lesson:style' } },
    ])
  })
})

describe('record summaries', () => {
  it('summarizes scenario steps and checkpoints in one line', () => {
    const data = makeTrace()
    expect(summarizeRecord(data.records[2]!, data.payloads)).toBe('接收用户输入「你好」')
    expect(summarizeRecord(data.records[6]!, data.payloads)).toBe('挂载 prompt-contributor')
    expect(summarizeRecord(data.records[9]!, data.payloads)).toBe('agent-loop:request-prepared · 请求已组装')
    expect(summarizeRecord(data.records[10]!, data.payloads)).toBe('发送模型请求')
    expect(summarizeRecord(data.records[12]!, data.payloads)).toBe('写入会话记录（turn/end）')
  })
})

describe('service providers', () => {
  it('maps each service to the first instance that provides it', () => {
    const instances = [
      { id: 'llm', definitionId: 'llm', stageId: 'llm@main', scopeId: 'root', parentId: null, enabled: true, config: {} },
      { id: 'llm-2', definitionId: 'llm', stageId: 'llm@main', scopeId: 'root', parentId: null, enabled: true, config: {} },
    ]
    expect(serviceProviders(instances, [stage('llm@main', [], ['llm'])])).toEqual({ llm: 'llm' })
  })
})
