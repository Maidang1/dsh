/**
 * Teaching subset of upstream Tools (packages/core/tools/src/index.ts @ 687f282e).
 *
 * Kept: the `tools` service key with `inject = ['systemPrompt']`, register()
 * bound to the caller's effect, schemas contributed through
 * systemPrompt.tools(), duplicate names rejected, `tools/change`, and
 * distinct results for unknown tools, invalid arguments and execution failure.
 * Also kept: the `tools/pre-execute` waterfall (allow or deny before the body
 * runs; a denial still passes through post-execute, as upstream's
 * 'post-result' path does) and the `tools/post-execute` waterfall (accept,
 * replace content, or block into an error).
 * Not kept: ask/approval, cancel decisions, the `tools/execute` wrapper,
 * PTC dispatch, output spill, additional contexts.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ToolSchema } from '../../../system-prompt/stages/main/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: Tools
  }
  interface Events {
    'tools/change'(): void
    'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
    'tools/post-execute'(exec: ToolExecution, result: Readonly<ToolResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
  }
}

export interface ToolDefinition extends ToolSchema {
  /** Return an error string for invalid arguments, or undefined when valid. */
  validate?(args: unknown): string | undefined
  execute(args: unknown): Promise<string> | string
}

export interface ToolEntry {
  readonly definition: ToolDefinition
  readonly owner: Context['fiber']
}

export interface ToolExecution {
  readonly name: string
  readonly arguments: unknown
}

export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }

export type PostToolDecision =
  | { kind: 'accept'; content?: string }
  | { kind: 'block'; feedback: string }

export type ToolResult =
  | { status: 'ok'; content: string }
  | { status: 'unknown-tool' | 'invalid-arguments' | 'failed' | 'denied' | 'blocked'; content: string }

export class Tools extends Service {
  static inject = ['systemPrompt']

  private readonly registry = new Map<string, ToolEntry>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
    ctx.systemPrompt.tools(() => [...this.registry.values()].map(({ definition: { name, description, parameters } }) =>
      ({ name, description, parameters })))
  }

  register(definition: ToolDefinition): () => void {
    const caller = this.ctx
    return caller.effect(() => {
      if (this.registry.has(definition.name)) {
        throw new Error(`tool "${definition.name}" is already registered`)
      }
      this.registry.set(definition.name, { definition, owner: caller.fiber })
      caller.emit('tools/change')
      return () => {
        this.registry.delete(definition.name)
        caller.emit('tools/change')
      }
    }, 'tools.register()')
  }

  entries(): ToolEntry[] {
    return [...this.registry.values()]
  }

  /**
   * Unknown tools and invalid arguments settle before any listener runs.
   * Otherwise pre-execute decides, the body runs only when allowed, and
   * post-execute sees every dispatched or denied outcome.
   */
  async execute(name: string, args: unknown): Promise<ToolResult> {
    const entry = this.registry.get(name)
    if (!entry) return { status: 'unknown-tool', content: `unknown tool "${name}"` }
    const invalid = entry.definition.validate?.(args)
    if (invalid !== undefined) return { status: 'invalid-arguments', content: invalid }

    const exec: ToolExecution = { name, arguments: args }
    // lesson:pre-execute
    const gate = await this.ctx.waterfall('tools/pre-execute', exec, () => Promise.resolve<PreToolDecision>({ kind: 'allow' }))
    // end lesson:pre-execute
    let result: ToolResult
    if (gate.kind === 'deny') {
      result = { status: 'denied', content: `Error: ${gate.reason}` }
    } else {
      try {
        result = { status: 'ok', content: await entry.definition.execute(args) }
      } catch (error) {
        result = { status: 'failed', content: error instanceof Error ? error.message : String(error) }
      }
    }
    const decision = await this.ctx.waterfall('tools/post-execute', exec, result, () => Promise.resolve<PostToolDecision>({ kind: 'accept' }))
    if (decision.kind === 'block') return { status: 'blocked', content: decision.feedback }
    return decision.content === undefined ? result : { ...result, content: decision.content }
  }
}

export default Tools
