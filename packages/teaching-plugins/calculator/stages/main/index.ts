/**
 * In-memory calculator tool (project code). It registers one deterministic
 * tool with upstream `tools.register()`, so tool lessons need no shell, files
 * or network.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'calculator'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'add',
    description: 'Add two numbers',
    parameters: { a: { type: 'number', required: true }, b: { type: 'number', required: true } },
    output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: (args: { a: number; b: number }) => Promise.resolve(args.a + args.b),
  }))
}
