import type { PluginPhase } from '@harness-explorer/contracts'

/**
 * Runtime values of Cordis' `const enum FiberState` (vendor/cordis/src/fiber.ts at the
 * pinned commit). The enum is erased at build time, so consumers must mirror it.
 */
export const FiberStateValue = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

/**
 * Map a Cordis fiber state to the inventory phase vocabulary
 * (packages/host/plugin-inventory/src/types.ts). DISPOSED has no active
 * root fiber and maps to null — it does not mean "unloaded successfully".
 */
export function toPluginPhase(state: number): PluginPhase {
  switch (state) {
    case FiberStateValue.PENDING: return 'pending'
    case FiberStateValue.LOADING: return 'loading'
    case FiberStateValue.ACTIVE: return 'active'
    case FiberStateValue.FAILED: return 'failed'
    case FiberStateValue.UNLOADING: return 'unloading'
    case FiberStateValue.DISPOSED: return null
    default: throw new RangeError(`unknown Cordis fiber state ${state}`)
  }
}
