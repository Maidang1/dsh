import type { Context } from '@deepseek-ai/cordis'

/**
 * Project helper, not an upstream API. The teaching runtime mounts every
 * instance in a context that carries its scope chain (root first, own scope
 * last). Upstream resolves scopes through `@deepseek-ai/dsh-scope`; this
 * subset only needs the chain to layer registrations.
 */
export const SCOPE_CHAIN = Symbol.for('harness-explorer.scope-chain')

export const ROOT_SCOPE = 'root'

export function scopeChainOf(ctx: Context): readonly string[] {
  return (ctx as unknown as Record<symbol, readonly string[] | undefined>)[SCOPE_CHAIN] ?? [ROOT_SCOPE]
}

export function withScopeChain(ctx: Context, chain: readonly string[]): Context {
  return ctx.extend({ [SCOPE_CHAIN]: chain })
}
