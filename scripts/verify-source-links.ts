/**
 * `pnpm lessons:verify-upstream`: check upstream excerpts against the pinned
 * commit. Uses UPSTREAM_DIR when set, otherwise a cached clone in .cache/upstream.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LessonBuild, verifyUpstreamRefs } from '@harness-explorer/lesson-kit'
import { ensureUpstream, outDir } from './lesson-env.ts'

const dir = ensureUpstream()
const build = LessonBuild.parse(JSON.parse(readFileSync(join(outDir, 'lessons.json'), 'utf8')))
const mismatches = await verifyUpstreamRefs(build, dir)
for (const mismatch of mismatches) console.log(`FAIL ${mismatch.id} ${mismatch.path}: ${mismatch.reason}`)
console.log(`${build.lessons.flatMap(lesson => lesson.upstreamRefs).length - mismatches.length} upstream excerpt(s) verified`)
if (mismatches.length) process.exit(1)
