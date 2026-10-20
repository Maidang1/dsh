/** `pnpm lessons:verify`: run every executable lesson stage's scenarios against the built modules. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LessonBuild, verifyStageRuns } from '@harness-explorer/lesson-kit'
import { compositions, modelScripts, outDir, repoRoot, scenarios } from './lesson-env.ts'

const build = LessonBuild.parse(JSON.parse(readFileSync(join(outDir, 'lessons.json'), 'utf8')))
const reports = await verifyStageRuns(build, {
  repoRoot,
  compositions,
  scenarios: Object.fromEntries(Object.values(scenarios).map(scenario => [scenario.id, scenario])),
  modelScripts: Object.fromEntries(Object.values(modelScripts).map(script => [script.id, script])),
  compositionOf: id => build.lessons.find(lesson => lesson.id === id)!.compositionId,
})
const passed = (report: (typeof reports)[number]) => report.outcome === 'completed' && !report.providesMismatches.length && !report.checkpointMismatch
for (const report of reports) {
  const notes = [report.error, ...report.providesMismatches, report.checkpointMismatch].filter(Boolean).map(note => ` · ${note}`).join('')
  console.log(`${passed(report) ? 'ok  ' : 'FAIL'} ${report.lessonId}/${report.stageId} · ${report.scenarioId}${notes}`)
}
if (!reports.every(passed)) process.exit(1)
