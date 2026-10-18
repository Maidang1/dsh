import { TraceName } from '@harness-explorer/contracts'
import { describe, expect, it } from 'vitest'
import { Recorder, ReplayIndex, TraceBuffer, hashJson, replayAll, toJsonSnapshot } from '../src/index.ts'

function sampleRecorder(count: number) {
  let clock = 0
  const recorder = new Recorder({ runId: 'run-1', now: () => clock++ })
  for (let index = 0; index < count; index++) {
    const registrationId = `reg-${index % 7}`
    if (index % 3 === 2) {
      recorder.record({ kind: 'data', name: TraceName.registrationRemove, payload: { registrationId } })
    } else {
      recorder.record({
        kind: 'data',
        name: TraceName.registrationAdd,
        instanceId: 'prompt-contributor',
        payload: { registrationId, kind: 'prompt-section', name: `s${index}`, scopeId: 'root', detail: { order: index } },
      })
    }
  }
  return recorder
}

describe('Recorder', () => {
  it('assigns monotonic seq and stores payloads by content', () => {
    const recorder = sampleRecorder(5)
    expect(recorder.records.map(record => record.seq)).toEqual([0, 1, 2, 3, 4])
    const first = recorder.records[0]!
    expect(first.payloadRef).toBe(hashJson(recorder.payloads.get(first.payloadRef!)))
    expect(Object.isFrozen(first)).toBe(true)
  })

  it('snapshots values so later mutation does not change the trace', () => {
    const recorder = new Recorder({ runId: 'run-1', now: () => 0 })
    const live = { sessionId: 's', type: 'turn/start', data: { text: 'before' } }
    const record = recorder.record({ kind: 'session', name: TraceName.sessionEvent, payload: live })!
    live.data.text = 'after'
    expect(recorder.payloads.get(record.payloadRef!)).toEqual({ sessionId: 's', type: 'turn/start', data: { text: 'before' } })
  })

  it('refuses live references such as functions and class instances', () => {
    expect(() => toJsonSnapshot({ fn: () => 1 })).toThrow(/unsupported function at \$\.fn/)
    expect(() => toJsonSnapshot({ when: new Date(0) })).toThrow(/non-plain object/)
  })

  it('marks the trace truncated instead of silently dropping the tail', () => {
    const recorder = new Recorder({ runId: 'run-1', now: () => 0, maxRecords: 2 })
    recorder.record({ kind: 'diagnostic', name: 'a' })
    recorder.record({ kind: 'diagnostic', name: 'b' })
    expect(recorder.record({ kind: 'diagnostic', name: 'c' })).toBeNull()
    expect(recorder.truncated).toBe(true)
    expect(recorder.lastSeq).toBe(1)
  })
})

describe('Replay (TRACE-01)', () => {
  it('jumping through checkpoints equals folding from the start', () => {
    const recorder = sampleRecorder(250)
    const resolve = (ref: string) => recorder.payloads.get(ref)
    const index = new ReplayIndex(recorder.records, resolve, 100)
    for (const seq of [-1, 0, 57, 99, 100, 101, 199, 249]) {
      expect(index.at(seq)).toEqual(replayAll(recorder.records.slice(0, seq + 1), resolve))
    }
  })

  it('projects registrations being added and removed', () => {
    const recorder = sampleRecorder(3)
    const snapshot = replayAll(recorder.records, ref => recorder.payloads.get(ref))
    expect(Object.keys(snapshot.registrations)).toEqual(['reg-0', 'reg-1'])
    const index = new ReplayIndex(recorder.records, ref => recorder.payloads.get(ref))
    expect(Object.keys(index.at(0).registrations)).toEqual(['reg-0'])
  })

  it('rejects out-of-order folding', () => {
    const recorder = sampleRecorder(3)
    expect(() => replayAll([recorder.records[1]!], ref => recorder.payloads.get(ref))).toThrow(/expects seq 0/)
  })
})

describe('TraceBuffer (HOST-01 receiver side)', () => {
  it('deduplicates, reports gaps and only completes after settlement', () => {
    const records = sampleRecorder(6).records
    const buffer = new TraceBuffer('run-1')
    expect(buffer.add(records.slice(0, 3))).toBe(3)
    expect(buffer.add(records.slice(1, 2))).toBe(0)
    buffer.add(records.slice(4, 5))
    expect(buffer.lastContiguousSeq).toBe(2)
    buffer.settle(5)
    expect(buffer.gaps()).toEqual([{ fromSeq: 3, toSeq: 3 }, { fromSeq: 5, toSeq: 5 }])
    expect(buffer.complete).toBe(false)
    buffer.add([records[3]!, records[5]!])
    expect(buffer.complete).toBe(true)
    expect(buffer.contiguous()).toHaveLength(6)
  })

  it('rejects records from another run', () => {
    const buffer = new TraceBuffer('run-2')
    expect(() => buffer.add(sampleRecorder(1).records)).toThrow(/run-1/)
  })
})

describe('incremental replay and buffering', () => {
  it('extending an index batch by batch equals building it at once', () => {
    const recorder = sampleRecorder(530)
    const resolve = (ref: string) => recorder.payloads.get(ref)
    const whole = new ReplayIndex(recorder.records, resolve, 100)
    const grown = new ReplayIndex([], resolve, 100)
    for (let start = 0; start < recorder.records.length; start += 37) grown.extend(recorder.records.slice(start, start + 37))
    for (const seq of [-1, 0, 99, 100, 250, 529]) expect(grown.at(seq)).toEqual(whole.at(seq))
  })

  it('rejects an extension that skips records', () => {
    const recorder = sampleRecorder(5)
    const index = new ReplayIndex(recorder.records.slice(0, 2), ref => recorder.payloads.get(ref))
    expect(() => index.extend(recorder.records.slice(3))).toThrow(/expects seq 2/)
  })

  it('exposes the contiguous prefix without copying and keeps it stable across batches', () => {
    const records = sampleRecorder(6).records
    const buffer = new TraceBuffer('run-1')
    const view = buffer.records
    buffer.add(records.slice(2, 4))
    expect(view).toHaveLength(0)
    buffer.add(records.slice(0, 2))
    expect(view).toBe(buffer.records)
    expect(view.map(record => record.seq)).toEqual([0, 1, 2, 3])
  })
})
