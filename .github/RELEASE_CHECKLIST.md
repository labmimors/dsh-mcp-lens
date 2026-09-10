# Release steps

- [ ] Update the package version, lockfile, and installation commands in both READMEs.
- [ ] Run `npm ci`, `npm run verify`, and `npm run bench -- --output benchmark.json`.
- [ ] Run `npm audit --omit=dev` and inspect the package contents with `npm pack --dry-run --json --ignore-scripts`.
- [ ] Run `verify:dsh-install` and `verify:dsh-profile` for Harness `0.1.1-rc.2`, `0.1.2-rc.1`, and `0.1.5-alpha.1`, using `--harness-version`.
- [ ] Build the tarball with `npm pack --ignore-scripts`. Install it into a fresh Harness profile, check `--dump-config`, and try a search followed by a tool call.
- [ ] Create the version tag and GitHub Release. Attach the tarball and link the relevant [product tests](../docs/PRODUCT_TESTS.md).
- [ ] Publish the same tarball to npm:

```sh
npm publish ./dsh-mcp-lens-0.1.0-rc.10.tgz --tag next
```

- [ ] Confirm the npm version and dist-tag, then install the published package in a fresh profile:

```sh
dsh plugin --profile lens-release add dsh-mcp-lens@0.1.0-rc.10
dsh --profile lens-release --dump-config
```

- [ ] Update both READMEs with the published installation command and release link.
