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
- [ ] Confirm README install URLs, version, Node/DSH versions and both language documents.
- [ ] Create an immutable prerelease tag and attach the reviewed tarball plus benchmark artifact.
- [ ] Add the `dsh-plugin` GitHub topic.
- [ ] Publish only evidence-bounded release and community copy.
