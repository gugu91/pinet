# Extensions Repo — Agent Guidelines

Pi extensions for Slack, Neovim, and Neon Postgres.

## Structure

```
extensions/
├── slack-bridge/    # Pinet — Slack assistant integration (workspace)
├── nvim-bridge/     # Neovim bridge; PiComms disabled pending Pinet adapter
├── neon-psql/       # Neon Postgres CLI (workspace)
├── types/           # Shared type declarations (workspace)
├── plans/           # Architecture docs
├── .pi/             # Pi config (skills, agents)
├── turbo.json       # Turborepo task orchestration
└── pnpm-workspace.yaml
```

## Commands

```bash
pnpm lint          # ESLint across all extensions (turbo-cached)
pnpm typecheck     # TypeScript strict check (turbo-cached)
pnpm test          # Vitest — all tests (turbo-cached)
pnpm prepush       # lint + typecheck + test (runs on git push)
pnpm format        # Prettier + Stylua
```

Turbo caches lint/typecheck/test results per-package. Unchanged packages
are skipped on re-runs.

## Worktree rules

- NEVER work directly on `main` or checkout feature branches in the main repo directory.
- ALWAYS create a git worktree: `git worktree add .worktrees/<name> -b <branch>` and `cd` into it before making changes.
- In a fresh worktree, run `pnpm install --frozen-lockfile` before `pnpm lint`, `pnpm typecheck`, `pnpm test`, or `pnpm prepush`. Dependency bootstrap is per checkout/worktree, not a one-time repo setup step.
- If the lane exercises live browser launches and no compatible host browser is available, run `cd browser-playwright && npx playwright install chromium` in that worktree.
- If you are already in a worktree, stay there. Do not `cd` back to the main checkout.
- When your PR is merged, clean up: `git worktree remove .worktrees/<name>` from the main checkout.
- NEVER run `git checkout <branch>` or `git switch <branch>` in the main repo checkout. It must always be on `main`.

## Development workflow

1. **Branch** from `main` — use `feat/`, `fix/`, `chore/` prefixes
2. **Write tests** for any new logic — extract pure functions into `helpers.ts` files and test them
3. **Check locally**: `pnpm lint && pnpm typecheck && pnpm test`
4. **Create a PR** — base on `main` (or stack on a feature branch)
5. **Request review** — use the `code-reviewer` subagent (see below)
6. **Address feedback**, then merge

## Code review

Always request a review before merging:

```
Use the code-reviewer subagent to review PR #N
```

The reviewer posts findings to PiComms and GitHub. Fix any critical/warning issues before merging.

## Testing

- Test runner: **Vitest**
- Tests live next to source: `foo.ts` → `foo.test.ts`
- Extract testable logic into `helpers.ts` — keep `index.ts` for extension wiring
- Tests run on **pre-push** hook (via husky)
- Use temp directories for filesystem tests, clean up in `afterEach`
- Per-package test scripts run via Turborepo

## Conventions

- **Zero npm runtime deps** — use native Node.js APIs (`node:fs`, `node:sqlite`, `fetch`, `WebSocket`)
- **TypeScript strict mode** — no `any`, no implicit returns
- **Prettier** for formatting (auto-runs via lint-staged on commit)
- **ESLint** with `typescript-eslint`
- Config in `~/.pi/agent/settings.json` under extension name key
- Env vars as fallback for secrets

## GitHub

- Remote: `github.com:gugu91/extensions.git`
- Auth: `GH_TOKEN=$(gh auth token --user gugu91)` prefix for `gh` commands
- Create PRs with `gh pr create`
- Merge with `gh pr merge`
- npm publish readiness lives in `.github/workflows/npm-publish.yml` and `plans/npm-publish.md`. Do not run real publishes, tag, or bump versions without explicit maintainer release approval.

## Extension patterns

Design every extension with token-efficient progressive discovery. This is
especially important for Pinet / `slack-bridge`, where large Slack/Pinet action
families can otherwise bloat every agent turn. See #566 and #581 for the design
pressure behind this guideline.

- Keep hot-path dedicated tool schemas compact, high-signal, and justified by
  frequent per-turn use.
- Collapse large homogeneous cold action families behind a compact dispatcher
  with structured `help` and per-action schema discovery.
- Keep cold-path templates, examples, API recipes, and recovery playbooks in
  lazily loaded skills/docs instead of always-present prompts or tool schemas.
- Avoid expanding prompt/tool schema footprint unless the token cost is clearly
  justified; include token-footprint tradeoffs in reviews for new Slack/Pinet
  tools, dispatcher actions, or prompt surfaces.
- Return structured contracts such as `{ status, data, errors, warnings }` for
  dispatcher actions, with typed errors and recovery hints.
- Preserve precise guardrails with action-level names such as
  `slack:upload` or `<extension>:<action>`.

Each extension is a workspace package with a `package.json` that declares the
`pi` manifest and an `index.ts` entry point:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register tools, commands, event handlers
  pi.registerTool("tool_name", { ... });
  pi.registerCommand("cmd", { ... });
  pi.on("session_start", async (event, ctx) => { ... });
}
```

```json
// package.json
{
  "name": "@pinet/slack-bridge",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./index.ts"] }
}
```

## Key architecture decisions

- **Pinet (slack-bridge)**: Opt-in via `/pinet` command or `autoConnect: true` in settings
- **nvim PiComms**: Disabled in `nvim-bridge`; use Pinet directly while the replacement nvim adapter is tracked in #714
- **Socket Mode**: Single WebSocket per Slack app token — only one pi session connects
- **Turborepo**: Per-package lint/typecheck/test with local caching
- **pnpm workspaces**: Each extension is an independent workspace package
