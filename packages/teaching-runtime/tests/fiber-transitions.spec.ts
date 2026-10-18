/**
 * FIBER-01: the lifecycle transition table of Cordis 4.0.5 fibers
 * (vendor/cordis/src/fiber.ts `_setEpoch`, `_reload`, `_unload`, `_getState`),
 * observed through `internal/status`. Each case pins one path the plugin
 * tree can show; the inventory phase list alone cannot imply these.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Fiber, Plugin } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { toPluginPhase } from '../src/fiber-phase.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    probe: Probe
  }
}

class Probe extends Service {
  constructor(ctx: Context) {
    super(ctx, 'probe')
  }
}

const flush = async () => {
  for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve))
}

/** Phases of the named fiber, in order, starting from its initial phase. */
function watch(root: Context, name: string) {
  const phases: string[] = []
  root.on('internal/plugin', (fiber: Fiber) => {
    if (fiber.runtime?.name === name && fiber.uid !== null && !phases.length) phases.push(String(toPluginPhase(fiber.state)))
  })
  root.on('internal/status', (fiber: Fiber) => {
    if (fiber.runtime?.name === name) phases.push(String(toPluginPhase(fiber.state)))
  })
  return phases
}

const consumer = (apply: (ctx: Context) => unknown = () => {}): Plugin => ({ name: 'consumer', inject: ['probe'], apply })

describe('FIBER-01 lifecycle transitions', () => {
  it('pending → loading → active once the dependency appears', async () => {
    const root = new Context()
    const phases = watch(root, 'consumer')
    root.plugin(consumer())
    await flush()
    root.plugin(Probe)
    await flush()
    expect(phases).toEqual(['pending', 'loading', 'active'])
  })

  it('active → unloading → pending when the dependency is lost', async () => {
    const root = new Context()
    const phases = watch(root, 'consumer')
    const provider = root.plugin(Probe)
    root.plugin(consumer())
    await flush()
    await provider.dispose()
    await flush()
    expect(phases).toEqual(['pending', 'loading', 'active', 'unloading', 'pending'])
  })

  it('active → unloading → loading → active when the provider is replaced', async () => {
    const root = new Context()
    const phases = watch(root, 'consumer')
    const first = root.plugin(Probe)
    root.plugin(consumer())
    await flush()
    // A second provider cannot coexist; replace by disposing and providing in one tick.
    void first.dispose()
    root.plugin(Probe)
    await flush()
    expect(phases.slice(0, 3)).toEqual(['pending', 'loading', 'active'])
    expect(phases.at(-1)).toBe('active')
    expect(phases).toContain('unloading')
  })

  it('loading → unloading → failed when apply throws, and failed → loading → active when the dependency changes', async () => {
    const root = new Context()
    const phases = watch(root, 'consumer')
    let attempts = 0
    const provider = root.plugin(Probe)
    root.plugin(consumer(() => {
      attempts++
      if (attempts === 1) throw new Error('first activation fails')
    }))
    await flush()
    // _reload's catch invalidates the epoch, so effects collected before the throw are unloaded first.
    expect(phases).toEqual(['pending', 'loading', 'unloading', 'failed'])
    await provider.dispose()
    root.plugin(Probe)
    await flush()
    expect(phases.slice(4)).toEqual(['loading', 'active'])
    expect(attempts).toBe(2)
  })

  it('loading → unloading → pending when the dependency is lost during an async apply', async () => {
    const root = new Context()
    const phases = watch(root, 'consumer')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const provider = root.plugin(Probe)
    root.plugin(consumer(() => gate))
    await flush()
    expect(phases).toEqual(['pending', 'loading'])
    void provider.dispose()
    await flush()
    release()
    await flush()
    expect(phases).toEqual(['pending', 'loading', 'unloading', 'pending'])
  })

  it('pending → unloading → null (disposed) without ever running apply', async () => {
    const root = new Context()
    const phases = watch(root, 'consumer')
    let ran = false
    const fiber = root.plugin(consumer(() => { ran = true }))
    await flush()
    await fiber.dispose()
    await flush()
    expect(phases).toEqual(['pending', 'unloading', 'null'])
    expect(ran).toBe(false)
  })

  it('active → unloading → null on dispose; null means no active fiber, not success', async () => {
    const root = new Context()
    const phases = watch(root, 'consumer')
    root.plugin(Probe)
    const fiber = root.plugin(consumer(ctx => ctx.effect(() => () => { throw new Error('cleanup fails') })))
    await flush()
    await fiber.dispose()
    await flush()
    expect(phases).toEqual(['pending', 'loading', 'active', 'unloading', 'null'])
  })
})
