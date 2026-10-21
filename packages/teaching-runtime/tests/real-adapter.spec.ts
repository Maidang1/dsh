/**
 * P2-06: the upstream real adapter (`@deepseek-ai/dsh-llm-deepseek-api-key`,
 * mounted through REAL_ADAPTER_STAGE) against a local Messages-compatible
 * mock. The mock records the wire traffic; the tests check the request shape,
 * stream assembly, failure handling and that the key never reaches the trace.
 *
 * Wire format captured from upstream 0.2.1-rc.2 (see the mock below):
 * POST <baseURL>/v1/messages with `x-api-key`, `anthropic-version: 2023-06-01`
 * and `accept: text/event-stream`; the body is Anthropic-shaped
 * (`messages`, `system`, `tools[].input_schema`, `stream: true`) and the
 * response is an SSE stream of message_start, content_block and message
 * events. A turn the adapter fails ends with `reason.kind === 'error'`, which
 * the runner surfaces as a TurnError.
 */
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TraceName } from '@harness-explorer/contracts'
import type { ModelRequestPayload, SessionEventPayload } from '@harness-explorer/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { REAL_ADAPTER_STAGE, compositionForMode } from '../src/index.ts'
import type { RunResult } from '../src/index.ts'
import { PERSONA, lifecycleScenario, minimalChat, payloadOf, requestsOf, run, scenario, sessionEvents, toolChat, toolGuardScenario } from './helpers.ts'

const KEY = 'sk-test-0123456789'

/** What the observer records under TraceName.modelResponse (observe.ts observeStream). */
interface ModelResponse {
  requestId: string
  text: string
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>
  finish: unknown
  error: { name: string; message: string } | null
}

interface WireRequest {
  path: string
  headers: IncomingHttpHeaders
  body: any
}

type Reply = (body: any) => { status?: number; events?: unknown[] }

const sse = (events: unknown[]) => events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

/** A complete Anthropic-style text response streaming `chunks`. */
function textEvents(...chunks: string[]) {
  return [
    { type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...chunks.map(text => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
}

let server: Server | null = null
const received: WireRequest[] = []

/** 4340 first, then upwards: another process may already hold a port. */
async function listen(instance: Server): Promise<number> {
  for (let port = 4340; port < 4350; port++) {
    const taken = await new Promise<boolean>(resolve => {
      instance.once('error', () => resolve(false))
      instance.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (taken) return port
  }
  throw new Error('no free port in 4340..4349')
}

async function startMock(reply: Reply): Promise<void> {
  received.length = 0
  server = createServer((request, response) => {
    let text = ''
    request.on('data', chunk => { text += chunk })
    request.on('end', () => {
      received.push({ path: request.url!, headers: request.headers, body: JSON.parse(text) })
      const answer = reply(received.at(-1)!.body)
      if (answer.status && answer.status !== 200) {
        response.writeHead(answer.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // Split mid-event to exercise SSE buffering.
      const payload = sse(answer.events ?? [])
      const cut = Math.floor(payload.length / 2)
      response.write(payload.slice(0, cut))
      setTimeout(() => response.end(payload.slice(cut)), 5)
    })
  })
  const port = await listen(server)
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}/anthropic`
}

const closeMock = () => new Promise<void>(resolve => {
  const current = server
  server = null
  if (!current) return resolve()
  current.close(() => resolve())
})

let previousDshHome: string | undefined
let dshHome: string

beforeAll(() => {
  // getOrCreateAnonymousUserId writes <DSH_HOME>/anonymous-user-id; keep it out of the real home directory.
  previousDshHome = process.env.DSH_HOME
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-real-adapter-'))
  process.env.DSH_HOME = dshHome
})
afterAll(() => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  rmSync(dshHome, { recursive: true, force: true })
})

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = KEY
})
afterEach(async () => {
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_BASE_URL
  await closeMock()
})

const realRun = (overrides: Parameters<typeof run>[0]) => run({ adapterMode: 'real', ...overrides })
const traceText = (result: RunResult) => JSON.stringify([...result.recorder.records, ...result.recorder.payloads.entries()])
const responsesOf = (result: RunResult) => result.recorder.records
  .filter(record => record.name === TraceName.modelResponse)
  .map(record => payloadOf<ModelResponse>(result, record))

describe('real model adapter (P2-06)', () => {
  it('replaces only the scripted adapter, keeping its id', () => {
    const swapped = compositionForMode(minimalChat(), 'real').instances.find(instance => instance.id === 'llm-scripted')
    expect(swapped).toMatchObject({ definitionId: REAL_ADAPTER_STAGE.definitionId, stageId: REAL_ADAPTER_STAGE.stageId })
    expect(compositionForMode(minimalChat(), 'deterministic')).toEqual(minimalChat())
  })

  it('speaks the upstream Messages wire format and assembles streamed text', async () => {
    await startMock(() => ({ events: textEvents('你', '好！') }))
    const result = await realRun({ scenario: lifecycleScenario() })
    expect(result.error).toBeNull()
    expect(received).toHaveLength(4)
    const [first] = received
    expect(first!.path).toBe('/anthropic/v1/messages')
    expect(first!.headers['x-api-key']).toBe(KEY)
    expect(first!.headers).toMatchObject({
      'anthropic-version': '2023-06-01',
      accept: 'text/event-stream',
      'x-deepseek-harness-session-id': 's-a',
    })
    expect(first!.headers['user-agent']).toMatch(/^deepseek-harness\//)
    expect(first!.headers['x-deepseek-harness-user-id']).toBeTruthy()
    expect(first!.body).toEqual({
      model: 'deepseek-flash',
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      max_tokens: 256000,
      thinking: { type: 'enabled' },
      output_config: { effort: 'high' },
      system: PERSONA,
      tools: [],
    })
    expect(received[1]!.body.system).toBe(`${PERSONA}\n\n回答时使用短句`)
    expect(sessionEvents(result, 's-a').find(event => event.type === 'assistant/message')?.data)
      .toMatchObject({ message: { role: 'assistant', content: [{ type: 'text', text: '你好！' }] } })
    expect(responsesOf(result)[0]).toEqual({ requestId: 'request-1', text: '你好！', toolCalls: [], finish: { kind: 'stop' }, error: null })
    expect(traceText(result)).not.toContain(KEY)
  }, 20000)

  it('streams a tool call and sends its result back as tool_result', async () => {
    const composition = toolChat()
    composition.instances = composition.instances.map(instance => instance.definitionId === 'tool-guard' ? { ...instance, stageId: 'tool-guard@00-observe' } : instance)
    await startMock(body => (body.messages.at(-1).content.some((block: { type: string }) => block.type === 'tool_result')
      ? { events: textEvents('结果是 3') }
      : {
          events: [
            { type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'add', input: {} } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":1,' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"b":2}' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
            { type: 'message_stop' },
          ],
        }))
    const result = await realRun({ composition, scenario: toolGuardScenario() })
    expect(result.error).toBeNull()
    expect(received).toHaveLength(2)
    expect(received[0]!.body.tools).toEqual([{
      name: 'add',
      description: 'Add two numbers',
      input_schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    }])
    expect(received[1]!.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '1+2' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'add', input: { a: 1, b: 2 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '3' }], is_error: false }] },
    ])
    expect(responsesOf(result)[0]).toMatchObject({ toolCalls: [{ id: 'toolu_1', name: 'add', arguments: { a: 1, b: 2 } }], finish: { kind: 'tool-calls' } })
    expect(requestsOf(result, 'ask')[1]!.messages.at(-1)).toEqual({ role: 'tool', content: '3', toolCallId: 'toolu_1' })
    expect(sessionEvents(result, 's').filter(event => event.type === 'assistant/message').at(-1)?.data)
      .toMatchObject({ message: { content: [{ type: 'text', text: '结果是 3' }] } })
  }, 20000)

  it('fails the run on an HTTP error without echoing the key', async () => {
    await startMock(() => ({ status: 401 }))
    const result = await realRun({ scenario: lifecycleScenario() })
    expect(result.outcome).toBe('failed')
    expect(result.error).toEqual({ name: 'TurnError', message: 'turn of session "s-a" ended with an error: invalid x-api-key' })
    // No agent/request-error listener is mounted, so upstream does not retry.
    expect(received).toHaveLength(1)
    expect(sessionEvents(result, 's-a').at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'error', error: { message: 'invalid x-api-key', code: 'AUTH', status: 401 } } })
    expect(traceText(result)).not.toContain(KEY)
  }, 20000)

  it('fails the run when the stream ends before message_stop', async () => {
    await startMock(() => ({ events: textEvents('半').slice(0, -1) }))
    const result = await realRun({ scenario: scenario([{ kind: 'input', id: 'ask', sessionId: 's', text: '你好' }]) })
    expect(result.outcome).toBe('failed')
    expect(result.error?.name).toBe('TurnError')
    expect(result.error?.message).toContain('DeepSeek Messages stream ended before message_stop')
  }, 20000)

  it('fails the turn with a clear error when the key is missing', async () => {
    await startMock(() => ({ events: textEvents('你好') }))
    delete process.env.DEEPSEEK_API_KEY
    const result = await realRun({ scenario: scenario([{ kind: 'input', id: 'ask', sessionId: 's', text: '你好' }]) })
    expect(result.outcome).toBe('failed')
    expect(result.error?.name).toBe('TurnError')
    expect(result.error?.message).toContain('llm-deepseek: no API key for provider route "deepseek-official"')
    expect(result.error?.message).toContain('DEEPSEEK_API_KEY')
    // The key resolves lazily per request: the plugin mounts fine and no request is ever sent.
    expect(received).toHaveLength(0)
  }, 20000)
})
