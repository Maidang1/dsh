/**
 * Failure paths of the control service that must not take it down or let
 * requests escape their boundaries.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Composition, JsonValue, TraceRecord } from '@harness-explorer/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDevCatalog } from '../src/catalog.ts'
import { RunController } from '../src/controller.ts'
import { commitDraft } from '../src/experiments.ts'
import { startServer } from '../src/server.ts'
import { RunStore } from '../src/store.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'explorer-robust-'))
  dirs.push(dir)
  return dir
}

class FailingStore extends RunStore {
  override async appendTrace(_runId: string, _records: readonly TraceRecord[], _payloads: ReadonlyMap<string, JsonValue>) {
    throw new Error('disk full')
  }
}

describe('run store write failures', () => {
  it('keeps the control service alive and reports the run as not saved', async () => {
    const store = new FailingStore(await tempDir())
    const catalog = loadDevCatalog()
    const composition: Composition = JSON.parse(await readFile(join(repo, 'fixtures/compositions/minimal-chat.json'), 'utf8'))
    const draft = await store.saveDraft({ id: 'd', parentRevisionId: null, composition, scenarioId: 'prompt-section-lifecycle', seed: 1 }, null)
    const revision = await commitDraft(store, catalog, draft)
    const controller = new RunController({ store, catalog })
    const runId = await controller.run(revision.id, 'deterministic')
    await controller.whenSettled(runId)
    expect(controller.phase).toBe('idle')
    expect(controller.state().error?.message).toMatch(/was not saved: disk full/)
    // In-memory results stay available for the current session.
    expect(controller.current!.records.length).toBeGreaterThan(0)
  })
})

describe('static file containment', () => {
  it('does not serve sibling directories that share the static root prefix', async () => {
    const root = await tempDir()
    const staticDir = join(root, 'out')
    await mkdir(staticDir)
    await mkdir(join(root, 'out-evil'))
    await writeFile(join(staticDir, 'index.html'), 'ok')
    await writeFile(join(root, 'out-evil', 'secret.txt'), 'secret')
    const store = new RunStore(await tempDir())
    const catalog = loadDevCatalog()
    const server = await startServer({ store, catalog, controller: new RunController({ store, catalog }), staticDir, launchToken: 't' })
    try {
      const get = (path: string, cookie?: string) => new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
        const req = httpRequest(new URL(path, server.origin), { headers: cookie ? { cookie } : {} }, (res) => {
          let body = ''
          res.on('data', chunk => { body += chunk })
          res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }))
        })
        req.on('error', reject)
        req.end()
      })
      const login = await get('/?token=t')
      const cookie = String(login.headers['set-cookie']).split(';')[0]!
      expect((await get('/', cookie)).body).toBe('ok')
      const escaped = await get('/..%2Fout-evil%2Fsecret.txt', cookie)
      expect(escaped.body).not.toContain('secret')
      expect([403, 404]).toContain(escaped.status)
      expect(login.headers['referrer-policy']).toBe('no-referrer')
      expect((await get('/%E0%A4%A', cookie)).status).toBe(400)
      expect((await get('/api/runs/%E0%A4%A', cookie)).status).toBe(400)
      expect(escaped.headers['x-content-type-options']).toBe('nosniff')
    } finally {
      await server.close()
    }
  })
})
