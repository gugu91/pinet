import { describe, expect, it } from "vitest";
import { decideCompaction, limitForModel, matchesModel, modelKey } from "./helpers.js";

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
