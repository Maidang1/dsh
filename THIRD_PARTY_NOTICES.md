# 第三方声明

以下内容说明哪些代码来自或依据第三方项目，以及它们的许可证。内核课程构建时从固定 commit 检出读取上游原文并写入被忽略的 `dist/` 产物；源码不会作为副本提交到仓库。

## deepseek-ai/deepseek-harness

学习对象：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，固定 commit `687f282e8625c6b8d11ff58211a90524be2e4317`（见 `upstream-lock.json`）。对话内核以 npm 发布的 `@deepseek-ai/dsh-*` 包原样执行（见下节）；内核课程从该 commit 的检出读取所展示的 TypeScript 源码，并在上游对照面板提供文件、行号与 commit 链接。展示源码与执行的 npm 发布包按固定版本绑定，不声称源码与编译产物逐字节对应。prompt-contributor、tool-guard、calculator 与 llm-scripted 是本项目编写的教学插件，没有对应的上游文件；它们与上游的差异写在课程清单的 `simplifications` 与 `upstream-map.ts` 中。上游仓库及以下 `@deepseek-ai/dsh-*` 包使用同一份许可证：

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## @deepseek-ai/dsh-*（对话内核）

从 npm 原样引入，未修改，版本均为 `0.2.1-rc.2`——上游在固定 commit 上打的 `dsh-v0.2.1-rc.2` 标签的发布（见 `docs/decisions/0002-run-upstream-packages.md`）：

- 直接依赖：`@deepseek-ai/dsh-llm`、`dsh-session`、`dsh-session-projection`、`dsh-system-prompt`、`dsh-tools`、`dsh-agent`、`dsh-agent-loop`（最小对话内核），`dsh-llm-deepseek`、`dsh-llm-deepseek-api-key`（真实模型适配），`dsh-scope`（作用域），`dsh-credentials`、`dsh-launch-environment`（适配器所需的 peer 依赖）。
- 经 pnpm 引入的间接依赖（如 `dsh-anonymous-user-id`、`dsh-brand`、`dsh-util-values`、`dsh-typert-protocol` 等）同为 `@0.2.1-rc.2`、同一许可证。

各包内的 `LICENSE` 均为上节的 MIT License（Copyright (c) 2026 DeepSeek），不再逐包复制。

## @deepseek-ai/cordis、@deepseek-ai/cosmokit、@deepseek-ai/schemastery

从 npm 原样引入，未修改：`@deepseek-ai/cordis@4.0.5`、`@deepseek-ai/cosmokit@1.8.6`、`@deepseek-ai/schemastery@3.18.5`。三个包 tarball 中的 `src/` 与上游固定 commit 的 `vendor/` 目录逐字节一致（见 `docs/decisions/0001-upstream-baseline-and-reuse.md`）。三者使用同一份许可证：

```text
MIT License

Copyright (c) 2021-present Shigma

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 其他依赖

其余依赖由 `pnpm install` 从 npm 安装，各自的许可证文件随包分发；`pnpm licenses list --prod` 列出全部依赖及其许可证。截至本文件更新时，生产依赖以 MIT、ISC、Apache-2.0、BSD-3-Clause 与 0BSD 为主，另有两处需要说明：

- `@img/sharp-libvips-*`（LGPL-3.0-or-later）：Next.js 的可选图片处理依赖。界面以 `images: { unoptimized: true }` 静态导出，不调用图片优化，静态产物不包含它。
- `caniuse-lite`（CC-BY-4.0）：浏览器兼容数据，只在构建时由工具链读取。
