import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  loadBrokerPrompt,
  renderBrokerPromptContent,
  resolveBrokerPromptCandidates,
} from "./broker-prompt-loader.js";

const execFileAsync = promisify(execFile);

let tempRoot: string;
let workspaceRoot: string;
let homeDir: string;
let packagedDefaultPath: string;

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function writeBuffer(filePath: string, content: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

function loaderOptions() {
  return {
    workspaceRoot,
    homeDir,
    defaultPromptPath: packagedDefaultPath,
  };
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "broker-prompt-loader-"));
  workspaceRoot = path.join(tempRoot, "workspace");
  homeDir = path.join(tempRoot, "home");
  packagedDefaultPath = path.join(tempRoot, "pkg", "prompts", "broker", "default.md");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  await writeText(packagedDefaultPath, "PACKAGED DEFAULT {{agentName}}");
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("resolveBrokerPromptCandidates", () => {
  it("orders workspace override, user-local override, then packaged default", () => {
    const candidates = resolveBrokerPromptCandidates(loaderOptions());

    expect(candidates.map((candidate) => candidate.source)).toEqual([
      "workspace",
      "user",
      "packaged",
    ]);
    expect(candidates[0]?.path).toBe(path.join(workspaceRoot, ".pi", "slack-bridge", "tmux.md"));
    expect(candidates[1]?.path).toBe(path.join(homeDir, ".pi", "agent", "slack-bridge", "tmux.md"));
    expect(candidates[2]?.path).toBe(packagedDefaultPath);
  });
});

describe("loadBrokerPrompt", () => {
  it("loads the workspace tmux.md override when it is the first valid candidate", async () => {
    await writeText(path.join(workspaceRoot, ".pi", "slack-bridge", "tmux.md"), "WORKSPACE PROMPT");
    await writeText(path.join(homeDir, ".pi", "agent", "slack-bridge", "tmux.md"), "USER PROMPT");

    const result = await loadBrokerPrompt(loaderOptions());

    expect(result).toMatchObject({ source: "workspace", content: "WORKSPACE PROMPT" });
    expect(result.warnings).toEqual([]);
  });

  it("loads configured relative paths before conventional overrides", async () => {
    await writeText(path.join(workspaceRoot, "prompts", "custom.md"), "CONFIGURED PROMPT");
    await writeText(path.join(workspaceRoot, ".pi", "slack-bridge", "tmux.md"), "WORKSPACE");

    const result = await loadBrokerPrompt({
      ...loaderOptions(),
      configuredPrompt: "prompts/custom.md",
    });

    expect(result).toMatchObject({ source: "configured", content: "CONFIGURED PROMPT" });
  });

  it("loads configured packaged prompt presets", async () => {
    const result = await loadBrokerPrompt({ ...loaderOptions(), configuredPrompt: "tmux" });

    expect(result.source).toBe("configured");
    expect(result.content).toContain("FRESH TMUX WORKERS");
  });

  it("warns and falls through from an invalid configured prompt", async () => {
    await writeText(path.join(workspaceRoot, ".pi", "slack-bridge", "tmux.md"), "WORKSPACE");

    const result = await loadBrokerPrompt({
      ...loaderOptions(),
      configuredPrompt: "missing/custom.md",
    });

    expect(result).toMatchObject({ source: "workspace", content: "WORKSPACE" });
    expect(result.warnings[0]).toMatchObject({ source: "configured", reason: "unreadable" });
  });

  it("resolves the workspace override from the git root when launched from a nested directory", async () => {
    await execFileAsync("git", ["init"], { cwd: workspaceRoot });
    const nestedDir = path.join(workspaceRoot, "packages", "app");
    await fs.mkdir(nestedDir, { recursive: true });
    await writeText(
      path.join(workspaceRoot, ".pi", "slack-bridge", "tmux.md"),
      "ROOT WORKSPACE PROMPT",
    );

    const result = await loadBrokerPrompt({
      cwd: nestedDir,
      homeDir,
      defaultPromptPath: packagedDefaultPath,
    });

    expect(result).toMatchObject({ source: "workspace", content: "ROOT WORKSPACE PROMPT" });
  });

  it("loads the user-local tmux.md override when the workspace override is absent", async () => {
    await writeText(path.join(homeDir, ".pi", "agent", "slack-bridge", "tmux.md"), "USER PROMPT");

    const result = await loadBrokerPrompt(loaderOptions());

    expect(result).toMatchObject({ source: "user", content: "USER PROMPT" });
    expect(result.warnings).toEqual([]);
  });

  it("loads the packaged default when overrides are absent", async () => {
    const result = await loadBrokerPrompt(loaderOptions());

    expect(result).toMatchObject({ source: "packaged", content: "PACKAGED DEFAULT {{agentName}}" });
    expect(result.warnings).toEqual([]);
  });

  it("warns and falls through from an invalid workspace override to a valid user override", async () => {
    await writeText(path.join(workspaceRoot, ".pi", "slack-bridge", "tmux.md"), "TOO LARGE");
    await writeText(path.join(homeDir, ".pi", "agent", "slack-bridge", "tmux.md"), "USER");

    const result = await loadBrokerPrompt({ ...loaderOptions(), maxBytes: 4 });

    expect(result.source).toBe("user");
    expect(result.content).toBe("USER");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ source: "workspace", reason: "too_large" });
    expect(result.warnings[0]?.message).not.toContain(workspaceRoot);
    expect(result.warnings[0]?.message).not.toContain("TOO LARGE");
  });

  it("warns and falls through from invalid overrides to the packaged default", async () => {
    await writeText(path.join(workspaceRoot, ".pi", "slack-bridge", "tmux.md"), "");
    await writeBuffer(
      path.join(homeDir, ".pi", "agent", "slack-bridge", "tmux.md"),
      Buffer.from([0xff, 0xfe, 0xfd]),
    );

    const result = await loadBrokerPrompt(loaderOptions());

    expect(result.source).toBe("packaged");
    expect(result.content).toBe("PACKAGED DEFAULT {{agentName}}");
    expect(result.warnings.map((entry) => [entry.source, entry.reason])).toEqual([
      ["workspace", "empty"],
      ["user", "invalid_utf8"],
    ]);
  });

  it("rejects workspace symlink escapes and continues to packaged default", async () => {
    const outsideDir = path.join(tempRoot, "outside");
    const outsideFile = path.join(outsideDir, "secret.md");
    const linkPath = path.join(workspaceRoot, ".pi", "slack-bridge", "tmux.md");
    await writeText(outsideFile, "SECRET PROMPT");
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.symlink(outsideFile, linkPath);

    const result = await loadBrokerPrompt(loaderOptions());

    expect(result.source).toBe("packaged");
    expect(result.content).toBe("PACKAGED DEFAULT {{agentName}}");
    expect(result.warnings[0]).toMatchObject({ source: "workspace", reason: "unsafe_path" });
    expect(result.warnings[0]?.message).not.toContain(outsideFile);
    expect(result.warnings[0]?.message).not.toContain("SECRET PROMPT");
  });

  it("rejects user-local symlink escapes and continues to packaged default", async () => {
    const outsideDir = path.join(tempRoot, "outside-user");
    const outsideFile = path.join(outsideDir, "secret.md");
    const linkPath = path.join(homeDir, ".pi", "agent", "slack-bridge", "tmux.md");
    await writeText(outsideFile, "USER SECRET PROMPT");
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.symlink(outsideFile, linkPath);

    const result = await loadBrokerPrompt(loaderOptions());

    expect(result.source).toBe("packaged");
    expect(result.warnings[0]).toMatchObject({ source: "user", reason: "unsafe_path" });
    expect(result.warnings[0]?.message).not.toContain(outsideFile);
    expect(result.warnings[0]?.message).not.toContain("USER SECRET PROMPT");
  });

  it("fails closed when the packaged default is missing or invalid", async () => {
    await fs.rm(packagedDefaultPath, { force: true });

    await expect(loadBrokerPrompt(loaderOptions())).rejects.toThrow(
      "No valid broker prompt candidates found",
    );
  });
});

describe("renderBrokerPromptContent", () => {
  it("renders broker identity placeholders without changing other MD", () => {
    expect(
      renderBrokerPromptContent("Hello {{agentEmoji}} {{agentName}}. Keep **Markdown**.", {
        agentEmoji: "🦫",
        agentName: "Prism Bronze Beaver",
      }),
    ).toBe("Hello 🦫 Prism Bronze Beaver. Keep **Markdown**.");
  });
});

describe("packaged default broker prompt", () => {
  it("keeps replaceable default policy in tmux.md rather than hard-coded broker prompt helpers", async () => {
    const defaultPromptPath = path.join(process.cwd(), "prompts", "broker", "tmux.md");
    const defaultPrompt = await fs.readFile(defaultPromptPath, "utf8");

    expect(defaultPrompt).toContain("NEVER WRITE CODE");
    expect(defaultPrompt).toContain("PRIORITIZED ISSUE GATE");
    expect(defaultPrompt).toContain("REPO-SCOPED DELEGATION");
    expect(defaultPrompt).toContain("RALPH LOOP");
    expect(defaultPrompt).toContain("{{agentEmoji}} {{agentName}}");
  });

  it("documents consent-gated PM mode and durable lane metadata", async () => {
    const defaultPromptPath = path.join(process.cwd(), "prompts", "broker", "tmux.md");
    const defaultPrompt = await fs.readFile(defaultPromptPath, "utf8");

    expect(defaultPrompt).toContain("PM MODE AWARENESS");
    expect(defaultPrompt).toContain("consent-gated");
    expect(defaultPrompt).toContain("nominates an implementation lead");
    expect(defaultPrompt).toContain("pinet action=lanes");
    expect(defaultPrompt).toContain("detached` lane means human/manual supervision");
    expect(defaultPrompt).toContain("do not auto-reassign it as normal broker-managed work");
  });

  it("documents safe repo-scoped follower startup before reporting capacity gaps", async () => {
    const defaultPromptPath = path.join(process.cwd(), "prompts", "broker", "tmux.md");
    const defaultPrompt = await fs.readFile(defaultPromptPath, "utf8");

    expect(defaultPrompt).toContain(
      "Use tmux only for broker-managed follower lifecycle operations",
    );
    expect(defaultPrompt).toContain("inspect recorded broker-managed sessions");
    expect(defaultPrompt).toContain("never manipulate unrelated or unmapped tmux sessions");
    expect(defaultPrompt).toContain("create a tmux session in the target repo");
    expect(defaultPrompt).toContain("/pinet follow");
    expect(defaultPrompt).toContain("start fresh repo-scoped Pinet follower capacity");
    expect(defaultPrompt).not.toContain("ask for a repo-matched worker");
    expect(defaultPrompt).not.toContain("suggest they spin up a new agent in that repo");
  });

  it("documents autonomous broker worker lifecycle and relay caveats", async () => {
    const defaultPromptPath = path.join(process.cwd(), "prompts", "broker", "tmux.md");
    const defaultPrompt = await fs.readFile(defaultPromptPath, "utf8");

    expect(defaultPrompt).toContain("fully autonomous / unchained broker lane");
    expect(defaultPrompt).not.toContain("WORKER REUSE BEFORE LAUNCH");
    expect(defaultPrompt).toContain("FRESH TMUX WORKERS");
    expect(defaultPrompt).toContain("launch a fresh tmux-backed Pinet follower worker");
    expect(defaultPrompt).toContain(
      "unless the maintainer explicitly asks to reuse an existing worker",
    );
    expect(defaultPrompt).toContain("tmux new-session -d -s <session> -c <repo>");
    expect(defaultPrompt).toContain(
      "Store the tmux session/socket and repo/worktree in durable lane metadata",
    );
    expect(defaultPrompt).toContain("Mac mini");
    expect(defaultPrompt).toContain("WORKER GRACE PERIOD");
    expect(defaultPrompt).toContain("short ten-minute grace period");
    expect(defaultPrompt).toContain("route follow-up");
    expect(defaultPrompt).toContain("fail closed: report the worker as a cleanup candidate");
    expect(defaultPrompt).toContain("WORKER CAP AND TMUX HYGIENE");
    expect(defaultPrompt).toContain("pruning, not by recycling old context into new lanes");
    expect(defaultPrompt).toContain("Start at most one fresh worker per new lane");
    expect(defaultPrompt).toContain("immediate duplicate-owner anomaly");
    expect(defaultPrompt).toContain("resolve duplicate owners immediately");
    expect(defaultPrompt).toContain("TMUX HYGIENE");
    expect(defaultPrompt).toContain("do not recycle unrelated idle workers as a shortcut");
    expect(defaultPrompt).toContain(
      "report ambiguous cases as cleanup candidates instead of guessing",
    );
    expect(defaultPrompt).toContain("close sessions whose worker exited after grace");
    expect(defaultPrompt).toContain("THREAD OWNERSHIP AND REPORTING");
    expect(defaultPrompt).toContain("direct Slack posting is blocked");
    expect(defaultPrompt).toContain("GITHUB AND SECRET HANDLING");
    expect(defaultPrompt).toContain("Never echo tokens");
  });

  // This exercises the real package build, including declaration emit; loaded worktrees and
  // pre-push runs can exceed Vitest's default 5s timeout even though the build path is expected
  // for publish readiness.
  it("copies prompt assets into dist/prompts so the packaged tmux.md is loadable", async () => {
    await execFileAsync("node", ["../scripts/build-package.mjs"], { cwd: process.cwd() });

    const distPromptPath = path.join(process.cwd(), "dist", "prompts", "broker", "tmux.md");
    await expect(fs.access(distPromptPath)).resolves.toBeUndefined();
    const result = await loadBrokerPrompt({
      workspaceRoot,
      homeDir,
      defaultPromptPath: distPromptPath,
    });

    expect(result.source).toBe("packaged");
    expect(result.content).toContain("PRIORITIZED ISSUE GATE");
  }, 60_000);
});
