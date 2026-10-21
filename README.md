# Harness Explorer

面向首次阅读 DeepSeek Harness 源码的交互式学习实验台。从最小插件树开始，逐个添加插件，通过 Code Hike 逐步构建插件代码，观察状态、事件和数据流变化，并理解每个插件的内部代码架构。

应用由本地 Node.js 命令启动，浏览器承载插件树、Code Hike、时间线、回放与对比。Node 在独立子进程中执行插件，运行事实通过统一轨迹驱动可视化；不以 mock 数据或预设动画代替实际执行。确定性模型用于无密钥教学和重复验证，真实模型通过本机环境中的 DeepSeek 凭据接入。

项目运行上游发布的对话内核，**不是完整的 DeepSeek Harness**：session、session-projection、system-prompt、tools、agent、agent-loop、llm 与 DeepSeek 适配器直接执行 npm 上的 `@deepseek-ai/dsh-*@0.2.1-rc.2`（固定 commit `687f282e` 的发布，标签 `dsh-v0.2.1-rc.2`，不复制不改写），Cordis 框架复用 `@deepseek-ai/cordis@4.0.5`（与该 commit 中的 vendor 源码逐字节一致）；prompt-contributor、tool-guard、calculator 与确定性模型适配器 llm-scripted 是本项目编写的教学插件，行为由契约测试约束，并链接到固定 commit 的上游源码。决定与差异见 [0002](docs/decisions/0002-run-upstream-packages.md)。

## 快速开始

需要 Node.js 22.19 或更高版本与 pnpm 10。

```sh
pnpm install
pnpm build        # 构建课程（类型检查、打包阶段模块、生成 lessons.json）与界面
pnpm explorer     # 启动本地服务，终端打印带一次性令牌的链接
```

用终端打印的链接打开浏览器。服务只绑定 `127.0.0.1`，令牌换取会话 cookie 后失效；运行记录保存在项目根目录的 `.explorer/`。界面的插件库可以从 npm 安装其他 `@deepseek-ai/dsh-*@0.2.1-rc.2` 附加包，安装进 `.explorer/packages/`。上游包读写的 `DSH_HOME` 被限定在 `.explorer/dsh-home/`，实验台不接触本机的 `~/.dsh`。

真实模型模式需要在启动 `pnpm explorer` 的环境中设置 `DEEPSEEK_API_KEY`（可选 `DEEPSEEK_BASE_URL`）。密钥只在 Node 进程内使用，不进入浏览器、轨迹或导出文件。

## 学习闭环

1. 整体组合：运行最小对话组合，查看插件树（组合、依赖、运行数据三个图层）、执行轨迹与模型请求。
2. 回放：移动回放游标查看任意位置的状态；回放从不重新执行插件。
3. 对比：选两次请求或两次运行，查看 system、messages、tools 的差异与可比条件。
4. 插件实现：从实例进入课程，按阶段阅读 Code Hike 代码增量、内部架构与上游对照，运行当前阶段并查看它自己的结果。
5. 导出与导入：运行可导出为 JSON，在另一份仓库中只读回放。

现有课程：

| 课程 | 内容 | 验证等级 |
|---|---|---|
| prompt-contributor | 依赖声明、提示词片段注册、effect 自动清理、作用域覆盖 | contract-verified |
| tool-guard | `tools/pre-execute` 的 around 中间件：委托、洋葱顺序、短路拒绝 | contract-verified |

## 开发命令

| 命令 | 作用 |
|---|---|
| `pnpm typecheck` | 全部包与界面的 TypeScript 检查 |
| `pnpm test` | 契约、轨迹、运行宿主与内容构建测试（Vitest） |
| `pnpm lesson:new <plugin-id>` | 生成新课程骨架（阶段源码、课程内容、组合与场景），制作流程见 [课程制作指南](docs/authoring.md) |
| `pnpm lessons:build` | 构建课程，展示代码与执行模块共用同一 sourceHash |
| `pnpm lessons:verify` | 在打包后的模块上运行每个可执行课程阶段 |
| `pnpm lessons:verify-upstream` | 对固定 commit 核对上游源码引用（会克隆上游到 `.cache/`，或使用 `UPSTREAM_DIR`） |
| `pnpm build:ui` | Next.js 静态导出界面 |
| `pnpm test:e2e` | Playwright 浏览器端到端测试（需先 `pnpm build`） |
| `pnpm check` | 按 CI 的顺序依次运行以上全部检查，任一失败即停止并返回非零退出码 |

## 目录

```text
apps/explorer          Next.js 界面（静态导出，由本地服务同源托管）
apps/local-server      控制服务：API、SSE、运行仓库、npm 附加包安装、每次运行一个子进程
packages/contracts     Zod schema 与共享类型
packages/teaching-runtime  场景执行器、观测适配、确定性设施
packages/teaching-plugins  上游内核阶段定义（src/upstream.ts）与教学插件各阶段源码
packages/trace         记录器、回放、轨迹缓冲
packages/lesson-kit    课程构建与校验
content/plugins        课程讲解、架构与上游映射
fixtures               组合、场景、确定性模型脚本
docs                   设计文档、契约与技术决定
```

## 文档

从 [文档总览](docs/README.md) 开始；各任务的完成情况见 [实施状态索引](docs/generated/implementation-status.md)，行为契约及其测试见 [docs/contracts](docs/contracts/README.md)，技术决定见 docs/decisions（[0001 上游基线与复用范围](docs/decisions/0001-upstream-baseline-and-reuse.md)、[0002 直接运行上游发布的内核包](docs/decisions/0002-run-upstream-packages.md)）。

1. [产品设计与范围](docs/01-product-design.md)
2. [系统架构与状态数据模型](docs/02-technical-architecture.md)
3. [Code Hike 与插件教学内容实现](docs/03-code-hike-and-plugin-lessons.md)
4. [分阶段实施计划与任务验收](docs/04-implementation-plan.md)
5. [行为一致性验证与发布标准](docs/05-validation-and-release.md)
6. [上游依据与待验证事项](docs/06-source-baseline.md)

## 来源与许可

学习对象：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）。内核插件 `@deepseek-ai/dsh-*@0.2.1-rc.2` 与框架包 `@deepseek-ai/cordis`、`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery` 均以 MIT 许可从 npm 原样引入。prompt-contributor、tool-guard、calculator 与 llm-scripted 是本项目编写的教学插件；课程中的上游片段以链接和行号引用，不复制源码。许可证原文与依赖说明见 [第三方声明](THIRD_PARTY_NOTICES.md)。
