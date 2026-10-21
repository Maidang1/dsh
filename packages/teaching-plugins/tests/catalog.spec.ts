/** Every plugin definition in the catalog is classified for the plugin library filter. */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { PluginResponsibility } from '@harness-explorer/contracts'
import { describe, expect, it } from 'vitest'
import { devStages, responsibilities } from '../src/index.ts'
import { kernelPlugins, resolvePackage } from '../src/upstream.ts'

/** Services a module provides: the names its classes pass to `super(ctx, …)`. */
const PROVIDED = /super\(\s*ctx\s*,\s*["']([\w.-]+)["']/g

/** The module's declared inject: a Service subclass' static, or a functional plugin's named export. */
function realInject(module: Record<string, unknown>): string[] {
  const service = module.default as { inject?: string[] } | undefined
  return [...(service?.inject ?? (module.inject as string[] | undefined) ?? [])]
}

describe('catalog', () => {
  it('gives each plugin definition a responsibility', () => {
    const definitions = [...new Set(devStages.map(stage => stage.pluginDefinitionId))].sort()
    expect(Object.keys(responsibilities).sort()).toEqual(definitions)
    for (const responsibility of Object.values(responsibilities)) expect(PluginResponsibility.options).toContain(responsibility)
  })

  // upstream.ts promises this check: the catalog's requires/provides are the modules' own.
  for (const plugin of kernelPlugins) {
    it(`${plugin.definitionId}: requires and provides match the installed module`, async () => {
      const { module } = resolvePackage(plugin.packageName)
      const loaded = await import(pathToFileURL(module).href) as Record<string, unknown>
      expect(realInject(loaded).sort()).toEqual([...plugin.requires].sort())
      const services = [...readFileSync(module, 'utf8').matchAll(PROVIDED)].map(match => match[1]!).sort()
      expect(services).toEqual([...plugin.provides].sort())
    })
  }
})
