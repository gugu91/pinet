# @pinet/model-aware-compaction

A Pi extension that triggers proactive compaction at different active-context token limits for different models. It adapts Pi's shipped `trigger-compact.ts` example to multi-model and subagent workloads.

## Install

```bash
pi install npm:@pinet/model-aware-compaction
```

For local development from a clone of this repository, load the source directly:

```bash
pi --extension /path/to/extensions/model-aware-compaction/index.ts
```

## Configure

The extension is disabled by default. Add this to project `.pi/settings.json` or global `~/.pi/agent/settings.json`:

```json
{
  "model-aware-compaction": {
    "enabled": true,
    "rules": [
      { "model": "openai/gpt-5-mini", "activeContextTokens": 100000 },
      { "model": "anthropic/claude-sonnet-4-6", "activeContextTokens": 100000 },
      { "model": "example-proxy/*", "activeContextTokens": 136000 }
    ],
    "customInstructions": "Preserve decisions, files changed, validation results, and next steps.",
    "debug": false
  }
}
```

Rules are evaluated in order. `*` wildcards are supported, such as `example-proxy/*`.

## Behavior

After each `turn_end`, the extension reads `ctx.getContextUsage()` and the active `ctx.model`. When usage first exceeds the matching rule's `activeContextTokens`, it calls `ctx.compact()`. It prevents duplicate calls while compaction is in flight and re-arms after usage drops below the threshold, the model changes, a session starts, or compaction fails.

Run `/model-aware-compaction-status` to inspect the active model, usage, matched threshold, state, and loaded rules.

## Limitation

Pi's extension API makes `ctx.compact()` fire-and-forget. This package is therefore proactive best effort, not an atomic `compact-before-next-provider-request` barrier. Debug logs make trigger/completion/failure visible so that race behavior can be measured. Upstream model-specific settings or an awaitable/deferred compaction seam would provide a stronger guarantee.

## Development

```bash
pnpm --filter @pinet/model-aware-compaction lint
pnpm --filter @pinet/model-aware-compaction typecheck
pnpm --filter @pinet/model-aware-compaction test
pnpm --filter @pinet/model-aware-compaction build
```
