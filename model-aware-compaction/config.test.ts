import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
    expect(config.compactionModels).toEqual(["google/gemini-2.5-flash:low"]);
    expect(config.rules).toEqual([
      {
        model: "anthropic/*",
        activeContextTokens: 90_000,
        compactionModels: ["anthropic/claude-haiku:off"],
      },
    ]);
  });

  it("accepts an ordered fallback chain, trimming, de-duplicating, and capping it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const config = resolveConfig({
        compactionModel: [" a/one:low ", "b/two", "", "a/one:low", "c/three", "d/four"],
        rules: [
          { model: "x/*", activeContextTokens: 1_000, compactionModel: ["r/one", "r/two"] },
          { model: "y/*", activeContextTokens: 1_000, compactionModel: [] },
        ],
      });
      expect(config.compactionModels).toEqual(["a/one:low", "b/two", "c/three"]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("only the first 3"));
      // An explicit empty rule chain is kept: it means Pi default for those models.
      expect(config.rules).toEqual([
        { model: "x/*", activeContextTokens: 1_000, compactionModels: ["r/one", "r/two"] },
        { model: "y/*", activeContextTokens: 1_000, compactionModels: [] },
      ]);
      expect(resolveConfig({}).compactionModels).toEqual([]);
      // The cap warning is reported once, not on every load.
      resolveConfig({ compactionModel: ["a/one:low", "b/two", "c/three", "d/four"] });
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it("keeps malformed chain values as unparseable entries instead of dropping them", () => {
    type Raw = NonNullable<Parameters<typeof resolveConfig>[0]>["compactionModel"];
    const raw = (compactionModel: Raw, rule?: Raw) =>
      resolveConfig({
        compactionModel,
        rules: [{ model: "x/*", activeContextTokens: 1_000, compactionModel: rule }],
      });
    expect(raw(42).compactionModels).toEqual(["<invalid 42>"]);
    expect(raw({ provider: "a" }).compactionModels).toEqual(['<invalid {"provider":"a"}>']);
    // A bad element does not let the chain skip straight to the good one.
    expect(raw([42, "provider/fallback"]).compactionModels).toEqual([
      "<invalid 42>",
      "provider/fallback",
    ]);
    // Malformed rule values stay on the rule and do not inherit the global chain.
    expect(raw("global/model", true).rules[0]).toEqual({
      model: "x/*",
      activeContextTokens: 1_000,
      compactionModels: ["<invalid true>"],
    });
    expect(raw("global/model", null).rules[0]).toEqual({
      model: "x/*",
      activeContextTokens: 1_000,
    });
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
      expect(loaded.compactionModels).toEqual(["project/model:low"]);
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
