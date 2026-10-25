---
title: "Cordis：可撤销的服务、effect 与事件"
description: "dsh 的所有插件都建立在 Cordis 之上。本文讲清 Cordis 的五个核心概念：服务、inject、effect、类型化事件与作用域隔离，以及 dsh 为什么非它不可。"
date: 2026-10-25
author: Madinah
tags: [DeepSeek Harness, dsh, Cordis, 插件系统, 依赖注入, 中间件]
series: 从架构读懂 DeepSeek Harness
order: 2
baseline: dsh-v0.2.1-rc.2 (687f282e)
---

# Cordis：可撤销的服务、effect 与事件

> 系列第 2 篇。本文回答：dsh 的插件怎样注册能力、声明依赖、相互通信？为什么卸载一个插件不会留下残渣？waterfall 事件为什么是 dsh 的主要拦截手段？

## dsh 对插件框架的要求

[上一篇](01-everything-is-a-plugin.md)提到，dsh 要让模型适配器、持久化、执行环境乃至 agent loop 都能从配置替换，还要支持热重载。把这两个目标翻译成对插件框架的要求，大致是：

1. 消费方按**能力名**找服务，不 import 具体实现，这样配置可以决定由谁提供。
2. 插件的启动时机由**依赖是否就绪**决定，而不是由配置文件里的书写顺序决定。
3. 插件做过的每一次注册都能**原样撤销**，否则卸载、替换、热重载都会留下悬挂的监听器和过期的工具。
4. 插件之间可以**拦截和改写**彼此的决策，而不需要知道对方是谁。

dsh 选择的框架是 [Cordis](https://github.com/cordiverse/cordis)，以 vendor 方式放在仓库的 `vendor/cordis`，发布为 `@deepseek-ai/cordis`（rc.2 对应 4.0.5）。dsh README 引用了描述其设计的论文 *A Programming Paradigm for Spatiotemporal Composability*。本文不讨论论文，只讲 dsh 实际用到的部分。上游的 [Cordis 入门](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cordis-primer.zh.md)把它们归纳为五个概念，下面逐个展开。

## 概念一：插件与 fiber

插件可以是一个带 `apply(ctx)` 的函数或对象，也可以是 `Service` 子类。每个被加载的插件实例对应一个 **fiber**，即该实例的运行时句柄。fiber 在以下状态之间转换：

```text
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
                 ↘ FAILED
```

- **PENDING**：已经声明，但所需服务还不可用。
- **LOADING / ACTIVE**：`apply` 正在运行 / 已经完成。
- **FAILED**：`apply` 或配置校验抛出异常。
- **UNLOADING / DISPOSED**：清理逻辑正在运行 / 已全部拆除。

`ctx.plugin(child)` 从代码里挂载一个子插件并返回它的 fiber；YAML loader 为每个配置行做的也是同一件事。父插件卸载时，子插件随之递归卸载。

## 概念二：effect，注册即可撤销

Cordis 把“插件对外部世界产生的影响”统一建模为 **effect**：effect 主体在加载时运行，返回的 disposer 在卸载时运行。对于 Cordis 不直接管理的资源，比如定时器、连接、文件 watcher，要显式包在 `ctx.effect()` 里。上游教程中的例子：

```ts
function heartbeat(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => console.log('tick'), 200)
    return () => {
      clearInterval(timer)
      console.log('heartbeat cleaned up')
    }
  })
}
```

更重要的是，Cordis 和 dsh 自带的注册 API **本身就是 effect**：

- `ctx.on(event, listener)` 注册的监听器会在卸载时移除；
- `ctx.plugin(child)` 挂载的子插件随父插件 dispose；
- 服务注册是 effect，`ctx.tools.register(...)`、`ctx.systemPrompt.section(...)` 这类 dsh 注册表方法也会把 disposer 挂到调用方插件上。

所以写 dsh 插件时几乎不需要手动清理。上游把它定为仓库约定：每一项贡献都经过 `ctx.effect()` 或 `ctx.on()`，注册表的 `register()` 返回 disposer；每个注册表贡献还必须有“dispose fiber 后观察到注册被移除”的测试。

有一处容易踩坑：disposer 按注册的逆序启动，但多个**异步** disposer 会并发执行。拆除步骤有先后要求时，应当放进同一个 disposer 里依次 await。

> 在 Harness Explorer 里，`prompt-contributor` 课程演示了这一点：卸载一个注册了提示词片段的插件后，再次组装提示词，片段已经不在了。

## 概念三：服务与 inject

**服务**是挂在上下文上的具名能力。提供方继承 `Service` 并用一个名字注册自己，消费方用 `inject` 声明依赖：

```ts
// 提供方
declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}

export class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }
  greet(who: string) {
    return `Hello, ${who}!`
  }
}

// 消费方
export const name = 'consumer'
export const inject = ['greeter']

export function apply(ctx: Context) {
  console.log(ctx.greeter.greet('world'))
}
```

这里有两层机制：

- **运行时**：`super(ctx, 'greeter')` 把实例注册到 `ctx.greeter`。消费方在 `inject` 列出的服务全部就绪前保持 PENDING，所以 `apply` 里可以放心使用 `ctx.greeter`。
- **编译时**：`declare module` 通过 TypeScript 声明合并把 `greeter` 加进 `Context` 接口，`ctx.greeter` 因此有完整类型。它不生成任何代码。

`inject` 不是一次性的启动检查。运行中某项服务消失时（提供方被卸载或热替换），所有依赖它的插件会跟着卸载，服务恢复后再重新加载。结合 effect，消费方不会持有一个已经失效的服务引用，因为依赖消失时它自己的注册也一并撤销了。

这就是“从配置替换提供方”的底层原理。上游教程举的例子是：卸载 `dsh-bash-local` 这一配置行，挂载另一个提供 `shell` 服务的插件，所有注入了 `shell` 的插件都会重启并用上新实现。

可选依赖不用 `inject`，而是在使用处用 `ctx.get('name')` 探测。dsh 的包级约定明确要求：`ctx.<name>` 只用于声明过的注入，可选服务一律走 `ctx.get(name)`。

## 概念四：类型化事件与五种分发模式

服务适合直接调用；事件让插件在不知道谁在听的情况下发出通知或征求意见。事件名和监听器签名同样通过声明合并注册到 `interface Events`，约定用 `namespace/action` 命名。

Cordis 的每个事件有且只有一种分发模式，分发模式是事件公开约定的一部分：

| 模式 | 调用 | 语义 |
|---|---|---|
| emit | `ctx.emit(name, ...args)` | 同步广播，不等待、不收集返回值 |
| parallel | `await ctx.parallel(name, ...args)` | 所有监听器并发运行并一起等待 |
| serial | `await ctx.serial(name, ...args)` | 按注册顺序依次 await；第一个非空返回值胜出并停止后续监听器 |
| bail | `ctx.bail(name, ...args)` | serial 的同步版本 |
| waterfall | `ctx.waterfall(name, ...args, next)` | 环绕中间件，见下文 |

dsh 在事件的 JSDoc 里用 `@mode` 标签记录模式，生成的事件目录会和实际的分发调用点交叉校验，防止“声明是 waterfall，代码里却用 emit 发”这类漂移。

**waterfall：dsh 的拦截主力**

waterfall 是 Cordis 的环绕中间件。每个监听器拿到参数和一个 `next()`：

- 调用 `next()` 执行下游监听器（最内层是分发方传入的默认逻辑），下游的返回值经 `next()` 回到当前层，当前层可以改写后再返回；
- 不调用 `next()` 直接返回，就**短路**了后面所有逻辑。

上游教程用一个很短的例子说明了顺序。下面的代码据教程改写：去掉了声明合并与外层的立即执行函数，并在行尾加了注释标出输出：

```ts
ctx.on('demo/transform', async (input, next) => {
  const downstream = await next()
  return downstream.toUpperCase()          // 监听器 1：包装下游结果
})

ctx.on('demo/transform', async (input, next) => {
  if (input.includes('blocked')) return '** blocked **'   // 监听器 2：拥有决策权时短路
  return next()
})

await ctx.waterfall('demo/transform', 'hello', async () => 'hello')                 // HELLO
await ctx.waterfall('demo/transform', 'blocked words', async () => 'blocked words') // ** BLOCKED **
```

第二次调用中，监听器 2 没有调用 `next()`，最内层默认逻辑从未运行；返回途中，监听器 1 仍然把替换结果转成了大写。

dsh 内核里需要“多方协作做一个决策”的地方几乎都是 waterfall：

| 事件 | 所属 | 用途 |
|---|---|---|
| `agent/pre-step` | agent | 决定这一步接纳哪些输入，或拒绝这一步 |
| `agent/request` | agent | 改写模型调用配置 |
| `agent/request-error` | agent | 请求失败后决定是否重试（压缩插件在这里处理上下文溢出） |
| `llm/stream` | llm | 在适配器查找之前包装或短路模型流 |
| `system-prompt/assemble` | system-prompt | 改写组装出的片段、上下文、工具和变量 |
| `tools/pre-execute` / `tools/execute` / `tools/post-execute` | tools | 工具调用的前置策略、环绕分发、后置改写 |
| `approval/request` | approval | 让策略代替用户回答审批 |

与之对照，`agent/turn-stopping` 是 serial 事件，没有 `next()`；`tools/result` 和 `agent/assistant-stream` 是 emit，只用来观察。

由此产生 dsh 最重要的一条事件纪律，被写进了仓库根目录的约定：**只做观察或标注的 waterfall 监听器必须调用 `next()`**。日志插件忘记调用 `next()`，会悄无声息地吞掉下游的全部默认行为，而编译器不会报错。

> Harness Explorer 的 `tool-guard` 课程把 `tools/pre-execute` 的洋葱顺序和短路拒绝做成了可运行的阶段，可以在执行轨迹里看到每一层进入和返回的顺序。

## 概念五：作用域与隔离

全局只有一个 `ctx.tools` 时，怎样让不同 agent 看到不同的工具集合？dsh 用了两种机制。

**按 agent 的作用域注册。** 每个活跃 agent 都有自己的 `agent.ctx`。通过它注册的工具、提示词片段、变量和监听器只对这个 agent 生效，同名时遮蔽全局注册，并在 agent 销毁时自动撤销。实现在零依赖的 `core/scope` 库里：`ScopedLayers` 持有一个全局层和若干按需创建的作用域层，读取时把全局条目与作用域遮蔽项合并。需要按 agent 过滤的事件（比如 `tools/pre-execute`）以 `scopeTarget(base, key)` 生成的载体作为 `this` 类型，agent 作用域的监听器只会收到这个 agent 的调用。

**服务隔离（isolate）。** Cordis 的 group 可以为某个服务名声明独立的“领域”，组内插件看到的是组内的实例。上游服务文档里的例子：

```yaml
- id: group-a
  name: '@deepseek-ai/cordis-plugin-group'
  group: true
  isolate:
    shell: true
  config:
    - name: '@deepseek-ai/dsh-bash-local'
      config:
        timeoutMs: 5000
    - name: './src/plugin-a.ts'
```

`group-a` 和另一个同样隔离了 `shell` 的 `group-b` 各自看到自己的 Bash 实例，互不影响。dsh 的 agent preset 就依赖这个机制：preset 里的服务行需要 `isolate`，这样不同会话可以拥有不同的能力集合（[第 7 篇](07-capability-seams.md)）。

## 把五个概念放在一起：一个工具插件

上游 Cordis 教程最后一章把这些概念用到了真实的 dsh 服务上。一个注册工具的插件只有十几行：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet the named person.',
    parameters: {
      name: { type: 'string', required: true, description: 'Who to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
}
```

- `inject: ['tools']` 让插件等待工具注册表就绪；
- `ctx.tools.register(...)` 是 effect，插件卸载时工具自动注销；
- 工具 schema 由工具注册表自动贡献给 system-prompt 组装，模型下一步就能看到它；
- 另一个插件监听 `tools/result` 就能观察每次调用的结果，两者互不知道对方存在。

组合这两个插件时，还需要在配置里放上 `@deepseek-ai/dsh-system-prompt`，因为 `dsh-tools` 注入了 `systemPrompt` 服务；少了它，工具插件会停在 PENDING。

## 排查：插件为什么没反应

依赖驱动加载的另一面是：`inject` 了一个没人提供的服务，插件就会一直等待，不输出也不报错。上游教程给出的诊断方法是遍历注册表，找出处于 PENDING 的 fiber：

```ts
import { FiberState, type Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context) {
  setTimeout(() => {
    for (const runtime of ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        if (fiber.state === FiberState.PENDING) {
          console.log(`${fiber.name} is PENDING — a required service is missing`)
        }
      }
    }
  }, 500)
}
```

在完整的 dsh 应用里，启动器会在 Loader 结算后报告未激活的条目，required 条目无法激活时直接以 `StartupError` 失败（[第 3 篇](03-profiles-bundles-and-boot.md)）。

## 小结

- Cordis 给 dsh 提供了五样东西：插件与 fiber 生命周期、可撤销的 effect、按名字查找的服务与 `inject`、五种分发模式的类型化事件、作用域与服务隔离。
- “注册即 effect”让卸载、替换和热重载天然安全；`inject` 的持续跟踪让替换提供方时消费方自动重启。
- waterfall 是 dsh 的主要拦截手段，观察型监听器必须调用 `next()`。
- 代价是间接层和静默的 PENDING 状态，排查时要从配置树和 fiber 状态入手。

下一篇看这些插件是怎样被组合成一个应用的：[从 profile 到插件树](03-profiles-bundles-and-boot.md)。

## 参考

- [Cordis 入门](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cordis-primer.zh.md)
- [Cordis 教程（7 章）](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cordis-tutorial)
- [服务与服务隔离](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/user/develop/framework/service.zh.md)
- [作用域注册 scope](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/scope.zh.md)
- [`vendor/cordis/src/fiber.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/vendor/cordis/src/fiber.ts)
- [Cordis 上游仓库](https://github.com/cordiverse/cordis)
