# Pinet website

Astro site for Pinet, covering pinet-core and the Slack bridge.

- `/` — what Pinet is, the life of a message, operating principles, quick start
- `/core/` — runtime modes, the message primitive, agent identity, RALPH, the dispatcher, `@pinet/pinet-core`
- `/slack-bridge/` — app manifest setup, tokens, access control, configuration reference, security, troubleshooting

## Develop

This directory is a standalone pnpm project. Its `pnpm-workspace.yaml` is a
boundary marker that keeps it outside the monorepo workspace and the turbo
lint/typecheck/test pipelines.

```bash
cd website
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # static output in dist/
pnpm preview
```

## Design system

Standards-document aesthetic: a two-ink print job. Black and red on white,
like an RFC, an ISO spec, or an engineering datasheet. System fonts only
(Helvetica/Arial + the platform monospace) — zero webfont payload. Hairline
rules, numbered sections, dense tables. Red is functional annotation, never
decoration. No gradients, no glow, no glass, no card grids, no sticky chrome.

Two deliberate refusals worth preserving:

1. **No dark-SaaS surface** — near-black + green/amber accent was 10/11 of the
   generated corpus (see below).
2. **No "tasteful AI editorial" surface** — warm cream + literary serif + a
   refined accent (terracotta, Klein blue) is the second-order default that
   models reach for when told to avoid the first. Earlier drafts of this site
   landed there twice. White + grotesque + functional red is the break.

Design context for agents lives in [`PRODUCT.md`](PRODUCT.md) and
[`DESIGN.md`](DESIGN.md) (impeccable-compatible). The site passes
[impeccable](https://github.com/pbakaus/impeccable)'s deterministic detector
with zero findings; the two inline waivers in `Base.astro` carry their reasons.

The design and copy were also iterated against an
[unslop](https://github.com/mshumer/unslop) run over 11 generated developer-tool
landing pages:

- [`design/unslop-profile.md`](design/unslop-profile.md) — the distilled
  "what to avoid" profile. Read it before restyling anything.
- [`design/unslop-analysis.md`](design/unslop-analysis.md) — the full counted
  pattern analysis the profile is based on.

Content is sourced from the repository README, `slack-bridge/README.md`,
`pinet-core/README.md`, and `plans/pinet-vision.md`. When those change, keep
the site in step.

## Deploy

Not wired up yet. For GitHub Pages or similar, set `site` (and `base` for
project sub-paths) in `astro.config.mjs`, then publish `dist/`.
