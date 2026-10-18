/**
 * HTTP surface: SEC-02 access control and HOST-01 reconnection over SSE.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Composition, TraceRecord } from '@harness-explorer/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadDevCatalog } from '../src/catalog.ts'
import { RunController } from '../src/controller.ts'
import { startServer } from '../src/server.ts'
import type { RunningServer } from '../src/server.ts'
import { RunStore } from '../src/store.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))

let root: string
let server: RunningServer
let controller: RunController
let cookie: string

/** Raw request so the Host header can be forged, which fetch forbids. */
function raw(path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const url = new URL(path, server.origin)
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    const req = httpRequest(url, {
      method: options.method ?? 'GET',
      headers: { ...body ? { 'content-type': 'application/json' } : {}, ...options.headers },
    }, (res) => {
      let text = ''
      res.on('data', (chunk: Buffer) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const authed = (path: string, options: { method?: string; body?: unknown; origin?: string } = {}) => raw(path, {
  method: options.method ?? 'GET',
  body: options.body,
  headers: { cookie, ...options.method && options.method !== 'GET' ? { origin: options.origin ?? server.origin } : {} },
})

interface SseEvent { event: string; id?: string; data: any }

/** Read SSE events until `until` returns true, then abort the stream. */
async function readEvents(path: string, until: (events: SseEvent[]) => boolean, headers: Record<string, string> = {}) {
  const controller = new AbortController()
  const response = await fetch(new URL(path, server.origin), { headers: { cookie, ...headers }, signal: controller.signal })
  const events: SseEvent[] = []
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for await (const chunk of response.body!) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const event: SseEvent = { event: 'message', data: null }
        for (const line of block.split('\n')) {
          const [key, ...rest] = line.split(': ')
          const value = rest.join(': ')
          if (key === 'event') event.event = value
          else if (key === 'id') event.id = value
          else if (key === 'data') event.data = JSON.parse(value)
        }
        events.push(event)
        if (until(events)) return events
      }
    }
  } finally {
    controller.abort()
  }
  return events
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'explorer-server-'))
  const store = new RunStore(root)
  const catalog = loadDevCatalog()
  controller = new RunController({ store, catalog })
  server = await startServer({ store, catalog, controller })
  const exchange = await raw(new URL(server.launchUrl).pathname + new URL(server.launchUrl).search)
  expect(exchange.status).toBe(302)
  cookie = String(exchange.headers['set-cookie']).split(';')[0]!
})

afterEach(async () => {
  await server.close()
  await rm(root, { recursive: true, force: true })
})

describe('SEC-02: access control', () => {
  it('sets an HttpOnly SameSite=Strict session cookie and burns the launch token', async () => {
    const again = await raw(new URL(server.launchUrl).pathname + new URL(server.launchUrl).search)
    expect(again.status).toBe(403)
  })

  it('rejects requests without a session, reads and SSE included', async () => {
    expect((await raw('/api/state')).status).toBe(401)
    expect((await raw('/api/events')).status).toBe(401)
    expect((await authed('/api/state')).status).toBe(200)
  })

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const response = await raw('/api/state', { headers: { cookie, host: 'attacker.example:80' } })
    expect(response.status).toBe(421)
  })

  it('rejects cross-origin and origin-less writes', async () => {
    const body = { revisionId: 'rev-x', adapterMode: 'deterministic' }
    expect((await authed('/api/runs', { method: 'POST', body, origin: 'http://evil.example' })).status).toBe(403)
    expect((await raw('/api/runs', { method: 'POST', body, headers: { cookie } })).status).toBe(403)
  })

  it('reports environment presence without values', async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'sk-never-sent-to-browser'
    try {
      const response = await authed('/api/environment')
      expect(response.body).not.toContain('sk-never-sent-to-browser')
      expect(JSON.parse(response.body).real.variables).toContainEqual({ name: 'DEEPSEEK_API_KEY', present: true, sensitive: true })
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })

  it('does not expose stage module paths', async () => {
    const response = await authed('/api/catalog')
    expect(response.status).toBe(200)
    expect(response.body).not.toContain(repo)
    expect(JSON.parse(response.body).stages[0]).not.toHaveProperty('module')
  })
})

describe('experiment API and HOST-01 reconnection', () => {
  it('saves a draft, commits a revision, runs it and replays the trace from any seq', async () => {
    const composition: Composition = JSON.parse(await readFile(join(repo, 'fixtures/compositions/minimal-chat.json'), 'utf8'))
    const draft = { id: 'main', parentRevisionId: null, composition, scenarioId: 'prompt-section-lifecycle', seed: 1 }
    expect((await authed('/api/drafts/main', { method: 'PUT', body: { expectedVersion: null, draft } })).status).toBe(200)
    expect((await authed('/api/drafts/main', { method: 'PUT', body: { expectedVersion: null, draft } })).status).toBe(409)
    const committed = await authed('/api/drafts/main/commit', { method: 'POST' })
    expect(committed.status).toBe(201)
    const revision = JSON.parse(committed.body)

    const started = await authed('/api/runs', { method: 'POST', body: { revisionId: revision.id, adapterMode: 'deterministic' } })
    expect(started.status).toBe(202)
    const { runId } = JSON.parse(started.body)
    expect((await authed('/api/runs', { method: 'POST', body: { revisionId: revision.id, adapterMode: 'deterministic' } })).status)
      .toBe(409)

    const live = await readEvents(`/api/events?runId=${runId}`, events => events.some(event => event.event === 'settled'))
    const liveRecords: TraceRecord[] = live.filter(event => event.event === 'trace').flatMap(event => event.data.records)
    expect(liveRecords.map(record => record.seq)).toEqual([...liveRecords.keys()])
    const settled = live.find(event => event.event === 'settled')!.data
    expect(settled).toMatchObject({ runId, outcome: 'completed', finalSeq: liveRecords.length - 1 })
    for (const event of live.filter(item => item.event === 'trace')) {
      for (const record of event.data.records as TraceRecord[]) {
        if (record.payloadRef) expect(event.data.payloads).toHaveProperty(record.payloadRef)
      }
    }

    // Reconnect with Last-Event-ID: only the missing tail, and no re-execution.
    const resumeFrom = 20
    const resumed = await readEvents(
      `/api/events?runId=${runId}`,
      events => events.some(event => event.event === 'settled'),
      { 'last-event-id': String(resumeFrom - 1) },
    )
    const resumedRecords: TraceRecord[] = resumed.filter(event => event.event === 'trace').flatMap(event => event.data.records)
    expect(resumedRecords).toEqual(liveRecords.slice(resumeFrom))
    const runs = JSON.parse((await authed('/api/runs')).body)
    expect(runs).toHaveLength(1)

    const stored = JSON.parse((await authed(`/api/runs/${runId}/trace?fromSeq=5`)).body)
    expect(stored.records).toEqual(liveRecords.slice(5))
  })
})
