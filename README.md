# MCP Lens for DeepSeek Harness

English | [简体中文](README.zh-CN.md)

[Website](https://deepseek-harness-mcp-lens.charmingkla.chatgpt.site) · [Local schema calculator](https://labmimors.github.io/dsh-mcp-lens/) · [Install rc.9](#install)

[![verify](https://github.com/labmimors/dsh-mcp-lens/actions/workflows/verify.yml/badge.svg)](https://github.com/labmimors/dsh-mcp-lens/actions/workflows/verify.yml)
[![release](https://img.shields.io/github/v/release/labmimors/dsh-mcp-lens?include_prereleases)](https://github.com/labmimors/dsh-mcp-lens/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-developer%20preview-5B5BD6)](https://github.com/deepseek-ai/deepseek-harness)

**Shrink large MCP catalogs to a two-tool model surface.**

MCP Lens lets DeepSeek Harness search and call 1,000 remote tools through two stable model-facing interfaces. Instead of sending every tool schema on every turn, it reveals exact schemas only for a small ranked set when a tool is actually needed.

If this keeps a large MCP catalog manageable for you, [star the repository](https://github.com/labmimors/dsh-mcp-lens) so more DeepSeek Harness users can find it.

Why users install it:

- Spend less on input-heavy turns: in the dated three-task pilot, estimated DeepSeek V4 Flash cost fell from `$0.0307204` to `$0.0034707`.
- Keep more room for the real task: the same pilot reduced `request/header.tools` JSON from `674,249 B` to `27,401 B`.
- Retrieve more relevant covered calls: on a frozen MCP-Atlas-derived convenience holdout, Recall@5 rose from `0.062610` to `0.246656` across 304 untouched prompts. This is lexical retrieval evidence, not an official MCP-Atlas or end-to-end score.
- Avoid rebuilding the same search index on every query: rc.9 reuses the tokenized index for each Lens-owned frozen catalog and policy generation, then invalidates it when the catalog changes.
- Narrow the tool-choice surface: search reveals only a small ranked set of exact schemas, and the final `server/tool` is still gated by `allowTools` and `denyTools`.
- Preserve completion in the tested pilot: both arms completed `3/3` tasks, while Lens used one extra search step.

Use MCP Lens if you have dozens to thousands of MCP tools, multiple servers, or long-tail tools that are expensive to advertise on every turn. Skip it if you have only a handful of tools that are used almost every request.

<a id="install"></a>

## Install rc.9

Prerequisites: DeepSeek Harness `0.1.0-rc.6`, Node.js `^22.19.0` or `>=24.0.0`, and `pnpm` on `PATH`. The `dsh plugin` command delegates installation to pnpm.

Fastest install:

```sh
dsh plugin --profile web add dsh-mcp-lens@next
```

For a reproducible install, pin the reviewed version:

```sh
dsh plugin --profile web add dsh-mcp-lens@0.1.0-rc.9
```

The npm `next` tag currently resolves to `0.1.0-rc.9`. The registry tarball was downloaded after publication and verified byte-for-byte against the reviewed GitHub rc.9 asset (`SHA-256 a8e4bf8389d0107379c13c845feb3c7c0c26d4aa3312391640e1fed074d39dbc`), then installed in a fresh DeepSeek Harness rc.6 profile.

<details>
<summary>Verify and install the GitHub Release tarball instead</summary>

The rc.9 Release page lists the `.tgz` asset and its SHA-256 digest. Download the file, compare its digest with the value shown for that exact Release asset, and only then install the local file into your Harness profile. Passing a redirected GitHub asset URL directly to pnpm can fail with `ERR_PNPM_MISSING_TARBALL_INTEGRITY` on some pnpm versions.

```sh
curl -fL --retry 3 -o dsh-mcp-lens-0.1.0-rc.9.tgz \
  https://github.com/labmimors/dsh-mcp-lens/releases/download/v0.1.0-rc.9/dsh-mcp-lens-0.1.0-rc.9.tgz
shasum -a 256 dsh-mcp-lens-0.1.0-rc.9.tgz
# Compare the output with the SHA-256 shown for the .tgz on the rc.9 Release page.
dsh plugin --profile web add ./dsh-mcp-lens-0.1.0-rc.9.tgz
```

On Windows, download the same asset from the [rc.9 Release page](https://github.com/labmimors/dsh-mcp-lens/releases/tag/v0.1.0-rc.9), compare `Get-FileHash -Algorithm SHA256` with the digest shown for that asset, and pass its local path to `dsh plugin add` only if they match.

</details>

To make the plugin useful, continue with [Connect your first MCP server](#connect-your-first-mcp-server); its copy-paste block adds both a server and the exact tools you want to allow. Then validate and start the profile:

```sh
dsh --profile web --dump-config
dsh --profile web
```

After that, prompt Harness normally. You do not need to mention `mcp_search` or `mcp_call` in your prompt.

Try the [local-only catalog calculator](https://labmimors.github.io/dsh-mcp-lens/) to measure your current tool-schema bytes, then copy a schema-free share link or Markdown result. Shared results are always labeled **self-reported local measurements** and encode only bounded numeric fields—not tool names, descriptions, or schemas. The numeric check catches accidental edits; it is not a signature or proof that a measurement occurred. Prefer a repeatable CI guard? Use the [schema budget Action](#keep-schema-drift-out-of-ci) to fail a workflow when tool count or schema bytes drift above your limit.

Need the same measurement in CI? This repository also ships a dependency-free GitHub Action that audits a checked-in tool payload and reports the model-facing tool count, canonical schema bytes, and byte reduction versus the fixed two-tool Lens surface.

```yaml
- uses: labmimors/dsh-mcp-lens@v0.1.0-rc.7
  with:
    tools-file: fixtures/request-header-tools.json
```

For an immutable production reference, pin the reviewed rc.7 commit: `f21169f921e7ed032a4db5062685afb6f948c2d1`.

<p align="center">
  <img src="assets/mcp-lens-comparison.svg" alt="Live DeepSeek Harness comparison: MCP Lens reduced model-visible tools, request tool JSON, and estimated API cost while both arms completed three of three tasks" width="100%">
</p>

**Why does the chart show 27 instead of 2?** Both arms include the same 25 non-MCP Harness tools: the direct client exposes `25 + 1,000 = 1,025` total tools; Lens exposes `25 + 2 = 27`. The MCP surface itself is **1,000 → 2**.

## What it solves

| Your problem | What MCP Lens changes |
|---|---|
| **API input grows with every MCP tool** | The MCP surface always starts with only `mcp_search` and `mcp_call`. In our live three-task pilot, estimated V4 Flash cost fell **88.702%**. |
| **Large tool lists consume standing context** | With the same 1,000-tool server, complete Harness request-tool JSON fell from **674,249 B to 27,401 B**. |
| **You worry routing will reduce task completion** | In the tested customer, Chinese-ticket, and GitHub tasks, Lens and the direct client both completed **3/3** with correct arguments and results. |
| **Many similar tools widen the choice set** | Search narrows what the model sees at once, returns exact `inputSchema` values, and calls an explicit `server/tool` identity. |
| **Every server connects even when unused** | Connections are lazy. Activation starts no MCP process and opens no MCP socket. |
| **One server outage should not block the rest** | Other servers keep working, and Lens keeps the previous usable catalog when a refresh fails. |
| **Risky tools should be hidden by default** | No remote tool appears until it matches `allowTools`; `denyTools` always wins in search and calls. |

In the live pilot, MCP Lens and the official direct client both completed **3/3 tasks**. Lens used one extra search step and more output tokens, so it is designed for large, multi-server, or long-tail catalogs, not a handful of tools used on every turn. See the [full pilot report](docs/LIVE_DEEPSEEK_PILOT.md).

The Release asset is a prebuilt tarball, so it needs no dependency build permission. The MCP documentation server used below requires no additional API key; Harness still needs your configured model provider.

<details>
<summary>Install reviewed source instead</summary>

To install the reviewed rc.9 source tag instead:

```sh
dsh plugin --profile web add github:labmimors/dsh-mcp-lens#v0.1.0-rc.9
```

Git installs fetch source and run `prepare`. With pnpm 10+, add this exact package key to `$DSH_HOME/profiles/web/pnpm-workspace.yaml` (default `~/.dsh/profiles/web/pnpm-workspace.yaml`), then rerun the command:

```yaml
allowBuilds:
  dsh-mcp-lens: true
```

Review the source and pin a tag or commit SHA before granting build permission.

</details>

## Connect your first MCP server

The plugin ships with no servers and allows no remote tools until you opt in. Open:

```text
$DSH_HOME/profiles/web/cordis.patch.yml
```

If `DSH_HOME` is unset, the default path is `~/.dsh/profiles/web/cordis.patch.yml`. If the file contains only `[]`, replace `[]` with the block below. If it already contains `- id` entries, append this as another top-level list item. It connects the public [official MCP documentation server](https://modelcontextprotocol.io/mcp) but exposes only its two read-only query tools:

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

Verify the assembled profile, then start Harness:

```sh
dsh --profile web --dump-config
dsh --profile web
```

Now ask a normal question:

```text
Use the official MCP documentation server to explain when an MCP client should use Streamable HTTP.
```

MCP Lens handles the two-step routing internally:

```text
your request
  → mcp_search("search MCP documentation for Streamable HTTP")
  → exact mcp-docs/search_model_context_protocol input schema
  → mcp_call("mcp-docs", "search_model_context_protocol", arguments)
  → tool result
```

You do not have to mention `mcp_search` or `mcp_call` in normal prompts.

<details>
<summary>Authenticated Streamable HTTP example</summary>

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

`cacheNamespace` is a non-secret identity for one tenant and permission scope. Rotate it when the account or scope changes. Never put the credential itself in this field. If a credentialed server omits it, Lens keeps that catalog memory-only and rediscovers it after restart.

</details>

Patterns match the exact `server/tool` identity, support literals plus `*`, and apply with **deny winning**. An empty `allowTools` list allows nothing. A later Cordis patch replaces this row's whole `config`, so include every non-default field you want to keep.

## Is MCP Lens right for you?

| Choose | When it fits best |
|---|---|
| Official `@deepseek-ai/dsh-mcp-client` | You have a few stable tools that are used on most turns and want the simplest direct path. |
| MCP Lens | You have dozens to thousands of tools, several MCP servers, long-tail capabilities, or repeated context/cost pressure. |

Lens trades a search step on first use for a nearly constant standing MCP schema surface. The larger and less frequently used your catalog is, the stronger that trade becomes.

**Speed:** there is no universal latency win to claim. The first uncached use adds search and connection work; smaller requests may offset that cost on large catalogs, so measure your own workload.

### What rc.9 changes

- Search tokenizes and sorts each Lens-owned, deeply frozen visible catalog once, then reuses that in-memory index for repeated queries under the same frozen policy. A refresh creates a new snapshot identity and therefore a new index; caller-owned mutable snapshots are never identity-cached.
- The one-edit typo fallback now uses a linear-time exactly-one-edit check and fails closed after 250,000 name/title candidate tokens, bounding its only vocabulary-scan route.
- A label-free replay against the frozen public Holdout B inputs matched the sealed rc.8 candidate rankings and per-result scores for all `304/304` prompts over 102 tools. That replay read no private labels, aggregate score output, or score receipt; it verifies ranking parity, not a new evaluation result.
- The full source checkout passes `98/98` automated tests, typechecking, and build. The compact runtime package intentionally excludes the test and benchmark runners.

## Measured results

### Frozen retrieval holdout

We evaluated the rc.8 ranker once on an **MCP-Atlas-derived convenience holdout**, not the official MCP-Atlas benchmark. It contains 15 real servers, 102 captured tool schemas, and 304 untouched prompts. The prompts exclude the earlier 15-query development set and 38-query holdout A; their exact-text overlap with this repository's 12-query regression fixture is zero.

| Metric | Released rc.7 ranker | rc.8 candidate v3 | Difference |
|---|---:|---:|---:|
| Recall@5 | 0.062610 | 0.246656 | +0.184046 |
| MRR | 0.119999 | 0.258684 | +0.138685 |
| nDCG@5 | 0.051830 | 0.204307 | +0.152477 |

The rc.7 runtime ranker is byte-identical to the rc.6 runtime baseline used by the evaluator. The Recall@5 difference has a 100,000-replicate paired-bootstrap 95% CI of `[0.144846, 0.224342]`; prompt-level wins/ties/losses are `99/197/8`. The rc.9 search-index change reproduced the frozen candidate's public rankings and per-result scores for `304/304` prompts without reading private labels, aggregate score output, or score receipt. This result covers **covered-call lexical retrieval only**. It does not measure end-to-end task completion, tokens, cost, latency, semantic retrieval, or general product quality. See the [method, boundaries, and artifact commitments](https://github.com/labmimors/dsh-mcp-lens/blob/v0.1.0-rc.9/docs/RETRIEVAL_EVALUATION.md).

### Live DeepSeek V4 Flash pilot

Same DeepSeek Harness `0.1.0-rc.6`, same 1,000-tool stdio server, and the same three customer/ticket/GitHub tasks:

| Metric across three tasks | Official direct client | MCP Lens | Difference |
|---|---:|---:|---:|
| Completed tasks | 3 / 3 | 3 / 3 | Tie |
| Model-visible tools per request | 1,025 | 27 | 97.366% fewer |
| `request/header.tools` JSON | 674,249 B | 27,401 B | 95.936% smaller |
| Uncached input tokens | 199,751 | 21,713 | 89.130% fewer |
| Cache-read input tokens | 934,912 | 74,496 | 92.032% fewer |
| Estimated API cost | $0.0307204 | $0.0034707 | 88.702% lower |

The cost estimate multiplies provider-reported usage by the [official DeepSeek V4 Flash pricing](https://api-docs.deepseek.com/quick_start/pricing/) retrieved on August 14, 2026. That pricing page also announces a new peak/off-peak schedule effective at 16:00 UTC on August 16, 2026, so later comparisons should recompute from the recorded usage. The three-task setup, observed calls, formula, and tradeoffs are recorded in [`docs/LIVE_DEEPSEEK_PILOT.md`](docs/LIVE_DEEPSEEK_PILOT.md).

### Keyless component benchmark

The checked-in benchmark uses a real Harness `Context`, `SystemPrompt`, and `ToolRuntime`, the official direct client as baseline, and the same local MCP fixture for both arms:

| Remote MCP tools | Direct-client schema JSON | Lens schema JSON | Reduction |
|---:|---:|---:|---:|
| 12 | 4,862 B | 1,114 B | 77.088% |
| 100 | 62,062 B | 1,114 B | 98.205% |
| 1,000 | 647,962 B | 1,114 B | 99.828% |

At 1,000 tools, the official client registers 1,000 remote schemas while Lens still registers two. On the frozen 12-query retrieval fixture, Lens measured Recall@1 / Recall@5 / MRR = `1.0 / 1.0 / 1.0`. That fixture was authored for this repository, so treat it as a regression guard—not independent evidence of real-world retrieval quality.

Reproduce the component result without an API key from a full source checkout:

```sh
npm ci
npm run verify
npm run bench -- --output benchmark.json
```

These are source-checkout scripts. The compact prebuilt runtime package deliberately excludes `scripts/`, tests, benchmark sources, and build configuration; unpacking the `.tgz` is not a supported way to run `npm run verify` or `npm run bench`. The exact metric, fixture, dependency versions, source digest, and measurement limits are in [`benchmark/README.md`](https://github.com/labmimors/dsh-mcp-lens/blob/v0.1.0-rc.9/benchmark/README.md).

## Keep schema drift out of CI

The dependency-free **MCP Lens Schema Audit** GitHub Action measures an exported model-facing tool payload inside the runner. It makes no network request, writes numeric metrics plus schema-free `share-url` / `share-markdown` outputs, and never copies tool names, descriptions, or schemas into the Step Summary. Optional budgets turn an unexpected schema expansion into a failing check.

Accepted JSON shapes are a tool array, `{ "tools": [...] }`, `{ "schemas": [...] }`, `{ "header": { "tools": [...] } }`, or a recorded `{ "request": { "header": { "tools": [...] } } }` payload.

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

The action accepts files up to 64 MiB, resolves the input inside `GITHUB_WORKSPACE`, and rejects symlink escapes. The byte metric is canonical `JSON.stringify(tools)` UTF-8 size—not tokens, billing, latency, or task quality.

## Reliability and resource controls

- **Lazy by default:** no MCP process or socket at plugin activation; idle connections close automatically.
- **Failure isolation:** catalog refreshes run per server; one failure does not hide healthy servers.
- **Last-good behavior:** failed or oversized discovery never replaces a usable catalog generation.
- **Frozen search index:** repeated queries reuse one tokenized index per immutable visible catalog generation; refreshes invalidate by snapshot identity.
- **Bounded input:** deadlines and caps cover pagination, tool count, per-tool bytes, total catalog bytes, cursors, and streamed HTTP responses.
- **Credential-aware cache:** the owner-only `0600` cache stores projected tool metadata, never explicit env/header values or URL credentials.
- **Exact policy:** search and call share the same allow/deny decision at the final `server/tool` identity.
- **Clean shutdown:** cancellation, HMR, and disposal close transports, children, timers, and in-flight work.

MCP Lens is not a sandbox: stdio servers execute on the host, and HTTP servers receive the headers you configure. The current release bridges MCP Tools; it does not implement OAuth, Resources, Prompts, Elicitation, or task-based tool execution.

## Configuration reference

Most users only need `servers`, `cachePath`, `allowTools`, and `denyTools`. The remaining fields already have bounded defaults:

<details>
<summary>Show all bounded defaults</summary>

| Field | Default | Purpose |
|---|---:|---|
| `catalogTtlMs` | `86400000` | Refresh a catalog after 24 hours |
| `idleDisconnectMs` | `300000` | Close an idle server after 5 minutes |
| `connectTimeoutMs` | `30000` | Connection deadline |
| `callTimeoutMs` | `60000` | Tool-call deadline |
| `discoveryTimeoutMs` | `30000` | Whole paginated discovery deadline |
| `maxDiscoveryPages` | `1000` | Maximum pages per discovery |
| `maxToolsPerServer` | `10000` | Maximum tools accepted from one server |
| `maxBytesPerTool` | `1048576` | Maximum projected metadata bytes per tool |
| `maxTotalCatalogBytes` | `67108864` | Maximum total catalog/cache bytes |
| `maxHttpResponseBytes` | `16777216` | Maximum streamed HTTP response bytes |
| `maxCursorBytes` | `4096` | Maximum UTF-8 pagination cursor bytes |
| `searchLimitDefault` | `5` | Default search results |
| `searchLimitMax` | `10` | Maximum search results |

See the shipped [`cordis.patch.yml`](cordis.patch.yml) for the canonical defaults.

</details>

## Security, development, and community

- Useful on your catalog? [Star the repository](https://github.com/labmimors/dsh-mcp-lens) and [join the catalog challenge](https://github.com/labmimors/dsh-mcp-lens/discussions/11); sanitized real workloads help the next user decide.
- Want a quick before/after number? Use the [local-only catalog calculator](https://labmimors.github.io/dsh-mcp-lens/) to paste your current tool surface, compute exact UTF-8 bytes, and export a shareable card without uploading your schemas.
- End-user terms: [`EULA.md`](EULA.md).
- Privacy and data handling: [`PRIVACY.md`](PRIVACY.md).
- Support and response targets: [`SUPPORT.md`](SUPPORT.md).
- Security reports: read [`SECURITY.md`](SECURITY.md); do not disclose an unpatched exploit in a public issue.
- Contributions: read [`CONTRIBUTING.md`](https://github.com/labmimors/dsh-mcp-lens/blob/v0.1.0-rc.9/CONTRIBUTING.md).
- Search quality: [submit a sanitized search miss](https://github.com/labmimors/dsh-mcp-lens/issues/new?template=search_miss.yml) and help turn it into a regression fixture.
- Release candidate: [`v0.1.0-rc.9`](https://github.com/labmimors/dsh-mcp-lens/releases/tag/v0.1.0-rc.9).

DeepSeek Harness currently discovers community plugins through public GitHub repositories with the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic and installs them from GitHub, tarballs, or npm packages. See the official [plugin publishing guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).

MCP Lens is an independent MIT-licensed community plugin and is not affiliated with or endorsed by DeepSeek AI.
