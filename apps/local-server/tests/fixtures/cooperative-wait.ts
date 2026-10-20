/** Test stage: holds every pre-step until the turn is cancelled, then rejects. */
import type { Context } from '@deepseek-ai/cordis'
import '@harness-explorer/teaching-plugins'

export const name = 'cooperative-wait'

export function apply(ctx: Context) {
  ctx.on('agent/pre-step', step => new Promise((_resolve, reject) => {
    step.signal.addEventListener('abort', () => reject(step.signal.reason), { once: true })
  }))
}
