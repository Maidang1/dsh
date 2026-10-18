/**
 * Deterministic model adapter (project code, not upstream). It answers each
 * actual request by matching ModelScript rules against it; it never replays a
 * prerecorded trace. A request no rule matches fails the scenario.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelScript, ModelScriptRule } from '@harness-explorer/contracts'
import type { ModelChunk, ModelRequest } from '../../../llm/stages/main/index.ts'

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

function matches(rule: ModelScriptRule, request: ModelRequest): boolean {
  const { match } = rule
  const last = request.messages.at(-1)
  const lastUser = request.messages.findLast(message => message.role === 'user')
  if (match.lastUserText !== undefined && lastUser?.content !== match.lastUserText) return false
  if (match.systemIncludes?.some(text => !request.system.includes(text))) return false
  const declared = new Set(request.tools.map(tool => tool.name))
  if (match.declaredTools?.some(name => !declared.has(name))) return false
  if (match.afterToolResult !== undefined && (last?.role !== 'tool' || last.content !== match.afterToolResult)) return false
  if (match.afterToolResult === undefined && last?.role === 'tool') return false
  return true
}

export const name = 'llm-scripted'
export const inject = ['llm']

export function apply(ctx: Context, config: Config) {
  const uses = new Map<string, number>()
  let callCounter = 0

  ctx.llm.adapter({
    name: `scripted:${config.script.id}`,
    async *stream(request): AsyncIterable<ModelChunk> {
      const rule = config.script.rules.find(candidate =>
        (uses.get(candidate.id) ?? 0) < (candidate.maxUses ?? Infinity) && matches(candidate, request))
      if (!rule) {
        throw new ScriptMismatchError(`no rule of model script "${config.script.id}" matches request ${request.requestId}`)
      }
      uses.set(rule.id, (uses.get(rule.id) ?? 0) + 1)
      const { respond } = rule
      if (respond.kind === 'error') {
        const error = new Error(respond.message)
        error.name = respond.name
        throw error
      }
      if (respond.kind === 'tool-call') {
        if (!request.tools.some(tool => tool.name === respond.tool)) {
          throw new ScriptMismatchError(`rule "${rule.id}" calls tool "${respond.tool}", which the request does not declare`)
        }
        yield { kind: 'tool-call', call: { id: `call-${++callCounter}`, name: respond.tool, arguments: respond.arguments } }
        return
      }
      for (const text of respond.chunks) yield { kind: 'text', text }
    },
  })
}
