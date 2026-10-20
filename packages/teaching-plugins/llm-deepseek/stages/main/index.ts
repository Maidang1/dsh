/**
 * Real model adapter: teaching subset of upstream llm-deepseek with
 * llm-deepseek-api-key (packages/llm/llm-deepseek/src/adapter.ts,
 * packages/llm/llm-deepseek-api-key/src/index.ts @ 687f282e).
 *
 * Kept: the DeepSeek Anthropic-Messages-compatible endpoint
 * (`{base}/v1/messages`, base from DEEPSEEK_BASE_URL or the public root),
 * the API key read from DEEPSEEK_API_KEY in the Node process and sent as
 * `x-api-key`, streamed text_delta and input_json_delta blocks, and failure
 * when the stream ends before message_stop.
 * Not kept: file upload, images, retries, pricing, request extensions,
 * attribution headers, model catalogue. The key never enters config or traces.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { HistoryMessage } from '../../../session/stages/main/index.ts'
import type { ModelChunk, ModelRequest } from '../../../llm/stages/main/index.ts'

export const name = 'llm-deepseek'
export const inject = ['llm']

export const PUBLIC_BASE_URL = 'https://api.deepseek.com/anthropic'
export const API_KEY_ENV = 'DEEPSEEK_API_KEY'
export const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'

export interface Config {
  model?: string
  maxTokens?: number
}

export const Config: z<Config> = z.object({
  model: z.string(),
  maxTokens: z.natural().min(1),
})

/** Same rule as upstream messagesApiRoot: append /v1 unless already present. */
export function messagesApiRoot(baseURL: string) {
  const base = baseURL.replace(/\/+$/u, '')
  return new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }

/** History → Messages turns; tool results ride in the following user turn, results first. */
export function serializeMessages(messages: readonly HistoryMessage[]) {
  const turns: Array<{ role: 'user' | 'assistant'; content: Block[] }> = []
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    const last = turns.at(-1)
    if (last?.role === role) {
      last.content = role === 'user'
        ? [...last.content.filter(block => block.type === 'tool_result'), ...blocks.filter(block => block.type === 'tool_result'), ...last.content.filter(block => block.type !== 'tool_result'), ...blocks.filter(block => block.type !== 'tool_result')]
        : [...last.content, ...blocks]
    } else {
      turns.push({ role, content: blocks })
    }
  }
  for (const message of messages) {
    if (message.role === 'user') push('user', [{ type: 'text', text: message.content }])
    else if (message.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: message.toolCallId!, content: message.content }])
    else {
      push('assistant', [
        ...message.content ? [{ type: 'text' as const, text: message.content }] : [],
        ...(message.toolCalls ?? []).map(call => ({ type: 'tool_use' as const, id: call.id, name: call.name, input: call.arguments })),
      ])
    }
  }
  return turns
}

/** Parse an SSE byte stream into the JSON payloads of its data lines. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<Record<string, unknown>> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (data) yield JSON.parse(data) as Record<string, unknown>
    }
  }
}

export function apply(ctx: Context, config: Config = {}) {
  const apiKey = process.env[API_KEY_ENV]
  if (!apiKey) throw new Error(`${API_KEY_ENV} is not set in the Node environment`)
  const root = messagesApiRoot(process.env[BASE_URL_ENV] || PUBLIC_BASE_URL)
  const model = config.model ?? 'deepseek-flash'

  ctx.llm.adapter({
    name: `deepseek:${model}`,
    async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelChunk> {
      // lesson:request
      const response = await fetch(`${root}/messages`, {
        method: 'POST',
        redirect: 'error',
        ...signal ? { signal } : {},
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: config.maxTokens ?? 4096,
          stream: true,
          ...request.system ? { system: request.system } : {},
          messages: serializeMessages(request.messages),
          ...request.tools.length ? { tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {},
        }),
      })
      // end lesson:request
      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => null) as { error?: { message?: string } } | null
        throw new Error(`DeepSeek Messages request failed with HTTP ${response.status}${detail?.error?.message ? `: ${detail.error.message}` : ''}`)
      }

      const toolBlocks = new Map<number, { id: string; name: string; json: string }>()
      for await (const event of sseEvents(response.body)) {
        if (event.type === 'error') {
          throw new Error(`DeepSeek Messages stream error: ${String((event.error as { message?: string } | undefined)?.message ?? 'unknown')}`)
        }
        if (event.type === 'content_block_start') {
          const block = event.content_block as { type: string; id?: string; name?: string }
          if (block.type === 'tool_use') toolBlocks.set(event.index as number, { id: block.id!, name: block.name!, json: '' })
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta as { type: string; text?: string; partial_json?: string }
          if (delta.type === 'text_delta' && delta.text) yield { kind: 'text', text: delta.text }
          if (delta.type === 'input_json_delta') toolBlocks.get(event.index as number)!.json += delta.partial_json ?? ''
        } else if (event.type === 'content_block_stop') {
          const tool = toolBlocks.get(event.index as number)
          if (tool) yield { kind: 'tool-call', call: { id: tool.id, name: tool.name, arguments: tool.json ? JSON.parse(tool.json) : {} } }
        } else if (event.type === 'message_stop') {
          return
        }
      }
      throw new Error('DeepSeek Messages stream ended before message_stop')
    },
  })
}
