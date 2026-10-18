/**
 * OBS-01: observation is read-only. Durable session events read straight from
 * the Sessions service are identical with observation on and off, and equal to
 * what the trace recorded.
 */
import type { Context } from '@deepseek-ai/cordis'
import { TraceName } from '@harness-explorer/contracts'
import type { SessionEventPayload } from '@harness-explorer/contracts'
import type { SessionEvent } from '@harness-explorer/teaching-plugins'
import { describe, expect, it } from 'vitest'
import { lifecycleScenario, payloadOf, run, scenario } from './helpers.ts'

const SESSIONS = ['s-a', 's-b', 's-c', 's-d']

function readSessions(root: Context, ids: readonly string[]) {
  const sessions = root.get('sessions') as { events(id: string): readonly SessionEvent[] }
  return Object.fromEntries(ids.map(id => [id, sessions.events(id).map(event => structuredClone(event))]))
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
    expect(Object.values(observed).flat()).toHaveLength(28)

    // The trace is a faithful copy of what the service committed.
    const traced = on.recorder.records
      .filter(record => record.name === TraceName.sessionEvent)
      .map(record => payloadOf<SessionEventPayload>(on, record))
    for (const id of SESSIONS) {
      expect(traced.filter(event => event.sessionId === id).map(event => ({ type: event.type, data: event.data })))
        .toEqual(observed[id]!.map(event => ({ type: event.type, data: event.data })))
    }
    // With observation off only scenario checkpoints are recorded.
    expect(new Set(off.recorder.records.map(record => record.name))).toEqual(new Set(['scenario/step', 'run/settle']))
  })

  it('keeps scenario cancel steps working without observation', async () => {
    let events: Record<string, SessionEvent[]> = {}
    const result = await run({
      observe: false,
      scenario: scenario([
        { kind: 'cancel', id: 'arm', afterCheckpoint: 'agent-loop:request-prepared' },
        { kind: 'input', id: 'ask', sessionId: 's', text: '你好' },
      ]),
      beforeSettle: root => { events = readSessions(root, ['s']) },
    })
    expect(result.outcome).toBe('completed')
    expect(events.s!.at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'aborted' } })
  })
})
