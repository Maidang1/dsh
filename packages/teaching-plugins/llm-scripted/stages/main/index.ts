/**
 * Deterministic model adapter (project code, not upstream). It is an upstream
 * `LlmAdapter` registered on the `scripted` provider route, so the upstream
 * agent loop sends it real requests; it answers each one by matching
 * ModelScript rules against it and never replays a prerecorded trace. A
 * request no rule matches fails the turn.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ModelScript, ModelScriptRule } from '@harness-explorer/contracts'

/** Provider route the runner selects for deterministic runs; the model id is the script id. */
export const SCRIPTED_PROVIDER = 'scripted'

export class ScriptMismatchError extends Error {
  override name = 'ScriptMismatchError'
}

export interface Config {
  script: ModelScript
}

/** The runner injects the scenario's script, already parsed against the ModelScript contract. */
export const Config: z<Config> = z.object({
  script: z.any().required(),
})

type Message = GenerateOptions['messages'][number]

/** The text blocks of a message, joined; tool calls and other blocks carry no text. */
export function messageText(message: Message | undefined): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => (block as { type?: string }).type === 'text' ? [(block as { text: string }).text] : []).join('')
}

function matches(rule: ModelScriptRule, request: GenerateOptions): boolean {
  const { match } = rule
  const last = request.messages.at(-1)
  const lastUser = request.messages.findLast(message => message.role === 'user')
  const system = request.messages.filter(message => message.role === 'system' || message.role === 'developer').map(messageText).join('\n\n')
  if (match.lastUserText !== undefined && messageText(lastUser) !== match.lastUserText) return false
  if (match.systemIncludes?.some(text => !system.includes(text))) return false
  const declared = new Set((request.tools ?? []).map(tool => tool.name))
  if (match.declaredTools?.some(name => !declared.has(name))) return false
  if (match.afterToolResult !== undefined && (last?.role !== 'tool' || messageText(last) !== match.afterToolResult)) return false
  if (match.afterToolResult === undefined && last?.role === 'tool') return false
  return true
}

class ScriptedAdapter extends LlmAdapter {
  private readonly uses = new Map<string, number>()
  private calls = 0

  constructor(private readonly script: ModelScript) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async* stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    const rule = this.script.rules.find(candidate =>
      (this.uses.get(candidate.id) ?? 0) < (candidate.maxUses ?? Infinity) && matches(candidate, request))
    if (!rule) throw new ScriptMismatchError(`no rule of model script "${this.script.id}" matches the request`)
    this.uses.set(rule.id, (this.uses.get(rule.id) ?? 0) + 1)
    const { respond } = rule
    if (respond.kind === 'error') {
      const error = new Error(respond.message)
      error.name = respond.name
      throw error
    }
    if (respond.kind === 'tool-call') {
      if (!(request.tools ?? []).some(tool => tool.name === respond.tool)) {
        throw new ScriptMismatchError(`rule "${rule.id}" calls tool "${respond.tool}", which the request does not declare`)
      }
      const id = ToolCallId(`call-${++this.calls}`)
      const args = JSON.stringify(respond.arguments)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: respond.tool, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: respond.tool, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = respond.chunks.join('')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const chunk of respond.chunks) yield { type: 'text-delta', index: 0, text: chunk }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'llm-scripted'
export const inject = ['llm']

export function apply(ctx: Context, config: Config) {
  ctx.llm.registerAdapter([SCRIPTED_PROVIDER], new ScriptedAdapter(config.script))
}
