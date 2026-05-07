import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildPinetOwnerToken,
  resolveAgentStableId,
  resolveBrokerStableId,
  resolvePersistedAgentIdentity,
  type SlackBridgeSettings,
} from "./helpers.js";
import type { SinglePlayerThreadInfo } from "./single-player-runtime.js";

export interface PersistedState {
  threads?: [string, SinglePlayerThreadInfo][];
  lastDmChannel?: string | null;
  userNames?: [string, string][];
  agentName?: string;
  agentEmoji?: string;
  agentStableId?: string;
  brokerStableId?: string;
  lastPinetRole?: "broker" | "worker";
  activeSkinTheme?: string | null;
  agentPersonality?: string | null;
  agentAliases?: string[];
}

export interface PersistedRuntimeStateStringCache {
  entries: () => Iterable<[string, string]>;
  has: (key: string) => boolean;
  set: (key: string, value: string) => void;
}

export interface PersistedRuntimeStateDeps {
  pi: Pick<ExtensionAPI, "appendEntry">;
  threads: Map<string, SinglePlayerThreadInfo>;
  userNames: PersistedRuntimeStateStringCache;
  getLastDmChannel: () => string | null;
  setLastDmChannel: (channelId: string | null) => void;
  getAgentName: () => string;
  setAgentName: (name: string) => void;
  getAgentEmoji: () => string;
  setAgentEmoji: (emoji: string) => void;
  getAgentStableId: () => string;
  setAgentStableId: (stableId: string) => void;
  getBrokerStableId: () => string;
  setBrokerStableId: (stableId: string) => void;
  getBrokerRole: () => "broker" | "follower" | null;
  getActiveSkinTheme: () => string | null;
  setActiveSkinTheme: (theme: string | null) => void;
  getAgentPersonality: () => string | null;
  setAgentPersonality: (personality: string | null) => void;
  agentAliases: Set<string>;
  setAgentOwnerToken: (ownerToken: string) => void;
  getSettings: () => SlackBridgeSettings;
  formatError: (error: unknown) => string;
}

export interface PersistedRuntimeStateManager {
  persistStateNow: () => void;
  persistState: () => void;
  flushPersist: () => void;
  restorePersistedRuntimeState: (ctx: ExtensionContext) => void;
}

export function createPersistedRuntimeState(
  deps: PersistedRuntimeStateDeps,
): PersistedRuntimeStateManager {
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  function persistStateNow(): void {
    persistTimer = null;
    try {
      deps.pi.appendEntry("slack-bridge-state", {
        threads: Array.from(deps.threads.entries()),
        lastDmChannel: deps.getLastDmChannel(),
        userNames: Array.from(deps.userNames.entries()),
        agentName: deps.getAgentName(),
        agentEmoji: deps.getAgentEmoji(),
        agentStableId: deps.getAgentStableId(),
        brokerStableId: deps.getBrokerStableId(),
        lastPinetRole: deps.getBrokerRole() === "broker" ? "broker" : "worker",
        activeSkinTheme: deps.getActiveSkinTheme(),
        agentPersonality: deps.getAgentPersonality(),
        agentAliases: [...deps.agentAliases],
      } satisfies PersistedState);
    } catch (error) {
      console.error(`[slack-bridge] persistState failed: ${deps.formatError(error)}`);
    }
  }

  function persistState(): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(persistStateNow, 1_000);
  }

  function flushPersist(): void {
    if (!persistTimer) {
      return;
    }
    clearTimeout(persistTimer);
    persistStateNow();
  }

  function restorePersistedRuntimeState(ctx: ExtensionContext): void {
    try {
      let savedState: PersistedState | null = null;
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === "slack-bridge-state") {
          savedState = entry.data as PersistedState;
        }
      }

      const restoredRole = savedState?.lastPinetRole === "broker" ? "broker" : "worker";
      const agentStableId = resolveAgentStableId(
        savedState?.agentStableId,
        ctx.sessionManager.getSessionFile(),
        os.hostname(),
        ctx.cwd,
        ctx.sessionManager.getLeafId(),
      );
      const brokerStableId = resolveBrokerStableId(
        savedState?.brokerStableId,
        os.hostname(),
        ctx.cwd,
      );
      deps.setAgentStableId(agentStableId);
      deps.setBrokerStableId(brokerStableId);
      deps.setAgentOwnerToken(
        buildPinetOwnerToken(restoredRole === "broker" ? brokerStableId : agentStableId),
      );
      const identitySeed =
        restoredRole === "broker"
          ? brokerStableId
          : (ctx.sessionManager.getSessionFile() ?? agentStableId);
      deps.setActiveSkinTheme(savedState?.activeSkinTheme ?? null);
      deps.setAgentPersonality(savedState?.agentPersonality ?? null);
      deps.agentAliases.clear();
      for (const alias of savedState?.agentAliases ?? []) {
        if (alias) {
          deps.agentAliases.add(alias);
        }
      }
      const restoredIdentity = resolvePersistedAgentIdentity(
        deps.getSettings(),
        savedState?.agentName,
        savedState?.agentEmoji,
        process.env.PI_NICKNAME,
        identitySeed,
        restoredRole,
      );
      deps.setAgentName(restoredIdentity.name);
      deps.setAgentEmoji(restoredIdentity.emoji);

      if (savedState) {
        if (savedState.threads) {
          for (const [threadTs, info] of savedState.threads) {
            if (!deps.threads.has(threadTs)) {
              deps.threads.set(threadTs, info);
            }
          }
        }
        if (savedState.lastDmChannel && !deps.getLastDmChannel()) {
          deps.setLastDmChannel(savedState.lastDmChannel);
        }
        if (savedState.userNames) {
          for (const [userId, userName] of savedState.userNames) {
            if (!deps.userNames.has(userId)) {
              deps.userNames.set(userId, userName);
            }
          }
        }
      }

      persistStateNow();
    } catch (error) {
      console.error(`[slack-bridge] restore failed: ${deps.formatError(error)}`);
    }
  }

  return {
    persistStateNow,
    persistState,
    flushPersist,
    restorePersistedRuntimeState,
  };
}
