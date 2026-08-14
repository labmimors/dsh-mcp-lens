# Live DeepSeek V4 Flash pilot

This report records a small real-model comparison between MCP Lens and the official direct MCP client in DeepSeek Harness. It answers a practical question: does progressive disclosure still complete real tool-use tasks, and what happened to the model-visible tool surface and API usage?

## Result at a glance

| Metric across three tasks | Official direct client | MCP Lens | Difference |
|---|---:|---:|---:|
| Completed tasks | 3 / 3 | 3 / 3 | Tie |
| Model-visible tools per request | 1,025 | 27 | 97.366% fewer |
| `request/header.tools` JSON per request | 674,249 B | 27,401 B | 95.936% smaller |
| Uncached input tokens | 199,751 | 21,713 | 89.130% fewer |
| Cache-read input tokens | 934,912 | 74,496 | 92.032% fewer |
| Output tokens | 491 | 794 | 61.711% more |
| Estimated API cost | $0.0307204 | $0.0034707 | 88.702% lower |

The pilot supports a narrow conclusion: on these three tasks and this 1,000-tool fixture, Lens preserved task completion while substantially reducing standing tool context and estimated API cost. It is not a general task-quality or latency benchmark.

## Setup

- Date: August 14, 2026
- DeepSeek Harness: `0.1.0-rc.6`
- Provider/model: `deepseek-official/deepseek-v4-flash`
- MCP transport: the same local stdio server in both arms
- Remote catalog: 1,000 MCP tools
- Lens path: `mcp_search` followed by `mcp_call`
- Direct path: one model-facing schema for every remote tool

Harness also exposed 25 non-MCP tools in both arms. That is why the complete request contained 27 tools with Lens and 1,025 with the direct client, while the MCP component itself was two versus 1,000 schemas.

## Tasks and observed calls

| Task | Lens calls | Direct-client call | Result |
|---|---|---|---|
| Look up a customer by email | `mcp_search` → `fixture/lookup_customer_by_email` | `mcp__fixture__lookup_customer_by_email` | Correct in both arms |
| Search Chinese support tickets for 退款 | `mcp_search` → `fixture/search_support_tickets` | `mcp__fixture__search_support_tickets` | Correct in both arms |
| List open pull requests by author | `mcp_search` → `fixture/github_list_pull_requests` | `mcp__fixture__github_list_pull_requests` | Correct in both arms |

Every Lens session retrieved the selected tool's exact `inputSchema` before calling it. All six sessions ended with `completed`, and every final answer matched the tool result.

## Usage and cost calculation

Aggregate provider-reported usage:

| Arm | Uncached input | Cache-read input | Output | Reasoning |
|---|---:|---:|---:|---:|
| Official direct client | 199,751 | 934,912 | 491 | 253 |
| MCP Lens | 21,713 | 74,496 | 794 | 307 |

The estimate uses the official DeepSeek V4 Flash prices current on August 15, 2026:

- cache-miss input: $0.14 per million tokens
- cache-hit input: $0.0028 per million tokens
- output: $0.28 per million tokens

Formula:

```text
estimated cost =
  uncached_input / 1,000,000 × $0.14
  + cache_read_input / 1,000,000 × $0.0028
  + output / 1,000,000 × $0.28
```

Pricing source: [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/). Provider prices can change, so recompute from the recorded usage when comparing later.

## What this does and does not show

This was a functional three-task pilot, not a statistically powered benchmark. It directly verifies the real model, real Harness tool traces, provider usage, selected arguments, tool results, and task completion for these cases.

The extra search step increased output tokens in this sample. Lens is therefore most compelling when catalog context dominates cost: many tools, several servers, or long-tail capabilities. For a few stable tools used on almost every turn, the official direct client remains the simpler option.

For a keyless, fully reproducible component benchmark at 12, 100, and 1,000 tools, see [`../benchmark/README.md`](../benchmark/README.md).
