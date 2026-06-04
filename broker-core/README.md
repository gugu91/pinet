# @pinet/broker-core

Transport-neutral broker kernel primitives for the `extensions` repo.

## What lives here

- broker domain types
- broker SQLite state and persistence
- routing and backlog maintenance logic
- direct/broadcast agent messaging helpers
- broker auth / lock / path / loopback utilities

## What stays out of scope

- Slack adapter and event normalization
- Slack tools, Home tabs, canvases, and manifest concerns
- Pi extension command/tool wiring
- broker runtime orchestration and RALPH UI flows
- follower runtime and single-player runtime glue

## Publishing

This package is part of the full npm publish set tracked in
[`../plans/npm-publish.md`](../plans/npm-publish.md). Use the GitHub Actions
workflow's default dry-run/readiness path for validation; do not publish, tag, or
bump versions without explicit maintainer release approval.
