/**
 * OBS-01: observation is read-only. Durable session events read from the live
 * agents' sessions (`agent.session.snapshotEvents()`) are identical with
 * observation on and off, and equal to what the trace recorded.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TraceName } from '@harness-explorer/contracts'
import type { SessionEventPayload } from '@harness-explorer/contracts'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SCRIPTED_PROVIDER } from '@harness-explorer/teaching-plugins'
import { inlineStage, lifecycleScenario, minimalChat, payloadOf, run, scenario, withInline } from './helpers.ts'

const SESSIONS = ['s-a', 's-b', 's-c', 's-d']

/** Detach a value the way the observer does, so trace and log compare as plain JSON. */
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown

/** The durable event log of each session's live agent, before settlement disposes them. */
function readSessions(root: Context, ids: readonly string[]) {
  return Object.fromEntries(ids.map(id => [
    id,
    (root.agents.get(SessionId(id))?.session.snapshotEvents() ?? []).map(event => structuredClone(event)),
  ]))
}

describe('OBS-01: observation does not change semantics', () => {
  it('yields the same durable session events with observation on and off', async () => {
    let observed: Record<string, SessionEvent[]> = {}
    let unobserved: Record<string, SessionEvent[]> = {}
    const on = await run({ scenario: lifecycleScenario(), beforeSettle: root => { observed = readSessions(root, SESSIONS) } })
    const off = await run({ scenario: lifecycleScenario(), observe: false, beforeSettle: root => { unobserved = readSessions(root, SESSIONS) } })
    expect(on.outcome).toBe('completed')
    expect(off.outcome).toBe('completed')
    expect(unobserved).toEqual(observed)
    expect(Object.values(observed).flat()).toHaveLength(44)

    // The trace is a faithful copy of what the session log committed.
    const traced = on.recorder.records
      .filter(record => record.name === TraceName.sessionEvent)
      .map(record => payloadOf<SessionEventPayload>(on, record))
    for (const id of SESSIONS) {
      expect(traced.filter(event => event.sessionId === id).map(event => ({ type: event.type, data: event.data })))
        .toEqual(observed[id]!.map(event => json({ type: event.type, data: event.data })))
    }
    // With observation off only scenario checkpoints are recorded.
    expect(new Set(off.recorder.records.map(record => record.name))).toEqual(new Set(['scenario/step', 'run/settle']))
  })

  it('keeps scenario cancel steps working without observation', async () => {
    let events: Record<string, SessionEvent[]> = {}
    const result = await run({
      observe: false,
      scenario: scenario([
        { kind: 'cancel', id: 'arm', afterCheckpoint: 'request/context' },
        { kind: 'input', id: 'ask', sessionId: 's', text: '你好' },
      ]),
      beforeSettle: root => { events = readSessions(root, ['s']) },
    })
    expect(result.outcome).toBe('completed')
    // Cancelled after the request was prepared: no assistant message, but the
    // step and turn still close, with the abort reason upstream commits.
    expect(events.s!.map(event => event.type)).toEqual([
      'agent/inbox/spliced', 'turn/start', 'agent/inbox/spliced',
      'step/start', 'system/message', 'user/message', 'request/header', 'request/context',
      'step/end', 'turn/end',
    ])
    expect(events.s!.at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  })
})

/**
 * explorer-redesign §5.1: model/request and model/response records carry the
 * instanceId of the instance that issued the call.
 */
describe('model request attribution', () => {
  it('records the requests of a turn on the agent-loop instance', async () => {
    const result = await run({ scenario: scenario([{ kind: 'input', id: 'ask', sessionId: 's', text: '你好' }]) })
    expect(result.error).toBeNull()
    const requests = result.recorder.records.filter(record => record.name === TraceName.modelRequest)
    const responses = result.recorder.records.filter(record => record.name === TraceName.modelResponse)
    expect(requests).toHaveLength(1)
    expect(responses).toHaveLength(1)
    expect(requests[0]!.instanceId).toBe('agent-loop')
    expect(responses[0]!.instanceId).toBe('agent-loop')
  })

  it('leaves instanceId off a request another plugin assembles itself', async () => {
    const prober = inlineStage('prober', ['llm'], {
      name: 'prober',
      inject: ['llm'],
      async apply(ctx: Context) {
        const request = { provider: SCRIPTED_PROVIDER, model: 'greeting', messages: [createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } })] }
        for await (const _chunk of ctx.llm.stream(request)) { /* drain */ }
      },
    })
    const result = await run({ ...withInline(minimalChat(), prober), scenario: scenario([{ kind: 'snapshot', id: 'look', label: 'look' }]) })
    expect(result.error).toBeNull()
    const records = result.recorder.records.filter(record => record.name === TraceName.modelRequest || record.name === TraceName.modelResponse)
    expect(records).toHaveLength(2)
    expect(records.map(record => record.instanceId)).toEqual([undefined, undefined])
  })
})
