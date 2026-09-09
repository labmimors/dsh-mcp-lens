# Contributing to MCP Lens

Thanks for helping make large MCP catalogs easier to operate and audit.

## Before you start

- Use Node.js `^22.19.0` or `>=24.0.0`.
- Never commit credentials, private MCP catalogs, `.env*`, `.npmrc`, DSH profile state, or production logs.
- For a security vulnerability, follow [`SECURITY.md`](SECURITY.md) instead of opening a public exploit report.
- Keep the model-facing contract at exactly `mcp_search` and `mcp_call` unless a proposal includes new benchmark evidence and a migration plan.

## Local checks

```sh
npm ci
npm run verify
npm run bench -- --output benchmark.json
npm audit --omit=dev
npm pack --dry-run --json --ignore-scripts
```

`npm run verify` must pass type checking, all tests, and the production build. The benchmark is component evidence; do not turn schema bytes or lexical retrieval scores into token, cost, or LLM task-quality claims.

## Harness compatibility

The default source graph pins every DSH development component to `0.1.2-rc.1`. CI also runs typechecking, the full source tests, the build, the component benchmark, and packed/profile checks against `0.1.1-rc.2` and `0.1.5-alpha.1`. All components must move together: individual DSH package dist-tags can differ from the CLI's tags.

After building, exercise the **packed** plugin against a supported exact npm version:

```sh
npm run verify:dsh-install -- --harness-version 0.1.5-alpha.1
npm run verify:dsh-profile -- --harness-version 0.1.5-alpha.1 --output /tmp/lens-alpha-profile.json
```

Omitting `--harness-version` selects the exact development version. Tags, ranges, unknown arguments, and versions outside the declared host peers are rejected. The packed-install check calls `mcp_search` and `mcp_call` through the installed host, checks the two-tool surface and policy denial, and rejects mixed or Lens-nested DSH packages. The profile check uses the exact npm CLI, strict peer resolution, and an isolated `DSH_HOME`; it checks one composed Lens bundle and saves a versioned receipt when `--output` is supplied. These checks call a local MCP fixture and require no model API key.

The profile runner uses `corepack` and pinned pnpm `10.20.0`. If your Node distribution omits Corepack, run it without a global install:

```sh
npm exec --yes --package=corepack@0.34.0 -- npm run verify:dsh-profile -- --harness-version 0.1.2-rc.1
```

The existing `verify:dsh-desktop-alpha` gate remains pinned to Desktop `2.0.4` and its `0.1.2-alpha.1` vendored graph. It is historical coverage, not evidence for the latest Desktop release. CLI composition and local fixture calls do not establish Desktop UI/Market behavior, live-model task quality, cost, or latency. Keep the August 14 pilot and retrieval holdout frozen; a new host version needs new paired model evidence before making new performance claims.

## High-value contributions

- A sanitized search query and minimal tool metadata that reproduce a ranking miss.
- Lifecycle regressions involving refresh, invalidation, cancellation, or disposal.
- Protocol fixtures for stdio or Streamable HTTP edge cases.
- Resource-boundary tests for discovery, pagination, catalogs, cursors, or responses.
- Documentation improvements verified against the current DeepSeek Harness developer preview.

Remove credentials, tenant names, signed URLs, private hostnames, and business data before sharing a fixture.

## Pull requests

Keep each pull request focused. Explain the user-visible problem, describe the smallest solution, list exact verification commands, and state what was not tested. Update both language READMEs when changing metrics, installation, configuration, or security behavior.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
