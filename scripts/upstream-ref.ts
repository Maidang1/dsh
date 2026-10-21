/**
 * `pnpm lessons:ref <id> <path> <startLine> <endLine> [symbol]`: print an
 * upstream-map entry for an excerpt of the pinned commit, with its content hash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { excerptHash } from '@harness-explorer/lesson-kit'
import { ensureUpstream } from './lesson-env.ts'

const [id, path, start, end, symbol] = process.argv.slice(2)
if (!id || !path || !start || !end) {
  console.error('usage: pnpm lessons:ref <id> <path> <startLine> <endLine> [symbol]')
  process.exit(1)
}
const source = readFileSync(join(ensureUpstream(), path), 'utf8')
const startLine = Number(start)
const endLine = Number(end)
const ref = { id, path, ...(symbol ? { symbol } : {}), startLine, endLine, contentHash: excerptHash(source, startLine, endLine) }
// Single quotes like the content files, unless the text itself holds one.
const literal = (value: string | number) => typeof value === 'number' ? String(value)
  : value.includes("'") ? JSON.stringify(value) : `'${value.replace(/\\/g, '\\\\')}'`
console.log(['  {', ...Object.entries(ref).map(([key, value]) => `    ${key}: ${literal(value)},`), '  },'].join('\n'))
