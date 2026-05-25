import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  PinetReadOptions,
  PinetReadResult,
} from "@gugu910/pi-pinet-core/pinet-read-formatting";
import {
  buildPinetOwnerToken,
  generateAgentName,
  resolvePinetMeshAuth,
  syncBrokerInboxEntries,
  type FollowerInboxEntry,
  type InboxMessage,
  type PinetControlCommand,
  type PinetRemoteControlRequestResult,
  type SlackBridgeSettings,
} from "./helpers.js";
import { startBroker, type Broker } from "./broker/index.js";
import type { BrokerMessage } from "./broker/types.js";
import { HEARTBEAT_INTERVAL_MS } from "./broker/client.js";

export interface SubtreeBrokerPaths {
  rootDir: string;
  socketPath: string;
  dbPath: string;
  lockPath: string;
}

export interface SubtreeBrokerStatus {
  active: boolean;
  selfAgentId: string | null;
  startedAt: string | null;
  paths: SubtreeBrokerPaths | null;
  childLaunchEnv: Record<string, string>;
  childLaunchHint: string | null;
}

export interface SubtreeBrokerRuntimeDeps {
  cwd: string;
  getSettings: () => SlackBridgeSettings;
  getAgentStableId: () => string;
  getCentralAgentId: () => string | null;
  getAgentIdentity: () => { name: string; emoji: string };
  getAgentMetadata: (role: "broker" | "worker") => Promise<Record<string, unknown>>;
  getMeshRoleFromMetadata: (
    metadata: Record<string, unknown> | undefined,
    fallback?: "broker" | "worker",
  ) => "broker" | "worker";
  pushInboxMessages: (messages: InboxMessage[]) => void;
  updateBadge: () => void;
  maybeDrainInboxIfIdle: (ctx: ExtensionContext) => boolean;
  requestRemoteControl: (
    command: PinetControlCommand,
    ctx: ExtensionContext,
  ) => PinetRemoteControlRequestResult;
  runRemoteControl: (command: PinetControlCommand, ctx: ExtensionContext) => void;
  formatError: (error: unknown) => string;
}

export interface SubtreeBrokerRuntime {
  start: (ctx: ExtensionContext) => Promise<SubtreeBrokerStatus>;
  stop: (options?: { releaseIdentity?: boolean }) => Promise<void>;
  getStatus: () => SubtreeBrokerStatus;
  readInbox: (options?: PinetReadOptions) => PinetReadResult | null;
  isActive: () => boolean;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "agent";
}

export function buildSubtreeBrokerPaths(stableId: string): SubtreeBrokerPaths {
  const rootDir = path.join(os.homedir(), ".pi", "pinet-subtrees", sanitizePathSegment(stableId));
  return {
    rootDir,
    socketPath: path.join(rootDir, "pinet.sock"),
    dbPath: path.join(rootDir, "pinet-broker.db"),
    lockPath: path.join(rootDir, "pinet-broker.lock"),
  };
}

function buildSelfAgentId(stableId: string): string {
  return `subbroker-${sanitizePathSegment(stableId).slice(0, 80)}`;
}

function buildChildLaunchEnv(
  paths: SubtreeBrokerPaths,
  selfAgentId: string,
): Record<string, string> {
  return {
    PINET_SOCKET_PATH: paths.socketPath,
    PINET_BROKER_MANAGED: "1",
    PINET_PARENT_AGENT_ID: selfAgentId,
    PINET_ROOT_AGENT_ID: selfAgentId,
    PINET_SPAWNED_BY_AGENT_ID: selfAgentId,
    PINET_LAUNCH_SOURCE: "subtree-broker-tmux",
  };
}

function quoteShellValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildChildLaunchHint(paths: SubtreeBrokerPaths, selfAgentId: string, cwd: string): string {
  const env = buildChildLaunchEnv(paths, selfAgentId);
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${quoteShellValue(value)}`)
    .join(" ");
  return `cd ${quoteShellValue(cwd)} && ${envPrefix} pi`;
}

function toFollowerInboxEntry(input: {
  entry: { id: number };
  message: BrokerMessage;
}): FollowerInboxEntry {
  return {
    inboxId: input.entry.id,
    message: {
      threadId: input.message.threadId,
      source: input.message.source,
      sender: input.message.sender,
      body: input.message.body,
      createdAt: input.message.createdAt,
      metadata: input.message.metadata,
    },
  };
}

export function createSubtreeBrokerRuntime(deps: SubtreeBrokerRuntimeDeps): SubtreeBrokerRuntime {
  let activeBroker: Broker | null = null;
  let selfAgentId: string | null = null;
  let startedAt: string | null = null;
  let activePaths: SubtreeBrokerPaths | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function stopHeartbeat(): void {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function startHeartbeat(broker: Broker, agentId: string): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      try {
        broker.db.heartbeatAgent(agentId);
      } catch {
        // Best effort only; normal broker maintenance will notice if this fails persistently.
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  }

  function getStatus(): SubtreeBrokerStatus {
    const childLaunchEnv =
      activePaths && selfAgentId ? buildChildLaunchEnv(activePaths, selfAgentId) : {};
    return {
      active: activeBroker !== null,
      selfAgentId,
      startedAt,
      paths: activePaths,
      childLaunchEnv,
      childLaunchHint:
        activePaths && selfAgentId
          ? buildChildLaunchHint(activePaths, selfAgentId, deps.cwd)
          : null,
    };
  }

  function drainSelfInbox(ctx: ExtensionContext, broker: Broker, agentId: string): void {
    const entries = broker.db.getInbox(agentId).map(toFollowerInboxEntry);
    if (entries.length === 0) return;

    const synced = syncBrokerInboxEntries(entries);
    const handledControlInboxIds = new Set<number>();
    for (const entry of synced.controlEntries) {
      try {
        const queued = deps.requestRemoteControl(entry.command, ctx);
        if (queued.ackDisposition === "immediate") {
          handledControlInboxIds.add(entry.inboxId);
        }
        if (queued.shouldStartNow) {
          deps.runRemoteControl(entry.command, ctx);
        }
      } catch (error) {
        ctx.ui.notify(`Subtree Pinet control failed: ${deps.formatError(error)}`, "error");
      }
    }

    if (handledControlInboxIds.size > 0) {
      broker.db.markDelivered([...handledControlInboxIds], agentId);
    }

    if (synced.inboxMessages.length === 0) return;
    deps.pushInboxMessages(synced.inboxMessages);
    deps.updateBadge();
    deps.maybeDrainInboxIfIdle(ctx);
  }

  function readInbox(options: PinetReadOptions = {}): PinetReadResult | null {
    if (!activeBroker || !selfAgentId) return null;
    if (options.threadId && !activeBroker.db.getThread(options.threadId)) return null;
    const result = activeBroker.db.readInbox(selfAgentId, options);
    return {
      messages: result.messages.map((item) => ({
        inboxId: item.entry.id,
        delivered: item.entry.delivered,
        readAt: item.entry.readAt,
        message: item.message,
      })),
      unreadCountBefore: result.unreadCountBefore,
      unreadCountAfter: result.unreadCountAfter,
      unreadThreads: result.unreadThreads,
      markedReadIds: result.markedReadIds,
    };
  }

  async function stop(options: { releaseIdentity?: boolean } = {}): Promise<void> {
    stopHeartbeat();
    const broker = activeBroker;
    const agentId = selfAgentId;
    activeBroker = null;
    selfAgentId = null;
    startedAt = null;
    activePaths = null;

    if (!broker) return;
    try {
      if (options.releaseIdentity && agentId) {
        broker.db.unregisterAgent(agentId);
      }
      await broker.stop();
    } catch {
      // Best effort; callers should be able to continue even if shutdown cleanup is partial.
    }
  }

  async function start(ctx: ExtensionContext): Promise<SubtreeBrokerStatus> {
    if (activeBroker) return getStatus();

    const stableId = deps.getCentralAgentId() ?? deps.getAgentStableId();
    const paths = buildSubtreeBrokerPaths(stableId);
    fs.mkdirSync(paths.rootDir, { recursive: true });
    const meshAuth = resolvePinetMeshAuth(deps.getSettings());
    const broker = await startBroker({
      dbPath: paths.dbPath,
      socketPath: paths.socketPath,
      lockPath: paths.lockPath,
      ...(meshAuth.meshSecret ? { meshSecret: meshAuth.meshSecret } : {}),
      ...(meshAuth.meshSecretPath ? { meshSecretPath: meshAuth.meshSecretPath } : {}),
    });

    const selfId = buildSelfAgentId(stableId);
    const { name, emoji } = deps.getAgentIdentity();
    const metadata = {
      ...(await deps.getAgentMetadata("broker")),
      subtreeBroker: true,
      upstreamAgentId: deps.getCentralAgentId(),
      subtreeSocketPath: paths.socketPath,
    };
    const selfAgent = broker.db.registerAgent(
      selfId,
      name ? `Subtree Broker ${name}` : "Subtree Broker",
      emoji || "🌳",
      process.pid,
      metadata,
      `${stableId}:subtree-broker`,
    );

    broker.server.setAgentRegistrationResolver((registration) => {
      const role = deps.getMeshRoleFromMetadata(registration.metadata, "worker");
      const identity = generateAgentName(registration.stableId ?? registration.agentId, role);
      return {
        name: registration.name || identity.name,
        emoji: registration.emoji || identity.emoji,
        metadata: {
          ...(registration.metadata ?? {}),
          subtreeBrokerAgentId: selfAgent.id,
          subtreeRootAgentId: selfAgent.id,
        },
      };
    });

    broker.server.onAgentMessage((targetAgentId: string) => {
      if (targetAgentId !== selfAgent.id) return;
      drainSelfInbox(ctx, broker, selfAgent.id);
    });

    activeBroker = broker;
    selfAgentId = selfAgent.id;
    startedAt = new Date().toISOString();
    activePaths = paths;
    startHeartbeat(broker, selfAgent.id);
    broker.db.setSetting("pinet.subtreeBrokerParentStableId", deps.getAgentStableId());
    broker.db.setSetting("pinet.subtreeBrokerOwnerToken", buildPinetOwnerToken(stableId));

    return getStatus();
  }

  return {
    start,
    stop,
    getStatus,
    readInbox,
    isActive: () => activeBroker !== null,
  };
}
