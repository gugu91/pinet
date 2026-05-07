import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildPinetOwnerToken,
  buildPinetSkinAssignment,
  type SlackBridgeSettings,
} from "./helpers.js";
import {
  createRuntimeAgentContext,
  type ReactionCommandMap,
  type RuntimeAgentContextDeps,
} from "./runtime-agent-context.js";
import type { SecurityGuardrails } from "./guardrails.js";
import type { GitContext } from "./git-metadata.js";
import type { SinglePlayerThreadInfo } from "./single-player-runtime.js";

interface MutableRuntimeAgentState {
  settings: SlackBridgeSettings;
  botToken: string | undefined;
  appToken: string | undefined;
  allowedUsers: Set<string> | null;
  guardrails: SecurityGuardrails;
  reactionCommands: ReactionCommandMap;
  securityPrompt: string;
  agentName: string;
  agentEmoji: string;
  agentStableId: string;
  brokerStableId: string;
  brokerRole: "broker" | "follower" | null;
  agentOwnerToken: string;
  activeSkinTheme: string | null;
  agentPersonality: string | null;
}

function createContext(
  sessionFile = "/tmp/runtime-agent-context-session.json",
  notify = vi.fn(),
): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI: true,
    isIdle: () => true,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
      },
      notify,
      setStatus: vi.fn(),
    },
    sessionManager: {
      getEntries: () => [],
      getHeader: () => null,
      getLeafId: () => "leaf-123",
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext;
}

function createDeps(
  overrides: {
    cwd?: string;
    state?: Partial<MutableRuntimeAgentState>;
    threads?: Map<string, SinglePlayerThreadInfo>;
    agentAliases?: Set<string>;
    extensionContext?: ExtensionContext | null;
    gitContext?: GitContext;
  } = {},
) {
  const cwd = overrides.cwd ?? process.cwd();
  const state: MutableRuntimeAgentState = {
    settings: {},
    botToken: "xoxb-test",
    appToken: "xapp-test",
    allowedUsers: null,
    guardrails: {},
    reactionCommands: new Map(),
    securityPrompt: "",
    agentName: "Cobalt Olive Crane",
    agentEmoji: "🦩",
    agentStableId: "agent-stable-current",
    brokerStableId: "broker-stable-current",
    brokerRole: null,
    agentOwnerToken: buildPinetOwnerToken("agent-stable-current"),
    activeSkinTheme: null,
    agentPersonality: null,
    ...overrides.state,
  };
  const threads =
    overrides.threads ??
    new Map<string, SinglePlayerThreadInfo>([
      [
        "100.1",
        {
          channelId: "D100",
          threadTs: "100.1",
          userId: "U100",
          owner: "Cobalt Olive Crane",
        },
      ],
    ]);
  const agentAliases = overrides.agentAliases ?? new Set<string>();
  const extensionContext = overrides.extensionContext ?? createContext();
  const gitContext: GitContext = overrides.gitContext ?? {
    cwd,
    repo: path.basename(cwd),
    repoRoot: cwd,
    branch: "main",
  };
  const persistState = vi.fn();
  const updateBadge = vi.fn();

  const deps: RuntimeAgentContextDeps = {
    cwd,
    getSettings: () => state.settings,
    setSettings: (settings) => {
      state.settings = settings;
    },
    getBotToken: () => state.botToken,
    setBotToken: (token) => {
      state.botToken = token;
    },
    getAppToken: () => state.appToken,
    setAppToken: (token) => {
      state.appToken = token;
    },
    getAllowedUsers: () => state.allowedUsers,
    setAllowedUsers: (users) => {
      state.allowedUsers = users;
    },
    getGuardrails: () => state.guardrails,
    setGuardrails: (guardrails) => {
      state.guardrails = guardrails;
    },
    getReactionCommands: () => state.reactionCommands,
    setReactionCommands: (commands) => {
      state.reactionCommands = commands;
    },
    getSecurityPrompt: () => state.securityPrompt,
    setSecurityPrompt: (prompt) => {
      state.securityPrompt = prompt;
    },
    getAgentName: () => state.agentName,
    setAgentName: (name) => {
      state.agentName = name;
    },
    getAgentEmoji: () => state.agentEmoji,
    setAgentEmoji: (emoji) => {
      state.agentEmoji = emoji;
    },
    getAgentStableId: () => state.agentStableId,
    getBrokerStableId: () => state.brokerStableId,
    getBrokerRole: () => state.brokerRole,
    getAgentOwnerToken: () => state.agentOwnerToken,
    setAgentOwnerToken: (ownerToken) => {
      state.agentOwnerToken = ownerToken;
    },
    getActiveSkinTheme: () => state.activeSkinTheme,
    setActiveSkinTheme: (theme) => {
      state.activeSkinTheme = theme;
    },
    getAgentPersonality: () => state.agentPersonality,
    setAgentPersonality: (personality) => {
      state.agentPersonality = personality;
    },
    getAgentAliases: () => agentAliases,
    getThreads: () => threads,
    getExtensionContext: () => extensionContext,
    persistState,
    updateBadge,
    getGitContext: async () => gitContext,
  };

  return {
    deps,
    state,
    threads,
    agentAliases,
    extensionContext,
    persistState,
    updateBadge,
  };
}

describe("createRuntimeAgentContext", () => {
  const originalHome = process.env.HOME;
  let testHome: string;

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-agent-context-home-"));
    process.env.HOME = testHome;
  });

  afterEach(() => {
    fs.rmSync(testHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    vi.restoreAllMocks();
  });

  it("warns once per distinct Slack access warning and resets after access is configured", () => {
    const notify = vi.fn();
    const { deps, state } = createDeps({
      extensionContext: createContext(undefined, notify),
      state: { allowedUsers: new Set() },
    });
    const runtimeAgentContext = createRuntimeAgentContext(deps);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(runtimeAgentContext.isUserAllowed("U_OK")).toBe(false);

    runtimeAgentContext.maybeWarnSlackUserAccess(deps.getExtensionContext() ?? undefined);
    runtimeAgentContext.maybeWarnSlackUserAccess(deps.getExtensionContext() ?? undefined);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("default-deny");

    state.allowedUsers = new Set(["U_OK"]);
    runtimeAgentContext.maybeWarnSlackUserAccess(deps.getExtensionContext() ?? undefined);
    expect(runtimeAgentContext.isUserAllowed("U_OK")).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    state.allowedUsers = new Set();
    runtimeAgentContext.maybeWarnSlackUserAccess(deps.getExtensionContext() ?? undefined);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("warns once when admitted users have effectively empty guardrails and resets when posture changes", () => {
    const notify = vi.fn();
    const { deps, state } = createDeps({
      extensionContext: createContext(undefined, notify),
      state: {
        allowedUsers: new Set(["U_OK"]),
        guardrails: {},
      },
    });
    const runtimeAgentContext = createRuntimeAgentContext(deps);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    runtimeAgentContext.maybeWarnSlackGuardrailPosture(deps.getExtensionContext() ?? undefined);
    runtimeAgentContext.maybeWarnSlackGuardrailPosture(deps.getExtensionContext() ?? undefined);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("guardrails are effectively empty");

    state.guardrails = { blockedTools: ["bash"] };
    runtimeAgentContext.maybeWarnSlackGuardrailPosture(deps.getExtensionContext() ?? undefined);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    state.guardrails = {};
    runtimeAgentContext.maybeWarnSlackGuardrailPosture(deps.getExtensionContext() ?? undefined);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);

    state.allowedUsers = new Set();
    runtimeAgentContext.maybeWarnSlackGuardrailPosture(deps.getExtensionContext() ?? undefined);
    expect(warnSpy).toHaveBeenCalledTimes(2);

    state.allowedUsers = new Set(["U_OK"]);
    runtimeAgentContext.maybeWarnSlackGuardrailPosture(deps.getExtensionContext() ?? undefined);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("applies local agent identity updates, normalizes owned threads, and skips redundant writes", () => {
    const { deps, state, threads, agentAliases, persistState, updateBadge } = createDeps({
      threads: new Map([
        [
          "100.1",
          {
            channelId: "D100",
            threadTs: "100.1",
            userId: "U100",
            owner: "Cobalt Olive Crane",
          },
        ],
        [
          "200.1",
          {
            channelId: "D200",
            threadTs: "200.1",
            userId: "U200",
            owner: "someone-else",
          },
        ],
      ]),
    });
    const runtimeAgentContext = createRuntimeAgentContext(deps);

    runtimeAgentContext.applyLocalAgentIdentity("Obsidian Coral Goose", "🪿", "observant");

    expect(state.agentName).toBe("Obsidian Coral Goose");
    expect(state.agentEmoji).toBe("🪿");
    expect(state.agentPersonality).toBe("observant");
    expect([...agentAliases]).toEqual(["Cobalt Olive Crane"]);
    expect(threads.get("100.1")?.owner).toBe(state.agentOwnerToken);
    expect(threads.get("200.1")?.owner).toBe("someone-else");
    expect(persistState).toHaveBeenCalledTimes(1);
    expect(updateBadge).toHaveBeenCalledTimes(1);

    runtimeAgentContext.applyLocalAgentIdentity("Obsidian Coral Goose", "🪿", "observant");
    expect(persistState).toHaveBeenCalledTimes(1);
    expect(updateBadge).toHaveBeenCalledTimes(1);
  });

  it("refreshes settings and prefers the configured skin identity when set", () => {
    fs.mkdirSync(path.join(testHome, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(testHome, ".pi", "agent", "settings.json"),
      JSON.stringify({
        "slack-bridge": {
          botToken: "xoxb-updated",
          appToken: "xapp-updated",
          allowedUsers: ["U_ALLOWED"],
          security: { blockedTools: ["bash"] },
          reactionCommands: {
            "👀": { action: "inspect", prompt: "Inspect closely" },
          },
          skinTheme: "foundation",
          agentName: "Ignored By Skin",
          agentEmoji: "❌",
        },
      }),
    );

    const sessionFile = "/tmp/runtime-agent-context-session.json";
    const { deps, state } = createDeps({
      extensionContext: createContext(sessionFile),
      state: {
        activeSkinTheme: "cyberpunk neon",
        agentName: "Current Name",
        agentEmoji: "🙂",
      },
    });
    const runtimeAgentContext = createRuntimeAgentContext(deps);

    runtimeAgentContext.refreshSettings();

    const expectedSkin = buildPinetSkinAssignment({
      theme: "foundation",
      role: "worker",
      seed: sessionFile,
    });

    expect(state.settings.allowedUsers).toEqual(["U_ALLOWED"]);
    expect(state.botToken).toBe("xoxb-updated");
    expect(state.appToken).toBe("xapp-updated");
    expect(state.allowedUsers).toEqual(new Set(["U_ALLOWED"]));
    expect(state.guardrails).toEqual({ blockedTools: ["bash"] });
    expect(state.reactionCommands.get("eyes")).toEqual({
      action: "inspect",
      prompt: "Inspect closely",
    });
    expect(state.securityPrompt).toContain("bash");
    expect(state.activeSkinTheme).toBe("foundation");
    expect(state.agentName).toBe(expectedSkin.name);
    expect(state.agentEmoji).toBe(expectedSkin.emoji);
    expect(state.agentPersonality).toBe(expectedSkin.personality);
  });

  it("clears stale active skin when skinTheme is removed from settings", () => {
    fs.mkdirSync(path.join(testHome, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(testHome, ".pi", "agent", "settings.json"),
      JSON.stringify({
        "slack-bridge": {
          agentName: "Config Name",
          agentEmoji: "🧭",
        },
      }),
    );

    const { deps, state } = createDeps({
      state: {
        activeSkinTheme: "foundation",
        agentName: "Skinned Name",
        agentEmoji: "🪐",
        agentPersonality: "stale persona",
      },
    });
    const runtimeAgentContext = createRuntimeAgentContext(deps);

    runtimeAgentContext.refreshSettings();

    expect(state.activeSkinTheme).toBeNull();
    expect(state.agentName).toBe("Config Name");
    expect(state.agentEmoji).toBe("🧭");
    expect(state.agentPersonality).toBeNull();
  });

  it("snapshots and restores reloadable runtime state with cloned collections and role-aware owner tokens", () => {
    const { deps, state, agentAliases } = createDeps({
      state: {
        settings: { allowedUsers: ["U_SAVED"], logLevel: "verbose" },
        botToken: "xoxb-saved",
        appToken: "xapp-saved",
        allowedUsers: new Set(["U_SAVED"]),
        guardrails: { blockedTools: ["bash"] },
        reactionCommands: new Map([["eyes", { action: "review", prompt: "Review this" }]]),
        securityPrompt: "saved prompt",
        agentName: "Saved Crane",
        agentEmoji: "🦩",
        brokerRole: "broker",
        agentOwnerToken: "owner:stale",
        activeSkinTheme: "midnight",
        agentPersonality: "steady",
      },
      agentAliases: new Set(["Saved Alias", "Saved Crane"]),
    });
    const runtimeAgentContext = createRuntimeAgentContext(deps);

    const snapshot = runtimeAgentContext.snapshotReloadableRuntime();

    state.settings = { allowedUsers: ["U_MUTATED"] };
    state.botToken = "xoxb-mutated";
    state.appToken = undefined;
    state.allowedUsers = new Set(["U_MUTATED"]);
    state.guardrails = { blockedTools: ["edit"] };
    state.reactionCommands = new Map([["bug", { action: "file-issue", prompt: "Bug" }]]);
    state.securityPrompt = "mutated prompt";
    state.agentName = "Mutated Goose";
    state.agentEmoji = "🪿";
    state.activeSkinTheme = null;
    state.agentPersonality = null;
    agentAliases.clear();
    agentAliases.add("Mutated Alias");

    runtimeAgentContext.restoreReloadableRuntime(snapshot);

    expect(state.settings).toEqual({ allowedUsers: ["U_SAVED"], logLevel: "verbose" });
    expect(state.botToken).toBe("xoxb-saved");
    expect(state.appToken).toBe("xapp-saved");
    expect(state.allowedUsers).toEqual(new Set(["U_SAVED"]));
    expect(state.allowedUsers).not.toBe(snapshot.allowedUsers);
    expect(state.guardrails).toEqual({ blockedTools: ["bash"] });
    expect(state.guardrails).not.toBe(snapshot.guardrails);
    expect(state.reactionCommands).toEqual(
      new Map([["eyes", { action: "review", prompt: "Review this" }]]),
    );
    expect(state.reactionCommands).not.toBe(snapshot.reactionCommands);
    expect(state.securityPrompt).toBe("saved prompt");
    expect(state.agentName).toBe("Saved Crane");
    expect(state.agentEmoji).toBe("🦩");
    expect(state.activeSkinTheme).toBe("midnight");
    expect(state.agentPersonality).toBe("steady");
    expect(state.agentOwnerToken).toBe(buildPinetOwnerToken(state.brokerStableId));
    expect([...agentAliases]).toEqual(["Saved Alias"]);
  });

  it("detects project tools and includes repo, branch, and skin metadata in agent metadata", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-agent-context-repo-"));
    const workerDir = path.join(repoRoot, "packages", "worker");
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint .", build: "tsc -b" } }),
    );
    fs.writeFileSync(
      path.join(workerDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }),
    );

    const { deps } = createDeps({
      cwd: workerDir,
      state: {
        activeSkinTheme: "midnight",
        agentPersonality: "observant",
      },
      gitContext: {
        cwd: workerDir,
        repo: "extensions",
        repoRoot,
        branch: "feat/runtime-agent-context",
      },
    });
    const runtimeAgentContext = createRuntimeAgentContext(deps);

    expect(runtimeAgentContext.detectProjectTools(repoRoot, workerDir)).toEqual([
      "build",
      "git",
      "lint",
      "test",
      "typecheck",
    ]);

    const metadata = await runtimeAgentContext.getAgentMetadata("broker");

    expect(metadata).toMatchObject({
      cwd: workerDir,
      repo: "extensions",
      repoRoot,
      branch: "feat/runtime-agent-context",
      role: "broker",
      skinTheme: "midnight",
      personality: "observant",
      skinStatusVocabulary: {
        idle: "standing by",
        working: "in motion",
        healthy: "signal clear",
        stale: "signal fading",
        ghost: "off signal",
        resumable: "recoverable",
      },
      scope: {
        workspace: {
          provider: "slack",
          source: "compatibility",
          compatibilityKey: "default",
        },
        instance: {
          source: "compatibility",
          compatibilityKey: "default",
        },
      },
    });
    expect(metadata.capabilities).toMatchObject({
      role: "broker",
      tools: ["build", "git", "lint", "test", "typecheck"],
      scope: {
        workspace: {
          provider: "slack",
          source: "compatibility",
          compatibilityKey: "default",
        },
        instance: {
          source: "compatibility",
          compatibilityKey: "default",
        },
      },
      tags: expect.arrayContaining([
        "role:broker",
        "repo:extensions",
        "branch:feat/runtime-agent-context",
        "tool:build",
        "tool:git",
        "tool:lint",
        "tool:test",
        "tool:typecheck",
      ]),
    });

    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("includes broker-managed launch metadata for marked follower workers", async () => {
    const originalManaged = process.env.PINET_BROKER_MANAGED;
    const originalBroker = process.env.PINET_BROKER_AGENT_ID;
    const originalLaunchSource = process.env.PINET_LAUNCH_SOURCE;
    const originalTmuxSession = process.env.PINET_TMUX_SESSION;
    process.env.PINET_BROKER_MANAGED = "1";
    process.env.PINET_BROKER_AGENT_ID = "broker-1";
    process.env.PINET_LAUNCH_SOURCE = "broker-tmux";
    process.env.PINET_TMUX_SESSION = "extensions-worker-1";
    try {
      const { deps } = createDeps();
      const runtimeAgentContext = createRuntimeAgentContext(deps);

      const workerMetadata = await runtimeAgentContext.getAgentMetadata("worker");
      const brokerMetadata = await runtimeAgentContext.getAgentMetadata("broker");

      expect(workerMetadata).toMatchObject({
        brokerManaged: true,
        brokerManagedBy: "broker-1",
        launchSource: "broker-tmux",
        tmuxSession: "extensions-worker-1",
      });
      expect(typeof workerMetadata.brokerManagedAt).toBe("string");
      expect(brokerMetadata).not.toHaveProperty("brokerManaged");
    } finally {
      if (originalManaged === undefined) delete process.env.PINET_BROKER_MANAGED;
      else process.env.PINET_BROKER_MANAGED = originalManaged;
      if (originalBroker === undefined) delete process.env.PINET_BROKER_AGENT_ID;
      else process.env.PINET_BROKER_AGENT_ID = originalBroker;
      if (originalLaunchSource === undefined) delete process.env.PINET_LAUNCH_SOURCE;
      else process.env.PINET_LAUNCH_SOURCE = originalLaunchSource;
      if (originalTmuxSession === undefined) delete process.env.PINET_TMUX_SESSION;
      else process.env.PINET_TMUX_SESSION = originalTmuxSession;
    }
  });

  it("applies registration identity and exposes metadata/id helper behavior", () => {
    const { deps, state, agentAliases, persistState, updateBadge } = createDeps({
      state: {
        activeSkinTheme: "dawn",
      },
      agentAliases: new Set(["Current Alias"]),
    });
    const runtimeAgentContext = createRuntimeAgentContext(deps);

    expect(runtimeAgentContext.getStableIdForRole("worker")).toBe("agent-stable-current");
    expect(runtimeAgentContext.getStableIdForRole("broker")).toBe("broker-stable-current");
    expect(runtimeAgentContext.getIdentitySeedForRole("worker", "/tmp/explicit-session.json")).toBe(
      "/tmp/explicit-session.json",
    );
    expect(runtimeAgentContext.getIdentitySeedForRole("broker")).toBe("broker-stable-current");
    expect(runtimeAgentContext.getSkinSeed("  preferred-seed  ")).toBe("preferred-seed");
    expect(runtimeAgentContext.asStringValue("  hello  ")).toBe("hello");
    expect(runtimeAgentContext.asStringValue("   ")).toBeUndefined();
    expect(runtimeAgentContext.getMeshRoleFromMetadata({ role: "broker" }, "worker")).toBe(
      "broker",
    );
    expect(runtimeAgentContext.getMeshRoleFromMetadata(undefined, "worker")).toBe("worker");
    expect(
      runtimeAgentContext.buildSkinMetadata({ role: "worker" }, "careful", {
        idle: "standing by",
        working: "in motion",
      }),
    ).toEqual({
      role: "worker",
      skinTheme: "dawn",
      personality: "careful",
      skinStatusVocabulary: {
        idle: "standing by",
        working: "in motion",
      },
    });

    state.activeSkinTheme = "default";
    expect(
      runtimeAgentContext.buildSkinMetadata(
        {
          role: "worker",
          skinStatusVocabulary: { idle: "standing by", working: "in motion" },
        },
        "classic",
      ),
    ).toEqual({
      role: "worker",
      skinTheme: "default",
      personality: "classic",
    });

    runtimeAgentContext.applyRegistrationIdentity({
      name: "Obsidian Coral Goose",
      emoji: "🪿",
      metadata: {
        skinTheme: "  midnight  ",
        personality: "  observant  ",
      },
    });

    expect(state.activeSkinTheme).toBe("midnight");
    expect(state.agentName).toBe("Obsidian Coral Goose");
    expect(state.agentEmoji).toBe("🪿");
    expect(state.agentPersonality).toBe("observant");
    expect([...agentAliases]).toContain("Cobalt Olive Crane");
    expect(persistState).toHaveBeenCalledTimes(1);
    expect(updateBadge).toHaveBeenCalledTimes(1);

    const guidelines = runtimeAgentContext.getIdentityGuidelines();
    expect(guidelines).toHaveLength(3);
    expect(guidelines.join("\n")).toContain("Obsidian Coral Goose");
    expect(guidelines.join("\n")).toContain("🪿");
  });
});
