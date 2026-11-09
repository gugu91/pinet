# Next release preparation

## v0.2.27

The maintainer requested merging the TypeBox peer-dependency fix (#1126) and releasing it on 2026-11-09. The repository releases all eight public `@pinet/*` packages together, plus the aligned private root package.

Baseline: npm reports `@pinet/slack-bridge` and `@pinet/tmux` at `0.2.26`. The v0.2.26 preparation merge is `9d6c0bb`; the release also includes the subsequent changes on `main`, summarized in [CHANGELOG.md](../CHANGELOG.md#0227---2026-11-09).

## Release procedure

Follow [npm-publish.md](npm-publish.md), the authoritative runbook.

1. Merge #1126 after independent review and green quality checks.
2. Prepare and merge the v0.2.27 release PR after review and green quality checks. Align the private root and all eight public package versions; retain local dependency specifiers in source.
3. Run the GitHub npm readiness workflow (`dry_run=true`) on the intended `main` commit. A green dry-run validates artifacts, not publication.
4. Tag that current `main` tip as `v0.2.27`. The tag workflow checks versions and that the tag still equals `origin/main`, then waits for the protected `npm-publish` environment approval.
5. Approve the protected publish job with the maintainer's release authorization. Use Trusted Publishing/OIDC; do not publish locally or add token fallbacks.
6. Verify all eight packages on npm at `0.2.27`, including the Slack bridge manifest's TypeBox peer dependency. A late failure is a partial release: record what published and follow the full-set patch-version recovery procedure rather than blindly retrying.

No bootstrap is needed: `@pinet/tmux@0.2.26` already exists on npm. The GitHub environment currently requires maintainer review and permits `main` and `v*.*.*` tags. npm Trusted Publisher configuration is checked by the live publish, not proven by a dry-run.

## Upgrade

Update installed Pi packages and restart Pi to load the release. Preparing, merging or publishing does not update existing installations or running sessions automatically.
