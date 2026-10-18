/**
 * Scenarios and deterministic model scripts. See docs/02-technical-architecture.md §5.2.
 */
import { z } from 'zod'
import { AdapterMode, JsonValue } from './domain.ts'

const Id = z.string().min(1)

export const ScenarioStep = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('input'), id: Id, sessionId: Id, text: z.string() }),
  z.object({ kind: z.literal('mount'), id: Id, instanceId: Id }),
  z.object({ kind: z.literal('unmount'), id: Id, instanceId: Id }),
  z.object({ kind: z.literal('snapshot'), id: Id, label: z.string() }),
  z.object({ kind: z.literal('cancel'), id: Id, afterCheckpoint: Id }),
])
export type ScenarioStep = z.infer<typeof ScenarioStep>

export const Scenario = z.object({
  id: Id,
  title: z.string(),
  steps: z.array(ScenarioStep),
  modelScriptId: Id.nullable(),
  memoryFiles: z.record(z.string(), z.string()),
  adapterModes: z.array(AdapterMode).min(1),
}).superRefine((scenario, ctx) => {
  const seen = new Set<string>()
  for (const step of scenario.steps) {
    if (seen.has(step.id)) ctx.addIssue({ code: 'custom', message: `duplicate step id "${step.id}"` })
    seen.add(step.id)
  }
  if (scenario.adapterModes.includes('deterministic') && scenario.modelScriptId === null) {
    ctx.addIssue({ code: 'custom', message: 'deterministic scenarios need a modelScriptId' })
  }
})
export type Scenario = z.infer<typeof Scenario>

export const ScriptedResponse = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), chunks: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('tool-call'), tool: Id, arguments: JsonValue }),
  z.object({ kind: z.literal('error'), name: z.string(), message: z.string() }),
])
export type ScriptedResponse = z.infer<typeof ScriptedResponse>

export const ModelScriptRule = z.object({
  id: Id,
  match: z.object({
    lastUserText: z.string().optional(),
    systemIncludes: z.array(z.string()).optional(),
    declaredTools: z.array(z.string()).optional(),
    afterToolResult: z.string().optional(),
  }),
  respond: ScriptedResponse,
  maxUses: z.number().int().positive().optional(),
})
export type ModelScriptRule = z.infer<typeof ModelScriptRule>

export const ModelScript = z.object({
  id: Id,
  rules: z.array(ModelScriptRule),
  onUnmatched: z.literal('fail'),
})
export type ModelScript = z.infer<typeof ModelScript>
