# extensions

Pi extensions monorepo — Slack, Neovim, and Neon Postgres integrations for
the [pi coding agent](https://github.com/nicholasgasior/pi-coding-agent).

Current state: the repo has moved from the initial **50+ merged PRs in a
single day** sprint into a broader Pinet stabilization and docs pass, with a
broker/follower Slack mesh, durable Pinet lanes/inbox state, Slack canvases, scheduled
wake-ups, worktree guardrails, checked-in Slack manifest deploy tooling,
optional mesh auth, and a browser-playwright workspace package for
interactive browsing and screenshots.

## Extensions

| Package                                     | Description                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| [`transport-core`](transport-core/)         | Transport-neutral message contracts shared across transport packages            |
| [`browser-playwright`](browser-playwright/) | Supported Anthropic-sandbox browsing path; Playwright-first single browser tool |
| [`slack-bridge`](slack-bridge/)             | Slack assistant app (Pinet) — broker mesh, inbox, canvases, deploy tooling      |
| [`slack-api`](slack-api/)                   | Typed Slack Web API client + CLI generated from OpenAPI                         |
| [`imessage-bridge`](imessage-bridge/)       | macOS/iMessage send-first transport package + readiness helpers                 |
| [`nvim-bridge`](nvim-bridge/)               | Neovim editor context sync; PiComms disabled pending Pinet adapter replacement  |
| [`neon-psql`](neon-psql/)                   | Config-driven Neon tunnel + `psql` tool                                         |
| [`types`](types/)                           | Shared ambient type declarations                                                |

## Current state snapshot

- **Broker mesh** — Slack-bridge now runs a broker/follower Pinet workflow with
  routing, inbox sync, broadcast channels, reload/unfollow controls,
  scheduled wake-ups, and optional/configurable shared-secret mesh auth.
- **Slack tooling** — the Slack extension includes canvases, uploads,
  modals, bookmarks, pinning, exports, and a root `pnpm deploy:slack` command
  for pushing `slack-bridge/manifest.yaml` via the Slack App Manifest API.
- **Browser automation** — the repo now carries a dedicated
  [`browser-playwright`](browser-playwright/README.md)
  workspace package as the supported browsing path in the Anthropic sandbox,
  with reusable sessions, multi-tab browsing, request guardrails, and
  workspace-local screenshot artifacts. Local `agent-browser` daemon
  compatibility is explicitly not a support goal for this path.
- **Recent wave** — browser-playwright landed alongside the Pinet v0.1.1 prep,
  mesh-secret optionality, auth-mismatch clarification, and refreshed mesh-auth
  docs ([#282](https://github.com/gugu91/extensions/pull/282),
  [#288](https://github.com/gugu91/extensions/pull/288),
  [#289](https://github.com/gugu91/extensions/pull/289),
  [#292](https://github.com/gugu91/extensions/pull/292),
  [#294](https://github.com/gugu91/extensions/pull/294)).

## Philosophy

### How Pinet was built

Pinet was not just designed on paper and then implemented by hand. It was built
mostly unsupervised by the kind of system it enables: a self-coordinating mesh
of coding agents working through Slack, GitHub, and linked git worktrees.

The core operating model is simple:

- **A broker coordinates, but does not write code.** The broker agent watches
  Slack, files and routes work, nudges stalled threads, tracks ownership, and
  keeps the system coherent. The actual implementation work stays with worker
  agents in isolated worktrees.
- **Workers ship end-to-end.** Worker agents pick up issues, write code, add
  tests, run checks, push branches, and open PRs without waiting for a human to
  micromanage every step.
- **Agents review other agents.** The mesh does not stop at code generation:
  agents review each other's PRs, handle rebases, resolve conflicts, and repair
  broken branches autonomously when `main` moves underneath them.
- **Personality is a feature, not garnish.** Named agents like Rocket Dolphin,
  Silent Crocodile, Solar Mantis, and Ultra Rabbit make a busy multi-agent
  system legible. When dozens of tasks are moving at once, memorable identities
  make status, ownership, and accountability visible to humans.
- **The mesh is expected to self-repair.** The RALPH loop watches for stalls,
  reassigns stuck work, nudges long-running threads, and reaps dead or ghosted
  agents so the system can keep moving even when parts of it fail.

This is not a toy demo. During the current buildout, the mesh merged **50+ PRs
in a single day** with minimal human intervention. The system was doing real
engineering work: implementing features, reviewing changes, recovering from
failures, and keeping momentum through rebases and broker hiccups.

Humans still matter, but in a deliberately high-leverage role: **set
priorities, approve merges, and provide the API tokens and environment** that
let the mesh operate. The goal is not to remove humans from the loop; it is to
move them up a level, from doing every step manually to steering a system that
can coordinate and execute most of the work itself.

## Quick start

```bash
# Install dependencies in this checkout
pnpm install

# Run all checks
pnpm lint && pnpm typecheck && pnpm test
```

### Fresh worktree bootstrap

For a fresh git worktree, bootstrap dependencies in that checkout before
running `pnpm lint`, `pnpm typecheck`, `pnpm test`, or `pnpm prepush`:

```bash
git worktree add .worktrees/<name> -b <branch>
cd .worktrees/<name>
pnpm install --frozen-lockfile
```

Dependency bootstrap is per checkout/worktree, not a one-time repo setup step.
If the lane exercises live browser launches and no compatible host browser is
available, install the Playwright browser binaries from the package directory:

```bash
cd browser-playwright
npx playwright install chromium
```

## Local extension development

This repo now uses pnpm workspaces + Turborepo for **repo-internal monorepo
tooling**. It is **not** yet a supported root-level `pi install git:...`
package target.

For local development, load individual extensions directly:

```bash
ln -s "$(pwd)/slack-bridge"       ~/.pi/agent/extensions/slack-bridge
ln -s "$(pwd)/nvim-bridge"        ~/.pi/agent/extensions/nvim-bridge
ln -s "$(pwd)/neon-psql"          ~/.pi/agent/extensions/neon-psql
ln -s "$(pwd)/browser-playwright" ~/.pi/agent/extensions/browser-playwright
```

See each extension's README for configuration details.

## Development

This repo uses [pnpm workspaces](https://pnpm.io/workspaces) +
[Turborepo](https://turbo.build/repo) for build orchestration with local
caching.

### Commands

| Command             | Description                                                     |
| ------------------- | --------------------------------------------------------------- |
| `pnpm lint`         | ESLint across all extensions (turbo-cached)                     |
| `pnpm typecheck`    | TypeScript strict check (turbo-cached)                          |
| `pnpm test`         | Vitest — all tests (turbo-cached)                               |
| `pnpm deploy:slack` | Validate and push `slack-bridge/manifest.yaml` to the Slack app |
| `pnpm prepush`      | lint + typecheck + test (runs on git push)                      |
| `pnpm format`       | Prettier + Stylua                                               |
| `pnpm check`        | lint + typecheck + format check                                 |

### Structure

```
extensions/
├── transport-core/     # @pinet/transport-core
│   ├── index.ts        #   canonical transport message contracts
│   └── package.json    #   workspace package
├── browser-playwright/ # @gugu910/pi-browser-playwright
│   ├── index.ts        #   Playwright-first single `browser` tool entry point
│   ├── helpers.ts      #   security defaults + install guidance
│   └── package.json    #   workspace package + pi manifest
├── slack-bridge/       # @pinet/slack-bridge
│   ├── broker/         #   message routing, socket server, adapters
│   ├── index.ts        #   extension entry point
│   └── package.json    #   workspace package + pi manifest
├── slack-api/          # @gugu910/pi-slack-api
│   ├── generated/      #   generated typed Slack Web API client
│   ├── cli.ts          #   CLI wrapper around generated methods
│   └── package.json    #   workspace package + pi manifest
├── imessage-bridge/    # @pinet/imessage-bridge
│   ├── mvp.ts          #   local macOS/iMessage readiness helpers
│   ├── send.ts         #   AppleScript send-first transport helper
│   └── package.json    #   standalone workspace package
├── nvim-bridge/        # @gugu910/pi-nvim-bridge
│   ├── nvim/           #   Neovim Lua plugin
│   ├── index.ts        #   extension entry point
│   └── package.json
├── neon-psql/          # @gugu910/pi-neon-psql
│   ├── index.ts        #   extension entry point
│   └── package.json
├── types/              # @gugu910/pi-ext-types (shared .d.ts)
├── plans/              # Architecture docs
├── .pi/                # Pi config (skills, agents)
├── turbo.json          # Turborepo task config
├── pnpm-workspace.yaml # Workspace packages
└── package.json        # Root — dev deps + scripts
```

### Extension tool-surface design principles

All extensions should use token-efficient progressive discovery for
agent-facing surfaces. This is especially important for Pinet / `slack-bridge`,
where broad Slack/Pinet action families can otherwise bloat every agent turn
(see #566 and #581).

1. **Hot tool schemas stay small.** Keep only the few per-turn, high-signal
   execution tools registered as dedicated tools, and justify additions by
   expected usage and token footprint.
2. **Cold paths stay discoverable.** Large homogeneous action families should
   sit behind compact dispatchers with structured `help` and per-action schema
   discovery instead of many cold one-off tools.
3. **Warm knowledge moves to skills/docs.** Formatting examples, API recipes,
   templates, and recovery playbooks belong in lazily loaded skills or docs —
   not in always-present prompts or tool schemas.
4. **Responses are contracts.** Prefer structured response envelopes such as
   `{ status, data, errors, warnings }` with typed error classes and recovery
   hints so agents can recover without an extra human turn.
5. **Guardrails name the executable action.** Dispatcher actions should expose
   stable guardrail names (for example `slack:upload`) so blocking and
   confirmation policies remain precise even when many actions share one tool.
6. **Reviews check token cost.** New Slack/Pinet tools, dispatcher actions, or
   prompt surfaces should include token-footprint tradeoffs in design and review
   rather than expanding the always-loaded surface by default.

### Adding a new extension

1. Create a directory with `index.ts` and `package.json`
2. Add a `pi` key to `package.json` pointing at the entry file
3. Add the directory to `pnpm-workspace.yaml`
4. Add `tsconfig.json` extending the root config
5. Add `eslint.config.mjs` re-exporting the root config
6. If the extension has tests, add `vitest.config.ts` and a `test` script

### Test policy

See [`plans/test-policy.md`](plans/test-policy.md) for merge-ready test
expectations and the required smoke checklist.

## npm publish readiness

The publishable Pinet/Slack package set is tracked in
[`plans/npm-publish.md`](plans/npm-publish.md) and executed through the manual
[`Publish npm packages`](.github/workflows/npm-publish.yml) GitHub Actions
workflow. The workflow intentionally has no package target selector; it always
validates or publishes the full set in dependency order.

Safe readiness checks are the default path:

1. Open **Actions → Publish npm packages → Run workflow**.
2. Leave `dry_run=true`.
3. Confirm the workflow runs `scripts/publish-npm-packages.mjs --dry-run` for
   the full `@pinet/*` package set and does not request npm credentials.

The same dry-run path can be run locally with `pnpm publish:npm`; it defaults to
readiness only and has no package target selector. The one-time npm org package
creation bootstrap path is `pnpm bootstrap:npm`, which also defaults to dry-run
and prints the full `@pinet/*` package set it would publish.

Real publishes are intentionally harder to trigger. They require a maintainer to
dispatch from `main` with `dry_run=false`, enter `publish all` as the exact
`release_approval` phrase, and approve the protected `npm-publish` environment.
The publish job uses npm Trusted Publishing / GitHub OIDC with
`npm publish --provenance`; it does not use a long-lived npm token. Maintainers must also
configure npm Trusted Publishers for every package in the npm `pinet` org
settings (`https://www.npmjs.com/settings/pinet/packages`) before real publish.
If npm requires packages to exist before Trusted Publishing can be configured,
a `pinet` org owner/admin may use the guarded local bootstrap script only after
maintainer-approved versions are set:

```bash
node ./scripts/bootstrap-npm-packages.mjs \
  --bootstrap-publish \
  --confirm "bootstrap @pinet packages"
```

The maintainer must already be logged in with `npm login` as a `pinet` org
owner/admin. This repo does not add token automation. Immediately after any
successful bootstrap, configure Trusted Publishing for every `@pinet/*` package
and use the GitHub Actions workflow for normal future publishes.

The publish and bootstrap scripts still refuse placeholder `0.0.0` versions and
versions that already exist on npm.

Do not publish, tag, or bump package versions as part of readiness-only changes;
record release notes in `CHANGELOG.md` only when a maintainer approves a real
versioned release.

## Git workflow

1. Branch from `main` — use `feat/`, `fix/`, `chore/` prefixes
2. Write tests for any new logic
3. Run `pnpm lint && pnpm typecheck && pnpm test`
4. Create a PR — merge to `main`

## Contributors

This repo is built by a mesh of human and AI agents coordinating via
[Pinet](slack-bridge/README.md). Names are procedural and can rotate across
sessions, so this section is a snapshot of the agents visible in today's work.
Entries are sourced from the relevant PR, Pinet, and PiComms trail rather than
`git shortlog` alone.

### Today's agents (2026-04-08)

| Agent                       | Contribution                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🦔 **Ember Ivory Hedgehog** | Coordinated the read-only post-merge sweep, opened [#296](https://github.com/gugu91/extensions/issues/296), and turned the browser/Pinet docs drift into a focused README refresh lane.                                                                                                                                                                                                                                   |
| 🦥 **Stellar Ebony Sloth**  | Traced the canonical contributor/acknowledgement locations, confirmed the root README drift after [#282](https://github.com/gugu91/extensions/pull/282), [#289](https://github.com/gugu91/extensions/pull/289), [#292](https://github.com/gugu91/extensions/pull/292), and [#294](https://github.com/gugu91/extensions/pull/294), then refreshed the snapshot in [#296](https://github.com/gugu91/extensions/issues/296). |
| 🐧 **Patch Puffin**         | Approved the Pinet v0.1.1 release-prep metadata and publish-surface review in [PR #288](https://github.com/gugu91/extensions/pull/288).                                                                                                                                                                                                                                                                                   |

### Today's agents (2026-04-03)

| Agent                          | Contribution                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| 🐢 **Thunder Emerald Turtle**  | Merge queue operator (11 PRs rebased & merged), phantom subagent pollution fix (#237 / PR #244). |
| 🦙 **Cobalt Slate Llama**      | RALPH "maintain momentum" message tweak (#246), RALPH broker self-nudge fix (#241 / PR #242).    |
| 🐘 **Jade Rust Elephant**      | Auto-reload on reconnect (#238 / PR #243).                                                       |
| 🦝 **Silver Coral Raccoon**    | npm publish preflight for all 4 packages.                                                        |
| 🐢 **Orbit Lime Turtle 2**     | PR #242 code review.                                                                             |
| 🐘 **Scarlet Bronze Elephant** | PR #244 code review.                                                                             |
| 🫎 **Slate Emerald Moose**     | PR #243 code review.                                                                             |

### Today's agents (2026-04-02)

| Agent                     | Contribution                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🐇 **Ultra Rabbit**       | Built file uploads, scheduled messages, pinning, thread export, the activity log, and the philosophy docs.                                                                                          |
| 🦩 **Cosmic Crane**       | Shipped Slack canvases, broker-specific naming, Block Kit support, the remaining RALPH timestamp work, neon-psql execution-path tests, the broker control-plane canvas, and the thread-routing fix. |
| 🐊 **Silent Crocodile**   | Shipped the deploy command, agent personalities, reaction triggers, user presence checks, the dedup fix, and Slack modals.                                                                          |
| 🐬 **Rocket Dolphin**     | Handled video research, Slack CLI research, the `slack-api` package, npm-readiness work, worktree cleanup, and the idle/free signal.                                                                |
| 🐻 **Crystal Blush Bear** | Fixed the phone input bug in `ai-recruiter`.                                                                                                                                                        |

### Maintainers

- **Will** — coordinates the agent mesh, reviews the flood of PRs, and keeps the
  whole worktree-first workflow pointed in roughly the right direction.

## License

MIT. See [`LICENSE`](LICENSE).
