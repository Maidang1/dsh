---
title: "一个轮次的一生：Agent 与 AgentLoop"
description: "用户发出一条消息后，dsh 内核按什么顺序开启轮次、组装提示词、调用模型、执行工具、写入日志？本文沿着 agent-loop 的源码走完一个完整轮次，并解释每个扩展点的位置与取消、出错时的行为。"
date: 2026-10-25
author: Madinah
tags: [DeepSeek Harness, dsh, Agent Loop, 工具调用, 流式输出, 取消与恢复]
series: 从架构读懂 DeepSeek Harness
order: 4
baseline: dsh-v0.2.1-rc.2 (687f282e)
---

# 一个轮次的一生：Agent 与 AgentLoop

> 系列第 4 篇。本文回答：一条用户消息进入 dsh 之后，到模型回复、工具执行完毕，中间按什么顺序发生了哪些事？插件可以在哪些位置介入？取消和失败时日志里会留下什么？

本文的代码都来自 [`packages/core/agent-loop/src/agent.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts)。这个文件只有七百行左右，却是整个 dsh 运行时的中心。建议对照源码阅读。

## 两个术语：轮次与步骤

dsh 对“一来一回”有精确的定义：

- **步骤（step）**：一次模型请求，加上这次响应里请求的所有工具调用。
- **轮次（turn）**：零个或多个步骤。它在领取第一条输入之前打开，在不再欠下任何工作时关闭。

一个典型的编码任务是一个轮次、多个步骤：模型读文件（步骤 1），改文件（步骤 2），跑测试（步骤 3），最后总结（步骤 4，不再调用工具）。轮次可以没有步骤：比如插件拒绝了这次输入，轮次照样打开和关闭，只是不花一次模型调用。

## Agent 句柄：外部世界看到的接口

UI、SDK、子代理插件与一个 agent 打交道时，拿到的是 `Agent` 接口（定义在 `core/agent`，不在 `agent-loop`）。关键字段：

| 字段 | 含义 |
|---|---|
| `id` | 以会话为依托的 agent 标识（`SessionId`） |
| `session` | 这个 agent 驱动的会话，其日志是唯一真源 |
| `inbox` | 持久的待处理输入 |
| `status` | `'idle'` 或 `'running'`，每次 `agent/status` 变化时同步 |
| `ctx` | agent 作用域的上下文，通过它注册的东西只对这个 agent 生效 |

输入通过同一个 inbox 进入驱动器。inbox 有两个边界：`next-turn`（下一个轮次）和 `next-step`（最近的步骤边界）。统一的入口是 `send(message, target, wakeup)`，另外三个方法是它的固定预设：

| 方法 | 进入哪个边界 | 是否唤醒驱动器 | 典型用途 |
|---|---|---|---|
| `followup(message)` | 下一个轮次，自成一轮 | 是 | 用户发出新的一条消息 |
| `steer(message)` | 最近的步骤边界 | 是 | 运行中途追加指示 |
| `inject(message)` | 下一个 pre-step | 否 | 插件注入上下文（文件变更通知、子目录 AGENTS.md、技能内容等） |

`inject` 不唤醒驱动器，这一点很重要：它保证插件注入上下文不会凭空触发一次模型调用，注入的内容会等到下一次有人唤醒驱动器时才进入请求。

另外还有 `cancel(cause)` 取消当前活动、`whenIdle()` 等待静止、`runMaintenance(task)` 在空闲时执行一次不属于任何轮次的维护任务（比如手动压缩）。

## 驱动器的三种阶段

驱动器内部用一个三态的 `Phase` 描述自己在做什么：

```ts
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }
```

同一时刻只有一种阶段。`running` 阶段持有一个 `AbortController`，轮次内的一切异步操作都共享它的 signal。驱动器的主循环简单到只有一行：

```ts
while (await this.turn()) {}
```

`turn()` 跑完一个轮次，如果 inbox 里还有待处理的输入就返回 `true`，接着跑下一个轮次。

## 全景：一个轮次的事件序列

上游架构文档给出了一个轮次的完整流程，这里按源码顺序整理成带注释的版本。带 `→ 日志` 的是追加到会话日志的持久事件，其余是实时扩展点。

```text
turn/start                                           → 日志
│
├─ 领取输入：inbox.claim('next-turn')
├─ system-prompt/assemble        (waterfall) 组装片段、上下文、工具 schema
├─ agent/pre-step                (waterfall) reject，或 enter(messages)
│    reject / 首步为空 → 关闭轮次，不花模型调用
│
├─ step/start                                        → 日志
│  ├─ agent/request              (waterfall) 改写模型调用配置
│  ├─ ctx.llm.prepareCall()      解析路由，绑定适配器
│  ├─ system/message             按节点协调系统提示词   → 日志
│  ├─ user/message × N           接纳本步输入           → 日志
│  ├─ request/header、request/context（按需）          → 日志
│  ├─ 从日志派生并冻结请求
│  ├─ llm/stream                 (waterfall) 流式请求
│  │    agent/assistant-stream   (emit) start / chunk* / end
│  ├─ assistant/message 或 assistant/attempt          → 日志
│  │    失败 → agent/request-error (waterfall) → 重试或放弃
│  ├─ 工具调用 × M：tool/call → tools/* 流水线 → tool/result   → 日志
│  └─ step/end                                       → 日志
│
├─ 还欠模型一次请求，或有新的 next-step 输入 → 领取 → 下一个步骤
├─ agent/turn-stopping           (serial) 轮次即将关闭
│
turn/end                                             → 日志
```

下面分段展开。

## 第一段：开启轮次与 pre-step

`turn()` 先追加 `turn/start`，然后进入步骤循环。每个步骤开始前都要经过 `preStep()`：

```ts
private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
  const signal = this.phase.abort.signal
  const claimed = this.inbox.claim(target, position.turn)
  const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
  signal.throwIfAborted()
  const decision = await this.dispatch.waterfall(
    'agent/pre-step', { messages: claimed, ...position, signal },
    (): Promise<PreStepDecision> => {
      const sections = renderContextSections(assembly)
      const context = this.runtimeContext.project(joinContextSections(sections), sections)
      return Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: context === undefined ? claimed : [...claimed, context],
      })
    },
  )
  signal.throwIfAborted()
  if (decision.kind === 'reject') return decision
  return { ...decision, assembly }
}
```

（节选，省略了阶段断言。）这段代码体现了三个设计点：

1. **先领取，再组装，再决策。** 领取的消息从 inbox 移除后，组装好的提示词和工具 schema 与之一起交给 `agent/pre-step` waterfall。
2. **默认决策在最内层。** 没有任何监听器干预时，默认是 `enter`，消息列表是领取到的消息加上运行时上下文快照（工作目录等动态事实，后文第 6 篇会讲）。
3. **监听器拥有否决权。** 监听器可以改写消息、追加消息，或者返回 `reject`。被拒绝时轮次以 `{ kind: 'blocked' }` 结束；首步被改写为空时，轮次以 `completed` 结束，同样不花模型调用。

压缩插件 `dsh-compaction-basic` 就挂在这里：它在派生请求之前检查上下文压力，必要时先剪枝工具结果或生成摘要。enter 决策还可以带上 `startsRequestSeries`，告诉循环“从这里开始是一个新的请求序列”，这会影响 KV cache 前缀的复用（[第 5 篇](05-session-log.md)）。

## 第二段：准备请求

进入步骤后，循环追加 `step/start`，然后调用 `prepareRequest()`。它做两件事：

```ts
const proposedConfig = await this.dispatch.waterfall(
  'agent/request', { turn, step, signal },
  () => Promise.resolve(seedConfig),
)
// ...
preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
```

- `agent/request` waterfall 允许插件替换模型调用配置（provider、model、推理强度、`maxTokens` 等）。种子配置来自 agent 的选项和日志中上一次记录的请求头。
- `ctx.llm.prepareCall()` 一次性解析路由、绑定适配器注册，返回一个 `PreparedLlmCall`。之后的模型解析、请求头记录和分派都使用同一个注册，即便中途有人替换了适配器，进行中的这次调用也不会串到新适配器上。

上游文档特别强调了一条顺序约束：**在这两个异步阶段中任何一处取消，都不会提交系统提示词或用户消息**。也就是说，被取消的步骤不会在日志里留下“模型并没有看到”的输入，“模型可见即已记录”反过来也成立。

## 第三段：接纳输入，冻结请求

准备好调用之后，循环才开始写日志：

1. 用 `system/message` 事件协调系统提示词节点。提示词没变就不写；变了就按路由能力决定原地替换首节点，还是在已缓存历史之后追加一条更新。
2. 把 enter 决策里的消息逐条追加为 `user/message`。重试时不会重复这一步。
3. 按需追加 `request/header`（完整请求头，包括工具 schema）和 `request/context`（路由与容量元数据）。
4. 从日志派生模型历史，冻结成一个不可变的请求对象。

注意第 4 步：**请求是从日志派生出来的，而不是在内存里一边拼一边发**。这保证了发出去的请求和日志里能重建出的请求完全一致。

## 第四段：流式响应与结算

请求经 `llm/stream` waterfall 流式发出。每个原始 chunk 都通过 `agent/assistant-stream` 事件实时发布给 UI（start、chunk*、end 三种 frame），同时在内存中累积。

流结束后，这次尝试必须**结算**成以下两种持久事件之一：

- `assistant/message`：成功的响应，包括内容为空或因 `max-tokens` 截断的响应。它嵌入了这次尝试的完整紧凑流（带时间戳的原始 chunk），以及 token 用量。
- `assistant/attempt`：失败、重试、取消或流错误的尝试。它同样嵌入流，但**不进入模型历史**。

失败时循环会发出 `agent/request-error` waterfall：

```ts
const action = await this.dispatch.waterfall(
  'agent/request-error', {
    turn, step,
    provider: request.provider,
    failure: finish.failure,
    retryPolicy: preparedCall?.retryPolicy,
    signal,
  },
  () => Promise.resolve<RequestErrorAction>(undefined),
)
if (action?.kind !== 'retry') {
  throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
}
continue
```

默认不重试。`dsh-llm-retry` 按退避策略返回 `{ kind: 'retry' }`；压缩插件在规范的上下文溢出错误（`CONTEXT_WINDOW_EXCEEDED`）时先压缩再要求重试。重试发生在仍然打开的这个步骤内，会重新准备调用，但不重复组装、pre-step 或用户消息接纳。

适配器这一侧有对应的约定：**一次适配器调用就是一次提供方尝试**，适配器禁用库内重试。重试的决策权统一收在 agent 层，每次尝试都在日志里留痕。

## 第五段：执行工具

如果 `assistant/message` 里有 `tool-call` 块，循环把它们交给 [`executeToolCalls()`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/tool-calls.ts)。调度规则：

- 每个工具声明执行模式：`exclusive` 或 `parallel`。
- `exclusive` 调用形成屏障，前面的调用全部完成后才开始，它完成后后面的才开始。
- `parallel` 调用进入一个有上限的滚动池，上限由 agent-loop 的 `maxParallelToolCalls` 配置，默认 10。
- 调用开始前会重新分类，所以执行模式可以依赖运行时状态。
- **分派可以重叠，但前置策略、结果和结果附带的上下文都按模型给出的顺序提交。** 日志里的 `tool/result` 顺序永远与模型请求的顺序一致。

每次调用都要经过工具注册表的完整流水线（`tools/pre-execute` → guard → 审批 → `tools/execute` → `tools/post-execute` → `tools/result`），第 6 篇专门讲。

工具执行完后，如果还欠模型一次请求（有工具结果要回传），或者 inbox 的 `next-step` 边界有新的 steering，循环就领取输入、进入下一个步骤。

## 第六段：关闭轮次

模型不再调用工具、`next-step` 也没有待处理输入时，循环发出 `agent/turn-stopping`：

```ts
if (turnEnds && this.inbox.nextStep.length === 0) {
  await this.dispatch.serial('agent/turn-stopping', { turn, signal })
  signal.throwIfAborted()
}
if (turnEnds && this.inbox.nextStep.length === 0) break
target = 'next-step'
```

它是 serial 事件，没有 `next()`。监听器如果认为“还没完”，可以调用 `agent.steer(...)` 往 `next-step` 放一条消息，循环检查到 inbox 非空就会继续下一个步骤，而不是关闭轮次。dsh 的会话目标（goal）功能就是通过 `agent/*` 事件实现续跑的。

最后在 `finally` 里追加 `turn/end`，携带结束原因。`TurnEndReason` 的取值包括 `completed`、`max-tokens`、`blocked`、`aborted`（带取消原因）、`error`（带结构化的 `LlmFailure`）等。其中 `max-tokens` 是粘性的：轮次里任何一个步骤撞到输出上限，后面步骤正常完成也不会把它降级为 `completed`。

## 取消与失败：日志永远自洽

agent 系统里最难处理的是中途打断。dsh 的原则是：**无论在哪里中断，日志都必须保持可回放**。几处具体实现：

- **流式输出中途取消**：已经送达的文本和推理前缀会被结算为一条带 `interrupted: true` 的 `assistant/message`；没有任何可见内容时结算为 `assistant/attempt`。
- **工具执行中途取消**：已开始的调用会被排干，未开始的调用记录合成的错误结果（`ABORTED_BEFORE_DISPATCH`），这样每个 `tool/call` 都有配对的 `tool/result`。
- **步骤内抛出异常**：步骤开始时会挂一个 `ToolCallRecovery` 监听会话事件；异常发生后，它为所有还没有结果的工具调用补写保守的 `tool/result`，然后照常追加 `step/end`。
- **第一个取消原因胜出**：`cancel(cause)` 对同一次活动只认第一个原因，原因被带进 `turn/end` 的 `aborted` 结束原因里。

这些规则的共同目的，是让“从日志重建模型历史”在任何中断点都成立。下一次恢复会话时，模型看到的是一份结构完整的对话，而不是一个悬空的工具调用。

## 为什么这么设计

回头看，agent-loop 的结构有几个一以贯之的选择：

- **扩展点都在决策点上。** pre-step 决定接纳什么，request 决定怎么调，request-error 决定是否重试，turn-stopping 决定是否结束。插件不需要修改循环就能改变这些决策。
- **先决策，后提交。** 所有可能被取消的异步步骤都在写日志之前完成，日志只记录已经确定发生的事实。
- **请求从日志派生。** 内存状态和持久状态不可能分叉。
- **重试集中在一处。** 适配器只尝试一次，重试策略统一由 agent 层的 waterfall 决定，每次尝试都有记录。

代价是这段代码的状态转换相当密集，各种“首次尝试才接纳用户消息”“取消时不提交系统提示词”的规则需要通过测试和文档维持。上游规定改动 agent-loop 必须同步更新架构文档，TypeScript 和 Python 两个 SDK 的期望输出也要在同一个 PR 里更新。

## 小结

- 步骤是一次模型请求加它调用的工具；轮次是零个或多个步骤。
- 输入统一进 inbox，`followup`、`steer`、`inject` 分别对应下一轮、下一步并唤醒、下一步不唤醒。
- 一个步骤的顺序是：pre-step → request → prepareCall → 提交 system/user 消息 → 从日志派生请求 → 流式响应 → 结算 → 工具 → step/end。
- 取消和失败都会被结算成结构完整的日志，保证回放和恢复总能成立。

循环反复提到“从日志派生”。下一篇看这份日志本身：[会话日志：模型可见即已记录](05-session-log.md)。

## 参考

- [`agent-loop/src/agent.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts)
- [`agent-loop/src/tool-calls.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/tool-calls.ts)
- [Agent 轮次与步骤生命周期（时序图）](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/agent-lifecycle.zh.md)
- [架构：轮次流程](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.zh.md#turn-flow)
- [核心子系统：Agent 句柄](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/core.zh.md#the-agent-handle)
- [`agent/src/runtime-types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/runtime-types.ts)
