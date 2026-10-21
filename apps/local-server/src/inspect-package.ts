/**
 * Reports the plugin shape of one installed package entry as a single JSON
 * line on stdout: { name, inject, configKeys, hasDefault, provides }. Forked
 * by PackageManager so untrusted package code never runs inside the control
 * service process.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Inject may be an array, { name: { required } }, or { required, optional }; keep the required names. */
function requiredInject(inject: unknown): string[] {
  if (Array.isArray(inject)) return inject.filter((name): name is string => typeof name === 'string')
  if (inject && typeof inject === 'object') {
    const list = (inject as { required?: unknown }).required
    if (Array.isArray(list)) return list.filter((name): name is string => typeof name === 'string')
    return Object.entries(inject)
      .filter(([, meta]) => !!(meta && typeof meta === 'object' && (meta as { required?: boolean }).required))
      .map(([name]) => name)
  }
  return []
}

/** Config keys of a schemastery object schema (a callable function with a `dict`), or of a zod-like `shape`. */
function configKeys(config: unknown): string[] {
  if (!config || (typeof config !== 'object' && typeof config !== 'function')) return []
  const keys = (config as { dict?: unknown; shape?: unknown }).dict ?? (config as { shape?: unknown }).shape
  return keys && typeof keys === 'object' ? Object.keys(keys) : []
}

const entry = process.argv[2]
if (!entry) throw new Error('usage: inspect-package.ts <entry module>')
const module = await import(pathToFileURL(entry).href) as Record<string, unknown>
const plugin = (module.default ?? module) as { name?: unknown; inject?: unknown; Config?: unknown }
const source = readFileSync(entry, 'utf8')
// Services a class plugin publishes: super(ctx, "service") in its constructor.
const provides = [...source.matchAll(/super\(\s*ctx\s*,\s*["']([\w.-]+)["']/g)].map(match => match[1]!)
process.stdout.write(`${JSON.stringify({
  name: typeof plugin.name === 'string' ? plugin.name : null,
  inject: requiredInject(plugin.inject),
  configKeys: configKeys(plugin.Config),
  hasDefault: module.default !== undefined,
  provides,
})}\n`)
