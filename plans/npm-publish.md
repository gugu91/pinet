# npm publish plan for Pinet and Slack bridge

Issue: #773. Dependency: #772 should confirm the Pinet/Slack package boundary before real releases.

## Package set

The publish workflow always validates or publishes the full npm org `pinet` package set in dependency order:

1. `@pinet/transport-core` from `transport-core/`
2. `@pinet/broker-core` from `broker-core/`
3. `@pinet/pinet-core` from `pinet-core/`
4. `@pinet/imessage-bridge` from `imessage-bridge/`
5. `@pinet/slack-bridge` from `slack-bridge/`

There is intentionally no workflow target selector or script target flag. Real releases publish the shared core packages and Slack bridge package together so dependency versions stay aligned and operators cannot accidentally publish only a subset.

## Workflow and script

`.github/workflows/npm-publish.yml` supports both manual `workflow_dispatch` runs and release-tag publishes.

Manual dispatch inputs:

- `dry_run`: defaults to `true`
- `release_approval`: manual real publishes only; must exactly match `publish all`

Tag-triggered publishes run only for `vX.Y.Z` tags. The readiness job validates every package in the full `@pinet/*` set has `package.json.version` equal to the tag version before any `npm publish --dry-run`; the preflight job also fetches `origin/main`, fails unless the tag commit equals the current `origin/main` tip, and repeats the package-version check before the protected publish job can request the `npm-publish` environment.

Every run first executes the readiness job: install with `pnpm install --frozen-lockfile`, build packages in dependency order through `scripts/publish-npm-packages.mjs`, rewrite local `file:../...` workspace dependencies to exact package versions in the CI checkout, verify declared `dist/` JavaScript exports and declaration outputs exist, smoke-test public declaration imports, and run `npm publish --dry-run` in dependency order.

For local/readiness use, run the same script directly or through the safe npm script:

```bash
pnpm publish:npm
node ./scripts/publish-npm-packages.mjs --dry-run
```

Both forms default to dry-run/readiness. The script has no `--target` flag and always processes the full package set. The `--publish` mode is reserved for the GitHub Actions Trusted Publishing/OIDC workflow context; it is not a local token-publish path.

For one-time npm org package creation before Trusted Publishing can be configured, use the bootstrap script described below:

```bash
pnpm bootstrap:npm
node ./scripts/bootstrap-npm-packages.mjs --dry-run
```

That script also defaults to dry-run/readiness and processes the same full package set. Its real publish mode is a local maintainer bootstrap escape hatch only; it is not the normal release path.

When manual `dry_run=true`, the workflow stops after the dry-run/readiness job and does not request the `npm-publish` environment. Dry-run dispatches use the `npm-publish-dry-run` concurrency group. Manual real publishes and tag-triggered publishes use the `npm-publish-live` concurrency group so live publishes are globally serialized.

Manual real publishes require all of these gates before the publish job can run:

- `dry_run=false` was selected manually.
- A non-environment preflight job confirms the dispatch ref is `refs/heads/main`.
- The same preflight job confirms `release_approval` exactly matches `publish all`.
- The `npm-publish` GitHub environment is approved by a maintainer after preflight passes.
- The publish job has `id-token: write` so npm Trusted Publishing can exchange GitHub OIDC for npm publish authority.
- npm Trusted Publishers are configured for every package in the full set with repository `gugu91/extensions`, workflow `npm-publish.yml`, and environment `npm-publish` when npm asks for an environment.

Tag-triggered real publishes require all of these gates before the publish job can run:

- A maintainer-approved version-bump PR has landed on `main`, with all five `@pinet/*` package versions and `pnpm-lock.yaml` aligned.
- A `vX.Y.Z` tag points at the current `main` tip after the version-bump PR merges.
- The non-environment preflight job fetches `origin/main` and confirms the tag commit equals the current `origin/main` tip.
- The same preflight job confirms every full-set package version equals `X.Y.Z`.
- The `npm-publish` GitHub environment is approved by a maintainer after preflight passes.
- The publish job has `id-token: write` and npm Trusted Publishers are configured for every package as above.

The real publish job then reruns the same publish script with `--publish`, which uses `npm publish --provenance` and fails closed if any target package version already exists on npm.

## npm org and first-publish bootstrap

Packages are intended for the npm `pinet` org/package settings area: <https://www.npmjs.com/settings/pinet/packages>.

Keep the GitHub and npm setup separate:

- **GitHub setup:** create/verify the `npm-publish` environment, require maintainer reviewers, allow deployments from `main` and release tags matching `v*.*.*`, and do not add long-lived npm token auth for this workflow. The tag allowance is only an environment policy prerequisite; the workflow still independently fails unless the tag commit equals the current `origin/main` tip.
- **npm setup:** an npm `pinet` org owner/admin must have package creation/publish authority for the org and must configure Trusted Publishing for every package in the list above.

Trusted Publishing is package-scoped in npm's settings UI. If npm does not allow a Trusted Publisher to be configured for a package before that package exists, do not add a token fallback in this repo.

The repo includes a guarded first-publish bootstrap script for that narrow package-creation gap:

```bash
# safe default: builds, validates, and runs npm publish --dry-run for the full set
pnpm bootstrap:npm

# real one-time bootstrap only, after maintainer-approved versions are set
node ./scripts/bootstrap-npm-packages.mjs \
  --bootstrap-publish \
  --confirm "bootstrap @pinet packages"
```

The real bootstrap mode still runs the same package-name, metadata/artifact, build-output, public-type, placeholder-version, and already-published-version gates. It then runs `npm publish --access public` for the full package set from the local npm CLI login. The maintainer running it must already be logged in with `npm login` as a `pinet` org owner/admin with package creation rights. This repo does not configure token auth and does not make bootstrap publishing the normal release path.

Immediately after any successful first-publish bootstrap, configure npm Trusted Publishing for every package in <https://www.npmjs.com/settings/pinet/packages> with owner/repo `gugu91/extensions`, workflow `npm-publish.yml`, and environment `npm-publish` if npm asks for one. Normal future publishes should then use the GitHub Actions Trusted Publishing/OIDC workflow with provenance. If npm's team/access UI loops or blocks package creation, resolve org/team/admin access in npm first rather than adding CI token automation.

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

Secrets:

- No long-lived npm token secret is required or expected for the Trusted Publishing workflow.

GitHub environment:

- `npm-publish` is an external repository prerequisite, not something this repo can create in source control.
- Configure or verify the environment before any real publish attempt.
- `npm-publish` should require maintainer approval before the publish job can run.
- Restrict environment deployments to `main` for manual real publishes and allow the `v*.*.*` release tag pattern for tag-triggered publishes.
- Treat this environment branch/tag policy as out-of-band maintainer setup: verify the live repo environment allows both `main` and `v*.*.*` before considering tag releases ready. Do not rely on environment tag allowance alone; the workflow guard still requires the tag commit to equal the current `origin/main` tip.
- Dry-run/readiness dispatches do not use the environment.

npm org/package configuration:

- Configure/verify the npm `pinet` org package settings for every package in the full set.
- Each package's Trusted Publisher should point at owner/repo `gugu91/extensions`, workflow `npm-publish.yml`, and environment `npm-publish` if npm asks for one.
- The maintainer performing npm setup must have enough org/package admin rights to create packages and configure publishing trust.

GitHub permissions:

- Readiness job: `contents: read`
- Publish job: `contents: read` plus `id-token: write` for npm Trusted Publishing/provenance

## Release gates before real publish

- #772 has confirmed the Pinet/Slack boundary and the full publish set is still correct.
- Package versions are intentionally bumped together. The publish and bootstrap scripts refuse real publishes for placeholder `0.0.0` packages or versions already present on npm.
- `pnpm-lock.yaml` is updated for the package-version bump.
- `CHANGELOG.md` has a maintainer-approved entry covering the full package set and package versions.
- The dry-run/readiness job is green on the same `main` commit intended for release.
- For manual real publishes, the workflow dispatch includes the exact `publish all` release approval phrase and runs from `main`.
- For tag-triggered real publishes, the maintainer creates a `vX.Y.Z` tag on the current `main` tip after the version-bump PR merges; the workflow validates the tag commit equals the current `origin/main` tip and every full-set package version equals `X.Y.Z` before publish approval.
- The `npm-publish` environment approval is granted by a maintainer for that release.
- npm Trusted Publishing is configured for every package in the full set.
- Built outputs are produced from the current commit and match `main`/`exports` entries.
- No npm token values are requested, printed, or committed.
