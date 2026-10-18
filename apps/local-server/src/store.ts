/**
 * Local run store under `.explorer/` (docs/02-technical-architecture.md §13).
 * The control service is its only writer; persistence never depends on a
 * browser being open.
 */
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Composition, EnvironmentSnapshot, ExperimentRevision, RunManifest, TraceRecord } from '@harness-explorer/contracts'
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

  // Progress ------------------------------------------------------------------

  async getProgress(): Promise<JsonValue> {
    const path = this.path('progress.json')
    return existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : {}
  }

  async saveProgress(progress: JsonValue) {
    await this.writeJson(this.path('progress.json'), progress)
  }
}
