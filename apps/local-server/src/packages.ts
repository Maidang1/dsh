/**
 * Installs `@deepseek-ai/dsh-*` add-on packages from npm into
 * `.explorer/packages` and turns each into an upstream stage of the catalog.
 * The install root lives inside the repository so imports of shared packages
 * (cordis, dsh-tools, …) resolve upwards to the one copy the kernel uses;
 * anything npm duplicated locally is deleted after each install.
 */
import { execFile, fork } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ExecutableStageDefinition, PluginResponsibility } from '@harness-explorer/contracts'
import { UPSTREAM_SCOPE, UPSTREAM_VERSION, upstreamStage } from '@harness-explorer/teaching-plugins'
import type { Catalog } from './catalog.ts'
import { ControlError } from './controller.ts'
import type { RunController } from './controller.ts'
import { RUN_VARIABLES } from './environment.ts'

const REGISTRY = 'https://registry.npmjs.org'
const CACHE_MS = 5 * 60_000
const NPM_TIMEOUT_MS = 120_000
const INSPECT_TIMEOUT_MS = 30_000
const NAME_PATTERN = /^@deepseek-ai\/[a-z0-9][a-z0-9.-]*$/
/**
 * Every npm call against the install root uses the install flags: an uninstall
 * without --legacy-peer-deps would rebuild the tree with extra local peers.
 */
const NPM_FLAGS = ['--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund']

export interface PackageManifest {
  name: string
  version?: string
  description?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/** The registry calls PackageManager needs; tests stub this. */
export interface Registry {
  /** The manifest of name@version, or null when there is no such release. */
  manifest(name: string, version: string): Promise<PackageManifest | null>
  /** Every published version of a package, or null when it does not exist. */
  versions(name: string): Promise<string[] | null>
  /** Registry text search. */
  search(text: string): Promise<Array<{ name: string; description: string; version: string }>>
}

/** Runs npm; tests stub this. */
export type NpmRunner = (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<void>

export interface InstalledPackage {
  name: string
  version: string
  definitionId: string
  installedAt: string
}

export interface PackageSearchResult {
  name: string
  description: string
  version: string
  /** Whether the package has a release at UPSTREAM_VERSION; null when not checked. */
  available: boolean | null
  installed: boolean
}

interface PackageInspection {
  name: string | null
  inject: string[]
  configKeys: string[]
  hasDefault: boolean
  provides: string[]
}

/** npmjs.com with a 5-minute in-memory cache; 404 answers null. */
export class NpmRegistry implements Registry {
  private readonly cache = new Map<string, { at: number; value: unknown }>()

  private async fetchJson<T>(url: string): Promise<T | null> {
    const cached = this.cache.get(url)
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value as T | null
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    const value = response.status === 404 ? null
      : response.ok ? await response.json()
        : (() => { throw new Error(`registry answered ${response.status} for ${url}`) })()
    this.cache.set(url, { at: Date.now(), value })
    return value as T | null
  }

  async manifest(name: string, version: string) {
    return this.fetchJson<PackageManifest>(`${REGISTRY}/${name}/${version}`)
  }

  async versions(name: string) {
    const packument = await this.fetchJson<{ versions?: Record<string, unknown> }>(`${REGISTRY}/${name}`)
    return packument ? Object.keys(packument.versions ?? {}) : null
  }

  async search(text: string) {
    const result = await this.fetchJson<{ objects?: Array<{ package: { name: string; description?: string; version?: string } }> }>(
      `${REGISTRY}/-/v1/search?text=${encodeURIComponent(text)}&size=50`,
    )
    return (result?.objects ?? []).map(object => ({
      name: object.package.name,
      description: object.package.description ?? '',
      version: object.package.version ?? '',
    }))
  }
}

/** The server env without the run secrets: npm and the inspector never see DEEPSEEK_API_KEY & co. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const variable of Object.values(RUN_VARIABLES).flat()) {
    if (variable.sensitive) delete env[variable.name]
  }
  return env
}

/** npm via execFile: no shell, so a crafted package name cannot inject commands. */
export const runNpm: NpmRunner = (args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile('npm', args, { cwd, timeout: timeoutMs, env: scrubbedEnv() }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`npm ${args[0]} failed: ${stderr.trim() || error.message}`))
      else resolve()
    })
  })

function parseVersion(version: string) {
  const dash = version.indexOf('-')
  const [major = 0, minor = 0, patch = 0] = (dash < 0 ? version : version.slice(0, dash)).split('.').map(Number)
  return { major, minor, patch, pre: dash < 0 ? '' : version.slice(dash + 1) }
}

function compareVersions(a: string, b: string) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
    || (left.pre === right.pre ? 0 : left.pre === '' ? 1 : right.pre === '' ? -1 : left.pre < right.pre ? -1 : 1)
}

/** The specs upstream publishes: exact pins, ^ and ~ ranges, and *. */
export function satisfies(version: string, spec: string): boolean {
  const trimmed = spec.trim()
  if (trimmed === '*' || trimmed === '') return true
  const range = trimmed.startsWith('^') || trimmed.startsWith('~') ? trimmed[0] : null
  if (!range) return version === trimmed
  const v = parseVersion(version)
  const target = parseVersion(trimmed.slice(1))
  if (compareVersions(version, trimmed.slice(1)) < 0) return false
  if (range === '^') return v.major === target.major
  return v.major === target.major && v.minor === target.minor
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

function responsibilityOf(name: string): PluginResponsibility {
  const short = name.slice(UPSTREAM_SCOPE.length)
  if (short.startsWith('dsh-tool-')) return 'tool'
  if (short.startsWith('dsh-llm-')) return 'model'
  if (short.startsWith('dsh-session-')) return 'session'
  if (short.startsWith('dsh-agent-')) return 'agent-loop'
  if (short.includes('prompt')) return 'prompt'
  return 'other'
}

export interface PackageManagerOptions {
  catalog: Catalog
  controller: Pick<RunController, 'phase'>
  /** The repository whose node_modules holds the shared packages. */
  repoRoot?: string
  /** Where add-ons are installed; must sit inside repoRoot. */
  installRoot?: string
  /** DSH_HOME for the inspector fork; defaults to <installRoot>/../dsh-home. */
  dshHome?: string
  registry?: Registry
  npm?: NpmRunner
}

/**
 * The install root of a store: <store>/packages. Null when the store sits
 * outside the repository — add-on imports of the kernel's shared packages
 * would not resolve from there, so installs must stay disabled.
 */
export function installRootFor(storeRoot: string, repoRoot = fileURLToPath(new URL('../../../', import.meta.url))): string | null {
  const offset = relative(repoRoot, storeRoot)
  return offset.startsWith('..') || isAbsolute(offset) ? null : join(storeRoot, 'packages')
}

export class PackageManager {
  private readonly catalog: Catalog
  private readonly controller: Pick<RunController, 'phase'>
  private readonly repoRoot: string
  private readonly installRoot: string
  private readonly dshHome: string
  private readonly registry: Registry
  private readonly npm: NpmRunner
  private installed: InstalledPackage[] = []
  /** Installs run one at a time; npm cannot take two writers on one node_modules. */
  private queue: Promise<void> = Promise.resolve()

  constructor(options: PackageManagerOptions) {
    this.catalog = options.catalog
    this.controller = options.controller
    this.repoRoot = options.repoRoot ?? fileURLToPath(new URL('../../../', import.meta.url))
    this.installRoot = options.installRoot ?? join(this.repoRoot, '.explorer/packages')
    this.dshHome = options.dshHome ?? join(dirname(this.installRoot), 'dsh-home')
    this.registry = options.registry ?? new NpmRegistry()
    this.npm = options.npm ?? runNpm
  }

  list(): InstalledPackage[] {
    return [...this.installed]
  }

  /** Registry search over the scope; availability is checked for the first 20 hits only. */
  async search(query: string): Promise<PackageSearchResult[]> {
    const found = (await this.registry.search(`scope:deepseek-ai ${query}`))
      .filter(item => item.name.startsWith(`${UPSTREAM_SCOPE}dsh-`))
    const installed = new Set(this.installed.map(item => item.name))
    const available = await Promise.all(found.slice(0, 20).map(async item =>
      (await this.registry.versions(item.name))?.includes(UPSTREAM_VERSION) ?? false))
    return found.map((item, index) => ({
      ...item,
      available: index < 20 ? available[index]! : null,
      installed: installed.has(item.name),
    }))
  }

  /** Re-add the persisted packages to the catalog; ones that fail their checks are skipped. */
  async load() {
    let persisted: InstalledPackage[]
    try {
      persisted = JSON.parse(await readFile(join(this.installRoot, 'installed.json'), 'utf8')) as InstalledPackage[]
    } catch {
      return
    }
    for (const entry of persisted) {
      try {
        if (this.catalog.stages.some(stage => stage.pluginDefinitionId === entry.definitionId)) {
          throw new Error(`definition ${entry.definitionId} is already in the catalog`)
        }
        this.addStage(await this.stageFor(entry.name))
        this.installed.push(entry)
      } catch (error) {
        console.warn(`skipping installed package ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Install name@UPSTREAM_VERSION and add its stage to the catalog. */
  async install(name: string): Promise<ExecutableStageDefinition> {
    if (!NAME_PATTERN.test(name)) {
      throw new ControlError('invalid', `package name "${name}" is not an @deepseek-ai/* package`)
    }
    if (await this.repoProvides(name)) {
      throw new ControlError('invalid', `${name} is part of the explorer kernel; it is already loaded`)
    }
    if (this.controller.phase !== 'idle') {
      throw new ControlError('busy', 'wait for the current run to settle before installing packages')
    }
    const queued = this.queue.then(() => this.doInstall(name))
    this.queue = queued.then(() => {}, () => {})
    return queued
  }

  /** Remove a package, its stage and its catalog entry; queued behind any install in flight. */
  async uninstall(name: string): Promise<void> {
    if (this.controller.phase !== 'idle') {
      throw new ControlError('busy', 'wait for the current run to settle before uninstalling packages')
    }
    const queued = this.queue.then(() => this.doUninstall(name))
    this.queue = queued.then(() => {}, () => {})
    return queued
  }

  private async doUninstall(name: string) {
    // Checked again now that the operation actually starts: a run may have begun while we queued.
    if (this.controller.phase !== 'idle') {
      throw new ControlError('busy', 'wait for the current run to settle before uninstalling packages')
    }
    const entry = this.installed.find(item => item.name === name)
    if (!entry) throw new ControlError('not-found', `package ${name} is not installed`)
    await this.npm(['uninstall', '--prefix', this.installRoot, ...NPM_FLAGS, name], {
      cwd: this.installRoot,
      timeoutMs: NPM_TIMEOUT_MS,
    })
    // npm rebuilds the remaining tree on uninstall, re-installing copies dedupe removed.
    await this.dedupe(this.installRoot)
    this.installed = this.installed.filter(item => item.name !== name)
    await this.persist()
    const catalog = this.mutableCatalog()
    catalog.stages = catalog.stages.filter(stage => stage.pluginDefinitionId !== entry.definitionId)
    delete catalog.responsibilities[entry.definitionId]
    await this.verifyRemaining()
  }

  /** A rebuilt tree may shadow a shared package for a remaining add-on; its stage must never reach a run. */
  private async verifyRemaining() {
    const resolveFromRoot = createRequire(join(this.installRoot, 'package.json'))
    for (const entry of this.installed) {
      try {
        await this.verifyShared(resolveFromRoot.resolve(entry.name))
      } catch (error) {
        console.warn(`dropping ${entry.name} from the catalog: ${error instanceof Error ? error.message : String(error)}`)
        const catalog = this.mutableCatalog()
        catalog.stages = catalog.stages.filter(stage => stage.pluginDefinitionId !== entry.definitionId)
        delete catalog.responsibilities[entry.definitionId]
      }
    }
  }

  private mutableCatalog() {
    return this.catalog as unknown as { stages: ExecutableStageDefinition[]; responsibilities: Record<string, PluginResponsibility> }
  }

  private addStage(stage: ExecutableStageDefinition) {
    const catalog = this.mutableCatalog()
    catalog.stages = [...catalog.stages, stage]
    catalog.responsibilities[stage.pluginDefinitionId] = responsibilityOf(stage.package!.name)
  }

  private async persist() {
    await writeFile(join(this.installRoot, 'installed.json'), `${JSON.stringify(this.installed, null, 2)}\n`)
  }

  /** True when the repo root already provides the package at a satisfying version. */
  private async repoProvides(name: string, spec?: string) {
    try {
      const manifest = JSON.parse(await readFile(join(this.repoRoot, 'node_modules', name, 'package.json'), 'utf8')) as { version?: string }
      return spec === undefined || satisfies(manifest.version ?? '', spec)
    } catch {
      return false
    }
  }

  private async resolveSpec(name: string, spec: string): Promise<string> {
    if (EXACT_VERSION.test(spec)) return spec
    const match = (await this.registry.versions(name))?.filter(version => satisfies(version, spec)).sort(compareVersions).at(-1)
    if (!match) throw new ControlError('not-found', `no published version of ${name} satisfies "${spec}"`)
    return match
  }

  /**
   * Peers npm will not install: optional peers are skipped and peers the repo
   * root provides are shared, so only the rest are installed explicitly.
   * Peers of every @deepseek-ai/* dependency or missing peer reached are
   * walked too; a repo-provided package's graph is the kernel's, so it is
   * neither installed nor walked.
   */
  private async peerClosure(first: PackageManifest): Promise<Map<string, string>> {
    const missing = new Map<string, string>()
    const seen = new Set<string>([first.name])
    const queue = [first]
    while (queue.length) {
      const manifest = queue.shift()!
      const peers = Object.entries(manifest.peerDependencies ?? {})
        .filter(([peer]) => !manifest.peerDependenciesMeta?.[peer]?.optional)
      for (const [peer, spec] of peers) {
        if (await this.repoProvides(peer, spec) || missing.has(peer)) continue
        missing.set(peer, await this.resolveSpec(peer, spec))
      }
      for (const [name, spec] of [...Object.entries(manifest.dependencies ?? {}), ...peers]) {
        if (!name.startsWith(UPSTREAM_SCOPE) || seen.has(name) || await this.repoProvides(name)) continue
        seen.add(name)
        const child = await this.registry.manifest(name, await this.resolveSpec(name, spec))
        if (child) queue.push(child)
      }
    }
    return missing
  }

  /** True when the local copy is exactly the repo copy's version, so imports may fall through to it. */
  private async duplicateOfRepo(name: string, path: string) {
    try {
      const [local, shared] = await Promise.all([
        readFile(join(path, 'package.json'), 'utf8'),
        readFile(join(this.repoRoot, 'node_modules', name, 'package.json'), 'utf8'),
      ])
      return (JSON.parse(local) as { version?: string }).version === (JSON.parse(shared) as { version?: string }).version
    } catch {
      return false
    }
  }

  /**
   * Delete every local copy that duplicates the repo's version, so imports fall
   * through to the shared instance. A different version is kept on purpose —
   * for @deepseek-ai/* packages verifyShared then refuses the install.
   */
  private async dedupe(dir: string) {
    const modules = join(dir, 'node_modules')
    if (!existsSync(modules)) return
    for (const entry of await readdir(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const packages = entry.name.startsWith('@')
        ? (await readdir(join(modules, entry.name), { withFileTypes: true }))
            .filter(scope => scope.isDirectory())
            .map(scope => ({ name: `${entry.name}/${scope.name}`, path: join(modules, entry.name, scope.name) }))
        : [{ name: entry.name, path: join(modules, entry.name) }]
      for (const pkg of packages) {
        if (await this.duplicateOfRepo(pkg.name, pkg.path)) await rm(pkg.path, { recursive: true, force: true })
        else await this.dedupe(pkg.path)
      }
    }
  }

  /**
   * The copy of `name` Node would load from fromDir: the first node_modules up
   * the directory chain that contains it. Resolved by hand because Node caches
   * CJS resolution results (and misses) per process, and the install tree
   * changes between install, uninstall and rollback within one server process.
   */
  private resolvesTo(fromDir: string, name: string): string | null {
    for (let dir = fromDir; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name)
      if (existsSync(join(candidate, 'package.json'))) return candidate
      if (dirname(dir) === dir) return null
    }
  }

  /**
   * Every @deepseek-ai/* package the repo provides must resolve to the repo's
   * own copy from the add-on, or Cordis contexts and services break. Names the
   * entry cannot resolve are skipped; every mismatch is reported at once.
   */
  private async verifyShared(entry: string) {
    const mismatches: string[] = []
    for (const dir of await readdir(join(this.repoRoot, 'node_modules', '@deepseek-ai'))) {
      const name = `@deepseek-ai/${dir}`
      const local = this.resolvesTo(dirname(entry), name)
      if (local === null) continue
      const [localReal, sharedReal] = await Promise.all([realpath(local), realpath(join(this.repoRoot, 'node_modules', name))])
      if (localReal !== sharedReal) mismatches.push(`${name} (from ${localReal})`)
    }
    if (mismatches.length) {
      throw new ControlError('internal', `the package would load its own copies of shared packages: ${mismatches.join(', ')}; refusing to install it`)
    }
  }

  /** Import the entry in a short-lived child, so package code never runs in the server process. */
  private inspect(entry: string): Promise<PackageInspection> {
    const inspector = fileURLToPath(new URL('./inspect-package.ts', import.meta.url))
    // Inspected package code may touch DSH_HOME; pin it to the store's dsh-home.
    mkdirSync(this.dshHome, { recursive: true })
    const env = { ...scrubbedEnv(), DSH_HOME: this.dshHome }
    return new Promise((resolve, reject) => {
      const child = fork(inspector, [entry], { execArgv: ['--import', import.meta.resolve('tsx')], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000) })
      const timer = setTimeout(() => child.kill('SIGKILL'), INSPECT_TIMEOUT_MS)
      child.on('error', reject)
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code !== 0) return reject(new Error(`inspector exited with code ${code}: ${stderr.trim()}`))
        try {
          resolve(JSON.parse(stdout.trim().split('\n').at(-1)!) as PackageInspection)
        } catch {
          reject(new Error(`inspector did not report JSON: ${stdout.trim()}`))
        }
      })
    })
  }

  /** Build the stage of an already-installed package: resolve, verify sharing, inspect. */
  private async stageFor(name: string): Promise<ExecutableStageDefinition> {
    const resolveFromRoot = createRequire(join(this.installRoot, 'package.json'))
    let entry: string
    try {
      entry = resolveFromRoot.resolve(name)
    } catch {
      throw new ControlError('not-found', `package ${name} does not resolve from ${this.installRoot}`)
    }
    await this.verifyShared(entry)
    const inspection = await this.inspect(entry)
    const stage = upstreamStage({
      definitionId: name.slice(UPSTREAM_SCOPE.length),
      packageName: name,
      requires: inspection.inject,
      provides: inspection.provides,
    }, specifier => pathToFileURL(resolveFromRoot.resolve(specifier)).href)
    return { ...stage, ...inspection.configKeys.length ? { configKeys: inspection.configKeys } : {} }
  }

  private async doInstall(name: string): Promise<ExecutableStageDefinition> {
    // Checked again now that the operation actually starts: a run may have begun while we queued.
    if (this.controller.phase !== 'idle') {
      throw new ControlError('busy', 'wait for the current run to settle before installing packages')
    }
    const definitionId = name.slice(UPSTREAM_SCOPE.length)
    if (this.catalog.stages.some(stage => stage.pluginDefinitionId === definitionId)) {
      throw new ControlError('invalid', `definition ${definitionId} is already in the catalog`)
    }
    await mkdir(this.installRoot, { recursive: true })
    if (!existsSync(join(this.installRoot, 'package.json'))) {
      await writeFile(join(this.installRoot, 'package.json'), JSON.stringify({ private: true }))
    }
    const manifest = await this.registry.manifest(name, UPSTREAM_VERSION)
    if (!manifest) throw new ControlError('not-found', `no release of ${name} at ${UPSTREAM_VERSION}`)
    const peers = await this.peerClosure(manifest)
    await this.npm([
      'install', '--prefix', this.installRoot, ...NPM_FLAGS, '--save-exact',
      `${name}@${UPSTREAM_VERSION}`,
      ...[...peers].map(([peer, version]) => `${peer}@${version}`),
    ], { cwd: this.installRoot, timeoutMs: NPM_TIMEOUT_MS })
    try {
      await this.dedupe(this.installRoot)
      const stage = await this.stageFor(name)
      this.addStage(stage)
      this.installed.push({ name, version: UPSTREAM_VERSION, definitionId, installedAt: new Date().toISOString() })
      await this.persist()
      return stage
    } catch (error) {
      // Roll the install back so package.json and node_modules return to their
      // previous state; a rollback failure must not hide the original error.
      // npm rebuilds the remaining tree here too, so dedupe again afterwards.
      await this.npm(['uninstall', '--prefix', this.installRoot, ...NPM_FLAGS, name], {
        cwd: this.installRoot,
        timeoutMs: NPM_TIMEOUT_MS,
      }).catch(() => {})
      await this.dedupe(this.installRoot).catch(() => {})
      throw error
    }
  }
}
