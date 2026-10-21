/**
 * TURN-01..03, TOOL-01, TOOL-02, LIFE-02 and repeatability, run on the
 * upstream agent loop (`@deepseek-ai/dsh-agent-loop`). Session event types
 * are upstream's own, including the inbox splices and request records.
 */
import type { Context } from '@deepseek-ai/cordis'
import { TraceName } from '@harness-explorer/contracts'
import { describe, expect, it } from 'vitest'
import { calculatorScript, inlineStage, lifecycleScenario, minimalChat, payloadOf, requestsOf, run, scenario, sessionEvents, sessionTypes, toolChat, withInline } from './helpers.ts'

/** Upstream opens every turn by moving the queued input out of the inbox. */
const OPEN = ['agent/inbox/spliced', 'turn/start', 'agent/inbox/spliced']
const REQUEST = ['system/message', 'user/message', 'request/header', 'request/context']

describe('TURN-03: plain text response', async () => {
  const result = await run({ scenario: scenario([{ kind: 'input', id: 'ask', sessionId: 's', text: '你好' }]) })

  it('commits durable events in upstream order', () => {
    expect(sessionTypes(result, 's')).toEqual([...OPEN, 'step/start', ...REQUEST, 'assistant/message', 'step/end', 'turn/end'])
  })

  it('settles the streamed chunks into one assistant message and completes the turn', () => {
    const events = sessionEvents(result, 's')
    const assistant = events.find(event => event.type === 'assistant/message')?.data as { message: { role: string; content: unknown } }
    expect(assistant.message.role).toBe('assistant')
    expect(assistant.message.content).toEqual([{ type: 'text', text: '你好！有什么可以帮你？' }])
    expect(events.at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })

  it('records the model response the stream settled into', () => {
    const response = result.recorder.records.find(record => record.name === TraceName.modelResponse)!
    expect(payloadOf(result, response)).toEqual({ requestId: 'request-1', text: '你好！有什么可以帮你？', toolCalls: [], finish: { kind: 'stop' }, error: null })
  })

  it('is repeatable: the same scenario yields an identical trace', async () => {
    const again = await run({ scenario: scenario([{ kind: 'input', id: 'ask', sessionId: 's', text: '你好' }]) })
    expect(again.recorder.records).toEqual(result.recorder.records)
  })
})

describe('TURN-01: a turn may close without a step', () => {
  it('closes the turn as blocked when agent/pre-step rejects, without committing the user message', async () => {
    const blocker = inlineStage('blocker', [], {
      name: 'blocker',
      apply(ctx: Context) {
        ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' as const }))
      },
    })
    const result = await run({
      ...withInline(minimalChat(), blocker),
      scenario: scenario([{ kind: 'input', id: 'ask', sessionId: 's', text: '你好' }]),
    })
    expect(result.error).toBeNull()
    const events = sessionEvents(result, 's')
    expect(events.map(event => event.type)).toEqual([...OPEN, 'turn/end'])
    expect(events.at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'blocked' } })
    expect(requestsOf(result, 'ask')).toEqual([])
  })

  it('sends blank input to the model like any other input', async () => {
    // The teaching subset used to skip the model call here; upstream does not.
    const result = await run({ scenario: scenario([{ kind: 'input', id: 'blank', sessionId: 's', text: '  ' }]) })
    expect(requestsOf(result, 'blank').map(request => request.messages.at(-1)?.content)).toEqual(['  '])
  })
})

describe('TOOL-01: tool call round trip', async () => {
  const composition = toolChat()
  composition.instances = composition.instances.filter(instance => instance.id !== 'tool-guard')
  const result = await run({
    composition,
    modelScripts: { calculator: calculatorScript() },
    scenario: scenario([{ kind: 'input', id: 'ask', sessionId: 's', text: '1+2' }], 'calculator'),
  })

  it('declares the tool, executes the call and feeds the result into the next request', () => {
    expect(result.error).toBeNull()
    const requests = requestsOf(result, 'ask')
    expect(requests).toHaveLength(2)
    expect(requests[0]!.tools.map(tool => tool.name)).toEqual(['add'])
    expect(requests[1]!.messages.at(-1)).toEqual({ role: 'tool', content: '3', toolCallId: 'call-1' })
  })

  it('records two steps with tool/call and tool/result inside the first', () => {
    expect(sessionTypes(result, 's')).toEqual([
      ...OPEN,
      'step/start', ...REQUEST, 'assistant/message', 'tool/call', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'step/end',
      'turn/end',
    ])
  })
})

describe('TOOL-02: a model calling an undeclared tool', () => {
  it('fails the scenario and ends the turn with an error instead of pretending the call happened', async () => {
    const script = calculatorScript()
    script.rules.push({ id: 'call-unknown', match: { lastUserText: 'boom' }, respond: { kind: 'tool-call', tool: 'subtract', arguments: {} } })
    const result = await run({
      composition: toolChat(),
      modelScripts: { calculator: script },
      scenario: scenario([{ kind: 'input', id: 'ask', sessionId: 's', text: 'boom' }], 'calculator'),
    })
    expect(result.outcome).toBe('failed')
    expect(result.error?.name).toBe('TurnError')
    expect(result.error?.message).toMatch(/calls tool "subtract", which the request does not declare/)
    const events = sessionEvents(result, 's')
    expect(events.some(event => event.type === 'tool/call')).toBe(false)
    expect(events.at(-1)?.data).toMatchObject({ reason: { kind: 'error' } })
  })
})

describe('TURN-02: cancelling after the request is prepared', () => {
  it('sends no request, commits no assistant message, and lets the scenario continue', async () => {
    const result = await run({
      scenario: scenario([
        { kind: 'cancel', id: 'arm', afterCheckpoint: 'request/context' },
        { kind: 'input', id: 'ask', sessionId: 's', text: '你好' },
        { kind: 'input', id: 'again', sessionId: 's2', text: '你好' },
      ]),
    })
    expect(result.error).toBeNull()
    expect(result.outcome).toBe('completed')
    const events = sessionEvents(result, 's')
    expect(events.map(event => event.type)).toEqual([...OPEN, 'step/start', ...REQUEST, 'step/end', 'turn/end'])
    expect(events.at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(requestsOf(result, 'ask')).toEqual([])
    expect(sessionEvents(result, 's2').at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })

  it('fails the run when the armed checkpoint is never reached', async () => {
    const result = await run({
      scenario: scenario([
        { kind: 'cancel', id: 'arm', afterCheckpoint: 'no/such-event' },
        { kind: 'input', id: 'ask', sessionId: 's', text: '你好' },
      ]),
    })
    expect(result.outcome).toBe('failed')
    expect(result.error?.message).toMatch(/was never reached/)
  })
})

describe('LIFE-02: a failing cleanup is never reported as success', () => {
  const leaky = inlineStage('leaky', [], {
    name: 'leaky',
    apply(ctx: Context) {
      ctx.effect(() => () => { throw new Error('disposer exploded') })
    },
  })

  it('fails an unmount step and records which instance failed', async () => {
    const result = await run({
      ...withInline(minimalChat(), leaky),
      scenario: scenario([{ kind: 'unmount', id: 'drop', instanceId: 'leaky' }]),
    })
    expect(result.outcome).toBe('failed')
    expect(result.error).toEqual({ name: 'CleanupError', message: 'cleanup of "leaky" failed: Error: disposer exploded' })
    const diagnostics = result.recorder.records.filter(record => record.name === TraceName.diagnostic && record.instanceId === 'leaky')
    expect(diagnostics).toHaveLength(1)
  })

  it('fails settlement but still unloads every other instance', async () => {
    const result = await run({
      ...withInline(minimalChat(), leaky),
      scenario: scenario([{ kind: 'snapshot', id: 'look', label: 'look' }]),
    })
    expect(result.outcome).toBe('failed')
    expect(result.error?.name).toBe('CleanupError')
    const lastPhases = new Map<string, unknown>()
    for (const record of result.recorder.records.filter(item => item.name === TraceName.pluginPhase)) {
      lastPhases.set(record.instanceId!, payloadOf<{ phase: unknown }>(result, record).phase)
    }
    expect([...lastPhases.values()].every(phase => phase === null)).toBe(true)
  })
})

describe('plugin tree lifecycle in scenarios', () => {
  const parent = inlineStage('parent', [], { name: 'parent', apply() {} })
  const child = inlineStage('child', [], { name: 'child', apply() {} })

  it('unloads children with their parent and lets them be mounted again under a remounted parent', async () => {
    const setup = withInline(minimalChat(), parent, child)
    const childInstance = setup.composition.instances.find(instance => instance.id === 'child')!
    childInstance.parentId = 'parent'
    const result = await run({
      ...setup,
      scenario: scenario([
        { kind: 'unmount', id: 'drop-parent', instanceId: 'parent' },
        { kind: 'mount', id: 'parent-again', instanceId: 'parent' },
        { kind: 'mount', id: 'child-again', instanceId: 'child' },
      ]),
    })
    expect(result.error).toBeNull()
    const childPhases = result.recorder.records
      .filter(record => record.name === TraceName.pluginPhase && record.instanceId === 'child')
      .map(record => ({ step: record.scenarioStepId, phase: payloadOf<{ phase: unknown }>(result, record).phase }))
    expect(childPhases.filter(item => item.step === 'drop-parent').at(-1)?.phase).toBeNull()
    expect(childPhases.filter(item => item.step === 'child-again').at(-1)?.phase).toBe('active')
  })
})

describe('trace limits', () => {
  it('stops the scenario instead of reporting a truncated run as completed', async () => {
    const result = await run({ scenario: lifecycleScenario(), limits: { maxRecords: 40, maxPayloadBytes: 10_000_000 } })
    expect(result.recorder.truncated).toBe(true)
    expect(result.outcome).toBe('failed')
    expect(result.error?.name).toBe('TraceLimitError')
  })
})
