/**
 * Teaching subset of upstream Tools (packages/core/tools/src/index.ts @ 687f282e).
 *
 * Kept: the `tools` service key with `inject = ['systemPrompt']`, register()
 * bound to the caller's effect, schemas contributed through
 * systemPrompt.tools(), duplicate names rejected, `tools/change`, and
 * distinct results for unknown tools, invalid arguments and execution failure.
 * Not kept (yet): tools/pre-execute and tools/post-execute waterfalls,
 * approval, PTC dispatch, output spill.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ToolSchema } from '../../../system-prompt/stages/main/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: Tools
  }
  interface Events {
    'tools/change'(): void
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

export type ToolResult =
  | { status: 'ok'; content: string }
  | { status: 'unknown-tool' | 'invalid-arguments' | 'failed'; content: string }

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

  async execute(name: string, args: unknown): Promise<ToolResult> {
    const entry = this.registry.get(name)
    if (!entry) return { status: 'unknown-tool', content: `unknown tool "${name}"` }
    const invalid = entry.definition.validate?.(args)
    if (invalid !== undefined) return { status: 'invalid-arguments', content: invalid }
    try {
      return { status: 'ok', content: await entry.definition.execute(args) }
    } catch (error) {
      return { status: 'failed', content: error instanceof Error ? error.message : String(error) }
    }
  }
}

export default Tools
