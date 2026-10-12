# Next release preparation

Tracking: #1078, requested after merging #1070 / #1069.

Status: maintainer approved preparing **v0.2.24** across all seven packages and publishing after independent review and CI pass. Versions are aligned in the preparation PR. Publication is still pending; the protected environment approval cannot be bypassed. The proposed resume integration is explicitly deferred until after this release.

## Candidate contents

Baseline: `v0.2.23`. Inspected `main` commit: `da823db`.

- #1070: persistent session links, `attach_link`, themed `/link` and `/pr`, `/goal` links shortcut, and the compact unseen-link footer. Includes legacy Pi context support, small-pane safeguards, and durable seen state.
- #1066: durationless goal snooze defaults to five minutes.
- #1063: pinned split-turn prompt updated to Pi 0.87.1 (verified unchanged through 0.99.1); corrected previous-summary and virtual-model matching documentation.

See [v0.2.24 release notes](../CHANGELOG.md#0224---2026-10-09) for user-facing notes and [agent-goal](../agent-goal/README.md#saved-links-and-pull-requests) for commands, persistence, and safety. The root and package READMEs include three cropped terminal screenshots. PNG copies contain no ancillary metadata; desktop originals are not committed. Visible GitHub handles and issue/PR URLs refer to this public repository. No unseen-count screenshot is claimed: the supplied captures show the pickers and goal overlay.

## Compatibility and upgrade

- No user configuration change is required for the built-in goal storage. SQLite creates the session-link table and adds nullable seen-state data automatically. Links remain independent of goal deletion; no manual database reset is needed.
- Third-party `GoalStorage` adapters must add the four link methods documented in the package README. The maintainer selected v0.2.24 with this adapter migration documented; custom adapter users must update before upgrading.
- Attachments are session-scoped. Reattach links in another session if needed; clearing or completing a goal does not remove them.
- The link picker supports legacy Pi contexts. Selected-model compaction on Pi 0.85.x/0.86.x uses the newer pinned 0.87.1 split-turn wording.
- After publication, update the installed `@pinet/agent-goal` package and reload Pi. Development users must replace any local source override with the npm package entry when returning to published builds; avoid loading both copies.

## Preparation evidence

On the documentation worktree based on `da823db`:

- Frozen-lockfile install and full `pnpm prepush` (lint, typecheck, tests) passed. The first run hit two pre-existing wall-clock retry assertions in `agent-goal/runtime.test.ts` off by 1 ms; an unchanged rerun passed all 160 goal tests. Release CI must still pass independently.
- `pnpm publish:npm` passed the full seven-package build, declaration, metadata, and npm dry-run checks at the unchanged `0.2.23` version. This is artifact validation only: it neither establishes that this version is publishable again nor approves a real publish.
- All three cropped PNGs contain only `IHDR`, `IDAT`, and `IEND` chunks: no text, EXIF, location, or other ancillary metadata. Their visible contents were checked before upload. Package README images use absolute GitHub raw URLs so npm renders them after this documentation PR merges; the images are not added to the npm tarball.

## Release gates

Follow [the npm publish runbook](npm-publish.md), which is authoritative for workflow inputs, Trusted Publishing, and recovery.

- [x] Maintainer chose v0.2.24 and approved the coordinated seven-package scope. All seven public `@pinet/*` packages ship together, including the five with no functional changes in this candidate; the private root package is aligned too.
- [ ] Refresh the candidate inventory against the latest `main`, including any additional merged PRs.
- [x] Added version bumps to PR #1080, converted Unreleased to v0.2.24, and updated the root README’s release wording. Actual publication remains pending.
- [ ] Confirm `pnpm install --frozen-lockfile`, lint, typecheck, tests, builds, and full-set `pnpm publish:npm` dry-run readiness. Dry-run may rewrite local dependency specifiers: inspect the working tree before committing.
- [ ] Obtain independent review and maintainer approval; merge the release-prep PR.
- [ ] Run the GitHub npm readiness workflow with `dry_run=true` on the exact intended `main` commit. Local or earlier-commit checks do not replace this gate.
- [ ] With explicit publish approval, use the protected workflow. Manual real publishing requires `release_approval=publish all`; alternatively, an approved `vX.Y.Z` tag must point to the current `main` tip. Both require the `npm-publish` environment approval and configured Trusted Publishers.
- [ ] Verify all seven packages exist on npm at the selected version, publish the matching release notes, and smoke-test `/link`, `/pr`, explicit browser opening, and unseen-count acknowledgement from the installed npm artifact.

A green dry-run proves packaging readiness, not publication. If any real package publish fails after another succeeds, follow the runbook’s full-set patch recovery procedure rather than treating the partial set as a completed release.
