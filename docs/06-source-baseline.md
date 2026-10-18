# 上游依据与待验证事项

## 1 参考基线

目标仓库：[Maidang1/dsh](https://github.com/Maidang1/dsh)。目前仓库只包含设计文档，尚无应用代码。

学习对象：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。本方案固定参考 commit：[`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317)。该 commit 的提交日期为 2026-10-17；文档整理日期为 2026-10-18。

此处区分三类信息：已阅读核查的上游事实、本项目设计决定、实施阶段仍需验证的细节。当前交付是计划文档，没有运行上游或完成行为一致性验证。

## 2 已核查的上游机制

### 2.1 插件组合与执行

[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md) 描述：模型适配、工具注册、会话日志、Agent Loop 都是插件；应用由 profile、bundle 和有序 patch 层组合而成。

其中明确区分 Session 持久事件、Agent 活跃事件和能力事件；step 是一次模型请求与其工具调用，turn 可以包含零个或多个 step。

本项目据此分离组合图、服务关系图、运行轨迹和持久会话投影。完整 Profile/Bundle/Patch 编辑不列入第一版，不能以普通对象 merge 冒充该机制。

### 2.2 Cordis 基础机制

[Cordis Primer](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cordis-primer.md) 描述 Context、服务键、inject、不同事件模式和可逆 effects。

waterfall 是 around-middleware，监听器通过 next 委托，可以不调用 next 以短路；不是普通值转换流水线。

本项目将其作为核心契约来源，但完整生命周期合法转换和依赖丢失细节仍需继续阅读 vendored Cordis 实现与测试。

### 2.3 提示词注册

[SystemPrompt 源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/system-prompt/src/index.ts) 已核查：

- SystemPrompt 以 systemPrompt 服务键提供能力。
- 内部使用 ScopedLayers 和 PromptLayer 管理分层注册。
- section() 校验 order 是有限数字。
- 同层重复名称不允许；作用域内的同名项可覆盖全局贡献。
- section() 返回与 Cordis effect 关联的 disposer。
- 注册/释放相关变化通知使用 system-prompt/change。

因此第一条教学样板优先采用提示词贡献：变化可直接在请求里观察，同时涵盖依赖、注册、作用域和卸载。具体贡献插件由本项目实现，不把虚构的 registerPrompt API 当作上游原文。

### 2.4 工具管线

[Tools 源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts) 已核查存在对 systemPrompt 的依赖、register()、execute()、前置/后置 waterfall 及不同结算路径。

这一点要求第一版即使不用工具，也先验证最小 Loop 对工具服务的真实依赖。工具失败和拦截不能统一画成永远经过同一条 pre → execute → post 链。

### 2.5 Agent Loop

[Agent Loop 文档](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/README.md) 与架构文档用于限定请求准备、输入接纳、流式结算、工具结果、取消和清理边界。

本项目必须通过源码分支及测试补齐契约，不能仅凭概览流程图定义全部合法状态转换。

### 2.6 插件状态清单

[Inventory 类型](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/host/plugin-inventory/src/types.ts) 中的 PluginFiberPhase 为 pending、loading、active、failed、unloading 或 null。

[Inventory 文档](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/host/plugin-inventory/README.md) 说明它是只读快照，不提供完整历史、变更订阅、配置层来源或修改能力；结构 group 行不在返回清单中。

因此不能只接这个接口就宣称已经拥有完整插件树、完整生命周期轨迹或配置来源追踪。本项目的教学运行时需要独立记录这些事实；未来连接完整上游时需要专门观测适配。

## 3 Code Hike 依据

[Code Hike 官方文档](https://codehike.org/docs) 在本次读取时显示版本 1.1.0，说明 React 与 MDX 为基本依赖，RSC 推荐但非必需；官方快速入门使用 Next.js、MDX 和 Tailwind。

官方文档列出代码注释、Focus、Diff、Token Transitions、Slideshow、Scrollycoding 等示例。它们支持动态教学的呈现层；本项目的阶段编译、运行器、状态机和源码一致性验证仍需自行实现。

实现前以实际安装版本的文档和类型定义为准，固定 package lock。没有把网站显示版本直接当作已测试的依赖组合。

## 4 尚待实施验证

| 项目 | 为什么需要验证 | 负责阶段 | 当前结果 |
|---|---|---|---|
| 最小对话插件依赖闭包 | 不能从概念图推出实际最少组合 | P0-01 | 依赖声明已核实（decisions/0001） |
| Cordis 与上游插件的 Node 复用 | 需验证固定版本的加载方式与依赖 | P0-04 | Cordis 直接复用；插件改为教学子集（decisions/0001） |
| 上游复用插件的观测适配 | 需在不改源码、不改语义的前提下记录生命周期、服务解析、事件分发与 Session 事件 | P0-04 | 观测基于 Cordis 内部事件，OBS-01 已验证 |
| 前端托管方式 | Next.js 静态导出能否由 Node 同源托管并满足 Code Hike/MDX；否则改用 custom server | P0-03 | 静态导出 + local-server 同源托管 |
| 真实模型提供方与凭据变量 | 依据上游 llm 插件实际支持的提供方确定 | P0-01、P2-06 | DeepSeek Messages 接口，DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL（REAL-01，仅对模拟服务验证） |
| Fiber 完整转换表 | inventory phase 不能推出完整转换关系 | P0-02 | 未完成：已验证 PENDING→LOADING→ACTIVE、依赖丢失回到 PENDING、卸载到 DISPOSED |
| 依赖丢失/恢复和清理顺序 | 错误简化会影响所有插件教学 | P0-02、P2 | CTX-01/02、LIFE-01/02 已验证 |
| Code Hike 与本地 Node 应用组合 | MDX、客户端交互、执行模块和轨迹订阅需一起验证 | P0-03 | 已实现，端到端测试覆盖 |
| Agent 请求取消及重试细节 | 概览不足以支持全部分支 | P0-02、P2-04 | 取消已覆盖（TURN-02）；重试未实现 |
| 工具拦截与错误结算 | 不同分支不一定经过相同后处理 | P5-01、P5-02 | TOOL-02/03 已验证 |
| 上游差分执行环境 | 需要固定依赖和可重复的参考夹具 | P5-04 | 未完成：未建立上游参考执行器，课程等级为 contract-verified |
| 动态代码动画的具体 API | 依赖所选 Code Hike 版本 | P0-03、P4-01 | codehike 1.1.0：highlight、Pre、token-transitions |

执行位置已调整为本地 Node，原有插件树、代码教学、轨迹、回放和数据对比保持不变；基础插件计划复用上游、被讲解插件使用教学实现。这是本项目设计决定，尚不表示已运行上游、证明全部插件可直接复用或可观测，或完成真实环境集成。

## 5 基线升级流程

1. 选择新 commit，生成所覆盖文件的 diff。
2. 检查契约是否改变，而不只检查包版本号。
3. 更新参考执行器并运行差分。
4. 修改教学实现、阶段内容、架构说明和源码映射。
5. 重新构建全部相关阶段与展示数据。
6. 发布新的 contentVersion/runtimeVersion，保留旧运行 manifest。

升级有未解释差异时，不替换默认教学基线。
