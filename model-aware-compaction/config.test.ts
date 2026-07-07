import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, resolveConfig } from "./config.js";

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

  it("loads object settings and ignores malformed settings shapes", () => {
    const root = mkdtempSync(join(tmpdir(), "model-aware-compaction-"));
    try {
      const projectPi = join(root, ".pi");
      mkdirSync(projectPi);
      const settingsPath = join(projectPi, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ "model-aware-compaction": [] }));
      expect(loadConfig(root, root).sourcePath).toBeNull();

      writeFileSync(
        settingsPath,
        JSON.stringify({
          "model-aware-compaction": {
            enabled: true,
            rules: [{ model: "openai/*", activeContextTokens: 120_000 }],
          },
        }),
      );
      const loaded = loadConfig(root, root);
      expect(loaded.enabled).toBe(true);
      expect(loaded.rules).toEqual([{ model: "openai/*", activeContextTokens: 120_000 }]);
      expect(loaded.sourcePath).toBe(`${settingsPath}#model-aware-compaction`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
