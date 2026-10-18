/**
 * Trace record names and their payload shapes. The runtime writes these and the
 * replay reducer reads them; neither side invents names outside this list.
 */
import { z } from 'zod'
import { JsonValue, PluginPhase } from './domain.ts'

export const TraceName = {
  pluginPhase: 'plugin/phase',
  serviceChange: 'service/change',
  registrationAdd: 'registration/add',
  registrationRemove: 'registration/remove',
  dispatchEnter: 'dispatch/enter',
  dispatchReturn: 'dispatch/return',
  modelRequest: 'model/request',
  modelResponse: 'model/response',
  sessionEvent: 'session/event',
  scenarioStep: 'scenario/step',
  diagnostic: 'diagnostic',
} as const

export const PluginPhasePayload = z.object({
  phase: PluginPhase,
  dependencyStatus: z.enum(['unknown', 'missing', 'resolved']),
  reason: z.string().nullable(),
  error: z.object({ name: z.string(), message: z.string() }).nullable(),
})
export type PluginPhasePayload = z.infer<typeof PluginPhasePayload>

export const ServiceChangePayload = z.object({
  name: z.string(),
  providerInstanceId: z.string().nullable(),
  available: z.boolean(),
})
export type ServiceChangePayload = z.infer<typeof ServiceChangePayload>

export const RegistrationAddPayload = z.object({
  registrationId: z.string(),
  kind: z.enum(['prompt-section', 'tool', 'listener']),
  name: z.string(),
  scopeId: z.string(),
  detail: JsonValue,
})
export type RegistrationAddPayload = z.infer<typeof RegistrationAddPayload>

export const RegistrationRemovePayload = z.object({
  registrationId: z.string(),
})
export type RegistrationRemovePayload = z.infer<typeof RegistrationRemovePayload>

export const ModelMessage = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(z.object({ id: z.string(), name: z.string(), arguments: JsonValue })).optional(),
})
export type ModelMessage = z.infer<typeof ModelMessage>

export const ModelRequestPayload = z.object({
  requestId: z.string(),
  system: z.string(),
  messages: z.array(ModelMessage),
  tools: z.array(z.object({ name: z.string(), description: z.string(), parameters: JsonValue })),
})
export type ModelRequestPayload = z.infer<typeof ModelRequestPayload>

export const SessionEventPayload = z.object({
  sessionId: z.string(),
  type: z.string(),
  data: JsonValue,
})
export type SessionEventPayload = z.infer<typeof SessionEventPayload>

export const DiagnosticPayload = z.object({
  level: z.enum(['info', 'warning', 'error']),
  message: z.string(),
})
export type DiagnosticPayload = z.infer<typeof DiagnosticPayload>
