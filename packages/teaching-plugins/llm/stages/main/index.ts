/**
 * Teaching subset of upstream Llm (packages/llm/llm/src/index.ts @ 687f282e).
 *
 * Kept: an `llm` service that owns the adapter boundary; adapters register
 * through a Cordis effect and stream chunks for a request.
 * Not kept: model routing, call config, retry policy, token accounting,
 * attribution and the full content model.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { HistoryMessage, ToolCall } from '../../../session/stages/main/index.ts'
import type { ToolSchema } from '../../../system-prompt/stages/main/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: Llm
  }
  interface Events {
    'llm/request'(request: ModelRequest): void
    'llm/response'(requestId: string, response: ModelResponse): void
  }
}

export interface ModelRequest {
  requestId: string
  system: string
  messages: HistoryMessage[]
  tools: ToolSchema[]
}

export type ModelChunk =
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; call: ToolCall }

export interface ModelResponse {
  text: string
  toolCalls: ToolCall[]
}

export interface ModelAdapter {
  readonly name: string
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelChunk>
}

export class Llm extends Service {
  private current: ModelAdapter | undefined

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /** Register the active adapter; a second concurrent adapter is rejected. */
  adapter(adapter: ModelAdapter): () => void {
    const caller = this.ctx
    return caller.effect(() => {
      if (this.current) throw new Error(`model adapter "${this.current.name}" is already registered`)
      this.current = adapter
      return () => {
        if (this.current === adapter) this.current = undefined
      }
    }, 'llm.adapter()')
  }

  /** Send one request and settle the streamed chunks into a response. */
  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const adapter = this.current
    if (!adapter) throw new Error('no model adapter is registered')
    this.ctx.emit('llm/request', request)
    const response: ModelResponse = { text: '', toolCalls: [] }
    for await (const chunk of adapter.stream(request, signal)) {
      if (chunk.kind === 'text') response.text += chunk.text
      else response.toolCalls.push(chunk.call)
    }
    this.ctx.emit('llm/response', request.requestId, response)
    return response
  }
}

export default Llm
