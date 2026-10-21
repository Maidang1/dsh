# Harness Explorer 界面改版：分层插件树 + 数据流 + Code Hike 源码深入

设计稿：`docs/design/harness-explorer.pen`（只能用 Pencil 打开）。每个画板的截图在 `docs/design/screens/`，实现时以截图为准。

| 截图 | 内容 |
|---|---|
| `01-workbench-dataflow.png` | ① 主屏：分层插件树、数据流、运行栏、回放栏、右侧「数据流」标签 |
| `01b-instance-inspector.png` | 右侧「实例」标签（现有 Inspector 的全部内容） |
| `01c-add-plugin.png` | 插件库抽屉（现有 PluginLibrary） |
| `01d-scopes-presets.png` | 作用域弹层（ScopeEditor）、预设弹层（PresetPicker）、画布上的嵌套作用域容器 |
| `01e-run-compare.png` | 右侧「对比」标签（现有 RequestDiff + RunDiff） |
| `01f-trace-runs-error.png` | 轨迹抽屉（TimelineRows）、运行选择弹层、错误横幅 |
| `02-lesson-codehike.png` | ② 插件实现页（LessonView）：阶段叙述 / Code Hike 代码 / 实时联动 |
| `02b-lesson-architecture.png` | ② 解释阶段 + 「内部架构」标签 |
| `02c-lesson-upstream-mismatch.png` | ② 「上游对照」标签 + 所选运行代码版本不对应的警告 |
| `03-narrow-list.png` | 窄屏：标签页切换 + 按层分组的列表视图 |

## 0 不可违反的约束

- 这是**界面重写，不是功能删减**。现有功能（见 `docs/generated/implementation-status.md` 的 P3、P4、P7）全部保留，只是换位置和样式。`lib/` 下的 store、api、replay、compare、library、errors 等逻辑尽量不改。
- 遵守 `docs/01-product-design.md`：界面展示的状态与流向必须来自 trace，**不能用预设动画或按事件名推断未观测的调用**。没有记录的关系不画成数据流。
- 保留键盘操作、列表视图、减少动画、窄屏标签页、错误提示（操作 / 原因 / 恢复）以及现有 aria-label。e2e 和 axe 依赖这些标签；确需改文字时同步更新测试。
- 不显示不可用的控件：P5-04 上游行为对照未实现，所以不放「上游对照运行」按钮；只保留已有的「上游对照」源码引用标签。P6 未开始，不放暂停执行按钮。
- 所有命令最终要通过 `pnpm check`。本机 e2e 用：`PW_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" pnpm test:e2e`。

## 1 设计 token（`apps/explorer/src/app/globals.css`）

深色为主题。用 CSS 变量，命名与设计稿一致：

```
--bg #0D0E10  --surface #141619  --surface-2 #1B1E22  --surface-3 #23272C
--border #262A30  --border-strong #353A42
--text-1 #ECEEF1  --text-2 #A2A8B1  --text-3 #6C727B
--accent #8EA8FF  --accent-soft #8EA8FF1F
--ok #45C08A  --warn #E6A94A  --info #5DB0EA  --err #F06A64  --unload #B993F2
--font-ui "Noto Sans SC", system-ui   --font-mono "JetBrains Mono", ui-monospace
```

字号：正文 12–13px，次要 11px，代码 12.5px，标题 14–18px。圆角 6–12px。状态颜色不能是唯一区分手段（保留状态符号与文字，例如 `● 已激活`）。焦点外变暗代码行的对比度问题见 implementation-status P7-02，不能变得更差。

## 2 ① 整体组合（`Workbench.tsx`）

纵向三段：顶栏 52px → 运行栏 40px → 主区（画布 + 右侧面板 360px）。整页一屏高，不出现页面滚动。

### 2.1 顶栏（`RunBar` 重写）
品牌 → 场景选择（现有 select，显示场景标题）→ 模型模式选择（确定性 / 真实，保留缺少 Key 时禁用及原因）→ 控制器状态胶囊（`控制器空闲 · 已连接`，运行中显示占用原因）→ 运行中时出现「停止运行」→ 主按钮「运行教学代码」。真实模型时显示「结果不可严格复现 · 环境来自本机」。

### 2.2 运行栏（原 `workbench__subbar`）
`查看运行` 选择器（run id + 结果徽章）、revision 短 id、草稿与所选运行版本不同的提示、观看正在进行的运行、导出 / 保留 / 删除（删除前确认）、导入运行、存储容量说明。选择器展开后的样式见 `01f`（可以继续用原生 select，弹层是视觉目标，非硬性）。

### 2.3 画布：分层插件树（`PluginTree.tsx` 重写布局）
- **分层**：横向条带 L0 根作用域 / L1 基础服务 / L2 能力 / L3 扩展 / L4 编排，左侧固定显示层名与一句说明。层来自目录里的新字段（见 §5.2），目录未声明时按 `requires` 的依赖深度计算（无依赖为 L1，依赖最深者 +1）。
- **节点**：160–200px 宽卡片，图标 + 实例 id（等宽）+ 状态点 + 副标题（`→ 提供的服务` 或 `← 依赖`）。状态沿用 `phaseOf()` 的 7 种情况，保留 reason 文案。选中节点用 accent 描边；草稿新增的实例显示「+ 新增」标签；选中后出现「双击进入源码 · N 个阶段」提示（有课程时），双击或 Enter 进入课程。
- **作用域**：非 root 作用域画成紫色虚框容器，标题 `作用域 agent-b ⊂ root`，包住该作用域的实例（见 `01d`）。
- **连线**：一律直角圆角线（React Flow `smoothstep`），每条线带文字标签，不能只靠颜色区分：
  - 组合图层：父子关系（现有 `parentId`）和 root → L1。
  - 依赖图层：consumer → provider，标注 `已解析 / 声明 <service>`（现有逻辑）。
  - 数据流图层（默认）：见 §2.4。
- 视图切换（左上）：`组合 | 依赖 | 数据流` + `列表视图`。右上：`作用域 N`（弹出 ScopeEditor）、`预设…`（弹出 PresetPicker）、`+ 添加插件`（右侧抽屉 PluginLibrary，带遮罩）。
- 保留 Controls（缩放、适配）和 FitOnResize。

### 2.4 数据流（只用 trace 中存在的记录）
以回放游标所在的「一次请求」为单位：从上一个 `scenario/step`（kind=input）到下一个 `scenario/step` 之间的记录。按顺序编号显示：

| 记录 | 画在哪里 |
|---|---|
| `scenario/step` input | agent-loop 节点下方的输入标签 |
| 当前有效的 `registration/add`（来自 snapshot.registrations，`instanceId` → 提供者） | 贡献者 → system-prompt / tools 的边，标签 `registration · <name>` |
| `checkpoint/<plugin>:<name>` | 标签贴在 `<plugin>` 节点旁，不画到其他节点的边 |
| `model/request` / `model/response` | 有 `instanceId`（§5.1）时画 发起者 → llm 的边并让「数据包」停在边上；没有时只高亮 llm 节点 |
| `session/event` | session 节点旁的标签 |

边的三种状态：已流经（accent 50%）、当前（accent 实线 + 发光 + 数据包圆点）、未到（灰）。数据包位置只由当前记录决定，`prefers-reduced-motion` 时不做移动动画。

### 2.5 右侧面板：标签页 `数据流 | 实例 | 对比`
- **数据流**（`01`）：标题 `请求 #2 · N 步`、回放中徽章；步骤时间轴（编号、事件名、所属实例、一行说明）；当前步骤展开 payload：`model/request` 显示 system 各段，与上一次请求比较，新增段绿色并标出来源实例与「看源码 →」（跳到该实例课程）；底部「这一步要观察」卡片使用课程的 `expectedObservations`（没有课程时隐藏），并注明它不是轨迹来源；最下方图例。
- **实例**（`01b`）：现有 `Inspector` 的全部字段与操作：状态、依赖、需要/提供、StateFix、可点击的状态变化历史、当前注册项、「进入插件实现」、编辑草稿（阶段、作用域、运行开始时挂载、JSON 配置及支持的键、应用配置、外部更新冲突提示）、从组合中移除（列出受影响消费者与注册项的确认）。未选中时显示节点状态图例与图层说明（现有空状态）。
- **对比**（`01e`）：现有 `RequestDiff`（对照运行、请求 A/B、对照条件、system/messages/tools diff）+ `RunDiff`（注册表、执行过程、会话记录，默认折叠）。

### 2.6 回放栏（画布底部浮条）
播放/暂停、上一条、下一条、`步骤 x / y` + `回放 #seq / last`、按场景步骤分段的进度条（挂载 / 请求 #1 / 请求 #2 / 卸载 / 再请求，来自 `scenario/step` 记录，可点击跳转）、速度 `1× 2× 4×`、`场景结束`、`到最新`（含结算）、`轨迹` 开关。说明文字「回放只移动游标，不重新执行」放到 title 或 sr-only。

### 2.7 轨迹抽屉（`01f`）
`轨迹` 打开画布下半部抽屉：标题 + 条数 + 键盘提示、按 TraceKind 筛选、当前记录行（`#seq name · 实例 · 步骤`，`在插件树中选中`、`查看本次运行的阶段代码`）、虚拟化 `TimelineRows`（seq / kind 色点 / name / 实例 / 摘要），保留 ↑↓ 键盘移动游标。

### 2.8 错误横幅
运行栏下方一条：图标、失败的操作、原因、恢复操作、`知道了`。沿用 `lib/errors.ts`。

## 3 ② 插件实现（`LessonView.tsx` + `CodePanel.tsx`）

顶栏：`← 插件树`、`L3 扩展 › prompt-contributor`、支持等级徽章、`阶段 3/5 · 标题`、可执行阶段显示「运行此阶段」，解释阶段换成徽章「解释阶段 · 展示 <codeStageId> 的代码，不单独运行」。

树位置条：`root → system-prompt (inject) → prompt-contributor → agent-loop (被读取)`，链条由该实例的 requires 与读取它的消费者生成；右侧显示对应运行与 sourceHash 是否一致（现有「对应运行」徽章的全部分支文案）。不对应时整条显示黄色警告横幅 + 「运行此阶段」（`02c`）。

主区三栏：
1. **阶段叙述（340px）**：标题 + 全部阶段卡片。当前阶段展开 objective、MDX section、`运行此阶段后应看到`（expectedObservations，中性引导列表，不做验证打勾）；已成功运行的阶段打勾（学习进度）；解释阶段带「解释」标签。底部 `上一阶段 / 下一阶段`，保留 ← → 快捷键。
2. **Code Hike（自适应）**：文件标签（多文件时）、`相对上一阶段 +a −r`、行号 + 增删改标记 + 焦点区高亮、焦点外变暗；底部图例与 `sourceHash … 与运行版本一致/不一致`。保持现有 `LessonCode` 的 Code Hike 渲染与定位滚动。
3. **右侧标签 `状态与数据 | 内部架构 | 上游对照`（440px）**：
   - 状态与数据（`02`）：systemPrompt 注册表（游标时刻，当前插件的行高亮）、生命周期时间轴（该实例的状态变化与注册/移除记录，点击移动游标）、检查点对照（现有 CheckpointCheck）、模型请求的 system 文本（本插件贡献的段高亮）。
   - 内部架构（`02b`）：节点卡片（kind 徽章、职责、`定位代码`、后续阶段引入的标为占位、本阶段相关的高亮）+ 关系列表（关系词、依据：源码 / 运行观测 / 解释）。
   - 上游对照（`02c`）：上游片段链接（符号、路径、行号、commit）、精简说明、「左侧是精简教学实现」说明。

代码行 ↔ 运行记录的行级联动（截图中的 `trace #12 · 已注册`、`L16–20`）属于 §5.3，可后做；没有映射时只链接到阶段，不要伪造行号。

## 4 窄屏（`03`）
宽度 < 900px：顶栏压缩为场景 + 运行按钮；主区用 `NarrowTabs`：`插件树 | 详情 | 轨迹`；插件树默认列表视图，按层分组，正在流经的节点带步骤编号；底部保留迷你回放条。页面不能横向滚动。

## 5 需要的运行时 / 数据改动

### 5.1 `model/request`、`model/response` 记录实例
`packages/teaching-runtime/src/observe.ts` 里 `llm/request`、`llm/response` 的监听器目前没有 `instanceId`。仿照 `internal/service` 的写法（`function (this: Context)` 拿到发出事件的上下文，用 `this.instanceOf(ctx.fiber)`），在记录里加 `instanceId`。补一条契约/单测证明 agent-loop 发出的请求被记到正确实例，并更新相关快照。

### 5.2 目录里的层
`packages/teaching-plugins/src/catalog.ts` 在 `responsibilities` 旁加 `layers: Record<string, 1|2|3|4>`：session/system-prompt/llm = 1，tools/llm-scripted/llm-deepseek = 2，prompt-contributor/calculator/tool-guard = 3，agent-loop = 4。经 local-server 的 catalog 接口暴露给前端（照 responsibilities 的路径），`pnpm lesson:new` 的脚手架与 `docs/authoring.md` 一并说明。加测试保证每个目录插件都有层。

### 5.3（可选，最后做）行级联动
在课程 manifest 里允许声明 `registrationAnchors`（例如 `prompt-section:lesson:style → lesson:section`），由 lesson-kit 校验锚点存在。有映射时，注册记录可跳转到具体行，代码里显示 `trace #seq` 徽章。

## 6 验收
- `pnpm check` 全部通过（e2e 用上面的 PW_CHROMIUM）。
- axe 无 serious/critical。
- 在 1440×900、1000×640、390 宽下截图，与 `docs/design/screens/` 对照；把截图放到 `/tmp/redesign-shots/` 并在汇报中列出路径。
- 不改动 `docs/design/` 以外的文档结论；`implementation-status.md` 只追加本次改版的条目。
