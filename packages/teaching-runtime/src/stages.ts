import type { Plugin } from '@deepseek-ai/cordis'
import type { ExecutableStageDefinition } from '@harness-explorer/contracts'
import { pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'

export type StageLoader = (stage: ExecutableStageDefinition) => Promise<Plugin>

interface StageModule {
  default?: unknown
  name?: string
  inject?: string[]
  Config?: unknown
  apply?: (...args: never[]) => unknown
}

/**
 * Turn an imported stage module into a Cordis plugin. A default export is a
 * plugin as-is (service classes); otherwise the module's `name`, `inject`,
 * `Config` and `apply` exports form a plugin object. Module namespaces are
 * frozen, so the object is copied rather than handed to Cordis directly.
 */
export function pluginFromModule(module: StageModule, stageId: string): Plugin {
  if (module.default !== undefined) return module.default as Plugin
  if (typeof module.apply !== 'function') {
    throw new TypeError(`stage ${stageId} exports neither a default plugin nor an apply function`)
  }
  return {
    name: module.name ?? stageId,
    ...module.inject ? { inject: module.inject } : {},
    ...module.Config ? { Config: module.Config } : {},
    apply: module.apply,
  } as Plugin
}

/** Load trusted, prebuilt stage modules by path; no eval and no remote URLs. */
export const importStageLoader: StageLoader = async (stage) => {
  if (!isAbsolute(stage.module)) {
    throw new Error(`stage ${stage.id} module must be an absolute path, received "${stage.module}"`)
  }
  const module = await import(pathToFileURL(stage.module).href) as StageModule
  return pluginFromModule(module, stage.id)
}
