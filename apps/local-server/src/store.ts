/**
 * Local run store under `.explorer/` (docs/02-technical-architecture.md §13).
 * The control service is its only writer; persistence never depends on a
 * browser being open.
 */
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Composition, EnvironmentSnapshot, ExperimentRevision, JsonValue as JsonValueSchema, RunManifest, Scenario, TraceRecord } from '@harness-explorer/contracts'
import type { JsonValue, RunOutcome } from '@harness-explorer/contracts'
import { hashJson } from '@harness-explorer/trace'
import { z } from 'zod'

export const Draft = z.object({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  parentRevisionId: z.string().min(1).nullable(),
  composition: Composition,
  scenarioId: z.string().min(1),
  seed: z.number().int(),
})
export type Draft = z.infer<typeof Draft>

/**
 * Portable run export (docs/02 §13): everything needed to replay a run and
 * bind it to its composition without the original store. Data only.
 */
export const RunBundle = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.iso.datetime(),
  manifest: RunManifest,
  revision: ExperimentRevision,
  scenario: Scenario.nullable(),
  environment: EnvironmentSnapshot,
  records: z.array(TraceRecord),
  payloads: z.record(z.string(), JsonValueSchema),
})
export type RunBundle = z.infer<typeof RunBundle>

export interface StoreUsage {
  runs: number
  records: number
  bytes: number
  pinned: string[]
}

export interface RetentionPolicy {
  maxRuns: number
  maxBytes: number
}

export const DEFAULT_RETENTION: RetentionPolicy = { maxRuns: 200, maxBytes: 512 * 1024 * 1024 }

export class InvalidBundleError extends Error {
  override name = 'InvalidBundleError'
}

export class ConflictError extends Error {
  override name = 'ConflictError'
}

export class NotFoundError extends Error {
  override name = 'NotFoundError'
}

const safeName = (value: string) => {
  if (!/^[\w.:-]+$/.test(value)) throw new Error(`unsafe store key "${value}"`)
  return value.replaceAll(':', '-')
}

/** Trace chunk size in records; each chunk is one append-only JSONL file. */
const CHUNK = 500

export class RunStore {
  constructor(readonly root: string) {}

  private path(...parts: string[]) {
    return join(this.root, ...parts)
  }

  private async writeJson(path: string, value: unknown) {
    await mkdir(join(path, '..'), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n')
    await rename(temp, path)
  }

  private async readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    if (!existsSync(path)) throw new NotFoundError(`not found: ${path.slice(this.root.length + 1)}`)
    return schema.parse(JSON.parse(await readFile(path, 'utf8')))
  }

  // Drafts ------------------------------------------------------------------

  getDraft(id: string) {
    return this.readJson(this.path('drafts', `${safeName(id)}.json`), Draft)
  }

  /** Optimistic concurrency: the caller states the version it edited. */
  async saveDraft(draft: Omit<Draft, 'version'>, expectedVersion: number | null): Promise<Draft> {
    const path = this.path('drafts', `${safeName(draft.id)}.json`)
    const current = existsSync(path) ? await this.getDraft(draft.id) : null
    const currentVersion = current?.version ?? null
    if (currentVersion !== expectedVersion) {
      throw new ConflictError(`draft "${draft.id}" is at version ${currentVersion ?? 'none'}, not ${expectedVersion ?? 'none'}`)
    }
    const saved = Draft.parse({ ...draft, version: (currentVersion ?? 0) + 1 })
    await this.writeJson(path, saved)
    return saved
  }

  // Revisions ---------------------------------------------------------------

  /** Revisions are content-addressed and never rewritten. */
  async putRevision(revision: Omit<ExperimentRevision, 'id' | 'revisionHash'>): Promise<ExperimentRevision> {
    const revisionHash = hashJson(revision as JsonValue)
    const id = `rev-${revisionHash.slice('sha256:'.length, 'sha256:'.length + 16)}`
    const full = ExperimentRevision.parse({ ...revision, id, revisionHash })
    const path = this.path('revisions', `${id}.json`)
    if (!existsSync(path)) await this.writeJson(path, full)
    return full
  }

  async getRevision(id: string): Promise<ExperimentRevision> {
    const revision = await this.readJson(this.path('revisions', `${safeName(id)}.json`), ExperimentRevision)
    const { id: _id, revisionHash, ...content } = revision
    if (hashJson(content as JsonValue) !== revisionHash) throw new Error(`revision ${id} does not match its revisionHash`)
    return revision
  }

  // Runs --------------------------------------------------------------------

  async createRun(manifest: RunManifest, environment: EnvironmentSnapshot) {
    await this.writeJson(this.path('runs', safeName(manifest.runId), 'environment.json'), EnvironmentSnapshot.parse(environment))
    await this.writeJson(this.path('runs', safeName(manifest.runId), 'manifest.json'), RunManifest.parse(manifest))
  }

  getManifest(runId: string) {
    return this.readJson(this.path('runs', safeName(runId), 'manifest.json'), RunManifest)
  }

  getEnvironment(runId: string) {
    return this.readJson(this.path('runs', safeName(runId), 'environment.json'), EnvironmentSnapshot)
  }

  async updateManifest(runId: string, patch: Partial<Pick<RunManifest, 'outcome' | 'lastSeq' | 'completeness'>>) {
    const manifest = await this.getManifest(runId)
    await this.writeJson(this.path('runs', safeName(runId), 'manifest.json'), RunManifest.parse({ ...manifest, ...patch }))
  }

  /** Append records in seq order; payloads are written once by content hash. */
  async appendTrace(runId: string, records: readonly TraceRecord[], payloads: ReadonlyMap<string, JsonValue>) {
    for (const [ref, value] of payloads) {
      const path = this.path('payloads', `${safeName(ref)}.json`)
      if (!existsSync(path)) await this.writeJson(path, value)
    }
    const byChunk = new Map<number, string[]>()
    for (const record of records) {
      const chunk = Math.floor(record.seq / CHUNK)
      byChunk.set(chunk, [...byChunk.get(chunk) ?? [], JSON.stringify(record)])
    }
    for (const [chunk, lines] of byChunk) {
      const path = this.path('runs', safeName(runId), `trace-${chunk}.jsonl`)
      await mkdir(join(path, '..'), { recursive: true })
      await appendFile(path, lines.join('\n') + '\n')
    }
  }

  /** Records from `fromSeq`; a torn final line from a crash is ignored. */
  async readTrace(runId: string, fromSeq = 0): Promise<TraceRecord[]> {
    const dir = this.path('runs', safeName(runId))
    if (!existsSync(dir)) throw new NotFoundError(`run ${runId} not found`)
    const chunks = (await readdir(dir))
      .map(name => /^trace-(\d+)\.jsonl$/.exec(name)?.[1])
      .filter((chunk): chunk is string => chunk !== undefined)
      .map(Number)
      .filter(chunk => (chunk + 1) * CHUNK > fromSeq)
      .sort((a, b) => a - b)
    const records: TraceRecord[] = []
    for (const chunk of chunks) {
      for (const line of (await readFile(join(dir, `trace-${chunk}.jsonl`), 'utf8')).split('\n')) {
        if (!line) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        const record = TraceRecord.parse(parsed)
        if (record.seq >= fromSeq) records.push(record)
      }
    }
    return records
  }

  async getPayload(ref: string): Promise<JsonValue> {
    const path = this.path('payloads', `${safeName(ref)}.json`)
    if (!existsSync(path)) throw new NotFoundError(`payload ${ref} not found`)
    return JSON.parse(await readFile(path, 'utf8'))
  }

  async listRuns(): Promise<RunManifest[]> {
    const dir = this.path('runs')
    if (!existsSync(dir)) return []
    const manifests: RunManifest[] = []
    for (const runId of await readdir(dir)) {
      try {
        manifests.push(await this.getManifest(runId))
      } catch {
        // A run directory without a readable manifest is not listed.
      }
    }
    return manifests.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /**
   * On startup: runs still marked running were cut off by a crash. Mark them
   * interrupted and truncated at the last fully written seq.
   */
  async recoverInterrupted(): Promise<string[]> {
    const recovered: string[] = []
    for (const manifest of await this.listRuns()) {
      if (manifest.outcome !== 'running') continue
      const records = await this.readTrace(manifest.runId)
      let lastSeq = -1
      while (records[lastSeq + 1]?.seq === lastSeq + 1) lastSeq++
      await this.updateManifest(manifest.runId, { outcome: 'interrupted' satisfies RunOutcome, completeness: 'truncated', lastSeq })
      recovered.push(manifest.runId)
    }
    return recovered
  }

  // Export and import ---------------------------------------------------------

  async exportRun(runId: string): Promise<RunBundle> {
    const manifest = await this.getManifest(runId)
    const records = await this.readTrace(runId)
    const payloads: Record<string, JsonValue> = {}
    for (const ref of new Set(records.flatMap(record => [record.payloadRef, record.beforeRef, record.afterRef]).filter((ref): ref is string => !!ref))) {
      payloads[ref] = await this.getPayload(ref)
    }
    const scenarioPath = this.path('runs', safeName(runId), 'scenario.json')
    return RunBundle.parse({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      manifest,
      revision: await this.getRevision(manifest.experimentRevisionId),
      scenario: existsSync(scenarioPath) ? JSON.parse(await readFile(scenarioPath, 'utf8')) : null,
      environment: await this.getEnvironment(runId),
      records,
      payloads,
    })
  }

  async saveRunScenario(runId: string, scenario: Scenario) {
    await this.writeJson(this.path('runs', safeName(runId), 'scenario.json'), Scenario.parse(scenario))
  }

  /** Validate and store an exported run. Nothing in the bundle is executed. */
  async importRun(raw: unknown): Promise<RunManifest> {
    const parsed = RunBundle.safeParse(raw)
    if (!parsed.success) throw new InvalidBundleError(`not a run export: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
    const bundle = parsed.data
    const { manifest, revision, records } = bundle
    const { id: _id, revisionHash, ...content } = revision
    if (hashJson(content as JsonValue) !== revisionHash) throw new InvalidBundleError('revision does not match its revisionHash')
    if (manifest.revisionHash !== revisionHash || manifest.experimentRevisionId !== revision.id) {
      throw new InvalidBundleError('manifest is bound to a different revision')
    }
    records.forEach((record, index) => {
      if (record.runId !== manifest.runId) throw new InvalidBundleError(`record ${index} belongs to run ${record.runId}`)
      if (record.seq !== index) throw new InvalidBundleError(`records are not contiguous at seq ${index}`)
    })
    for (const [ref, value] of Object.entries(bundle.payloads)) {
      if (hashJson(value) !== ref) throw new InvalidBundleError(`payload ${ref} does not match its content hash`)
    }
    for (const record of records) {
      for (const ref of [record.payloadRef, record.beforeRef, record.afterRef]) {
        if (ref && !(ref in bundle.payloads)) throw new InvalidBundleError(`payload ${ref} of record ${record.seq} is missing`)
      }
    }
    if (existsSync(this.path('runs', safeName(manifest.runId)))) throw new ConflictError(`run ${manifest.runId} already exists`)

    const lastSeq = records.length - 1
    const stored: RunManifest = {
      ...manifest,
      lastSeq,
      ...manifest.outcome === 'running' ? { outcome: 'interrupted', completeness: 'truncated' } : {},
      ...lastSeq < manifest.lastSeq ? { completeness: 'truncated' } : {},
    }
    const revisionPath = this.path('revisions', `${safeName(revision.id)}.json`)
    if (!existsSync(revisionPath)) await this.writeJson(revisionPath, revision)
    await this.createRun(stored, { ...bundle.environment, cwd: '<workspace>' })
    if (bundle.scenario) await this.saveRunScenario(manifest.runId, bundle.scenario)
    await this.appendTrace(manifest.runId, records, new Map(Object.entries(bundle.payloads)))
    return stored
  }

  // Capacity ------------------------------------------------------------------

  private async dirBytes(dir: string): Promise<number> {
    if (!existsSync(dir)) return 0
    let total = 0
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      total += entry.isDirectory() ? await this.dirBytes(path) : (await stat(path)).size
    }
    return total
  }

  async pinnedRuns(): Promise<Set<string>> {
    const path = this.path('pins.json')
    return new Set(existsSync(path) ? z.array(z.string()).parse(JSON.parse(await readFile(path, 'utf8'))) : [])
  }

  /** Pinned runs are never removed by automatic retention. */
  async setPinned(runId: string, pinned: boolean) {
    await this.getManifest(runId)
    const pins = await this.pinnedRuns()
    if (pinned) pins.add(runId)
    else pins.delete(runId)
    await this.writeJson(this.path('pins.json'), [...pins].sort())
  }

  async usage(): Promise<StoreUsage> {
    const runs = await this.listRuns()
    const runBytes = await this.dirBytes(this.path('runs'))
    const payloadBytes = await this.dirBytes(this.path('payloads'))
    return {
      runs: runs.length,
      records: runs.reduce((total, run) => total + Math.max(run.lastSeq + 1, 0), 0),
      bytes: runBytes + payloadBytes,
      pinned: [...await this.pinnedRuns()].filter(runId => runs.some(run => run.runId === runId)),
    }
  }

  /**
   * Delete one run. Payloads it alone referenced are removed by
   * collectGarbage, which the caller runs while no run is writing.
   */
  async deleteRun(runId: string) {
    await this.getManifest(runId)
    await rm(this.path('runs', safeName(runId)), { recursive: true, force: true })
    const pins = await this.pinnedRuns()
    if (pins.delete(runId)) await this.writeJson(this.path('pins.json'), [...pins].sort())
  }

  /** Remove payloads no remaining run trace refers to. Unsafe while a run is being written. */
  async collectGarbage(): Promise<number> {
    const dir = this.path('payloads')
    if (!existsSync(dir)) return 0
    const referenced = new Set<string>()
    for (const run of await this.listRuns()) {
      for (const record of await this.readTrace(run.runId)) {
        for (const ref of [record.payloadRef, record.beforeRef, record.afterRef]) if (ref) referenced.add(`${safeName(ref)}.json`)
      }
    }
    let removed = 0
    for (const name of await readdir(dir)) {
      if (name.endsWith('.json') && !referenced.has(name)) {
        await rm(join(dir, name), { force: true })
        removed++
      }
    }
    return removed
  }

  /**
   * Keep the store within both limits by deleting the oldest settled,
   * unpinned runs. Runs still marked running, pinned runs and `protect` are kept.
   */
  async enforceRetention(policy: RetentionPolicy, protect: readonly string[] = []): Promise<string[]> {
    const pins = await this.pinnedRuns()
    const deleted: string[] = []
    const candidates = (await this.listRuns())
      .filter(run => run.outcome !== 'running' && !pins.has(run.runId) && !protect.includes(run.runId))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    let usage = await this.usage()
    while (candidates.length && (usage.runs > policy.maxRuns || usage.bytes > policy.maxBytes)) {
      const oldest = candidates.shift()!
      await this.deleteRun(oldest.runId)
      deleted.push(oldest.runId)
      if (usage.bytes > policy.maxBytes) await this.collectGarbage()
      usage = await this.usage()
    }
    if (deleted.length) await this.collectGarbage()
    return deleted
  }

  // Progress ------------------------------------------------------------------

  async getProgress(): Promise<JsonValue> {
    const path = this.path('progress.json')
    return existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : {}
  }

  async saveProgress(progress: JsonValue) {
    await this.writeJson(this.path('progress.json'), progress)
  }
}
