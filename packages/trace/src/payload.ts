import { createHash } from 'node:crypto'
import type { JsonValue } from '@harness-explorer/contracts'

/** Serialize with sorted object keys so equal values always hash the same. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`
}

export function hashJson(value: JsonValue): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/**
 * Convert an arbitrary captured value into an immutable JSON snapshot. Functions,
 * symbols and class instances that are not plain data are rejected rather than
 * silently dropped, so the trace never holds live references.
 */
export function toJsonSnapshot(value: unknown, path = '$'): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`non-finite number at ${path}`)
    return value
  }
  if (value === undefined) throw new TypeError(`undefined at ${path}`)
  if (Array.isArray(value)) return value.map((item, index) => toJsonSnapshot(item, `${path}[${index}]`))
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`non-plain object at ${path}`)
    }
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      result[key] = toJsonSnapshot(item, `${path}.${key}`)
    }
    return result
  }
  throw new TypeError(`unsupported ${typeof value} at ${path}`)
}

/** Content-addressed store for large trace values. */
export class PayloadStore {
  private readonly values = new Map<string, JsonValue>()
  private bytes = 0

  put(value: JsonValue): string {
    const ref = hashJson(value)
    if (!this.values.has(ref)) {
      this.values.set(ref, value)
      this.bytes += canonicalJson(value).length
    }
    return ref
  }

  get(ref: string): JsonValue {
    const value = this.values.get(ref)
    if (value === undefined) throw new Error(`unknown payload ${ref}`)
    return value
  }

  has(ref: string) {
    return this.values.has(ref)
  }

  get totalBytes() {
    return this.bytes
  }

  entries() {
    return this.values.entries()
  }
}
