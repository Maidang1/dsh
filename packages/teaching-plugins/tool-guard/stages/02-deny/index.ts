/**
 * Stage 02 — the inner policy denies listed tools without calling next().
 * Nothing further down the chain runs and the tool body is skipped; the
 * outer audit still sees the denial on its way back out.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import { checkpoint } from '../../../shared/checkpoint.ts'

export const name = 'tool-guard'
export const inject = ['tools']

export interface Config {
  deny?: string[]
}

/** Missing keys take the schema's defaults before apply sees the config. */
export const Config: z<Config> = z.object({
  deny: z.array(z.string()).default(['add']),
})

export function apply(ctx: Context, config: Config = {}) {
  const deny = new Set(config.deny)

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
    if (deny.has(exec.name)) {
      checkpoint(ctx, 'tool-guard:policy-deny', { tool: exec.name })
      return { kind: 'deny', reason: `${exec.name} is blocked by policy` }
    }
    const decision = await next()
    checkpoint(ctx, 'tool-guard:policy-return', { tool: exec.name, decision: decision.kind })
    return decision
  })
  // end lesson:policy
}
