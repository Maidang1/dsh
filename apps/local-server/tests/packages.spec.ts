/**
 * PackageManager: name validation, the pinned release, the peer closure,
 * dedupe against the repo's node_modules, persistence and the busy refusal.
 * Registry and npm are stubbed; the install root sits inside a temporary
 * repository so module resolution walks up to that repository's node_modules,
 * exactly like .explorer/packages inside the real one.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Composition, TraceName } from '@harness-explorer/contracts'
import type { TraceRecord } from '@harness-explorer/contracts'
import { runScenario } from '@harness-explorer/teaching-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadDevCatalog } from '../src/catalog.ts'
import type { Catalog } from '../src/catalog.ts'
import type { RunController } from '../src/controller.ts'
import { installRootFor, PackageManager } from '../src/packages.ts'
import type { InstalledPackage, NpmRunner, PackageManifest, Registry } from '../src/packages.ts'

const PINNED = '0.2.1-rc.2'
const PACKAGE = '@deepseek-ai/dsh-tool-thing'

class StubRegistry implements Registry {
  readonly manifests = new Map<string, PackageManifest>()
  searchResults: Array<{ name: string; description: string; version: string }> = []

  async manifest(name: string, version: string) {
    return this.manifests.get(`${name}@${version}`) ?? null
  }

  async versions(name: string) {
    return [...this.manifests.keys()].filter(key => key.startsWith(`${name}@`)).map(key => key.slice(name.length + 1))
  }

  async search() {
    return this.searchResults
  }
}

/** The plugin module the stub npm writes for each installed package. */
const ENTRY = `export const name = 'thing'
export const inject = []
export const Config = { dict: { retries: {} } }
class P extends Object { constructor(ctx) { super(ctx, "things") } }
export function apply() {}
`

let repoRoot: string
let installRoot: string
let registry: StubRegistry
let npmCalls: string[][]

const stubNpm: NpmRunner = async (args, { cwd }) => {
  npmCalls.push(args)
  if (args[0] === 'install') {
    for (const arg of args) {
      const match = /^(@deepseek-ai\/[^@]+)@(.+)$/.exec(arg)
      if (!match) continue
      const dir = join(cwd, 'node_modules', match[1]!)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: match[1], version: match[2], type: 'module', main: 'index.js' }))
      await writeFile(join(dir, 'index.js'), ENTRY)
    }
  }
  if (args[0] === 'uninstall') await rm(join(cwd, 'node_modules', args.at(-1)!), { recursive: true, force: true })
}

/** A fake repository with the shared cordis the kernel runs on. */
async function fakeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'explorer-packages-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fake-repo', private: true }))
  const cordis = join(root, 'node_modules', '@deepseek-ai', 'cordis')
  await mkdir(cordis, { recursive: true })
  await writeFile(join(cordis, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.0.5', type: 'module', main: 'index.js' }))
  await writeFile(join(cordis, 'index.js'), 'export {}\n')
  return root
}

async function addRepoPackage(name: string, version: string) {
  const dir = join(repoRoot, 'node_modules', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.js' }))
  await writeFile(join(dir, 'index.js'), 'export {}\n')
}

const stubCatalog = () => ({ stages: [], responsibilities: {} }) as unknown as Catalog
const idle = { phase: 'idle' } as RunController

function manager(catalog: Catalog, controller: RunController = idle, npm: NpmRunner = stubNpm) {
  return new PackageManager({ catalog, controller, repoRoot, installRoot, registry, npm })
}

beforeEach(async () => {
  repoRoot = await fakeRepo()
  installRoot = join(repoRoot, '.explorer', 'packages')
  registry = new StubRegistry()
  npmCalls = []
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

describe('installRootFor', () => {
  it('places the install root inside the store and refuses a store outside the repository', () => {
    expect(installRootFor(join(repoRoot, '.explorer'), repoRoot)).toBe(join(repoRoot, '.explorer', 'packages'))
    expect(installRootFor(join(repoRoot, '.explorer-e2e'), repoRoot)).toBe(join(repoRoot, '.explorer-e2e', 'packages'))
    expect(installRootFor(join(repoRoot, 'nested', 'store'), repoRoot)).toBe(join(repoRoot, 'nested', 'store', 'packages'))
    expect(installRootFor(join(tmpdir(), 'outside-store'), repoRoot)).toBeNull()
    expect(installRootFor(join(repoRoot, '..', 'sibling-store'), repoRoot)).toBeNull()
  })
})

describe('PackageManager', () => {
  it('refuses names that are not a scoped @deepseek-ai package', async () => {
    await expect(manager(stubCatalog()).install('lodash')).rejects.toMatchObject({ code: 'invalid' })
    await expect(manager(stubCatalog()).install('@deepseek-ai/Bad Name')).rejects.toMatchObject({ code: 'invalid' })
    await expect(manager(stubCatalog()).install('@other/dsh-tool-x')).rejects.toMatchObject({ code: 'invalid' })
    expect(npmCalls).toEqual([])
  })

  it('refuses a package with no release at the pinned version', async () => {
    await expect(manager(stubCatalog()).install(PACKAGE)).rejects.toThrow(`no release of ${PACKAGE} at ${PINNED}`)
    expect(npmCalls).toEqual([])
  })

  it('refuses a definition id that is already in the catalog', async () => {
    const catalog = stubCatalog()
    ;(catalog as unknown as { stages: unknown[] }).stages = [{ pluginDefinitionId: 'dsh-tool-thing' }]
    registry.manifests.set(`${PACKAGE}@${PINNED}`, { name: PACKAGE, version: PINNED })
    await expect(manager(catalog).install(PACKAGE)).rejects.toThrow('already in the catalog')
  })

  it('installs missing peers, skipping optional and repo-provided ones', async () => {
    // dsh-tools is provided by the repo root; left-pad is optional; dsh-dep's
    // own peer dsh-transitive is reached transitively and installed.
    const tools = join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-tools')
    await mkdir(tools, { recursive: true })
    await writeFile(join(tools, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: PINNED }))
    registry.manifests.set(`${PACKAGE}@${PINNED}`, {
      name: PACKAGE,
      version: PINNED,
      dependencies: { '@deepseek-ai/dsh-dep': PINNED },
      peerDependencies: {
        '@deepseek-ai/cordis': '~4.0.5',
        '@deepseek-ai/dsh-tools': PINNED,
        '@deepseek-ai/dsh-extra': PINNED,
        'left-pad': '1.0.0',
      },
      peerDependenciesMeta: { 'left-pad': { optional: true } },
    })
    registry.manifests.set(`@deepseek-ai/dsh-dep@${PINNED}`, {
      name: '@deepseek-ai/dsh-dep',
      version: PINNED,
      peerDependencies: { '@deepseek-ai/dsh-transitive': PINNED, '@deepseek-ai/cordis': '~4.0.5' },
    })
    registry.manifests.set(`@deepseek-ai/dsh-extra@${PINNED}`, { name: '@deepseek-ai/dsh-extra', version: PINNED })
    registry.manifests.set(`@deepseek-ai/dsh-transitive@${PINNED}`, { name: '@deepseek-ai/dsh-transitive', version: PINNED })

    const catalog = stubCatalog()
    const stage = await manager(catalog).install(PACKAGE)

    const specs = npmCalls[0]!.filter(arg => arg.startsWith('@'))
    expect(specs).toEqual([`${PACKAGE}@${PINNED}`, `@deepseek-ai/dsh-extra@${PINNED}`, `@deepseek-ai/dsh-transitive@${PINNED}`])
    expect(stage.id).toBe(`dsh-tool-thing@${PINNED}`)
    expect(stage.origin).toBe('upstream')
    expect(stage.package).toEqual({ name: PACKAGE, version: PINNED })
    expect(stage.sourceHash).toMatch(/^sha256:/)
    expect(stage.requires).toEqual([])
    expect(stage.provides).toEqual(['things'])
    expect(stage.configKeys).toEqual(['retries'])
    expect(catalog.stages.at(-1)!.id).toBe(stage.id)
    expect(catalog.responsibilities['dsh-tool-thing']).toBe('tool')
  })

  it('reports the config keys of a schemastery Config, which is a callable function', async () => {
    // A real schemastery object schema: typeof Config === 'function', keys on .dict.
    const schemastery = import.meta.resolve('@deepseek-ai/schemastery')
    const npmWithSchema: NpmRunner = async (args, options) => {
      await stubNpm(args, options)
      if (args[0] !== 'install') return
      await writeFile(join(options.cwd, 'node_modules', PACKAGE, 'index.js'), `import z from '${schemastery}'
export const name = 'thing'
export const inject = []
export const Config = z.object({ allowParallelInProgress: z.boolean().default(false) })
export function apply() {}
`)
    }
    registry.manifests.set(`${PACKAGE}@${PINNED}`, { name: PACKAGE, version: PINNED })
    const stage = await manager(stubCatalog(), idle, npmWithSchema).install(PACKAGE)
    expect(stage.configKeys).toEqual(['allowParallelInProgress'])
  })

  it('forks the inspector with DSH_HOME inside the store, not the inherited one', async () => {
    const probe = join(repoRoot, 'inspector-probe-out.txt')
    registry.manifests.set(`${PACKAGE}@${PINNED}`, { name: PACKAGE, version: PINNED })
    const npmWithProbe: NpmRunner = async (args, options) => {
      await stubNpm(args, options)
      if (args[0] !== 'install') return
      await writeFile(join(options.cwd, 'node_modules', PACKAGE, 'index.js'), `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(probe)}, process.env.DSH_HOME ?? '<unset>')
export const name = 'thing'
export const inject = []
export function apply() {}
`)
    }
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = join(repoRoot, 'inherited-dsh-home')
    try {
      await manager(stubCatalog(), idle, npmWithProbe).install(PACKAGE)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
    expect(await readFile(probe, 'utf8')).toBe(join(repoRoot, '.explorer', 'dsh-home'))
    expect(existsSync(join(repoRoot, '.explorer', 'dsh-home'))).toBe(true)
  })

  it('deletes local copies of packages the repo root already provides, at any depth', async () => {
    registry.manifests.set(`${PACKAGE}@${PINNED}`, { name: PACKAGE, version: PINNED })
    const npmWithDupes: NpmRunner = async (args, options) => {
      await stubNpm(args, options)
      if (args[0] !== 'install') return
      for (const dir of [
        join(options.cwd, 'node_modules', '@deepseek-ai', 'cordis'),
        join(options.cwd, 'node_modules', PACKAGE, 'node_modules', '@deepseek-ai', 'cordis'),
      ]) {
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.0.5' }))
        await writeFile(join(dir, 'index.js'), 'export {}\n')
      }
    }
    await manager(stubCatalog(), idle, npmWithDupes).install(PACKAGE)
    expect(existsSync(join(installRoot, 'node_modules', '@deepseek-ai', 'cordis'))).toBe(false)
    expect(existsSync(join(installRoot, 'node_modules', PACKAGE, 'node_modules', '@deepseek-ai', 'cordis'))).toBe(false)
    expect(existsSync(join(installRoot, 'node_modules', PACKAGE, 'index.js'))).toBe(true)
  })

  it('keeps a local copy whose version differs from the repo copy', async () => {
    registry.manifests.set(`${PACKAGE}@${PINNED}`, { name: PACKAGE, version: PINNED })
    await addRepoPackage('left-pad', '1.0.0')
    const npmWithNewer: NpmRunner = async (args, options) => {
      await stubNpm(args, options)
      if (args[0] !== 'install') return
      for (const dir of [join(options.cwd, 'node_modules', 'left-pad'), join(options.cwd, 'node_modules', PACKAGE, 'node_modules', 'left-pad')]) {
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'left-pad', version: '2.0.0' }))
        await writeFile(join(dir, 'index.js'), 'export {}\n')
      }
    }
    await manager(stubCatalog(), idle, npmWithNewer).install(PACKAGE)
    expect(existsSync(join(installRoot, 'node_modules', 'left-pad'))).toBe(true)
    expect(existsSync(join(installRoot, 'node_modules', PACKAGE, 'node_modules', 'left-pad'))).toBe(true)
  })

  it('fails and rolls back when a kept copy shadows a shared @deepseek-ai package', async () => {
    registry.manifests.set(`${PACKAGE}@${PINNED}`, { name: PACKAGE, version: PINNED })
    await addRepoPackage('@deepseek-ai/dsh-tools', PINNED)
    const npmWithShadow: NpmRunner = async (args, options) => {
      await stubNpm(args, options)
      if (args[0] !== 'install') return
      const dir = join(options.cwd, 'node_modules', PACKAGE, 'node_modules', '@deepseek-ai', 'dsh-tools')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-shadow', type: 'module', main: 'index.js' }))
      await writeFile(join(dir, 'index.js'), 'export {}\n')
    }
    const catalog = stubCatalog()
    await expect(manager(catalog, idle, npmWithShadow).install(PACKAGE))
      .rejects.toThrow(/own copies of shared packages: @deepseek-ai\/dsh-tools/)
    // The failed install is rolled back; nothing is cataloged or persisted.
    expect(npmCalls.map(args => args[0])).toEqual(['install', 'uninstall'])
    expect(catalog.stages).toEqual([])
    expect(existsSync(join(installRoot, 'installed.json'))).toBe(false)
    expect(existsSync(join(installRoot, 'node_modules', PACKAGE))).toBe(false)
  })

  it('refuses to install a package the explorer kernel already provides', async () => {
    await addRepoPackage('@deepseek-ai/dsh-tools', PINNED)
    registry.manifests.set(`@deepseek-ai/dsh-tools@${PINNED}`, { name: '@deepseek-ai/dsh-tools', version: PINNED })
    await expect(manager(stubCatalog()).install('@deepseek-ai/dsh-tools'))
      .rejects.toMatchObject({ code: 'invalid', message: '@deepseek-ai/dsh-tools is part of the explorer kernel; it is already loaded' })
    expect(npmCalls).toEqual([])
  })

  it('queues uninstall behind install and re-checks the run phase when it starts', async () => {
    registry.manifests.set(`${PACKAGE}@${PINNED}`, { name: PACKAGE, version: PINNED })
    let phase: 'idle' | 'running' = 'idle'
    const controller = { get phase() { return phase } } as RunController
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const inside = new Promise<void>(resolve => { entered = resolve })
    const slowNpm: NpmRunner = async (args, options) => {
      if (args[0] === 'install') {
        entered()
        await gate
      }
      await stubNpm(args, options)
    }
    const first = manager(stubCatalog(), controller, slowNpm)
    const installing = first.install(PACKAGE)
    await inside
    // Enqueued while the phase is still idle; the run starts before the install finishes.
    const uninstalling = first.uninstall(PACKAGE)
    phase = 'running'
    release()
    await installing
    await expect(uninstalling).rejects.toMatchObject({ code: 'busy' })
    expect(first.list()).toHaveLength(1)
  })

  it('persists installs and reloads them into a fresh catalog', async () => {
    registry.manifests.set(`${PACKAGE}@${PINNED}`, { name: PACKAGE, version: PINNED })
    await manager(stubCatalog()).install(PACKAGE)
    const persisted = JSON.parse(await readFile(join(installRoot, 'installed.json'), 'utf8')) as InstalledPackage[]
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ name: PACKAGE, version: PINNED, definitionId: 'dsh-tool-thing' })

    const fresh = stubCatalog()
    const reloaded = manager(fresh)
    await reloaded.load()
    expect(reloaded.list()).toHaveLength(1)
    expect(fresh.stages.map(stage => stage.id)).toEqual([`dsh-tool-thing@${PINNED}`])
    expect(fresh.responsibilities['dsh-tool-thing']).toBe('tool')
  })

  it('skips persisted packages that no longer resolve, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mkdir(installRoot, { recursive: true })
    await writeFile(join(installRoot, 'installed.json'), JSON.stringify([{ name: '@deepseek-ai/dsh-ghost', version: PINNED, definitionId: 'dsh-ghost', installedAt: '' }]))
    const catalog = stubCatalog()
    await manager(catalog).load()
    expect(catalog.stages).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('@deepseek-ai/dsh-ghost'))
    warn.mockRestore()
  })

  it('refuses to install or uninstall while a run is in progress', async () => {
    const running = { phase: 'running' } as RunController
    registry.manifests.set(`${PACKAGE}@${PINNED}`, { name: PACKAGE, version: PINNED })
    await expect(manager(stubCatalog(), running).install(PACKAGE)).rejects.toMatchObject({ code: 'busy' })
    await expect(manager(stubCatalog(), running).uninstall(PACKAGE)).rejects.toMatchObject({ code: 'busy' })
    expect(npmCalls).toEqual([])
  })

  it('uninstalls a package: npm, persistence and the catalog entry', async () => {
    registry.manifests.set(`${PACKAGE}@${PINNED}`, { name: PACKAGE, version: PINNED })
    const catalog = stubCatalog()
    const first = manager(catalog)
    await first.install(PACKAGE)
    await first.uninstall(PACKAGE)
    expect(npmCalls.at(-1)).toContain('uninstall')
    expect(catalog.stages).toEqual([])
    expect(catalog.responsibilities).toEqual({})
    expect(first.list()).toEqual([])
    expect(JSON.parse(await readFile(join(installRoot, 'installed.json'), 'utf8'))).toEqual([])
    expect(existsSync(join(installRoot, 'node_modules', PACKAGE))).toBe(false)
    await expect(first.uninstall(PACKAGE)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('re-dedupes after an uninstall that rebuilds the tree', async () => {
    const OTHER = '@deepseek-ai/dsh-other'
    registry.manifests.set(`${PACKAGE}@${PINNED}`, { name: PACKAGE, version: PINNED })
    registry.manifests.set(`${OTHER}@${PINNED}`, { name: OTHER, version: PINNED })
    // npm's rebuild on uninstall puts the shared cordis back into the tree.
    const npmRebuilding: NpmRunner = async (args, options) => {
      await stubNpm(args, options)
      if (args[0] !== 'uninstall') return
      const dir = join(options.cwd, 'node_modules', '@deepseek-ai', 'cordis')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.0.5' }))
      await writeFile(join(dir, 'index.js'), 'export {}\n')
    }
    const first = manager(stubCatalog(), idle, npmRebuilding)
    await first.install(PACKAGE)
    await first.install(OTHER)
    await first.uninstall(OTHER)
    expect(existsSync(join(installRoot, 'node_modules', '@deepseek-ai', 'cordis'))).toBe(false)
    expect(existsSync(join(installRoot, 'node_modules', PACKAGE))).toBe(true)
    expect(first.list().map(item => item.name)).toEqual([PACKAGE])
  })

  it('drops the stage of a remaining package the rebuilt tree breaks', async () => {
    const OTHER = '@deepseek-ai/dsh-other'
    registry.manifests.set(`${PACKAGE}@${PINNED}`, { name: PACKAGE, version: PINNED })
    registry.manifests.set(`${OTHER}@${PINNED}`, { name: OTHER, version: PINNED })
    // npm's rebuild nests a different cordis version inside the remaining package.
    const npmShadowing: NpmRunner = async (args, options) => {
      await stubNpm(args, options)
      if (args[0] !== 'uninstall') return
      const dir = join(options.cwd, 'node_modules', PACKAGE, 'node_modules', '@deepseek-ai', 'cordis')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '9.9.9' }))
      await writeFile(join(dir, 'index.js'), 'export {}\n')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const catalog = stubCatalog()
    const first = manager(catalog, idle, npmShadowing)
    await first.install(PACKAGE)
    await first.install(OTHER)
    await first.uninstall(OTHER)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`dropping ${PACKAGE}`))
    expect(catalog.stages).toEqual([])
    expect(catalog.responsibilities).toEqual({})
    // The package stays installed; a restart's load() would warn and skip it too.
    expect(first.list().map(item => item.name)).toEqual([PACKAGE])
    warn.mockRestore()
  })
})

/**
 * Real installs from npm: dsh-tool-todo plus dsh-session-title (which has its
 * own @deepseek-ai/* dependencies), then an uninstall of the second — npm
 * rebuilds the remaining tree, and no repo-provided package may reappear as a
 * local duplicate. The todo add-on must still mount and register todo_write.
 * Run with DSH_NPM_E2E=1.
 */
describe.skipIf(process.env.DSH_NPM_E2E !== '1')('npm e2e', () => {
  /** Every package directory under dir's node_modules, at any depth. */
  async function collectPackages(dir: string): Promise<Array<{ name: string; path: string }>> {
    const modules = join(dir, 'node_modules')
    if (!existsSync(modules)) return []
    const found: Array<{ name: string; path: string }> = []
    for (const entry of await readdir(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (entry.name.startsWith('@')) {
        for (const scope of await readdir(join(modules, entry.name), { withFileTypes: true })) {
          if (scope.isDirectory()) found.push({ name: `${entry.name}/${scope.name}`, path: join(modules, entry.name, scope.name) })
        }
      } else {
        found.push({ name: entry.name, path: join(modules, entry.name) })
      }
    }
    for (const pkg of [...found]) found.push(...await collectPackages(pkg.path))
    return found
  }

  it('leaves no duplicate of a repo-provided package after an uninstall', async () => {
    const repo = fileURLToPath(new URL('../../../', import.meta.url))
    const root = join(repo, '.explorer-e2e', `packages-${Date.now()}`)
    try {
      const catalog = loadDevCatalog(repo)
      const packages = new PackageManager({ catalog, controller: idle, repoRoot: repo, installRoot: root })
      const stage = await packages.install('@deepseek-ai/dsh-tool-todo')
      await packages.install('@deepseek-ai/dsh-session-title')
      await packages.uninstall('@deepseek-ai/dsh-session-title')

      // No local copy of a package the repo provides at the same version may survive the uninstall.
      const offenders: string[] = []
      for (const pkg of await collectPackages(root)) {
        const shared = join(repo, 'node_modules', pkg.name, 'package.json')
        if (!existsSync(shared)) continue
        const local = JSON.parse(await readFile(join(pkg.path, 'package.json'), 'utf8')) as { version?: string }
        const repoVersion = (JSON.parse(await readFile(shared, 'utf8')) as { version?: string }).version
        if (local.version === repoVersion) offenders.push(`${pkg.name}@${local.version}`)
      }
      expect(offenders).toEqual([])

      const composition = Composition.parse(JSON.parse(await readFile(join(repo, 'fixtures/compositions/tool-chat.json'), 'utf8')))
      composition.instances.push({
        id: 'todo',
        definitionId: 'dsh-tool-todo',
        stageId: stage.id,
        scopeId: 'root',
        parentId: null,
        enabled: true,
        config: { allowParallelInProgress: false },
      })
      const registrations: string[] = []
      const records: TraceRecord[] = []
      const result = await runScenario({
        runId: 'npm-e2e',
        composition,
        scenario: catalog.scenarios['tool-guard']!,
        modelScripts: { calculator: catalog.modelScripts['calculator']! },
        stages: catalog.stages,
        adapterMode: 'deterministic',
        onRecord: (record, store) => {
          records.push(record)
          if (record.name === TraceName.registrationAdd && record.payloadRef) {
            registrations.push((store.get(record.payloadRef) as { registrationId: string }).registrationId)
          }
        },
      })
      expect(result.outcome).toBe('completed')
      expect(registrations).toContain('tool:root:todo_write')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})
