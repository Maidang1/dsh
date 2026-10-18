/**
 * Teaching subset of upstream Session (packages/core/session/src/index.ts @ 687f282e).
 *
 * Kept: the `sessions` service key, an append-only log of durable events per
 * session (turn/*, step/*, system/message, user/message, assistant/message,
 * tool/call, tool/result), and
 * the model-visible history derived from it.
 * Not kept: persistence, forking, repair, format migrations, projections.
 */
import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: Sessions
  }
  interface Events {
    'session/event'(sessionId: string, event: SessionEvent): void
  }
}

export type DurableEventType =
  | 'turn/start' | 'turn/end'
  | 'step/start' | 'step/end'
  | 'system/message' | 'user/message' | 'assistant/message'
  | 'tool/call' | 'tool/result'

export interface ToolCall {
  id: string
  name: string
  arguments: unknown
}

export interface SessionEvent {
  readonly seq: number
  readonly type: DurableEventType
  readonly turnId: string
  readonly stepId?: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: ToolCall[]
}

export class Sessions extends Service {
  private readonly logs = new Map<string, SessionEvent[]>()

  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  append(sessionId: string, event: Omit<SessionEvent, 'seq'>): SessionEvent {
    const log = this.logs.get(sessionId) ?? []
    this.logs.set(sessionId, log)
    const stored = Object.freeze({ ...event, data: Object.freeze(structuredClone(event.data)), seq: log.length })
    log.push(stored)
    this.ctx.emit('session/event', sessionId, stored)
    return stored
  }

  events(sessionId: string): readonly SessionEvent[] {
    return this.logs.get(sessionId) ?? []
  }

  /** The model-visible history: committed messages only, in log order. */
  history(sessionId: string): HistoryMessage[] {
    const messages: HistoryMessage[] = []
    for (const event of this.events(sessionId)) {
      if (event.type === 'user/message') {
        messages.push({ role: 'user', content: String(event.data['text']) })
      } else if (event.type === 'assistant/message') {
        const toolCalls = event.data['toolCalls'] as ToolCall[] | undefined
        messages.push({ role: 'assistant', content: String(event.data['text']), ...toolCalls?.length ? { toolCalls } : {} })
      } else if (event.type === 'tool/result') {
        messages.push({ role: 'tool', content: String(event.data['content']), toolCallId: String(event.data['toolCallId']) })
      }
    }
    return messages
  }
}

export default Sessions
