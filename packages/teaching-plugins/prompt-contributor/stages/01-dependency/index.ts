/**
 * Stage 01 — declare the service this plugin needs. Cordis keeps the fiber
 * pending until `systemPrompt` is available in its context, and runs apply
 * again whenever the service comes back after being lost.
 */
import type { Context } from '@deepseek-ai/cordis'
import '../../../system-prompt/stages/main/index.ts'

export const name = 'prompt-contributor'

// lesson:inject
export const inject = ['systemPrompt']
// end lesson:inject

export function apply(ctx: Context) {
  ctx.logger('prompt-contributor').debug('systemPrompt is available')
}
