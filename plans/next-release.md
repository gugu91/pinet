# Next release preparation

## v0.2.28

The maintainer requested releasing extensions after merged #1129 on 2026-11-11. The repository releases all eight public `@pinet/*` packages together, plus the aligned private root package.

Baseline: v0.2.27 was published successfully by workflow run `42643482512`. The only functional change since its preparation commit `d0e35aa` is #1129, merged at `2b5d208`. See [CHANGELOG.md](../CHANGELOG.md#0228---2026-11-11).

## Release procedure

Follow [npm-publish.md](npm-publish.md), the authoritative runbook.

1. Prepare and merge the v0.2.28 release PR after independent review and green quality checks. Align the private root and all eight public package versions; retain local dependency specifiers in source.
2. Run the GitHub npm readiness workflow (`dry_run=true`) on the intended `main` commit. A green dry-run validates artifacts, not publication.
3. Tag that current `main` tip as `v0.2.28`. The tag workflow checks versions and that the tag still equals `origin/main`, then waits for the protected `npm-publish` environment approval.
4. Obtain the protected publish job approval from the maintainer. Use Trusted Publishing/OIDC; do not publish locally or add token fallbacks.
5. Verify all eight packages on npm at `0.2.28`. A late failure is a partial release: record what published and follow the full-set patch-version recovery procedure rather than blindly retrying.

No bootstrap is needed: all eight packages already exist on npm. The GitHub environment requires maintainer review; verify it still permits `main` and `v*.*.*` tags before tagging. npm Trusted Publisher configuration is checked by the live publish, not proven by a dry-run.

## Upgrade

Update installed Pi packages and restart Pi to load the release. Preparing, merging or publishing does not update existing installations or running sessions automatically.
