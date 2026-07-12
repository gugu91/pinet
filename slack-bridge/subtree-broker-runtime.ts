import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sleep } from "@pinet/transport-core/async";
import { summarizePinetStableId } from "./pinet-session-formatting.js";
import type { AgentSessionSummary } from "./broker/types.js";
import type { PinetReadOptions, PinetReadResult } from "@pinet/pinet-core/pinet-read-formatting";
import { dispatchDirectAgentMessage, resolveDirectAgentTarget } from "./broker/agent-messaging.js";
import { startBroker, type Broker } from "./broker/index.js";
import { HEARTBEAT_INTERVAL_MS } from "./broker/client.js";
import type { AgentInfo, BrokerMessage } from "./broker/types.js";
import {
  buildPinetOwnerToken,
  formatPinetSteeringMessage,
  generateAgentName,
  normalizeOutgoingPinetControlMessage,
  normalizeOutgoingPinetSteeringMessage,
  resolvePinetMeshAuth,
  syncBrokerInboxEntries,
  type FollowerInboxEntry,
  type InboxMessage,
  type PinetControlCommand,
  type PinetRemoteControlRequestResult,
  type SlackBridgeSettings,
} from "./helpers.js";
import { resolveHibernationSettings } from "./hibernation-config.js";
import {
  hibernationRuntimeActive,
  createHibernationOrchestrator,
  persistSpawnedRuntimeSpec,
  recoverStrandedWakesBeforeRegistrations,
} from "./broker/hibernation-activation.js";
import { freezeHibernationActivationAuthority } from "./broker/hibernation-activation-authority.js";
import type { BrokerDB } from "./broker/schema.js";

const execFileAsync = promisify(execFile);
const DEFAULT_SPAWN_REGISTRATION_TIMEOUT_MS = 45_000;
const SUBTREE_CHILD_EXIT_GRACE_MS = 5_000;

export interface SubtreeBrokerPaths {
  rootDir: string;
  socketPath: string;
  dbPath: string;
  lockPath: string;
}

export interface SubtreeWorkerRecord {
  launchId: string;
  sessionName: string;
  repoPath: string;
  role: string;
  laneId: string | null;
  agentId: string | null;
  startedAt: string;
  monitorCommand: string;
}

export interface SubtreeBrokerStatus {
  active: boolean;
  selfAgentId: string | null;
  startedAt: string | null;
  paths: SubtreeBrokerPaths | null;
  childLaunchEnv: Record<string, string>;
  childLaunchHint: string | null;
  childCount: number;
  spawnedWorkers: SubtreeWorkerRecord[];
}

export interface SubtreeAgentRecord {
  emoji: string;
  name: string;
  id: string;
  pid?: number;
  stableId?: string | null;
  session?: AgentSessionSummary | null;
  status: "working" | "idle";
  metadata: Record<string, unknown> | null;
  lastHeartbeat: string;
  lastSeen?: string;
  disconnectedAt?: string | null;
  resumableUntil?: string | null;
  outboundCount?: number;
  pendingInboxCount?: number;
  parentAgentId?: string | null;
  rootAgentId?: string | null;
  treeDepth?: number;
  supervisionState?: string;
  subtreeRole?: string | null;
  laneId?: string | null;
}

export interface SubtreeSpawnInput {
  task: string;
  repo: string;
  role?: string;
  laneId?: string;
  waitForRegistrationMs?: number;
}

export interface SubtreeSpawnResult {
  status: "started";
  launchId: string;
  sessionName: string;
  repoPath: string;
  role: string;
  laneId: string | null;
  agentId: string;
  agentName: string;
  messageId: number;
  threadId: string;
  monitorCommand: string;
  socketPath: string;
  dbPath: string;
  childLaunchEnv: Record<string, string>;
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
  deliverSteeringMessage: (text: string, ctx: ExtensionContext) => boolean;
  requestRemoteControl: (
    command: PinetControlCommand,
    ctx: ExtensionContext,
  ) => PinetRemoteControlRequestResult;
  runRemoteControl: (command: PinetControlCommand, ctx: ExtensionContext) => void;
  formatError: (error: unknown) => string;
}

/**
 * The authoritative hibernation runtime surface for this process's subtree
 * broker. The subtree broker is the authority that spawns and OWNS its workers
 * and authors their durable runtime specs, so hibernate/wake must resolve the
 * target, read its authz spec, and drive the orchestrator against THIS same
 * authoritative DB end to end. The explicit trust boundary: the operator command
 * may only address workers this subtree broker owns. Null when no subtree broker
 * is running (nothing is command-addressable).
 */
export interface SubtreeHibernationRuntimeControl {
  /** The single authoritative DB that owns the spawned workers + their specs. */
  db: BrokerDB;
  /** Broker instance id recorded on lifecycle leases; matches startup recovery. */
  brokerInstanceId: string;
  /** Base PINET_* env re-establishing the mesh connection for a woken worker. */
  baseLaunchEnv: Record<string, string>;
}

export interface SubtreeBrokerRuntime {
  start: (ctx: ExtensionContext) => Promise<SubtreeBrokerStatus>;
  getHibernationRuntimeControl: () => SubtreeHibernationRuntimeControl | null;
  stop: (options?: { releaseIdentity?: boolean; stopChildren?: boolean }) => Promise<void>;
  getStatus: () => SubtreeBrokerStatus;
  readInbox: (options?: PinetReadOptions) => PinetReadResult | null;
  sendMessage: (
    target: string,
    body: string,
    metadata?: Record<string, unknown>,
  ) => Promise<{ messageId: number; target: string; threadId: string } | null>;
  listAgents: (includeGhosts?: boolean) => SubtreeAgentRecord[] | null;
  spawnWorker: (ctx: ExtensionContext, input: SubtreeSpawnInput) => Promise<SubtreeSpawnResult>;
  isActive: () => boolean;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "agent";
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
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
  input: { launchId?: string; role?: string; laneId?: string; tmuxSession?: string } = {},
): Record<string, string> {
  return {
    PINET_SOCKET_PATH: paths.socketPath,
    PINET_BROKER_MANAGED: "1",
    PINET_PARENT_AGENT_ID: selfAgentId,
    PINET_ROOT_AGENT_ID: selfAgentId,
    PINET_SPAWNED_BY_AGENT_ID: selfAgentId,
    PINET_LAUNCH_SOURCE: "subtree-broker-tmux",
    ...(input.launchId ? { PINET_LAUNCH_ID: input.launchId } : {}),
    ...(input.role ? { PINET_SUBTREE_ROLE: input.role } : {}),
    ...(input.laneId ? { PINET_LANE_ID: input.laneId } : {}),
    ...(input.tmuxSession ? { PINET_TMUX_SESSION: input.tmuxSession } : {}),
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

function metadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveRepoPath(repo: string, cwd: string): string {
  const trimmed = repo.trim();
  if (!trimmed) throw new Error("spawn requires repo");

  const candidates = [
    path.isAbsolute(trimmed) ? trimmed : null,
    trimmed === "." ? cwd : null,
    path.resolve(cwd, trimmed),
    path.join(os.homedir(), trimmed),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`spawn repo not found: ${repo}`);
}

function normalizeRole(role: string | undefined): string {
  const normalized = role?.trim();
  return normalized && normalized.length > 0 ? normalized : "subworker";
}

function buildTmuxSessionName(repoPath: string, role: string, launchId: string): string {
  const repoName = sanitizePathSegment(path.basename(repoPath));
  const roleName = sanitizePathSegment(role);
  const shortLaunch = sanitizePathSegment(launchId).slice(-8);
  return sanitizePathSegment(`pinet-${repoName}-${roleName}-${shortLaunch}`).slice(0, 80);
}

function findTmuxSocketPath(): string | null {
  const configuredDir = process.env.CLAUDE_TMUX_SOCKET_DIR?.trim();
  const candidates = [
    configuredDir ? path.join(configuredDir, "claude.sock") : null,
    process.env.TMUX?.split(",")[0] ?? null,
    process.env.TMPDIR ? path.join(process.env.TMPDIR, "claude-tmux-sockets", "claude.sock") : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function buildTmuxBaseArgs(socketPath: string | null): string[] {
  return socketPath ? ["-S", socketPath] : [];
}

function buildTmuxMonitorCommand(sessionName: string, socketPath: string | null): string {
  const socketArgs = socketPath ? `-S ${quoteShellValue(socketPath)} ` : "";
  return `tmux ${socketArgs}attach -t ${quoteShellValue(sessionName)}`;
}

export function getExtensionEntryPath(): string {
  const currentPath = fileURLToPath(import.meta.url);
  const extension = path.extname(currentPath) || ".js";
  return path.join(path.dirname(currentPath), `index${extension}`);
}

/**
 * Broker env var NAMES (never values) a spawned — or later WOKEN — worker
 * re-exports to re-establish itself. Single source of truth shared by the
 * ordinary spawn launcher and the Phase B wake path so both stay in lockstep.
 */
export const SUBTREE_INHERITED_ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_OFFLINE",
  "PI_SETTINGS_PATH",
  "PINET_MESH_SECRET",
  "PINET_MESH_SECRET_PATH",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
];

function childStartupPrompt(parentAgentId: string): string {
  return [
    `You are a Pinet subtree child supervised by ${parentAgentId}.`,
    "Wait for the supervising worker's Pinet task, then do that task and report back through Pinet.",
    "If you are not following Pinet yet, wait for the launcher to run /pinet follow.",
  ].join(" ");
}

function buildLauncherScript(input: {
  repoPath: string;
  env: Record<string, string>;
  extensionEntryPath: string;
  startupPrompt: string;
}): string {
  const inheritedEnvKeys = [
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
    "PI_OFFLINE",
    "PI_SETTINGS_PATH",
    "PINET_MESH_SECRET",
    "PINET_MESH_SECRET_PATH",
    "SLACK_APP_TOKEN",
    "SLACK_BOT_TOKEN",
  ];
  const inheritedExports = inheritedEnvKeys
    .map((key) => {
      const value = process.env[key];
      return value ? `export ${key}=${quoteShellValue(value)}` : null;
    })
    .filter((line): line is string => Boolean(line));
  const envExports = Object.entries(input.env).map(
    ([key, value]) => `export ${key}=${quoteShellValue(value)}`,
  );
  const nickname = `Subtree ${input.env.PINET_SUBTREE_ROLE ?? "Worker"} ${input.env.PINET_LAUNCH_ID ?? randomSuffix()}`;

  return [
    "#!/bin/bash",
    "set -euo pipefail",
    `cd ${quoteShellValue(input.repoPath)}`,
    ...inheritedExports,
    ...envExports,
    `export PI_NICKNAME=${quoteShellValue(nickname)}`,
    `exec pi -e ${quoteShellValue(input.extensionEntryPath)} ${quoteShellValue(input.startupPrompt)}`,
    "",
  ].join("\n");
}

function isSubtreeChildAgent(agent: AgentInfo, selfAgentId: string): boolean {
  return agent.id !== selfAgentId && agent.parentAgentId === selfAgentId;
}

function toSubtreeAgentRecord(db: Broker["db"], agent: AgentInfo): SubtreeAgentRecord {
  return {
    emoji: agent.emoji,
    name: agent.name,
    id: agent.id,
    pid: agent.pid,
    stableId: agent.stableId ?? null,
    session: summarizePinetStableId(agent.stableId),
    status: agent.status,
    metadata: agent.metadata,
    lastHeartbeat: agent.lastHeartbeat,
    lastSeen: agent.lastSeen,
    disconnectedAt: agent.disconnectedAt,
    resumableUntil: agent.resumableUntil,
    outboundCount: agent.outboundCount,
    pendingInboxCount: db.getPendingInboxCount(agent.id),
    parentAgentId: agent.parentAgentId,
    rootAgentId: agent.rootAgentId,
    treeDepth: agent.treeDepth,
    supervisionState: agent.supervisionState,
    subtreeRole: agent.subtreeRole,
    laneId: agent.laneId,
  };
}

export function createSubtreeBrokerRuntime(deps: SubtreeBrokerRuntimeDeps): SubtreeBrokerRuntime {
  let activeBroker: Broker | null = null;
  let selfAgentId: string | null = null;
  let startedAt: string | null = null;
  let activePaths: SubtreeBrokerPaths | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const spawnedWorkers = new Map<string, SubtreeWorkerRecord>();

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

  function currentChildren(): AgentInfo[] {
    const broker = activeBroker;
    const agentId = selfAgentId;
    if (!broker || !agentId) return [];
    return broker.db.getAllAgents().filter((agent) => isSubtreeChildAgent(agent, agentId));
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
      childCount: currentChildren().length,
      spawnedWorkers: [...spawnedWorkers.values()],
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

    const steeredInboxIds: number[] = [];
    for (const entry of synced.steeringEntries) {
      try {
        if (deps.deliverSteeringMessage(formatPinetSteeringMessage(entry), ctx)) {
          steeredInboxIds.push(entry.inboxId);
        }
      } catch (error) {
        ctx.ui.notify(`Subtree Pinet steering failed: ${deps.formatError(error)}`, "error");
      }
    }

    if (steeredInboxIds.length > 0) {
      broker.db.markDelivered(steeredInboxIds, agentId);
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

  async function sendMessage(
    target: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ messageId: number; target: string; threadId: string } | null> {
    if (!activeBroker || !selfAgentId) return null;
    const targetAgent = resolveDirectAgentTarget(activeBroker.db.getAgents(), target);
    if (!targetAgent || targetAgent.id === selfAgentId) return null;

    const normalized =
      normalizeOutgoingPinetControlMessage(body, metadata) ??
      normalizeOutgoingPinetSteeringMessage(body, metadata);
    const finalBody = normalized?.body ?? body;
    const finalMetadata = normalized?.metadata ?? metadata;
    const identity = deps.getAgentIdentity();
    const result = dispatchDirectAgentMessage(activeBroker.db, {
      senderAgentId: selfAgentId,
      senderAgentName: identity.name || "Subtree Broker",
      target,
      body: finalBody,
      ...(finalMetadata ? { metadata: finalMetadata } : {}),
    });

    return {
      messageId: result.messageId,
      target: result.target.name,
      threadId: result.threadId,
    };
  }

  function listAgents(includeGhosts = false): SubtreeAgentRecord[] | null {
    const broker = activeBroker;
    if (!broker) return null;
    const agents = broker.db.getAllAgents();
    const filtered = includeGhosts ? agents : agents.filter((agent) => !agent.disconnectedAt);
    return filtered.map((agent) => toSubtreeAgentRecord(broker.db, agent));
  }

  async function sendFollowCommand(sessionName: string, tmuxBaseArgs: string[]): Promise<void> {
    await execFileAsync("tmux", [
      ...tmuxBaseArgs,
      "send-keys",
      "-t",
      sessionName,
      "-l",
      "--",
      "/pinet follow",
    ]);
    await execFileAsync("tmux", [...tmuxBaseArgs, "send-keys", "-t", sessionName, "Enter"]);
  }

  async function waitForSpawnedAgent(input: {
    broker: Broker;
    launchId: string;
    sessionName: string;
    tmuxBaseArgs: string[];
    timeoutMs: number;
  }): Promise<AgentInfo> {
    const deadline = Date.now() + input.timeoutMs;
    let lastFollowAttemptAt = 0;

    while (Date.now() < deadline) {
      const agent = input.broker.db
        .getAllAgents()
        .find((candidate) => metadataString(candidate.metadata, "launchId") === input.launchId);
      if (agent) return agent;

      if (Date.now() - lastFollowAttemptAt > 6_000) {
        lastFollowAttemptAt = Date.now();
        await sendFollowCommand(input.sessionName, input.tmuxBaseArgs).catch(() => {
          // The session may still be starting; the loop retries until timeout.
        });
      }

      await sleep(1_000);
    }

    throw new Error(
      `subtree worker session ${input.sessionName} started but did not register within ${input.timeoutMs}ms`,
    );
  }

  async function requestChildExit(agent: AgentInfo): Promise<void> {
    await sendMessage(agent.id, "/exit", { subtreeLifecycle: "stop" }).catch(() => null);
  }

  async function killTmuxSession(sessionName: string, tmuxBaseArgs: string[]): Promise<void> {
    await execFileAsync("tmux", [...tmuxBaseArgs, "has-session", "-t", sessionName]).catch(() => {
      throw new Error("missing");
    });
    await execFileAsync("tmux", [...tmuxBaseArgs, "kill-session", "-t", sessionName]);
  }

  function childTmuxSessions(broker: Broker, agentId: string): string[] {
    const sessions = new Set<string>();
    for (const worker of spawnedWorkers.values()) {
      sessions.add(worker.sessionName);
    }
    for (const agent of broker.db.getAllAgents()) {
      if (!isSubtreeChildAgent(agent, agentId)) continue;
      const session = metadataString(agent.metadata, "tmuxSession");
      if (session) sessions.add(session);
    }
    return [...sessions];
  }

  async function stopChildren(broker: Broker, agentId: string): Promise<void> {
    const children = broker.db
      .getAllAgents()
      .filter((agent) => isSubtreeChildAgent(agent, agentId));
    await Promise.all(children.map(requestChildExit));
    if (children.length > 0) {
      await sleep(SUBTREE_CHILD_EXIT_GRACE_MS);
    }

    const tmuxSocketPath = findTmuxSocketPath();
    const tmuxBaseArgs = buildTmuxBaseArgs(tmuxSocketPath);
    await Promise.all(
      childTmuxSessions(broker, agentId).map((sessionName) =>
        killTmuxSession(sessionName, tmuxBaseArgs).catch(() => undefined),
      ),
    );
  }

  async function stop(
    options: { releaseIdentity?: boolean; stopChildren?: boolean } = {},
  ): Promise<void> {
    stopHeartbeat();
    const broker = activeBroker;
    const agentId = selfAgentId;

    if (!broker) return;
    try {
      if (agentId && options.stopChildren !== false) {
        await stopChildren(broker, agentId);
      }
      if (options.releaseIdentity && agentId) {
        broker.db.unregisterAgent(agentId);
      }
      await broker.stop();
    } catch {
      // Best effort; callers should be able to continue even if shutdown cleanup is partial.
    } finally {
      activeBroker = null;
      selfAgentId = null;
      startedAt = null;
      activePaths = null;
      spawnedWorkers.clear();
    }
  }

  async function start(ctx: ExtensionContext): Promise<SubtreeBrokerStatus> {
    if (activeBroker) return getStatus();

    const stableId = deps.getCentralAgentId() ?? deps.getAgentStableId();
    const paths = buildSubtreeBrokerPaths(stableId);
    fs.mkdirSync(paths.rootDir, { recursive: true });
    const meshAuth = resolvePinetMeshAuth(deps.getSettings());

    // Capture the durable, process-lifetime activation authority at broker start
    // (frozen; never re-read from reloadable settings) and resolve the self id up
    // front so Phase B, Seam 3 startup stranded-wake recovery can run inside
    // `beforeListen` — strictly BEFORE the socket accepts any registration.
    freezeHibernationActivationAuthority();
    const selfId = buildSelfAgentId(stableId);
    const runtimeActive = hibernationRuntimeActive();
    const startupHib = resolveHibernationSettings(deps.getSettings());

    const broker = await startBroker({
      dbPath: paths.dbPath,
      socketPath: paths.socketPath,
      lockPath: paths.lockPath,
      ...(meshAuth.meshSecret ? { meshSecret: meshAuth.meshSecret } : {}),
      ...(meshAuth.meshSecretPath ? { meshSecretPath: meshAuth.meshSecretPath } : {}),
      ...(runtimeActive
        ? {
            beforeListen: ({ db }) => {
              // Phase B, Seam 3 (default-off): reconcile crash-stranded wake rows
              // on THIS broker's authoritative DB BEFORE it begins listening, so
              // a stranded waking/hibernating row is completed/quarantined/
              // requeued deterministically instead of racing an incoming
              // (possibly duplicate) wake registration. Pure DB reconciliation;
              // launches nothing. `selfId` equals the self-agent id registered
              // below, so recovery's lease ownership matches the live wake path.
              recoverStrandedWakesBeforeRegistrations(
                createHibernationOrchestrator({
                  db,
                  brokerInstanceId: selfId,
                  extensionEntryPath: getExtensionEntryPath(),
                  baseLaunchEnv: buildChildLaunchEnv(paths, selfId),
                  inheritedEnvKeys: SUBTREE_INHERITED_ENV_KEYS,
                  config: {
                    handshakeTimeoutMs: startupHib.handshakeTimeoutMs,
                    wakeLeaseMs: startupHib.wakeLeaseMs,
                    maxConcurrentWakes: startupHib.maxConcurrentWakes,
                    maxConcurrentWakesPerRepo: startupHib.maxConcurrentWakesPerRepo,
                  },
                }),
              );
            },
          }
        : {}),
    });

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

  async function spawnWorker(
    ctx: ExtensionContext,
    input: SubtreeSpawnInput,
  ): Promise<SubtreeSpawnResult> {
    if (!input.task.trim()) throw new Error("spawn requires task");
    if (!input.repo.trim()) throw new Error("spawn requires repo");
    if (!activeBroker) {
      await start(ctx);
    }
    if (!activeBroker || !activePaths || !selfAgentId) {
      throw new Error("Subtree broker is not running.");
    }

    const repoPath = resolveRepoPath(input.repo, deps.cwd);
    const role = normalizeRole(input.role);
    const launchId = `subtree-${Date.now().toString(36)}-${randomSuffix()}`;
    const sessionName = buildTmuxSessionName(repoPath, role, launchId);
    const tmuxSocketPath = findTmuxSocketPath();
    const tmuxBaseArgs = buildTmuxBaseArgs(tmuxSocketPath);
    const monitorCommand = buildTmuxMonitorCommand(sessionName, tmuxSocketPath);
    const childLaunchEnv = buildChildLaunchEnv(activePaths, selfAgentId, {
      launchId,
      role,
      ...(input.laneId ? { laneId: input.laneId } : {}),
      tmuxSession: sessionName,
    });
    const launchersDir = path.join(activePaths.rootDir, "launchers");
    fs.mkdirSync(launchersDir, { recursive: true });
    const launcherPath = path.join(launchersDir, `${sessionName}.sh`);
    fs.writeFileSync(
      launcherPath,
      buildLauncherScript({
        repoPath,
        env: childLaunchEnv,
        extensionEntryPath: getExtensionEntryPath(),
        startupPrompt: childStartupPrompt(selfAgentId),
      }),
      { mode: 0o700 },
    );

    await execFileAsync("tmux", [
      ...tmuxBaseArgs,
      "new-session",
      "-d",
      "-s",
      sessionName,
      launcherPath,
    ]);
    const workerRecord: SubtreeWorkerRecord = {
      launchId,
      sessionName,
      repoPath,
      role,
      laneId: input.laneId ?? null,
      agentId: null,
      startedAt: new Date().toISOString(),
      monitorCommand,
    };
    spawnedWorkers.set(launchId, workerRecord);

    const agent = await waitForSpawnedAgent({
      broker: activeBroker,
      launchId,
      sessionName,
      tmuxBaseArgs,
      timeoutMs: input.waitForRegistrationMs ?? DEFAULT_SPAWN_REGISTRATION_TIMEOUT_MS,
    });
    const updatedRecord: SubtreeWorkerRecord = { ...workerRecord, agentId: agent.id };
    spawnedWorkers.set(launchId, updatedRecord);

    // Phase B, Seam 2 (default-off): record a durable, broker-authored runtime
    // spec so this freshly-registered worker is hibernatable/wakeable later. The
    // authz VCS identity is derived from the repo's REAL git remote (never the
    // directory name); an unresolvable remote or non-durable locator set fails
    // closed (no spec persisted). No-op unless the durable, non-reloadable
    // runtime-activation authority is set. Persisted into `activeBroker.db` — the
    // SAME authoritative DB the hibernate/wake command path resolves against via
    // `getHibernationRuntimeControl`.
    if (hibernationRuntimeActive()) {
      await persistSpawnedRuntimeSpec(activeBroker.db, {
        agentId: agent.id,
        stableId: agent.stableId ?? "",
        brokerOwnerId: selfAgentId,
        cwd: repoPath,
        repoRoot: repoPath,
        worktreePath: repoPath,
        tmuxSocket: tmuxSocketPath ?? "",
        tmuxSession: sessionName,
        tmuxTarget: sessionName,
        extensionEntryPath: getExtensionEntryPath(),
        envAllowlist: Object.keys(childLaunchEnv),
        configFingerprint: "subtree-broker-tmux",
        expectedUser: os.userInfo().username,
        launchSource: "subtree-broker-tmux",
      });
    }

    const messageResult = await sendMessage(agent.id, input.task, {
      subtreeTask: true,
      launchId,
      role,
      ...(input.laneId ? { laneId: input.laneId } : {}),
    });
    if (!messageResult) {
      throw new Error(`subtree worker ${agent.id} registered but could not receive the task`);
    }

    return {
      status: "started",
      launchId,
      sessionName,
      repoPath,
      role,
      laneId: input.laneId ?? null,
      agentId: agent.id,
      agentName: agent.name,
      messageId: messageResult.messageId,
      threadId: messageResult.threadId,
      monitorCommand,
      socketPath: activePaths.socketPath,
      dbPath: activePaths.dbPath,
      childLaunchEnv,
    };
  }

  function getHibernationRuntimeControl(): SubtreeHibernationRuntimeControl | null {
    if (!activeBroker || !selfAgentId || !activePaths) return null;
    return {
      db: activeBroker.db,
      brokerInstanceId: selfAgentId,
      baseLaunchEnv: buildChildLaunchEnv(activePaths, selfAgentId),
    };
  }

  return {
    start,
    getHibernationRuntimeControl,
    stop,
    getStatus,
    readInbox,
    sendMessage,
    listAgents,
    spawnWorker,
    isActive: () => activeBroker !== null,
  };
}
