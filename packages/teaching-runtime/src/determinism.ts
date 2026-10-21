/**
 * Deterministic runs must yield identical traces (TURN-01), but upstream mints
 * message and record ids from randomness: `randomUUID` from `node:crypto`,
 * and `globalThis.crypto.getRandomValues` in `@deepseek-ai/dsh-util-crypto`.
 * For the length of a deterministic run both draw from a seeded generator,
 * and `Date.now()`, which stamps session records and stream chunks, reads a
 * virtual clock that advances one millisecond per call.
 * Node's documented `syncBuiltinESMExports()` carries the replacement into the
 * live `import { randomUUID } from 'node:crypto'` bindings upstream modules
 * hold; no upstream code changes. Real runs keep real randomness.
 */
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'

type Uuid = `${string}-${string}-${string}-${string}-${string}`

let active = false

/** mulberry32: a small, fast 32-bit generator; enough for ids, never for secrets. */
function seeded(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }
}

/** Virtual epoch of deterministic runs: 2026-01-01T00:00:00Z. */
export const VIRTUAL_EPOCH = Date.UTC(2026, 0, 1)

/** Install seeded randomness and a virtual clock; the returned function restores the real sources. */
export function useSeededRandomness(seed = 1): () => void {
  if (active) throw new Error('seeded randomness is already installed; deterministic runs cannot overlap in one process')
  active = true
  const next = seeded(seed)
  const webCrypto = globalThis.crypto as typeof globalThis.crypto & Record<string, unknown>
  const original = { randomUUID: crypto.randomUUID, getRandomValues: Object.getOwnPropertyDescriptor(webCrypto, 'getRandomValues'), webRandomUUID: Object.getOwnPropertyDescriptor(webCrypto, 'randomUUID') }

  const getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (!array) return array
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    for (let index = 0; index < bytes.length; index += 4) {
      const value = next()
      for (let offset = 0; offset < 4 && index + offset < bytes.length; offset++) bytes[index + offset] = (value >>> (offset * 8)) & 0xFF
    }
    return array
  }
  const randomUUID = (): Uuid => {
    const hex = Array.from(getRandomValues(new Uint8Array(16)), (byte, index) =>
      (index === 6 ? (byte & 15) | 64 : index === 8 ? (byte & 63) | 128 : byte).toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  const realNow = Date.now
  let clock = VIRTUAL_EPOCH
  Date.now = () => clock++

  crypto.randomUUID = randomUUID
  Object.defineProperty(webCrypto, 'getRandomValues', { value: getRandomValues, configurable: true, writable: true })
  Object.defineProperty(webCrypto, 'randomUUID', { value: randomUUID, configurable: true, writable: true })
  syncBuiltinESMExports()
  return () => {
    Date.now = realNow
    crypto.randomUUID = original.randomUUID
    const restore = (name: string, descriptor: PropertyDescriptor | undefined) => {
      if (descriptor) Object.defineProperty(webCrypto, name, descriptor)
      else delete webCrypto[name]
    }
    restore('getRandomValues', original.getRandomValues)
    restore('randomUUID', original.webRandomUUID)
    syncBuiltinESMExports()
    active = false
  }
}
