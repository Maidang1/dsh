# 内核插件课程方案

文档日期：2026-10-22。状态：方案；K0 基础设施已有初版（§9），课程内容未开始。前置：[decisions/0002](decisions/0002-run-upstream-packages.md)（已随 PR #3 合入 main）。

## 1 问题

实例摘要面板只在插件定义有课程时显示“进入插件实现”（`apps/explorer/src/components/Panels.tsx`：`lessons.find(item => item.pluginDefinitionId === instance.definitionId)`）。现有课程只有 prompt-contributor 与 tool-guard，所以最小对话组合里的 session、system-prompt、tools、llm、agent-loop 等节点都进不去，看起来像缺陷。

## 2 目标与范围

最小对话组合与工具组合中出现的每个插件都有课程，内核插件讲解**上游原文**（固定 commit `687f282e`），不是教学重写。

| 插件定义 | 课程代码来源 | 上游路径 | 源码规模（不含测试） |
|---|---|---|---|
| system-prompt | 上游原文 | `packages/core/system-prompt` | 1 文件，691 行 |
| session | 上游原文 | `packages/core/session` | 10 文件，3324 行 |
| session-projection | 上游原文 | `packages/session/session-projection` | 2 文件，739 行 |
| tools | 上游原文 | `packages/core/tools` | 10 文件，5782 行 |
| agent | 上游原文 | `packages/core/agent` | 8 文件，1656 行 |
| agent-loop | 上游原文 | `packages/core/agent-loop` | 7 文件，2478 行 |
| llm | 上游原文 | `packages/llm/llm` | 13 文件，4088 行 |
| llm-deepseek | 上游原文 | `packages/llm/llm-deepseek-api-key` | 2 文件，91 行 |
| llm-scripted | 本项目编写 | — | 确定性模型适配器 |
| calculator | 本项目编写 | — | 示例工具 |

不在范围内：上游其余约 320 个包（附加包仍可从 npm 安装运行，但没有课程）；逐行讲完整个包。每门课只讲该插件的主干机制，其余路径在讲解中标为“未展开”，并给出上游链接。

已核实的事实：固定 commit 上 8 个上游包的 `package.json` 名称与 npm 包一致，版本均为 `0.2.1-rc.2`；npm 发布包只含编译后的 `lib/index.js`，没有 `src/`，所以原文必须取自固定 commit 的检出。

## 3 前置

内核已改为直接运行 npm 发布包（[decisions/0002](decisions/0002-run-upstream-packages.md)，PR #3）。本方案的课程讲解的就是这些包的原文，阶段 id 为 `<定义>@0.2.1-rc.2`。

## 4 设计：源码导读课程

### 4.1 展示与执行的绑定

现有课程的规则是“展示的代码就是执行的代码”，两者共用一个 sourceHash（BUILD-01）。上游课程做不到逐字节相同（展示 TypeScript 原文，执行 npm 的编译产物），改为以下绑定：

- **展示**：固定 commit 检出中该包的 `src/` 文件，构建时读入 `dist/lessons.json`（`dist/` 已被 git 忽略，仓库不保存上游源码）。
- **执行**：`kernelStages()` 已有的上游阶段，即 npm 包入口 `lib/index.js`，阶段 id `<定义>@0.2.1-rc.2`。
- **绑定依据**：构建时核对检出中的包名、版本与运行加载的 npm 包一致；npm `0.2.1-rc.2` 是固定 commit 的发布标签（0002 已记录）。
- **运行对应**：课程阶段的 sourceHash 取上游阶段自身的 sourceHash（npm 入口文件的哈希）。控制服务已为每次运行记录 `loadedSourceHashes[stage.id] = stage.sourceHash`，所以“所选运行是否执行了当前代码”的判断无需改动。

不做的事：不证明 `lib/index.js` 由所示源码编译而来（需要复现上游构建，见 §8 风险 1）。界面明确写出“左侧是上游原文，运行的是同一版本的发布包”，不声称逐字节一致。

### 4.2 锚点

上游原文里没有 `// lesson:` 注释，也不能修改。锚点改由课程的 `upstream-map.ts` 提供：

- 位于该包 `src/` 内的上游引用自动成为阶段锚点，id 为 `<阶段 id>#<引用 id>`，`symbol` 为引用 id；`focusAnchors` 与架构节点的 `sourceRefIds` 照常引用它们。
- 构建时逐条按 `contentHash` 核对；固定 commit 一变，行号漂移即构建失败，而不是悄悄高亮错行。
- 展示的文件 = 包入口 `src/index.ts` + 引用到的其他文件。不展示整个包，减轻阅读负担与静态页面体积。
- 包外的引用（例如 agent-loop 课程引用 session 的代码）仍只出现在“上游对照”标签页的链接中。

新增作者工具 `pnpm lessons:ref <id> <path> <起行> <止行> [symbol]`：从固定 commit 检出读取片段，打印可直接粘贴的引用（含哈希），避免手算。

### 4.3 阶段形态

一个上游插件只有一个代码阶段（npm 包），所以课程阶段不是“代码逐步长出来”，而是**同一份原文上的导读路线**：

- 每个课程阶段的 `codeStageId` 相同，用 `focusAnchors` 依次聚焦不同片段；相邻阶段代码相同，不显示新增行标记。
- 进入阶段时自动滚动到第一个聚焦片段（上游文件动辄上千行）。
- 能用确定性场景观察到的机制设为 `executable` 阶段，绑定场景与契约，运行结果进入“状态与数据”面板；运行不到的路径（重试、真实提供方、恢复与修复）设为 `explanation` 阶段。
- 教学阶段要求的 `simplifications`（与上游的差异）对上游阶段不适用，改为可选的“运行环境说明”，写明实验台运行与真实 dsh 的差异（确定性模型、`DSH_HOME` 隔离、虚拟时间等）。

### 4.4 构建与校验改动

| 位置 | 改动 |
|---|---|
| `packages/lesson-kit/src/schema.ts` | `LessonBuild.upstreamStages?: BuiltStage[]`：课程读取的上游阶段（原文文件 + 锚点）；运行目录不从这里取阶段 |
| `packages/lesson-kit/src/build.ts` | `BuildOptions.upstreamDir`；先加载全部课程内容，再为被课程引用的上游阶段构建展示数据；有检出时核对所有课程的上游引用；`simplifications` 只对教学阶段强制；一个上游阶段只能由一门课程读取 |
| `packages/lesson-kit/src/verify.ts` | `verifyUpstreamRefs` 同时核对 `upstreamStages` 中展示的文件与检出逐字节一致 |
| `scripts/lesson-env.ts` | `ensureUpstream()`：使用 `UPSTREAM_DIR`，否则使用 `.cache/upstream`（首次克隆）并检出固定 commit；`buildOptions()` 带上它 |
| `scripts/verify-source-links.ts` | 改用 `ensureUpstream()`，删掉重复的克隆逻辑 |
| `scripts/upstream-ref.ts`、`package.json` | `lessons:ref` 作者工具 |

影响：`pnpm lessons:build` 首次运行需要网络（克隆上游）。CI 已在 `lessons:verify-upstream` 中克隆，顺序上需让 `.cache/upstream` 在构建前就位（同一个 `ensureUpstream()` 即可）。离线时可设置 `UPSTREAM_DIR` 指向本地检出。

### 4.5 界面改动

| 位置 | 改动 |
|---|---|
| `apps/explorer/src/lib/lesson-data.ts` | 视图带上 `origin` 与 `package`；页面把 `build.stages` 与 `build.upstreamStages` 一并传入 |
| `LessonView.tsx` 代码标题 | 上游阶段显示“上游原文，commit 687f282e · 运行的是同一版本的发布包 `<包>@<版本>`”，取代“新增/删除行数” |
| `LessonView.tsx` 上游对照页 | 上游阶段显示“运行环境说明”与原文来源说明；教学阶段保持“精简说明” |
| `LessonView.tsx` | 切换阶段时滚动到第一个聚焦片段 |
| `Panels.tsx` | 不需要改：课程存在即显示入口。可选：没有课程的插件显示一行灰字说明（例如上游附加包），而不是什么都不显示 |

### 4.6 来源与许可

上游为 MIT。仓库内仍只保存引用（路径、行号、哈希），原文在构建时读入被 git 忽略的 `dist/`。README 中“课程中的上游片段以链接和行号引用，不复制源码”需更新为：“内核课程在构建时从固定 commit 的检出读取上游原文展示，仓库不保存副本”，并在 `THIRD_PARTY_NOTICES.md` 说明展示内容的许可。导出的运行文件不包含课程原文，不受影响。

## 5 各课程大纲

行号为固定 commit 上的起始行，实施时用 `lessons:ref` 固定范围与哈希。契约编号沿用 `docs/contracts`；标“新增”的契约需先写契约条目与针对上游包的测试（`packages/teaching-runtime/tests/`）。

现有场景只有 `prompt-scope`、`prompt-section-lifecycle`、`todo-plan`、`tool-guard`；`greeting`、`calculator` 是模型脚本，不是场景。K0 新增三个场景：`chat-greeting`（一次输入，模型脚本 greeting）、`tool-calculator`（一次输入，模型脚本 calculator，触发一次工具调用）、`chat-cancel`（请求准备后取消，对应 TURN-02）。下表中的场景名均指这些场景。

### 5.1 system-prompt（试点）

| 阶段 | 类型 | 聚焦（`packages/core/system-prompt/src/index.ts`） | 场景 / 契约 |
|---|---|---|---|
| 00 服务与配置 | executable | `class SystemPrompt extends Service`（429）、`Config` 与构造（430–477） | chat-greeting / CTX-04 |
| 01 片段注册 | executable | `section()`（478）、`SECTION_ORDERS`（131）、`comparePromptSections`（248） | prompt-section-lifecycle / PROMPT-01、02、04 |
| 02 作用域分层 | executable | `class PromptLayer`（395） | prompt-scope / PROMPT-03、CTX-03 |
| 03 上下文、变量与工具提供者 | explanation | `context()`（513）、`variable()`（561）、`tools()`（545）、`interpolate`（340） | — |
| 04 组装与渲染 | executable | `assemble()`（614）、`renderPrompt`（290）、`renderContextSections`（330） | chat-greeting / TURN-03 |

试点同时验证：大文件渲染、自动滚动、锚点哈希核对、运行对应判断。

### 5.2 llm-scripted（本项目，作为 llm 的前导）

按现有教学课程做法：分 2–3 个可执行阶段，展示一个最小 `LlmAdapter` 如何注册到 `scripted` 路由，并按模型脚本返回流式块。契约：TURN-03。

### 5.3 llm

| 阶段 | 类型 | 聚焦（`packages/llm/llm/src/`） | 场景 / 契约 |
|---|---|---|---|
| 00 LlmRuntime 服务 | executable | `index.ts` `class LlmRuntime`（354） | chat-greeting / TURN-03 |
| 01 适配器契约 | executable | `abstract class LlmAdapter`（208）、`prepareCall`（290）、`registerAdapter`（401） | chat-greeting / 新增 LLM-01 路由与适配器 |
| 02 一次流式调用 | executable | `resolveCallConfig`（894）、`stream()`（1166）、`adapterFailureChunk`（1184） | chat-greeting / TURN-03 |
| 03 流到消息 | explanation | `assembler.ts` `BlockAssembler`（38）、`message.ts` `createAssistantMessage`（260） | — |
| 04 错误与重试 | explanation | `error.ts` `HarnessError`（13）、`retry-policy.ts` `resolveRetryPolicy`（149） | — |

### 5.4 llm-deepseek

| 阶段 | 类型 | 聚焦（`packages/llm/llm-deepseek-api-key/src/`） | 说明 |
|---|---|---|---|
| 00 注册 DeepSeek 路由 | explanation | `index.ts` `apply`（17）、`config.ts` `resolveAdapterOptions`（37） | 确定性验证没有密钥，不设可执行阶段；真实模式运行见 REAL-01 |

协议实现在另一个包 `@deepseek-ai/dsh-llm-deepseek`（`registerDeepSeekProvider`），按 §4.2 只作上游链接，不展开。

### 5.5 calculator（本项目，作为 tools 的前导）

现有单阶段扩为 2 个可执行阶段：`defineTool` 声明参数 schema，注册后出现在请求的 tools 中并被调用。契约：TOOL-01、TOOL-02。

### 5.6 tools

| 阶段 | 类型 | 聚焦（`packages/core/tools/src/`） | 场景 / 契约 |
|---|---|---|---|
| 00 ToolRuntime 服务 | executable | `index.ts` `class ToolRuntime`（808）、构造（850） | tool-calculator / TOOL-01 |
| 01 定义与注册 | executable | `schema.ts` `defineTool`（554）、`index.ts` `register()`（1071）、`class ToolLayer`（735） | tool-calculator / TOOL-01 |
| 02 进入请求 | executable | `schemas()`（1268） | tool-calculator / TOOL-01 |
| 03 执行管线 | executable | `execute()`（1377）、`tools/pre-execute` 与 `tools/post-execute` 事件声明（152–190）、`schema.ts` `validateArgs`（478）、`ToolNotFoundError`（511） | tool-calculator、tool-guard / TOOL-02、TOOL-03、EVT-01、EVT-02 |
| 04 限制与守卫 | explanation | `restrict()`（1105）、`guard()`（1144） | — |

`ptc.ts`、`py-types.ts`、`ts-types.ts`（代码执行工具与 SDK 生成，约 2000 行）不展开，讲解中注明。

### 5.7 session

| 阶段 | 类型 | 聚焦（`packages/core/session/src/`） | 场景 / 契约 |
|---|---|---|---|
| 00 SessionStore 服务 | executable | `index.ts` `class SessionStore`（1049）、`create`（1111）、`prepare`（1143） | chat-greeting / TURN-03 |
| 01 事件日志 | executable | `class Session`（522）、`eventAt`（711）、`known-event-types.ts`（22） | chat-greeting / TURN-03（事件顺序） |
| 02 消息表面 | executable | `surface.ts` `foldSurface`（594）、`class SurfaceManager`（612）、`deriveMessages`（984） | chat-greeting / 新增 SESSION-01 表面折叠 |
| 03 请求头与上下文 | executable | `requestHeader`（912）、`requestContext`（933）、`request-header.ts` `foldRequestHeader`（63） | chat-greeting、chat-cancel / TURN-02 |
| 04 中断修复 | explanation | `repair.ts` `openTurnClosers`（53）、`ToolCallRecovery`（105） | — |

### 5.8 session-projection

| 阶段 | 类型 | 聚焦（`packages/session/session-projection/src/index.ts`） | 场景 / 契约 |
|---|---|---|---|
| 00 投影注册表 | executable | `class SessionProjectionRegistry`（199）、`ProjectionDefinition`（48） | chat-greeting / 新增 SESSION-02 投影 |
| 01 变更通知 | executable | `onChanged`（302） | chat-greeting / SESSION-02 |
| 02 检查点与恢复 | explanation | `checkpoint`（397）、`restoreFloor`（426） | — |

agent-loop 注册的 inbox 与 turn-boundary 投影就是现成的使用方，场景无需新增。

### 5.9 agent

| 阶段 | 类型 | 聚焦（`packages/core/agent/src/`） | 场景 / 契约 |
|---|---|---|---|
| 00 AgentRegistry 服务 | executable | `index.ts` `class AgentRegistry`（245） | chat-greeting / 新增 AGENT-01 |
| 01 工厂 | executable | `setFactory`（360）、`create`（393）、`AgentFactory`（171） | chat-greeting / AGENT-01 |
| 02 进入与宣告 | executable | `enter`（461）、`announce`（539）、`currentInitiator`（297） | chat-greeting / AGENT-01 |
| 03 事件分发 | explanation | `dispatch.ts` `agentEvents`（107）、`assembleContextFor`（174） | — |
| 04 模型选择 | explanation | `model-selection.ts` `installModelSelection`（81） | — |

### 5.10 agent-loop

| 阶段 | 类型 | 聚焦（`packages/core/agent-loop/src/`） | 场景 / 契约 |
|---|---|---|---|
| 00 AgentLoop 作为工厂 | executable | `index.ts` `class AgentLoop`（341）、`create`（688）、`createAgent`（750） | chat-greeting / TURN-03 |
| 01 轮与步 | executable | `agent.ts` `class ReactLoopAgent`（98）、`turn()`（298）、`step()`（400） | chat-greeting / TURN-03 |
| 02 组装请求 | executable | `prepareRequest`（564）、`buildRequest`（616）、`runtime-context.ts` `SystemPromptProjection`（65） | chat-greeting / TURN-03、PROMPT-01 |
| 03 工具调用 | executable | `tool-calls.ts` `executeToolCalls`（60） | tool-calculator / TOOL-01、TOOL-02 |
| 04 收件箱与取消 | executable | `inbox.ts` `ReactLoopInbox`（74）、`agent.ts` `steer`/`followup`（163–171）、`cancel`（175） | chat-cancel / TURN-01、TURN-02 |

## 6 实施顺序

| 编号 | 交付 | 依赖 | 初步工作量 |
|---|---|---|---|
| K0 | §4.4、§4.5 基础设施、§7 测试、§5 所需的三个场景 | 无 | 1.5–2 人日（初版已完成，见 §9） |
| K1 | system-prompt 试点课程 | K0 | 1 人日 |
| K1 评审 | 在界面里走完试点课程，确认导读形式后再批量制作 | K1 | — |
| K2 | llm-scripted、llm | K1 评审 | 2 人日 |
| K3 | calculator、tools | K1 评审 | 2 人日 |
| K4 | session、session-projection（含 SESSION-01、02 契约） | K1 评审 | 2 人日 |
| K5 | agent、agent-loop（含 AGENT-01 契约） | K2–K4 | 2.5–3 人日 |
| K6 | llm-deepseek | K2 | 0.5 人日 |
| K7 | README 课程表、authoring.md 增加“上游导读课程”一节、e2e 覆盖课程入口 | K2–K6 | 1 人日 |

每门课程的验收沿用 [authoring §3](authoring.md#3-发布前检查)，另加：

- `lessons:build` 对该课程所有上游引用核对哈希通过；`lessons:verify-upstream` 核对展示文件逐字节一致。
- 每个可执行阶段在 `lessons:verify` 中通过，`provides` 与实际一致。
- 从整体组合点该插件实例能进入课程；运行此阶段后“状态与数据”面板显示该运行，而不是“另一版代码”。
- 讲解区分代码事实与设计解读；未展开的路径写明并附上游链接。

## 7 测试

- lesson-kit：上游阶段构建（文件 = 入口 + 引用文件；锚点 id；哈希不符、包名或版本不符、文件缺失、无检出时的报错）；`verifyUpstreamRefs` 对改动过的展示文件报错。测试使用临时目录伪造的最小检出，不依赖网络。
- explorer：`lessonStageViews` 对上游阶段给出 `origin`、`package`；课程页 e2e 覆盖一门上游课程的打开、切换阶段与运行。
- 新增契约（LLM-01、SESSION-01、SESSION-02、AGENT-01）在 `packages/teaching-runtime/tests/` 针对上游包断言实际行为。

## 8 风险与待定

1. **编译产物与原文的对应只靠版本标签。** 如需更强保证，可在构建时用上游 tsconfig 编译所示源码，与 npm `lib/index.js` 比较导出名；成本较高，先不做，界面如实说明。
2. **大文件渲染。** tools 的 `index.ts` 1993 行。课程数据按 `codeStageId` 共享高亮源码，每个阶段只携带焦点与差异注解；system-prompt 试点的静态页从重复高亮时约 1.0 MB 降至约 465 KB。制作 tools 课程时仍需测量页面体积，过大时再评估只展示引用片段与上下文。
3. **确定性场景覆盖不到的路径**（重试、真实提供方、中断恢复）只能做解释阶段，课程验证等级不能写成全部可执行。
4. **固定 commit 升级。** 行号与哈希全部失效，构建会逐条报错；升级流程为：更新 `upstream-lock.json` 与 npm 版本 → `lessons:build` 列出失效引用 → 用 `lessons:ref` 重新固定。
5. **试点后可能调整形式。** 如果导读形式不理想（例如希望按调用路径跨包讲解，而不是按包），K1 评审后修改本方案再继续。

## 9 K0 当前状态

K0 已完成：§4.4 的上游阶段构建、锚点与哈希校验、共享检出和 `lessons:ref`；§4.5 的课程数据、上游来源说明和阶段焦点滚动；§7 的临时检出构建测试与浏览器课程闭环测试；`chat-greeting`、`tool-calculator`、`chat-cancel` 场景及其确定性执行测试；README、作者指南与 MIT 来源说明。CI 的 `lessons:build` 在 `lessons:verify` 和 `lessons:verify-upstream` 前调用 `ensureUpstream()`，后续检查复用同一检出。

K0 另外新增 `kernel-chat` 与 `calculator-chat` 组合：前者让系统提示词课程在不同阶段分别验证注册生命周期和作用域覆盖，后者用于在不启用默认拒绝策略时运行计算器工具场景。可选的“没有课程”插件提示尚未添加，不影响课程入口。

## 10 K1 试点当前状态

`content/plugins/system-prompt/` 已实现五阶段上游导读，覆盖配置、片段注册与顺序、作用域层、动态提供者与变量插值、组装与渲染。上游引用由 `lessons:ref` 生成并经固定 commit 哈希校验；可执行阶段使用 `chat-greeting`、`prompt-section-lifecycle` 与 `system-prompt-scope`，未由场景覆盖的动态输入路径保持为解释阶段。

已验证 `lessons:build`、`lessons:verify`、`lessons:verify-upstream`、静态 UI 构建、单元测试和课程页面端到端测试。相同 `codeStageId` 的高亮源码在课程页共享传输，每阶段单独带焦点与差异注解。K1 评审后再按 §6 决定是否批量制作 K2–K7 课程。
