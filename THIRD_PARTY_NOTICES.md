# 第三方声明

本仓库没有复制上游源码文件；以下内容说明哪些代码来自或依据第三方项目，以及它们的许可证。

## deepseek-ai/deepseek-harness

`packages/teaching-plugins` 中的核心插件（session、system-prompt、tools、llm、llm-scripted、llm-deepseek、agent-loop）是依据 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 固定 commit `687f282e8625c6b8d11ff58211a90524be2e4317`（见 `upstream-lock.json`）精简改写的实现：保留了上游的服务名、事件名与部分错误信息，文件头部注明对应的上游路径以及保留和删减的行为。prompt-contributor、tool-guard、calculator 是本项目编写的教学插件，没有对应的上游文件。课程内容引用上游源码时只给出链接、行号与内容哈希。

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
