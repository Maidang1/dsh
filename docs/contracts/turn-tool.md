# 对话与工具契约

- 上游：`packages/core/agent-loop/src/agent.ts`（`turn()`、`preStep()`、`step()`），`packages/core/session/src/types.ts`（持久事件），`packages/core/tools/src/index.ts`。
- 执行实现：npm 包 `session@0.2.1-rc.2`、`agent@0.2.1-rc.2`、`agent-loop@0.2.1-rc.2`、`tools@0.2.1-rc.2` 原样执行（[decisions/0002](../decisions/0002-run-upstream-packages.md)）；确定性模型为项目插件 `packages/teaching-plugins/llm-scripted`。

### TURN-01 首批输入被拒绝或为空

- 期望：`agent/pre-step` 拒绝时 turn 以 `{ kind: 'blocked' }` 结束，只有 agent/inbox/spliced、turn/start、agent/inbox/spliced 与 turn/end，不提交 user/message，不发请求。空白输入（如 `"  "`）上游照常发给模型，不跳过 step（教学子集曾跳过，差异见 decisions/0002）。
- 验证：`packages/teaching-runtime/tests/turn-contract.spec.ts`。状态：verified。

### TURN-02 请求准备取消

- 期望：取消步骤挂在上游会话事件 `request/context` 之后（`afterCheckpoint: 'request/context'`）：system/message 与 user/message 已提交，但没有模型请求、没有 assistant/message；step/end 与 turn/end 仍提交，`turn/end` 数据为 `{ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }`，场景继续。
- 验证：`packages/teaching-runtime/tests/turn-contract.spec.ts`「TURN-02」、`apps/local-server/tests/controller.spec.ts`（pre-step 阶段的协作取消）。状态：verified。

### TURN-03 普通文本响应

- 期望：持久事件依次为 agent/inbox/spliced、turn/start、agent/inbox/spliced、step/start、system/message、user/message、request/header、request/context、assistant/message、step/end、turn/end；流式分块合并为一条 assistant/message，`turn/end` 数据为 `{ turn: 1, reason: { kind: 'completed' } }`。
- 验证：`turn-contract.spec.ts`。状态：verified。

### TOOL-01 工具正常调用

- 期望：工具声明进入请求；调用产生 tool/call 与 tool/result；结果进入下一次请求。`tool/result` 数据为 `{ turn, step, message: { role: 'tool', toolCallId, content: [...blocks], isError } }`，没有 `status` 字段。
- 验证：`turn-contract.spec.ts`。状态：verified。

### TOOL-02 未知工具或非法参数

- 期望：确定性模型调用未声明的工具时运行以 TurnError 失败，turn 以 `{ kind: 'error' }` 结束，不产生 tool/call；非法参数与工具体抛错都成为模型可读的 `tool/result` 错误（`isError: true`），文本分别为 `Error: invalid arguments: "a" must be a number` 与 `Error: kaboom`；同名工具第二次注册使注册者进入 failed（`tool "<name>" is already registered (for a per-agent variant, …)`），已有工具与模型可见的工具声明不变。
- 验证：`turn-contract.spec.ts` 覆盖未声明工具；`tool-contract.spec.ts` 覆盖非法参数、执行失败与重复注册。状态：verified。

### TOOL-03 前置拦截

- 上游：`packages/core/tools/src/index.ts` 的 `prepareExecution`（deny 走 post-result 路径）与 `postExecute`。
- 期望：`tools/pre-execute` 返回 deny 时不执行工具体，结果为 `Error: <reason>` 且仍经过 `tools/post-execute`；post-execute 可接受、替换内容或拦截为错误（`content`/`feedback` 为 `ContentBlock[]`）；pre-execute 监听器抛错也成为错误结果（`Error: policy crashed`）。tool-guard 02-deny 的拒绝文本为 `Error: add is blocked by policy`。
- 验证：`tool-contract.spec.ts`。状态：verified。
