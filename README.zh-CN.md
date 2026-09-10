# DeepSeek Harness 的 MCP Lens

[English](README.md) | 简体中文

[![verify](https://github.com/labmimors/dsh-mcp-lens/actions/workflows/verify.yml/badge.svg)](https://github.com/labmimors/dsh-mcp-lens/actions/workflows/verify.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**先搜索大型 MCP 工具库，再调用需要的工具。**

MCP Lens 为 DeepSeek Harness 提供两个模型可见工具：

1. `mcp_search` 搜索相关工具，返回它们的准确输入 Schema。
2. `mcp_call` 按明确的 `server/tool` 调用工具，返回结果及其中的结构化数据。

这两个工具定义的 JSON 合计 **1,114 字节**，不会随工具库增大。远端工具的 Schema 随搜索结果进入对话。连接按需建立，重复搜索会复用目录索引。

它适合分布在多个 MCP Server 上的几十到几千个工具。搜索会多一步；如果只有几个工具，而且几乎每次请求都要用，官方直接客户端更简单。

<a id="install"></a>

## 安装

使用 Node.js `^22.19.0 || >=24.0.0` 和 Harness `0.1.2-rc.1`。截至 2026 年 9 月 10 日，Harness 的 npm `latest` 和 `next` 都指向这个版本。

Lens rc.10 可从下面的源码分支安装。npm 上已发布的仍是适用于 Harness `0.1.0-rc.6` 的 rc.9。

```sh
npm install -g @deepseek-ai/dsh@0.1.2-rc.1
git clone --branch fix/dsh-rc2-compat https://github.com/labmimors/dsh-mcp-lens.git
cd dsh-mcp-lens
npm ci --ignore-scripts
npm run build
npm pack --ignore-scripts
dsh plugin --profile web add ./dsh-mcp-lens-0.1.0-rc.10.tgz
```

`dsh plugin` 使用 pnpm 安装。如果 `PATH` 中没有 `pnpm`，将最后一条命令替换为：

```sh
npm exec --yes --package=pnpm@10.20.0 -- dsh plugin --profile web add ./dsh-mcp-lens-0.1.0-rc.10.tgz
```

如果继续使用已有的 Harness `0.1.0-rc.6`，请运行 `dsh plugin --profile web add dsh-mcp-lens@0.1.0-rc.9`。

## 连接第一个 MCP Server

插件初始没有配置 Server。打开 `~/.dsh/profiles/web/cordis.patch.yml`；如果设置了 `DSH_HOME`，则打开 `$DSH_HOME/profiles/web/cordis.patch.yml`。

文件内容为空数组 `[]` 时，用下面的配置替换。有其他配置项时，将它追加为顶层列表项；已有 `mcp-lens` 项时，替换该项的 `config`。

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

这会连接[官方 MCP 文档 Server](https://modelcontextprotocol.io/mcp)，开放其中两个只读查询工具。这个 Server 不需要 API Key；Harness 使用你已配置的模型服务。

检查配置，然后启动 Harness：

```sh
dsh --profile web --dump-config
dsh --profile web
```

接着提问：

```text
使用官方 MCP 文档 Server，解释 MCP Client 应该在什么情况下使用 Streamable HTTP。
```

正常提问即可，模型会按需使用 `mcp_search` 和 `mcp_call`。

## 配置

设置 `servers`、`cachePath`，并把需要的工具放入 `allowTools`。模式匹配 `server/tool`，用 `*` 表示通配符。`denyTools` 优先于 `allowTools`；允许列表为空时，不开放工具。

每条 Cordis Patch 都会替换该项的整个 `config`，因此需要保留的自定义设置应一起写入。

<details>
<summary>本地 stdio Server</summary>

```yaml
- id: mcp-lens
  config:
    servers:
      - name: local
        transport: stdio
        command: node
        args: ['/absolute/path/to/mcp-server.mjs']
        cwd: /absolute/path/to/project

    cachePath: !!js dshHomePath('mcp-lens/catalog.json')
    allowTools: ['local/search_*', 'local/read_*']
    denyTools: ['local/delete_*']
```

将命令、路径和工具匹配模式替换为你的 MCP Server 对应设置。

</details>

<details>
<summary>需要身份验证的 HTTP Server</summary>

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

`cacheNamespace` 用于标识账户和权限范围，不包含凭据本身。切换账户或权限时一起修改。未设置这个字段时，带身份验证的 Server 目录只保存在内存中，重启后会重新获取。

</details>

<details>
<summary>超时、搜索数量和目录设置</summary>

| 字段 | 默认值 | 用途 |
|---|---:|---|
| `catalogTtlMs` | `86400000` | 24 小时后刷新目录 |
| `idleDisconnectMs` | `300000` | 空闲 5 分钟后关闭连接 |
| `connectTimeoutMs` | `30000` | 连接超时 |
| `callTimeoutMs` | `60000` | 工具调用超时 |
| `discoveryTimeoutMs` | `30000` | 完整目录发现超时 |
| `maxDiscoveryPages` | `1000` | 每次发现的最大页数 |
| `maxToolsPerServer` | `10000` | 每个 Server 的最大工具数 |
| `maxBytesPerTool` | `1048576` | 每个工具的元数据字节上限 |
| `maxTotalCatalogBytes` | `67108864` | 目录与缓存总字节上限 |
| `maxHttpResponseBytes` | `16777216` | HTTP 响应字节上限 |
| `maxCursorBytes` | `4096` | 分页游标字节上限 |
| `searchLimitDefault` | `5` | 默认搜索结果数 |
| `searchLimitMax` | `10` | 最大搜索结果数 |

默认值也可查看 [cordis.patch.yml](cordis.patch.yml)。

</details>

刷新失败时保留上一份可用目录，单个 Server 不可用也不会隐藏其他 Server 的结果。Lens 支持通过 stdio 和 Streamable HTTP 使用 MCP Tools。目前尚未实现 OAuth、Resources、Prompts、Elicitation 和基于 Task 的执行。

## 最新测试

最新改动让模型能看到结构化结果，包括后续调用需要的标识符。

| 测试 | 结果 |
|---|---|
| 自动化测试 | 175 项通过 |
| 16 个合成工具上的三项 Codex 模型任务 | Lens 3/3；官方直接客户端 2/3 |
| 16 和 1,000 工具目录上的数据流程 | 修复后 12/12；修复前 10/12 |
| Lens 工具定义 | 2 个 Schema，1,114 B |

模型任务在 Codex 中运行，通过真实 Harness `ToolRuntime` 和 MCP Server 调用工具。任务、结果和复现命令见[产品测试](docs/PRODUCT_TESTS.zh-CN.md)。

早期实验：[2026 年 8 月 14 日 DeepSeek V4 Flash 实测](docs/LIVE_DEEPSEEK_PILOT.zh-CN.md)。

## 开发

在源码目录中运行：

```sh
npm ci
npm run verify
npm run bench -- --output benchmark.json
npm run verify:dsh-install
npm run verify:dsh-profile
```

`verify` 包含类型检查、测试和构建。安装检查使用本地 MCP 测试 Server 和临时 Harness Profile。如果没有 Corepack，可通过 `npm exec --yes --package=corepack@0.35.0 -- npm run verify:dsh-profile` 运行 Profile 检查。

准确的 Harness 版本、测试命令和 Schema 大小 GitHub Action 见[贡献指南](CONTRIBUTING.md)。

[Schema 计算器](https://labmimors.github.io/dsh-mcp-lens/) · [支持](SUPPORT.md) · [安全](SECURITY.md) · [MIT 许可证](LICENSE)
