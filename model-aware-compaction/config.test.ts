import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";

describe("resolveConfig", () => {
  it("is disabled by default with useful example rules", () => {
    const config = resolveConfig();
    expect(config.enabled).toBe(false);
    expect(config.rules).toContainEqual({
      model: "openai/gpt-5-mini",
      activeContextTokens: 100_000,
    });
  });

  it("keeps valid configured rules and drops malformed entries", () => {
    const config = resolveConfig({
      enabled: true,
      rules: [
        { model: "anthropic/*", activeContextTokens: 90_000 },
        { model: "", activeContextTokens: 1 },
        { model: "openai/*", activeContextTokens: -1 },
      ],
    });
    expect(config.rules).toEqual([{ model: "anthropic/*", activeContextTokens: 90_000 }]);
  });
});
