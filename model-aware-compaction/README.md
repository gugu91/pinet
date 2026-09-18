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
    "compactionModel": ["google/gemini-2.5-flash:low", "anthropic/claude-haiku-4-5"],
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

Selectors have the form `provider/model` or `provider/model:level`. The exact text after `/` is resolved first, so registered model IDs containing colons work; only when no exact ID matches is a trailing `:off|minimal|low|medium|high|xhigh|max` treated as a thinking level. Without a level (or with `:off`) summaries go through `ctx.modelRegistry.complete()` with no thinking option, so the provider default applies and existing configurations are unchanged. With a level, summaries take the same route as Pi's own compaction: pi-ai's `completeSimple()` with the registry's resolved credentials and endpoint, which translates the level into each provider's thinking request (Anthropic budget or effort, Gemini `thinkingConfig`, OpenAI reasoning effort). The level is clamped to what the model supports, so a level on a non-reasoning model degrades to provider default; `/model-aware-compaction-status` shows both when they differ. Example: `"compactionModel": "jnj-llm-gateway/gemini-3.8-flash:low"` asks that one gateway model for low thinking while other selectors keep their defaults. Levels are settings-only: the `/model-aware-compaction-model` argument and picker select `provider/model` without a suffix. Note that Gemini counts thinking tokens against the summary's output cap while Anthropic widens the cap for the thinking budget, so prefer `:low` on Gemini or raise Pi's `compaction.reserveTokens` before using higher levels.

### Fallback chain

`compactionModel` accepts a single selector or an ordered list of up to three. Entries are tried in order, and every entry is one you named, so fallback never routes context anywhere the configuration does not list. An entry hands over to the next when its model is unavailable, its credentials cannot be resolved, its context window cannot hold the serialized history plus the output reserve (checked _before_ any request, so a chain can be ordered small-and-cheap → large), or its request fails: provider or rate-limit errors, a length-capped, tool-calling, or empty response. Two things never advance the chain: user or Pi cancellation, and an entry that does not parse as a selector — that is a configuration error and fails closed naming the entry, so a typo cannot shift traffic. A fallback is always logged to stderr (`fell back to <entry> after <entry>: <reason>`), and the summary's compaction details record which entry produced it. A split-turn compaction that fails part-way reruns as a whole on the next entry, so one summary always comes from one model. When every entry fails, compaction is cancelled with each entry's reason.

Precedence is deterministic:

1. `/model-aware-compaction-model` session override (exactly one model; it replaces the whole configured chain)
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

- **No retry wrapper.** Pi wraps each summarization in `retryAssistantCall` with the user's retry settings, which extensions cannot read. A failed request is never retried on the same model; it advances to the next configured chain entry, and only exhausting the chain cancels the compaction.
- **Empty sections are rejected.** Pi persists whatever text a provider returns; this extension fails closed rather than checkpointing an empty summary.
- **Split turn with no new history.** Pi writes the literal `No prior history.` even when a previous summary exists; this extension re-summarizes that previous checkpoint through the update prompt so an earlier checkpoint is never dropped.
- **File metadata.** Pi's `computeFileLists` and `formatFileOperations` are not exported, so they are reimplemented with identical sorting and `<read-files>` / `<modified-files>` output, plus an extension-owned `details` payload that carries file lists across repeated extension compactions.
- **Thinking level.** Pi forwards the session thinking level; this extension uses the selector's explicit `:level` when present and the provider default otherwise, never the session level.
- **Pre-send budget check and failure wording** are extension-owned and have no Pi equivalent.

`enabled` only controls the proactive threshold trigger. It does not disable a configured model for manual or Pi-automatic compaction.

### Failure policy

Configured model selection is **fail closed**. Missing credentials, invalid or unavailable models, oversized inputs, provider failures, length-limited or tool-call responses, and empty generated sections move on to the next configured chain entry, and cancel the compaction when none is left. Non-cancellation failures are written to stderr even without interactive UI. The extension never falls back to the active model or to any model not listed in the chain, so context is not silently sent elsewhere. User cancellation also cancels immediately and never starts fallback work. Remove `compactionModel` (globally and from matching rules) to restore Pi's unchanged default behavior, or use `/model-aware-compaction-off` for the current session only.

After each `agent_settled`, proactive mode reads `ctx.getContextUsage()` and the active `ctx.model`. Waiting for `agent_settled` avoids racing Pi's own automatic compaction/retry lifecycle. It skips a branch whose latest entry is already a compaction and suppresses overlapping or duplicate proactive requests.

## Status and session picker

- `/model-aware-compaction-status` reports the session switch, active model, the compaction chain with each entry's readiness (credentials, availability, and a heuristic window check comparing the model's context window with the session's current token count) and effective thinking level, usage, matched threshold, config source, and per-rule chains.
- `/model-aware-compaction-off` disables the extension for the current session — no proactive triggering and no compaction-model routing, so Pi's stock compaction on the active model applies — and `/model-aware-compaction-on` re-enables it. Session-only; nothing is written to settings. Persistent off is `enabled: false` with no `compactionModel`.
- `/model-aware-compaction-model` selects a session-only override and does not edit project or user settings. In the TUI it opens Pi's own `/model` picker (`ModelSelectorComponent`, a package-root export) with the same `--models`/`enabledModels` shortlist, type-to-filter search, `Tab` to toggle between the scoped list and all authenticated models, and `Esc` to keep the current selection. The active compaction model is pre-highlighted when it is in the current scope. Outside the TUI (RPC hosts), where custom components are unavailable, the command falls back to a flat select list. The picker reads the catalog through the extension `modelRegistry` facade; only package-root exports are used.
- `/model-aware-compaction-model <provider/model>` sets the session override without opening the picker. The argument accepts the same surface as the picker: an exact `provider/model` id of any authenticated model, or a bare model id when it is unambiguous within the shortlist. `default` (or `reset`) clears a session override and restores the configured chain; anything else is rejected with the reason.
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
