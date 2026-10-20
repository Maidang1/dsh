/**
 * Run store capacity (docs/02 §13): usage, deletion with payload collection,
 * pinning, and automatic retention that never removes pinned or current runs.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Composition } from '@harness-explorer/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadDevCatalog } from '../src/catalog.ts'
import { RunController } from '../src/controller.ts'
import type { ControllerOptions } from '../src/controller.ts'
import { commitDraft } from '../src/experiments.ts'
import { startServer } from '../src/server.ts'
import { RunStore } from '../src/store.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
let root: string
let store: RunStore
const catalog = loadDevCatalog()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'explorer-retention-'))
  store = new RunStore(root)
})
afterEach(() => rm(root, { recursive: true, force: true }))

async function runs(count: number, options: Partial<ControllerOptions> = {}, scenarioId = 'prompt-section-lifecycle') {
  const composition: Composition = JSON.parse(await readFile(join(repo, 'fixtures/compositions/minimal-chat.json'), 'utf8'))
  const draft = await store.saveDraft({ id: `d-${Math.random()}`, parentRevisionId: null, composition, scenarioId, seed: 1 }, null)
  const revision = await commitDraft(store, catalog, draft)
  const controller = new RunController({ store, catalog, ...options })
  const ids: string[] = []
  for (let index = 0; index < count; index++) {
    const runId = await controller.run(revision.id, 'deterministic')
    await controller.whenSettled(runId)
    ids.push(runId)
    // startedAt has millisecond resolution; keep the order unambiguous.
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return { ids, controller }
}

const payloadFiles = async () => (await readdir(join(root, 'payloads'))).length

describe('usage and deletion', () => {
  it('counts runs, records and bytes', async () => {
    const { ids } = await runs(2)
    const usage = await store.usage()
    expect(usage.runs).toBe(2)
    expect(usage.records).toBe((await store.readTrace(ids[0]!)).length * 2)
    expect(usage.bytes).toBeGreaterThan(0)
    expect(usage.pinned).toEqual([])
  })

  it('keeps payloads still referenced by another run and removes orphans', async () => {
    const { ids } = await runs(2)
    const before = await payloadFiles()
    await store.deleteRun(ids[0]!)
    // Deterministic runs share every payload, so nothing becomes unreferenced.
    expect(await store.collectGarbage()).toBe(0)
    expect(await payloadFiles()).toBe(before)
    expect(await store.readTrace(ids[1]!)).not.toHaveLength(0)
    await store.deleteRun(ids[1]!)
    expect(await store.collectGarbage()).toBe(before)
    expect(await payloadFiles()).toBe(0)
  })
})

describe('automatic retention', () => {
  it('deletes the oldest unpinned runs and keeps pinned ones', async () => {
    const policy = { maxRuns: 2, maxBytes: Number.MAX_SAFE_INTEGER }
    const first = await runs(1)
    await store.setPinned(first.ids[0]!, true)
    const later = await runs(3, { retention: policy })
    const remaining = (await store.listRuns()).map(run => run.runId).sort()
    expect(remaining).toEqual([first.ids[0]!, later.ids[2]!].sort())
    expect((await store.usage()).pinned).toEqual([first.ids[0]])
  })

  it('never removes the run that just settled, even over the byte limit', async () => {
    const { ids } = await runs(3, { retention: { maxRuns: 100, maxBytes: 1 } })
    expect((await store.listRuns()).map(run => run.runId)).toEqual([ids[2]])
  })

  it('does not touch runs still marked running', async () => {
    const { ids } = await runs(2)
    await store.updateManifest(ids[0]!, { outcome: 'running' })
    expect(await store.enforceRetention({ maxRuns: 0, maxBytes: 0 })).toEqual([ids[1]])
    expect((await store.listRuns()).map(run => run.runId)).toEqual([ids[0]])
  })
})

describe('storage API', () => {
  it('reports usage, pins and deletes runs through the local server', async () => {
    const { ids, controller } = await runs(2)
    const server = await startServer({ store, catalog, controller, launchToken: 'tok', retention: { maxRuns: 9, maxBytes: 99 } })
    const call = (method: string, path: string, cookie: string, body?: unknown) => new Promise<{ status: number; json: any; headers: Record<string, unknown> }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = httpRequest(new URL(path, server.origin), {
        method,
        headers: { cookie, origin: server.origin, ...payload ? { 'content-type': 'application/json' } : {} },
      }, (res) => {
        let text = ''
        res.on('data', chunk => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null, headers: res.headers }))
      })
      req.on('error', reject)
      req.end(payload)
    })
    try {
      const login = await new Promise<string>((resolve) => {
        httpRequest(new URL('/?token=tok', server.origin), res => resolve(String(res.headers['set-cookie']).split(';')[0]!)).end()
      })
      expect((await call('GET', '/api/storage', login)).json).toMatchObject({ runs: 2, retention: { maxRuns: 9, maxBytes: 99 } })
      expect((await call('PUT', `/api/runs/${ids[0]}/pin`, login, { pinned: true })).status).toBe(200)
      expect((await call('GET', '/api/storage', login)).json.pinned).toEqual([ids[0]])
      const deleted = await call('DELETE', `/api/runs/${ids[1]}`, login)
      expect(deleted.status).toBe(200)
      expect((await call('GET', '/api/runs', login)).json.map((run: { runId: string }) => run.runId)).toEqual([ids[0]])
      expect((await call('DELETE', '/api/runs/run-missing', login)).status).toBe(404)
    } finally {
      await server.close()
    }
  })
})
