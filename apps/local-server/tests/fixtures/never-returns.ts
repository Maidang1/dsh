/** Test stage: holds every pre-step forever and ignores cancellation. */
import type { Context } from '@deepseek-ai/cordis'
import '@harness-explorer/teaching-plugins'

export const name = 'never-returns'

export function apply(ctx: Context) {
  ctx.on('agent/pre-step', () => new Promise(() => {}))
}
