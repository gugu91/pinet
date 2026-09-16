# @pinet/model-aware-compaction

A Pi extension for proactive model-aware context limits and optional compaction with a model independent of the active conversation model.

## Install

Requires Pi `>=0.85.1` for usage-preserving custom compaction and resolved provider authentication.

```bash
pi install npm:@pinet/model-aware-compaction
```

For local development from a clone of this repository:

```bash
pi --extension /path/to/extensions/model-aware-compaction/index.ts
```

## Configure

The proactive trigger is disabled by default. Model selection is independent: when `compactionModel` is omitted, all manual and automatic compactions retain Pi's default behavior.

Add settings to project `.pi/settings.json` or global `~/.pi/agent/settings.json`:

```json
{
  "model-aware-compaction": {
    "enabled": true,
    "compactionModel": "google/gemini-2.5-flash:off",
    "rules": [
      {
        "model": "openai/gpt-5-mini",
        "activeContextTokens": 100000,
        "compactionModel": "anthropic/claude-haiku-4-5:low"
      },
      { "model": "anthropic/claude-sonnet-4-6", "activeContextTokens": 100000 },
      { "model": "example-proxy/*", "activeContextTokens": 136000 }
    ],
    "customInstructions": "Preserve decisions, files changed, validation results, and next steps.",
    "debug": false
  }
}
```

Selectors have the form `provider/model:thinking`. Thinking defaults to `off`; supported values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Provider and model are resolved as an exact pair through Pi's model registry. Unsupported thinking levels are rejected.

Precedence is deterministic:

1. `/model-aware-compaction-model` session override
2. `compactionModel` on the first matching rule
3. extension-level `compactionModel`
4. Pi's active model and normal compaction behavior when none is configured

A project `model-aware-compaction` object overrides the entire global object. Within one object, rules are evaluated in order and support `*` wildcards. This whole-object precedence keeps project configuration explicit and prevents an ambient global selector from unexpectedly receiving project context.

## Behavior

A configured selector intercepts `session_before_compact`, so it covers manual `/compact`, Pi's automatic threshold and overflow recovery, and compaction initiated by this extension. It does not alter the active session model or thinking level. The extension resolves credentials through Pi's registry and calls Pi's `compact()` primitive with the selected model, preserving:

- previous summaries and split-turn prefix summaries
- first-kept-entry boundaries
- cumulative read/modified file tracking
- manual and configured custom instructions
- compaction usage accounting
- cancellation via Pi's abort signal

Before sending anything, the extension estimates each serialized summarization request and verifies that it plus the output reserve fits the selected model's context window. It does not truncate history.

`enabled` only controls the proactive threshold trigger. It does not disable a configured model for manual or Pi-automatic compaction.

### Failure policy

Configured model selection is **fail closed**. Missing credentials, invalid or unavailable models, unsupported thinking, oversized inputs, provider failures, tool-call responses, and empty summaries cancel that compaction. The extension never falls back to the active model or another provider, so context is not silently sent elsewhere. User cancellation also cancels immediately and never starts fallback work. Remove `compactionModel` (globally and from matching rules) to restore Pi's unchanged default fallback behavior.

After each `agent_settled`, proactive mode reads `ctx.getContextUsage()` and the active `ctx.model`. Waiting for `agent_settled` avoids racing Pi's own automatic compaction/retry lifecycle. It skips a branch whose latest entry is already a compaction and suppresses overlapping or duplicate proactive requests.

## Status and session picker

- `/model-aware-compaction-status` reports the active model, resolved selector, availability, usage, matched threshold, config source, and per-rule overrides.
- `/model-aware-compaction-model` selects a session-only override. It uses `ctx.scopedModels` when the session has a model scope and otherwise uses authenticated available models. It does not edit project or user settings.
- A compact footer status shows the current selector when configured.

The commands add no LLM tool schema or always-present prompt content.

## Limitation

Pi's `ctx.compact()` remains fire-and-forget, so the proactive trigger is best effort rather than an atomic barrier. Pi owns the manual/automatic compaction barrier and awaits `session_before_compact` there.

## Development

```bash
pnpm --filter @pinet/model-aware-compaction lint
pnpm --filter @pinet/model-aware-compaction typecheck
pnpm --filter @pinet/model-aware-compaction test
pnpm --filter @pinet/model-aware-compaction build
```
