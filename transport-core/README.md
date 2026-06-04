# @gugu910/pi-transport-core

Tiny transport-neutral contracts package for the `extensions` repo.

## What lives here

- canonical `InboundMessage` contract
- canonical `OutboundMessage` contract
- normalized outbound `content` shape for transport-aware rendering with plain-text fallback
- canonical `MessageAdapter` transport interface

## What stays out of scope

- broker state
- routing
- socket server/client logic
- Slack-specific normalization
- iMessage-specific AppleScript or readiness logic
- Pi extension commands/tools

This package exists to keep transport contracts transport-neutral while other packages decide how to route, persist, or render those messages.

## Publishing

This package is part of both manual npm publish lanes tracked in
[`../plans/npm-publish.md`](../plans/npm-publish.md). Use the GitHub Actions
workflow's default dry-run/readiness path for validation; do not publish, tag, or
bump versions without explicit maintainer release approval.

## Outbound content rules

`OutboundMessage.text` remains the backward-compatible plain-text fallback and persistence body.

When richer transport-aware rendering is available, callers may also send `OutboundMessage.content`:

- `content.text`: canonical plain-text body
- `content.markdown`: optional markdown-friendly representation for markdown-capable text renderers or exports
- `content.slackBlocks`: optional prebuilt Slack Block Kit payload

Transports should prefer their transport-specific representation when present, then fall back to the canonical plain-text body:

1. transport-native content (`slackBlocks` for Slack)
2. plain `text`

`markdown` is supplementary for markdown-aware surfaces and should not replace the canonical plain-text body on plain-text transports like iMessage.

This keeps Slack, markdown-oriented exports, and plain-text sends aligned without requiring every caller to collapse everything into one presentation string upfront.
