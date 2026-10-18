/**
 * P0-04 probe: pins the behaviour of the reused Cordis 4.0.5 that the teaching
 * runtime builds on. These are observations of upstream code, not teaching code.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { FiberStateValue as FiberState } from '../src/fiber-phase.ts'
import { describe, expect, it } from 'vitest'

declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: Greeter
  }
  interface Events {
    'probe/pipe'(value: string[], next: () => string[]): string[]
  }
}

class Greeter extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }

  greet() {
    return 'hello'
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('Cordis dependency lifecycle (CTX-01, CTX-02, LIFE-01 probes)', () => {
  it('keeps a consumer pending until the injected service appears, then activates once', async () => {
    const root = new Context()
    let activations = 0
    let disposals = 0
    const consumer = root.plugin({
      name: 'consumer',
      inject: ['greeter'],
      apply(ctx: Context) {
        activations++
        expect(ctx.greeter.greet()).toBe('hello')
        ctx.effect(() => () => { disposals++ })
      },
    })
    await flush()
    expect(consumer.state).toBe(FiberState.PENDING)
    expect(activations).toBe(0)

    const provider = root.plugin(Greeter)
    await provider
    await consumer
    expect(consumer.state).toBe(FiberState.ACTIVE)
    expect(activations).toBe(1)

    await provider.dispose()
    await flush()
    expect(disposals).toBe(1)
    expect(consumer.state).toBe(FiberState.PENDING)

    root.plugin(Greeter)
    await flush()
    expect(consumer.state).toBe(FiberState.ACTIVE)
    expect(activations).toBe(2)
  })

  it('runs effect disposers in reverse order and only once', async () => {
    const root = new Context()
    const order: string[] = []
    const fiber = root.plugin((ctx: Context) => {
      ctx.effect(() => () => order.push('first'))
      ctx.effect(() => () => order.push('second'))
    })
    await fiber
    await fiber.dispose()
    await fiber.dispose()
    expect(order).toEqual(['second', 'first'])
  })

  it('reports lifecycle transitions through internal/status', async () => {
    const root = new Context()
    const seen: Array<[number, number]> = []
    root.on('internal/status', (fiber, oldValue) => {
      if (fiber.runtime?.name === 'watched') seen.push([oldValue, fiber.state])
    })
    const fiber = root.plugin({ name: 'watched', apply() {} })
    await fiber
    await fiber.dispose()
    expect(seen[0]).toEqual([FiberState.PENDING, FiberState.LOADING])
    expect(seen.at(-1)?.[1]).toBe(FiberState.DISPOSED)
  })
})

describe('Cordis service isolation (CTX-03 probe)', () => {
  it('resolves each isolated sibling scope to its own provider without leaking', async () => {
    const root = new Context()
    const left = root.isolate('greeter')
    const right = root.isolate('greeter')
    class Named extends Service {
      constructor(ctx: Context, readonly label: string) {
        super(ctx, 'greeter')
      }
      greet() {
        return this.label
      }
    }
    left.plugin({ name: 'left-provider', apply: (ctx: Context) => { new Named(ctx, 'left') } })
    const seen: string[] = []
    const consumer = (ctx: Context) => { seen.push((ctx.greeter as unknown as Named).greet()) }
    const leftConsumer = left.plugin({ name: 'left-consumer', inject: ['greeter'], apply: consumer })
    const rightConsumer = right.plugin({ name: 'right-consumer', inject: ['greeter'], apply: consumer })
    await flush()
    expect(seen).toEqual(['left'])
    expect(leftConsumer.state).toBe(FiberState.ACTIVE)
    expect(rightConsumer.state).toBe(FiberState.PENDING)
    expect(root.get('greeter')).toBeUndefined()

    right.plugin({ name: 'right-provider', apply: (ctx: Context) => { new Named(ctx, 'right') } })
    await flush()
    expect(seen).toEqual(['left', 'right'])
  })
})

describe('Cordis waterfall (EVT-01, EVT-02 probes)', () => {
  it('is around-middleware: outer enters, delegates, and returns last', () => {
    const root = new Context()
    const log: string[] = []
    root.on('probe/pipe', (value, next) => {
      log.push('A-before')
      const result = next()
      log.push('A-after')
      return [...result, 'A']
    })
    root.on('probe/pipe', (value, next) => {
      log.push('B-before')
      const result = next()
      log.push('B-after')
      return [...result, 'B']
    })
    const result = root.waterfall('probe/pipe', ['seed'], () => {
      log.push('inner')
      return ['inner']
    })
    expect(log).toEqual(['A-before', 'B-before', 'inner', 'B-after', 'A-after'])
    expect(result).toEqual(['inner', 'B', 'A'])
  })

  it('short-circuits when a listener does not call next', () => {
    const root = new Context()
    const log: string[] = []
    root.on('probe/pipe', () => {
      log.push('A')
      return ['vetoed']
    })
    root.on('probe/pipe', (value, next) => {
      log.push('B')
      return next()
    })
    const result = root.waterfall('probe/pipe', [], () => {
      log.push('inner')
      return []
    })
    expect(result).toEqual(['vetoed'])
    expect(log).toEqual(['A'])
  })

  it('announces every non-internal dispatch through internal/dispatch', () => {
    const root = new Context()
    const dispatches: string[] = []
    root.on('internal/dispatch', (mode, name) => { dispatches.push(`${mode}:${name}`) })
    root.waterfall('probe/pipe', [], () => [])
    expect(dispatches).toEqual(['waterfall:probe/pipe'])
  })
})
