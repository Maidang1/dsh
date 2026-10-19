/** Plugin config rules shared by the runner, commit-time validation and the explorer (CTX-04). */
import type { JsonValue } from './domain.ts'

/** Name of the scope every composition starts from. */
export const ROOT_SCOPE = 'root'

/** Keys of `config` that `supported` does not name; a config that is not an object has none. */
export function unsupportedConfigKeys(config: JsonValue | undefined, supported: readonly string[]): string[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return []
  return Object.keys(config).filter(key => !supported.includes(key))
}

/** Equality of two JSON values regardless of object key order. */
export function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  const canonical = (value: JsonValue | undefined): unknown => (Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
      : value)
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}
