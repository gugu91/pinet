import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseScheduledWakeupDelay } from "@pinet/pinet-core/scheduled-wakeups";
import {
  generateAgentName,
  agentOwnsThread,
  describeSlackUserAccess,
  formatFollowerRuntimeDiagnosticHealth,
  formatFollowerRuntimeDiagnosticNextStep,
  resolveAllowAllWorkspaceUsers,
  type FollowerRuntimeDiagnostic,
  type SlackBridgeSettings,
} from "./helpers.js";
import { formatRecentActivityLogEntries, type LoggedActivityLogEntry } from "./activity-log.js";
import { formatRuntimeGuardrailsPosture } from "./guardrails.js";
import type { PinetRuntimeControlContext } from "./pinet-remote-control.js";
import {
  formatSlackScopeDiagnosticsStatus,
  type SlackScopeDiagnostics,
} from "./slack-scope-diagnostics.js";
import type { SlackBridgeRuntimeMode } from "./runtime-mode.js";
import type { RalphSnoozeStatus } from "./ralph-loop.js";
import type {
  SubtreeBrokerStatus,
  SubtreeSpawnInput,
  SubtreeSpawnResult,
} from "./subtree-broker-runtime.js";

export interface PinetCommandsDeps {
  // State accessors
  pinetEnabled: () => boolean;
  pinetRegistrationBlocked: () => boolean;
  runtimeMode: () => SlackBridgeRuntimeMode;
  runtimeConnected: () => boolean;
  brokerRole: () => "broker" | "follower" | null;
  agentName: () => string;
  agentEmoji: () => string;
  agentOwnerToken: () => string;
  agentPersonality: () => string | null;
  agentAliases: () => Set<string>;
  botUserId: () => string | null;
  activeSkinTheme: () => string | null;
  lastDmChannel: () => string | null;
  followerRuntimeDiagnostic: () => FollowerRuntimeDiagnostic | null;
  threads: () => Map<string, { owner?: string }>;
  allowedUsers: () => Set<string> | null;
  inboxLength: () => number;
  recentActivityLogEntries: (limit: number) => ReadonlyArray<LoggedActivityLogEntry>;
  slackScopeDiagnostics: () => SlackScopeDiagnostics;
  settings: () => SlackBridgeSettings;
  lastBrokerMaintenance: () => {
    pendingBacklogCount: number;
    assignedBacklogCount: number;
    reapedAgentIds: string[];
    repairedThreadClaims: number;
    anomalies: string[];
  } | null;
  ralphSnoozeStatus?: () => RalphSnoozeStatus | null;
  snoozeRalphLoop?: (input: { durationMs: number; reason?: string | null }) => RalphSnoozeStatus;
  clearRalphSnooze?: () => RalphSnoozeStatus;
  getBrokerControlPlaneHomeTabViewerIds: () => string[];
  lastBrokerControlPlaneHomeTabRefreshAt: () => string | null;
  lastBrokerControlPlaneHomeTabError: () => string | null;
  subtreeBrokerStatus: () => SubtreeBrokerStatus;

  // Actions
  getPinetRegistrationBlockReason: () => string;
  connectAsBroker: (ctx: ExtensionContext) => Promise<void>;
  connectAsFollower: (ctx: ExtensionContext) => Promise<void>;
  reloadPinetRuntime: (ctx: ExtensionContext) => Promise<void>;
  disconnectFollower: (ctx: ExtensionContext) => Promise<{ unregisterError: string | null }>;
  startSubtreeBroker: (ctx: ExtensionContext) => Promise<SubtreeBrokerStatus>;
  stopSubtreeBroker: () => Promise<void>;
  spawnSubtreeWorker: (
    ctx: ExtensionContext,
    input: SubtreeSpawnInput,
  ) => Promise<SubtreeSpawnResult>;
  sendPinetAgentMessage: (
    target: string,
    body: string,
  ) => Promise<{ messageId: number; target: string }>;
  signalAgentFree: (
    ctx: ExtensionContext,
    options: { requirePinet?: boolean },
  ) => Promise<{ queuedInboxCount: number; drainedQueuedInbox: boolean }>;
  applyLocalAgentIdentity: (name: string, emoji: string, personality: string | null) => void;
  setExtStatus: (ctx: ExtensionContext, state: "ok" | "reconnecting" | "error" | "off") => void;
  setExtCtx: (ctx: ExtensionContext) => void;
}

export type PinetCommandAction =
  | "start"
  | "follow"
  | "unfollow"
  | "reload"
  | "exit"
  | "free"
  | "status"
  | "logs"
  | "rename"
  | "snooze"
  | "subtree";

interface ParsedPinetCommandAction {
  action: PinetCommandAction;
  args: string;
}

const PINET_PRIMARY_COMMANDS: Array<{
  action: PinetCommandAction;
  args: string;
  description: string;
}> = [
  { action: "start", args: "", description: "Start as the mesh broker" },
  { action: "follow", args: "", description: "Connect as a follower worker" },
  { action: "unfollow", args: "", description: "Disconnect from the broker" },
  { action: "reload", args: "<agent>", description: "Ask another agent to reload" },
  { action: "exit", args: "<agent>", description: "Ask another agent to exit" },
  { action: "free", args: "", description: "Mark this agent as idle" },
  { action: "snooze", args: "[duration|off|status]", description: "Quiet empty RALPH cycles" },
  {
    action: "subtree",
    args: "[start|status|spawn|stop]",
    description: "Run this worker as a subtree broker for child followers",
  },
];

const PINET_SECONDARY_COMMANDS: Array<{
  action: PinetCommandAction;
  args: string;
  description: string;
}> = [
  { action: "status", args: "", description: "Show Pinet status" },
  { action: "logs", args: "", description: "Show recent broker activity logs" },
  { action: "rename", args: "[name]", description: "Rename this Pinet agent" },
];

// ─── Registration ────────────────────────────────────────

function abortCurrentTurnBeforeBrokerReload(ctx: ExtensionContext): void {
  if (ctx.isIdle?.() ?? true) {
    return;
  }

  try {
    (ctx as PinetRuntimeControlContext).abort?.();
  } catch {
    /* best effort */
  }
}

export function formatPinetCommandHelp(): string {
  const lines = [
    "Usage: /pinet <action> [args]",
    "",
    "Primary actions:",
    ...PINET_PRIMARY_COMMANDS.map((command) =>
      formatPinetCommandHelpLine(command.action, command.args, command.description),
    ),
    "",
    "Other actions:",
    ...PINET_SECONDARY_COMMANDS.map((command) =>
      formatPinetCommandHelpLine(command.action, command.args, command.description),
    ),
  ];

  return lines.join("\n");
}

function formatPinetCommandHelpLine(
  action: PinetCommandAction,
  args: string,
  description: string,
): string {
  const command = args ? `/pinet ${action} ${args}` : `/pinet ${action}`;
  return `• ${command} — ${description}`;
}

function parsePinetCommandAction(args: string): ParsedPinetCommandAction | null {
  const trimmed = args.trim();
  if (!trimmed || trimmed === "?" || trimmed === "-h" || trimmed === "--help") {
    return null;
  }

  const [rawAction = "", ...rest] = trimmed.split(/\s+/);
  const action = normalizePinetCommandAction(rawAction);
  if (!action) {
    return null;
  }

  return {
    action,
    args: rest.join(" ").trim(),
  };
}

function normalizePinetCommandAction(rawAction: string): PinetCommandAction | null {
  const normalized = rawAction.trim().replace(/^\//, "").toLowerCase();

  switch (normalized) {
    case "start":
    case "broker":
      return "start";
    case "follow":
    case "worker":
      return "follow";
    case "unfollow":
    case "disconnect":
      return "unfollow";
    case "reload":
      return "reload";
    case "exit":
      return "exit";
    case "free":
    case "idle":
      return "free";
    case "status":
      return "status";
    case "logs":
    case "log":
      return "logs";
    case "rename":
      return "rename";
    case "snooze":
    case "quiet":
      return "snooze";
    case "subtree":
    case "subbroker":
      return "subtree";
    case "help":
      return null;
    default:
      return null;
  }
}

export async function runPinetCommandAction(
  deps: PinetCommandsDeps,
  action: PinetCommandAction,
  args: string,
  ctx: ExtensionContext,
  usageCommand = `/pinet ${action}`,
): Promise<void> {
  switch (action) {
    case "start":
      await runPinetStart(deps, ctx);
      return;
    case "follow":
      await runPinetFollow(deps, ctx);
      return;
    case "unfollow":
      await runPinetUnfollow(deps, ctx);
      return;
    case "reload":
      await runPinetReload(deps, args, ctx, usageCommand);
      return;
    case "exit":
      await runPinetExit(deps, args, ctx, usageCommand);
      return;
    case "free":
      await runPinetFree(deps, ctx);
      return;
    case "status":
      runPinetStatus(deps, ctx);
      return;
    case "logs":
      runPinetLogs(deps, ctx);
      return;
    case "rename":
      runPinetRename(deps, args, ctx);
      return;
    case "snooze":
      runPinetSnooze(deps, args, ctx);
      return;
    case "subtree":
      await runPinetSubtree(deps, args, ctx);
      return;
  }
}

export function registerPinetCommands(pi: ExtensionAPI, deps: PinetCommandsDeps): void {
  pi.registerCommand("pinet", {
    description:
      "Unified Pinet command surface: start, follow, unfollow, reload, exit, free, snooze, subtree, status, logs, rename",
    handler: async (args, ctx) => {
      const parsed = parsePinetCommandAction(args);
      if (!parsed) {
        const trimmed = args.trim();
        const tone =
          trimmed && !["help", "?", "-h", "--help"].includes(trimmed.toLowerCase())
            ? "warning"
            : "info";
        const prefix = tone === "warning" ? `Unknown Pinet action: ${trimmed}\n\n` : "";
        ctx.ui.notify(`${prefix}${formatPinetCommandHelp()}`, tone);
        return;
      }

      await runPinetCommandAction(deps, parsed.action, parsed.args, ctx);
    },
  });
}

async function runPinetStart(deps: PinetCommandsDeps, ctx: ExtensionContext): Promise<void> {
  if (deps.pinetRegistrationBlocked()) {
    ctx.ui.notify(deps.getPinetRegistrationBlockReason(), "warning");
    return;
  }
  deps.setExtCtx(ctx);

  if (deps.runtimeMode() === "broker") {
    try {
      abortCurrentTurnBeforeBrokerReload(ctx);
      ctx.ui.notify("Pinet broker already running — reloading current runtime", "info");
      await deps.reloadPinetRuntime(ctx);
    } catch (err) {
      ctx.ui.notify(`Pinet broker reload failed: ${errorMsg(err)}`, "error");
      deps.setExtStatus(ctx, "error");
    }
    return;
  }

  try {
    await deps.connectAsBroker(ctx);
  } catch (err) {
    ctx.ui.notify(`Pinet broker failed: ${errorMsg(err)}`, "error");
    deps.setExtStatus(ctx, "error");
  }
}

async function runPinetFollow(deps: PinetCommandsDeps, ctx: ExtensionContext): Promise<void> {
  if (deps.pinetRegistrationBlocked()) {
    ctx.ui.notify(deps.getPinetRegistrationBlockReason(), "warning");
    return;
  }
  if (deps.runtimeMode() === "follower") {
    ctx.ui.notify("Pinet already running (follower)", "info");
    return;
  }
  deps.setExtCtx(ctx);

  try {
    await deps.connectAsFollower(ctx);
    ctx.ui.notify(`${deps.agentEmoji()} ${deps.agentName()} — following broker`, "info");
  } catch (err) {
    ctx.ui.notify(`Pinet follow failed: ${errorMsg(err)}`, "error");
    deps.setExtStatus(ctx, "error");
  }
}

async function runPinetUnfollow(deps: PinetCommandsDeps, ctx: ExtensionContext): Promise<void> {
  if (deps.runtimeMode() !== "follower" || deps.brokerRole() == null) {
    ctx.ui.notify("Pinet is not running as a follower.", "info");
    return;
  }

  if (deps.brokerRole() !== "follower") {
    ctx.ui.notify(
      "Pinet is running as broker; /pinet unfollow only applies to followers.",
      "warning",
    );
    return;
  }

  const { unregisterError } = await deps.disconnectFollower(ctx);
  if (unregisterError) {
    ctx.ui.notify(
      `Pinet follower disconnected locally, but broker deregistration failed: ${unregisterError}`,
      "warning",
    );
    return;
  }

  ctx.ui.notify(
    `${deps.agentEmoji()} ${deps.agentName()} — disconnected from broker; local session still running`,
    "info",
  );
}

async function runPinetReload(
  deps: PinetCommandsDeps,
  args: string,
  ctx: ExtensionContext,
  usageCommand: string,
): Promise<void> {
  const target = args.trim();
  if (!target) {
    ctx.ui.notify(`Usage: ${usageCommand} <agent-name-or-id>`, "warning");
    return;
  }

  try {
    const result = await deps.sendPinetAgentMessage(target, "/reload");
    ctx.ui.notify(`Sent /reload to ${result.target}`, "info");
  } catch (err) {
    ctx.ui.notify(`Pinet reload failed: ${errorMsg(err)}`, "error");
  }
}

async function runPinetExit(
  deps: PinetCommandsDeps,
  args: string,
  ctx: ExtensionContext,
  usageCommand: string,
): Promise<void> {
  const target = args.trim();
  if (!target) {
    ctx.ui.notify(`Usage: ${usageCommand} <agent-name-or-id>`, "warning");
    return;
  }

  try {
    const result = await deps.sendPinetAgentMessage(target, "/exit");
    ctx.ui.notify(`Sent /exit to ${result.target}`, "info");
  } catch (err) {
    ctx.ui.notify(`Pinet exit failed: ${errorMsg(err)}`, "error");
  }
}

function formatDurationMs(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    seconds > 0 && hours === 0 ? `${seconds}s` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(" ") || "0s";
}

function formatRalphSnoozeStatus(status: RalphSnoozeStatus | null): string {
  if (!status) {
    return "RALPH snooze: unavailable outside broker mode";
  }
  if (!status.active) {
    return `RALPH snooze: off (${status.emptyCycleCount} empty cycle${status.emptyCycleCount === 1 ? "" : "s"})`;
  }
  return [
    `RALPH snooze: active for ${formatDurationMs(status.remainingMs)}`,
    `Until: ${status.until ?? "unknown"}`,
    `Source: ${status.source ?? "unknown"}`,
    `Reason: ${status.reason ?? "none"}`,
    `Empty cycles: ${status.emptyCycleCount}`,
  ].join("\n");
}

async function runPinetFree(deps: PinetCommandsDeps, ctx: ExtensionContext): Promise<void> {
  if (!deps.pinetEnabled()) {
    ctx.ui.notify("Pinet mesh runtime is not active. Use /pinet start or /pinet follow.", "info");
    return;
  }

  try {
    const result = await deps.signalAgentFree(ctx, { requirePinet: true });
    const suffix = result.drainedQueuedInbox
      ? ` Processing ${result.queuedInboxCount} queued inbox item${result.queuedInboxCount === 1 ? "" : "s"} now.`
      : result.queuedInboxCount > 0
        ? ` ${result.queuedInboxCount} queued inbox item${result.queuedInboxCount === 1 ? " remains" : "s remain"}.`
        : "";
    ctx.ui.notify(
      `Marked ${deps.agentEmoji()} ${deps.agentName()} idle/free for new work.${suffix}`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(`Pinet free failed: ${errorMsg(err)}`, "error");
  }
}

function runPinetSnooze(deps: PinetCommandsDeps, args: string, ctx: ExtensionContext): void {
  if (deps.runtimeMode() !== "broker") {
    ctx.ui.notify("RALPH snooze is only available while running as the Pinet broker.", "warning");
    return;
  }

  const trimmed = args.trim();
  const normalized = trimmed.toLowerCase();
  if (!trimmed || normalized === "status") {
    ctx.ui.notify(formatRalphSnoozeStatus(deps.ralphSnoozeStatus?.() ?? null), "info");
    return;
  }

  if (["off", "clear", "wake", "resume", "cancel"].includes(normalized)) {
    if (!deps.clearRalphSnooze) {
      ctx.ui.notify("RALPH snooze is unavailable in this runtime.", "warning");
      return;
    }
    ctx.ui.notify(formatRalphSnoozeStatus(deps.clearRalphSnooze()), "info");
    return;
  }

  const [durationToken = "", ...reasonParts] = trimmed.split(/\s+/);
  const durationMs = parseScheduledWakeupDelay(durationToken);
  if (durationMs == null) {
    ctx.ui.notify(
      "Usage: /pinet snooze <duration|off|status> [reason]. Example: /pinet snooze 30m no work available",
      "warning",
    );
    return;
  }

  if (!deps.snoozeRalphLoop) {
    ctx.ui.notify("RALPH snooze is unavailable in this runtime.", "warning");
    return;
  }

  const status = deps.snoozeRalphLoop({
    durationMs,
    reason: reasonParts.join(" ").trim() || "manual command",
  });
  ctx.ui.notify(formatRalphSnoozeStatus(status), "info");
}

function formatSubtreeBrokerStatus(status: SubtreeBrokerStatus): string {
  if (!status.active || !status.paths || !status.selfAgentId) {
    return "Subtree broker: off\nUse /pinet subtree start from a worker that is already following the central broker.";
  }

  const envLines = Object.entries(status.childLaunchEnv).map(([key, value]) => `${key}=${value}`);
  return [
    "Subtree broker: running",
    `Self agent: ${status.selfAgentId}`,
    `Started: ${status.startedAt ?? "unknown"}`,
    `Socket: ${status.paths.socketPath}`,
    `Database: ${status.paths.dbPath}`,
    `Lock: ${status.paths.lockPath}`,
    `Children: ${status.childCount}`,
    ...(status.spawnedWorkers.length > 0
      ? [
          "Spawned workers:",
          ...status.spawnedWorkers.map(
            (worker) =>
              `- ${worker.sessionName} role=${worker.role} agent=${worker.agentId ?? "pending"} repo=${worker.repoPath}`,
          ),
        ]
      : []),
    "Child follower environment:",
    ...envLines,
    ...(status.childLaunchHint ? ["Child launch hint:", status.childLaunchHint] : []),
  ].join("\n");
}

function parseSubtreeSpawnArgs(args: string): SubtreeSpawnInput | null {
  const tokens = args
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  let repo: string | null = null;
  let role: string | undefined;
  let laneId: string | undefined;
  const taskParts: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (token === "--") {
      taskParts.push(...tokens.slice(index + 1));
      break;
    }
    if (token === "--repo" || token === "repo") {
      if (!next) return null;
      repo = next;
      index += 1;
      continue;
    }
    if (token === "--role" || token === "role") {
      if (!next) return null;
      role = next;
      index += 1;
      continue;
    }
    if (token === "--lane" || token === "--lane-id" || token === "lane" || token === "lane_id") {
      if (!next) return null;
      laneId = next;
      index += 1;
      continue;
    }
    if (token.startsWith("repo=")) {
      repo = token.slice("repo=".length);
      continue;
    }
    if (token.startsWith("role=")) {
      role = token.slice("role=".length);
      continue;
    }
    if (token.startsWith("lane=")) {
      laneId = token.slice("lane=".length);
      continue;
    }
    if (token.startsWith("lane_id=")) {
      laneId = token.slice("lane_id=".length);
      continue;
    }
    taskParts.push(token);
  }

  const task = taskParts.join(" ").trim();
  if (!repo || !task) return null;
  return {
    repo,
    task,
    ...(role ? { role } : {}),
    ...(laneId ? { laneId } : {}),
  };
}

function formatSubtreeSpawnResult(result: SubtreeSpawnResult): string {
  return [
    "Subtree worker started",
    `Agent: ${result.agentName} (${result.agentId})`,
    `Session: ${result.sessionName}`,
    `Repo: ${result.repoPath}`,
    `Role: ${result.role}`,
    ...(result.laneId ? [`Lane: ${result.laneId}`] : []),
    `Task message: ${result.messageId}`,
    `Thread: ${result.threadId}`,
    `Monitor: ${result.monitorCommand}`,
  ].join("\n");
}

async function runPinetSubtree(
  deps: PinetCommandsDeps,
  args: string,
  ctx: ExtensionContext,
): Promise<void> {
  const [rawSubcommand = "status"] = args.trim().split(/\s+/);
  const subcommand = rawSubcommand.toLowerCase();

  if (["status", "show", "info", ""].includes(subcommand)) {
    ctx.ui.notify(formatSubtreeBrokerStatus(deps.subtreeBrokerStatus()), "info");
    return;
  }

  if (["stop", "off", "down"].includes(subcommand)) {
    await deps.stopSubtreeBroker();
    ctx.ui.notify("Subtree broker stopped. Spawned child followers were asked to exit.", "info");
    return;
  }

  if (deps.runtimeMode() !== "follower" || deps.brokerRole() !== "follower") {
    ctx.ui.notify(
      "Subtree broker operations require this session to be running as a Pinet worker/follower. Run /pinet follow first.",
      "warning",
    );
    return;
  }

  if (["spawn", "child", "worker"].includes(subcommand)) {
    const spawnInput = parseSubtreeSpawnArgs(args.trim().slice(rawSubcommand.length));
    if (!spawnInput) {
      ctx.ui.notify(
        "Usage: /pinet subtree spawn repo=<repo-or-path> [role=<role>] [lane=<lane>] <task>",
        "warning",
      );
      return;
    }

    try {
      const result = await deps.spawnSubtreeWorker(ctx, spawnInput);
      ctx.ui.notify(formatSubtreeSpawnResult(result), "info");
    } catch (err) {
      ctx.ui.notify(`Subtree worker spawn failed: ${errorMsg(err)}`, "error");
    }
    return;
  }

  if (!["start", "on", "broker", "promote"].includes(subcommand)) {
    ctx.ui.notify("Usage: /pinet subtree [start|status|spawn|stop]", "warning");
    return;
  }

  try {
    const status = await deps.startSubtreeBroker(ctx);
    ctx.ui.notify(formatSubtreeBrokerStatus(status), "info");
  } catch (err) {
    ctx.ui.notify(`Subtree broker start failed: ${errorMsg(err)}`, "error");
  }
}

function runPinetStatus(deps: PinetCommandsDeps, ctx: ExtensionContext): void {
  const mode = deps.runtimeMode();
  const ownedCount = [...deps.threads().values()].filter((t) =>
    agentOwnsThread(t.owner, deps.agentName(), deps.agentAliases(), deps.agentOwnerToken()),
  ).length;
  const users = deps.allowedUsers();
  const s = deps.settings();
  const allowlistInfo = describeSlackUserAccess(users, {
    allowAllWorkspaceUsers: resolveAllowAllWorkspaceUsers(
      s,
      process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS,
    ),
  });
  const defaultChInfo = s.defaultChannel
    ? `Default channel: ${s.defaultChannel}`
    : "Default channel: none";
  const activityLogInfo = s.logChannel
    ? `Activity log: ${s.logChannel} (${s.logLevel ?? "actions"})`
    : "Activity log: disabled";
  const guardrailsInfo = `Guardrails: ${formatRuntimeGuardrailsPosture(s.security ?? {})}`;
  const runtimeDiagnostic = deps.followerRuntimeDiagnostic();
  const runtimeHealthInfo = `Runtime health: ${formatFollowerRuntimeDiagnosticHealth(runtimeDiagnostic)}`;
  const runtimeNextStepInfo = `Next step: ${formatFollowerRuntimeDiagnosticNextStep(runtimeDiagnostic)}`;
  const slackToolHealthInfo = `Slack tool health: ${formatSlackScopeDiagnosticsStatus(deps.slackScopeDiagnostics())}`;
  const lbm = deps.lastBrokerMaintenance();
  const brokerHealthInfo =
    mode === "broker" && lbm
      ? [
          `Pending backlog: ${lbm.pendingBacklogCount}`,
          `Last maintenance: assigned ${lbm.assignedBacklogCount}, reaped ${lbm.reapedAgentIds.length}, repaired ${lbm.repairedThreadClaims}`,
          ...(lbm.anomalies.length > 0 ? [`Health: ${lbm.anomalies.join("; ")}`] : []),
        ]
      : [];
  const ralphSnoozeInfo =
    mode === "broker" ? [formatRalphSnoozeStatus(deps.ralphSnoozeStatus?.() ?? null)] : [];
  const brokerHomeTabInfo =
    mode === "broker"
      ? [
          `Home tab viewers: ${deps.getBrokerControlPlaneHomeTabViewerIds().length}`,
          ...(deps.lastBrokerControlPlaneHomeTabRefreshAt()
            ? [`Home tab refreshed: ${deps.lastBrokerControlPlaneHomeTabRefreshAt()}`]
            : []),
          ...(deps.lastBrokerControlPlaneHomeTabError()
            ? [`Home tab status: ${deps.lastBrokerControlPlaneHomeTabError()}`]
            : []),
        ]
      : [];
  const subtreeStatus = deps.subtreeBrokerStatus();
  const subtreeBrokerInfo = subtreeStatus.active
    ? [
        `Subtree broker: running (${subtreeStatus.selfAgentId ?? "unknown"})`,
        ...(subtreeStatus.paths ? [`Subtree socket: ${subtreeStatus.paths.socketPath}`] : []),
      ]
    : [];
  ctx.ui.notify(
    [
      `Mode: ${mode}`,
      `Agent: ${deps.agentEmoji()} ${deps.agentName()}`,
      `Bot: ${deps.botUserId() ?? "unknown"}`,
      `Connection: ${deps.runtimeConnected() ? "connected" : "disconnected"}`,
      runtimeHealthInfo,
      runtimeNextStepInfo,
      `Skin: ${deps.activeSkinTheme() ?? "(legacy/manual)"}`,
      ...(deps.agentPersonality() ? [`Persona: ${deps.agentPersonality()}`] : []),
      `Threads: ${deps.threads().size} (${ownedCount} owned by ${deps.agentName()})`,
      `DM channel: ${deps.lastDmChannel() ?? "none yet"}`,
      allowlistInfo,
      guardrailsInfo,
      defaultChInfo,
      activityLogInfo,
      slackToolHealthInfo,
      ...brokerHealthInfo,
      ...ralphSnoozeInfo,
      ...brokerHomeTabInfo,
      ...subtreeBrokerInfo,
    ].join("\n"),
    "info",
  );
}

function runPinetLogs(deps: PinetCommandsDeps, ctx: ExtensionContext): void {
  const s = deps.settings();
  const channelInfo = s.logChannel ? `${s.logChannel} (${s.logLevel ?? "actions"})` : "disabled";
  ctx.ui.notify(
    [
      `Activity log channel: ${channelInfo}`,
      formatRecentActivityLogEntries(deps.recentActivityLogEntries(10)),
    ].join("\n\n"),
    s.logChannel ? "info" : "warning",
  );
}

function runPinetRename(deps: PinetCommandsDeps, args: string, ctx: ExtensionContext): void {
  const newName = args.trim();
  if (!newName) {
    const fresh = generateAgentName(
      undefined,
      deps.runtimeMode() === "broker" ? "broker" : "worker",
    );
    deps.applyLocalAgentIdentity(fresh.name, fresh.emoji, deps.agentPersonality());
  } else {
    deps.applyLocalAgentIdentity(newName, deps.agentEmoji(), deps.agentPersonality());
  }
  ctx.ui.notify(`${deps.agentEmoji()} Agent renamed to: ${deps.agentName()}`, "info");
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
