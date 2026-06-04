# @pinet/pinet-core

Runtime-core helpers for Pinet that are independent of any Slack adapter.

Current seam:

- Pinet output option normalization (`cli` default, explicit `json`/`full` opt-ins)
- durable Pinet read result text/detail formatting
- scheduled wake-up time parsing and thread ID helpers

`@pinet/slack-bridge` still composes the extension and preserves compatibility wrappers, but these helpers now live behind package exports so future extraction can move one boundary at a time.

Design proposal: `plans/slack-split-proposal.md`

## Publishing

This package is included in the full npm publish set tracked in
[`../plans/npm-publish.md`](../plans/npm-publish.md). Use the GitHub Actions
workflow's default dry-run/readiness path for validation; do not publish, tag, or
bump versions without explicit maintainer release approval.
