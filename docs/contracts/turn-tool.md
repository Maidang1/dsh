# 对话与工具契约

- 上游：`packages/core/agent-loop/src/agent.ts`（`turn()`、`preStep()`、`step()`），`packages/core/session/src/types.ts`（持久事件），`packages/core/tools/src/index.ts`。
- 教学实现：`packages/teaching-plugins/agent-loop`、`session`、`tools`、`llm`、`llm-scripted`。

### TURN-01 首批输入被拒绝或为空

- 期望：`agent/pre-step` 拒绝时以 blocked 结束，只有 turn/start 与 turn/end，不提交 user/message，不发请求；空输入同样不进入 step。
- 验证：`packages/teaching-runtime/tests/turn-contract.spec.ts`。状态：verified。

### TURN-02 请求准备取消

- 期望：准备请求期间取消不提前提交 system/user。
- 验证：控制器协作取消测试覆盖 pre-step 阶段取消（`apps/local-server/tests/controller.spec.ts`）；场景内 cancel 步骤尚未实现。状态：partial。

### TURN-03 普通文本响应

- 期望：持久事件依次为 turn/start、step/start、system/message、user/message、assistant/message、step/end、turn/end；流式分块合并为一条 assistant/message。
- 验证：`turn-contract.spec.ts`。状态：verified。

### TOOL-01 工具正常调用

- 期望：工具声明进入请求；调用产生 tool/call 与 tool/result；结果进入下一次请求。
- 验证：`turn-contract.spec.ts`。状态：verified。

### TOOL-02 未知工具或非法参数

- 期望：确定性模型调用未声明的工具时场景失败；tools.execute 对未知工具、非法参数、执行失败返回不同状态。
- 验证：`turn-contract.spec.ts` 覆盖未声明工具；execute 的三种状态尚无独立测试。状态：partial。

### TOOL-03 前置拦截

- 期望：`tools/pre-execute` 拦截时不执行工具。
- 验证：尚未实现。状态：planned。
