# DeepSeek Harness 的 MCP Lens

[English](README.md) | 简体中文

[官网](https://deepseek-harness-mcp-lens.charmingkla.chatgpt.site) · [本地 Schema 计算器](https://labmimors.github.io/dsh-mcp-lens/) · [安装 rc.9](#install)

[![verify](https://github.com/labmimors/dsh-mcp-lens/actions/workflows/verify.yml/badge.svg)](https://github.com/labmimors/dsh-mcp-lens/actions/workflows/verify.yml)
[![release](https://img.shields.io/github/v/release/labmimors/dsh-mcp-lens?include_prereleases)](https://github.com/labmimors/dsh-mcp-lens/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-developer%20preview-5B5BD6)](https://github.com/deepseek-ai/deepseek-harness)

**把大型 MCP 工具库收缩成模型只看见的两个工具。**

MCP Lens 让 DeepSeek Harness 通过两个稳定入口搜索并调用 1,000 个远端工具。它不会在每轮请求中塞入全部工具 Schema，而是只在真正需要工具时，为少量排序候选揭示准确 Schema。

如果它帮你管住了大型 MCP 工具库，欢迎[给仓库点个 Star](https://github.com/labmimors/dsh-mcp-lens)，让更多 DeepSeek Harness 用户找到它。

用户最关心的四件事：

- 更省输入成本：在带日期的三任务实测里，DeepSeek V4 Flash 预估费用从 `$0.0307204` 降到 `$0.0034707`。
- 更少占上下文：同一组实测里，`request/header.tools` JSON 从 `674,249 B` 降到 `27,401 B`。
- 更容易找回相关的已覆盖调用：在冻结的 MCP-Atlas 衍生便利 Holdout 上，304 个未触碰 Prompt 的 Recall@5 从 `0.062610` 提升到 `0.246656`。这只是词法检索证据，不是 MCP-Atlas 官方分数或端到端成绩。
- 避免每次查询重复构建同一索引：rc.9 会复用每个 Lens 自有冻结目录与策略世代的分词索引，并在目录变化时自动失效。
- 缩小模型的选工具范围：搜索只揭示少量排序候选的准确 Schema，最终 `server/tool` 仍然受 `allowTools` / `denyTools` 限制。
- 在已测任务里保持完成率：真模型实测两侧都完成 `3/3`，Lens 多用了一次搜索步骤。

如果你有几十到几千个 MCP 工具、多个 Server，或者很多长尾能力不值得每轮都暴露给模型，这个插件适合你。只有几个固定工具、而且几乎每轮都会用到时，直接客户端通常更简单。

<a id="install"></a>

## 安装 rc.9

前置要求：DeepSeek Harness `0.1.0-rc.6`、Node.js `^22.19.0` 或 `>=24.0.0`，并且 `pnpm` 已在 `PATH` 中。`dsh plugin` 会把安装交给 pnpm 执行。

最快安装方式：

```sh
dsh plugin --profile web add dsh-mcp-lens@next
```

需要可复现安装时，固定到已审核版本：

```sh
dsh plugin --profile web add dsh-mcp-lens@0.1.0-rc.9
```

npm 的 `next` 标签目前解析到 `0.1.0-rc.9`。发布后下载的 Registry Tarball 已与审核过的 GitHub rc.9 附件逐字节比较一致（`SHA-256 a8e4bf8389d0107379c13c845feb3c7c0c26d4aa3312391640e1fed074d39dbc`），并在全新的 DeepSeek Harness rc.6 Profile 中完成真实安装验证。

<details>
<summary>改为校验并安装 GitHub Release 附件</summary>

rc.9 Release 页面已经列出 `.tgz` 附件与 SHA-256。先下载文件，把本地摘要与该附件显示的摘要逐字比较，确认一致后再把本地文件安装到 Harness Profile。某些 pnpm 版本直接接收 GitHub 重定向后的附件 URL 时会报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`。

```sh
curl -fL --retry 3 -o dsh-mcp-lens-0.1.0-rc.9.tgz \
  https://github.com/labmimors/dsh-mcp-lens/releases/download/v0.1.0-rc.9/dsh-mcp-lens-0.1.0-rc.9.tgz
shasum -a 256 dsh-mcp-lens-0.1.0-rc.9.tgz
# 与 rc.9 Release 页面中 .tgz 附件显示的 SHA-256 逐字比较。
dsh plugin --profile web add ./dsh-mcp-lens-0.1.0-rc.9.tgz
```

Windows 用户可从 [rc.9 Release 页面](https://github.com/labmimors/dsh-mcp-lens/releases/tag/v0.1.0-rc.9)下载同一附件，把 `Get-FileHash -Algorithm SHA256` 的结果与附件显示的摘要逐字比较；只有一致时才把本地路径交给 `dsh plugin add`。

</details>

要真正开始使用，请继续完成[连接第一个 MCP Server](#连接第一个-mcp-server)；其中的复制粘贴配置会同时添加 Server 和你要放行的准确工具。然后验证并启动 Profile：

```sh
dsh --profile web --dump-config
dsh --profile web
```

完成后像平常一样提问即可，不需要在 Prompt 里手动写 `mcp_search` 或 `mcp_call`。

可以直接试试[本地目录测量页](https://labmimors.github.io/dsh-mcp-lens/)：把你当前的工具 Schema 粘进去，浏览器会本地计算准确 UTF-8 bytes，并可复制不含 Schema 的分享链接或 Markdown。分享结果固定标注为**用户自报的本地测量（self-reported local measurement）**，URL 只编码有边界的数字字段，不包含工具名、描述或 Schema。数字校验只能发现意外修改，不是签名，也不能证明测量真实发生过。如果希望把它变成可重复的 CI 约束，可以用 [Schema 预算 Action](#在-ci-里阻止-schema-失控增长)，在工具数量或 Schema 字节超过上限时让 Workflow 失败。

如果你想把同样的测量放进 CI，这个仓库也附带了一个零依赖 GitHub Action：读取仓库内的工具 JSON，输出模型可见工具数、标准 Schema 字节数，以及相对 Lens 固定两工具面的字节降幅。

```yaml
- uses: labmimors/dsh-mcp-lens@v0.1.0-rc.7
  with:
    tools-file: fixtures/request-header-tools.json
```

生产环境如需不可变引用，请固定到已审核的 rc.7 Commit：`f21169f921e7ed032a4db5062685afb6f948c2d1`。

<p align="center">
  <img src="assets/mcp-lens-comparison.zh-CN.svg" alt="DeepSeek Harness 实测对比：两侧都完成三项任务，MCP Lens 大幅减少模型可见工具、请求工具 JSON 和预估 API 成本" width="100%">
</p>

**为什么图中是 27，而不是 2？** 两侧都包含同样的 25 个非 MCP Harness 工具：直接客户端是 `25 + 1,000 = 1,025` 个完整工具，Lens 是 `25 + 2 = 27` 个。MCP 工具面本身是 **1,000 → 2**。

## 它具体解决什么问题

| 你的问题 | MCP Lens 带来的改变 |
|---|---|
| **MCP 工具越多，每轮 API 输入越大** | MCP 工具面初始只有 `mcp_search` 和 `mcp_call`。在三任务实测中，V4 Flash 预估费用降低 **88.702%**。 |
| **大段工具定义长期挤占上下文** | 同一个 1,000 工具 Server 下，Harness 完整请求中的工具 JSON 从 **674,249 B 降至 27,401 B**。 |
| **担心压缩工具面会牺牲任务完成率** | 在已测的客户、中文工单和 GitHub 任务中，Lens 与直接客户端都以正确参数和结果完成 **3/3**。 |
| **大量相似工具会扩大单次候选暴露面** | 先缩小模型一次看到的候选集合并返回准确 `inputSchema`，再按明确的 `server/tool` 身份调用。 |
| **没有用到的 Server 也消耗连接资源** | 连接按需建立；插件激活时不启动 MCP 进程，也不打开 MCP Socket。 |
| **一个 Server 故障不应该阻塞其他 Server** | 其他 Server 会继续工作；刷新失败时仍保留上一份可用目录。 |
| **危险工具应该默认不可见** | 远端工具只有匹配 `allowTools` 才会出现；`denyTools` 在搜索和调用中永远优先。 |

在 DeepSeek 实测中，MCP Lens 和官方直接客户端都完成了 **3/3 项任务**。Lens 会多一次搜索，并在这组样本中产生更多输出 Token，因此它针对的是大型、多 Server、长尾工具库，而不是每轮都会用到的几个固定工具。完整数据见[中文实测报告](docs/LIVE_DEEPSEEK_PILOT.zh-CN.md)。

Release 附件是预编译 tarball，不需要依赖构建权限。下面使用的 MCP 文档 Server 不需要额外 API Key；Harness 仍然需要你已经配置好的模型 Provider。

<details>
<summary>改为安装已审核的源码</summary>

如需改装已审核的 rc.9 源码 Tag：

```sh
dsh plugin --profile web add github:labmimors/dsh-mcp-lens#v0.1.0-rc.9
```

Git 安装会下载源码并运行 `prepare`。使用 pnpm 10+ 时，请在 `$DSH_HOME/profiles/web/pnpm-workspace.yaml`（默认 `~/.dsh/profiles/web/pnpm-workspace.yaml`）中加入准确包名，然后重新安装：

```yaml
allowBuilds:
  dsh-mcp-lens: true
```

授予构建权限前请先审查源码，并固定 Tag 或 Commit SHA。

</details>

## 连接第一个 MCP Server

插件默认不携带 Server，也不会开放任何远端工具。打开：

```text
$DSH_HOME/profiles/web/cordis.patch.yml
```

如果没有设置 `DSH_HOME`，默认路径是 `~/.dsh/profiles/web/cordis.patch.yml`。如果文件内容只有 `[]`，请用下面的配置块替换 `[]`；如果已经存在其他 `- id` 项，请把它追加为另一个顶层列表项。它会连接公开的[官方 MCP 文档 Server](https://modelcontextprotocol.io/mcp)，但只开放其中两个只读查询工具：

```yaml
- id: mcp-lens
  config:
    servers:
      - name: mcp-docs
        transport: streamable-http
        url: https://modelcontextprotocol.io/mcp

    cachePath: !!js dshHomePath('mcp-lens/catalog.json')
    allowTools:
      - mcp-docs/search_model_context_protocol
      - mcp-docs/query_docs_filesystem_model_context_protocol
    denyTools: ['mcp-docs/submit_feedback']
```

先检查最终组装的 Profile，再启动 Harness：

```sh
dsh --profile web --dump-config
dsh --profile web
```

现在像平时一样提问：

```text
使用官方 MCP 文档 Server，解释 MCP Client 应该在什么情况下使用 Streamable HTTP。
```

MCP Lens 会在内部完成两段式路由：

```text
你的请求
  → mcp_search("搜索 MCP 文档中的 Streamable HTTP")
  → mcp-docs/search_model_context_protocol 的准确输入 Schema
  → mcp_call("mcp-docs", "search_model_context_protocol", arguments)
  → 工具结果
```

正常使用时，你不需要在 Prompt 中提到 `mcp_search` 或 `mcp_call`。

<details>
<summary>带身份验证的 Streamable HTTP 示例</summary>

```yaml
- id: mcp-lens
  config:
    servers:
      - name: knowledge
        transport: streamable-http
        url: https://mcp.example.com/rpc
        headers:
          Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
        cacheNamespace: knowledge-acme-readonly

    cachePath: !!js dshHomePath('mcp-lens/catalog.json')
    allowTools: ['knowledge/read_*', 'knowledge/search_*']
    denyTools: ['*/delete_*', '*/destroy_*']
```

`cacheNamespace` 是某个租户和权限范围的非秘密身份。切换账户或权限范围时需要轮换它，绝不能把真实凭据写入其中。带凭据的 Server 如果没有设置它，Lens 只在内存保存该目录，并在重启后重新发现。

</details>

模式匹配准确的 `server/tool` 身份，只支持字面量和 `*`，并且 **deny 永远优先**。空的 `allowTools` 不允许任何工具。后续 Cordis Patch 会替换这一行的整个 `config`，因此需要保留的非默认字段都要写在覆盖层里。

## 什么时候应该用它

| 选择 | 最适合的情况 |
|---|---|
| 官方 `@deepseek-ai/dsh-mcp-client` | 只有几个稳定工具，而且大多数轮次都会使用；你希望路径最直接。 |
| MCP Lens | 有几十到几千个工具、多个 MCP Server、很多长尾能力，或上下文与 API 成本已经成为问题。 |

Lens 用首次使用时的一次搜索，换取接近恒定的常驻 MCP Schema 面。工具越多、单个工具使用频率越低，这个交换越划算。

**速度：**目前没有可以普遍承诺的延迟提升。首次未缓存使用会增加搜索和连接工作；大型工具库的较小请求可能抵消这部分开销，请以自己的工作负载实测。

### rc.9 改了什么

- 搜索只为每个 Lens 自有、深度冻结的可见目录构建一次分词与排序索引；相同冻结策略下的后续查询直接复用。目录刷新会产生新的 Snapshot 身份并重建索引；调用方持有的可变 Snapshot 永远不会进入身份缓存。
- edit-distance-one 拼写容错改为线性时间的准确单编辑检查，并在扫描 250,000 个名称／标题候选 Token 后 fail-closed，为唯一的词表扫描路径设置上限。
- 一次无标签重放在冻结的公开 Holdout B 输入上，对 102 个工具的 `304/304` 个 Prompt 全部复现 sealed rc.8 candidate 的 Ranking 与逐结果 Score。该重放没有读取私有标签、聚合 Score 输出或 Score Receipt；它证明排序一致，不是一次新的评测。
- 完整源码 Checkout 已通过 `98/98` 个自动化测试、类型检查与构建；精简 Runtime 包刻意不携带测试和 Benchmark Runner。

## 实测结果

### 冻结检索 Holdout

我们把 rc.8 排序器一次性评测在一个 **MCP-Atlas 衍生的便利 Holdout** 上；它不是 MCP-Atlas 官方 Benchmark。该集合包含 15 个真实 Server、102 份实际捕获的工具 Schema 和 304 个未触碰 Prompt。Prompt 排除了先前的 15 条开发集和 38 条 Holdout A；与本仓库 12 查询回归 Fixture 的准确文本交集为零。

| 指标 | 已发布 rc.7 排序器 | rc.8 candidate v3 | 差值 |
|---|---:|---:|---:|
| Recall@5 | 0.062610 | 0.246656 | +0.184046 |
| MRR | 0.119999 | 0.258684 | +0.138685 |
| nDCG@5 | 0.051830 | 0.204307 | +0.152477 |

rc.7 的 Runtime 排序器与评测所用 rc.6 Runtime Baseline 逐字节相同。Recall@5 差值在 100,000 次 paired bootstrap 下的 95% CI 为 `[0.144846, 0.224342]`，逐 Prompt 胜／平／负为 `99/197/8`。rc.9 的搜索索引改动在不读取私有标签、聚合 Score 输出或 Score Receipt 的前提下，复现了冻结 Candidate 在 `304/304` 个 Prompt 上的公开 Ranking 与逐结果 Score。这个结果只覆盖 **covered-call 词法检索**，不测量端到端任务完成、Token、费用、延迟、语义检索或通用产品质量。方法、边界和工件摘要见[中文检索评测报告](https://github.com/labmimors/dsh-mcp-lens/blob/v0.1.0-rc.9/docs/RETRIEVAL_EVALUATION.zh-CN.md)。

### DeepSeek V4 Flash 真模型实测

同一个 DeepSeek Harness `0.1.0-rc.6`、同一个 1,000 工具 stdio Server、同样三项客户／工单／GitHub 任务：

| 三项任务合计 | 官方直接客户端 | MCP Lens | 差异 |
|---|---:|---:|---:|
| 完成任务 | 3 / 3 | 3 / 3 | 相同 |
| 每次请求中模型可见工具 | 1,025 | 27 | 减少 97.366% |
| `request/header.tools` JSON | 674,249 B | 27,401 B | 减少 95.936% |
| 非缓存输入 Token | 199,751 | 21,713 | 减少 89.130% |
| 缓存命中输入 Token | 934,912 | 74,496 | 减少 92.032% |
| 预估 API 费用 | $0.0307204 | $0.0034707 | 降低 88.702% |

费用根据 Provider 返回的 Usage，并按 2026 年 8 月 14 日抓取的 [DeepSeek V4 Flash 官方价格](https://api-docs.deepseek.com/quick_start/pricing/)估算。该价格页同时注明会在 2026 年 8 月 16 日 16:00 UTC 切换到峰谷计费，所以后续比较应基于记录的 Usage 重新计算。三项任务、实际调用、计算公式和取舍都记录在 [`docs/LIVE_DEEPSEEK_PILOT.zh-CN.md`](docs/LIVE_DEEPSEEK_PILOT.zh-CN.md)。

### 无需 API Key 的组件 Benchmark

仓库内的 Benchmark 使用真实 Harness `Context`、`SystemPrompt` 和 `ToolRuntime`，以官方直接客户端为基线，两侧连接同一个本地 MCP Fixture：

| 远端 MCP 工具 | 直接客户端 Schema JSON | Lens Schema JSON | 降幅 |
|---:|---:|---:|---:|
| 12 | 4,862 B | 1,114 B | 77.088% |
| 100 | 62,062 B | 1,114 B | 98.205% |
| 1,000 | 647,962 B | 1,114 B | 99.828% |

在 1,000 工具规模下，官方客户端注册 1,000 个远端 Schema，Lens 仍然只注册两个。在固定的 12 查询检索 Fixture 上，Lens 的 Recall@1 / Recall@5 / MRR 为 `1.0 / 1.0 / 1.0`。该 Fixture 由本仓库编写，因此只能作为回归保护，不能视为真实场景检索质量的独立证据。

在完整源码 Checkout 中，无需 API Key 即可复现组件结果：

```sh
npm ci
npm run verify
npm run bench -- --output benchmark.json
```

这些命令只面向完整源码 Checkout。精简的预编译 Runtime 包会刻意排除 `scripts/`、测试、Benchmark 源码与构建配置；解包 `.tgz` 后运行 `npm run verify` 或 `npm run bench` 不属于支持契约。准确指标、Fixture、依赖版本、源码摘要和测量限制见 [`benchmark/README.md`](https://github.com/labmimors/dsh-mcp-lens/blob/v0.1.0-rc.9/benchmark/README.md)。

## 在 CI 里阻止 Schema 失控增长

零依赖的 **MCP Lens Schema Audit** GitHub Action 会在 Runner 内测量导出的模型可见工具载荷。它不发网络请求，除数字指标外只输出不含 Schema 的 `share-url` / `share-markdown`，也不会把工具名称、描述或 Schema 复制到 Step Summary。配置预算后，意外扩大的工具面会直接让检查失败。

支持的 JSON 形式包括工具数组、`{ "tools": [...] }`、`{ "schemas": [...] }`、`{ "header": { "tools": [...] } }`，以及记录的 `{ "request": { "header": { "tools": [...] } } }`。

```yaml
name: MCP schema budget
on: [pull_request]

permissions:
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
      - uses: labmimors/dsh-mcp-lens@f21169f921e7ed032a4db5062685afb6f948c2d1
        with:
          tools-file: artifacts/request-header.json
          max-tools: 100
          max-schema-bytes: 65536
```

Action 接受最大 64 MiB 的文件，把输入限制在 `GITHUB_WORKSPACE` 内，并拒绝符号链接越界。这里测量的是标准 `JSON.stringify(tools)` 的 UTF-8 字节，不是 Token、账单、延迟或任务质量。

## 稳定性与资源控制

- **默认懒加载：**插件激活时没有 MCP 进程或 Socket；空闲连接会自动关闭。
- **故障隔离：**每个 Server 独立刷新目录；一个 Server 失败不会遮蔽其他健康结果。
- **last-good：**超时、异常或超限的发现结果不会替换可用目录。
- **冻结搜索索引：**重复查询复用每个不可变可见目录世代的分词索引；刷新通过新的 Snapshot 身份使旧索引失效。
- **输入有上限：**分页、工具数量、单工具字节、目录总字节、游标和流式 HTTP 响应都有时限或容量限制。
- **凭据感知缓存：**权限为 `0600` 的缓存只保存投影后的工具元数据，不保存显式 env/header 值或 URL 凭据。
- **准确策略：**搜索和调用在最终 `server/tool` 身份上使用同一个 allow/deny 判定。
- **完整退出：**取消、HMR 和 Dispose 会关闭 Transport、子进程、Timer 与进行中的工作。

MCP Lens 不是沙箱：stdio Server 仍会在宿主机执行，HTTP Server 仍会收到你配置的 Header。当前版本只桥接 MCP Tools，不支持 OAuth、Resources、Prompts、Elicitation 或基于 Task 的工具执行。

## 配置参考

大多数用户只需设置 `servers`、`cachePath`、`allowTools` 和 `denyTools`。其他字段已有受限默认值：

<details>
<summary>展开全部受限默认值</summary>

| 字段 | 默认值 | 作用 |
|---|---:|---|
| `catalogTtlMs` | `86400000` | 24 小时后刷新目录 |
| `idleDisconnectMs` | `300000` | 空闲 5 分钟后断开 Server |
| `connectTimeoutMs` | `30000` | 连接时限 |
| `callTimeoutMs` | `60000` | 工具调用时限 |
| `discoveryTimeoutMs` | `30000` | 完整分页发现时限 |
| `maxDiscoveryPages` | `1000` | 单次发现的最大页数 |
| `maxToolsPerServer` | `10000` | 单个 Server 的最大工具数 |
| `maxBytesPerTool` | `1048576` | 单工具投影元数据最大字节 |
| `maxTotalCatalogBytes` | `67108864` | 目录／缓存总字节上限 |
| `maxHttpResponseBytes` | `16777216` | 流式 HTTP 响应字节上限 |
| `maxCursorBytes` | `4096` | 分页游标最大 UTF-8 字节 |
| `searchLimitDefault` | `5` | 默认搜索结果数 |
| `searchLimitMax` | `10` | 最大搜索结果数 |

规范默认值以插件附带的 [`cordis.patch.yml`](cordis.patch.yml) 为准。

</details>

## 安全、开发与社区

- 如果 Lens 对你的工具库确实有用，请[为仓库加 Star](https://github.com/labmimors/dsh-mcp-lens)，并[参与目录挑战](https://github.com/labmimors/dsh-mcp-lens/discussions/11)；脱敏后的真实工作负载能帮助下一位用户判断。
- 如果你想先看一个可复现的前后对比，可以用[本地目录测量页](https://labmimors.github.io/dsh-mcp-lens/)粘贴当前工具面，直接算出准确 UTF-8 bytes，并导出可分享卡片；全程不上传 Schema。
- 最终用户条款：[`EULA.md`](EULA.md)。
- 隐私与数据边界：[`PRIVACY.md`](PRIVACY.md)。
- 支持渠道与响应目标：[`SUPPORT.md`](SUPPORT.md)。
- 安全问题：阅读 [`SECURITY.md`](SECURITY.md)，不要在公开 Issue 中披露未修复漏洞。
- 参与贡献：阅读 [`CONTRIBUTING.md`](https://github.com/labmimors/dsh-mcp-lens/blob/v0.1.0-rc.9/CONTRIBUTING.md)。
- 搜索质量：[提交脱敏后的搜索 Miss](https://github.com/labmimors/dsh-mcp-lens/issues/new?template=search_miss.yml)，帮助把真实失败转成回归 Fixture。
- Release Candidate：[`v0.1.0-rc.9`](https://github.com/labmimors/dsh-mcp-lens/releases/tag/v0.1.0-rc.9)。

DeepSeek Harness 当前通过带有 [`dsh-plugin`](https://github.com/topics/dsh-plugin) Topic 的公开 GitHub 仓库发现社区插件，并支持从 GitHub、tarball 或 npm 包安装。详见官方[插件发布教程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)。

MCP Lens 是采用 MIT License 的独立社区插件，与 DeepSeek AI 无隶属关系，也不代表其官方背书。
