/**
 * Upstream plugins executed as published on npm: `@deepseek-ai/dsh-*` at the
 * release tagged on the pinned commit (upstream-lock.json, tag
 * `dsh-v0.2.1-rc.2`). Their code is not copied or rewritten; a stage is the
 * package's own entry module, identified by the hash of that file.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExecutableStageDefinition, PluginResponsibility } from '@harness-explorer/contracts'

/** The one upstream release every `@deepseek-ai/dsh-*` package must match. */
export const UPSTREAM_VERSION = '0.2.1-rc.2'
export const UPSTREAM_SCOPE = '@deepseek-ai/'

const lock = JSON.parse(readFileSync(new URL('../../../upstream-lock.json', import.meta.url), 'utf8')) as { commit: string }
export const UPSTREAM_COMMIT = lock.commit

export class UpstreamPackageError extends Error {
  override name = 'UpstreamPackageError'
}

export interface UpstreamPlugin {
  definitionId: string
  packageName: string
  requires: readonly string[]
  provides: readonly string[]
  responsibility: PluginResponsibility
}

/**
 * The minimal agent kernel of upstream `packages/bundle/sdk-minimal`, plus
 * the DeepSeek API-key adapter that bundle uses for real model calls. The
 * requires and provides are checked against the modules by the catalog test.
 */
export const kernelPlugins: readonly UpstreamPlugin[] = [
  { definitionId: 'llm', packageName: '@deepseek-ai/dsh-llm', requires: [], provides: ['llm'], responsibility: 'model' },
  { definitionId: 'session', packageName: '@deepseek-ai/dsh-session', requires: [], provides: ['sessions'], responsibility: 'session' },
  { definitionId: 'session-projection', packageName: '@deepseek-ai/dsh-session-projection', requires: [], provides: ['sessionProjections'], responsibility: 'session' },
  { definitionId: 'system-prompt', packageName: '@deepseek-ai/dsh-system-prompt', requires: [], provides: ['systemPrompt'], responsibility: 'prompt' },
  { definitionId: 'tools', packageName: '@deepseek-ai/dsh-tools', requires: ['systemPrompt'], provides: ['tools'], responsibility: 'tool' },
  { definitionId: 'agent', packageName: '@deepseek-ai/dsh-agent', requires: [], provides: ['agents'], responsibility: 'agent-loop' },
  {
    definitionId: 'agent-loop',
    packageName: '@deepseek-ai/dsh-agent-loop',
    requires: ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections'],
    provides: ['agentLoop'],
    responsibility: 'agent-loop',
  },
  { definitionId: 'llm-deepseek', packageName: '@deepseek-ai/dsh-llm-deepseek-api-key', requires: ['llm'], provides: [], responsibility: 'model' },
]

export const sha256 = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

/** Entry module and manifest of an installed package, resolved like Node resolves its importers. */
export function resolvePackage(packageName: string, resolve: (specifier: string) => string = specifier => import.meta.resolve(specifier)) {
  const module = fileURLToPath(resolve(packageName))
  // Entry modules sit at lib/index.js; walk up to the manifest that names this package.
  for (let dir = dirname(module); dir !== dirname(dir); dir = dirname(dir)) {
    let manifest: { name?: string; version?: string }
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as typeof manifest
    } catch {
      continue
    }
    if (manifest.name === packageName) return { module, version: manifest.version ?? '' }
  }
  throw new UpstreamPackageError(`no package.json for ${packageName} above ${module}`)
}

/** A stage for one installed upstream package; refuses any version other than the pinned release. */
export function upstreamStage(plugin: Omit<UpstreamPlugin, 'responsibility'>, resolve?: (specifier: string) => string): ExecutableStageDefinition {
  const { module, version } = resolvePackage(plugin.packageName, resolve)
  if (version !== UPSTREAM_VERSION) {
    throw new UpstreamPackageError(`${plugin.packageName}@${version} is installed, but this explorer runs ${UPSTREAM_VERSION} (the release of ${UPSTREAM_COMMIT.slice(0, 8)}); run pnpm install`)
  }
  return {
    id: `${plugin.definitionId}@${version}`,
    pluginDefinitionId: plugin.definitionId,
    origin: 'upstream',
    module,
    sourceHash: sha256(readFileSync(module, 'utf8')),
    requires: [...plugin.requires],
    provides: [...plugin.provides],
    upstreamCommit: UPSTREAM_COMMIT,
    package: { name: plugin.packageName, version },
  }
}

export const kernelStages = (): ExecutableStageDefinition[] => kernelPlugins.map(plugin => upstreamStage(plugin))
