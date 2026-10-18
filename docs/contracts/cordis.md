# Cordis 基础机制契约

这些行为由复用的 `@deepseek-ai/cordis@4.0.5` 提供（与 `vendor/cordis/src` 逐字节一致），测试是对上游代码的行为探针。

### CTX-01 缺失必需服务

- 上游：`vendor/cordis/src/fiber.ts`（`Fiber` 构造中的 `_checkImpl`、`_refresh`），`registry.ts` 的 `inject`。
- 期望：消费者 `inject` 的服务不存在时停在 PENDING，不执行插件体；轨迹给出 `waiting for <service>`。
- 验证：`packages/teaching-runtime/tests/cordis-baseline.spec.ts`、`prompt-contract.spec.ts`「missing dependency」。状态：verified。

### CTX-02 服务出现后激活

- 期望：提供者挂载后消费者激活一次；提供者卸载后消费者 effect 释放并回到 PENDING，恢复后再次激活。
- 验证：`cordis-baseline.spec.ts`。状态：verified。

### CTX-03 作用域隔离

- 期望：在嵌套作用域注册的内容不影响兄弟或外层作用域的组装。
- 验证：`prompt-contract.spec.ts`「PROMPT-03」覆盖提示词层；`cordis-baseline.spec.ts`「CTX-03 probe」覆盖服务级 `ctx.isolate`：兄弟作用域各自解析自己的提供者，未提供的一侧保持 pending。状态：verified。

### LIFE-01 卸载贡献插件

- 上游：`fiber.ts` 的 `effect()` 与 `dispose`。
- 期望：插件经 `ctx.effect` 注册的资源在卸载时逆序释放，且只释放一次。
- 验证：`cordis-baseline.spec.ts`、`prompt-contract.spec.ts`「PROMPT-01 and PROMPT-04」。状态：verified。

### LIFE-02 清理失败

- 上游：`vendor/cordis/src/fiber.ts` 的 `_unload` 捕获 disposer 异常并只交给 `ctx.logger.error`，`dispose()` 仍然成功返回。
- 期望：教学运行时通过只读的 logger exporter 捕获这些错误；场景卸载步骤或运行结算中的清理失败使运行 failed，并记录归属实例的诊断；其余实例照常卸载。
- 验证：`packages/teaching-runtime/tests/turn-contract.spec.ts`「LIFE-02」。状态：verified。

### EVT-01 两层 waterfall

- 上游：`vendor/cordis/src/events.ts` 的 `waterfall`。
- 期望：A-before、B-before、inner、B-after、A-after；返回值逐层传回。
- 验证：`cordis-baseline.spec.ts`；工具中间件上的两层顺序见 `tool-contract.spec.ts`「01-two-layers」。状态：verified。

### EVT-02 waterfall 短路

- 期望：不调用 `next` 的监听器使后续监听器与 inner 都不执行。
- 验证：`cordis-baseline.spec.ts`。状态：verified。

### EVT-03 异常传播

- 期望：监听器抛出的异常沿 waterfall 向外传播，不被吞掉，后续工具体不执行。
- 验证：`packages/teaching-runtime/tests/tool-contract.spec.ts`「propagates a throwing pre-execute listener」。状态：verified。
