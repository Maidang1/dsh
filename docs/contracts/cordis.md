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
- 验证：`prompt-contract.spec.ts`「PROMPT-03」覆盖提示词层；服务级作用域（`ctx.isolate`）尚未覆盖。状态：partial。

### LIFE-01 卸载贡献插件

- 上游：`fiber.ts` 的 `effect()` 与 `dispose`。
- 期望：插件经 `ctx.effect` 注册的资源在卸载时逆序释放，且只释放一次。
- 验证：`cordis-baseline.spec.ts`、`prompt-contract.spec.ts`「PROMPT-01 and PROMPT-04」。状态：verified。

### LIFE-02 清理失败

- 期望：清理抛错时运行不报告为成功。
- 验证：运行结算捕获清理异常并记为 failed（`packages/teaching-runtime/src/runner.ts`）；尚无专门测试。状态：planned。

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
