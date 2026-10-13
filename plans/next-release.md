# Next release preparation

Tracking: #1085. Maintainer approved preparing a **v0.2.25 PR only**, including coordinated version bumps for all seven public `@pinet/*` packages and the private root package. **No tagging or publishing is authorized.**

## Candidate contents

Baseline: published npm `0.2.24`. All seven packages reported `0.2.24` as their latest version during preparation. The local tag list stops at `v0.2.23`, so that tag is not the release baseline.

Inspected `main` commit: `49a8962`, immediately after #1083 merged. The only functional change after the v0.2.24 preparation commit (`d3c30cb`) is:

- #1083: prevent compaction and Slack scope diagnostics from corrupting Pi's interactive editor. Compaction debug, failure, fallback, and config messages use UI notifications when UI is available, preserving headless stderr output. Configuration diagnostics are returned to wiring and deduplicated per extension instance. Slack scope warnings no longer emit through both UI and stderr.

See [v0.2.25 release notes](../CHANGELOG.md#0225---2026-10-13). The five other packages ship unchanged functionally at the aligned version. The previously deferred resume integration remains outside this candidate.

## Compatibility and upgrade

- No configuration or database migration is required for this patch. Debug mode may remain enabled.
- Failure and fallback diagnostics remain visible even when compaction debug mode is off. Headless logging is retained; supported RPC notifications use the UI route.
- After a separately approved publication, update installed packages and reload or restart Pi. Preparing or merging the release PR does not update running sessions or npm installations.
- Existing v0.2.24 custom `GoalStorage` adapter requirements remain unchanged; see its changelog entry for that earlier migration.

## Readiness evidence

On the preparation worktree based on `49a8962`:

- `pnpm install --frozen-lockfile` and full `pnpm prepush` (lint, typecheck, tests) passed.
- `pnpm publish:npm` passed builds, metadata, public declaration checks, and npm dry-runs for all seven packages at v0.2.25. Original dependency specifiers were restored; no lockfile change was needed.
- A separate read-only npm availability check found v0.2.25 unpublished for all seven packages. This is a point-in-time result, not a reservation; the protected real-publish workflow must check again.

Independent review and CI are recorded in the release PR. A local dry-run validates artifacts only and publishes nothing.

## Release gates

Follow [the npm publish runbook](npm-publish.md), which is authoritative for workflow inputs, Trusted Publishing, and partial-release recovery.

- [x] Maintainer approved preparing v0.2.25 across the full seven-package set, without tagging or publishing.
- [x] Inventory refreshed against `main` at `49a8962`; v0.2.24 is already on npm.
- [x] Package and private root versions aligned to v0.2.25; changelog added.
- [x] Confirm frozen-lockfile install, full lint/typecheck/tests, build/declaration checks, and full-set `pnpm publish:npm` dry-run. Confirm the dry-run restores local dependency specifiers.
- [ ] Obtain independent review and green release-PR CI; merge only when requested.
- [ ] Refresh the inventory if additional changes land on `main` before release.
- [ ] After the release PR merges, run the GitHub npm readiness workflow with `dry_run=true` on the exact intended `main` commit. Checks on another commit do not replace this gate.
- [ ] Obtain separate explicit maintainer approval to tag or publish. A tag-triggered release must point at the current `main` tip; a manual real publish requires `release_approval=publish all`. Both require the protected `npm-publish` environment approval and configured npm Trusted Publishers.
- [ ] After publication, verify all seven packages at v0.2.25 on npm and smoke-test installed artifacts, including compaction with debug enabled.

A green dry-run proves packaging readiness, not publication. If a real publish partially succeeds, prepare a new approved patch version for the full set rather than retrying already-published versions.
