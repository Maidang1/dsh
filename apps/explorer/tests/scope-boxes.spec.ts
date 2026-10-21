/**
 * Scope containers (§2.3): one dashed box per (scope, layer, row run) so a
 * scope whose members sit in different bands — or with a non-member column
 * between them — never swallows nodes that are not its members.
 */
import { describe, expect, it } from 'vitest'
import { scopeBoxes } from '../src/lib/scope-boxes'
import type { ScopeBox } from '../src/lib/scope-boxes'

const OPTIONS = { nodeWidth: 200, nodeHeight: 84, columnGap: 64, padX: 12, padTop: 34, padBottom: 26 } as const

/** A node's rect overlaps a box when any corner region intersects. */
function overlaps(box: ScopeBox, node: { x: number; y: number }) {
  return node.x < box.x + box.width && node.x + OPTIONS.nodeWidth > box.x
    && node.y < box.y + box.height && node.y + OPTIONS.nodeHeight > box.y
}

const SCOPES = [{ id: 'root', parentId: null }, { id: 'agent-b', parentId: 'root' }]

describe('scope boxes', () => {
  it('draws one container per (scope, layer); a root instance between the bands is outside both', () => {
    // Two members of scope agent-b in L2 and L4; a root-scope instance sits in
    // the L3 band between them, in the same column.
    const instances = [
      { id: 'scoped-a', scopeId: 'agent-b' },
      { id: 'scoped-b', scopeId: 'agent-b' },
      { id: 'plain', scopeId: 'root' },
    ]
    const positions = new Map([
      ['scoped-a', { x: 400, y: 200 }],
      ['plain', { x: 400, y: 400 }],
      ['scoped-b', { x: 400, y: 600 }],
    ])
    const layers = new Map([['scoped-a', 2], ['plain', 3], ['scoped-b', 4]])
    const boxes = scopeBoxes({ scopes: SCOPES, instances, positions, layers, ...OPTIONS })
    expect(boxes).toHaveLength(2)
    expect(boxes.map(box => box.layer).sort()).toEqual([2, 4])
    for (const box of boxes) {
      expect(box.scopeId).toBe('agent-b')
      expect(box.parentId).toBe('root')
      // The box wraps its own member…
      const member = box.layer === 2 ? positions.get('scoped-a')! : positions.get('scoped-b')!
      expect(overlaps(box, member)).toBe(true)
      // …and never the root instance in the band between.
      expect(overlaps(box, positions.get('plain')!)).toBe(false)
    }
  })

  it('splits a row into runs so a non-member column between members stays outside', () => {
    // Same layer, same row: members at columns 0 and 2, a root node at column 1.
    const instances = [
      { id: 'scoped-a', scopeId: 'agent-b' },
      { id: 'plain', scopeId: 'root' },
      { id: 'scoped-b', scopeId: 'agent-b' },
    ]
    const positions = new Map([
      ['scoped-a', { x: 200, y: 200 }],
      ['plain', { x: 464, y: 200 }],
      ['scoped-b', { x: 728, y: 200 }],
    ])
    const layers = new Map([['scoped-a', 3], ['plain', 3], ['scoped-b', 3]])
    const boxes = scopeBoxes({ scopes: SCOPES, instances, positions, layers, ...OPTIONS })
    expect(boxes).toHaveLength(2)
    expect(boxes.every(box => box.layer === 3)).toBe(true)
    expect(overlaps(boxes[0]!, positions.get('scoped-a')!)).toBe(true)
    expect(overlaps(boxes[1]!, positions.get('scoped-b')!)).toBe(true)
    for (const box of boxes) expect(overlaps(box, positions.get('plain')!)).toBe(false)
  })

  it('keeps adjacent same-row members in one box and skips the root scope', () => {
    const instances = [
      { id: 'scoped-a', scopeId: 'agent-b' },
      { id: 'scoped-b', scopeId: 'agent-b' },
      { id: 'plain', scopeId: 'root' },
    ]
    const positions = new Map([
      ['scoped-a', { x: 200, y: 200 }],
      ['scoped-b', { x: 464, y: 200 }],
      ['plain', { x: 728, y: 200 }],
    ])
    const layers = new Map([['scoped-a', 3], ['scoped-b', 3], ['plain', 3]])
    const boxes = scopeBoxes({ scopes: SCOPES, instances, positions, layers, ...OPTIONS })
    expect(boxes).toHaveLength(1)
    expect(overlaps(boxes[0]!, positions.get('scoped-a')!)).toBe(true)
    expect(overlaps(boxes[0]!, positions.get('scoped-b')!)).toBe(true)
    // Adjacent member columns: the box ends where the second member ends.
    expect(overlaps(boxes[0]!, positions.get('plain')!)).toBe(false)
  })
})
