/** Test worker: records the DSH_HOME it was forked with, then settles without running. */
import { writeFileSync } from 'node:fs'

process.on('message', (raw) => {
  const message = raw as { type?: string; runId?: string }
  if (message.type !== 'START') return
  writeFileSync(process.env.ENV_PROBE_OUT!, process.env.DSH_HOME ?? '<unset>')
  process.send!({ type: 'READY', runId: message.runId })
  process.send!({ type: 'SETTLED', runId: message.runId, outcome: 'completed', error: null, lastSeq: -1, truncated: false }, () => process.disconnect())
})
