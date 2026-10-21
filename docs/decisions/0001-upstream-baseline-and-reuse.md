# 0001 上游基线与复用范围

状态：已采纳（P0-01、P0-04）。日期：2026-10-18。

## 基线

固定 deepseek-harness commit `687f282e8625c6b8d11ff58211a90524be2e4317`（2026-10-17，MIT），记录在根目录 `upstream-lock.json`。

## 决定

1. **Cordis 直接复用。** 依赖 npm 上的 `@deepseek-ai/cordis@4.0.5` 与 `@deepseek-ai/cosmokit@1.8.6`，精确锁定版本。两个包 tarball 中的 `src/` 与固定 commit 的 `vendor/cordis/src`、`vendor/cosmokit/src` 逐字节一致（`diff -r` 无输出）。插件配置 schema 同样复用 `@deepseek-ai/schemastery@3.18.5`（tarball `src/` 与 `vendor/schemastery/src` 逐字节一致），教学插件像上游服务一样声明 `Config`，由 Cordis 在 apply 前校验；它与 Cordis 一样在阶段打包时保持 external。
2. **核心插件使用教学子集。**（状态：已被 [0002](0002-run-upstream-packages.md) 取代——npm 上的 `0.2.1-rc.2` 即固定 commit 的发布，第一条理由已消失；以下为原文。）session、system-prompt、tools、agent、agent-loop、llm 在教学运行时中精简重写，运行在真实 Cordis 上。原因：
   - npm 上的 `@deepseek-ai/dsh-*` 版本（如 `dsh-system-prompt@0.0.1-rc.1`、`dsh-agent-loop@0.1.0-rc.6`）不对应固定 commit，不能作为“固定 commit 的上游实现”；
   - 从源码构建上游需要 pnpm 11、原生模块与 typert 生成链，超出第一版的教学成本；
   - 教学子集以契约测试约束，并通过 SourceRef 指向固定 commit 的源码。
3. **观测适配面向 Cordis。** 由于基础机制就是上游 Cordis，观测通过它公开的内部事件完成，不修改源码：`internal/plugin`、`internal/status`（生命周期）、`internal/service`（服务变化）、`internal/dispatch`（事件分发）。

因此第一版的组合里所有插件都是 `origin: 'teaching'`，但 Context、服务注入、effect 释放和事件分发都是上游代码在执行。后续若上游发布与基线一致的插件包，再按 `02 §8` 引入 `upstream-bridge`。

## 依据（P0-04 行为探针）

`packages/teaching-runtime/tests/cordis-baseline.spec.ts` 在 Cordis 4.0.5 上验证：

- 消费者 `inject` 的服务缺失时停在 PENDING，不执行插件体；服务出现后激活一次。（CTX-01、CTX-02）
- 提供者卸载时，消费者的 effect 被释放，状态回到 PENDING；提供者恢复后再次激活。（LIFE-01）
- effect disposer 逆序执行，重复调用只执行一次。
- `internal/status` 报告 PENDING → LOADING … → DISPOSED。
- waterfall 为 around-middleware：A-before、B-before、inner、B-after、A-after；不调用 next 即短路。（EVT-01、EVT-02）
- 非 internal 事件分发都会触发 `internal/dispatch`，可用于只读观测。

注意：`FiberState` 是 `const enum`，运行时被擦除，教学运行时在 `src/fiber-phase.ts` 中镜像其取值，DISPOSED 映射为 phase `null`。

## 最小组合（P0-01）

上游 `packages/bundle/sdk-minimal/cordis.patch.yml` 把 timer、llm、session、system-prompt、tools、agent、agent-loop 列为“minimal agent kernel”。`AgentLoop.inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']`（`packages/core/agent-loop/src/index.ts:342`），`Tools.inject = ['systemPrompt']`（`packages/core/tools/src/index.ts:809`）。

| 组合 | 节点 | 状态 |
|---|---|---|
| 最小框架树 | root Context + 一个服务 + 一个消费者 | 已证实（上述探针） |
| 最小对话树 | session、session-projection、system-prompt、tools、agent、llm + 模型适配器、agent-loop | 依赖声明已证实；教学子集是否需要 timer 待 P2-04 确认 |

sdk-minimal 还包含文件系统、shell、沙箱、压缩等行，它们不是对话的必需依赖，不等同于最少节点的教学组合。
