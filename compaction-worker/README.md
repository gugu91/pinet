# Pi Compaction Worker

Opt-in Pi extension for model-aware custom compaction.

It provides an extension-first slice for issue #595:

- resolves per-model/profile compaction budgets;
- starts a side summary job at a configurable prepare threshold;
- triggers compaction at a later threshold;
- validates prepared summaries against the current session/branch before use;
- falls back to live custom compaction, then Pi default compaction, on any failure.

The extension is disabled by default.

## Configuration

Add settings under `compaction-worker` in `.pi/settings.json` or `~/.pi/agent/settings.json`:

```jsonc
{
  "compaction-worker": {
    "enabled": true,
    "prepareAtPercent": 60,
    "triggerAtPercent": 75,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "summaryModels": ["google/gemini-2.5-flash"],
    "profiles": {
      "opus": {
        "match": "anthropic/claude-opus-*",
        "prepareAtPercent": 55,
        "triggerAtPercent": 70,
        "keepRecentTokens": 100000,
      },
    },
  },
}
```

Use `/compaction-worker-status` to inspect the active model, matched profile, thresholds, and prepared-summary state.

## Boundaries

This is an extension-side proactive policy. Pi core still owns built-in auto-compaction and overflow recovery thresholds. If a prepared summary is stale, divergent, expired, or incompatible with the current model/profile, the extension generates a live summary or falls back to Pi default compaction.
