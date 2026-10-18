/**
 * Entry point of a run subprocess. It executes exactly one run and exits, so
 * no module cache or Cordis state survives into the next run.
 */
import type { JsonValue, TraceRecord } from '@harness-explorer/contracts'
import { runScenario } from '@harness-explorer/teaching-runtime'
import { ParentMessage } from './ipc.ts'
import type { ChildMessage, StartMessage } from './ipc.ts'

const BATCH_SIZE = 50
const BATCH_MS = 20

function send(message: ChildMessage) {
  return new Promise<void>((resolve, reject) => {
    process.send!(message, (error: Error | null) => (error ? reject(error) : resolve()))
  })
}

async function run(start: StartMessage, abort: AbortController) {
  let records: TraceRecord[] = []
  let payloads = new Map<string, JsonValue>()
  let timer: NodeJS.Timeout | undefined
  let sent = Promise.resolve()

  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (records.length) {
      const batch: ChildMessage = { type: 'TRACE_BATCH', runId: start.runId, records, payloads: [...payloads] }
      records = []
      payloads = new Map()
      sent = sent.then(() => send(batch))
    }
    return sent
  }

  await send({ type: 'READY', runId: start.runId })
  const result = await runScenario({
    runId: start.runId,
    composition: start.composition,
    scenario: start.scenario,
    modelScripts: start.modelScripts,
    stages: start.stages,
    adapterMode: start.adapterMode,
    signal: abort.signal,
    limits: start.limits,
    onRecord: (record, store) => {
      records.push(record)
      for (const ref of [record.beforeRef, record.afterRef, record.payloadRef]) {
        if (ref) payloads.set(ref, store.get(ref))
      }
      if (records.length >= BATCH_SIZE) void flush()
      else timer ??= setTimeout(() => void flush(), BATCH_MS)
    },
  })
  await flush()
  await send({
    type: 'SETTLED',
    runId: start.runId,
    outcome: result.outcome === 'terminated' ? 'failed' : result.outcome,
    error: result.error,
    lastSeq: result.recorder.lastSeq,
    truncated: result.recorder.truncated,
  })
}

const abort = new AbortController()
let started = false
process.on('message', (raw) => {
  const message = ParentMessage.parse(raw)
  if (message.type === 'CANCEL') {
    abort.abort(new Error('cancelled by user'))
    return
  }
  if (started) throw new Error('a run subprocess executes exactly one run')
  started = true
  run(message, abort).then(
    () => process.disconnect(),
    (error: unknown) => {
      console.error(error)
      process.exitCode = 1
      process.disconnect()
    },
  )
})
