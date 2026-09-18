import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
  compactionInputError,
  compactionModelChoices,
  decideCompaction,
  describeThinking,
  effectiveThinkingLevel,
  limitForModel,
  matchesModel,
  modelKey,
  parseCompactionSelector,
  resolveCompactionModelArgument,
  chainForModel,
} from "./helpers.js";

const rules = [
  { model: "openai/gpt-5-mini", activeContextTokens: 100_000 },
  { model: "example-proxy/*", activeContextTokens: 136_000 },
];

describe("model matching", () => {
  it("normalizes provider-prefixed ids without doubling the provider", () => {
    expect(modelKey({ provider: "OpenAI", id: "openai/gpt-5-mini" })).toBe("openai/gpt-5-mini");
  });

  it("supports exact and wildcard rules in declared order", () => {
    expect(matchesModel("example-proxy/*", "example-proxy/frontier-model")).toBe(true);
    expect(limitForModel(rules, "openai/gpt-5-mini")).toBe(100_000);
    expect(limitForModel(rules, "example-proxy/frontier-model")).toBe(136_000);
  });
});

describe("compaction model selection", () => {
  it("parses thinking suffixes while preserving exact ids with colons", () => {
    expect(parseCompactionSelector("anthropic/claude-sonnet:high")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet",
      thinkingOverride: "high",
    });
    expect(parseCompactionSelector("bedrock/arn:aws:model:off")).toEqual({
      provider: "bedrock",
      modelId: "arn:aws:model",
      thinkingOverride: "off",
    });
    expect(
      parseCompactionSelector(
        "openai/model:high",
        (provider, modelId) => provider === "openai" && modelId === "model:high",
      ),
    ).toEqual({ provider: "openai", modelId: "model:high" });
    expect(parseCompactionSelector("missing-provider")).toBeNull();
  });

  it("uses a matching rule chain before the global chain", () => {
    expect(
      chainForModel(
        [{ ...rules[0], compactionModels: ["anthropic/rule-model:low", "b/fallback"] }],
        "openai/gpt-5-mini",
        ["google/global-model"],
      ),
    ).toEqual(["anthropic/rule-model:low", "b/fallback"]);
    expect(chainForModel(rules, "openai/gpt-5-mini", ["google/global-model"])).toEqual([
      "google/global-model",
    ]);
    expect(chainForModel(rules, null, [])).toEqual([]);
  });

  it("rejects serialized requests that do not leave the output reserve", () => {
    // 4_000 serialized chars fit a 2_600 window on their own; the verbatim Pi 0.85.1
    // system and summarization prompts are what push the request over the limit.
    expect(
      compactionInputError({
        serializedHistory: "x".repeat(4_000),
        serializedTurnPrefix: "",
        contextWindow: 2_600,
        outputReserve: 1_000,
      }),
    ).toContain("exceeds selected model context window");
    expect(
      compactionInputError({
        serializedHistory: "",
        serializedTurnPrefix: "prefix",
        previousSummary: "x".repeat(80_000),
        customInstructions: "Preserve the prior checkpoint.",
        contextWindow: 10_000,
        outputReserve: 1_000,
      }),
    ).toContain("exceeds selected model context window");
    // A split turn with no new history sends only the turn-prefix request, which uses
    // Pi's smaller 0.5 * reserveTokens output budget.
    expect(
      compactionInputError({
        serializedHistory: "",
        serializedTurnPrefix: "x".repeat(4_000),
        contextWindow: 2_200,
        outputReserve: 400,
        prefixOutputReserve: 600,
      }),
    ).toContain("exceeds selected model context window");
    expect(
      compactionInputError({
        serializedHistory: "short",
        serializedTurnPrefix: "",
        contextWindow: 20_000,
        outputReserve: 1_000,
      }),
    ).toBeNull();
  });
});

describe("compaction decisions", () => {
  const base = {
    enabled: true,
    model: { provider: "openai", id: "gpt-5-mini" },
    rules,
    inFlight: false,
    triggeredModelKey: null,
  };

  it("triggers when the first observed turn is already over the model limit", () => {
    expect(decideCompaction({ ...base, tokens: 100_001 })).toMatchObject({
      shouldCompact: true,
      reason: "over-limit",
    });
  });

  it("does not trigger below the limit", () => {
    expect(decideCompaction({ ...base, tokens: 100_000 })).toMatchObject({
      shouldCompact: false,
      reason: "below-limit",
    });
  });

  it("suppresses duplicate attempts while in flight or already triggered", () => {
    expect(decideCompaction({ ...base, tokens: 120_000, inFlight: true })).toMatchObject({
      shouldCompact: false,
      reason: "in-flight",
    });
    expect(
      decideCompaction({ ...base, tokens: 120_000, triggeredModelKey: "openai/gpt-5-mini" }),
    ).toMatchObject({ shouldCompact: false, reason: "already-triggered" });
  });
});

describe("session model picker", () => {
  const scopedModels = [
    { model: { provider: "anthropic", id: "claude-haiku-4-5" } },
    { model: { provider: "openai-codex", id: "gpt-5.6-luna" }, thinkingLevel: "low" as const },
  ];
  const availableModels = [
    { provider: "anthropic", id: "claude-haiku-4-5" },
    { provider: "openai-codex", id: "gpt-5.6-luna" },
    { provider: "openai", id: "gpt-5-mini" },
  ];

  it("offers only the session shortlist and annotates the active selector", () => {
    const choices = compactionModelChoices({
      scopedModels,
      availableModels,
      configuredSelector: "anthropic/claude-haiku-4-5",
      activeSelector: "anthropic/claude-haiku-4-5",
    });
    expect(choices).toEqual([
      { label: "Use configured selector (anthropic/claude-haiku-4-5)", selector: undefined },
      { label: "anthropic/claude-haiku-4-5 (current)", selector: "anthropic/claude-haiku-4-5" },
      { label: "openai-codex/gpt-5.6-luna (thinking: low)", selector: "openai-codex/gpt-5.6-luna" },
    ]);
  });

  it("offers every authenticated model when the session is unscoped", () => {
    const choices = compactionModelChoices({ scopedModels: [], availableModels });
    expect(choices.map((choice) => choice.selector)).toEqual([
      undefined,
      "anthropic/claude-haiku-4-5",
      "openai-codex/gpt-5.6-luna",
      "openai/gpt-5-mini",
    ]);
    expect(choices[0].label).toBe("Use configured selector (Pi default)");
  });

  it("resolves bare ids inside the shortlist and exact ids across authenticated models", () => {
    const choices = compactionModelChoices({ scopedModels, availableModels });
    const available = availableModels.map((model) => `${model.provider}/${model.id}`);
    expect(resolveCompactionModelArgument("openai-codex/gpt-5.6-luna", choices, available)).toEqual(
      { selector: "openai-codex/gpt-5.6-luna" },
    );
    expect(resolveCompactionModelArgument("claude-haiku-4-5", choices, available)).toEqual({
      selector: "anthropic/claude-haiku-4-5",
    });
    expect(resolveCompactionModelArgument("default", choices, available)).toEqual({
      selector: undefined,
    });
    // Same surface as the picker's Tab-to-all: exact ids may leave the shortlist…
    expect(resolveCompactionModelArgument("openai/gpt-5-mini", choices, available)).toEqual({
      selector: "openai/gpt-5-mini",
    });
    // …but bare ids and unauthenticated models may not.
    expect(resolveCompactionModelArgument("gpt-5-mini", choices, available)).toMatchObject({
      error: expect.stringContaining("not an authenticated provider/model id"),
    });
    expect(resolveCompactionModelArgument("openai/gpt-9", choices, available)).toMatchObject({
      error: expect.stringContaining("not an authenticated provider/model id"),
    });
  });

  it("rejects an ambiguous bare model id instead of guessing a provider", () => {
    const choices = compactionModelChoices({
      scopedModels: [],
      availableModels: [
        { provider: "anthropic", id: "claude-haiku-4-5" },
        { provider: "github-copilot", id: "claude-haiku-4-5" },
      ],
    });
    expect(resolveCompactionModelArgument("claude-haiku-4-5", choices)).toMatchObject({
      error: expect.stringContaining("use the full provider/model id"),
    });
  });
});

describe("effective thinking level", () => {
  const model = (reasoning: boolean): Model<Api> => ({
    api: "anthropic-messages",
    provider: "anthropic",
    id: reasoning ? "thinker" : "plain",
    name: "Model",
    baseUrl: "https://api.anthropic.com",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  });

  it("sends nothing without a level or for off, and clamps to what the model supports", () => {
    expect(effectiveThinkingLevel(model(true), undefined)).toBeUndefined();
    expect(effectiveThinkingLevel(model(true), "off")).toBeUndefined();
    expect(effectiveThinkingLevel(model(true), "low")).toBe("low");
    // Pi clamps a level on a non-reasoning model to off instead of failing.
    expect(effectiveThinkingLevel(model(false), "high")).toBeUndefined();
  });

  it("describes configured versus effective thinking for status", () => {
    expect(describeThinking(model(true), undefined)).toBe("provider default");
    expect(describeThinking(model(true), "off")).toBe("provider default");
    expect(describeThinking(model(true), "low")).toBe("low");
    expect(describeThinking(model(false), "high")).toBe("high (effective: off)");
    expect(describeThinking(undefined, "high")).toBe("high");
  });
});
