/** `pnpm lessons:build`: type-check, bundle stages, extract code and anchors, write lessons.json. */
import { execFileSync } from 'node:child_process'
import { buildLessons } from '@harness-explorer/lesson-kit'
import { buildOptions, outDir, repoRoot } from './lesson-env.ts'

execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: repoRoot, stdio: 'inherit' })
const result = await buildLessons(await buildOptions())
console.log(`built ${result.stages.length} stages and ${result.lessons.length} lesson(s) into ${outDir.slice(repoRoot.length)}`)
console.log(`contentVersion ${result.contentVersion}`)
