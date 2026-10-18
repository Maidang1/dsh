import 'server-only'
/**
 * Build-time lesson data: reads lessons.json from `pnpm lessons:build`,
 * highlights every stage file with Code Hike once, and marks focus anchors and
 * lines added since the previous lesson stage. Nothing here runs in the browser.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { highlight } from 'codehike/code'
import type { HighlightedCode } from 'codehike/code'
import { LessonBuild } from '@harness-explorer/lesson-kit/schema'
import type { BuiltLesson, BuiltLessonStage, BuiltStage } from '@harness-explorer/lesson-kit/schema'
import type { SourceRef } from '@harness-explorer/contracts'

const LESSONS_JSON = join(process.cwd(), '../../packages/teaching-plugins/dist/lessons.json')
export const CODE_THEME = 'github-dark'

export function readLessonBuild(): LessonBuild | null {
  if (!existsSync(LESSONS_JSON)) return null
  return LessonBuild.parse(JSON.parse(readFileSync(LESSONS_JSON, 'utf8')))
}

export interface StageFileView {
  /** Stable across stages so the code panel animates instead of remounting. */
  key: string
  path: string
  code: HighlightedCode
  added: number
  removed: number
}

export interface LessonStageView {
  stage: BuiltLessonStage
  files: StageFileView[]
  sourceRefs: SourceRef[]
}

/** Lines of `after` that are new compared with `before` (1-based), by LCS. */
function addedLines(before: string, after: string) {
  const a = before.split('\n')
  const b = after.split('\n')
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const added: number[] = []
  let i = 0
  let j = 0
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) { i++; j++ } else if (i < a.length && table[i + 1]![j]! >= table[i]![j + 1]!) { i++ } else { added.push(++j) }
  }
  return { added, removed: a.length - table[0]![0]! }
}

/** Collapse sorted line numbers into contiguous ranges. */
function ranges(lines: number[]) {
  const result: Array<[number, number]> = []
  for (const line of lines) {
    const last = result.at(-1)
    if (last && last[1] === line - 1) last[1] = line
    else result.push([line, line])
  }
  return result
}

export async function lessonStageViews(lesson: BuiltLesson, stages: readonly BuiltStage[]): Promise<LessonStageView[]> {
  const byId = new Map(stages.map(stage => [stage.definition.id, stage]))
  const views: LessonStageView[] = []
  let previous: BuiltStage | undefined
  for (const stage of lesson.stages) {
    const code = byId.get(stage.codeStageId)!
    const files: StageFileView[] = []
    for (const [index, file] of code.files.entries()) {
      // The entry file changes path between stages; compare it with the previous entry.
      const before = index === 0 ? previous?.files[0] : previous?.files.find(item => item.path === file.path)
      const diff = before && before !== file && previous !== code ? addedLines(before.content, file.content) : { added: [], removed: 0 }
      const highlighted = await highlight({ value: file.content, lang: 'ts', meta: '' }, CODE_THEME)
      for (const ref of code.sourceRefs.filter(item => item.path === file.path && stage.focusAnchors.includes(item.symbol ?? ''))) {
        highlighted.annotations.push({ name: 'focus', query: ref.symbol ?? '', fromLineNumber: ref.startLine, toLineNumber: ref.endLine })
      }
      for (const [from, to] of ranges(diff.added)) {
        highlighted.annotations.push({ name: 'mark', query: 'added', fromLineNumber: from, toLineNumber: to })
      }
      files.push({ key: index === 0 ? 'entry' : file.path, path: file.path, code: highlighted, added: diff.added.length, removed: diff.removed })
    }
    views.push({ stage, files, sourceRefs: code.sourceRefs })
    previous = code
  }
  return views
}

/** Split lesson MDX by `## NN` headings; each section belongs to the stage whose id starts with NN. */
export function mdxSections(mdx: string, lesson: BuiltLesson): { intro: string; byStage: Record<string, string> } {
  const parts = mdx.split(/^(?=## )/m)
  const byStage: Record<string, string> = {}
  let intro = ''
  for (const part of parts) {
    const prefix = /^## (\S+)/.exec(part)?.[1]
    const stage = prefix ? lesson.stages.find(item => item.id.startsWith(prefix)) : undefined
    if (stage) byStage[stage.id] = part.replace(/^## .*\n/, '')
    else intro += part
  }
  return { intro: intro.replace(/^# .*\n/, ''), byStage }
}
