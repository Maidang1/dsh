/**
 * Stage 00 — the smallest Cordis plugin: a name and an apply function.
 * It is mounted and becomes active, but contributes nothing yet.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'prompt-contributor'

export function apply(ctx: Context) {
  // lesson:entry
  ctx.logger('prompt-contributor').debug('mounted')
  // end lesson:entry
}
