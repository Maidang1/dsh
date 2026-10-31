---
title: "会话日志：模型可见即已记录"
description: "dsh 不单独保存模型对话历史，而是把一切写进一份仅追加的事件日志，再从日志派生模型看到的消息。本文讲解事件词汇、surface 投影、压缩替换、请求头、fork 与持久化迁移，以及这套设计对回放和 KV cache 的影响。"
date: 2026-10-25
author: Madinah
tags: [DeepSeek Harness, dsh, 事件溯源, 会话持久化, 上下文压缩, KV Cache]
series: 从架构读懂 DeepSeek Harness
order: 5
baseline: dsh-v0.2.1-rc.2 (687f282e)
---

# 会话日志：模型可见即已记录

> 系列第 5 篇。本文回答：dsh 怎样保证“模型当时看到了什么”永远可以精确重建？上下文压缩、会话 fork、崩溃恢复和格式升级，怎样在一份只能追加的日志上实现？

## 一条规则

dsh 仓库约定里有一条规则被反复引用：

> **Model-visible ⟺ logged**：任何进入模型请求的内容，都必须能从会话日志重建；新增一种模型可见的输入，就要新增一种会话事件。

很多 agent 框架同时维护两份数据：一份是发给模型的 `messages` 数组，一份是给 UI 和持久化用的记录。两者迟早会不一致：某个插件往 `messages` 里塞了一段上下文却没记下来，或者压缩改写了历史，事后谁也说不清模型当时看到的是哪个版本。

dsh 的做法是只保留一份数据。`Session` 是一份由类型化 `SessionEvent` 组成的**仅追加日志**，是 agent 完整交互历史的唯一真源。模型消息历史**从日志派生**，从不单独存储；回放就是从同一组事件重新派生。

## 事件词汇：SessionEventMap

日志里能出现哪些事件，由 [`SessionEventMap`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/types.ts#L282-L429) 定义。核心事件可以分成三组：

| 分组 | 事件 | 说明 |
|---|---|---|
| 结构 | `turn/start`、`turn/end`、`step/start`、`step/end` | 轮次和步骤的边界；`turn/end` 带结束原因 |
| 模型可见 | `system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result` | 会投影成模型消息 |
| 仅日志 | `assistant/attempt`、`tool/call`、`request/header`、`request/context`、`session/end-seed` | 记录事实，不进入模型历史 |

几个值得细看的设计：

- `user/message` 不只是用户的输入。`agent.inject()` 注入的上下文（文件变更通知、子目录 AGENTS.md、技能内容、定时提醒）和目标续跑轮次也是 `user/message`，三者原样投影 `content`，用 `source` 字段区分来源。
- `assistant/message` 嵌入了这次尝试的完整紧凑流（`stream`）和 token 用量。日志里没有单独的 usage 记录，模型输出和它的计费一起走。
- `assistant/attempt` 记录失败、重试、取消的尝试，同样嵌入流，但不会凭空制造模型可见的历史。
- `tool/call` 保存模型生成的原始 `arguments` JSON 字符串，不做解析。

这个映射是**可合并扩展**的。插件通过 TypeScript 声明合并加入自己的事件类型，比如压缩 seam 加了 `compaction/start`、`compaction/summary`、`compaction/end`，钩子桥接加了 `hook/invoked`、`hook/result`。所有事件数据必须是无损 JSON，`Session.append` 在源头运行时校验，不可序列化的数据直接被拒绝，坏事件永远进不了日志。

## surface：日志之上的有序投影

如果模型历史只是“把模型可见事件按顺序排好”，压缩就无从实现：压缩要用摘要代替一段旧历史，可日志又只能追加。dsh 用 **surface** 解决这个矛盾。

surface 是日志之上的一个有序投影，只有五种模型可见事件（`SurfaceEventType`）能进入它。这些事件在追加时必须声明自己如何加入 surface，即 `SurfaceOp`：

```ts
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
```

- `'append'`：追加到尾部，用户、助手、工具消息走这条常规路径。
- `{ op: 'replace', startSeq, endSeq }`：用这条新事件替换当前 surface 中 `startSeq` 到 `endSeq`（闭区间）的节点。新事件的 `sourceEventSeqs` 必须列出所有被遮蔽的节点。

压缩就是这样实现的。压缩后端生成摘要后，追加一条携带 `surfaceOp: { op: 'replace', startSeq, endSeq }` 的 `user/message`。原始事件仍然留在日志里，只是不再出现在派生出的模型消息中。日志依旧只追加，被压缩掉的内容依旧可查。

压缩 seam 还导出了 `toolPairingBalancedBefore/After` 两个辅助函数，确保替换边界不会切断一个尚未得到结果的工具调用，否则模型会看到一个悬空的 `tool-call`。

## 从日志到消息：deriveMessages

`Session.deriveMessages()` 把 surface 投影为模型看到的 `Message[]`。它有两个性质：

- **缓存**：每个 surface 节点在首次出现时投影一次；发生 replace 时重建。
- **冻结**：每次调用返回一个新数组，但其中的消息是共享的深冻结对象。通过投影结果去修改已记录的历史，在类型上就无法表达。

投影规则很直接：`user/message` 变成一条 user 消息；`assistant/message` 变成一条 assistant 消息，**内容为空时跳过**（比如因 max-tokens 截断且没有任何输出的步骤，它的事件仍然记录流和用量，但不能进入提供方的对话记录）；`tool/result` 变成一条 tool 消息。其他事件都是结构信息，不产生消息。

逐节点的投影函数 `deriveEventMessage(event)` 也被公开导出，独立的读取器（比如离线分析工具）可以用完全相同的规则重建任意日志前缀，不会与缓存产生分歧。

插件如果需要改写已有消息的内容（例如把大图片替换为引用），注册的是**纯消息投影**，独立读取器显式传入同一个处理器。改写规则本身也是确定的、可重放的。

## 系统提示词也是一条消息

在多数框架里，系统提示词是请求上的一个独立字段。dsh 把它放进了日志：渲染后的系统提示词以 `system/message` 事件进入 surface，作为第 0 号节点。

为什么要这么麻烦？因为系统提示词会变：工具集合变了、插件贡献的片段变了、运行时事实变了。如果它只是请求字段，日志里就看不出某次请求用的是哪个版本。放进 surface 之后：

- 提示词没变时，系统节点保持不动，什么都不写；
- 变了且路由支持“历史内更新”（`systemPromptUpdate: 'in-history'`）时，在已缓存历史之后**追加**一条新的系统消息，保住前面的 KV cache 前缀；
- 路由不支持，或者开启了新的请求序列时，把提示词归并回首个系统节点，用有日志记录的逐节点替换完成；
- 渲染结果为空时，清除所有生效的系统节点，模型不会再看到任何旧指令。

这背后是一个很实际的权衡：**KV cache 命中率**。前缀不变，提供方就能复用缓存；改写首节点会让从第一个变化 token 起的缓存全部失效。system-prompt 包的 README 有一节专门写“KV Cache 影响”，dsh 的每个包 README 都要求写这一节。

## 请求头与请求序列

`request/header` 记录下一次请求的完整“信封”：调用配置（provider、model、推理强度、`maxTokens`）、适配器填入的默认值、工具 schema。它只在第一次请求、恢复后第一次请求、头部变化或开启新序列时写入，原因记在 `reason` 字段里（`initial`、`resume`、`change`、`series`）。

**请求序列（request series）**是 dsh 用来描述“这些请求共享同一个可缓存前缀”的概念。surface 被替换（压缩、图片省略）、插件在 pre-step 中显式声明 `startsRequestSeries`、或者路由不支持工具增量更新而工具集合变了，都会开启新序列。序列信息同样写在日志里，所以事后能解释每一次缓存失效的原因。

`request/context` 记录路由和容量元数据，只在变化时写，不参与请求重建。

## fork：在轮次边界分叉

因为模型上下文完全由日志决定，fork 一个会话就是“复制一段日志前缀，开一个新会话”。`SessionStore.fork(source, boundary?, childSessionId?)`：

- 选取源会话到 `boundary`（含）为止的事件，默认是最后一个事件；
- **要求所选前缀结束时没有打开的轮次**，否则拒绝，而不是静默截断；
- 新会话带有深克隆的 seed 事件、`parentSession`、`isSeeded: true`、精确的 `inheritedEventCount` 和继承的工作目录；
- 子会话在继承前缀的切点处有一个 `session/end-seed { inherited: true }` 标记，区分继承来的历史和自己的新工作。

用户可以从任意稳定的轮次之间分叉，包括较早的 `turn/end`。子代理插件 `dsh-subagent-fork-in-process` 也是基于这个原语，在父会话的已完成前缀上派生子会话。

## 持久化：句柄、批量写与崩溃恢复

日志的持久化是一个独立的 seam：`SessionPersistence` 定义 `create`/`open`/`stat`/`list` 等方法，每个会话通过 `SessionHandle` 读写。rc.2 随产品交付的后端是 `dsh-session-persistence-jsonl`：逐会话的仅追加 JSONL 日志，默认存储为带 checksum 的连续 Zstandard frame，逐批 `fsync`。

几个关键行为：

- **不阻塞生产方。** `session/event` 是同步通知，后端把事件放进有界的 write-behind 窗口批量写入；循环在领取下一个普通轮次之前调用 `session/flush` 作为顺序与错误的检查点。
- **单写者。** 活跃会话的写句柄由其生命周期所有者持有，并发的 `open(id, 'write')` 会以 `SessionAlreadyOwnedError` 拒绝。
- **崩溃恢复不截断。** 轮次中途崩溃的日志以一个没有 `turn/end` 的 `turn/start` 结尾。持久化层不会截断它（长任务的一个轮次可能非常大），只丢弃物理上撕裂的尾部碎片。修复是读方的职责：恢复时 agent-loop 计算缺失的工具错误结果、未闭合的 `step/end`，以及一个合成的 `turn/end { reason: { kind: 'interrupted' } }`，作为普通批次追加后才发布会话。`interrupted` 是唯一一个不由循环本身发出的结束原因。

## 格式迁移：只加不改

会话格式会演进，而用户磁盘上已经有旧格式的日志。dsh 的规则非常保守：

- JSONL v0 使用 `session.jsonl[.zstd]`，v1 及之后使用 `session.vN.jsonl[.zstd]`；
- **已提交的 generation 文件绝不重命名、替换或删除**；
- 每个迁移包只负责一个相邻步骤 `vN → vN+1`；
- 只读打开时，在内存中组合迁移链，直接使用结果，不写任何东西；写打开时，先编码、校验，再在源文件旁边排他发布一个以最终版本命名的后继文件；
- 遇到来自未来版本的日志直接拒绝。

`SESSION_FORMAT_VERSION` 只在现有判别字段无法防止不安全解读时才提升；同版本内的变化必须保证旧读者行为安全。

## 投影服务：给 UI 和插件用的状态

UI 和插件经常需要从日志算出一些状态，比如当前轮次边界、沙箱模式、token 计数。逐个插件各扫一遍日志代价很高，也容易各算各的。`dsh-session-projection` 提供 `ctx.sessionProjections`：

- 插件注册投影单元，增量折叠已提交的事件；
- host 侧消费者通过 `stateOf()` 读取单个类型化状态；
- 传输层通过 `snapshot()` 批量取得裁剪后的客户端视图。

它是一个**强制 seam**：读取方要么在激活时要求该服务，要么在注册表或所需 key 缺失时明确失败，不能为缺失的状态静默提供默认值。agent-loop 自己也通过它注册了共享的 `turnBoundary` 状态。

## 代价与收益

把一切都写进一份只追加的日志，收益很明确：

- **可审计**：任何一次请求都能从日志精确重建，包括系统提示词和工具 schema；
- **可回放**：UI 回放、遥测、对话导出、fork、恢复都从同一份事实派生；
- **可压缩而不丢失**：replace 只改变投影，原始事件仍在；
- **可迁移**：格式升级不碰已提交的文件。

代价同样明确：

- **规则多**。surface 的替换约束、系统节点的协调规则、请求序列的判定，都需要专门的文档和测试维护。
- **日志会变大**。每次尝试都嵌入完整的流，长会话的日志体积可观。dsh 用 Zstandard 压缩、溢出（spill）插件把超大工具输出移出日志，并用紧凑流表示（同一内容块的连续 delta 收进一条记录，去掉重复的事件信封，但保留每个 token 边界和时间戳）来缓解。
- **扩展要守纪律**。插件新增模型可见输入，就必须新增会话事件并保证 JSON 可序列化；新增事件若破坏核心执行嵌套，就构成磁盘格式的破坏性变更。

## 小结

- 会话日志是唯一真源，模型历史从日志派生，从不单独存储。
- surface 是日志之上的有序投影，`append` 与 `replace` 两种操作让压缩在只追加的前提下成立。
- 系统提示词作为 surface 节点进入日志，更新策略围绕 KV cache 前缀复用设计。
- fork 要求在轮次边界，崩溃恢复由读方补写闭合事件，格式迁移只加不改。

下一篇看 surface 里那两样最“贵”的东西是怎么来的：[提示词组装与工具流水线](06-prompt-and-tools.md)。

## 参考

- [会话子系统](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/session.zh.md)
- [会话持久化](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/persistence.zh.md)
- [`session/src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/types.ts)
- [架构：会话日志](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.zh.md)
- [压缩 seam README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/compaction/compaction/README.zh.md)
- [system-prompt README：模型体验与 KV Cache 影响](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/system-prompt/README.zh.md)
