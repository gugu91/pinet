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
      compactionModel: "google/gemini-2.5-flash:low",
      rules: [
        {
          model: "anthropic/*",
          activeContextTokens: 90_000,
          compactionModel: "anthropic/claude-haiku:off",
        },
        { model: "", activeContextTokens: 1 },
        { model: "openai/*", activeContextTokens: -1 },
      ],
    });
    expect(config.compactionModel).toBe("google/gemini-2.5-flash:low");
    expect(config.rules).toEqual([
      {
        model: "anthropic/*",
        activeContextTokens: 90_000,
        compactionModel: "anthropic/claude-haiku:off",
      },
    ]);
  });

  it("gives the project extension object precedence over the global object", () => {
    const root = mkdtempSync(join(tmpdir(), "model-aware-compaction-"));
    const agentDir = join(root, "agent");
    try {
      mkdirSync(join(root, ".pi"));
      mkdirSync(agentDir);
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({
          "model-aware-compaction": {
            enabled: true,
            compactionModel: "global/model",
            rules: [{ model: "global/*", activeContextTokens: 10_000 }],
          },
        }),
      );
      writeFileSync(
        join(root, ".pi", "settings.json"),
        JSON.stringify({
          "model-aware-compaction": {
            enabled: false,
            compactionModel: "project/model:low",
            rules: [{ model: "project/*", activeContextTokens: 20_000 }],
          },
        }),
      );
      const loaded = loadConfig(root, agentDir);
      expect(loaded.enabled).toBe(false);
      expect(loaded.compactionModel).toBe("project/model:low");
      expect(loaded.rules).toEqual([{ model: "project/*", activeContextTokens: 20_000 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
