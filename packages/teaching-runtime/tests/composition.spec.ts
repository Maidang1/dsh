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
