/**
 * BUILD-01 and lesson validation: the shown code and the executed module come
 * from the same files, anchors are strict, and early stages behave as stated.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TraceName } from '@harness-explorer/contracts'
import type { ModelRequestPayload } from '@harness-explorer/contracts'
import { teachingStages } from '@harness-explorer/teaching-plugins'
import { runScenario } from '@harness-explorer/teaching-runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnchorError, buildLessons, parseAnchors, sha256 } from '../src/index.ts'
import type { LessonBuild } from '../src/index.ts'
import { buildOptions, compositions, modelScripts, repoRoot, scenarios } from '../../../scripts/lesson-env.ts'

describe('anchors', () => {
  it('parses closed regions with 1-based body lines', () => {
    const source = ['a', '// lesson:one', 'x', 'y', '// end lesson:one', 'b'].join('\n')
    expect(parseAnchors(source, 'f.ts')).toEqual([{ name: 'one', startLine: 3, endLine: 4, text: 'x\ny' }])
  })

  it.each([
    ['unclosed', '// lesson:a\nx', /never closed/],
    ['duplicate', '// lesson:a\nx\n// end lesson:a\n// lesson:a\ny\n// end lesson:a', /duplicate anchor "a"/],
    ['crossed', '// lesson:a\n// lesson:b\nx\n// end lesson:a\n// end lesson:b', /does not close "b"/],
    ['empty', '// lesson:a\n// end lesson:a', /is empty/],
    ['stray end', 'x\n// end lesson:a', /does not close any open anchor/],
  ])('rejects %s anchors', (_name, source, message) => {
    expect(() => parseAnchors(source, 'f.ts')).toThrow(AnchorError)
    expect(() => parseAnchors(source, 'f.ts')).toThrow(message)
  })
})

describe('lesson build', () => {
  let outDir: string
  let build: LessonBuild

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'lessons-'))
    build = await buildLessons({ ...await buildOptions(), outDir })
  }, 120_000) // a cold cache clones upstream first
  afterAll(() => rm(outDir, { recursive: true, force: true }))

  const stage = (id: string) => build.stages.find(item => item.definition.id === id)!

  it('BUILD-01: hashes exactly the files that were bundled and shown', async () => {
    for (const built of build.stages) {
      expect(built.definition.sourceHash).toBe(sha256(built.files.map(file => `${file.path}\0${file.content}\0`).join('')))
      for (const file of built.files) expect(await readFile(join(repoRoot, file.path), 'utf8')).toBe(file.content)
      expect(existsSync(join(repoRoot, built.modulePath)) || existsSync(built.modulePath)).toBe(true)
    }
  })

  it('fails when the catalog requires differ from what the stage source injects', async () => {
    const options = await buildOptions()
    const stage = options.stages.find(item => item.id === 'tool-guard@00-observe')!
    const drifted = { ...stage, requires: ['tools', 'systemPrompt'] }
    await expect(buildLessons({ ...options, stages: [drifted], contentDir: join(outDir, 'no-content'), outDir }))
      .rejects.toThrow('stage tool-guard@00-observe injects [tools] but the catalog lists requires [systemPrompt, tools]')
  })

  it('builds only the teaching stages; upstream stages run as published and are skipped', () => {
    expect(build.stages.every(item => item.definition.origin === 'teaching')).toBe(true)
    expect(build.stages.map(item => item.definition.id).sort()).toEqual(teachingStages.map(item => item.id).sort())
  })

  it('includes runtime imports and leaves out type-only ones', () => {
    expect(stage('prompt-contributor@02-section').files.map(file => file.path))
      .toEqual(['packages/teaching-plugins/prompt-contributor/stages/02-section/index.ts'])
    // A runtime import of project code joins the bundle; `import type` does not.
    expect(stage('tool-guard@00-observe').files.map(file => file.path)).toEqual([
      'packages/teaching-plugins/tool-guard/stages/00-observe/index.ts',
      'packages/teaching-plugins/shared/checkpoint.ts',
    ])
  })

  it('turns anchors into source refs whose lines hold the anchored text', () => {
    const ref = stage('prompt-contributor@02-section').sourceRefs.find(item => item.symbol === 'section')!
    const file = stage('prompt-contributor@02-section').files[0]!.content.split('\n')
    expect(file.slice(ref.startLine - 1, ref.endLine).join('\n')).toContain('ctx.systemPrompt.section({')
    expect(ref.contentHash).toBe(sha256(file.slice(ref.startLine - 1, ref.endLine).join('\n')))
  })

  it('binds every lesson stage to the hash of the code it shows', () => {
    const lesson = build.lessons[0]!
    for (const lessonStage of lesson.stages) {
      expect(lessonStage.sourceHash).toBe(stage(lessonStage.codeStageId).definition.sourceHash)
    }
    expect(lesson.stages.find(item => item.id === '03-disposal')).toMatchObject({ kind: 'explanation', codeStageId: 'prompt-contributor@02-section' })
  })
})

describe('lesson validation', () => {
  let contentDir: string
  let outDir: string

  beforeAll(async () => {
    contentDir = await mkdtemp(join(tmpdir(), 'content-'))
    outDir = await mkdtemp(join(tmpdir(), 'lessons-'))
  })
  afterAll(async () => {
    await rm(contentDir, { recursive: true, force: true })
    await rm(outDir, { recursive: true, force: true })
  })

  let attempt = 0
  async function buildWith(edit: (manifest: string) => string) {
    // A fresh directory per case, so the module cache cannot serve a previous edit.
    const caseDir = join(contentDir, `case-${++attempt}`)
    const dir = join(caseDir, 'prompt-contributor')
    await mkdir(dir, { recursive: true })
    await cp(join(repoRoot, 'content/plugins/prompt-contributor'), dir, { recursive: true })
    await writeFile(join(dir, 'manifest.ts'), edit(await readFile(join(dir, 'manifest.ts'), 'utf8')))
    return buildLessons({ ...await buildOptions(), contentDir: caseDir, outDir })
  }

  it.each([
    ['an unknown focus anchor', (text: string) => text.replace("focusAnchors: ['inject']", "focusAnchors: ['nope']"), /focus anchor "nope" does not exist/],
    ['an unknown contract', (text: string) => text.replace("contractIds: ['PROMPT-04', 'LIFE-01']", "contractIds: ['PROMPT-99']"), /unknown contract "PROMPT-99"/],
    ['an executable stage without scenarios', (text: string) => text.replace("contractIds: ['CTX-02'],\n      scenarioIds: ['prompt-section-lifecycle']", "contractIds: ['CTX-02'],\n      scenarioIds: []"), /executable stages need scenarios and contracts/],
    ['a stage without simplifications (docs/05 §7)', (text: string) => text.replace(/simplifications: \['Cordis 的 inject[^\]]*\]/, 'simplifications: []'), /01-dependency: list at least one simplification/],
    ['a checkpoint outside the plugin namespace', (text: string) => text.replace("expectedObservations: ['依赖已解析", "expectedCheckpoints: ['agent-loop:request-prepared'],\n      expectedObservations: ['依赖已解析"), /checkpoint "agent-loop:request-prepared" is outside the "prompt-contributor:" namespace/],
    ['a code stage that does not exist', (text: string) => text.replace("codeStageId: 'prompt-contributor@00-entry'", "codeStageId: 'prompt-contributor@99'"), /is not an executable stage/],
  ])('fails on %s', async (_name, edit, message) => {
    await expect(buildWith(edit)).rejects.toThrow(message)
  })
})

describe('early stages behave as their lesson says', () => {
  // The upstream system-prompt plugin's default text: harness identity plus the fixture persona.
  const BASELINE = 'You are an AI agent powered by DeepSeek Harness.\n\n你是一个助手'
  async function requestSystems(stageId: string) {
    const base = compositions['minimal-chat']!
    const composition = {
      ...base,
      instances: base.instances.map(instance => instance.definitionId === 'prompt-contributor' ? { ...instance, stageId } : instance),
    }
    const { devStages } = await import('@harness-explorer/teaching-plugins')
    const result = await runScenario({
      runId: stageId,
      composition,
      scenario: scenarios['prompt-section-lifecycle']!,
      modelScripts: { greeting: modelScripts['greeting']! },
      stages: devStages,
      adapterMode: 'deterministic',
    })
    expect(result.outcome).toBe('completed')
    return result.recorder.records
      .filter(record => record.name === TraceName.modelRequest)
      .map(record => (result.recorder.payloads.get(record.payloadRef!) as ModelRequestPayload).system)
  }

  it('00-entry and 01-dependency leave every request equal to the baseline', async () => {
    for (const stageId of ['prompt-contributor@00-entry', 'prompt-contributor@01-dependency']) {
      expect(new Set(await requestSystems(stageId))).toEqual(new Set([BASELINE]))
    }
  })

  it('02-section changes only the requests made while the plugin is mounted', async () => {
    expect(await requestSystems('prompt-contributor@02-section')).toEqual([
      BASELINE,
      `${BASELINE}\n\n回答时使用短句`,
      BASELINE,
      `${BASELINE}\n\n回答时使用短句`,
    ])
  })
})
