/** Plugin library planning (docs/01 §5.1): missing services and "同时添加依赖". */
import { Composition } from '@harness-explorer/contracts'
import { devStages } from '@harness-explorer/teaching-plugins'
import { describe, expect, it } from 'vitest'
import minimalChat from '../../../fixtures/compositions/minimal-chat.json' with { type: 'json' }
import { affectedConsumers, instancesFor, parseConfig, planAddition, scopeIdProblem, scopeRemovalProblem, scopeSessionProblem } from '../src/lib/library'
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
      ['tools', 'tools@0.2.1-rc.2'],
      ['systemPrompt', 'system-prompt@0.2.1-rc.2'],
    ])
    expect(ids(plan)).toEqual(['system-prompt@0.2.1-rc.2', 'tools@0.2.1-rc.2', 'calculator@main'])
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
    const second = instancesFor([stage('tools@0.2.1-rc.2')], composition.instances)
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

  it('checks a session added to a scope', () => {
    const scopes = [
      { id: 'root', parentId: null },
      { id: 'agent-b', parentId: 'root', sessions: ['s-b'] },
      { id: 'agent-c', parentId: 'root' },
    ]
    expect(scopeSessionProblem('s-c', scopes, 'agent-c')).toBeNull()
    expect(scopeSessionProblem('', scopes, 'agent-c')).toBe('会话 id 不能为空')
    expect(scopeSessionProblem('  ', scopes, 'agent-c')).toBe('会话 id 不能为空')
    expect(scopeSessionProblem('s c', scopes, 'agent-c')).toBe('会话 id 不能包含空白字符')
    // validateComposition refuses a repeat within one scope too ("listed by both scope X and scope X").
    expect(scopeSessionProblem('s-b', scopes, 'agent-b')).toBe('作用域 agent-b 已列出会话 s-b')
    expect(scopeSessionProblem('s-b', scopes, 'agent-c')).toBe('会话 s-b 已由作用域 agent-b 列出')
  })

  it('parses edited config and names unsupported keys before commit', () => {
    expect(parseConfig('{"text": "只用一句话"}', ['name', 'order', 'text'])).toEqual({ config: { text: '只用一句话' } })
    expect(parseConfig('{"txt": 1}', ['name', 'order', 'text'])).toEqual({ problem: '不支持的配置项：txt（支持：name、order、text）' })
    expect(parseConfig('[1]', [])).toEqual({ problem: '配置必须是 JSON 对象' })
    expect(parseConfig('{', undefined)).toMatchObject({ problem: expect.stringContaining('不是合法的 JSON') })
    // Development stages carry no keys; the runner checks them instead.
    expect(parseConfig('{"anything": true}', undefined)).toEqual({ config: { anything: true } })
  })

  it('removes only a scope nothing uses', () => {
    const scopes = [...composition.scopes, { id: 'a', parentId: 'root' }, { id: 'b', parentId: 'a' }]
    expect(scopeRemovalProblem('root', { scopes, instances: composition.instances })).toBe('根作用域不能删除')
    expect(scopeRemovalProblem('a', { scopes, instances: composition.instances })).toBe('仍有子作用域：b')
    // A session listed in the scope's `sessions` keeps the scope in use (ScopeDefinition.sessions).
    const withSession = scopes.map(scope => (scope.id === 'b' ? { ...scope, sessions: ['s-b'] } : scope))
    expect(scopeRemovalProblem('b', { scopes: withSession, instances: composition.instances })).toBe('仍有会话：s-b')
    const moved = composition.instances.map(instance => (instance.id === 'prompt-contributor' ? { ...instance, scopeId: 'b' } : instance))
    expect(scopeRemovalProblem('b', { scopes, instances: moved })).toBe('仍有实例：prompt-contributor')
    expect(scopeRemovalProblem('b', { scopes, instances: composition.instances })).toBeNull()
  })
})
