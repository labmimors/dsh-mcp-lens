# Product tests — September 10, 2026

English | [简体中文](PRODUCT_TESTS.zh-CN.md)

MCP Lens rc.10 fixes a multi-step tool-use problem: when a server returned a text
summary alongside structured data, the model could read the summary but miss the
customer ID needed for its next call. Lens now includes both in the tool result,
without duplicating identical JSON text.

## Model-driven tasks

Each task ran with a fresh Codex agent, Harness `0.1.2-rc.1`, and the same two local
MCP servers containing 16 tools. The model chose its own tools and arguments.
Results were checked against the returned IDs, amounts, status, and call order.

| Task | Official MCP client | MCP Lens rc.10 |
|---|---|---|
| Find a login support ticket from a Chinese request | Completed | Completed |
| Customer lookup → latest order → delivery status and amount | Stopped: customer ID missing from visible output | Completed |
| Recover from a health-check timeout and look up a customer | Completed | Completed |

The previous Lens build also stopped on the structured-data task. With the fix,
the model obtained the customer ID, passed it to the order lookup, and returned
the exact order ID, delivery status, amount, and currency.

Lens used one extra search for the ticket and timeout tasks, and two searches
for the three-step order task. These runs used synthetic business data and Codex;
the earlier DeepSeek model measurements are in the [August 14 report](LIVE_DEEPSEEK_PILOT.md).

## Data-flow tests

Six tasks ran at both 16 and 1,000 tools: customer lookup, refund tickets, login
tickets, ordinary order lookup, structured order lookup, and timeout recovery.
The same scripted driver and server data were used before and after the fix.

| Build | Official MCP client | MCP Lens |
|---|---:|---:|
| Before the fix | 10/12 | 10/12 |
| After the fix | 10/12 | 12/12 |

The two improved cases were the structured order task at each catalog size.
The scripted driver checks data flow; it does not ask a model to choose tools.

## Regression checks

- Type checking, build, and 175 tests passed.
- The existing 12 search queries returned the same rankings.
- At 1,000 remote tools, Lens still exposes 2 schemas totaling 1,114 UTF-8 bytes.
- The packaged plugin installed and completed search, call, and denied-call checks
  on Harness `0.1.2-rc.1`.
- The updated local Web profile started successfully and used the official public
  MCP documentation server to search and read Streamable HTTP documentation.

The [test results and tool traces](product-tests/2026-09-10.json) include the
before/after results. The structured-output regression tests live in
[`tests/integration.spec.ts`](https://github.com/labmimors/dsh-mcp-lens/blob/fix/dsh-rc2-compat/tests/integration.spec.ts).

Run the regression suite from a source checkout:

```sh
npm ci --ignore-scripts
npm run verify
npm run bench -- --output benchmark.json
```
