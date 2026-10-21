# 0002 直接运行上游发布的内核包

状态：已采纳。日期：2026-10-21。取代 0001 的决定 2。

## 基线

0001 决定 2 不采用 npm 包的第一条理由已经消失：npm 上的 `@deepseek-ai/dsh-*@0.2.1-rc.2` 就是固定 commit 的发布——上游在 `687f282e8625c6b8d11ff58211a90524be2e4317`（`upstream-lock.json`）上打了 `dsh-v0.2.1-rc.2` 标签。内核因此不再需要教学子集，直接运行发布包。

## 决定

1. **内核即发布包。** llm、session、session-projection、system-prompt、tools、agent、agent-loop 与 DeepSeek API-key 适配器（`llm-deepseek` = `@deepseek-ai/dsh-llm-deepseek-api-key`）以 npm 上 `@deepseek-ai/dsh-*@0.2.1-rc.2` 的入口模块原样执行，不复制、不改写（`packages/teaching-plugins/src/upstream.ts` 的 `kernelPlugins`）。阶段 id 为 `<definitionId>@0.2.1-rc.2`，sourceHash 是包入口文件的 `sha256:<hex>`；加载时核对版本，不是 `0.2.1-rc.2` 即以 UpstreamPackageError 拒绝并提示 `pnpm install`。
2. **删除教学子集。** session、system-prompt、tools、agent、agent-loop、llm、llm-deepseek 的教学实现与 `packages/teaching-plugins/shared/scope.ts` 全部删除；契约测试改为断言上游包的实际行为，不再约束项目代码的覆盖范围。
3. **仍是项目代码的部分。** 课程插件 prompt-contributor、calculator、tool-guard 的各阶段，以及确定性模型适配器 llm-scripted（一个注册在 `scripted` 提供方路由上的上游 `LlmAdapter`，上游 agent loop 向它发送真实请求），是本项目编写的教学插件（`catalog.ts` 的 `teachingStages`）。场景运行器、只读观测适配（Cordis 内部事件与上游服务的公开事件，外加一个逐块透传的 `llm/stream` 监听器）和确定性设施（种子随机数、虚拟 `Date.now`）留在 `packages/teaching-runtime`。
4. **作用域映射到 dsh-scope。** 组合里的每个作用域是上游 `@deepseek-ai/dsh-scope` 的一个作用域键：`createScope` 建立作用域上下文，`bindScopeParent` 连接父子。`ScopeDefinition.sessions` 声明哪些会话的 agent 住在哪个作用域；运行器按 `sessionScope` 在对应键下创建 agent，并在发布前把它链接到该键，使提示词组装看到该作用域的层（`packages/teaching-runtime/src/runner.ts`）。
5. **npm 附加包与一份拷贝规则。** 界面可以从 npm 安装其他 `@deepseek-ai/dsh-*@0.2.1-rc.2` 附加包（`apps/local-server/src/packages.ts`）：安装到 `<运行仓库>/packages`，该目录必须在仓库内，使包对 cordis、dsh-tools 等共享包的导入向上解析到内核使用的那一份；npm 在本地复制的共享包在每次安装后删除。版本不等于 `0.2.1-rc.2` 的拒绝安装。运行仓库在仓库外时向上解析不成立，安装禁用，路由以 409 说明原因。
6. **DSH_HOME 隔离。** 上游包会读写 `DSH_HOME`（默认 `~/.dsh`；例如 `@deepseek-ai/dsh-anonymous-user-id` 写入 `<DSH_HOME>/anonymous-user-id`，真实 DeepSeek 适配器把它作为 `x-deepseek-harness-user-id` 发送）。本机上可能同时运行真实的 dsh，实验台不得共享那份状态：运行子进程与附加包检查子进程都以 `DSH_HOME=<运行仓库>/dsh-home` 启动（不存在则创建），并覆盖服务自身环境里的 `DSH_HOME`，任何路径都不指向用户真实的 home。

## 切换暴露的差异

契约测试从教学子集迁到上游包后确认的行为差异：

- **空输入发给模型。** 教学子集对空白输入跳过模型调用；上游把它作为普通输入照常发送（TURN-01）。
- **请求准备后取消的边界。** TURN-02 的取消点现在是上游会话事件 `request/context`：system/message 与 user/message 已提交，但没有模型请求、没有 assistant/message；step/end 与 turn/end 仍提交，`turn/end` 数据为 `{ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }`，场景继续。
- **`tool/result` 数据形状。** `{ turn, step, message: { role: 'tool', toolCallId, content: [...blocks], isError } }`，不再有 `status` 字段；`PostToolDecision` 的 `content`/`feedback` 是 `ContentBlock[]`，不是字符串。
- **错误文本即上游原文。** 非法参数 `Error: invalid arguments: "a" must be a number`；工具体抛错 `Error: kaboom`；tool-guard 02-deny 的拒绝 `Error: add is blocked by policy`；重复注册 `tool "<name>" is already registered (for a per-agent variant, …)`。
- **默认系统文本。** `You are an AI agent powered by DeepSeek Harness.\n\n你是一个助手`：上游身份行加上 `personaPrefix` 配置；身份行可用 `includeHarnessIdentity: false` 关闭（CTX-04）。
- **流式时间戳。** 上游 `assistant/message` 数据带流式墙钟时间（`time`），两次运行的阶段表不同则取值不同；会话对比在投影时剔除墙钟字段（`apps/explorer/src/lib/compare.ts`）。

普通一轮的持久事件顺序为 `agent/inbox/spliced, turn/start, agent/inbox/spliced, step/start, system/message, user/message, request/header, request/context, assistant/message, step/end, turn/end`（TURN-03）。

## 依据

- `packages/teaching-plugins/tests/catalog.spec.ts`：每个 `kernelPlugins` 条目的 `requires` 等于模块真实的 `inject`，`provides` 等于入口文件中注册的服务。
- `packages/teaching-runtime/tests/`：TURN、TOOL、PROMPT、CTX、OBS 契约在上游包上全部通过；`real-adapter.spec.ts` 对本地模拟服务验证 `dsh-llm-deepseek-api-key`（REAL-01，未对真实 DeepSeek 服务验证）。
