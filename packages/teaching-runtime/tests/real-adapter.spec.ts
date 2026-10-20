/**
 * P2-06: the real model adapter against a local Messages-compatible server.
 * Real outputs are not compared verbatim; the tests check the wire contract,
 * stream assembly, failure handling and that the key never reaches the trace.
 */
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { Composition, Scenario, TraceName } from '@harness-explorer/contracts'
import type { ModelRequestPayload, SessionEventPayload } from '@harness-explorer/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { compositionForMode } from '../src/index.ts'
import type { RunResult } from '../src/index.ts'
import { lifecycleScenario, minimalChat, payloadOf, run } from './helpers.ts'

const KEY = 'sk-test-0123456789'
type Reply = (body: any) => { status?: number; events?: unknown[]; raw?: string }

let server: Server
let base: string
let reply: Reply
const received: Array<{ path: string; headers: IncomingHttpHeaders; body: any }> = []

const sse = (events: unknown[]) => events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

function textEvents(...chunks: string[]) {
  return [
    { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...chunks.map(text => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let text = ''
    request.on('data', chunk => { text += chunk })
    request.on('end', () => {
      const body = JSON.parse(text)
      received.push({ path: request.url!, headers: request.headers, body })
      const answer = reply(body)
      if (answer.status && answer.status !== 200) {
        response.writeHead(answer.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // Split mid-event to exercise buffering.
      const payload = answer.raw ?? sse(answer.events ?? [])
      const cut = Math.floor(payload.length / 2)
      response.write(payload.slice(0, cut))
      setTimeout(() => response.end(payload.slice(cut)), 5)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/anthropic`
})
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

beforeEach(() => {
  received.length = 0
  process.env.DEEPSEEK_API_KEY = KEY
  process.env.DEEPSEEK_BASE_URL = base
})
afterEach(() => {
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_BASE_URL
})

const realRun = (overrides: Parameters<typeof run>[0]) => run({ adapterMode: 'real', ...overrides })
const traceText = (result: RunResult) => JSON.stringify([...result.recorder.records, ...result.recorder.payloads.entries()])
const sessionEvents = (result: RunResult) => result.recorder.records
  .filter(record => record.name === TraceName.sessionEvent)
  .map(record => payloadOf<SessionEventPayload>(result, record))

describe('real model adapter (P2-06)', () => {
  it('replaces only the scripted adapter, keeping its id', () => {
    const swapped = compositionForMode(minimalChat(), 'real').instances.find(instance => instance.id === 'llm-scripted')
    expect(swapped).toMatchObject({ definitionId: 'llm-deepseek', stageId: 'llm-deepseek@main' })
    expect(compositionForMode(minimalChat(), 'deterministic')).toEqual(minimalChat())
  })

  it('speaks the upstream Messages wire format and assembles streamed text', async () => {
    reply = () => ({ events: textEvents('你', '好！') })
    const result = await realRun({ scenario: lifecycleScenario() })
    expect(result.error).toBeNull()
    expect(received).toHaveLength(4)
    const [first] = received
    expect(first!.path).toBe('/anthropic/v1/messages')
    expect(first!.headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01', accept: 'text/event-stream' })
    expect(first!.body).toMatchObject({ model: 'deepseek-flash', stream: true, system: '你是一个助手', messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] })
    expect(received[1]!.body.system).toBe('你是一个助手\n\n回答时使用短句')
    expect(sessionEvents(result).find(event => event.type === 'assistant/message')?.data).toMatchObject({ text: '你好！' })
    expect(traceText(result)).not.toContain(KEY)
  })

  it('streams a tool call and sends its result back as tool_result', async () => {
    const composition = Composition.parse(JSON.parse(readFileSync(new URL('../../../fixtures/compositions/tool-chat.json', import.meta.url), 'utf8')))
    composition.instances = composition.instances.map(instance => instance.definitionId === 'tool-guard' ? { ...instance, stageId: 'tool-guard@00-observe' } : instance)
    reply = body => (body.messages.at(-1).content[0].type === 'tool_result'
      ? { events: textEvents('结果是 3') }
      : {
          events: [
            { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } },
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'add', input: {} } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":1,' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"b":2}' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
            { type: 'message_stop' },
          ],
        })
    const scenario = Scenario.parse(JSON.parse(readFileSync(new URL('../../../fixtures/scenarios/tool-guard.json', import.meta.url), 'utf8')))
    const result = await realRun({ composition, scenario })
    expect(result.error).toBeNull()
    expect(received[0]!.body.tools).toEqual([expect.objectContaining({ name: 'add', input_schema: expect.objectContaining({ type: 'object' }) })])
    expect(received[1]!.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '1+2' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'add', input: { a: 1, b: 2 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '3' }] },
    ])
    const requests = result.recorder.records.filter(record => record.name === TraceName.modelRequest)
    expect(payloadOf<ModelRequestPayload>(result, requests[1]!).messages.at(-1)).toEqual({ role: 'tool', content: '3', toolCallId: 'toolu_1' })
  })

  it('fails the run on an HTTP error without echoing the key', async () => {
    reply = () => ({ status: 401 })
    const result = await realRun({ scenario: lifecycleScenario() })
    expect(result.outcome).toBe('failed')
    expect(result.error?.message).toBe('DeepSeek Messages request failed with HTTP 401: invalid x-api-key')
    expect(traceText(result)).not.toContain(KEY)
  })

  it('fails when the stream ends before message_stop', async () => {
    reply = () => ({ events: textEvents('半').slice(0, -1) })
    const result = await realRun({ scenario: lifecycleScenario() })
    expect(result.outcome).toBe('failed')
    expect(result.error?.message).toMatch(/ended before message_stop/)
  })

  it('leaves the adapter failed with a reason when the key is missing', async () => {
    delete process.env.DEEPSEEK_API_KEY
    const result = await realRun({ scenario: lifecycleScenario() })
    expect(result.outcome).toBe('failed')
    expect(received).toHaveLength(0)
    const phases = result.recorder.records
      .filter(record => record.name === TraceName.pluginPhase && record.instanceId === 'llm-scripted')
      .map(record => payloadOf<{ phase: string; error: { message: string } | null }>(result, record))
    expect(phases.find(phase => phase.phase === 'failed')?.error?.message).toBe('DEEPSEEK_API_KEY is not set in the Node environment')
  })
})
