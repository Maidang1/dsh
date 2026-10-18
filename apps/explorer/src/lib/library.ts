/**
 * Adding a plugin from the library (docs/01 §5.1). Missing services are
 * listed with the stage that would provide them, so "同时添加依赖" adds
 * exactly what the learner was shown, and nothing is filled in silently.
 */
import type { PluginInstance } from '@harness-explorer/contracts'
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
 * Resolve the services `stage` requires that the root scope does not provide
 * yet, transitively. Each missing service takes the first definition whose
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

/** Root-scope instances for `stages`, with ids unique within the composition. */
export function instancesFor(stages: readonly PublicStage[], existing: readonly PluginInstance[]): PluginInstance[] {
  const taken = new Set(existing.map(instance => instance.id))
  return stages.map(stage => {
    let id = stage.pluginDefinitionId
    for (let suffix = 2; taken.has(id); suffix++) id = `${stage.pluginDefinitionId}-${suffix}`
    taken.add(id)
    return { id, definitionId: stage.pluginDefinitionId, stageId: stage.id, scopeId: 'root', parentId: null, enabled: true, config: {} }
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
