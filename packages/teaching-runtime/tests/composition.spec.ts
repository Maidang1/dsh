/** Static composition checks run on commit (docs/02 §9): the scope tree is sound before anything runs. */
import { devStages } from '@harness-explorer/teaching-plugins'
import { describe, expect, it } from 'vitest'
import { CompositionError, validateComposition } from '../src/index.ts'
import { lifecycleScenario, minimalChat } from './helpers.ts'

const withScopes = (scopes: Array<{ id: string; parentId: string | null }>) => ({ ...minimalChat(), scopes })

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

describe('session scope chains', () => {
  const withSessionScopes = (sessionScopes: Record<string, string[]>) => {
    const composition = withScopes([{ id: 'root', parentId: null }, { id: 'a', parentId: 'root' }, { id: 'b', parentId: 'a' }])
    composition.instances = composition.instances.map(instance => (instance.id === 'agent-loop' ? { ...instance, config: { sessionScopes } } : instance))
    return composition
  }

  it('accepts chains that run from root down the scope tree', () => {
    expect(() => validateComposition(withSessionScopes({ 's-b': ['root', 'a', 'b'], 's-a': ['root', 'a'] }), lifecycleScenario(), devStages)).not.toThrow()
  })

  it.each([
    ['a scope that does not exist', { 's-b': ['root', 'gone'] }, /maps session "s-b" to scope chain \[root, gone\], which is not a chain of this composition/],
    ['a chain that skips a parent', { 's-b': ['root', 'b'] }, /expected \[root, a, b\]/],
  ])('refuses %s instead of silently dropping layers', (_name, sessionScopes, message) => {
    expect(() => validateComposition(withSessionScopes(sessionScopes), lifecycleScenario(), devStages)).toThrow(message)
  })
})
