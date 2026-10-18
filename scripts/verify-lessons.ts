/** `pnpm lessons:verify`: run every executable lesson stage's scenarios against the built modules. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LessonBuild, verifyStageRuns } from '@harness-explorer/lesson-kit'
import { compositions, modelScripts, outDir, repoRoot, scenarios } from './lesson-env.ts'

const build = LessonBuild.parse(JSON.parse(readFileSync(join(outDir, 'lessons.json'), 'utf8')))
const manifests = new Map<string, string>()
for (const lesson of build.lessons) {
  const manifest = (await import(join(repoRoot, 'content/plugins', lesson.id, 'manifest.ts'))).default as { compositionId: string }
  manifests.set(lesson.id, manifest.compositionId)
}
const reports = await verifyStageRuns(build, {
  repoRoot,
  compositions,
  scenarios: Object.fromEntries(Object.values(scenarios).map(scenario => [scenario.id, scenario])),
  modelScripts: Object.fromEntries(Object.values(modelScripts).map(script => [script.id, script])),
  compositionOf: id => manifests.get(id)!,
})
for (const report of reports) {
  console.log(`${report.outcome === 'completed' ? 'ok  ' : 'FAIL'} ${report.lessonId}/${report.stageId} · ${report.scenarioId}${report.error ? ` · ${report.error}` : ''}`)
}
if (reports.some(report => report.outcome !== 'completed')) process.exit(1)
