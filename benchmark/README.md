# Benchmarks

Compare the official MCP client with MCP Lens on the same local MCP stdio
server, using Harness Context, SystemPrompt, and ToolRuntime.

```sh
npm ci --ignore-scripts
npm run build
npm run bench -- --output benchmark.json
```

The benchmark runs catalogs of 12, 100, and 1,000 tools and records:

- Model-visible schema count and UTF-8 size of `JSON.stringify(ctx.tools.schemas())`.
- Plugin startup time, cold search time, and search-result size.
- Seven warm tool-call samples, including median and p95.
- Recall@1, Recall@5, and MRR for the repository's 12 search queries.
- Package versions and hashes of the source files used by the run.

Each arm gets a fresh Context and MCP process. Startup and cold-search timings
are single observations in a fixed order; compare repeated runs on your own
machine when investigating latency. The 12-query set checks search regressions.
Model-driven task results are in [Product tests](../docs/PRODUCT_TESTS.md).

The retrieval table also includes `naive-all-token-substring`, a simple baseline
that counts query tokens found anywhere in tool metadata. The official MCP
client supplies tools directly and has no search ranker.

## Search-index cache

Measure the index cache with a 10,000-tool catalog:

```sh
npx tsx benchmark/search-cache.ts --output /tmp/lens-search-cache.json
```

This run compares 12 first searches on fresh catalog snapshots with 60 searches
after priming one snapshot. Every result is compared with an uncached search.
The output contains raw samples, median, p95, machine details, and source hashes.
Use a new output path for each run.
