/** Line diff used by every comparison: aligned when affordable, bounded when not. */
import { describe, expect, it } from 'vitest'
import { MAX_DIFF_CELLS, diffLines } from '../src/lib/replay'

describe('diffLines', () => {
  it('aligns a change between a common head and tail', () => {
    expect(diffLines('a\nb\nc\nd', 'a\nx\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'same', text: 'd' },
    ])
    expect(diffLines('a\nb', 'a\nb\nc').map(line => line.kind)).toEqual(['same', 'same', 'added'])
  })

  it('keeps long identical runs cheap and bounds a large differing middle', () => {
    const size = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 10
    const a = Array.from({ length: size }, (_, index) => `a${index}`)
    const b = Array.from({ length: size }, (_, index) => `b${index}`)
    // Past the limit the middle is listed, not aligned: every line of A removed, every line of B added.
    const lines = diffLines(['same', ...a, 'end'].join('\n'), ['same', ...b, 'end'].join('\n'))
    expect(lines[0]).toEqual({ kind: 'same', text: 'same' })
    expect(lines.at(-1)).toEqual({ kind: 'same', text: 'end' })
    expect(lines.filter(line => line.kind === 'removed')).toHaveLength(size)
    expect(lines.filter(line => line.kind === 'added')).toHaveLength(size)
  })
})
