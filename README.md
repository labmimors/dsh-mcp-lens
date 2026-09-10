# MCP Lens for DeepSeek Harness

English | [简体中文](README.zh-CN.md)

[![verify](https://github.com/labmimors/dsh-mcp-lens/actions/workflows/verify.yml/badge.svg)](https://github.com/labmimors/dsh-mcp-lens/actions/workflows/verify.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Search a large MCP catalog, then call the tool you need.**

MCP Lens gives DeepSeek Harness two model-facing tools:

1. `mcp_search` finds relevant tools and returns their exact input schemas.
2. `mcp_call` calls a specific `server/tool` and returns its result, including structured data.

The two tool definitions occupy **1,114 bytes of JSON**, regardless of catalog size. Remote schemas enter the conversation when search returns them. Connections open on demand, and repeated searches reuse the catalog index.

This works well for dozens to thousands of tools spread across MCP servers. Search adds a step; for a few tools used on nearly every request, the official direct MCP client is simpler.

<a id="install"></a>

## Install

Use Node.js `^22.19.0 || >=24.0.0` and Harness `0.1.2-rc.1`. As of September 10, 2026, Harness's npm `latest` and `next` tags point to this version.

Lens rc.10 is available from the source branch below. The published npm package is still rc.9, which targets Harness `0.1.0-rc.6`.

```sh
npm install -g @deepseek-ai/dsh@0.1.2-rc.1
git clone --branch fix/dsh-rc2-compat https://github.com/labmimors/dsh-mcp-lens.git
cd dsh-mcp-lens
npm ci --ignore-scripts
npm run build
npm pack --ignore-scripts
dsh plugin --profile web add ./dsh-mcp-lens-0.1.0-rc.10.tgz
```

`dsh plugin` uses pnpm. If `pnpm` is missing from `PATH`, replace the last command with:

```sh
npm exec --yes --package=pnpm@10.20.0 -- dsh plugin --profile web add ./dsh-mcp-lens-0.1.0-rc.10.tgz
```

If you are keeping an existing Harness `0.1.0-rc.6` installation, use `dsh plugin --profile web add dsh-mcp-lens@0.1.0-rc.9`.

## Connect your first MCP server

The plugin starts with no servers. Open `~/.dsh/profiles/web/cordis.patch.yml`, or `$DSH_HOME/profiles/web/cordis.patch.yml` if you set `DSH_HOME`.

Replace an empty `[]` with this block. If the file already has other entries, append it as another top-level item; if it already has an `mcp-lens` item, replace that item's `config`.

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

This connects the [official MCP documentation server](https://modelcontextprotocol.io/mcp) and enables its two read-only query tools. The server needs no API key; Harness uses the model provider you have configured.

Check the configuration and start Harness:

```sh
dsh --profile web --dump-config
dsh --profile web
```

Then ask:

```text
Use the official MCP documentation server to explain when an MCP client should use Streamable HTTP.
```

Ask normal questions. The model uses `mcp_search` and `mcp_call` as needed.

## Configuration

Set `servers`, `cachePath`, and the tools you want in `allowTools`. Patterns match `server/tool`, with `*` as a wildcard. `denyTools` overrides `allowTools`; an empty allow list enables no tools.

Each Cordis patch replaces the item's whole `config`, so include all custom settings you want to keep.

<details>
<summary>Local stdio server</summary>

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

Replace the command, paths, and tool patterns with those of your MCP server.

</details>

<details>
<summary>Authenticated HTTP server</summary>

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

`cacheNamespace` identifies the account and permission scope, without containing a credential. Change it when the account or scope changes. Without it, an authenticated server's catalog stays in memory and is fetched again after restart.

</details>

<details>
<summary>Timeouts, search limits, and catalog settings</summary>

| Field | Default | Purpose |
|---|---:|---|
| `catalogTtlMs` | `86400000` | Refresh a catalog after 24 hours |
| `idleDisconnectMs` | `300000` | Close an idle connection after 5 minutes |
| `connectTimeoutMs` | `30000` | Connection timeout |
| `callTimeoutMs` | `60000` | Tool-call timeout |
| `discoveryTimeoutMs` | `30000` | Timeout for the full catalog discovery |
| `maxDiscoveryPages` | `1000` | Pages per discovery |
| `maxToolsPerServer` | `10000` | Tools per server |
| `maxBytesPerTool` | `1048576` | Metadata bytes per tool |
| `maxTotalCatalogBytes` | `67108864` | Total catalog/cache bytes |
| `maxHttpResponseBytes` | `16777216` | HTTP response bytes |
| `maxCursorBytes` | `4096` | Pagination cursor bytes |
| `searchLimitDefault` | `5` | Default search results |
| `searchLimitMax` | `10` | Maximum search results |

The defaults are also in [cordis.patch.yml](cordis.patch.yml).

</details>

A failed refresh keeps the previous usable catalog, and one unavailable server does not hide results from other servers. Lens supports MCP Tools over stdio and Streamable HTTP. OAuth, Resources, Prompts, Elicitation, and task-based execution are not currently implemented.

## Latest tests

The latest change makes structured results visible to the model, including identifiers needed by later calls.

| Test | Result |
|---|---|
| Automated tests | 175 passed |
| Three Codex model tasks with 16 synthetic tools | Lens 3/3; official direct client 2/3 |
| Data workflows across 16- and 1,000-tool catalogs | 12/12 after the fix; 10/12 before |
| Lens tool definitions | 2 schemas, 1,114 B |

The model tasks ran in Codex through real Harness `ToolRuntime` and MCP servers. See [Product tests](docs/PRODUCT_TESTS.md) for the tasks, results, and reproduction commands.

Earlier experiment: [DeepSeek V4 Flash pilot, August 14, 2026](docs/LIVE_DEEPSEEK_PILOT.md).

## Development

Run these commands from the source checkout:

```sh
npm ci
npm run verify
npm run bench -- --output benchmark.json
npm run verify:dsh-install
npm run verify:dsh-profile
```

`verify` runs type checking, tests, and the build. The install checks use local MCP fixtures and temporary Harness profiles. If Corepack is unavailable, run the profile check through `npm exec --yes --package=corepack@0.35.0 -- npm run verify:dsh-profile`.

See [Contributing](CONTRIBUTING.md) for exact Harness versions, test commands, and the schema-size GitHub Action.

[Schema calculator](https://labmimors.github.io/dsh-mcp-lens/) · [Support](SUPPORT.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
