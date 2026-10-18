# 实施状态索引

按 `04-implementation-plan.md` §11 记录每个任务的完成情况：交付位置、验收依据（测试与契约）、未支持的边界。上游版本均为 `687f282e8625c6b8d11ff58211a90524be2e4317`。更新于 2026-10-18，对应提交 `e4f8f7f` 之后。

验证命令：`pnpm typecheck`、`pnpm test`（164 个用例）、`pnpm lessons:build`、`pnpm lessons:verify`、`pnpm lessons:verify-upstream`、`pnpm build:ui`、`pnpm test:e2e`（25 个用例）。

## P0 依据与技术验证

| 任务 | 状态 | 交付 | 验收依据 | 未覆盖 |
|---|---|---|---|---|
| P0-01 固定上游基线 | 完成 | `upstream-lock.json`、`docs/decisions/0001` | 最小对话树的依赖声明已核实 | 教学子集是否需要 timer 未单独验证 |
| P0-02 行为契约 | 完成 | `docs/contracts/` | 每条契约指向测试；FIBER-01 给出完整转换表 | `update()` 与 Loader 配置重载 |
| P0-03 Code Hike 与 Node 验证 | 完成 | 静态导出 + local-server 同源托管 | `apps/explorer/e2e/lesson.spec.ts` | — |
| P0-04 Cordis 复用决定 | 完成 | 复用 `@deepseek-ai/cordis@4.0.5`，插件为教学子集 | `cordis-baseline.spec.ts`、`fiber-transitions.spec.ts` | 上游插件包未复用（版本不对应基线） |

## P1 工程与内容基础设施

| 任务 | 状态 | 交付 | 验收依据 | 未覆盖 |
|---|---|---|---|---|
| P1-01 workspace | 完成 | pnpm workspace、TypeScript strict、Vitest、Playwright、`.github/workflows/ci.yml` | 在全新克隆中按 `ci.yml` 的步骤逐条复现通过（含 `lessons:verify-upstream` 克隆上游），`contentVersion` 与开发目录一致 | 工作流只在 `main` 推送与 PR 时触发，尚未在 GitHub 上实际运行 |
| P1-02 公共协议 | 完成 | `packages/contracts` | `contracts/tests/schemas.spec.ts` | — |
| P1-03 内容编译器 | 完成 | `packages/lesson-kit`、`scripts/*-lessons.ts` | `lesson-kit/tests/build.spec.ts`（BUILD-01、锚点、`requires` 一致性）、`provides.spec.ts`（`lessons:verify` 按运行中实际提供的服务核对 `provides`） | `provides` 只在课程场景中实际激活的实例上核对 |

## P2 教学运行时与 Node 宿主

| 任务 | 状态 | 交付 | 验收依据 | 未覆盖 |
|---|---|---|---|---|
| P2-01 Context、依赖、作用域 | 完成 | 复用 Cordis；`shared/scope.ts` | CTX-01..03 | — |
| P2-02 注册与生命周期 | 完成 | effect 绑定的注册；清理失败上报 | LIFE-01、LIFE-02、PROMPT-04 | — |
| P2-03 事件分发 | 完成 | Cordis waterfall；`tools/pre-execute`、`post-execute` | EVT-01..03 | 只有 waterfall 有专门契约，serial/bail 未覆盖 |
| P2-04 最小对话运行 | 完成 | session、system-prompt、tools、llm、llm-scripted、agent-loop | TURN-01..03、TOOL-01..03 | 重试、inbox、运行时上下文 |
| P2-05 Recorder、Reducer、Node 宿主 | 完成 | `packages/trace`、`apps/local-server` | TRACE-01、HOST-01..03、SEC-01/02、EXPORT-01、STORE-01 | — |
| P2-06 实际环境与适配器 | 完成 | `llm-deepseek`，real 模式 | REAL-01 | 仅对本地模拟服务验证，未对真实 DeepSeek 服务验证 |

## P3–P4 界面与第一条学习闭环

| 任务 | 状态 | 交付 | 验收依据 | 未覆盖 |
|---|---|---|---|---|
| P3-00 本地 API 客户端 | 完成 | `apps/explorer/src/lib/api.ts`、SSE 重连 | `workbench.spec.ts`（刷新后保留运行） | — |
| P3-01 插件树 | 完成 | 组合、依赖、运行数据三个图层，文本列表视图；状态区分未启用、等待服务、原因未知、加载失败、无活动 Fiber，检查器给出修复入口 | `workbench.spec.ts`、`phase.spec.ts`、`interaction.spec.ts` | 依赖图层只有 declared/resolved，没有 observed 边 |
| P3-02 添加插件与实验版本 | 完成 | 插件库（按职责筛选、缺失服务与提供者、“同时添加依赖”）、移除前列出受影响消费者与注册项、草稿乐观并发、不可变 revision | `controller.spec.ts`、`server.spec.ts`、`apps/explorer/tests/library.spec.ts`、`interaction.spec.ts` | 依赖只在根作用域解析 |
| P3-03 时间线与回放 | 完成 | 虚拟化列表、键盘操作、状态变化历史、1×/2×/4× 回放播放与暂停 | `workbench.spec.ts` | — |
| P3-04 前后对比 | 完成 | 模型请求差异；两次运行间的注册表、执行过程、会话记录差异（截至场景结束，大段先显示摘要）；对照条件含真实模型说明 | `compare.spec.ts`、`workbench.spec.ts` | 执行过程按文本行对齐，不识别分支结构 |
| P4-01..03 提示词插件闭环 | 完成 | `content/plugins/prompt-contributor` | `lesson.spec.ts`、`lessons:verify` | — |
| P4-04 作者模板 | 完成 | `pnpm lesson:new` 脚手架、`docs/authoring.md` 制作指南；第二门课程按同一结构新增，无需改运行器或界面 | `scaffold.spec.ts`、`tool-guard` 课程 | — |

## P5–P7

| 任务 | 状态 | 交付 | 验收依据 | 未覆盖 |
|---|---|---|---|---|
| P5-01 工具调用闭环 | 完成 | calculator 内存工具 | TOOL-01..03 | — |
| P5-02 中间件与拦截 | 完成 | `content/plugins/tool-guard` | `tool-contract.spec.ts` | — |
| P5-03 作用域与生命周期实验 | 完成 | PROMPT-03、FIBER-01 | `prompt-contract.spec.ts`、`fiber-transitions.spec.ts` | — |
| P5-04 上游行为对照 | 未完成 | — | — | 需要能运行上游的参考执行器；课程等级停在 contract-verified |
| P6 协作式执行单步 | 未开始 | 语义检查点已存在（取消步骤使用） | — | 暂停/继续控制；按设计，界面不显示不可用的暂停按钮 |
| P7-01 保存与导出 | 完成 | 导出导入、保留策略、容量提示、课程学习进度（阅读位置与已运行阶段） | EXPORT-01、STORE-01、`progress.spec.ts`、`lesson.spec.ts` | — |
| P7-02 性能与可访问性 | 完成 | `docs/generated/performance.md`；键盘、列表视图、减少动画；错误提示包含失败的操作、原因与恢复操作；窄屏以标签页切换主区域，页面不横向滚动；页头始终显示运行版本、回放位置与阅读阶段对应的运行 | `performance.spec.ts`（回放跳转）、`interaction.spec.ts`（点击反馈、视口稳定）、`errors.spec.ts`、`narrow.spec.ts` | 数值来自单一云端容器，未在其他机器上记录 |
| P7-03 文档与来源说明 | 完成 | README、契约、决策记录、本文件 | — | — |
| P7-04 构建与发布验收 | 部分 | `pnpm build`、`pnpm test:e2e` | 本地与全新克隆中通过 | 未在 GitHub Actions 上验证；生产发布按设计不自动进行 |
