# Code Hike 与插件教学内容实现

## 1 目标与边界

Code Hike 展示插件实现逐渐增加的过程，用户能够观察每次代码增量对注册、状态和数据的影响。代码动画必须使用当前阶段实际执行的源码，不能在 MDX 中维护一份与运行器分离的示例。

Code Hike 不是代码运行器、调试器或状态机。阶段切换、模块编译、执行隔离、源码映射和状态关联由本项目实现。

官方文档确认当前接入方式包含 codehike 包、codehike/mdx 中的 remarkCodeHike 与 recmaCodeHike、highlight 与 Pre 等能力，并提供 Focus、Diff、Token Transitions、Scrollycoding、Slideshow 示例。实现时固定兼容版本后使用对应 API，不能假定旧示例可直接复制。

## 2 单一源码来源

每个可运行阶段保存完整 TypeScript 文件集。展示增量由相邻阶段文件差异自动生成。不能只保存几行补丁，在用户点击时临时拼接字符串再执行。

```text
packages/teaching-plugins/prompt-contributor/
  stages/
    00-entry/index.ts
    01-dependency/index.ts
    02-section/index.ts
    03-disposal/index.ts
  contracts/
    registration.spec.ts
    disposal.spec.ts

content/plugins/prompt-contributor/
  lesson.mdx
  manifest.ts
  architecture.ts
  upstream-map.ts
```

这里的插件名称和阶段编号为本项目教学内容规划，不声称上游存在同名插件或同样的拆分。上游真实的 SystemPrompt.section() 可作为提示词贡献行为的依据。

构建时依次执行：解析 manifest → 类型检查所有阶段 → 编译模块 → 提取展示代码 → 生成高亮数据 → 校验源码引用 → 执行阶段场景 → 输出 manifest 和内容哈希。

生成文件不手工编辑。共享辅助实现需可展开查看，不能在用户面前把核心行为藏在未解释的 helper 里。

## 3 内容类型

以下是本项目 schema 草案，使用 TypeScript 配合 Zod 校验。

```ts
interface LessonStage {
  id: string
  title: string
  objective: string
  kind: 'executable' | 'explanation'
  sourceFiles: string[]
  entryFile?: string
  sourceHash: string
  focusAnchors: string[]
  architectureNodeIds: string[]
  contractIds: string[]
  scenarioIds: string[]
  expectedObservations: string[]
  requiresServices: string[]
  upstreamRefIds: string[]
  simplifications: string[]
}

interface PluginLesson {
  id: string
  title: string
  summary: string
  pluginDefinitionId: string
  upstreamCommit: string
  stages: LessonStage[]
  prerequisites: string[]
  architectureId: string
  supportLevel: 'contract-verified' | 'upstream-compared' | 'draft'
}
```

manifest 作者不手写 sourceHash，构建器计算后注入。可执行阶段必须有入口文件、场景和契约；解释阶段不允许显示“运行本阶段”按钮，也不让上一阶段的运行结果冒充本阶段结果。

expectedObservations 是验收断言和用户引导，不能作为生成运行轨迹的数据源。

## 4 Code Hike 集成步骤

### 4.1 先验证最小接入

使用 Next.js + MDX 的最小页面验证 Code Hike MDX 插件、静态高亮、客户端阶段切换和代码过渡。验证 Node 本地启动、阶段模块在运行子进程中的加载路径、浏览器轨迹订阅及重连，并记录确切版本。

推荐把语法分析和高亮放在构建期。客户端只加载当前插件的处理后代码数据和动画组件。避免每次切换阶段在主线程重新解析所有文件。

### 4.2 项目级适配组件

下列名称是项目自定义封装，不是 Code Hike 原生 API：

- LessonCodePanel：根据 stageId 加载处理后的代码与焦点信息。
- StageNavigator：切换教学阶段，不直接操作运行游标。
- CodeTransition：封装选定版本的代码 token 过渡实现。
- SourceMention：文中符号链接，定位代码和架构节点。
- StageRunButton：提交绑定 sourceHash 的运行命令。
- UpstreamComparison：并排展示精简代码、上游片段与删减说明。

这些封装隔离 Code Hike 版本变化；领域数据不依赖其内部 token 结构。

### 4.3 高亮与动画

支持新增行、删除行、修改行、焦点区域和变量提及。默认动画时间建议 200–350 ms，最终由可用性测试调整。用户开启减少动画时直接切换，保留差异颜色及文字说明。

保持文件 ID 稳定，避免每次阶段切换都卸载整个代码面板。跨文件变化显示文件标签和变更计数。删除代码用短暂 diff 或独立差异视图呈现，不为了视觉效果改变实际源码。

## 5 代码锚点与源码映射

教学源码使用可校验 region 注释或符号名定位，例如 lesson:section-register。构建工具解析成 SourceRef 的行范围。锚点必须唯一且闭合；格式错误阻断构建。

上游代码使用完整 commit、实际文件、符号和提取范围。必要时保存片段哈希，避免版本更换后旧行号仍看似有效。

一个教学检查点可对应多段代码，一个源码片段也可能参与多个事件。映射使用多对多关系，不硬设“一行代码等于一次状态转换”。

```text
stageId
  ├── sourceHash / sourceRefIds
  ├── architectureNodeIds
  ├── semanticCheckpointIds
  └── contractIds

traceRecord
  ├── instanceId / stageId（由运行 manifest 确定）
  ├── checkpoint / event / span
  └── sourceRefIds
```

JS source map 用于异常定位，教学 SourceRef 用于语义解释，二者不能互相替代。

## 6 插件内部架构 schema

```ts
interface ArchitectureNode {
  id: string
  kind: 'entry' | 'type' | 'function' | 'class'
      | 'registry' | 'event' | 'resource' | 'external-service'
  label: string
  responsibility: string
  sourceRefIds: string[]
  introducedAtStageId?: string
}

interface ArchitectureEdge {
  id: string
  from: string
  to: string
  relation: 'calls' | 'implements' | 'registers' | 'reads'
          | 'subscribes' | 'disposes' | 'requires'
  evidence: 'source' | 'observed' | 'explanation'
  sourceRefIds: string[]
}
```

初期人工维护精选插件的架构元数据，通过构建器校验 sourceRef 和节点引用。自动扫描可辅助发现 imports、类和函数，但不能把 import 图当成完整架构，也不能从静态 AST 准确推断所有 Cordis 动态注册。

本阶段未引入的模块可隐藏或显示虚线占位，不能高亮为已执行。外部服务与插件内部模块使用不同边框和标签。

## 7 提示词贡献插件的第一条完整样板

这是一份教学插件的实施规划；名称与代码结构属于本项目。已核查的上游锚点包括 SystemPrompt.section()、PromptLayer、ScopedLayers 和 system-prompt/change，后续应继续核实组装路径。

| 阶段 | 实际代码变化 | 运行场景 | 应观察到的事实 |
|---|---|---|---|
| 00 入口 | 最小插件入口，不注册提示词 | 挂载后发送固定输入 | 请求与基线相同 |
| 01 依赖 | 声明 systemPrompt 服务依赖 | 分别提供/缺失服务 | 激活或等待原因来自依赖机制 |
| 02 注册 | 注册具名、带顺序的文本片段 | 发送相同输入 | 注册表新增项，下一次请求出现片段 |
| 03 清理 | 解释并保留可逆注册机制 | 挂载、卸载、再次请求 | 注册项移除，后续请求无该片段 |
| 04 作用域 | 加入同名局部覆盖场景 | 两个不同作用域 | 局部覆盖只影响对应作用域 |

清理不一定通过“新加 dispose 函数”实现。如果底层注册 API 已返回并绑定 disposer，就逐步揭示这段机制，而不是人为制造一个会泄漏的早期版本。阶段 03 可以是对真实已存在机制的展开解释；若标为 executable，则该阶段代码必须独立可运行。

必测细节：重复名称在同一作用域的错误、顺序值合法性、注册和移除通知、不同作用域的可见性、注册不会直接改写已经冻结的请求。

## 8 工具与中间件样板

工具教学按“定义 schema → 注册 → 进入模型声明 → 模型返回调用 → 校验/执行 → 记录结果 → 下一请求”展开。使用内存读取工具或确定性算术工具，避免第一版引入真实 shell。

模型脚本读取实际请求中的工具声明；没有工具声明时不得假装模型仍调用该工具。重复注册、未知工具和参数错误应有不同场景。

中间件样板通过两层监听器展示：外层进入、内层进入、执行、内层返回、外层返回。切换“委托”和“短路”代码阶段，实际运行确认后续监听器是否被调用。

工具执行不是每条分支都必然经过 post-execute。上游源码存在不同结算路径，教学契约需列出所覆盖分支，不能画一条对所有异常都成立的固定流水线。

## 9 内容制作流程

1. 阅读固定上游版本的实现、类型和测试，确定一个具体学习问题。
2. 编写行为契约，列出保留、替代和不支持的范围。
3. 先实现最终精简版本并通过契约验证。
4. 将最终实现拆成少量有意义的阶段；每阶段有可运行目标或明确的解释目标。
5. 配置确定性输入，执行生成轨迹，不手绘成功结果。
6. 编写架构映射和解释，引用具体符号。
7. 使用 Code Hike 预览增量，检查每步是否只引入少量新概念。
8. 校验所有可执行阶段类型检查、构建、测试和展示哈希一致。
9. 对最终阶段运行上游对照；记录该插件的验证等级。
10. 人工走完学习闭环后发布内容。

## 10 内容质量准则

- 代码简化以减少非当前机制的负担为目标，不以最少行数为目标。
- 默认片段建议 10–35 行，但允许展开完整文件，不为行数限制破坏语义。
- 每一步有一个可观察变化或一个具体设计解释。
- 区分本项目类型、教学适配器和上游 API。
- 不用“添加插件后模型必然更聪明”等不可验证描述。
- 没有执行的路径标为静态关系或未触发。
- 精简实现的名字可更易懂，但始终提供与上游符号的映射。
- 修改上游基线或最终实现后，所有阶段重新构建和验证。
