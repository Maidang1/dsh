/** Shared config helpers (CTX-04). */
import { describe, expect, it } from 'vitest'
import { sameJson, unsupportedConfigKeys } from '../src/index.ts'

describe('config helpers', () => {
  it('names keys outside the supported list', () => {
    expect(unsupportedConfigKeys({ text: 'a', txt: 'b' }, ['name', 'order', 'text'])).toEqual(['txt'])
    expect(unsupportedConfigKeys({}, [])).toEqual([])
    expect(unsupportedConfigKeys([1, 2], [])).toEqual([])
  })

  it('compares JSON regardless of key order', () => {
    expect(sameJson({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { e: 3, d: 2 }] }, a: 1 })).toBe(true)
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
    expect(sameJson({ a: 1 }, { a: 1, b: null })).toBe(false)
  })
})
