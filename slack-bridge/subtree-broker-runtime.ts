import { execFile, spawn } from "node:child_process";
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
import {
  dispatchDirectAgentMessage,
  resolveDirectAgentTarget,
  resolveAgentThreadRecipient,
} from "./broker/agent-messaging.js";
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
import { reportDiagnostic } from "@pinet/transport-core/diagnostics";

const execFileAsync = promisify(execFile);
const DEFAULT_SPAWN_REGISTRATION_TIMEOUT_MS = 45_000;
const SUBTREE_CHILD_EXIT_GRACE_MS = 5_000;

export interface SubtreeBrokerPaths {
  rootDir: string;
  socketPath: string;
  dbPath: string;
  lockPath: string;
}

export type WorkerRuntimeSpec =
  | {
      runtimeKind: "tmux";
      sessionName: string;
      tmuxSocketPath: string | null;
    }
  | {
      runtimeKind: "herdr";
      sessionName: string;
      herdrSession: string;
      herdrConfigDir: string;
      herdrPaneId: string | null;
      herdrShellPid: number | null;
    };

type TmuxWorkerRuntimeSpec = Extract<WorkerRuntimeSpec, { runtimeKind: "tmux" }>;
type HerdrWorkerRuntimeSpec = Extract<WorkerRuntimeSpec, { runtimeKind: "herdr" }>;
type PendingHerdrRuntimeRecord = Omit<HerdrWorkerRuntimeSpec, "herdrPaneId" | "herdrShellPid"> & {
  launchId: string;
  herdrPaneId: string;
  herdrShellPid: number;
};

const PENDING_HERDR_RUNTIMES_SETTING = "pinet.subtreePendingHerdrRuntimes";

function readPendingHerdrRuntimes(db: BrokerDB): PendingHerdrRuntimeRecord[] {
  const records = db.getSetting<PendingHerdrRuntimeRecord[]>(PENDING_HERDR_RUNTIMES_SETTING);
  if (!Array.isArray(records)) return [];
  return records.filter(
    (record) =>
      record !== null &&
      typeof record === "object" &&
      record.runtimeKind === "herdr" &&
      typeof record.launchId === "string" &&
      record.launchId.length > 0 &&
      typeof record.sessionName === "string" &&
      record.sessionName.length > 0 &&
      typeof record.herdrSession === "string" &&
      record.herdrSession.length > 0 &&
      typeof record.herdrConfigDir === "string" &&
      record.herdrConfigDir.length > 0 &&
      typeof record.herdrPaneId === "string" &&
      record.herdrPaneId.length > 0 &&
      typeof record.herdrShellPid === "number" &&
      Number.isInteger(record.herdrShellPid) &&
      record.herdrShellPid > 0,
  );
}

function updatePendingHerdrRuntime(
  db: BrokerDB,
  launchId: string,
  spec: HerdrWorkerRuntimeSpec | null,
): void {
  const records = readPendingHerdrRuntimes(db).filter((record) => record.launchId !== launchId);
  if (spec) {
    if (!spec.herdrPaneId || spec.herdrShellPid === null) {
      throw new Error(`Herdr runtime ${spec.sessionName} has no cleanup identity`);
    }
    records.push({
      ...spec,
      launchId,
      herdrPaneId: spec.herdrPaneId,
      herdrShellPid: spec.herdrShellPid,
    });
  }
  if (records.length === 0) db.deleteSetting(PENDING_HERDR_RUNTIMES_SETTING);
  else db.setSetting(PENDING_HERDR_RUNTIMES_SETTING, records);
}

export type SubtreeWorkerRecord = WorkerRuntimeSpec & {
  launchId: string;
  repoPath: string;
  role: string;
  laneId: string | null;
  agentId: string | null;
  startedAt: string;
  monitorCommand: string;
};

interface WorkerRuntimeController<T extends WorkerRuntimeSpec> {
  createLaunchSpec: (sessionName: string) => T;
  monitorCommand: (spec: T) => string;
  launch: (
    spec: T,
    launcherPath: string,
    launchEnv: Record<string, string>,
    onRuntimeOwned?: (spec: T) => void,
  ) => Promise<void>;
  cleanup: (spec: T) => Promise<void>;
}

export interface HerdrCommandOptions {
  env: NodeJS.ProcessEnv;
  detached?: boolean;
}

export type HerdrCommandRunner = (args: string[], options: HerdrCommandOptions) => Promise<string>;

export interface HerdrWorkerRuntimeControllerOptions {
  herdrSession: string;
  herdrConfigDir: string;
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

export interface SubtreeSpawnLaunchHandle {
  launchId: string;
  tmuxSessionName: string;
  socketPath: string;
  state: "launched_unregistered";
  runtimeKind?: WorkerRuntimeSpec["runtimeKind"];
  monitorCommand?: string;
}

export class SubtreeSpawnRegistrationTimeoutError extends Error {
  readonly handle: SubtreeSpawnLaunchHandle;

  constructor(timeoutMs: number, handle: SubtreeSpawnLaunchHandle) {
    const runtimeKind = handle.runtimeKind ?? "tmux";
    const monitorHint = handle.monitorCommand ? `; monitor=${handle.monitorCommand}` : "";
    super(
      `subtree ${runtimeKind} worker ${handle.tmuxSessionName} started but did not register within ${timeoutMs}ms; ` +
        `launchId=${handle.launchId}; tmuxSessionName=${handle.tmuxSessionName}; ` +
        `socketPath=${handle.socketPath}; state=${handle.state}${monitorHint}`,
    );
    this.name = "SubtreeSpawnRegistrationTimeoutError";
    this.handle = handle;
  }
}

export class SubtreeSpawnLaunchError extends Error {
  readonly handle: SubtreeSpawnLaunchHandle;

  constructor(
    error: Error,
    handle: SubtreeSpawnLaunchHandle,
    runtimeKind: WorkerRuntimeSpec["runtimeKind"] = "tmux",
  ) {
    const message = error.message;
    super(
      `subtree worker session ${handle.tmuxSessionName} may have started after ${runtimeKind} reported: ${message}; ` +
        `launchId=${handle.launchId}; tmuxSessionName=${handle.tmuxSessionName}; ` +
        `socketPath=${handle.socketPath}; state=${handle.state}`,
      { cause: error },
    );
    this.name = "SubtreeSpawnLaunchError";
    this.handle = handle;
  }
}

export interface SubtreeSpawnInput {
  task: string;
  repo: string;
  role?: string;
  laneId?: string;
  waitForRegistrationMs?: number;
  cleanupHandle?: SubtreeSpawnLaunchHandle;
}

export interface SubtreeSpawnResult {
  status: "started";
  launchId: string;
  runtimeKind: WorkerRuntimeSpec["runtimeKind"];
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
  discardQueuedInboxMessages: (inboxIds?: number[]) => void;
  updateBadge: () => void;
  maybeDrainInboxIfIdle: (ctx: ExtensionContext) => boolean;
  deliverSteeringMessage: (text: string, ctx: ExtensionContext) => boolean;
  requestRemoteControl: (
    command: PinetControlCommand,
    ctx: ExtensionContext,
  ) => PinetRemoteControlRequestResult;
  runRemoteControl: (command: PinetControlCommand, ctx: ExtensionContext) => void;
  formatError: (error: unknown) => string;
  runTmuxCommand?: (args: string[]) => Promise<void>;
  runHerdrCommand?: HerdrCommandRunner;
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
  drainInbox: (ctx: ExtensionContext) => void;
  markDelivered: (inboxIds: number[]) => void;
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
  input: {
    launchId?: string;
    role?: string;
    laneId?: string;
    runtimeKind?: WorkerRuntimeSpec["runtimeKind"];
    tmuxSession?: string;
  } = {},
): Record<string, string> {
  return {
    PINET_SOCKET_PATH: paths.socketPath,
    PINET_BROKER_MANAGED: "1",
    PINET_BROKER_AGENT_ID: selfAgentId,
    PINET_PARENT_AGENT_ID: selfAgentId,
    PINET_ROOT_AGENT_ID: selfAgentId,
    PINET_SPAWNED_BY_AGENT_ID: selfAgentId,
    PINET_LAUNCH_SOURCE:
      input.runtimeKind === "herdr" ? "subtree-broker-herdr" : "subtree-broker-tmux",
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

function isMissingTmuxTarget(error: Error): boolean {
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return /can't find session:|no server running|error connecting to .*\(no such file or directory\)/i.test(
    `${error.message}\n${stderr}`,
  );
}

function herdrErrorText(error: Error): string {
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return `${error.message}\n${stderr}`;
}

function isMissingHerdrSession(error: Error): boolean {
  return /Error:\s*Os\s*\{\s*code:\s*2,\s*kind:\s*NotFound,\s*message:\s*"No such file or directory"\s*\}/.test(
    herdrErrorText(error),
  );
}

// agent-standards-ignore prefer-inline-single-use-helper: precise Herdr absence classifier
function isMissingHerdrPane(error: Error): boolean {
  return /"code"\s*:\s*"pane_not_found"/.test(herdrErrorText(error));
}

// agent-standards-ignore prefer-inline-single-use-helper: runtime backend construction seam
function createTmuxWorkerRuntimeController(
  runTmuxCommand: (args: string[]) => Promise<void>,
): WorkerRuntimeController<TmuxWorkerRuntimeSpec> {
  return {
    createLaunchSpec: (sessionName) => ({
      runtimeKind: "tmux",
      sessionName,
      tmuxSocketPath: findTmuxSocketPath(),
    }),
    monitorCommand: (spec) => buildTmuxMonitorCommand(spec.sessionName, spec.tmuxSocketPath),
    launch: async (spec, launcherPath) => {
      await runTmuxCommand([
        ...buildTmuxBaseArgs(spec.tmuxSocketPath),
        "new-session",
        "-d",
        "-s",
        spec.sessionName,
        launcherPath,
      ]);
    },
    cleanup: async (spec) => {
      const exactTarget = `=${spec.sessionName}`;
      try {
        await runTmuxCommand([
          ...buildTmuxBaseArgs(spec.tmuxSocketPath),
          "has-session",
          "-t",
          exactTarget,
        ]);
      } catch (error) {
        if (error instanceof Error && isMissingTmuxTarget(error)) return;
        throw error;
      }
      try {
        await runTmuxCommand([
          ...buildTmuxBaseArgs(spec.tmuxSocketPath),
          "kill-session",
          "-t",
          exactTarget,
        ]);
      } catch (error) {
        if (!(error instanceof Error) || !isMissingTmuxTarget(error)) throw error;
      }
    },
  };
}

function runHerdrSessionCommand(
  runner: HerdrCommandRunner,
  spec: HerdrWorkerRuntimeSpec,
  args: string[],
  detached = false,
): Promise<string> {
  return runner(["--session", spec.herdrSession, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: spec.herdrConfigDir },
    ...(detached ? { detached: true } : {}),
  });
}

// agent-standards-ignore prefer-inline-single-use-helper: dedicated Herdr ownership boundary
function ensureHerdrConfig(configDir: string): void {
  const herdrDir = path.join(configDir, "herdr");
  const configPath = path.join(herdrDir, "config.toml");
  fs.mkdirSync(herdrDir, { recursive: true });
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, "[experimental]\npane_history = true\n", { mode: 0o600 });
  }
}

export function createHerdrWorkerRuntimeController(
  runHerdrCommand: HerdrCommandRunner,
  options: HerdrWorkerRuntimeControllerOptions,
): WorkerRuntimeController<HerdrWorkerRuntimeSpec> {
  return {
    createLaunchSpec: (sessionName) => ({
      runtimeKind: "herdr",
      sessionName,
      herdrSession: options.herdrSession,
      herdrConfigDir: options.herdrConfigDir,
      herdrPaneId: null,
      herdrShellPid: null,
    }),
    monitorCommand: (spec) =>
      `XDG_CONFIG_HOME=${quoteShellValue(spec.herdrConfigDir)} herdr session attach ${quoteShellValue(spec.herdrSession)}`,
    launch: async (spec, launcherPath, launchEnv, onRuntimeOwned) => {
      ensureHerdrConfig(spec.herdrConfigDir);
      try {
        await runHerdrSessionCommand(runHerdrCommand, spec, ["pane", "list"]);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw new Error(
            "Herdr worker runtime is configured but the 'herdr' executable is unavailable.",
            { cause: error },
          );
        }
        if (!(error instanceof Error) || !isMissingHerdrSession(error)) throw error;
        await runHerdrSessionCommand(runHerdrCommand, spec, ["server"], true);
        let ready = false;
        let lastMissingError = error;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          try {
            await runHerdrSessionCommand(runHerdrCommand, spec, ["pane", "list"]);
            ready = true;
            break;
          } catch (probeError) {
            if (!(probeError instanceof Error) || !isMissingHerdrSession(probeError)) {
              throw probeError;
            }
            lastMissingError = probeError;
            await sleep(50);
          }
        }
        if (!ready) {
          throw new Error(`Herdr session ${spec.herdrSession} did not become ready`, {
            cause: lastMissingError,
          });
        }
      }

      const createOutput = await runHerdrSessionCommand(runHerdrCommand, spec, [
        "workspace",
        "create",
        "--cwd",
        path.dirname(launcherPath),
        "--label",
        spec.sessionName,
        ...Object.entries(launchEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        ...PER_LAUNCH_PINET_ENV_KEYS.filter((key) => !(key in launchEnv)).flatMap((key) => [
          "--env",
          `${key}=`,
        ]),
        ...SUBTREE_INHERITED_ENV_KEYS.flatMap((key) => ["--env", `${key}=`]),
        ...HERDR_UNSET_ENV_KEYS.flatMap((key) => ["--env", `${key}=`]),
        "--no-focus",
      ]);
      const createResponse = JSON.parse(createOutput) as {
        result?: { root_pane?: { pane_id?: string } };
      };
      const paneId = createResponse.result?.root_pane?.pane_id;
      if (typeof paneId !== "string" || paneId.length === 0) {
        throw new Error("Herdr workspace create returned no pane id");
      }
      spec.herdrPaneId = paneId;

      try {
        const processOutput = await runHerdrSessionCommand(runHerdrCommand, spec, [
          "pane",
          "process-info",
          "--pane",
          paneId,
        ]);
        const processResponse = JSON.parse(processOutput) as {
          result?: { process_info?: { shell_pid?: number } };
        };
        const shellPid = processResponse.result?.process_info?.shell_pid;
        if (typeof shellPid !== "number" || !Number.isInteger(shellPid) || shellPid <= 0) {
          throw new Error(`Herdr pane ${paneId} returned no shell PID`);
        }
        spec.herdrShellPid = shellPid;
        onRuntimeOwned?.(spec);
      } catch (launchError) {
        try {
          await runHerdrSessionCommand(runHerdrCommand, spec, ["pane", "close", paneId]);
          spec.herdrPaneId = null;
          spec.herdrShellPid = null;
        } catch (rollbackError) {
          if (
            rollbackError instanceof Error &&
            (isMissingHerdrPane(rollbackError) || isMissingHerdrSession(rollbackError))
          ) {
            spec.herdrPaneId = null;
            spec.herdrShellPid = null;
          } else {
            const rollbackMessage =
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            throw new Error(
              `Herdr launch failed before PID capture for pane ${paneId}, and rollback failed: ${rollbackMessage}`,
              { cause: launchError },
            );
          }
        }
        throw launchError;
      }

      await runHerdrSessionCommand(runHerdrCommand, spec, [
        "pane",
        "run",
        paneId,
        quoteShellValue(launcherPath),
      ]);
    },
    cleanup: async (spec) => {
      const paneId = spec.herdrPaneId;
      const recordedShellPid = spec.herdrShellPid;
      if (!paneId && recordedShellPid === null) return;
      if (!paneId || recordedShellPid === null) {
        throw new Error(`Herdr runtime ${spec.sessionName} has an incomplete pane generation`);
      }

      try {
        await runHerdrSessionCommand(runHerdrCommand, spec, ["pane", "get", paneId]);
        const processOutput = await runHerdrSessionCommand(runHerdrCommand, spec, [
          "pane",
          "process-info",
          "--pane",
          paneId,
        ]);
        const processResponse = JSON.parse(processOutput) as {
          result?: { process_info?: { shell_pid?: number } };
        };
        const observedShellPid = processResponse.result?.process_info?.shell_pid;
        if (
          typeof observedShellPid !== "number" ||
          !Number.isInteger(observedShellPid) ||
          observedShellPid <= 0
        ) {
          throw new Error(`Herdr pane ${paneId} returned no shell PID`);
        }
        if (observedShellPid !== recordedShellPid) {
          throw new Error(
            `Refusing to clean up Herdr pane ${paneId}: recorded shell PID ${recordedShellPid}, observed ${observedShellPid}`,
          );
        }
        await runHerdrSessionCommand(runHerdrCommand, spec, ["pane", "close", paneId]);
      } catch (error) {
        if (error instanceof Error && (isMissingHerdrPane(error) || isMissingHerdrSession(error))) {
          return;
        }
        throw error;
      }
    },
  };
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
  "PINET_HIBERNATION_RUNTIME_ACTIVATION",
  "SLACK_ALLOW_ALL_WORKSPACE_USERS",
  "SLACK_ALLOWED_USERS",
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

/**
 * Per-launch PINET identity env var NAMES. A child launch must either set
 * these explicitly or have them cleared at the pane/launcher boundary, so a
 * child can never inherit stale identity (broker owner, lane, tmux locator,
 * parentage) from the parent process environment or a shared, long-lived
 * Herdr server started by an earlier agent.
 */
const PER_LAUNCH_PINET_ENV_KEYS = [
  "PINET_BROKER_AGENT_ID",
  "PINET_BROKER_MANAGED",
  "PINET_LANE_ID",
  "PINET_LAUNCH_ID",
  "PINET_LAUNCH_SOURCE",
  "PINET_PARENT_AGENT_ID",
  "PINET_ROOT_AGENT_ID",
  "PINET_SOCKET_PATH",
  "PINET_SPAWNED_BY_AGENT_ID",
  "PINET_SUBTREE_ROLE",
  "PINET_TMUX_SESSION",
  "PINET_WAKE_CORRELATION_ID",
  "PINET_WAKE_FENCE_TOKEN",
  "PINET_WAKE_LEASE_ID",
  "PINET_WAKE_RESERVED_GENERATION",
  "PINET_WAKE_RESERVATION_NONCE",
];

const HERDR_UNSET_ENV_KEYS = ["CLAUDE_TMUX_SOCKET_DIR", "TMUX", "TMUX_PANE"];

function buildLauncherScript(input: {
  runtimeKind: WorkerRuntimeSpec["runtimeKind"];
  repoPath: string;
  env: Record<string, string>;
  extensionEntryPath: string;
  startupPrompt: string;
}): string {
  const inheritedEnv = SUBTREE_INHERITED_ENV_KEYS.map((key) => {
    const value = process.env[key];
    return value ? `export ${key}=${quoteShellValue(value)}` : `unset ${key}`;
  });
  const envExports = Object.entries(input.env).map(
    ([key, value]) => `export ${key}=${quoteShellValue(value)}`,
  );
  const nickname = `Subtree ${input.env.PINET_SUBTREE_ROLE ?? "Worker"} ${input.env.PINET_LAUNCH_ID ?? randomSuffix()}`;

  return [
    "#!/bin/bash",
    "set -euo pipefail",
    `cd ${quoteShellValue(input.repoPath)}`,
    ...(input.runtimeKind === "herdr" ? HERDR_UNSET_ENV_KEYS.map((key) => `unset ${key}`) : []),
    ...inheritedEnv,
    ...envExports,
    ...PER_LAUNCH_PINET_ENV_KEYS.filter((key) => !(key in input.env)).map((key) => `unset ${key}`),
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
  let brokerStartPromise: Promise<SubtreeBrokerStatus> | null = null;
  const spawnedWorkers = new Map<string, SubtreeWorkerRecord>();
  const fencedLaunchIds = new Set<string>();
  const pendingInboxIds = new Set<number>();
  const runTmuxCommand =
    deps.runTmuxCommand ??
    (async (args: string[]): Promise<void> => {
      await execFileAsync("tmux", args);
    });
  const runHerdrCommand =
    deps.runHerdrCommand ??
    (async (args: string[], options: HerdrCommandOptions): Promise<string> => {
      if (!options.detached) {
        const { stdout } = await execFileAsync("herdr", args, { env: options.env });
        return stdout;
      }
      await new Promise<void>((resolve, reject) => {
        const child = spawn("herdr", args, {
          detached: true,
          env: options.env,
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
      return "";
    });
  const workerRuntimeControllers = {
    tmux: createTmuxWorkerRuntimeController(runTmuxCommand),
    herdr: createHerdrWorkerRuntimeController(runHerdrCommand, {
      herdrSession: "pinet-workers",
      herdrConfigDir: path.join(os.homedir(), ".pi", "pinet-herdr-config"),
    }),
  };

  // agent-standards-ignore prefer-inline-single-use-helper: discriminated runtime cleanup dispatch
  function cleanupWorkerRuntime(spec: WorkerRuntimeSpec): Promise<void> {
    return spec.runtimeKind === "tmux"
      ? workerRuntimeControllers.tmux.cleanup(spec)
      : workerRuntimeControllers.herdr.cleanup(spec);
  }

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

  function fenceLaunch(broker: Broker, launchId: string): void {
    fencedLaunchIds.add(launchId);
    for (const agent of broker.db.getAllAgents()) {
      if (metadataString(agent.metadata, "launchId") === launchId) {
        broker.server.disconnectAgentConnections(agent.id);
        broker.db.unregisterAgent(agent.id);
      }
    }
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
    const entries = broker.db
      .getInbox(agentId)
      .filter((item) => !pendingInboxIds.has(item.entry.id))
      .map(toFollowerInboxEntry);
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
    const inboxMessages = synced.inboxMessages.map((message) => ({
      ...message,
      brokerInboxOrigin: "subtree" as const,
    }));
    deps.pushInboxMessages(inboxMessages);
    for (const message of inboxMessages) {
      if (message.brokerInboxId != null) pendingInboxIds.add(message.brokerInboxId);
    }
    deps.updateBadge();
    deps.maybeDrainInboxIfIdle(ctx);
  }

  function drainInbox(ctx: ExtensionContext): void {
    if (!activeBroker || !selfAgentId) return;
    drainSelfInbox(ctx, activeBroker, selfAgentId);
  }

  function markDelivered(inboxIds: number[]): void {
    if (!activeBroker || !selfAgentId) return;
    activeBroker.db.markDelivered(inboxIds, selfAgentId);
    for (const inboxId of inboxIds) pendingInboxIds.delete(inboxId);
  }

  function readInbox(options: PinetReadOptions = {}): PinetReadResult | null {
    if (!activeBroker || !selfAgentId) return null;
    if (options.threadId && !activeBroker.db.getThread(options.threadId)) return null;
    const result = activeBroker.db.readInbox(selfAgentId, options);
    if (result.markedReadIds.length > 0) {
      markDelivered(result.markedReadIds);
      deps.discardQueuedInboxMessages(result.markedReadIds);
      deps.updateBadge();
    }
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
    const agents = activeBroker.db.getAgents();
    const targetAgent = target
      ? resolveDirectAgentTarget(agents, target)
      : typeof metadata?.threadId === "string"
        ? resolveAgentThreadRecipient(agents, selfAgentId, metadata.threadId)
        : null;
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
    await runTmuxCommand([
      ...tmuxBaseArgs,
      "send-keys",
      "-t",
      sessionName,
      "-l",
      "--",
      "/pinet follow",
    ]);
    await runTmuxCommand([...tmuxBaseArgs, "send-keys", "-t", sessionName, "Enter"]);
  }

  async function waitForSpawnedAgent(input: {
    broker: Broker;
    handle: SubtreeSpawnLaunchHandle;
    runtimeSpec: WorkerRuntimeSpec;
    timeoutMs: number;
  }): Promise<AgentInfo> {
    const deadline = Date.now() + input.timeoutMs;
    let lastFollowAttemptAt = 0;

    while (Date.now() < deadline) {
      const agent = input.broker.db
        .getAllAgents()
        .find(
          (candidate) => metadataString(candidate.metadata, "launchId") === input.handle.launchId,
        );
      if (agent) return agent;

      if (input.runtimeSpec.runtimeKind === "tmux" && Date.now() - lastFollowAttemptAt > 6_000) {
        lastFollowAttemptAt = Date.now();
        await sendFollowCommand(
          input.runtimeSpec.sessionName,
          buildTmuxBaseArgs(input.runtimeSpec.tmuxSocketPath),
        ).catch(() => {
          // The session may still be starting; the loop retries until timeout.
        });
      }

      await sleep(Math.min(1_000, Math.max(1, deadline - Date.now())));
    }

    fenceLaunch(input.broker, input.handle.launchId);
    throw new SubtreeSpawnRegistrationTimeoutError(input.timeoutMs, input.handle);
  }

  async function requestChildExit(agent: AgentInfo): Promise<void> {
    await sendMessage(agent.id, "/exit", { subtreeLifecycle: "stop" }).catch(() => null);
  }

  // agent-standards-ignore prefer-inline-single-use-helper: restart-safe runtime cleanup resolution
  function childRuntimeSpecs(broker: Broker, agentId: string): WorkerRuntimeSpec[] {
    const specs = new Map<string, WorkerRuntimeSpec>();
    const addSpec = (spec: WorkerRuntimeSpec): void => {
      const key =
        spec.runtimeKind === "tmux"
          ? `tmux:${spec.tmuxSocketPath ?? ""}:${spec.sessionName}`
          : `herdr:${spec.herdrConfigDir}:${spec.herdrSession}:${spec.herdrPaneId ?? ""}:${spec.herdrShellPid ?? ""}`;
      specs.set(key, spec);
    };
    const workers = [...spawnedWorkers.values()];
    for (const worker of workers) addSpec(worker);
    const activeLaunchIds = new Set(spawnedWorkers.keys());
    for (const { launchId, ...spec } of readPendingHerdrRuntimes(broker.db)) {
      if (!activeLaunchIds.has(launchId)) addSpec(spec);
    }
    const recordedAgentIds = new Set(
      workers.flatMap((worker) => (worker.agentId ? [worker.agentId] : [])),
    );
    for (const agent of broker.db.getAllAgents()) {
      if (!isSubtreeChildAgent(agent, agentId) || recordedAgentIds.has(agent.id)) continue;
      const durableSpec = broker.db.getAgentRuntimeSpec(agent.id);
      if (durableSpec?.runtimeKind === "tmux") {
        addSpec({
          runtimeKind: "tmux",
          sessionName: durableSpec.tmuxSession,
          tmuxSocketPath: durableSpec.tmuxSocket,
        });
        continue;
      }
      if (durableSpec?.runtimeKind === "herdr") {
        addSpec({
          runtimeKind: "herdr",
          sessionName: agent.id,
          herdrSession: durableSpec.herdrSession,
          herdrConfigDir: durableSpec.herdrConfigDir,
          herdrPaneId: durableSpec.herdrPaneId,
          herdrShellPid: durableSpec.herdrShellPid,
        });
        continue;
      }
      const tmuxSession = metadataString(agent.metadata, "tmuxSession");
      const metadataRuntimeKind = metadataString(agent.metadata, "runtimeKind");
      const launchSource = metadataString(agent.metadata, "launchSource");
      if (
        metadataRuntimeKind === "herdr" ||
        launchSource === "broker-herdr" ||
        launchSource === "subtree-broker-herdr"
      ) {
        if (tmuxSession) {
          reportDiagnostic(
            "warning",
            `[slack-bridge] Ignoring inherited tmuxSession metadata for Herdr child ${agent.id}; no durable Herdr runtime spec is available for cleanup.`,
          );
        }
        continue;
      }
      if (tmuxSession) {
        addSpec({
          runtimeKind: "tmux",
          sessionName: tmuxSession,
          tmuxSocketPath: findTmuxSocketPath(),
        });
      }
    }
    return [...specs.values()];
  }

  async function stopChildren(broker: Broker, agentId: string): Promise<void> {
    const children = broker.db
      .getAllAgents()
      .filter((agent) => isSubtreeChildAgent(agent, agentId));
    await Promise.all(children.map(requestChildExit));
    if (children.length > 0) {
      await sleep(SUBTREE_CHILD_EXIT_GRACE_MS);
    }

    const cleanupResults = await Promise.all(
      childRuntimeSpecs(broker, agentId).map(async (spec) => {
        try {
          await cleanupWorkerRuntime(spec);
          return true;
        } catch {
          return false;
        }
      }),
    );
    if (cleanupResults.every(Boolean)) {
      broker.db.deleteSetting(PENDING_HERDR_RUNTIMES_SETTING);
    }
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
      fencedLaunchIds.clear();
      deps.discardQueuedInboxMessages();
      pendingInboxIds.clear();
      deps.updateBadge();
    }
  }

  // agent-standards-ignore prefer-inline-single-use-helper: single-flight start implementation
  async function startOnce(ctx: ExtensionContext): Promise<SubtreeBrokerStatus> {
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
      beforeListen: async ({ db }) => {
        const pendingHerdrRuntimes = readPendingHerdrRuntimes(db);
        for (const pending of pendingHerdrRuntimes) {
          const spec: HerdrWorkerRuntimeSpec = pending;
          await cleanupWorkerRuntime(spec);
        }
        if (pendingHerdrRuntimes.length > 0) {
          db.deleteSetting(PENDING_HERDR_RUNTIMES_SETTING);
        }
        if (runtimeActive) {
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
        }
      },
    });

    try {
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
        const launchId = metadataString(registration.metadata, "launchId");
        if (launchId && fencedLaunchIds.has(launchId)) {
          throw new Error("spawn launch has already been cleaned up");
        }
        const role = deps.getMeshRoleFromMetadata(registration.metadata, "worker");
        const identity = generateAgentName(registration.stableId ?? registration.agentId, role);
        const worker = launchId ? spawnedWorkers.get(launchId) : undefined;
        return {
          name: registration.name || identity.name,
          emoji: registration.emoji || identity.emoji,
          metadata: {
            ...(registration.metadata ?? {}),
            ...(worker
              ? {
                  runtimeKind: worker.runtimeKind,
                  runtimeLocator:
                    worker.runtimeKind === "tmux"
                      ? worker.sessionName
                      : (worker.herdrPaneId ?? worker.sessionName),
                }
              : {}),
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

      broker.db.recoverPendingTargetedBacklog(selfAgent.id);
      drainSelfInbox(ctx, broker, selfAgent.id);
      broker.db.setSetting("pinet.subtreeBrokerParentStableId", deps.getAgentStableId());
      broker.db.setSetting("pinet.subtreeBrokerOwnerToken", buildPinetOwnerToken(stableId));
      return getStatus();
    } catch (error) {
      stopHeartbeat();
      activeBroker = null;
      selfAgentId = null;
      startedAt = null;
      activePaths = null;
      deps.discardQueuedInboxMessages();
      pendingInboxIds.clear();
      deps.updateBadge();
      await broker.stop().catch(() => undefined);
      throw error;
    }
  }

  function start(ctx: ExtensionContext): Promise<SubtreeBrokerStatus> {
    if (activeBroker) return Promise.resolve(getStatus());
    if (!brokerStartPromise) {
      brokerStartPromise = startOnce(ctx).finally(() => {
        brokerStartPromise = null;
      });
    }
    return brokerStartPromise;
  }

  async function spawnWorker(
    ctx: ExtensionContext,
    input: SubtreeSpawnInput,
  ): Promise<SubtreeSpawnResult> {
    if (!input.task.trim()) throw new Error("spawn requires task");
    if (!input.repo.trim()) throw new Error("spawn requires repo");
    await start(ctx);
    if (!activeBroker || !activePaths || !selfAgentId) {
      throw new Error("Subtree broker is not running.");
    }
    const broker = activeBroker;
    if (input.cleanupHandle) {
      const handle = input.cleanupHandle;
      if (!activePaths || handle.socketPath !== activePaths.socketPath) {
        throw new Error("spawn cleanup handle does not belong to this subtree broker");
      }
      const worker = spawnedWorkers.get(handle.launchId);
      if (!worker) {
        throw new Error(
          fencedLaunchIds.has(handle.launchId)
            ? "spawn cleanup handle has already been consumed"
            : "spawn cleanup handle does not belong to this subtree broker",
        );
      }
      if (worker.sessionName !== handle.tmuxSessionName) {
        throw new Error("spawn cleanup handle does not match its recorded tmux session");
      }

      fenceLaunch(activeBroker, handle.launchId);
      spawnedWorkers.delete(handle.launchId);
      try {
        await cleanupWorkerRuntime(worker);
        if (worker.runtimeKind === "herdr") {
          updatePendingHerdrRuntime(activeBroker.db, handle.launchId, null);
        }
      } catch (error) {
        spawnedWorkers.set(handle.launchId, worker);
        throw error;
      }
    }

    const socketPath = activePaths.socketPath;
    const repoPath = resolveRepoPath(input.repo, deps.cwd);
    const role = normalizeRole(input.role);
    const launchId = `subtree-${Date.now().toString(36)}-${randomSuffix()}`;
    const sessionName = buildTmuxSessionName(repoPath, role, launchId);
    const configuredRuntime = (deps.getSettings() as { subtreeWorkerRuntime?: string })
      .subtreeWorkerRuntime;
    const runtimeKind = configuredRuntime === undefined ? "tmux" : configuredRuntime;
    if (runtimeKind !== "tmux" && runtimeKind !== "herdr") {
      const invalidValue = JSON.stringify(runtimeKind);
      throw new Error(
        `Invalid subtreeWorkerRuntime setting ${invalidValue}; valid options are "tmux" and "herdr".`,
      );
    }
    const runtimeSpec: WorkerRuntimeSpec =
      runtimeKind === "tmux"
        ? workerRuntimeControllers.tmux.createLaunchSpec(sessionName)
        : workerRuntimeControllers.herdr.createLaunchSpec(sessionName);
    const monitorCommand =
      runtimeSpec.runtimeKind === "tmux"
        ? workerRuntimeControllers.tmux.monitorCommand(runtimeSpec)
        : workerRuntimeControllers.herdr.monitorCommand(runtimeSpec);
    const childLaunchEnv = buildChildLaunchEnv(activePaths, selfAgentId, {
      launchId,
      role,
      runtimeKind: runtimeSpec.runtimeKind,
      ...(input.laneId ? { laneId: input.laneId } : {}),
      ...(runtimeSpec.runtimeKind === "tmux" ? { tmuxSession: sessionName } : {}),
    });
    const launchersDir = path.join(activePaths.rootDir, "launchers");
    fs.mkdirSync(launchersDir, { recursive: true });
    const launcherPath = path.join(launchersDir, `${sessionName}.sh`);
    fs.writeFileSync(
      launcherPath,
      buildLauncherScript({
        runtimeKind: runtimeSpec.runtimeKind,
        repoPath,
        env: childLaunchEnv,
        extensionEntryPath: getExtensionEntryPath(),
        startupPrompt: childStartupPrompt(selfAgentId),
      }),
      { mode: 0o700 },
    );

    const workerRecord = {
      ...runtimeSpec,
      launchId,
      repoPath,
      role,
      laneId: input.laneId ?? null,
      agentId: null,
      startedAt: new Date().toISOString(),
      monitorCommand,
    } satisfies SubtreeWorkerRecord;
    const launchHandle: SubtreeSpawnLaunchHandle = {
      launchId,
      tmuxSessionName: sessionName,
      socketPath,
      state: "launched_unregistered",
      runtimeKind: workerRecord.runtimeKind,
      monitorCommand: workerRecord.monitorCommand,
    };
    spawnedWorkers.set(launchId, workerRecord);
    try {
      if (workerRecord.runtimeKind === "tmux") {
        await workerRuntimeControllers.tmux.launch(workerRecord, launcherPath, childLaunchEnv);
      } else {
        await workerRuntimeControllers.herdr.launch(
          workerRecord,
          launcherPath,
          childLaunchEnv,
          (spec) => updatePendingHerdrRuntime(broker.db, launchId, spec),
        );
      }
    } catch (error) {
      fenceLaunch(activeBroker, launchId);
      throw new SubtreeSpawnLaunchError(
        error instanceof Error ? error : new Error(String(error)),
        launchHandle,
        workerRecord.runtimeKind,
      );
    }

    const agent = await waitForSpawnedAgent({
      broker: activeBroker,
      handle: launchHandle,
      runtimeSpec: workerRecord,
      timeoutMs: input.waitForRegistrationMs ?? DEFAULT_SPAWN_REGISTRATION_TIMEOUT_MS,
    });
    const updatedRecord: SubtreeWorkerRecord = { ...workerRecord, agentId: agent.id };
    spawnedWorkers.set(launchId, updatedRecord);

    const commonRuntimeFacts = {
      agentId: agent.id,
      stableId: agent.stableId ?? "",
      brokerOwnerId: selfAgentId,
      cwd: repoPath,
      repoRoot: repoPath,
      worktreePath: repoPath,
      extensionEntryPath: getExtensionEntryPath(),
      envAllowlist: Object.keys(childLaunchEnv),
      configFingerprint: `subtree-broker-${workerRecord.runtimeKind}`,
      expectedUser: os.userInfo().username,
      launchSource: childLaunchEnv.PINET_LAUNCH_SOURCE,
    };
    if (workerRecord.runtimeKind === "tmux") {
      if (hibernationRuntimeActive()) {
        await persistSpawnedRuntimeSpec(activeBroker.db, {
          ...commonRuntimeFacts,
          runtimeKind: "tmux",
          tmuxSocket: workerRecord.tmuxSocketPath ?? "",
          tmuxSession: workerRecord.sessionName,
          tmuxTarget: workerRecord.sessionName,
        });
      }
    } else {
      let persisted = false;
      let persistenceError: Error | null = null;
      if (workerRecord.herdrPaneId && workerRecord.herdrShellPid !== null) {
        try {
          persisted = Boolean(
            await persistSpawnedRuntimeSpec(activeBroker.db, {
              ...commonRuntimeFacts,
              runtimeKind: "herdr",
              herdrSession: workerRecord.herdrSession,
              herdrConfigDir: workerRecord.herdrConfigDir,
              herdrPaneId: workerRecord.herdrPaneId,
              herdrShellPid: workerRecord.herdrShellPid,
            }),
          );
        } catch (error) {
          persistenceError = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (persisted) {
        updatePendingHerdrRuntime(activeBroker.db, launchId, null);
      } else {
        const failureMessage = `Herdr worker ${agent.id} has no durable restart-safe cleanup identity`;
        const failure = persistenceError
          ? new Error(failureMessage, { cause: persistenceError })
          : new Error(failureMessage);
        fenceLaunch(activeBroker, launchId);
        await requestChildExit(agent);
        try {
          await cleanupWorkerRuntime(workerRecord);
          updatePendingHerdrRuntime(activeBroker.db, launchId, null);
          spawnedWorkers.delete(launchId);
          activeBroker.db.unregisterAgent(agent.id);
        } catch (error) {
          throw new SubtreeSpawnLaunchError(
            new Error(`${failure.message}; cleanup also failed`, {
              cause: error instanceof Error ? error : new Error(String(error)),
            }),
            launchHandle,
            "herdr",
          );
        }
        throw new Error(`${failure.message}; worker stopped`, { cause: failure });
      }
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
      runtimeKind: workerRecord.runtimeKind,
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
    drainInbox,
    markDelivered,
    readInbox,
    sendMessage,
    listAgents,
    spawnWorker,
    isActive: () => activeBroker !== null,
  };
}
