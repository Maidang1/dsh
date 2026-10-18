# 对话与工具契约

- 上游：`packages/core/agent-loop/src/agent.ts`（`turn()`、`preStep()`、`step()`），`packages/core/session/src/types.ts`（持久事件），`packages/core/tools/src/index.ts`。
- 教学实现：`packages/teaching-plugins/agent-loop`、`session`、`tools`、`llm`、`llm-scripted`。

### TURN-01 首批输入被拒绝或为空

- 期望：`agent/pre-step` 拒绝时以 blocked 结束，只有 turn/start 与 turn/end，不提交 user/message，不发请求；空输入同样不进入 step。
- 验证：`packages/teaching-runtime/tests/turn-contract.spec.ts`。状态：verified。

### TURN-02 请求准备取消

- 期望：在 `agent-loop:request-prepared` 检查点取消时不提交 system/user，不发请求，turn 以 aborted 结束，场景继续。
- 验证：`packages/teaching-runtime/tests/turn-contract.spec.ts`「TURN-02」、`apps/local-server/tests/controller.spec.ts`（pre-step 阶段的协作取消）。状态：verified。
- 差异：上游取消时会以 `interrupted: true` 提交已流出的回复前缀，教学版不提交。

### TURN-03 普通文本响应

- 期望：持久事件依次为 turn/start、step/start、system/message、user/message、assistant/message、step/end、turn/end；流式分块合并为一条 assistant/message。
- 验证：`turn-contract.spec.ts`。状态：verified。

### TOOL-01 工具正常调用

- 期望：工具声明进入请求；调用产生 tool/call 与 tool/result；结果进入下一次请求。
- 验证：`turn-contract.spec.ts`。状态：verified。

### TOOL-02 未知工具或非法参数

- 期望：确定性模型调用未声明的工具时场景失败；tools.execute 对未知工具、非法参数、执行失败返回不同状态。
- 验证：`turn-contract.spec.ts` 覆盖未声明工具；`tool-contract.spec.ts` 覆盖 execute 的 unknown-tool、invalid-arguments、failed。状态：verified。

### TOOL-03 前置拦截

- 上游：`packages/core/tools/src/index.ts` 的 `prepareExecution`（deny 走 post-result 路径）与 `postExecute`。
- 期望：`tools/pre-execute` 返回 deny 时不执行工具体，结果为 `Error: <reason>` 且仍经过 `tools/post-execute`；post-execute 可接受、替换内容或拦截为错误。
- 验证：`tool-contract.spec.ts`。状态：verified。
