# Next release preparation

Tracking: #1090. Maintainer requested preparing **v0.2.26** across all eight public `@pinet/*` packages and the private root package, including the first release of `@pinet/tmux`, with a one-time local bootstrap publish of that package. **No tagging or CI publishing is authorized by this preparation.**

## Candidate contents

Baseline: published npm `0.2.25` for the seven existing packages. `@pinet/tmux` has never been published.

Inspected `main` commit: `7b6adaa`. Changes since the v0.2.25 preparation merge (`a35c7e9`):

- #1081: new `@pinet/tmux` pane-state publisher and companion TPM plugin; `model-aware-compaction` emits `pinet:compaction-start`.
- #1087: agent-goal retains Done and rechecks blocked goals.
- #1089: agent-goal recovers active goals after network outages.

See [v0.2.26 release notes](../CHANGELOG.md#0226---2026-10-13). transport-core, broker-core, pinet-core, imessage-bridge and slack-bridge ship unchanged functionally at the aligned version.

## One-time `@pinet/tmux` bootstrap

npm Trusted Publishing is configured per package and needs the package to exist. The full-set bootstrap script (`pnpm bootstrap:npm`) cannot create it now: it refuses because the seven existing packages are already published. The protected workflow fails closed on any already-published version, so the bootstrap must not use the release version.

Plan: create the package from `main` **before this PR merges**, at the never-published `0.2.25`, then release `0.2.26` for all eight through the normal workflow.

1. Maintainer `npm login` as a `pinet` org owner/admin (`npm whoami` must succeed).
2. From an up-to-date `main` checkout with `tmux/package.json` at `0.2.25` and `npm view @pinet/tmux` returning 404:

   ```bash
   pnpm install --frozen-lockfile
   pnpm bootstrap:npm                              # dry-run: full-set build, metadata, types, npm publish --dry-run
   cd tmux && npm publish --access public          # prepack rebuilds dist/
   npm view @pinet/tmux@0.2.25 version             # verify
   ```

   `@pinet/tmux` has no `@pinet/*` dependencies, so no workspace specifier rewrite is needed.

3. **Later, just before the approved v0.2.26 publish**, configure its Trusted Publisher at <https://www.npmjs.com/package/@pinet/tmux/access>: repository `gugu91/pinet`, workflow `npm-publish.yml`, environment `npm-publish`, and under **Allowed actions** enable **`npm publish`**. Trusted publishers created after Sep 03, 2026 default to `npm stage publish` only, while the workflow runs `npm publish --provenance`; `@pinet/tmux` publishes last, so a stage-only configuration would leave the other seven packages published and the release partial.

   A new trusted publisher expires unless it completes a successful publish **within 2 days**, and an expired configuration cannot be edited. So configure it only once the release PR is merged and the readiness dry-run is green, then run the approved publish promptly. If it expires, delete it and create a new one. Dry-runs do not exercise trust.

This local publish has no provenance; v0.2.26 and later publish through CI with provenance.

## Compatibility and upgrade

- No configuration or database migration is required.
- After publication, update installed packages and **restart** Pi; `/reload` keeps already-loaded package modules. Preparing or merging this PR does not update running sessions or installations.
- agent-goal custom runtime storage/continuation adapters must honor the commit/dispatch `AbortSignal`; see the changelog.

## Readiness evidence

On the preparation worktree based on `7b6adaa`:

- `pnpm install --frozen-lockfile` and full `pnpm prepush` (lint, typecheck, tests) passed.
- `pnpm publish:npm` passed builds, metadata, public declaration checks and npm dry-runs for all eight packages at v0.2.26. Original dependency specifiers were restored; no lockfile change was needed.
- The bootstrap command dry-run (`npm publish --access public --dry-run` in `tmux/` on `main` at `7b6adaa`) produced `@pinet/tmux@0.2.25` (17 files).
- A read-only npm check found v0.2.26 unpublished for all eight packages and `@pinet/tmux` absent from npm. This is a point-in-time result; the protected workflow checks again.

A local dry-run validates artifacts only and publishes nothing.

## Release gates

Follow [the npm publish runbook](npm-publish.md), which is authoritative for workflow inputs, Trusted Publishing, and partial-release recovery.

- [x] Maintainer requested preparing v0.2.26 across the full eight-package set.
- [x] Inventory refreshed against `main` at `7b6adaa`; v0.2.25 is on npm for the seven existing packages.
- [x] Package and private root versions aligned to v0.2.26; changelog added.
- [x] Frozen-lockfile install, full lint/typecheck/tests and eight-package `pnpm publish:npm` dry-run.
- [ ] Independent review and green release-PR CI.
- [ ] **Before merging:** maintainer bootstraps `@pinet/tmux@0.2.25` locally (above).
- [ ] Confirm the seven existing packages' Trusted Publishers allow `npm publish` (configurations created before May 20, 2026 do automatically).
- [ ] Merge only when requested; refresh the inventory if more changes land on `main` first.
- [ ] After merge, run the GitHub npm readiness workflow with `dry_run=true` on the exact intended `main` commit.
- [ ] Configure the `@pinet/tmux` Trusted Publisher with `npm publish` allowed, then publish within 2 days (above).
- [ ] Obtain separate explicit maintainer approval to tag or publish. A tag-triggered release must point at the current `main` tip; a manual real publish requires `release_approval=publish all`. Both require the protected `npm-publish` environment approval and configured Trusted Publishers for all eight packages.
- [ ] After publication, verify all eight packages at v0.2.26 on npm and smoke-test installed artifacts, including `@pinet/tmux` in a fresh Pi session inside tmux.

A green dry-run proves packaging readiness, not publication. If a real publish partially succeeds, prepare a new approved patch version for the full set rather than retrying already-published versions.
