# @pinet/pinet-core

Runtime helpers for Pinet that work independently of Slack.

## What it does

This package provides:

- output option normalisation (defaults to `cli`, accepts `json` or `full`)
- durable read result formatting
- scheduled wake-up time parsing
- thread ID helpers

## How it works

The package exports helpers that `@pinet/slack-bridge` uses internally. These functions handle Pinet operations without depending on Slack adapters.

The helpers live behind package exports. Future changes can move functionality one boundary at a time.

See the design proposal in `plans/slack-split-proposal.md`.

## Publishing

This package is part of the npm publish set in [`../plans/npm-publish.md`](../plans/npm-publish.md).

Do not publish, tag, or bump versions without maintainer approval. Use the GitHub Actions workflow for validation.
