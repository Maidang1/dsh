---
title: "从 profile 到插件树：dsh 如何组合与启动"
description: "同一套 dsh 安装，既能是浏览器里的 Web 应用，也能是一次性的命令行任务、SDK 服务器或 ACP 服务。本文拆解 profile、组合包与 patch 分层，以及启动器怎样把它们变成一棵运行中的插件树。"
date: 2026-10-25
author: Madinah
tags: [DeepSeek Harness, dsh, 配置组合, profile, 热重载, 启动流程]
series: 从架构读懂 DeepSeek Harness
order: 3
baseline: dsh-v0.2.1-rc.2 (687f282e)
---

# 从 profile 到插件树：dsh 如何组合与启动

> 系列第 3 篇。本文回答：`dsh web` 和 `dsh --profile headless "task"` 启动的是同一个程序，为什么得到的是两种完全不同的应用？用户怎样在不 fork 仓库的前提下替换其中任意一个插件？

## 问题：一个产品，五种形态

dsh 随发行版交付五个 profile 模板：

| profile | 形态 |
|---|---|
| `web` | 本地 Web UI（`npx @deepseek-ai/dsh web` 默认启动的就是它） |
| `headless` | 不带服务器的一次性任务运行器 |
| `sdk` | 供 TypeScript / Python SDK 连接的 JSON-RPC 服务器 |
| `sdk-minimal` | 显式写出整棵配置树的极简 SDK 组合 |
| `acp` | 仅用于自动化的 ACP 服务器 |

另外还有 Electron 桌面应用，它持有一个保留的 `desktop` profile。

这些形态共享绝大部分能力：模型适配器、工具、持久化、沙箱与审批、设置、凭据、遥测。差异只在“入口”和少数配置值上。如果每种形态各写一份启动代码，共享部分迟早会分叉。dsh 的做法是让启动器只做一件事：**按 profile 组合出一份 Cordis 配置列表，交给 Loader 挂载**。形态之间的差别全部落在配置数据里。

## 三个概念：profile、组合包、patch

### 组合包（bundle）

组合包是“一组 Cordis 配置行及其挂载代码”的分发格式，本身就是一个 npm 包。它在 `package.json` 的 `dsh` 字段里声明自己的 patch 文件：

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

rc.2 中的官方组合包：

- **`dsh-base`**：`web`、`headless`、`sdk`、`acp` 共享的第一层，包含近百个配置行（按 `id` 计），涵盖模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测等。
- **`dsh-web-app`**：在 base 之上加浏览器应用。
- **`dsh-headless`**：加一次性运行器。
- **`dsh-sdk-app`**：加 SDK JSON-RPC 服务器。
- **`dsh-acp-app`**：加 ACP 服务器。
- **`dsh-sdk-minimal`**：刻意保留的例外，自己拥有完整的显式配置树，不叠加 `dsh-base`。

### profile

profile 是存放在 Harness home 中的具名组装，目录在 `$DSH_HOME/profiles/<name>`。它列出自己叠放的组合包，存放自己安装的树外插件，并保存用户自己的 `cordis.patch.yml`。内置模板写在 [`app-boot/src/profile.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile.ts#L178-L195) 里，第一次使用时自动初始化：

```ts
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  acp: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
  },
  web: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  },
  headless: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  },
  sdk: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  },
  'sdk-minimal': {
    bundles: ['@deepseek-ai/dsh-sdk-minimal'],
  },
}
```

可以看到，四种形态都是“base + 一个模式组合包”，只有 `sdk-minimal` 单独成树。

### patch

patch 是一组针对配置行的操作，按 `id` 定位：

- 写出某个已有 `id` 及新的 `config`：**替换该行的整个 config**（不是合并）；
- `insert`：插入新行；
- `disabled: true`：保留该行，但不挂载。

“替换整个 config”这一点要特别注意。base 的 patch 文件开头注释专门解释了它带来的约束：如果某一行的值随模式不同，它就不放在 base 里，而由各模式组合包完整重述，这样任何一行最多只经过“一个组合包层 + 用户层”的覆盖，读者不必在多层之间做合并推理。

## 分层顺序

启动时，各层依次应用在一个空的条目列表之上：

```text
空列表
  ← profile 中按序列出的组合包 patch（例如 dsh-base，然后 dsh-headless）
  ← profile 自己的 cordis.patch.yml
  ← Harness home 的 cordis.patch.yml
  ← 命令行 --patch overlay
= 最终配置树 → Cordis Loader 挂载
```

后面的层优先级更高。用户的 patch 永远叠在所有组合包之后，所以**任何一个官方配置行都能被用户自己的 patch 替换**。上游架构文档的说法是：`dsh --profile web --dump-config` 打印出的任何条目，都可以由你自己的 patch 替换。

来看 `headless` 组合包的完整 patch（[`packages/bundle/headless/cordis.patch.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/headless/cordis.patch.yml)，删去了注释）。它只有二十几行，却把 base 变成了一个命令行任务运行器：

```yaml
- id: system-prompt
  config:
    personaPrefix: >-
      You are a coding agent powered by the {{model}} model.

- id: tools
  config:
    mode: !!js process.env.DSH_TOOLS_MODE

- insert:
    - id: headless-startup
      name: '@deepseek-ai/dsh-headless/startup'

    - id: headless-runner
      name: '@deepseek-ai/dsh-headless'
      inject: [headlessStartup]
      config:
        task: !!js ctx.headlessStartup.task
        sessionId: !!js ctx.headlessStartup.sessionId
        json: !!js ctx.headlessStartup.json

- id: hmr
  disabled: true

- id: credentials
  disabled: true

- id: authorization
  disabled: true

- id: deepseek-account
  disabled: true
```

逐段看：

1. 替换 `system-prompt` 和 `tools` 两行的 config，给出 headless 模式的人设前缀和工具模式。
2. 插入两行：`headless-startup` 解析命令行参数并提供 `headlessStartup` 服务；`headless-runner` 注入这个服务，从中读取任务、会话 id 和输出格式，然后通过核心注册表创建 Agent 并打印持久结果。
3. 禁用 base 中的热重载、交互式凭据存储和账户登录，因为一次性任务使用启动时的环境凭据。

没有一行启动代码，只有数据。

## `!!js` 表达式：配置里的动态值

上面的 `!!js ctx.headlessStartup.task` 是 `@deepseek-ai/cordis-plugin-include` 提供的表达式节点。规则是：

- 条目的 `config` 在该行声明的注入激活后，基于该插件的上下文求值，所以 `headless-runner` 可以在 config 里读 `ctx.headlessStartup`；
- 条目的 `disabled` 在每次挂载决策时基于 loader 上下文求值，比如 base 中 `disabled: !!js "!ctx.get('profileContext')"`，以及按平台二选一的 `disabled: !!js process.platform === 'win32'`；
- 其他元数据保持字面值。要按环境选择插件，应该用 overlay，而不是在 `name` 上写表达式。

## 启动器：唯一的入口

dsh 对“怎样启动一个 Node 应用”有一条硬规则：**受支持的 Node 应用只能通过具名 `dsh` profile 启动**。包自带的 bin、demo 和 SDK 都不能绕过 `dsh` 自建一棵插件树。仓库里的 `verify-application-entrypoints` 脚本把每个包 bin、可执行源码和根脚本归入显式类别，拒绝任何绕过 `dsh` 的 Node 应用路径。

这条规则同样约束 SDK：

- TypeScript SDK 解析同版本的 `dsh` 依赖并选择 `sdk` profile；
- Python SDK 的运行时 wheel 把普通 `dsh` CLI 打包进去，客户端默认以显式 Harness home 启动 `dsh --profile sdk`；
- 两种 SDK 暴露的都是“选择 profile + 有序 patch 文件”，而不是一棵完整的 Cordis 树。

桌面应用也不例外：Electron 以 Node 模式启动私有 Desktop Host，Host 调用共享的 CLI profile runner 和完整的 Web 应用。

把入口收敛到一处的好处是，版本兼容检查、运行时依赖解析、启动诊断这些横切逻辑只需要实现一次。

## 启动器在挂载前做的事

`app-boot` 包负责 profile 加载与组合。挂载插件之前，它还做了几件事：

**版本兼容检查。** profile 导入插件前，会把插件声明的 DSH 版本要求与运行时版本比较：声明了 `engines.dsh` 时只看它；否则 `peerDependencies` 中对 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` 的每个范围都必须匹配。不兼容的普通行会被改写成 `disabled: true`，它的模块根本不会被导入。用户可以在 profile 的 `compatibility.json` 里为精确的 `包名@版本` 授予豁免，豁免不会随插件升级或 dsh 升级继承。上游文档特别说明，这些检查不是防范恶意包代码的沙箱。

**组合包降级而不是崩溃。** 某个组合包解析失败、读不到 manifest 或 patch 加载失败时，启动器跳过该组合包并在 `skippedBundles` 中列出，其余组合包保持原顺序。但 profile 和用户 patch 的错误仍会让启动失败，因为那是用户明确写下的意图。

**确定运行时解析。** 启动器从安装依赖图与有序组合包依赖图计算一份不可变的 runtime resolution，安装到 Node 的 ESM 与 CommonJS 解析器中，普通 Node、打包可执行文件和 Electron Host 都走这一套。

## 热重载：id 是关键

base 启用了一个只监视配置的 `dsh-hmr`；headless、SDK、ACP 禁用它，`sdk-minimal` 不包含它。启用时，HMR 监视 profile manifest 和两份用户 patch 文件，变化后重新组合。

重新组合之所以可行，靠的是上一篇讲的两个性质：卸载会撤销所有 effect，加载遵循依赖关系。Loader 按 `id` 比较新旧两份配置，只挂载、卸载或重新配置发生变化的行。这也是 dsh 的每个配置行都带显式 `id` 的原因：不带 `id` 的行每次读取都会得到一个新生成的 id，配置文件任何一处编辑都会让它被当成“先删除再添加”而重新挂载。

热重载失败时的处理按条目区分。上游 app-boot README 给出了一张完整的失败策略表，摘几行：

| 失败模式 | optional 条目启动时 | required 条目启动时 | 后续配置 HMR |
|---|---|---|---|
| 根配置缺失、格式错误或含无效条目 | 终止启动 | 终止启动 | 拒绝该 patch，运行中的配置不变 |
| 模块导入失败或求值抛错 | 警告，继续 | 终止启动 | 报告错误，保留成功的兄弟插件 |
| 插件配置 schema 校验失败 | 警告，继续 | 终止启动 | 新条目保持未激活，现有条目保留原实例 |

required 条目无法激活时，`boot()` 会先释放已挂载的资源，再以 `StartupError` 拒绝；CLI 打印一次分组后的诊断（失败的插件、在等待的服务、原始堆栈），保存完整启动诊断后以退出码 1 结束。上一篇提到的“静默 PENDING”在这里得到了兜底。

## 实践：替换一个配置行

假设你想把 Web 应用默认使用的模型从 `deepseek-flash` 换掉。base 里对应的行是：

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-flash
```

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里写同一个 `id` 和新的完整 config 即可，不需要碰任何组合包：

```yaml
# 示意：替换 agent-default-model 行的整个 config
- id: agent-default-model
  config:
    provider: deepseek-official
    model: <你要使用的模型 id>
```

启动前用 `dsh --profile web --dump-config` 确认结果。dump 会按 patch 层分组标注每一行来自哪个源文件，未匹配任何行的 patch 也会连同层标签一起报告。

## 设计取舍

- **配置即程序。** 好处是形态之间不会分叉，用户能替换任何一行；代价是读懂一个应用需要读懂一份几百行的 YAML，以及 `!!js` 表达式的求值时机。`--dump-config` 和生成的[配置目录](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/config-catalog.zh.md)是必备工具。
- **整行替换而非深度合并。** 语义简单、可预测，但用户覆盖某一行时必须重述所有想保留的字段。
- **单一入口。** 横切逻辑只实现一次，但第三方想嵌入 dsh 时不能“直接 new 一个 Loader”，必须走 profile 和 patch。

## 小结

- profile 列出组合包，组合包提供配置行，patch 按 `id` 替换或插入配置行；四个模式 profile 都是“base + 模式组合包”，`sdk-minimal` 单独成树。
- 分层顺序是：组合包 → profile patch → home patch → `--patch`，用户层永远在最后。
- 所有 Node 应用（包括 SDK 和桌面）都通过 `dsh` profile 启动，版本检查、运行时解析和启动诊断集中实现。
- 热重载依赖 effect 可撤销和配置行的稳定 `id`。

插件树挂好之后，真正干活的是 agent loop。下一篇：[一个轮次的一生](04-turn-lifecycle.md)。

## 参考

- [架构：Profile 与组合包、应用启动](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.zh.md)
- [app-boot README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/README.zh.md)
- [dsh-base 组合包 patch](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml)
- [dsh-headless 组合包 patch](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/headless/cordis.patch.yml)
- [Cordis 教程第 6 章：组合与 HMR](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cordis-tutorial/06-composition-and-hmr.zh.md)
