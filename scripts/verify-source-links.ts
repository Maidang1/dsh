/**
 * `pnpm lessons:verify-upstream`: check upstream excerpts against the pinned
 * commit. Uses UPSTREAM_DIR when set, otherwise a cached clone in .cache/upstream.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LessonBuild, verifyUpstreamRefs } from '@harness-explorer/lesson-kit'
import { outDir, repoRoot, upstreamCommit } from './lesson-env.ts'

let dir = process.env.UPSTREAM_DIR
if (!dir) {
  dir = join(repoRoot, '.cache/upstream')
  if (!existsSync(dir)) {
    execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', 'https://github.com/deepseek-ai/deepseek-harness', dir], { stdio: 'inherit' })
  }
  execFileSync('git', ['-C', dir, 'checkout', '--quiet', upstreamCommit], { stdio: 'inherit' })
}
const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (head !== upstreamCommit) throw new Error(`${dir} is at ${head}, expected ${upstreamCommit}`)

const build = LessonBuild.parse(JSON.parse(readFileSync(join(outDir, 'lessons.json'), 'utf8')))
const mismatches = await verifyUpstreamRefs(build, dir)
for (const mismatch of mismatches) console.log(`FAIL ${mismatch.id} ${mismatch.path}: ${mismatch.reason}`)
console.log(`${build.lessons.flatMap(lesson => lesson.upstreamRefs).length - mismatches.length} upstream excerpt(s) verified`)
if (mismatches.length) process.exit(1)
