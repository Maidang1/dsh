/**
 * P7-02 baseline (docs/02 §14): replay jumps over a standard experiment of
 * 50 instances and 5,000 small records must stay under 200 ms at p95.
 */
import { TraceName } from '@harness-explorer/contracts'
import { expect, it } from 'vitest'
import { Recorder, ReplayIndex } from '../src/index.ts'

it('jumps anywhere in a 5,000-record trace within the p95 budget', () => {
  let clock = 0
  const recorder = new Recorder({ runId: 'perf', now: () => clock++ })
  for (let index = 0; index < 5000; index++) {
    const instanceId = `plugin-${index % 50}`
    if (index % 5 === 0) {
      recorder.record({ kind: 'lifecycle', name: TraceName.pluginPhase, instanceId, payload: { phase: index % 10 ? 'active' : 'pending', dependencyStatus: 'resolved', reason: null, error: null } })
    } else if (index % 5 === 1) {
      recorder.record({ kind: 'data', name: TraceName.registrationAdd, instanceId, payload: { registrationId: `r-${index % 200}`, kind: 'prompt-section', name: `s-${index}`, scopeId: 'root', detail: { order: index } } })
    } else if (index % 5 === 2) {
      recorder.record({ kind: 'data', name: TraceName.registrationRemove, instanceId, payload: { registrationId: `r-${(index + 100) % 200}` } })
    } else {
      recorder.record({ kind: 'session', name: TraceName.sessionEvent, sessionId: 's', payload: { sessionId: 's', type: 'assistant/message', data: { text: 'x'.repeat(200) } } })
    }
  }

  const buildStart = performance.now()
  const index = new ReplayIndex(recorder.records, ref => recorder.payloads.get(ref), 100)
  const buildMs = performance.now() - buildStart

  const durations: number[] = []
  let seed = 7
  for (let sample = 0; sample < 200; sample++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    const target = seed % 5000
    const start = performance.now()
    index.at(target)
    durations.push(performance.now() - start)
  }
  durations.sort((a, b) => a - b)
  const p95 = durations[Math.floor(durations.length * 0.95)]!
  console.log(`replay index build ${buildMs.toFixed(1)} ms; jump p50 ${durations[100]!.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`)
  expect(p95).toBeLessThan(200)
})
