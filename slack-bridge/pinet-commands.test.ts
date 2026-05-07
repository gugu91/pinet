import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatPinetCommandHelp,
  registerPinetCommands,
  type PinetCommandsDeps,
} from "./pinet-commands.js";
import type { SlackBridgeSettings } from "./helpers.js";
import type { SlackScopeDiagnostics } from "./slack-scope-diagnostics.js";
import type { SlackBridgeRuntimeMode } from "./runtime-mode.js";

type CommandDefinition = {
  description?: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
};

function createContext(): { ctx: ExtensionContext; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify,
      theme: { fg: (_color: string, text: string) => text },
      setStatus: vi.fn(),
    },
  } as unknown as ExtensionContext;

  return { ctx, notify };
}

function createDeps(overrides: Partial<PinetCommandsDeps> = {}): PinetCommandsDeps {
  const settings: SlackBridgeSettings = {};
  const slackScopeDiagnostics: SlackScopeDiagnostics = {
    status: "not_checked",
    checkedAt: null,
    summary: "unchecked",
    surfaces: [],
    missingScopes: [],
    results: [],
  };

  const defaults: PinetCommandsDeps = {
    pinetEnabled: () => true,
    pinetRegistrationBlocked: () => false,
    runtimeMode: () => "single" as SlackBridgeRuntimeMode,
    runtimeConnected: () => true,
    brokerRole: () => "broker",
    agentName: () => "Slate Chalk Otter",
    agentEmoji: () => "🦦",
    agentOwnerToken: () => "owner-token",
    agentPersonality: () => null,
    agentAliases: () => new Set<string>(),
    botUserId: () => "U123",
    activeSkinTheme: () => null,
    lastDmChannel: () => null,
    followerRuntimeDiagnostic: () => null,
    threads: () => new Map<string, { owner?: string }>(),
    allowedUsers: () => null,
    inboxLength: () => 0,
    recentActivityLogEntries: () => [],
    slackScopeDiagnostics: () => slackScopeDiagnostics,
    settings: () => settings,
    lastBrokerMaintenance: () => null,
    ralphSnoozeStatus: () => ({
      active: false,
      until: null,
      remainingMs: 0,
      reason: null,
      source: null,
      emptyCycleCount: 0,
    }),
    snoozeRalphLoop: ({ durationMs, reason }) => ({
      active: true,
      until: "2026-04-02T14:30:00.000Z",
      remainingMs: durationMs,
      reason: reason ?? null,
      source: "manual",
      emptyCycleCount: 0,
    }),
    clearRalphSnooze: () => ({
      active: false,
      until: null,
      remainingMs: 0,
      reason: null,
      source: null,
      emptyCycleCount: 0,
    }),
    getBrokerControlPlaneHomeTabViewerIds: () => [],
    lastBrokerControlPlaneHomeTabRefreshAt: () => null,
    lastBrokerControlPlaneHomeTabError: () => null,
    getPinetRegistrationBlockReason: () => "blocked",
    connectAsBroker: async () => {},
    connectAsFollower: async () => {},
    reloadPinetRuntime: async () => {},
    disconnectFollower: async () => ({ unregisterError: null }),
    sendPinetAgentMessage: async (target) => ({ messageId: 1, target }),
    signalAgentFree: async () => ({ queuedInboxCount: 0, drainedQueuedInbox: false }),
    applyLocalAgentIdentity: () => {},
    setExtStatus: () => {},
    setExtCtx: () => {},
  };

  return { ...defaults, ...overrides };
}

function registerCommands(deps: PinetCommandsDeps): Map<string, CommandDefinition> {
  const commands = new Map<string, CommandDefinition>();
  const pi = {
    registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
      commands.set(name, definition);
    }),
  } as unknown as ExtensionAPI;

  registerPinetCommands(pi, deps);
  return commands;
}

describe("registerPinetCommands", () => {
  it("registers only the unified /pinet command", () => {
    const commands = registerCommands(createDeps());

    expect(commands.has("pinet")).toBe(true);
    expect(commands.has("pinet-start")).toBe(false);
    expect(commands.has("pinet-follow")).toBe(false);
    expect(commands.has("pinet-free")).toBe(false);
    expect(commands.has("pinet-skin")).toBe(false);
  });

  it("shows help for the unified command", async () => {
    const commands = registerCommands(createDeps());
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("", ctx);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /pinet <action> [args]"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("/pinet start"), "info");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("/pinet skin <theme>"), "info");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("/pinet-start"), "info");
  });

  it("routes /pinet reload through the existing remote-control message path", async () => {
    const sendPinetAgentMessage = vi.fn(async (target: string, body: string) => ({
      messageId: 42,
      target: `${target}:${body}`,
    }));
    const commands = registerCommands(createDeps({ sendPinetAgentMessage }));
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("reload GoldenOtter", ctx);

    expect(sendPinetAgentMessage).toHaveBeenCalledWith("GoldenOtter", "/reload");
    expect(notify).toHaveBeenCalledWith("Sent /reload to GoldenOtter:/reload", "info");
  });

  it("uses unified usage text for action arguments", async () => {
    const commands = registerCommands(createDeps());
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("reload", ctx);

    expect(notify).toHaveBeenCalledWith("Usage: /pinet reload <agent-name-or-id>", "warning");
  });

  it("snoozes and clears broker RALPH maintenance from the unified command", async () => {
    const snoozeRalphLoop = vi.fn(({ durationMs, reason }) => ({
      active: true,
      until: "2026-04-02T14:30:00.000Z",
      remainingMs: durationMs,
      reason,
      source: "manual" as const,
      emptyCycleCount: 0,
    }));
    const clearRalphSnooze = vi.fn(() => ({
      active: false,
      until: null,
      remainingMs: 0,
      reason: null,
      source: null,
      emptyCycleCount: 0,
    }));
    const commands = registerCommands(
      createDeps({ runtimeMode: () => "broker", snoozeRalphLoop, clearRalphSnooze }),
    );
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("snooze 30m no work available", ctx);
    await commands.get("pinet")?.handler("snooze off", ctx);

    expect(snoozeRalphLoop).toHaveBeenCalledWith({
      durationMs: 30 * 60_000,
      reason: "no work available",
    });
    expect(clearRalphSnooze).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("RALPH snooze: active"), "info");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("RALPH snooze: off"), "info");
  });

  it("runs free from the unified command and rejects removed skin action", async () => {
    const signalAgentFree = vi.fn(async () => ({ queuedInboxCount: 0, drainedQueuedInbox: false }));
    const commands = registerCommands(createDeps({ signalAgentFree }));
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("free", ctx);
    await commands.get("pinet")?.handler("skin slate chalk", ctx);

    expect(signalAgentFree).toHaveBeenCalledWith(ctx, { requirePinet: true });
    expect(notify).toHaveBeenCalledWith(
      "Marked 🦦 Slate Chalk Otter idle/free for new work.",
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Unknown Pinet action: skin"),
      "warning",
    );
  });
});

describe("formatPinetCommandHelp", () => {
  it("documents the consolidated primary actions", () => {
    const help = formatPinetCommandHelp();

    expect(help).toContain("/pinet start");
    expect(help).toContain("/pinet follow");
    expect(help).toContain("/pinet reload <agent>");
    expect(help).toContain("/pinet exit <agent>");
    expect(help).toContain("/pinet free");
    expect(help).toContain("/pinet snooze [duration|off|status]");
    expect(help).not.toContain("/pinet skin <theme>");
  });
});
