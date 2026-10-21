/** Static composition checks run on commit (docs/02 §9): the scope tree is sound before anything runs. */
import { devStages } from '@harness-explorer/teaching-plugins'
import { describe, expect, it } from 'vitest'
import { CompositionError, validateComposition } from '../src/index.ts'
import { lifecycleScenario, minimalChat } from './helpers.ts'

const withScopes = (scopes: Array<{ id: string; parentId: string | null; sessions?: string[] }>) => ({ ...minimalChat(), scopes })

describe('scope tree', () => {
  it('accepts nested scopes', () => {
    expect(() => validateComposition(withScopes([{ id: 'root', parentId: null }, { id: 'a', parentId: 'root' }, { id: 'b', parentId: 'a' }]), lifecycleScenario(), devStages)).not.toThrow()
  })

  it.each([
    ['a scope whose parent does not exist', [{ id: 'root', parentId: null }, { id: 'a', parentId: 'gone' }], /scope "a" has unknown parent "gone"/],
    ['a root scope with a parent', [{ id: 'root', parentId: 'a' }, { id: 'a', parentId: 'root' }], /scope "root" cannot have a parent/],
    ['a cycle', [{ id: 'root', parentId: null }, { id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }], /scope tree has a cycle/],
  ])('refuses %s', (_name, scopes, message) => {
    expect(() => validateComposition(withScopes(scopes), lifecycleScenario(), devStages)).toThrow(CompositionError)
    expect(() => validateComposition(withScopes(scopes), lifecycleScenario(), devStages)).toThrow(message)
  })
})

describe('scope sessions and instance placement', () => {
  it('accepts sessions each listed by one scope', () => {
    expect(() => validateComposition(withScopes([
      { id: 'root', parentId: null },
      { id: 'a', parentId: 'root', sessions: ['s-a'] },
      { id: 'b', parentId: 'a', sessions: ['s-b'] },
    ]), lifecycleScenario(), devStages)).not.toThrow()
  })

  it('refuses a session listed by two scopes', () => {
    const composition = withScopes([
      { id: 'root', parentId: null },
      { id: 'a', parentId: 'root', sessions: ['s-b'] },
      { id: 'b', parentId: 'a', sessions: ['s-b'] },
    ])
    expect(() => validateComposition(composition, lifecycleScenario(), devStages)).toThrow(CompositionError)
    expect(() => validateComposition(composition, lifecycleScenario(), devStages)).toThrow('session "s-b" is listed by both scope "a" and scope "b"')
  })

  it('accepts an instance placed in a scope nested inside its parent instance\'s scope', () => {
    const composition = withScopes([{ id: 'root', parentId: null }, { id: 'a', parentId: 'root' }, { id: 'b', parentId: 'a' }])
    composition.instances = composition.instances.map(instance => {
      if (instance.id === 'session') return { ...instance, scopeId: 'a' }
      if (instance.id === 'tools') return { ...instance, scopeId: 'b', parentId: 'session' }
      return instance
    })
    expect(() => validateComposition(composition, lifecycleScenario(), devStages)).not.toThrow()
  })

  it('refuses an instance in a scope outside its parent instance\'s scope', () => {
    const composition = withScopes([{ id: 'root', parentId: null }, { id: 'a', parentId: 'root' }, { id: 'b', parentId: 'a' }])
    composition.instances = composition.instances.map(instance => {
      if (instance.id === 'session') return { ...instance, scopeId: 'b' }
      if (instance.id === 'tools') return { ...instance, parentId: 'session' }
      return instance
    })
    expect(() => validateComposition(composition, lifecycleScenario(), devStages)).toThrow(CompositionError)
    expect(() => validateComposition(composition, lifecycleScenario(), devStages)).toThrow('instance "tools" is in scope "root", outside the scope "b" of its parent "session"')
  })
})
