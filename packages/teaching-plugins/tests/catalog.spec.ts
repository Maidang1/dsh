/** Every plugin definition in the catalog is classified for the plugin library filter. */
import { PluginResponsibility } from '@harness-explorer/contracts'
import { describe, expect, it } from 'vitest'
import { devStages, responsibilities } from '../src/index.ts'

describe('catalog', () => {
  it('gives each plugin definition a responsibility', () => {
    const definitions = [...new Set(devStages.map(stage => stage.pluginDefinitionId))].sort()
    expect(Object.keys(responsibilities).sort()).toEqual(definitions)
    for (const responsibility of Object.values(responsibilities)) expect(PluginResponsibility.options).toContain(responsibility)
  })
})
