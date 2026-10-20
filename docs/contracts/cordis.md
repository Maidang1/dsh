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

### CTX-04 插件配置

- 上游：`vendor/cordis/src/fiber.ts` 的 `resolveConfig`（apply 前按 `Config['~standard']` 校验）；`packages/core/system-prompt/src/index.ts:430` 的 `SystemPrompt.Config`。
- 期望：带配置的阶段导出 schemastery `Config`，Cordis 在 apply 前校验，值类型不符时实例进入 failed（ValidationError）；配置中出现 schema 未列出的键（拼写错误、教学版不支持的上游选项、无配置阶段收到任何键）时，运行器在挂载任何实例前以 CompositionError 拒绝运行。课程构建把每个阶段 schema 的键记录为 `configKeys`，提交草稿时即按它拒绝不支持的键，不生成实验版本。
- 验证：`packages/teaching-runtime/tests/config-contract.spec.ts`、`apps/local-server/tests/built-catalog.spec.ts`。状态：verified。

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

### FIBER-01 生命周期转换表

- 上游：`vendor/cordis/src/fiber.ts` 的 `_setEpoch`、`_reload`、`_unload`、`_getState`。状态由“注入是否全部解析”（epoch）与 `_error`、`uid` 共同决定；`internal/status` 报告每次变化。
- 期望（括号内为插件树显示的 phase）：

| 从 | 到 | 条件 |
|---|---|---|
| PENDING | LOADING | 所有 inject 的服务可用 |
| LOADING | ACTIVE | apply 完成且期间依赖未变 |
| LOADING | UNLOADING → FAILED | apply 抛错：先清理已收集的 effect，再停在 FAILED |
| LOADING | UNLOADING → PENDING | apply 进行中依赖丢失 |
| ACTIVE | UNLOADING → PENDING | 依赖丢失 |
| ACTIVE | UNLOADING → LOADING → ACTIVE | 提供者被替换 |
| FAILED | LOADING → ACTIVE | 依赖重新解析后重试成功 |
| PENDING | UNLOADING → DISPOSED（null） | 未激活即卸载，apply 从未运行 |
| ACTIVE | UNLOADING → DISPOSED（null） | 卸载；清理失败时仍到 DISPOSED，见 LIFE-02 |

- 未覆盖：`update()` 的配置更新路径与 Loader/Include 的配置重载（教学运行时不使用 Loader）。
- 验证：`packages/teaching-runtime/tests/fiber-transitions.spec.ts`。状态：verified。
