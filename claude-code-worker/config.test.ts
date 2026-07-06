import { describe, expect, it } from "vitest";
import { mergeConfig } from "./config.js";
import type { WorkerConfig } from "./config.js";

const defaults: WorkerConfig = {
  socketPath: "/tmp/sock",
  meshSecretPath: null,
  name: "",
  emoji: "",
  stableId: "stable",
  workdir: "/tmp",
  claudeBin: "claude",
  model: null,
  taskTimeoutMs: 1000,
  pollIntervalMs: 2000,
  stateDir: "/tmp/state",
};

describe("mergeConfig", () => {
  it("applies layers left to right", () => {
    const merged = mergeConfig(defaults, { name: "file-name" }, { name: "cli-name" });
    expect(merged.name).toBe("cli-name");
  });

  it("ignores undefined values in layers", () => {
    const merged = mergeConfig(defaults, { name: undefined, workdir: "/work" });
    expect(merged.name).toBe("");
    expect(merged.workdir).toBe("/work");
  });

  it("does not mutate the defaults object", () => {
    mergeConfig(defaults, { name: "x" });
    expect(defaults.name).toBe("");
  });
});
