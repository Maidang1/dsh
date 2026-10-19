/** Plugin library planning (docs/01 §5.1): missing services and "同时添加依赖". */
import { Composition } from '@harness-explorer/contracts'
import { devStages } from '@harness-explorer/teaching-plugins'
import { describe, expect, it } from 'vitest'
import minimalChat from '../../../fixtures/compositions/minimal-chat.json' with { type: 'json' }
import { affectedConsumers, instancesFor, parseConfig, planAddition, scopeIdProblem } from '../src/lib/library'
import type { PublicStage } from '../src/lib/api'

const stages: PublicStage[] = devStages.map(({ module: _module, ...stage }) => stage)
const stage = (id: string) => stages.find(item => item.id === id)!
const composition = Composition.parse(minimalChat)
const ids = (plan: { stages: PublicStage[] }) => plan.stages.map(item => item.id)

describe('plugin library', () => {
  it('adds only the plugin when the root scope already provides its services', () => {
    const plan = planAddition(stages, composition.instances, stage('calculator@main'))
    expect(ids(plan)).toEqual(['calculator@main'])
    expect(plan.providers).toEqual([])
  })

  it('lists each missing service with its provider and adds providers first, transitively', () => {
    const plan = planAddition(stages, [], stage('calculator@main'))
    expect(plan.providers.map(item => [item.service, item.stage.id])).toEqual([
      ['tools', 'tools@main'],
      ['systemPrompt', 'system-prompt@main'],
    ])
    expect(ids(plan)).toEqual(['system-prompt@main', 'tools@main', 'calculator@main'])
    expect(plan.unresolved).toEqual([])
  })

  it('reports services that no plugin provides', () => {
    const orphan: PublicStage = { ...stage('calculator@main'), id: 'orphan@main', pluginDefinitionId: 'orphan', requires: ['vectorStore'] }
    const plan = planAddition([...stages, orphan], composition.instances, orphan)
    expect(plan.unresolved).toEqual(['vectorStore'])
    expect(ids(plan)).toEqual(['orphan@main'])
  })

  it('gives every new instance an unused id', () => {
    const existing = instancesFor([stage('calculator@main'), stage('calculator@main')], composition.instances)
    expect(existing.map(item => item.id)).toEqual(['calculator', 'calculator-2'])
    const more = instancesFor([stage('calculator@main')], [...composition.instances, existing[1]!])
    expect(more.map(item => item.id)).toEqual(['calculator'])
  })

  it('lists consumers that lose their only provider on removal', () => {
    expect(affectedConsumers(stages, composition.instances, 'system-prompt')).toEqual([
      { instanceId: 'tools', services: ['systemPrompt'] },
      { instanceId: 'agent-loop', services: ['systemPrompt'] },
      { instanceId: 'prompt-contributor', services: ['systemPrompt'] },
    ])
    expect(affectedConsumers(stages, composition.instances, 'agent-loop')).toEqual([])
  })

  it('does not list consumers another instance still serves', () => {
    const second = instancesFor([stage('tools@main')], composition.instances)
    expect(affectedConsumers(stages, [...composition.instances, ...second], 'tools')).toEqual([])
  })

  it('places new instances in the chosen scope', () => {
    expect(instancesFor([stage('calculator@main')], composition.instances, 'agent-b')[0]).toMatchObject({ id: 'calculator', scopeId: 'agent-b' })
  })

  it('checks a new scope name', () => {
    expect(scopeIdProblem('agent-b', composition.scopes)).toBeNull()
    expect(scopeIdProblem('root', composition.scopes)).toBe('已有作用域 root')
    expect(scopeIdProblem('Agent B', composition.scopes)).toMatch(/小写字母/)
  })

  it('parses edited config and names unsupported keys before commit', () => {
    expect(parseConfig('{"text": "只用一句话"}', ['name', 'order', 'text'])).toEqual({ config: { text: '只用一句话' } })
    expect(parseConfig('{"txt": 1}', ['name', 'order', 'text'])).toEqual({ problem: '不支持的配置项：txt（支持：name、order、text）' })
    expect(parseConfig('[1]', [])).toEqual({ problem: '配置必须是 JSON 对象' })
    expect(parseConfig('{', undefined)).toMatchObject({ problem: expect.stringContaining('不是合法的 JSON') })
    // Development stages carry no keys; the runner checks them instead.
    expect(parseConfig('{"anything": true}', undefined)).toEqual({ config: { anything: true } })
  })
})
