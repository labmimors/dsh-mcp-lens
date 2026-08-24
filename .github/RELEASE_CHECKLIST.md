# Release checklist

- [ ] Freeze the source tree and record the commit SHA.
- [ ] Run `npm ci` on a clean checkout.
- [ ] Run `npm run verify` and record the test count.
- [ ] Run `npm run bench -- --output benchmark.json`; inspect provenance and claim boundaries.
- [ ] Run `npm audit --omit=dev`.
- [ ] Run secret and forbidden-file scans against tracked files and the packed tarball.
- [ ] Record Node/npm versions, run `npm pack --ignore-scripts` twice in the frozen toolchain, and require byte-identical archives there.
- [ ] Across different npm compression toolchains, compare the uncompressed tar SHA-256 plus the unpacked file set and per-file SHA-256 digests; do not require the outer gzip stream to match.
- [ ] Install the tarball into a fresh DSH profile and run `--dump-config`.
- [ ] Run `npm run verify:dsh-install`; require one current DSH component version and no Lens-nested legacy DSH graph.
- [ ] Run `npm run verify:dsh-profile -- --output <release-dir>/dsh-mcp-lens-v0.1.0-rc.10-compatibility.json`; require the rc.2 CLI to load the Lens bundle from a fresh isolated profile, then inspect and retain the receipt.
- [ ] Confirm README install URLs, version, Node/DSH versions and both language documents.
- [ ] Create an immutable prerelease tag and attach the reviewed tarball, benchmark artifact and compatibility receipt.
- [ ] Publish that exact reviewed tarball with `npm publish <tarball> --tag next`; do not move `latest` without a separate decision.
- [ ] Read back npm dist-tags and metadata, download the registry tarball, and require its SHA-256 to match the GitHub Release asset byte-for-byte.
- [ ] Install `dsh-mcp-lens@next` in another fresh rc.2 profile and repeat `--dump-config` before declaring the release complete.
- [ ] Add the `dsh-plugin` GitHub topic.
- [ ] Publish only evidence-bounded release and community copy.
