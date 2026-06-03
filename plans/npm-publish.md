# npm publish plan for Pinet and Slack bridge

Issue: #773. Dependency: #772 should confirm the Pinet/Slack package boundary before real releases.

## Package lanes

### Pinet lane

Publish in dependency order:

1. `@gugu910/pi-transport-core` from `transport-core/`
2. `@gugu910/pi-broker-core` from `broker-core/`
3. `@gugu910/pi-pinet-core` from `pinet-core/`

This lane is transport-neutral and must not publish Slack-specific packages.

### Slack bridge lane

Publish in dependency order:

1. `@gugu910/pi-transport-core` from `transport-core/`
2. `@gugu910/pi-broker-core` from `broker-core/`
3. `@gugu910/pi-pinet-core` from `pinet-core/`
4. `@gugu910/pi-imessage-bridge` from `imessage-bridge/`
5. `@gugu910/pi-slack-bridge` from `slack-bridge/`

The Slack lane includes the Pinet package closure because `slack-bridge` depends on Pinet and broker primitives, but the workflow keeps it as a separate manual target.

## Workflow

`.github/workflows/npm-publish.yml` is a manual `workflow_dispatch` workflow with two inputs:

- `target`: `pinet` or `slack-bridge`
- `dry_run`: defaults to `true`

The workflow installs with `pnpm install --frozen-lockfile`, builds packages, rewrites local `file:../...` workspace dependencies to exact package versions in the CI checkout, verifies declared `dist/` exports exist, and then runs `npm publish` in dependency order. Dry runs use `npm publish --dry-run`; real publishes must be dispatched from `refs/heads/main`, use `npm publish --provenance`, and fail closed if any target package version already exists on npm.

## Required GitHub/npm configuration

Secret names only:

- `NPM_TOKEN` in the `npm-publish` GitHub environment

GitHub permissions:

- `contents: read`
- `id-token: write` for npm provenance

## Release gates before setting `dry_run=false`

- #772 has confirmed the Pinet/Slack boundary and the target lane is still correct.
- Package versions are intentionally bumped. The publish script refuses real publishes for placeholder `0.0.0` packages or versions already present on npm.
- Built outputs are produced from the current commit and match `main`/`exports` entries.
- No npm token values are requested, printed, or committed.
