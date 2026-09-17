import type { Api, Context, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { thinkingComplete, type RegistryComplete } from "./selected-compaction.js";

/**
 * Drives the real pi-ai adapters (not a mock) so that the `:level` transport is checked
 * against the request each provider would actually send. `onPayload` captures the
 * built request and throws, so no network call is made.
 */
const context: Context = {
  systemPrompt: "system",
  messages: [{ role: "user", content: [{ type: "text", text: "summarize" }], timestamp: 1 }],
};

/** The slice of each provider's wire request that a thinking level must shape. */
interface AnthropicWire {
  model: string;
  max_tokens: number;
  thinking?: { type: "enabled" | "disabled"; budget_tokens?: number };
}
interface GeminiWire {
  config: { maxOutputTokens?: number; thinkingConfig?: { thinkingBudget?: number } };
}

// `onPayload` is a pi-ai StreamOptions hook that thinkingComplete must forward untouched.
type PayloadOptions<Wire> = Parameters<RegistryComplete>[2] & {
  onPayload: (payload: Wire) => never;
};

async function capturePayload<Wire>(model: Model<Api>, level: "low" | "medium"): Promise<Wire> {
  let captured: Wire | undefined;
  const options: PayloadOptions<Wire> = {
    maxTokens: 1_600,
    signal: new AbortController().signal,
    cacheRetention: "none",
    sessionId: "session",
    onPayload: (payload) => {
      captured = payload;
      throw new Error("captured");
    },
  };
  const response = await thinkingComplete(
    { apiKey: "test-key", baseUrl: "https://example.invalid" },
    level,
  )(model, context, options);
  expect(response.stopReason).toBe("error");
  expect(response.errorMessage).toContain("captured");
  if (!captured) throw new Error("adapter never built a request");
  return captured;
}

describe("thinking transport", () => {
  it("translates the level into Anthropic budget thinking and widens max_tokens for it", async () => {
    const model: Model<"anthropic-messages"> = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-test",
      name: "Claude Test",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    };
    const payload = await capturePayload<AnthropicWire>(model, "low");
    expect(payload.model).toBe("claude-test");
    expect(payload.thinking?.type).toBe("enabled");
    const budget = payload.thinking?.budget_tokens ?? 0;
    expect(budget).toBeGreaterThan(0);
    // Anthropic adds the budget on top of the caller's cap, keeping answer room.
    expect(payload.max_tokens).toBeGreaterThan(1_600);
    expect(payload.max_tokens - budget).toBeGreaterThanOrEqual(1_024);
  });

  it("translates the level into Gemini thinkingConfig", async () => {
    const model: Model<"google-generative-ai"> = {
      api: "google-generative-ai",
      provider: "google",
      id: "gemini-2.5-flash",
      name: "Gemini Test",
      baseUrl: "https://generativelanguage.googleapis.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 8_192,
    };
    const payload = await capturePayload<GeminiWire>(model, "medium");
    expect(payload.config.maxOutputTokens).toBe(1_600);
    // Disabled thinking is `thinkingBudget: 0`; a level must buy a real budget.
    expect(payload.config.thinkingConfig?.thinkingBudget ?? 0).toBeGreaterThan(0);
  });
});
