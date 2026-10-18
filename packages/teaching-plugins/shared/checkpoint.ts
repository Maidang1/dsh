import type { Context } from '@deepseek-ai/cordis'

/**
 * Teaching checkpoints (project code, not an upstream API): named semantic
 * boundaries inside teaching code. The runtime records them as trace
 * checkpoints and may act on them, e.g. a scenario cancel step. They are not
 * pause points yet (docs/02 §12).
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'explorer/checkpoint'(name: string, data: Record<string, unknown>): void
  }
}

export function checkpoint(ctx: Context, name: string, data: Record<string, unknown> = {}) {
  ctx.emit('explorer/checkpoint', name, data)
}
