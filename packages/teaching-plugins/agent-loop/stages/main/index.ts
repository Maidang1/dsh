/**
 * Teaching subset of upstream AgentLoop (packages/core/agent-loop/src/agent.ts @ 687f282e).
 *
 * Kept, in upstream order: turn/start → pre-step (assemble the prompt, then
 * the `agent/pre-step` waterfall, which may reject or empty the step) →
 * step/start → system/message and user/message committed only after the
 * request is prepared → model call → assistant/message → tool/call and
 * tool/result → step/end (always) → next step while tools ran → turn/end
 * (always) with completed / blocked / aborted / error.
 * Not kept: interrupted assistant prefixes on cancel (upstream commits
 * them with `interrupted: true`; this subset commits nothing), the inbox, retries, runtime-context snapshots, request headers,
 * max-tokens handling, compaction, subagents. Upstream injects `agents` and
 * `sessionProjections` too; this subset has no agent registry or projections.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelRequest } from '../../../llm/stages/main/index.ts'
import { renderPrompt } from '../../../system-prompt/stages/main/index.ts'
import type { PromptAssembly } from '../../../system-prompt/stages/main/index.ts'
import { ROOT_SCOPE } from '../../../shared/scope.ts'
import { checkpoint } from '../../../shared/checkpoint.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoop: AgentLoop
  }
  interface Events {
    'agent/pre-step'(step: PreStep, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
  }
}

export interface PreStep {
  sessionId: string
  turn: number
  step: number
  messages: string[]
  signal: AbortSignal
}

export type PreStepDecision =
  | { kind: 'enter'; messages: string[] }
  | { kind: 'reject'; reason: string }

export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string }

export interface Config {
  /** Scope chain (root first) used to assemble each session's prompt. */
  sessionScopes?: Record<string, string[]>
  maxSteps?: number
}

export class AgentLoop extends Service {
  static inject = ['sessions', 'llm', 'tools', 'systemPrompt']
  static Config: z<Config> = z.object({
    sessionScopes: z.dict(z.array(z.string())),
    maxSteps: z.natural(),
  })

  private readonly turns = new Map<string, number>()
  private requestCounter = 0

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'agentLoop')
  }

  /** Run one turn for `text` and resolve with how it ended. */
  async submit(sessionId: string, text: string, signal: AbortSignal = new AbortController().signal): Promise<TurnEndReason> {
    const { sessions } = this.ctx
    const turn = (this.turns.get(sessionId) ?? 0) + 1
    this.turns.set(sessionId, turn)
    const turnId = `${sessionId}:turn-${turn}`
    sessions.append(sessionId, { type: 'turn/start', turnId, data: { turn } })

    let reason: TurnEndReason = { kind: 'completed' }
    let pending = [text]
    let systemCommitted: string | undefined
    try {
      for (let step = 1; step <= (this.config.maxSteps ?? 8); step++) {
        signal.throwIfAborted()
        const assembly = this.ctx.systemPrompt.assemble(this.config.sessionScopes?.[sessionId] ?? [ROOT_SCOPE])
        const decision = await this.preStep({ sessionId, turn, step, messages: pending, signal })
        if (decision.kind === 'reject') {
          reason = { kind: 'blocked', reason: decision.reason }
          break
        }
        // An empty first step owns the turn boundary but spends no model call.
        if (step === 1 && decision.messages.every(message => message.trim() === '')) break

        const stepId = `${turnId}:step-${step}`
        sessions.append(sessionId, { type: 'step/start', turnId, stepId, data: { turn, step } })
        try {
          const ranTools = await this.step(sessionId, turnId, stepId, assembly, decision.messages, systemCommitted, signal)
          systemCommitted = renderPrompt(assembly)
          if (!ranTools) break
        } finally {
          sessions.append(sessionId, { type: 'step/end', turnId, stepId, data: { turn, step } })
        }
        pending = []
      }
    } catch (error) {
      reason = signal.aborted
        ? { kind: 'aborted' }
        : { kind: 'error', message: error instanceof Error ? error.message : String(error) }
      throw error
    } finally {
      sessions.append(sessionId, { type: 'turn/end', turnId, data: { turn, reason } })
    }
    return reason
  }

  private preStep(position: PreStep): Promise<PreStepDecision> {
    return this.ctx.waterfall('agent/pre-step', position, () =>
      Promise.resolve<PreStepDecision>({ kind: 'enter', messages: position.messages }))
  }

  /** One model call plus the tools it requested. Resolves true when tools ran. */
  private async step(
    sessionId: string,
    turnId: string,
    stepId: string,
    assembly: PromptAssembly,
    messages: string[],
    systemCommitted: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    const { sessions, llm, tools } = this.ctx
    const system = renderPrompt(assembly)
    const request: ModelRequest = {
      requestId: `request-${++this.requestCounter}`,
      system,
      messages: [...sessions.history(sessionId), ...messages.map(content => ({ role: 'user' as const, content }))],
      tools: assembly.tools,
    }
    // The request is fully prepared; only now do system and user messages become durable.
    checkpoint(this.ctx, 'agent-loop:request-prepared', { requestId: request.requestId })
    signal.throwIfAborted()
    if (system !== systemCommitted) sessions.append(sessionId, { type: 'system/message', turnId, stepId, data: { text: system } })
    for (const text of messages) sessions.append(sessionId, { type: 'user/message', turnId, stepId, data: { text } })

    const response = await llm.complete(request, signal)
    checkpoint(this.ctx, 'agent-loop:model-responded', { requestId: request.requestId })
    signal.throwIfAborted()
    sessions.append(sessionId, { type: 'assistant/message', turnId, stepId, data: { text: response.text, toolCalls: response.toolCalls } })
    for (const call of response.toolCalls) {
      sessions.append(sessionId, { type: 'tool/call', turnId, stepId, data: { callId: call.id, name: call.name, arguments: call.arguments } })
      const result = await tools.execute(call.name, call.arguments)
      sessions.append(sessionId, { type: 'tool/result', turnId, stepId, data: { toolCallId: call.id, status: result.status, content: result.content } })
    }
    return response.toolCalls.length > 0
  }
}

export default AgentLoop
