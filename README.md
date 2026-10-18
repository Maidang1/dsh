# Harness Explorer

面向首次阅读 DeepSeek Harness 源码的交互式学习实验台。从最小插件树开始，逐个添加插件，通过 Code Hike 逐步构建插件代码，观察状态、事件和数据流变化，并理解每个插件的内部代码架构。

应用由本地 Node.js 命令启动，浏览器继续承载原有插件树、Code Hike、数据流、时间线、回放与对比。Node 执行实际插件并读取本机环境，运行事实通过统一轨迹驱动可视化；不以 mock 数据或预设动画代替实际执行。确定性适配器保留用于无密钥教学和重复验证。

项目采用可执行的精简教学实现：不要求与上游逐行一致，但覆盖范围内的核心状态、转换条件、事件顺序和数据语义必须有源码依据及行为验证。

当前仓库处于设计阶段，尚未实现应用。以下命令、类型和目录规划均在实施文档中说明，不能视为已经存在的功能。

## 实现文档

从 [文档总览](docs/README.md) 开始。

1. [产品设计与范围](docs/01-product-design.md)
2. [系统架构与状态数据模型](docs/02-technical-architecture.md)
3. [Code Hike 与插件教学内容实现](docs/03-code-hike-and-plugin-lessons.md)
4. [分阶段实施计划与任务验收](docs/04-implementation-plan.md)
5. [行为一致性验证与发布标准](docs/05-validation-and-release.md)
6. [上游依据与待验证事项](docs/06-source-baseline.md)

目标仓库：[Maidang1/dsh](https://github.com/Maidang1/dsh)。学习对象：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
