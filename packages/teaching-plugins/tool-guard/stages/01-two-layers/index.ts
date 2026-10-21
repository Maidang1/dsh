/**
 * Stage 01 — a second listener registered after the first runs inside it:
 * audit enters, policy enters, the default decision is made, policy returns,
 * audit returns. Both delegate, so the tool still runs.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
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

  // lesson:policy
  ctx.on('tools/pre-execute', async (exec, next) => {
    checkpoint(ctx, 'tool-guard:policy-enter', { tool: exec.name })
    const decision = await next()
    checkpoint(ctx, 'tool-guard:policy-return', { tool: exec.name, decision: decision.kind })
    return decision
  })
  // end lesson:policy
}
