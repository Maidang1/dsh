/**
 * P7-01 export and import, and SEC-01 for exports.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Composition } from '@harness-explorer/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadDevCatalog } from '../src/catalog.ts'
import { RunController } from '../src/controller.ts'
import { commitDraft } from '../src/experiments.ts'
import { InvalidBundleError, RunStore } from '../src/store.ts'
import type { RunBundle } from '../src/store.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const SECRET = 'sk-export-secret-5678'
let dirs: string[] = []
let source: RunStore
let bundle: RunBundle

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'explorer-export-'))
  dirs.push(dir)
  return new RunStore(dir)
}

beforeEach(async () => {
  source = await tempStore()
  const catalog = loadDevCatalog()
  const composition: Composition = JSON.parse(await readFile(join(repo, 'fixtures/compositions/minimal-chat.json'), 'utf8'))
  const draft = await source.saveDraft({ id: 'd', parentRevisionId: null, composition, scenarioId: 'prompt-section-lifecycle', seed: 1 }, null)
  const revision = await commitDraft(source, catalog, draft)
  const controller = new RunController({ store: source, catalog, env: { ...process.env, DEEPSEEK_API_KEY: SECRET } })
  const runId = await controller.run(revision.id, 'deterministic')
  await controller.whenSettled(runId)
  bundle = await source.exportRun(runId)
})

afterEach(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
  dirs = []
})

describe('run export and import', () => {
  it('round-trips a run into another store without the original', async () => {
    const target = await tempStore()
    const manifest = await target.importRun(JSON.parse(JSON.stringify(bundle)))
    expect(manifest).toEqual(bundle.manifest)
    expect(await target.readTrace(manifest.runId)).toEqual(bundle.records)
    expect(await target.getRevision(manifest.experimentRevisionId)).toEqual(bundle.revision)
    expect(bundle.scenario?.id).toBe('prompt-section-lifecycle')
    const again = await target.exportRun(manifest.runId)
    expect({ ...again, exportedAt: '' }).toEqual({ ...bundle, exportedAt: '' })
  })

  it('SEC-01: exports carry no secret values and no absolute paths', () => {
    const text = JSON.stringify(bundle)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(repo)
    expect(text).not.toContain(process.cwd())
    expect(bundle.environment.cwd).toBe('<workspace>')
  })

  it.each([
    ['a tampered payload', (copy: RunBundle) => {
      const ref = Object.keys(copy.payloads)[0]!
      copy.payloads[ref] = { forged: true }
    }, /does not match its content hash/],
    ['a tampered revision', (copy: RunBundle) => { copy.revision.seed = 99 }, /does not match its revisionHash/],
    ['a gap in the records', (copy: RunBundle) => { copy.records.splice(3, 1) }, /not contiguous at seq 3/],
    ['records of another run', (copy: RunBundle) => { copy.records[0] = { ...copy.records[0]!, runId: 'run-other' } }, /belongs to run run-other/],
    ['a missing payload', (copy: RunBundle) => { delete copy.payloads[copy.records.find(record => record.payloadRef)!.payloadRef!] }, /is missing/],
  ])('rejects %s', async (_name, tamper, message) => {
    const copy = structuredClone(bundle)
    tamper(copy)
    const target = await tempStore()
    await expect(target.importRun(copy)).rejects.toBeInstanceOf(InvalidBundleError)
    await expect(target.importRun(copy)).rejects.toThrow(message)
    expect(await target.listRuns()).toEqual([])
  })

  it('marks an exported run that never settled as interrupted', async () => {
    const copy = structuredClone(bundle)
    copy.manifest.outcome = 'running'
    copy.records = copy.records.slice(0, 20)
    const target = await tempStore()
    const manifest = await target.importRun(copy)
    expect(manifest).toMatchObject({ outcome: 'interrupted', completeness: 'truncated', lastSeq: 19 })
  })

  it('refuses to overwrite an existing run', async () => {
    await expect(source.importRun(bundle)).rejects.toThrow(/already exists/)
  })
})
