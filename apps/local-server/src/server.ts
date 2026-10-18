/**
 * Single-port, same-origin local server: static UI, JSON API and SSE trace
 * subscription (docs/02-technical-architecture.md §3, §4 and §10).
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { AdapterMode } from '@harness-explorer/contracts'
import type { JsonValue, TraceRecord } from '@harness-explorer/contracts'
import { z, ZodError } from 'zod'
import type { Catalog } from './catalog.ts'
import { ControlError } from './controller.ts'
import type { ControllerEvent, RunController } from './controller.ts'
import { commitDraft } from './experiments.ts'
import { ConflictError, Draft, NotFoundError } from './store.ts'
import type { RunStore } from './store.ts'

export interface ServerOptions {
  store: RunStore
  catalog: Catalog
  controller: RunController
  port?: number
  staticDir?: string
  /** Fixed launch token for automated browser tests; random when omitted. */
  launchToken?: string
}

export interface RunningServer {
  /** Base URL plus the one-time token; printed to the terminal only. */
  launchUrl: string
  origin: string
  close(): Promise<void>
}

const SESSION_COOKIE = 'explorer_session'
const MAX_BODY = 1024 * 1024

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const RunBody = z.object({ revisionId: z.string().min(1), adapterMode: AdapterMode })
const DraftBody = z.object({ expectedVersion: z.number().int().nonnegative().nullable(), draft: Draft.omit({ version: true }) })

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function cookie(request: IncomingMessage, name: string) {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return undefined
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large')
    chunks.push(chunk as Buffer)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'request body is not JSON')
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** Public catalog view: no module paths leave the server. */
function publicCatalog(catalog: Catalog) {
  return {
    contentVersion: catalog.contentVersion,
    upstreamCommit: catalog.upstreamCommit,
    stages: catalog.stages.map(({ module: _module, ...stage }) => stage),
    scenarios: Object.values(catalog.scenarios),
  }
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const { store, catalog, controller } = options
  let launchToken: string | null = options.launchToken ?? randomBytes(24).toString('base64url')
  const sessions = new Set<string>()
  let origins: string[] = []
  let hosts: string[] = []

  const payloadsFor = (records: readonly TraceRecord[], lookup: (ref: string) => JsonValue | undefined) => {
    const payloads: Record<string, JsonValue> = {}
    for (const record of records) {
      for (const ref of [record.payloadRef, record.beforeRef, record.afterRef]) {
        if (ref && !(ref in payloads)) {
          const value = lookup(ref)
          if (value !== undefined) payloads[ref] = value
        }
      }
    }
    return payloads
  }

  async function storedPayloads(records: readonly TraceRecord[]) {
    const refs = new Set(records.flatMap(record => [record.payloadRef, record.beforeRef, record.afterRef]).filter((ref): ref is string => !!ref))
    const values = new Map<string, JsonValue>()
    for (const ref of refs) values.set(ref, await store.getPayload(ref))
    return payloadsFor(records, ref => values.get(ref))
  }

  async function events(request: IncomingMessage, response: ServerResponse, url: URL) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    const write = (event: string, data: unknown, id?: number) => {
      response.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    const runId = url.searchParams.get('runId') ?? controller.current?.runId ?? null
    const lastEventId = request.headers['last-event-id']
    let fromSeq = lastEventId !== undefined ? Number(lastEventId) + 1 : Number(url.searchParams.get('fromSeq') ?? 0)
    if (!Number.isInteger(fromSeq) || fromSeq < 0) fromSeq = 0

    // Subscribe before replaying so nothing produced meanwhile is lost; the
    // replay cursor drops anything already sent.
    let replaying = true
    const queued: ControllerEvent[] = []
    let sentThrough = fromSeq - 1
    let settledSent = false
    const sendSettled = (data: unknown) => {
      if (settledSent) return
      settledSent = true
      write('settled', data)
    }
    const forward = (event: ControllerEvent) => {
      if (event.type === 'state') return write('state', event.state)
      if (event.runId !== runId) return
      if (event.type === 'settled') return sendSettled(event)
      const fresh = event.records.filter(record => record.seq > sentThrough)
      if (!fresh.length) return
      sentThrough = fresh.at(-1)!.seq
      const run = controller.current
      write('trace', { runId, records: fresh, payloads: payloadsFor(fresh, ref => run?.payloads.get(ref)) }, sentThrough)
    }
    const unsubscribe = controller.subscribe(event => (replaying ? queued.push(event) : forward(event)))
    request.on('close', () => unsubscribe())

    write('state', controller.state())
    if (runId) {
      const current = controller.current?.runId === runId ? controller.current : null
      const backlog = current
        ? current.records.slice(fromSeq)
        : await store.readTrace(runId, fromSeq).catch(() => [])
      if (backlog.length) {
        sentThrough = backlog.at(-1)!.seq
        const payloads = current ? payloadsFor(backlog, ref => current.payloads.get(ref)) : await storedPayloads(backlog)
        write('trace', { runId, records: backlog, payloads }, sentThrough)
      }
      if (current?.finished) {
        sendSettled({ type: 'settled', runId, ...current.finished })
      } else if (!current) {
        const manifest = await store.getManifest(runId).catch(() => null)
        if (manifest && manifest.outcome !== 'running') {
          sendSettled({ type: 'settled', runId, finalSeq: manifest.lastSeq, outcome: manifest.outcome })
        }
      }
    }
    replaying = false
    for (const event of queued.splice(0)) forward(event)
  }

  async function api(request: IncomingMessage, response: ServerResponse, url: URL) {
    const method = request.method ?? 'GET'
    const parts = url.pathname.split('/').slice(2).map(decodeURIComponent)
    const route = `${method} /${parts.map((part, index) => (index % 2 === 1 ? ':id' : part)).join('/')}`

    switch (route) {
      case 'GET /catalog':
        return sendJson(response, 200, publicCatalog(catalog))
      case 'GET /lessons': {
        const lessons = catalog.lessons
        if (!lessons) throw new HttpError(404, 'lessons are not built; run pnpm lessons:build')
        return sendJson(response, 200, {
          contentVersion: lessons.contentVersion,
          upstreamCommit: lessons.upstreamCommit,
          lessons: lessons.lessons,
          stages: lessons.stages.map(({ modulePath: _modulePath, definition: { module: _module, ...definition }, ...stage }) => ({ ...stage, definition })),
        })
      }
      case 'GET /compositions':
        return sendJson(response, 200, catalog.compositions)
      case 'GET /state':
        return sendJson(response, 200, controller.state())
      case 'GET /drafts/:id':
        return sendJson(response, 200, await store.getDraft(parts[1]!))
      case 'PUT /drafts/:id': {
        const body = DraftBody.parse(await readBody(request))
        if (body.draft.id !== parts[1]) throw new HttpError(400, 'draft id does not match the URL')
        return sendJson(response, 200, await store.saveDraft(body.draft, body.expectedVersion))
      }
      case 'POST /drafts/:id/commit':
        return sendJson(response, 201, await commitDraft(store, catalog, await store.getDraft(parts[1]!)))
      case 'GET /revisions/:id':
        return sendJson(response, 200, await store.getRevision(parts[1]!))
      case 'GET /runs':
        return sendJson(response, 200, await store.listRuns())
      case 'POST /runs': {
        const body = RunBody.parse(await readBody(request))
        return sendJson(response, 202, { runId: await controller.run(body.revisionId, body.adapterMode) })
      }
      case 'POST /runs/:id/cancel':
        if (controller.current?.runId !== parts[1] || !controller.cancel()) throw new HttpError(409, `run ${parts[1]} cannot be cancelled now`)
        return sendJson(response, 202, { cancelling: parts[1] })
      case 'GET /runs/:id':
        return sendJson(response, 200, { manifest: await store.getManifest(parts[1]!), environment: await store.getEnvironment(parts[1]!) })
      case 'GET /runs/:id/trace': {
        const fromSeq = Number(url.searchParams.get('fromSeq') ?? 0)
        const records = await store.readTrace(parts[1]!, Number.isInteger(fromSeq) && fromSeq > 0 ? fromSeq : 0)
        return sendJson(response, 200, { records, payloads: await storedPayloads(records) })
      }
      case 'GET /payloads/:id':
        return sendJson(response, 200, await store.getPayload(parts[1]!))
      case 'GET /events':
        return events(request, response, url)
      default:
        throw new HttpError(404, `no route ${method} ${url.pathname}`)
    }
  }

  function serveStatic(response: ServerResponse, url: URL) {
    const dir = options.staticDir
    if (!dir || !existsSync(dir)) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><meta charset="utf-8"><title>Harness Explorer</title><p>界面尚未构建。API 位于 /api。</p>')
      return
    }
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
    let path = join(dir, relative)
    if (!path.startsWith(dir)) throw new HttpError(403, 'path escapes the static root')
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html')
    if (!existsSync(path) && existsSync(`${path}.html`)) path = `${path}.html`
    if (!existsSync(path)) throw new HttpError(404, 'not found')
    response.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    response.end(readFileSync(path))
  }

  const server = createServer(async (request, response) => {
    try {
      // DNS rebinding: only our own host names are accepted.
      if (!hosts.includes(request.headers.host ?? '')) throw new HttpError(421, 'unexpected Host header')
      const url = new URL(request.url ?? '/', origins[0])

      // Exchange the one-time launch token for a session cookie.
      const token = url.searchParams.get('token')
      if (token !== null && request.method === 'GET') {
        if (!launchToken || !safeEqual(token, launchToken)) throw new HttpError(403, 'invalid or used launch token')
        launchToken = null
        const session = randomBytes(24).toString('base64url')
        sessions.add(session)
        response.writeHead(302, {
          location: url.pathname,
          'set-cookie': `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
        })
        response.end()
        return
      }

      const session = cookie(request, SESSION_COOKIE)
      if (!session || !sessions.has(session)) throw new HttpError(401, 'open the launch URL printed in the terminal')
      if (request.method !== 'GET' && request.method !== 'HEAD' && !origins.includes(request.headers.origin ?? '')) {
        throw new HttpError(403, 'cross-origin write rejected')
      }
      if (url.pathname.startsWith('/api/')) await api(request, response, url)
      else serveStatic(response, url)
    } catch (error) {
      if (response.headersSent) {
        response.end()
        return
      }
      const status = error instanceof HttpError ? error.status
        : error instanceof ControlError ? { busy: 409, invalid: 400, 'not-found': 404, internal: 500 }[error.code]
          : error instanceof ConflictError ? 409
            : error instanceof NotFoundError ? 404
              : error instanceof ZodError ? 400
                : 500
      const message = error instanceof ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
        : error instanceof Error ? error.message : String(error)
      sendJson(response, status, { error: { status, message: status === 500 ? 'internal error' : message } })
      if (status === 500) console.error(error)
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('server has no TCP address'))
      const port = address.port
      hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
      origins = hosts.map(host => `http://${host}`)
      resolve({
        launchUrl: `${origins[0]}/?token=${launchToken}`,
        origin: origins[0]!,
        close: () => new Promise<void>((done) => {
          server.closeAllConnections()
          server.close(() => done())
        }),
      })
    })
  })
}
