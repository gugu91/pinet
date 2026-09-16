import { describe, expect, it } from "vitest";
import {
  compactionInputError,
  decideCompaction,
  limitForModel,
  matchesModel,
  modelKey,
  parseCompactionSelector,
  selectorForModel,
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
  it("detects unsupported thinking suffixes while preserving exact ids with colons", () => {
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

  it("uses a matching rule selector before the global selector", () => {
    expect(
      selectorForModel(
        [{ ...rules[0], compactionModel: "anthropic/rule-model:low" }],
        "openai/gpt-5-mini",
        "google/global-model",
      ),
    ).toBe("anthropic/rule-model:low");
    expect(selectorForModel(rules, "openai/gpt-5-mini", "google/global-model")).toBe(
      "google/global-model",
    );
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
