# 提示词契约

- 上游：`packages/core/system-prompt/src/index.ts`（`SystemPrompt.section()`、`PromptLayer`、`ScopedLayers`、`renderPrompt`）。
- 教学实现：`packages/teaching-plugins/system-prompt/stages/main/index.ts`，贡献插件 `packages/teaching-plugins/prompt-contributor/stages/*`。
- 不支持：运行时上下文、变量与插值、complete section、`system-prompt/assemble` waterfall。

### PROMPT-01 添加片段

- 期望：挂载贡献插件产生一条属于该实例的注册项且不发送请求；下一次请求包含片段恰好一次，排在 order 更小的片段之后；与基线请求的差异只有该片段。
- 验证：`packages/teaching-runtime/tests/prompt-contract.spec.ts`。状态：verified。

### PROMPT-02 同域重复名称

- 期望：同一作用域第二次注册同名片段抛出 `prompt section "<name>" is already registered`，第二个插件进入 failed，已有片段不被覆盖。
- 验证：`prompt-contract.spec.ts`。状态：verified。

### PROMPT-03 局部同名覆盖

- 期望：嵌套作用域中的同名片段只在按该作用域组装时覆盖外层片段。
- 验证：`prompt-contract.spec.ts`。状态：verified。

### PROMPT-04 移除片段

- 期望：卸载后注册项释放；已记录的请求不变；后续请求恢复为基线；再次挂载不泄漏。
- 验证：`prompt-contract.spec.ts`。状态：verified。
