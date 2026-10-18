import { createHash } from 'node:crypto'

export interface Anchor {
  name: string
  /** 1-based, inclusive lines of the region body (markers excluded). */
  startLine: number
  endLine: number
  text: string
}

export class AnchorError extends Error {
  override name = 'AnchorError'
}

const OPEN = /^\s*\/\/ lesson:([\w:-]+)\s*$/
const CLOSE = /^\s*\/\/ end lesson:([\w:-]+)\s*$/

/**
 * Parse `// lesson:<name>` … `// end lesson:<name>` regions. Regions must be
 * unique, non-empty, closed, and closed in order; violations fail the build.
 */
export function parseAnchors(source: string, file: string): Anchor[] {
  const lines = source.split('\n')
  const open: Array<{ name: string; line: number }> = []
  const anchors: Anchor[] = []
  const seen = new Set<string>()
  lines.forEach((line, index) => {
    const lineNo = index + 1
    const opened = OPEN.exec(line)?.[1]
    const closed = CLOSE.exec(line)?.[1]
    if (opened) {
      if (seen.has(opened)) throw new AnchorError(`${file}:${lineNo}: duplicate anchor "${opened}"`)
      seen.add(opened)
      open.push({ name: opened, line: lineNo })
    } else if (closed) {
      const top = open.pop()
      if (!top || top.name !== closed) {
        throw new AnchorError(`${file}:${lineNo}: "end lesson:${closed}" does not close ${top ? `"${top.name}"` : 'any open anchor'}`)
      }
      const startLine = top.line + 1
      const endLine = lineNo - 1
      if (endLine < startLine) throw new AnchorError(`${file}:${top.line}: anchor "${closed}" is empty`)
      anchors.push({ name: closed, startLine, endLine, text: lines.slice(startLine - 1, endLine).join('\n') })
    }
  })
  if (open.length) throw new AnchorError(`${file}:${open.at(-1)!.line}: anchor "${open.at(-1)!.name}" is never closed`)
  return anchors.sort((a, b) => a.startLine - b.startLine)
}

export function sha256(text: string) {
  return 'sha256:' + createHash('sha256').update(text).digest('hex')
}

/** Hash an excerpt of a file by 1-based inclusive line range. */
export function excerptHash(source: string, startLine: number, endLine: number) {
  const lines = source.split('\n')
  if (startLine < 1 || endLine > lines.length || endLine < startLine) {
    throw new AnchorError(`range ${startLine}-${endLine} is outside a ${lines.length}-line file`)
  }
  return sha256(lines.slice(startLine - 1, endLine).join('\n'))
}
