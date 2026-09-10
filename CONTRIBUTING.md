# Contributing to MCP Lens

Use Node.js `^22.19.0 || >=24.0.0`. Start from the source checkout:

```sh
npm ci
npm run verify
npm run bench -- --output benchmark.json
```

`verify` runs type checking, the tests, and the production build. The benchmark compares Lens with the official direct MCP client using local servers. See [Product tests](docs/PRODUCT_TESTS.md) for the latest model tasks and data workflows.

## Harness compatibility

The development dependencies use Harness `0.1.2-rc.1`. The registry checks also cover `0.1.1-rc.2` and `0.1.5-alpha.1`. As of September 10, 2026, Harness's npm `alpha` tag points to `0.1.5-alpha.2`; use the exact versions above for these checks.

After building, test the installed package and a fresh profile:

```sh
npm run verify:dsh-install -- --harness-version 0.1.2-rc.1
npm run verify:dsh-profile -- --harness-version 0.1.2-rc.1
```

Repeat with the other supported versions when changing Harness integration. Omitting `--harness-version` uses the development version. Keep the five DSH development packages on the same exact version when upgrading.

The package check runs search, a structured call, and a denied call through the installed Lens package. It checks that Lens exposes two tools and shares the host's DSH packages. The profile check uses a temporary `DSH_HOME`, installs the plugin, and checks the resulting configuration. Both checks work without a model API key. Add `--output /tmp/lens-profile.json` to save the profile check's results.

The profile runner uses Corepack and pnpm `10.20.0`. If Corepack is unavailable:

```sh
npm exec --yes --package=corepack@0.35.0 -- npm run verify:dsh-profile -- --harness-version 0.1.2-rc.1
```

The separate `verify:dsh-desktop-alpha` script tests Desktop `2.0.4` with its bundled Harness `0.1.2-alpha.1` from a source checkout.

## Useful contributions

- Search queries and minimal tool definitions that reproduce a missed result.
- Multi-step calls that pass returned identifiers into the next tool.
- Tests for refresh, cancellation, server failures, stdio, or Streamable HTTP.
- Clearer installation and configuration examples.

Keep fixtures free of credentials and private customer data. Report vulnerabilities through [SECURITY.md](SECURITY.md).

In a pull request, describe the user-visible change and how to reproduce or test it. Update both READMEs when changing installation, configuration, or reported results.

## Measure schema size in CI

The Schema Audit Action reads exported tool JSON and reports tool count and UTF-8 schema bytes. Optional limits fail the check when the payload grows too large.

```yaml
- uses: labmimors/dsh-mcp-lens@f21169f921e7ed032a4db5062685afb6f948c2d1
  with:
    tools-file: fixtures/request-header-tools.json
    max-tools: 100
    max-schema-bytes: 65536
```

This commit is the rc.7 Action release. The input can be a tool array or an object containing `tools`, `schemas`, `header.tools`, or `request.header.tools`. The Action reads files inside the workspace, up to 64 MiB. Its `share-url` and `share-markdown` outputs share numeric measurements from the [schema calculator](https://labmimors.github.io/dsh-mcp-lens/).

For publishing a version, see [Release steps](.github/RELEASE_CHECKLIST.md).
