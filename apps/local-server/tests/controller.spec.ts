/**
 * Node host integration: HOST-02, HOST-03, cancellation and SEC-01 on the
 * controller and run store, with real subprocesses.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TraceName } from '@harness-explorer/contracts'
import type { Composition, ExecutableStageDefinition, Scenario, SessionEventPayload } from '@harness-explorer/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadDevCatalog } from '../src/catalog.ts'
import type { Catalog } from '../src/catalog.ts'
import { ControlError, RunController } from '../src/controller.ts'
import type { ControllerEvent } from '../src/controller.ts'
import { commitDraft } from '../src/experiments.ts'
import { RunStore } from '../src/store.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const minimalChat = async (): Promise<Composition> => JSON.parse(await readFile(join(repo, 'fixtures/compositions/minimal-chat.json'), 'utf8'))

function testStage(name: string): ExecutableStageDefinition {
  return {
    id: `${name}@test`,
    pluginDefinitionId: name,
    origin: 'teaching',
    module: fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url)),
    sourceHash: 'test',
    requires: [],
    provides: [],
    upstreamCommit: null,
  }
}

const askOnce: Scenario = {
  id: 'ask-once',
  title: 'ask once',
  modelScriptId: 'greeting',
  memoryFiles: {},
  adapterModes: ['deterministic'],
  steps: [{ kind: 'input', id: 'ask', sessionId: 's', text: '你好' }],
}

let root: string
let store: RunStore
let catalog: Catalog

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'explorer-store-'))
  store = new RunStore(root)
  const dev = loadDevCatalog()
  catalog = {
    ...dev,
    stages: [...dev.stages, testStage('cooperative-wait'), testStage('never-returns')],
    scenarios: { ...dev.scenarios, [askOnce.id]: askOnce },
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

let draftCounter = 0
async function revisionWith(extra: string[] = [], scenarioId = 'prompt-section-lifecycle') {
  const composition = await minimalChat()
  for (const name of extra) {
    composition.instances.push({ id: name, definitionId: name, stageId: `${name}@test`, scopeId: 'root', parentId: null, enabled: true, config: {} })
  }
  const draft = await store.saveDraft({ id: `draft-${++draftCounter}`, parentRevisionId: null, composition, scenarioId, seed: 1 }, null)
  return commitDraft(store, catalog, draft)
}

describe('run lifecycle through a subprocess', () => {
  it('runs the lifecycle scenario, persists every record and returns to idle', async () => {
    const controller = new RunController({ store, catalog })
    const events: ControllerEvent[] = []
    controller.subscribe(event => events.push(event))
    const revision = await revisionWith()
    const runId = await controller.run(revision.id, 'deterministic')
    await controller.whenSettled(runId)

    expect(controller.phase).toBe('idle')
    const manifest = await store.getManifest(runId)
    expect(manifest).toMatchObject({ outcome: 'completed', completeness: 'complete', experimentRevisionId: revision.id })
    const persisted = await store.readTrace(runId)
    expect(persisted.map(record => record.seq)).toEqual([...Array(manifest.lastSeq + 1).keys()])
    expect(persisted).toEqual(controller.current!.records)
    const request = persisted.find(record => record.name === TraceName.modelRequest)!
    expect(await store.getPayload(request.payloadRef!)).toMatchObject({ system: '你是一个助手' })

    const phases = events.filter(event => event.type === 'state').map(event => event.state.phase)
    expect([...new Set(phases)]).toEqual(['validating', 'starting', 'running', 'settling', 'idle'])
    expect(events.at(-1)).toEqual({ type: 'settled', runId, finalSeq: manifest.lastSeq, outcome: 'completed', completeness: 'complete' })
  })

  it('HOST-02: rejects a second RUN while busy and uses a fresh subprocess per run', async () => {
    const controller = new RunController({ store, catalog })
    const revision = await revisionWith()
    const first = await controller.run(revision.id, 'deterministic')
    const firstPid = controller.current!.child!.pid
    await expect(controller.run(revision.id, 'deterministic')).rejects.toMatchObject({ code: 'busy' })
    await controller.whenSettled(first)
    const second = await controller.run(revision.id, 'deterministic')
    expect(controller.current!.child!.pid).not.toBe(firstPid)
    await controller.whenSettled(second)
    const [a, b] = await Promise.all([store.readTrace(first), store.readTrace(second)])
    expect(b.map(record => ({ ...record, runId: first }))).toEqual(a)
  })

  it('rejects invalid revisions before spawning anything', async () => {
    const { DEEPSEEK_API_KEY: _key, ...withoutKey } = process.env
    const controller = new RunController({ store, catalog, env: withoutKey })
    await expect(controller.run('rev-missing', 'deterministic')).rejects.toMatchObject({ code: 'not-found' })
    const revision = await revisionWith()
    await expect(controller.run(revision.id, 'real')).rejects.toThrow(/real mode needs DEEPSEEK_API_KEY/)
    const toolOnly = await revisionWith([], askOnce.id)
    await expect(controller.run(toolOnly.id, 'real')).rejects.toThrow(/does not support real mode/)
    expect(controller.phase).toBe('idle')
    expect(await store.listRuns()).toEqual([])
  })

  it('cancels cooperatively and records the aborted turn', async () => {
    const controller = new RunController({ store, catalog })
    const revision = await revisionWith(['cooperative-wait'], askOnce.id)
    const started = new Promise<void>(resolve => controller.subscribe((event) => {
      if (event.type === 'trace' && event.records.some(record => record.name === TraceName.sessionEvent)) resolve()
    }))
    const runId = await controller.run(revision.id, 'deterministic')
    await started
    expect(controller.cancel()).toBe(true)
    await controller.whenSettled(runId)
    expect((await store.getManifest(runId)).outcome).toBe('cancelled')
    const records = await store.readTrace(runId)
    const turnEnd = records
      .filter(record => record.name === TraceName.sessionEvent)
      .map(record => controller.current!.payloads.get(record.payloadRef!) as SessionEventPayload)
      .find(event => event.type === 'turn/end')
    expect(turnEnd?.data).toMatchObject({ reason: { kind: 'aborted' } })
  })

  it('terminates a run that ignores cancellation and does not claim cleanup', async () => {
    const controller = new RunController({ store, catalog, cleanupTimeoutMs: 200 })
    const revision = await revisionWith(['never-returns'], askOnce.id)
    const started = new Promise<void>(resolve => controller.subscribe((event) => {
      if (event.type === 'trace' && event.records.some(record => record.name === TraceName.sessionEvent)) resolve()
    }))
    const runId = await controller.run(revision.id, 'deterministic')
    await started
    controller.cancel()
    await controller.whenSettled(runId)
    expect(await store.getManifest(runId)).toMatchObject({ outcome: 'terminated', completeness: 'truncated' })
    expect(controller.state().error?.message).toMatch(/terminated before cleanup finished/)
    expect(controller.phase).toBe('idle')
  })
})

describe('cancelling before the subprocess exists', () => {
  it('does not start the run and settles it as cancelled', async () => {
    const controller = new RunController({ store, catalog })
    controller.subscribe((event) => {
      if (event.type === 'state' && event.state.phase === 'starting') controller.cancel()
    })
    const revision = await revisionWith()
    const runId = await controller.run(revision.id, 'deterministic')
    await controller.whenSettled(runId)
    expect(controller.current!.child).toBeNull()
    expect(await store.getManifest(runId)).toMatchObject({ outcome: 'cancelled', lastSeq: -1 })
    expect(controller.phase).toBe('idle')
  })
})

describe('trace limits through a subprocess', () => {
  it('stops the run, reports failure and marks the trace truncated', async () => {
    const controller = new RunController({ store, catalog, limits: { maxRecords: 30, maxPayloadBytes: 10_000_000 } })
    const events: ControllerEvent[] = []
    controller.subscribe(event => events.push(event))
    const revision = await revisionWith()
    const runId = await controller.run(revision.id, 'deterministic')
    await controller.whenSettled(runId)
    expect(await store.getManifest(runId)).toMatchObject({ outcome: 'failed', completeness: 'truncated', lastSeq: 29 })
    expect(events.at(-1)).toMatchObject({ type: 'settled', outcome: 'failed', completeness: 'truncated' })
    expect(controller.state().error?.message).toMatch(/trace limit reached/)
  })
})

describe('HOST-03: interrupted runs', () => {
  it('marks runs left running by a crash as interrupted and truncated at the last complete record', async () => {
    const controller = new RunController({ store, catalog })
    const revision = await revisionWith()
    const runId = await controller.run(revision.id, 'deterministic')
    await controller.whenSettled(runId)
    const records = await store.readTrace(runId)
    // Simulate a crash: manifest still running, a torn line and a missing tail.
    await store.updateManifest(runId, { outcome: 'running', lastSeq: -1 })
    const chunk = join(root, 'runs', runId, 'trace-0.jsonl')
    const lines = (await readFile(chunk, 'utf8')).trim().split('\n').slice(0, 10)
    await writeFile(chunk, lines.join('\n') + '\n{"schemaVersion":1,"runId"')

    expect(await store.recoverInterrupted()).toEqual([runId])
    expect(await store.getManifest(runId)).toMatchObject({ outcome: 'interrupted', completeness: 'truncated', lastSeq: 9 })
    expect(records.length).toBeGreaterThan(10)
  })
})

describe('SEC-01: no secrets or absolute paths at rest', () => {
  it('stores only presence flags and a workspace placeholder', async () => {
    const secret = 'sk-test-secret-value'
    const controller = new RunController({ store, catalog, env: { ...process.env, DEEPSEEK_API_KEY: secret } })
    const revision = await revisionWith()
    const runId = await controller.run(revision.id, 'deterministic')
    await controller.whenSettled(runId)
    const environment = await store.getEnvironment(runId)
    expect(environment.cwd).toBe('<workspace>')
    const files: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(dir, entry.name))
        else files.push(await readFile(join(dir, entry.name), 'utf8'))
      }
    }
    await walk(root)
    const everything = files.join('\n')
    expect(everything).not.toContain(secret)
    expect(everything).not.toContain(process.cwd())
    expect(everything).not.toContain(repo)
  })
})

describe('draft concurrency', () => {
  it('rejects a save based on a stale version', async () => {
    const composition = await minimalChat()
    const draft = { id: 'd', parentRevisionId: null, composition, scenarioId: 'prompt-section-lifecycle', seed: 1 }
    await store.saveDraft(draft, null)
    await store.saveDraft(draft, 1)
    await expect(store.saveDraft(draft, 1)).rejects.toThrow(/at version 2, not 1/)
  })

  it('refuses to commit a composition that does not compile', async () => {
    const composition = await minimalChat()
    composition.instances[0]!.stageId = 'missing@stage'
    const draft = await store.saveDraft({ id: 'd', parentRevisionId: null, composition, scenarioId: 'prompt-section-lifecycle', seed: 1 }, null)
    await expect(commitDraft(store, catalog, draft)).rejects.toBeInstanceOf(ControlError)
  })
})

describe('real mode through a subprocess (P2-06)', () => {
  it('swaps in the real adapter, records it in the manifest and keeps the key out of the store', async () => {
    const { createServer } = await import('node:http')
    const key = 'sk-subprocess-secret-1234'
    const seen: string[] = []
    const server = createServer((request, response) => {
      seen.push(String(request.headers['x-api-key']))
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const events = [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_stop' },
        ]
        response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const controller = new RunController({ store, catalog, env: { ...process.env, DEEPSEEK_API_KEY: key, DEEPSEEK_BASE_URL: baseUrl } })
      const revision = await revisionWith()
      const runId = await controller.run(revision.id, 'real')
      await controller.whenSettled(runId)
      const manifest = await store.getManifest(runId)
      expect(manifest).toMatchObject({ outcome: 'completed', adapterMode: 'real' })
      expect(Object.keys(manifest.loadedSourceHashes)).toContain('llm-deepseek@main')
      expect(Object.keys(manifest.loadedSourceHashes)).not.toContain('llm-scripted@main')
      expect(seen).toEqual(Array(4).fill(key))
      const environment = await store.getEnvironment(runId)
      expect(environment).toMatchObject({ modelProvider: 'deepseek', variables: expect.arrayContaining([{ name: 'DEEPSEEK_API_KEY', present: true, sensitive: true }]) })
      const files: string[] = []
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) await walk(join(dir, entry.name))
          else files.push(await readFile(join(dir, entry.name), 'utf8'))
        }
      }
      await walk(root)
      expect(files.join('\n')).not.toContain(key)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
