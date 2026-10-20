/**
 * In-memory calculator tool (project code). It registers one deterministic
 * tool so tool lessons need no shell, files or network.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../../tools/stages/main/index.ts'

export const name = 'calculator'
export const inject = ['tools']

interface AddArguments {
  a: number
  b: number
}

function isAddArguments(args: unknown): args is AddArguments {
  const value = args as Partial<AddArguments> | null
  return typeof value?.a === 'number' && typeof value.b === 'number'
}

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'add',
    description: 'Add two numbers',
    parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    validate: args => (isAddArguments(args) ? undefined : 'add expects numeric a and b'),
    execute: args => String((args as AddArguments).a + (args as AddArguments).b),
  })
}
