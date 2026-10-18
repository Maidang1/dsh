/**
 * TURN-01, TURN-03, TOOL-01, TOOL-02 and repeatability on the teaching runtime.
 */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { TraceName } from '@harness-explorer/contracts'
import type { Composition, ExecutableStageDefinition, ModelScript, SessionEventPayload } from '@harness-explorer/contracts'
import { devStages } from '@harness-explorer/teaching-plugins'
import { describe, expect, it } from 'vitest'
import { importStageLoader } from '../src/index.ts'
import type { RunResult } from '../src/index.ts'
import { minimalChat, payloadOf, requestsOf, run, scenario } from './helpers.ts'

function inlineStage(id: string, requires: string[], plugin: Plugin) {
  const definition: ExecutableStageDefinition = {
    id: `${id}@inline`,
    pluginDefinitionId: id,
    origin: 'teaching',
    module: `/inline/${id}`,
    sourceHash: 'inline',
    requires,
    provides: [],
    upstreamCommit: null,
  }
  return { definition, plugin }
}

function withInline(composition: Composition, ...inline: Array<ReturnType<typeof inlineStage>>) {
  for (const { definition } of inline) {
    composition.instances.push({
      id: definition.pluginDefinitionId,
      definitionId: definition.pluginDefinitionId,
      stageId: definition.id,
      scopeId: 'root',
      parentId: null,
      enabled: true,
      config: {},
    })
  }
  const plugins = new Map(inline.map(({ definition, plugin }) => [definition.id, plugin]))
  return {
    composition,
    stages: [...devStages, ...inline.map(({ definition }) => definition)],
    loadStage: async (stage: ExecutableStageDefinition) => plugins.get(stage.id) ?? importStageLoader(stage),
  }
}

function sessionTypes(result: RunResult, sessionId: string) {
  return result.recorder.records
    .filter(record => record.name === TraceName.sessionEvent && record.sessionId === sessionId)
    .map(record => payloadOf<SessionEventPayload>(result, record))
}

describe('TURN-03: plain text response', async () => {
  const result = await run({ scenario: scenario([{ kind: 'input', id: 'ask', sessionId: 's', text: '你好' }]) })

  it('commits durable events in upstream order', () => {
    expect(sessionTypes(result, 's').map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'system/message', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    ])
  })

  it('settles the streamed chunks into one assistant message and completes the turn', () => {
    const events = sessionTypes(result, 's')
    expect(events.find(event => event.type === 'assistant/message')?.data).toEqual({ text: '你好！有什么可以帮你？', toolCalls: [] })
    expect(events.at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })

  it('is repeatable: the same scenario yields an identical trace', async () => {
    const again = await run({ scenario: scenario([{ kind: 'input', id: 'ask', sessionId: 's', text: '你好' }]) })
    expect(again.recorder.records).toEqual(result.recorder.records)
  })
})

describe('TURN-01: a turn may close without a step', () => {
  it('spends no model call on an empty first input', async () => {
    const result = await run({ scenario: scenario([{ kind: 'input', id: 'empty', sessionId: 's', text: '  ' }]) })
    expect(sessionTypes(result, 's').map(event => event.type)).toEqual(['turn/start', 'turn/end'])
    expect(requestsOf(result, 'empty')).toEqual([])
  })

  it('closes the turn as blocked when agent/pre-step rejects, without committing the user message', async () => {
    const blocker = inlineStage('blocker', [], {
      name: 'blocker',
      apply(ctx: Context) {
        ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' as const, reason: 'policy' }))
      },
    })
    const result = await run({
      ...withInline(minimalChat(), blocker),
      scenario: scenario([{ kind: 'input', id: 'ask', sessionId: 's', text: '你好' }]),
    })
    const events = sessionTypes(result, 's')
    expect(events.map(event => event.type)).toEqual(['turn/start', 'turn/end'])
    expect(events.at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'blocked', reason: 'policy' } })
    expect(requestsOf(result, 'ask')).toEqual([])
  })
})

const calculatorScript: ModelScript = {
  id: 'calculator',
  onUnmatched: 'fail',
  rules: [
    { id: 'call-add', match: { lastUserText: '1+2', declaredTools: ['add'] }, respond: { kind: 'tool-call', tool: 'add', arguments: { a: 1, b: 2 } } },
    { id: 'answer', match: { afterToolResult: '3' }, respond: { kind: 'text', chunks: ['结果是 3'] } },
    { id: 'call-unknown', match: { lastUserText: 'boom' }, respond: { kind: 'tool-call', tool: 'subtract', arguments: {} } },
  ],
}

const calculator = inlineStage('calculator', ['tools'], {
  name: 'calculator',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.tools.register({
      name: 'add',
      description: 'Add two numbers',
      parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
      validate: args => (typeof (args as { a?: unknown }).a === 'number' ? undefined : 'a must be a number'),
      execute: args => String((args as { a: number; b: number }).a + (args as { a: number; b: number }).b),
    })
  },
})

describe('TOOL-01: tool call round trip', async () => {
  const result = await run({
    ...withInline(minimalChat(), calculator),
    modelScripts: { calculator: calculatorScript },
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
    expect(sessionTypes(result, 's').map(event => event.type)).toEqual([
      'turn/start',
      'step/start', 'system/message', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'step/end',
      'turn/end',
    ])
  })
})

describe('TOOL-02: a model calling an undeclared tool', () => {
  it('fails the scenario and ends the turn with an error instead of pretending the call happened', async () => {
    const result = await run({
      ...withInline(minimalChat(), calculator),
      modelScripts: { calculator: calculatorScript },
      scenario: scenario([{ kind: 'input', id: 'ask', sessionId: 's', text: 'boom' }], 'calculator'),
    })
    expect(result.outcome).toBe('failed')
    expect(result.error?.message).toMatch(/calls tool "subtract", which the request does not declare/)
    const events = sessionTypes(result, 's')
    expect(events.some(event => event.type === 'tool/call')).toBe(false)
    expect(events.at(-1)?.data).toMatchObject({ reason: { kind: 'error' } })
  })
})

describe('TURN-02: cancelling while the request is being prepared', () => {
  it('commits neither system nor user messages and lets the scenario continue', async () => {
    const result = await run({
      scenario: scenario([
        { kind: 'cancel', id: 'arm', afterCheckpoint: 'agent-loop:request-prepared' },
        { kind: 'input', id: 'ask', sessionId: 's', text: '你好' },
        { kind: 'input', id: 'again', sessionId: 's2', text: '你好' },
      ]),
    })
    expect(result.error).toBeNull()
    expect(result.outcome).toBe('completed')
    const events = sessionTypes(result, 's')
    expect(events.map(event => event.type)).toEqual(['turn/start', 'step/start', 'step/end', 'turn/end'])
    expect(events.at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'aborted' } })
    expect(requestsOf(result, 'ask')).toEqual([])
    expect(result.recorder.records.some(record => record.name === 'checkpoint/agent-loop:request-prepared' && record.scenarioStepId === 'ask')).toBe(true)
    expect(sessionTypes(result, 's2').at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })

  it('fails the run when the armed checkpoint is never reached', async () => {
    const result = await run({
      scenario: scenario([
        { kind: 'cancel', id: 'arm', afterCheckpoint: 'agent-loop:no-such-checkpoint' },
        { kind: 'input', id: 'ask', sessionId: 's', text: '你好' },
      ]),
    })
    expect(result.outcome).toBe('failed')
    expect(result.error?.message).toMatch(/was never reached/)
  })
})
