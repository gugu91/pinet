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
    "compactionModel": "google/gemini-2.5-flash",
    "rules": [
      {
        "model": "openai/gpt-5-mini",
        "activeContextTokens": 100000,
        "compactionModel": "anthropic/claude-haiku-4-5"
      },
      { "model": "anthropic/claude-sonnet-4-6", "activeContextTokens": 100000 },
      { "model": "example-proxy/*", "activeContextTokens": 136000 }
    ],
    "customInstructions": "Preserve decisions, files changed, validation results, and next steps.",
    "debug": false
  }
}
```

Selectors have the form `provider/model`. The exact text after `/` is resolved first, so registered model IDs containing colons work. This release does not override thinking: the selected provider/model uses its provider default. A recognized appended suffix such as `:high` is rejected with an actionable error unless it is part of an exact registered model ID.

Precedence is deterministic:

1. `/model-aware-compaction-model` session override
2. `compactionModel` on the first matching rule
3. extension-level `compactionModel`
4. Pi's active model and normal compaction behavior when none is configured

A project `model-aware-compaction` object overrides the entire global object. Within one object, rules are evaluated in order and support `*` wildcards. This whole-object precedence keeps project configuration explicit and prevents an ambient global selector from unexpectedly receiving project context.

## Behavior

A configured selector intercepts `session_before_compact`, so it covers manual `/compact`, Pi's automatic threshold and overflow recovery, and compaction initiated by this extension. It does not alter the active session model or thinking level. The extension follows Pi's official custom-compaction pattern and sends each summary section through `ctx.modelRegistry.complete()`, so registry credentials, dynamic endpoints, and custom providers remain authoritative. Its focused compaction assembly preserves:

- previous summaries and split-turn prefix summaries
- first-kept-entry boundaries
- cumulative read/modified file tracking across repeated extension-owned compactions
- manual and configured custom instructions
- compaction usage accounting
- cancellation via Pi's abort signal

Before sending anything, the extension estimates each summarization request — system prompt, conversation tags, previous summary, custom focus, and the full Pi prompt body — and verifies that it plus that request's output reserve fits the selected model's context window. It does not truncate history.

### Pi prompt parity

Summarization requests reproduce Pi 0.85.1 exactly: the same system prompt, the same `<conversation>` / `<previous-summary>` ordering, the same initial, update, and turn-prefix prompt bodies, the same `\n\nAdditional focus: ` custom-instruction suffix, the same `0.8 * reserveTokens` and `0.5 * reserveTokens` output budgets, `cacheRetention: "none"`, a fresh routing session ID per request, and the same `"**Turn Context (split turn):**"` split-turn wrapper.

Pi's package `exports` map publishes only its root entry, so the prompt constants in `dist/core/compaction/compaction.js` (`SUMMARIZATION_PROMPT`, `UPDATE_SUMMARIZATION_INSTRUCTIONS`, `UPDATE_SUMMARIZATION_PROMPT`, `TURN_PREFIX_SUMMARIZATION_PROMPT`) and `dist/core/compaction/utils.js` (`SUMMARIZATION_SYSTEM_PROMPT`) cannot be imported. They are copied verbatim into `prompts.ts` with source-file attribution and a pinned version anchor, and `prompts.test.ts` re-reads the installed SDK files so any upstream prompt change fails the test suite. Genuinely exported helpers are used directly: `convertToLlm` and `serializeConversation` from `@earendil-works/pi-coding-agent`, `contentText` and `uuidv7` from `@earendil-works/pi-ai`.

Remaining deviations from Pi's own compaction, all deliberate:

- **No retry wrapper.** Pi wraps each summarization in `retryAssistantCall` with the user's retry settings, which extensions cannot read. A failed request cancels the compaction instead of being retried.
- **Empty sections are rejected.** Pi persists whatever text a provider returns; this extension fails closed rather than checkpointing an empty summary.
- **Split turn with no new history.** Pi writes the literal `No prior history.` even when a previous summary exists; this extension re-summarizes that previous checkpoint through the update prompt so an earlier checkpoint is never dropped.
- **File metadata.** Pi's `computeFileLists` and `formatFileOperations` are not exported, so they are reimplemented with identical sorting and `<read-files>` / `<modified-files>` output, plus an extension-owned `details` payload that carries file lists across repeated extension compactions.
- **Thinking level.** Pi forwards the session thinking level; this release always uses the selected provider's default.
- **Pre-send budget check and failure wording** are extension-owned and have no Pi equivalent.

`enabled` only controls the proactive threshold trigger. It does not disable a configured model for manual or Pi-automatic compaction.

### Failure policy

Configured model selection is **fail closed**. Missing credentials, invalid or unavailable models, thinking-override suffixes, oversized inputs, provider failures, length-limited or tool-call responses, and empty generated sections cancel that compaction. Non-cancellation failures are written to stderr even without interactive UI. The extension never falls back to the active model or another provider, so context is not silently sent elsewhere. User cancellation also cancels immediately and never starts fallback work. Remove `compactionModel` (globally and from matching rules) to restore Pi's unchanged default fallback behavior.

After each `agent_settled`, proactive mode reads `ctx.getContextUsage()` and the active `ctx.model`. Waiting for `agent_settled` avoids racing Pi's own automatic compaction/retry lifecycle. It skips a branch whose latest entry is already a compaction and suppresses overlapping or duplicate proactive requests.

## Status and session picker

- `/model-aware-compaction-status` reports the active model, selector, provider-default thinking policy, credential readiness, usage, matched threshold, config source, and per-rule overrides.
- `/model-aware-compaction-model` selects a session-only override and does not edit project or user settings. It offers the same shortlist `/model` uses: `ctx.scopedModels` (your `--models`/`enabledModels` scope) when the session is scoped, and every authenticated model otherwise, so the picker can never widen the model surface past `/model`. Entries show a pinned thinking level and mark the current selection.
- `/model-aware-compaction-model <provider/model>` sets the session override without opening the picker. A bare model id is accepted when it is unambiguous in the shortlist, `default` (or `reset`) restores the configured selector, and anything outside the shortlist is rejected with the reason.
- The extension deliberately claims no persistent footer status entry. The selector is reported on demand by `/model-aware-compaction-status` instead of occupying the status bar for every turn.

The commands add no LLM tool schema or always-present prompt content.

## Limitation

Pi's `ctx.compact()` remains fire-and-forget, so the proactive trigger is best effort rather than an atomic barrier. Pi owns the manual/automatic compaction barrier and awaits `session_before_compact` there.

Selected-model summaries and marked file metadata use extension-owned contracts because Pi 0.85.1 does not expose its registry-backed simple stream to extensions or automatically carry `fromHook` compaction details forward. Tests pin the prompts and the external compaction contract against the installed SDK, but a future Pi prompt or assembly change requires a matching update here.

## Development

```bash
pnpm --filter @pinet/model-aware-compaction lint
pnpm --filter @pinet/model-aware-compaction typecheck
pnpm --filter @pinet/model-aware-compaction test
pnpm --filter @pinet/model-aware-compaction build
```
