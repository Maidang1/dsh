# 轨迹、构建、运行宿主与安全契约

### TRACE-01 回放与跳转

- 期望：任意 seq 的检查点跳转结果与从头归约一致。
- 验证：`packages/trace/tests/trace.spec.ts`。状态：verified。

### BUILD-01 代码展示与执行

- 期望：同一阶段的展示代码与执行模块来自同一组源文件，sourceHash 相同；锚点错误阻断构建。
- 验证：`packages/lesson-kit/tests`。状态：verified。

### OBS-01 观测不改变语义

- 期望：开启与关闭观测时规范化的会话事件一致。
- 验证：尚未实现。状态：planned。

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
- 验证：`controller.spec.ts`（运行仓库）、`server.spec.ts`（catalog 不含模块路径）。导出尚未实现。状态：partial。

### SEC-02 本地服务访问控制

- 期望：无会话、Host 不符、跨源或无 Origin 的写请求被拒绝；启动令牌只能使用一次。
- 验证：`server.spec.ts`。状态：verified。
