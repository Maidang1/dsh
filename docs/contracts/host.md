# 轨迹、构建、运行宿主与安全契约

### TRACE-01 回放与跳转

- 期望：任意 seq 的检查点跳转结果与从头归约一致。
- 验证：`packages/trace/tests/trace.spec.ts`。状态：verified。

### BUILD-01 代码展示与执行

- 期望：同一阶段的展示代码与执行模块来自同一组源文件，sourceHash 相同；锚点错误阻断构建。
- 验证：`packages/lesson-kit/tests`。状态：verified。

### OBS-01 观测不改变语义

- 期望：开启与关闭观测时，Sessions 服务实际提交的持久事件一致，且与轨迹记录一致；关闭观测时只剩场景检查点。
- 验证：`packages/teaching-runtime/tests/observation.spec.ts`。状态：verified。

### EXPORT-01 运行导出与导入

- 期望：导出包含 manifest、revision、场景、脱敏环境、轨迹与 payload；导入到另一仓库后可回放；篡改的 payload、revision、序号缺口、外来记录和缺失 payload 被拒绝；未结算运行导入为 interrupted；不覆盖已有运行；导入不执行代码。
- 验证：`apps/local-server/tests/export.spec.ts`、`apps/explorer/e2e/workbench.spec.ts`。状态：verified。

### HOST-01 刷新与重连

- 期望：重连不重新执行场景；按 Last-Event-ID 只补发缺失记录；缺口显式标记。
- 验证：`apps/local-server/tests/server.spec.ts`、`packages/trace/tests/trace.spec.ts`。状态：verified。

### HOST-02 运行隔离

- 期望：每次运行新建子进程；忙时拒绝 RUN；旧运行消息被丢弃。
- 验证：`apps/local-server/tests/controller.spec.ts`。状态：verified。

### HOST-03 控制服务异常退出

- 期望：重启后未结算运行标为 interrupted 与 truncated。
- 验证：`controller.spec.ts`。状态：verified。

### SEC-01 密钥与本机信息

- 期望：运行仓库、SSE 与导出不含环境变量值、凭据和绝对路径。
- 验证：`controller.spec.ts`（运行仓库，含 real 模式子进程）、`server.spec.ts`（catalog 不含模块路径，`/api/environment` 只含存在标记）、`teaching-runtime/tests/real-adapter.spec.ts`（HTTP 错误与轨迹不含密钥）。导出见 `apps/local-server/tests/export.spec.ts`「SEC-01」。状态：verified。

### SEC-02 本地服务访问控制

- 期望：无会话、Host 不符、跨源或无 Origin 的写请求被拒绝；启动令牌只能使用一次。
- 验证：`server.spec.ts`。状态：verified。

### REAL-01 真实模型适配器

- 上游：`packages/llm/llm-deepseek/src/adapter.ts`、`messages-api.ts`，`packages/llm/llm-deepseek-api-key/src/index.ts`。
- 期望：real 模式把确定性适配器替换为 `llm-deepseek`（保留实例 id）；请求发往 `{base}/v1/messages`，带 `x-api-key` 与 `anthropic-version`；流式 text_delta 与 input_json_delta 正确组装；工具结果以 tool_result 回传；HTTP 错误与未结束的流使运行失败；缺少密钥时适配器 failed 并给出原因。真实输出不做逐字比较。
- 验证：`packages/teaching-runtime/tests/real-adapter.spec.ts`、`apps/local-server/tests/controller.spec.ts`「real mode through a subprocess」，均对本地模拟服务。状态：verified（未对真实 DeepSeek 服务验证）。
