# npm publish plan for Pinet and Slack bridge

Issue: #773. Dependency: #772 should confirm the Pinet/Slack package boundary before real releases.

## Package set

The publish workflow always validates or publishes the full package set in dependency order:

1. `@gugu910/pi-transport-core` from `transport-core/`
2. `@gugu910/pi-broker-core` from `broker-core/`
3. `@gugu910/pi-pinet-core` from `pinet-core/`
4. `@gugu910/pi-imessage-bridge` from `imessage-bridge/`
5. `@gugu910/pi-slack-bridge` from `slack-bridge/`

There is intentionally no workflow target selector or script target flag. Real releases publish the shared core packages and Slack bridge package together so dependency versions stay aligned and operators cannot accidentally publish only a subset.

## Workflow

`.github/workflows/npm-publish.yml` is a manual `workflow_dispatch` workflow with two inputs:

- `dry_run`: defaults to `true`
- `release_approval`: real publishes only; must exactly match `publish all`

Every dispatch first runs the readiness job: install with `pnpm install --frozen-lockfile`, build packages in dependency order through `scripts/publish-npm-packages.mjs`, rewrite local `file:../...` workspace dependencies to exact package versions in the CI checkout, verify declared `dist/` JavaScript exports and declaration outputs exist, smoke-test public declaration imports, and run `npm publish --dry-run` in dependency order.

When `dry_run=true`, the workflow stops after that dry-run/readiness job and does not request the `npm-publish` environment or npm token. Dry-run dispatches use the `npm-publish-dry-run` concurrency group. Real publish dispatches use the `npm-publish-live` concurrency group so live publishes are globally serialized.

Real publishes require all of these gates before the publish job can run:

- `dry_run=false` was selected manually.
- A non-environment preflight job confirms the dispatch ref is `refs/heads/main`.
- The same preflight job confirms `release_approval` exactly matches `publish all`.
- The `npm-publish` GitHub environment is approved by a maintainer after preflight passes.
- `NPM_TOKEN` is present in that environment.

The real publish job then reruns the same publish script with `--publish`, which uses `npm publish --provenance` and fails closed if any target package version already exists on npm.

## Package artifacts and type/declaration artifacts

Publishable packages must include npm-visible package basics:

- `README.md`
- `LICENSE`
- `dist/`
- `license` metadata
- `publishConfig.access: "public"`

Publishable packages must also expose `types: "./dist/index.d.ts"` and build matching `.d.ts` files alongside their `dist/*.js` outputs. The publish script validates root metadata, package file allowlists, JavaScript export targets, declaration outputs, and public `.d.ts` import resolution before any dry-run or real publish. Public declaration imports are checked in an isolated TypeScript smoke test, and sibling publish-set imports must be declared in package dependencies, optional dependencies, or peer dependencies.

## `transport-core.slackBlocks` decision

`NormalizedMessageContent.slackBlocks` remains a compatibility/native-rendering field for the current release-readiness track. It is intentionally documented as a Slack-specific rendering escape hatch on the otherwise transport-neutral content contract so existing Slack Block Kit callers can keep working while future transport-neutral rich-content design is considered separately. This is **not** a blocker for dry-run/release-readiness, but it remains a follow-up API design decision before claiming the content model is fully transport-native.

## Required GitHub/npm configuration

Secret names only:

- `NPM_TOKEN` in the `npm-publish` GitHub environment

GitHub environment:

- `npm-publish` is an external repository prerequisite, not something this repo can create in source control.
- Configure or verify the environment before any real publish attempt.
- `npm-publish` should require maintainer approval before the publish job can access `NPM_TOKEN`.
- Dry-run/readiness dispatches do not use the environment and do not need the token.

GitHub permissions:

- Readiness job: `contents: read`
- Publish job: `contents: read` plus `id-token: write` for npm provenance

## Release gates before setting `dry_run=false`

- #772 has confirmed the Pinet/Slack boundary and the full publish set is still correct.
- Package versions are intentionally bumped. The publish script refuses real publishes for placeholder `0.0.0` packages or versions already present on npm.
- `CHANGELOG.md` has a maintainer-approved entry covering the full package set and package versions.
- The dry-run/readiness job is green on the same `main` commit intended for release.
- The workflow dispatch includes the exact `publish all` release approval phrase.
- The `npm-publish` environment approval is granted by a maintainer for that release.
- Built outputs are produced from the current commit and match `main`/`exports` entries.
- No npm token values are requested, printed, or committed.
