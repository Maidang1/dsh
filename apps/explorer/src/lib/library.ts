/**
 * Adding a plugin from the library (docs/01 §5.1). Missing services are
 * listed with the stage that would provide them, so "同时添加依赖" adds
 * exactly what the learner was shown, and nothing is filled in silently.
 */
import { ROOT_SCOPE, unsupportedConfigKeys } from '@harness-explorer/contracts'
import type { JsonValue, PluginInstance, ScopeDefinition } from '@harness-explorer/contracts'
import type { PublicStage } from './api'

export interface AdditionPlan {
  /** Stages to add in order: providers first, the chosen stage last. */
  stages: PublicStage[]
  /** Which stage provides each service that was missing. */
  providers: Array<{ service: string; stage: PublicStage }>
  /** Services no stage in the catalog provides. */
  unresolved: string[]
}

/** The latest stage of each definition, in catalog order. */
export function latestStages(stages: readonly PublicStage[]): PublicStage[] {
  const latest = new Map<string, PublicStage>()
  for (const stage of stages) latest.set(stage.pluginDefinitionId, stage)
  return [...latest.values()]
}

/**
 * Resolve the services `stage` requires that the composition does not provide
 * yet, transitively. Services resolve from the root context for every
 * instance; scopes only layer prompt sections, so they play no part here. Each missing service takes the first definition whose
 * latest stage provides it; adapters that provide nothing are never picked.
 */
export function planAddition(stages: readonly PublicStage[], instances: readonly PluginInstance[], stage: PublicStage): AdditionPlan {
  const byId = new Map(stages.map(item => [item.id, item]))
  const provided = new Set(instances.flatMap(instance => byId.get(instance.stageId)?.provides ?? []))
  const candidates = latestStages(stages)
  const plan: AdditionPlan = { stages: [], providers: [], unresolved: [] }

  const visit = (current: PublicStage) => {
    for (const service of current.requires) {
      if (provided.has(service) || plan.unresolved.includes(service)) continue
      const provider = candidates.find(item => item.provides.includes(service))
      if (!provider) {
        plan.unresolved.push(service)
        continue
      }
      provider.provides.forEach(name => provided.add(name))
      plan.providers.push({ service, stage: provider })
      visit(provider)
      plan.stages.push(provider)
    }
  }
  visit(stage)
  plan.stages.push(stage)
  return plan
}

/** Instances for `stages` in `scopeId`, with ids unique within the composition. */
export function instancesFor(stages: readonly PublicStage[], existing: readonly PluginInstance[], scopeId = ROOT_SCOPE): PluginInstance[] {
  const taken = new Set(existing.map(instance => instance.id))
  return stages.map(stage => {
    let id = stage.pluginDefinitionId
    for (let suffix = 2; taken.has(id); suffix++) id = `${stage.pluginDefinitionId}-${suffix}`
    taken.add(id)
    return { id, definitionId: stage.pluginDefinitionId, stageId: stage.id, scopeId, parentId: null, enabled: true, config: {} }
  })
}

export interface AffectedConsumer {
  instanceId: string
  /** Services the consumer requires that only the removed instance provides. */
  services: string[]
}

/**
 * Consumers that lose a provider when `instanceId` leaves the composition
 * (docs/01 §5.2). Whether they wait or stop is the runner's to report.
 */
export function affectedConsumers(stages: readonly PublicStage[], instances: readonly PluginInstance[], instanceId: string): AffectedConsumer[] {
  const byId = new Map(stages.map(item => [item.id, item]))
  const removed = instances.find(instance => instance.id === instanceId)
  if (!removed) return []
  const remaining = instances.filter(instance => instance.id !== instanceId)
  const stillProvided = new Set(remaining.flatMap(instance => byId.get(instance.stageId)?.provides ?? []))
  const lost = (byId.get(removed.stageId)?.provides ?? []).filter(service => !stillProvided.has(service))
  return remaining.flatMap(instance => {
    const services = (byId.get(instance.stageId)?.requires ?? []).filter(service => lost.includes(service))
    return services.length ? [{ instanceId: instance.id, services }] : []
  })
}

/** Why `id` cannot name a new scope, or null when it can. */
export function scopeIdProblem(id: string, scopes: readonly ScopeDefinition[]): string | null {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return '作用域名只能用小写字母、数字和连字符，并以字母开头'
  if (scopes.some(scope => scope.id === id)) return `已有作用域 ${id}`
  return null
}

/**
 * Parse edited config text. Keys outside `configKeys` are named here so the
 * learner sees them before commit refuses the draft (CTX-04).
 */
export function parseConfig(text: string, configKeys: readonly string[] | undefined): { config: { [key: string]: JsonValue } } | { problem: string } {
  let value: JsonValue
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { problem: `不是合法的 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { problem: '配置必须是 JSON 对象' }
  const unsupported = configKeys ? unsupportedConfigKeys(value, configKeys) : []
  if (unsupported.length) return { problem: `不支持的配置项：${unsupported.join('、')}（支持：${configKeys!.join('、') || '无'}）` }
  return { config: value }
}
