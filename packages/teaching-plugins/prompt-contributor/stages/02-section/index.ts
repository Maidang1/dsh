/**
 * Stage 02 — contribute a named, ordered section. section() binds its
 * disposer to this plugin's Cordis effect, so unloading the plugin removes
 * the section without any cleanup code here.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../../system-prompt/stages/main/index.ts'

export const name = 'prompt-contributor'

export const inject = ['systemPrompt']

export interface Config {
  name?: string
  order?: number
  text?: string
}

export function apply(ctx: Context, config: Config = {}) {
  // lesson:section
  ctx.systemPrompt.section({
    name: config.name ?? 'lesson:style',
    order: config.order ?? 100,
    text: config.text ?? '回答时使用短句',
  })
  // end lesson:section
}
