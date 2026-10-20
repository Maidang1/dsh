/**
 * Stage 00 — one around-listener on tools/pre-execute. It enters, delegates
 * with next(), and sees the decision on the way back out.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../../tools/stages/main/index.ts'
import { checkpoint } from '../../../shared/checkpoint.ts'

export const name = 'tool-guard'
export const inject = ['tools']

export function apply(ctx: Context) {
  // lesson:audit
  ctx.on('tools/pre-execute', async (exec, next) => {
    checkpoint(ctx, 'tool-guard:audit-enter', { tool: exec.name })
    const decision = await next()
    checkpoint(ctx, 'tool-guard:audit-return', { tool: exec.name, decision: decision.kind })
    return decision
  })
  // end lesson:audit
}
