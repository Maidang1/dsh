# 课程制作指南

本指南把 [03 §9 内容制作流程](03-code-hike-and-plugin-lessons.md#9-内容制作流程) 落到本仓库的目录与命令上。新课程只增加内容、阶段源码与 fixture，不修改运行器或界面；`prompt-contributor` 与 `tool-guard` 是两份可对照的完整示例。

## 1 生成骨架

```sh
pnpm lesson:new <plugin-id> [课程标题]
pnpm lessons:build && pnpm lessons:verify
```

`plugin-id` 只能是小写字母、数字和连字符。命令不会覆盖已有文件，生成后的骨架可以直接构建和验证：

| 文件 | 作用 |
|---|---|
| `packages/teaching-plugins/<id>/stages/00-entry/index.ts` | 第一个可执行阶段：完整、可运行的插件源码，带 `// lesson:entry` 锚点 |
| `packages/teaching-plugins/src/catalog.ts` | 追加一行 `stage('<id>', '00-entry', [], [])`，登记阶段的 `requires` 与 `provides` |
| `content/plugins/<id>/manifest.ts` | 课程与阶段元数据，初始等级 `draft` |
| `content/plugins/<id>/architecture.ts` | 内部架构节点与边，节点引用阶段锚点 |
| `content/plugins/<id>/upstream-map.ts` | 上游源码引用（固定 commit、行号、内容哈希） |
| `content/plugins/<id>/lesson.mdx` | 讲解正文 |
| `fixtures/compositions/<id>.json` | 运行课程阶段的组合：最小对话树加上本插件 |
| `fixtures/scenarios/<id>.json` | 场景：确定性模型脚本 `greeting` 与一次输入 |

骨架里的 `TODO` 都需要替换；`summary`、`objective` 与 `expectedObservations` 必须写成运行后能在轨迹里核对的事实。

## 2 制作步骤

1. **确定学习问题**：在固定 commit（`upstream-lock.json`）上阅读上游实现、类型与测试，只选一个机制，例如“around 中间件如何短路”。
2. **写契约**：在 `docs/contracts/` 增加或复用契约条目，写明保留、替代与不支持的范围，并在对应包的 `tests/` 中写测试。阶段的 `contractIds` 只能引用已存在的契约编号，构建会核对。
3. **先写最终版本**：在最后一个阶段目录实现精简插件，跑通契约测试。每个文件头部注明对应的上游路径与删减的行为。
4. **拆阶段**：把最终实现拆成少量阶段（`00-…`、`01-…`），每个阶段目录都是完整可运行的副本，不是 diff。每个阶段在 `catalog.ts` 登记一行，并在同一文件的 `responsibilities` 中为插件定义选择职责（插件库按它筛选，`pnpm test` 检查每个定义都已分类）；`requires` 必须与源码 `inject` 的服务一致，构建会拒绝不一致的声明；`provides` 由 `lessons:verify` 对照运行中该实例实际提供的服务核对。
5. **配置场景**：在 `fixtures/scenarios/` 写步骤（input、mount、unmount、snapshot、cancel），模型回复写在 `fixtures/model-scripts/`。需要在轨迹里标出教学位置时，调用 `shared/checkpoint.ts` 的 `checkpoint(ctx, '<id>:<名字>', 数据)`，并在阶段的 `expectedCheckpoints` 里按顺序列出本插件应记录的检查点：`lessons:verify` 逐一核对，课程的“状态与数据”面板并排显示预期与实际。不手写成功结果，一切观察都来自实际运行。
6. **写架构与讲解**：`architecture.ts` 的每个节点用 `sourceRefIds`（`<id>@<阶段>#<锚点>`）指向具体代码；`lesson.mdx` 区分代码事实与设计解读，未执行的路径标为静态关系。
7. **预览增量**：`pnpm build && pnpm explorer`，在课程页逐阶段查看 Code Hike 增量，确认每步只引入少量新概念，`focusAnchors` 落在本阶段的变化上。
8. **构建与验证**：`pnpm typecheck`、`pnpm test`、`pnpm lessons:build`、`pnpm lessons:verify`。展示代码与执行模块共用同一 sourceHash；源码改动会改变 sourceHash 与 contentVersion，对比视图把内容版本列为可比条件之一。
9. **上游对照**：在 `upstream-map.ts` 记录上游片段（`path`、`symbol`、`startLine`、`endLine`、`contentHash`），用 `pnpm lessons:verify-upstream` 核对。全部契约测试通过后把 `supportLevel` 改为 `contract-verified`；`upstream-compared` 需要上游参考执行器，目前尚未提供（见实施状态 P5-04）。
10. **人工走查**：在界面里走完整条学习闭环（运行、回放、对比、课程阶段），再在 README 的课程表中登记。

## 3 发布前检查

- [ ] 每个可执行阶段都能单独运行，`lessons:verify` 全部 ok。
- [ ] `requires` 与源码一致，`contractIds`、`scenarioIds`、`architectureNodeIds`、`upstreamRefIds` 都能解析。
- [ ] 锚点成对闭合且非空，`focusAnchors` 指向本阶段真正变化的代码。
- [ ] `expectedObservations` 能在该阶段的轨迹中逐条找到。
- [ ] 每个阶段的 `simplifications` 至少一条（构建检查），写明与上游的差异，没有“模型必然更聪明”一类不可验证的描述。
- [ ] 上游引用通过 `lessons:verify-upstream`，`supportLevel` 与实际验证等级一致。
- [ ] 内容质量符合 [03 §10](03-code-hike-and-plugin-lessons.md#10-内容质量准则)。
