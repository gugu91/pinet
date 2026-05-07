import * as os from "node:os";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type RalphLoopAgentWorkload,
  type RalphLoopEvaluationOptions,
  type RalphLoopEvaluationResult,
  type SlackBridgeSettings,
  evaluateRalphLoopCycle,
  rewriteRalphLoopGhostAnomalies,
  buildAgentDisplayInfo,
  buildRalphLoopNudgeMessage,
  buildRalphLoopAnomalySignature,
  buildRalphLoopCycleNotifications,
  buildRalphLoopStatusMessage,
  shouldDeliverRalphLoopFollowUp,
  filterAgentsForMeshVisibility,
  resolveRalphLoopIntervalMs,
  resolveRalphSnoozeAfterEmptyCycles,
  resolveRalphSnoozeDurationMs,
  DEFAULT_RALPH_LOOP_NUDGE_COOLDOWN_MS,
  DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS,
  DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
} from "./helpers.js";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from "./broker/socket-server.js";
import { HEARTBEAT_INTERVAL_MS } from "./broker/client.js";
import {
  getPendingTaskAssignmentReport,
  hasTaskAssignmentStatusChange,
  normalizeTrackedTaskAssignments,
  resolveTaskAssignments,
  type ResolvedTaskAssignment,
} from "./task-assignments.js";
import type { ActivityLogEntry, ActivityLogTone } from "./activity-log.js";
import { probeGitBranch } from "./git-metadata.js";
import type { BrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-dashboard.js";
import type { BrokerMaintenanceResult } from "./broker/maintenance.js";
import type { BrokerDB, TaskAssignmentAwaitingReplyInfo } from "./broker/schema.js";
import type { TaskAssignmentInfo } from "./broker/types.js";

// ─── State ───────────────────────────────────────────────

export type RalphSnoozeSource = "manual" | "auto";

export interface RalphSnoozeStatus {
  active: boolean;
  until: string | null;
  remainingMs: number;
  reason: string | null;
  source: RalphSnoozeSource | null;
  emptyCycleCount: number;
}

export interface RalphLoopState {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  nudges: Map<string, number>;
  reportedGhosts: Set<string>;
  ghostBaselineHydrated: boolean;
  nonGhostSignature: string;
  hadOutstandingAnomalies: boolean;
  followUpAt: number;
  followUpPending: boolean;
  followUpSignature: string;
  taskAssignmentReportSignature: string;
  pendingTaskAssignmentReport: { message: string; signature: string } | null;
  snoozeUntilMs: number;
  snoozeReason: string | null;
  snoozeSource: RalphSnoozeSource | null;
  snoozeEmptyCycleCount: number;
}

export function createRalphLoopState(): RalphLoopState {
  return {
    timer: null,
    running: false,
    nudges: new Map(),
    reportedGhosts: new Set(),
    ghostBaselineHydrated: false,
    nonGhostSignature: "",
    hadOutstandingAnomalies: false,
    followUpAt: 0,
    followUpPending: false,
    followUpSignature: "",
    taskAssignmentReportSignature: "",
    pendingTaskAssignmentReport: null,
    snoozeUntilMs: 0,
    snoozeReason: null,
    snoozeSource: null,
    snoozeEmptyCycleCount: 0,
  };
}

export function resetRalphLoopState(state: RalphLoopState): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.running = false;
  state.nudges.clear();
  state.reportedGhosts.clear();
  state.ghostBaselineHydrated = false;
  state.nonGhostSignature = "";
  state.hadOutstandingAnomalies = false;
  state.followUpAt = 0;
  state.followUpPending = false;
  state.followUpSignature = "";
  state.taskAssignmentReportSignature = "";
  state.pendingTaskAssignmentReport = null;
  clearRalphLoopSnooze(state);
}

export function getRalphLoopSnoozeStatus(
  state: Pick<
    RalphLoopState,
    "snoozeUntilMs" | "snoozeReason" | "snoozeSource" | "snoozeEmptyCycleCount"
  >,
  now = Date.now(),
): RalphSnoozeStatus {
  const remainingMs = Math.max(0, state.snoozeUntilMs - now);
  return {
    active: remainingMs > 0,
    until: remainingMs > 0 ? new Date(state.snoozeUntilMs).toISOString() : null,
    remainingMs,
    reason: remainingMs > 0 ? state.snoozeReason : null,
    source: remainingMs > 0 ? state.snoozeSource : null,
    emptyCycleCount: state.snoozeEmptyCycleCount,
  };
}

export function setRalphLoopSnooze(
  state: Pick<
    RalphLoopState,
    "snoozeUntilMs" | "snoozeReason" | "snoozeSource" | "snoozeEmptyCycleCount"
  >,
  input: { durationMs: number; reason?: string | null; source?: RalphSnoozeSource; now?: number },
): RalphSnoozeStatus {
  const now = input.now ?? Date.now();
  state.snoozeUntilMs = now + Math.max(0, Math.trunc(input.durationMs));
  state.snoozeReason = input.reason?.trim() || null;
  state.snoozeSource = input.source ?? "manual";
  return getRalphLoopSnoozeStatus(state, now);
}

export function clearRalphLoopSnooze(
  state: Pick<
    RalphLoopState,
    "snoozeUntilMs" | "snoozeReason" | "snoozeSource" | "snoozeEmptyCycleCount"
  >,
): void {
  state.snoozeUntilMs = 0;
  state.snoozeReason = null;
  state.snoozeSource = null;
  state.snoozeEmptyCycleCount = 0;
}

function isActiveTrackedAssignment(
  assignment: Pick<ResolvedTaskAssignment, "status" | "issueState">,
): boolean {
  return (
    assignment.issueState !== "CLOSED" &&
    assignment.status !== "pr_merged" &&
    assignment.status !== "pr_closed"
  );
}

function formatTrackedAssignmentIssueList(issueNumbers: readonly number[]): string {
  return issueNumbers.map((issueNumber) => `#${issueNumber}`).join(", ");
}

function buildTrackedAssignmentIdleReplyStallAnomaly(
  agentName: string,
  issueNumbers: readonly number[],
): string {
  const label = issueNumbers.length === 1 ? "assignment" : "assignments";
  return `${agentName} idle after tracked ${label} ${formatTrackedAssignmentIssueList(issueNumbers)} without any agent reply to the original sender`;
}

export function buildTrackedAssignmentReplyNudgeMessage(
  issueNumbers: readonly number[],
  cycleStartedAt?: string,
): string {
  const prefix = cycleStartedAt ? `RALPH LOOP nudge (${cycleStartedAt})` : "RALPH LOOP nudge";
  const label = issueNumbers.length === 1 ? "assignment" : "assignments";
  return `${prefix}: you are idle after tracked ${label} ${formatTrackedAssignmentIssueList(issueNumbers)} and still have not sent any agent reply to the original sender. Please report outcome or blocker now.`;
}

export function applyTrackedAssignmentIdleReplyStalls(
  evaluation: RalphLoopEvaluationResult,
  workloads: ReadonlyArray<
    Pick<
      RalphLoopAgentWorkload,
      "id" | "name" | "status" | "lastHeartbeat" | "lastSeen" | "disconnectedAt" | "resumableUntil"
    >
  >,
  awaitingReplyAssignments: ReadonlyArray<TaskAssignmentAwaitingReplyInfo>,
  options: Pick<
    RalphLoopEvaluationOptions,
    "now" | "heartbeatTimeoutMs" | "heartbeatIntervalMs"
  > = {},
): Map<string, number[]> {
  const idleHealthyWorkloads = new Map(
    workloads
      .filter((workload) => {
        if (workload.status !== "idle" || workload.disconnectedAt != null) {
          return false;
        }

        return buildAgentDisplayInfo({ emoji: "", ...workload }, options).health === "healthy";
      })
      .map((workload) => [workload.id, workload] as const),
  );
  const pendingIssuesByAgent = new Map<string, Set<number>>();

  for (const assignment of awaitingReplyAssignments) {
    if (!idleHealthyWorkloads.has(assignment.agentId)) {
      continue;
    }
    const issues = pendingIssuesByAgent.get(assignment.agentId) ?? new Set<number>();
    issues.add(assignment.issueNumber);
    pendingIssuesByAgent.set(assignment.agentId, issues);
  }

  const result = new Map<string, number[]>();
  for (const [agentId, issues] of pendingIssuesByAgent) {
    const issueNumbers = [...issues].sort((left, right) => left - right);
    if (!evaluation.nudgeAgentIds.includes(agentId)) {
      evaluation.nudgeAgentIds.push(agentId);
    }
    const agentName = idleHealthyWorkloads.get(agentId)?.name ?? agentId;
    evaluation.anomalies.push(buildTrackedAssignmentIdleReplyStallAnomaly(agentName, issueNumbers));
    result.set(agentId, issueNumbers);
  }

  return result;
}

// ─── Callbacks ───────────────────────────────────────────

export function hydrateRalphLoopReportedGhosts(
  state: Pick<RalphLoopState, "reportedGhosts" | "ghostBaselineHydrated">,
  recentCycles: Array<{ ghostAgentIds: string[] }>,
): void {
  if (state.ghostBaselineHydrated) {
    return;
  }

  if (state.reportedGhosts.size > 0) {
    state.ghostBaselineHydrated = true;
    return;
  }

  for (const ghostId of recentCycles[0]?.ghostAgentIds ?? []) {
    state.reportedGhosts.add(ghostId);
  }
  state.ghostBaselineHydrated = true;
}

export interface RalphLoopDeps {
  // Broker access
  getBrokerDb: () => BrokerDB | null;
  getBrokerAgentId: () => string | null;
  heartbeatTimerActive: () => boolean;
  maintenanceTimerActive: () => boolean;

  // Callbacks
  runMaintenance: (ctx: ExtensionContext) => void;
  sendMaintenanceMessage: (targetAgentId: string, body: string) => void;
  trySendFollowUp: (body: string, onDelivered: () => void) => void;
  logActivity: (entry: ActivityLogEntry) => void;
  formatTrackedAgent: (agentId: string) => string;
  summarizeTrackedAssignmentStatus: (
    status: string,
    prNumber: number | null,
    branch: string | null,
  ) => { summary: string; tone?: string };
  refreshHomeTabs: (
    ctx: ExtensionContext,
    snapshot: BrokerControlPlaneDashboardSnapshot,
    refreshedAt: string,
  ) => Promise<void>;
  getLastMaintenance: () => BrokerMaintenanceResult | null;
  getSettings?: () => SlackBridgeSettings;

  // Snapshot builder
  buildControlPlaneDashboardSnapshot: (
    input: Record<string, unknown>,
  ) => BrokerControlPlaneDashboardSnapshot;

  // State setters for control plane tracking
  setLastHomeTabSnapshot: (snapshot: BrokerControlPlaneDashboardSnapshot) => void;
  getLastHomeTabError: () => string | null;
  setLastHomeTabError: (err: string | null) => void;
}

// ─── Core loop ───────────────────────────────────────────

export async function runRalphLoopCycle(
  ctx: ExtensionContext,
  state: RalphLoopState,
  deps: RalphLoopDeps,
): Promise<void> {
  const db = deps.getBrokerDb();
  const selfId = deps.getBrokerAgentId();
  if (!db || !selfId || state.running) return;

  state.running = true;
  const cycleStartedAt = new Date().toISOString();
  const cycleStartMs = Date.now();
  try {
    hydrateRalphLoopReportedGhosts(state, db.getRecentRalphCycles(1));
    deps.runMaintenance(ctx);
    const lastMaintenance = deps.getLastMaintenance();

    const currentBranch = (await probeGitBranch(process.cwd())) ?? null;
    const now = Date.now();
    const recentGhostWindowMs = DEFAULT_HEARTBEAT_TIMEOUT_MS * 2;

    const workloads = filterAgentsForMeshVisibility(db.getAllAgents(), {
      now,
      includeGhosts: true,
      recentDisconnectWindowMs: recentGhostWindowMs,
    }).map((agent) => ({
      ...agent,
      pendingInboxCount: db.getPendingInboxCount(agent.id),
      ownedThreadCount: db.getOwnedThreadCount(agent.id),
    }));
    const pendingBacklogCount = db.getBacklogCount("pending");
    const evaluationOptions: RalphLoopEvaluationOptions = {
      now,
      heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
      pendingBacklogCount,
      currentBranch,
      brokerHeartbeatActive: deps.heartbeatTimerActive(),
      brokerMaintenanceActive: deps.maintenanceTimerActive(),
      brokerAgentId: selfId,
    };
    const evaluation = evaluateRalphLoopCycle(workloads, evaluationOptions);
    const trackedAssignmentIdleReplyStalls = applyTrackedAssignmentIdleReplyStalls(
      evaluation,
      workloads,
      db.listTaskAssignmentsAwaitingFirstReply(),
      evaluationOptions,
    );

    const nudgeAgentIds = new Set(evaluation.nudgeAgentIds);
    for (const workload of workloads) {
      if (!nudgeAgentIds.has(workload.id)) {
        state.nudges.delete(workload.id);
        continue;
      }

      const lastNudgeAt = state.nudges.get(workload.id) ?? 0;
      if (now - lastNudgeAt < DEFAULT_RALPH_LOOP_NUDGE_COOLDOWN_MS) {
        continue;
      }

      const trackedAssignmentIssues = trackedAssignmentIdleReplyStalls.get(workload.id);
      deps.sendMaintenanceMessage(
        workload.id,
        trackedAssignmentIssues
          ? buildTrackedAssignmentReplyNudgeMessage(trackedAssignmentIssues, cycleStartedAt)
          : buildRalphLoopNudgeMessage(
              workload.pendingInboxCount,
              workload.ownedThreadCount,
              cycleStartedAt,
            ),
      );
      state.nudges.set(workload.id, now);
    }

    const ghostRewrite = rewriteRalphLoopGhostAnomalies(evaluation, state.reportedGhosts, {
      suppressedGhostIds: lastMaintenance?.reapedAgentIds ?? [],
    });
    state.reportedGhosts.clear();
    for (const ghostId of ghostRewrite.nextReportedGhostIds) {
      state.reportedGhosts.add(ghostId);
    }

    const visibleEvaluation = ghostRewrite.evaluation;
    const visibleSignature = buildRalphLoopAnomalySignature(visibleEvaluation);
    const nonGhostSignature = ghostRewrite.nonGhostAnomalies.join("|");
    const hasOutstandingAnomalies =
      visibleEvaluation.ghostAgentIds.length > 0 || visibleEvaluation.anomalies.length > 0;
    const ralphNotifications = buildRalphLoopCycleNotifications(visibleEvaluation, cycleStartedAt);
    const followUpPrompt =
      ghostRewrite.newGhostIds.length === 0 &&
      ghostRewrite.clearedGhostIds.length > 0 &&
      ghostRewrite.nonGhostAnomalies.length === 0
        ? null
        : ralphNotifications.followUpPrompt;

    const agentsById = new Map(
      workloads.map((workload) => [workload.id, { emoji: workload.emoji, name: workload.name }]),
    );
    let projectedAssignments: ResolvedTaskAssignment[] = [];
    let taskProgressChanged = false;
    const rawTrackedAssignments = db.listTaskAssignments();
    const trackedAssignmentSourceIds = [
      ...new Set(
        rawTrackedAssignments
          .map((assignment) => assignment.sourceMessageId)
          .filter((messageId): messageId is number => messageId != null),
      ),
    ];
    const trackedAssignments = normalizeTrackedTaskAssignments(
      rawTrackedAssignments,
      new Map(
        db
          .getMessagesByIds(trackedAssignmentSourceIds)
          .map((message) => [message.id, message.body]),
      ),
    );
    if (trackedAssignments.length === 0) {
      state.pendingTaskAssignmentReport = null;
      state.taskAssignmentReportSignature = "";
    } else {
      const resolvedAssignments = await resolveTaskAssignments(
        trackedAssignments as TaskAssignmentInfo[],
        process.cwd(),
      );
      const changedAssignments = resolvedAssignments.filter(hasTaskAssignmentStatusChange);
      taskProgressChanged = changedAssignments.length > 0;
      projectedAssignments = resolvedAssignments.map((assignment) => {
        if (hasTaskAssignmentStatusChange(assignment)) {
          db.updateTaskAssignmentProgress(
            assignment.id,
            assignment.nextStatus,
            assignment.nextPrNumber,
          );
        }
        return { ...assignment, status: assignment.nextStatus, prNumber: assignment.nextPrNumber };
      });

      if (changedAssignments.length > 0) {
        const openedCount = changedAssignments.filter((a) => a.nextStatus === "pr_open").length;
        const mergedCount = changedAssignments.filter((a) => a.nextStatus === "pr_merged").length;
        const closedCount = changedAssignments.filter((a) => a.nextStatus === "pr_closed").length;
        const tone: ActivityLogTone =
          closedCount > 0 ? "warning" : mergedCount > 0 || openedCount > 0 ? "success" : "info";
        const title =
          mergedCount > 0
            ? mergedCount === 1
              ? "Task merged"
              : "Tasks merged"
            : openedCount > 0
              ? openedCount === 1
                ? "Worker completion recorded"
                : "Worker completions recorded"
              : "Task progress updated";
        const summaryParts = [];
        if (openedCount > 0)
          summaryParts.push(
            `${openedCount} worker completion${openedCount === 1 ? "" : "s"} moved to PR open`,
          );
        if (mergedCount > 0)
          summaryParts.push(`${mergedCount} PR${mergedCount === 1 ? "" : "s"} merged`);
        if (closedCount > 0)
          summaryParts.push(`${closedCount} PR${closedCount === 1 ? "" : "s"} closed`);
        if (summaryParts.length === 0) {
          summaryParts.push(
            `${changedAssignments.length} tracked assignment${changedAssignments.length === 1 ? " changed" : "s changed"}`,
          );
        }
        deps.logActivity({
          kind: "task_progress",
          level: "actions",
          title,
          summary: summaryParts.join("; "),
          details: changedAssignments.map((a) => {
            const next = deps.summarizeTrackedAssignmentStatus(
              a.nextStatus,
              a.nextPrNumber,
              a.branch,
            );
            return `${deps.formatTrackedAgent(a.agentId)} — #${a.issueNumber}: ${next.summary}`;
          }),
          fields: [
            { label: "Updated", value: changedAssignments.length },
            { label: "Merged", value: mergedCount },
            { label: "PR open", value: openedCount },
            { label: "Cycle", value: cycleStartedAt },
          ],
          tone,
        });
      }

      state.pendingTaskAssignmentReport = getPendingTaskAssignmentReport(
        projectedAssignments,
        agentsById,
        state.taskAssignmentReportSignature,
        cycleStartedAt,
      );
    }

    const activeWorkingAgentIds = workloads
      .filter(
        (workload) =>
          workload.id !== selfId &&
          workload.status === "working" &&
          !visibleEvaluation.ghostAgentIds.includes(workload.id),
      )
      .map((workload) => workload.id);
    const activeTrackedAssignmentCount =
      projectedAssignments.filter(isActiveTrackedAssignment).length;
    const activeWorkCount = activeWorkingAgentIds.length + activeTrackedAssignmentCount;
    const snoozeSettings = deps.getSettings?.() ?? {};
    const snoozeStatusBefore = getRalphLoopSnoozeStatus(state, now);
    const emptyCycle =
      activeWorkCount === 0 &&
      !hasOutstandingAnomalies &&
      pendingBacklogCount === 0 &&
      (lastMaintenance?.assignedBacklogCount ?? 0) === 0 &&
      (lastMaintenance?.anomalies.length ?? 0) === 0 &&
      state.pendingTaskAssignmentReport == null &&
      !taskProgressChanged;
    const shouldWakeSnooze = snoozeStatusBefore.active && !emptyCycle;
    if (shouldWakeSnooze) {
      clearRalphLoopSnooze(state);
      deps.logActivity({
        kind: "ralph_event",
        level: "actions",
        title: "RALPH snooze ended",
        summary: "RALPH woke because work, anomalies, or task progress appeared.",
        fields: [
          { label: "Backlog", value: pendingBacklogCount },
          { label: "Anomalies", value: visibleEvaluation.anomalies.length },
          { label: "Active work", value: activeWorkCount },
          { label: "Cycle", value: cycleStartedAt },
        ],
        tone: "info",
      });
    }

    if (emptyCycle) {
      state.snoozeEmptyCycleCount += 1;
    } else {
      state.snoozeEmptyCycleCount = 0;
    }

    let snoozeStartedThisCycle = false;
    const autoSnoozeAfterEmptyCycles = resolveRalphSnoozeAfterEmptyCycles(snoozeSettings);
    if (
      emptyCycle &&
      !getRalphLoopSnoozeStatus(state, now).active &&
      autoSnoozeAfterEmptyCycles > 0 &&
      state.snoozeEmptyCycleCount >= autoSnoozeAfterEmptyCycles
    ) {
      setRalphLoopSnooze(state, {
        durationMs: resolveRalphSnoozeDurationMs(snoozeSettings),
        reason: `${state.snoozeEmptyCycleCount} empty RALPH cycles`,
        source: "auto",
        now,
      });
      snoozeStartedThisCycle = true;
    }
    const snoozeStatus = getRalphLoopSnoozeStatus(state, now);
    const quietEmptyCycle = snoozeStatus.active && emptyCycle;

    const shouldWarn =
      ghostRewrite.newGhostIds.length > 0 ||
      (nonGhostSignature.length > 0 && nonGhostSignature !== state.nonGhostSignature);
    const shouldInform =
      ghostRewrite.clearedGhostIds.length > 0 && visibleEvaluation.anomalies.length > 0;

    const shouldDeliverFollowUp =
      followUpPrompt != null &&
      shouldDeliverRalphLoopFollowUp({
        signature: visibleSignature,
        lastDeliveredSignature: state.followUpSignature,
        lastDeliveredAt: state.followUpAt,
        now,
        cooldownMs: DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS,
        pending: state.followUpPending,
        idle: ctx.isIdle?.() ?? true,
      }) &&
      (shouldWarn || shouldInform);
    if (shouldDeliverFollowUp && followUpPrompt) {
      deps.trySendFollowUp(followUpPrompt, () => {
        state.followUpPending = true;
        state.followUpAt = now;
        state.followUpSignature = visibleSignature;
      });
    }
    if (!hasOutstandingAnomalies) {
      state.followUpSignature = "";
    }
    if (state.pendingTaskAssignmentReport && (ctx.isIdle?.() ?? true)) {
      const reportToDeliver = state.pendingTaskAssignmentReport;
      deps.trySendFollowUp(reportToDeliver.message, () => {
        state.taskAssignmentReportSignature = reportToDeliver.signature;
        state.pendingTaskAssignmentReport = null;
      });
    }
    if (shouldWarn) {
      ctx.ui.notify(ralphNotifications.anomalyStatus ?? "RALPH loop anomaly detected", "warning");
    } else if (shouldInform) {
      ctx.ui.notify(ralphNotifications.anomalyStatus ?? "RALPH loop anomaly detected", "info");
    } else if (!hasOutstandingAnomalies && state.hadOutstandingAnomalies) {
      ctx.ui.notify(ralphNotifications.recoveryStatus, "info");
    }

    if (shouldWarn || shouldInform) {
      deps.logActivity({
        kind: "ralph_event",
        level: "actions",
        title: shouldWarn ? "RALPH anomaly detected" : "RALPH status updated",
        summary: ralphNotifications.anomalyStatus ?? "RALPH loop anomaly detected",
        details: visibleEvaluation.anomalies,
        fields: [
          { label: "Ghosts", value: visibleEvaluation.ghostAgentIds.length },
          { label: "Stuck", value: visibleEvaluation.stuckAgentIds.length },
          { label: "Nudged", value: visibleEvaluation.nudgeAgentIds.length },
          { label: "Backlog", value: pendingBacklogCount },
          { label: "Follow-up", value: shouldDeliverFollowUp },
        ],
        tone: shouldWarn ? "warning" : "info",
      });
    } else if (!hasOutstandingAnomalies && state.hadOutstandingAnomalies) {
      deps.logActivity({
        kind: "ralph_event",
        level: "actions",
        title: "RALPH recovered",
        summary: ralphNotifications.recoveryStatus,
        details: ["Previous ghost/stall/backlog anomalies cleared."],
        fields: [
          { label: "Backlog", value: pendingBacklogCount },
          { label: "Idle workers", value: visibleEvaluation.idleDrainAgentIds.length },
        ],
        tone: "success",
      });
    } else if (quietEmptyCycle) {
      if (snoozeStartedThisCycle) {
        deps.logActivity({
          kind: "ralph_event",
          level: "actions",
          title: "RALPH snoozed",
          summary: `RALPH will stay quiet until ${snoozeStatus.until ?? "the snooze expires"} after ${state.snoozeEmptyCycleCount} empty cycle${state.snoozeEmptyCycleCount === 1 ? "" : "s"}.`,
          fields: [
            { label: "Source", value: snoozeStatus.source ?? "unknown" },
            { label: "Reason", value: snoozeStatus.reason ?? "none" },
            { label: "Cycle", value: cycleStartedAt },
          ],
          tone: "info",
        });
      }
    } else {
      deps.logActivity({
        kind: "ralph_cycle",
        level: "verbose",
        title: "RALPH cycle",
        summary:
          visibleEvaluation.anomalies.length > 0
            ? `${visibleEvaluation.anomalies.length} anomaly entries observed this cycle.`
            : "Broker health steady this cycle.",
        details: visibleEvaluation.anomalies.length > 0 ? visibleEvaluation.anomalies : undefined,
        fields: [
          { label: "Ghosts", value: visibleEvaluation.ghostAgentIds.length },
          { label: "Stuck", value: visibleEvaluation.stuckAgentIds.length },
          { label: "Nudged", value: visibleEvaluation.nudgeAgentIds.length },
          { label: "Idle", value: visibleEvaluation.idleDrainAgentIds.length },
          { label: "Backlog", value: pendingBacklogCount },
        ],
        tone: visibleEvaluation.anomalies.length > 0 ? "warning" : "info",
      });
    }
    state.nonGhostSignature = nonGhostSignature;
    state.hadOutstandingAnomalies = hasOutstandingAnomalies;

    let recentRalphCycles: Array<{
      startedAt: string;
      completedAt: string | null;
      durationMs: number | null;
      ghostAgentIds: string[];
      stuckAgentIds: string[];
      anomalies: string[];
      followUpDelivered: boolean;
      agentCount: number;
      backlogCount: number;
    }> = [];
    try {
      const cycleCompletedAt = new Date().toISOString();
      db.recordRalphCycle({
        startedAt: cycleStartedAt,
        completedAt: cycleCompletedAt,
        durationMs: Date.now() - cycleStartMs,
        ghostAgentIds: visibleEvaluation.ghostAgentIds,
        nudgeAgentIds: visibleEvaluation.nudgeAgentIds,
        idleDrainAgentIds: visibleEvaluation.idleDrainAgentIds,
        stuckAgentIds: visibleEvaluation.stuckAgentIds,
        anomalies: visibleEvaluation.anomalies,
        anomalySignature: visibleSignature,
        followUpDelivered: shouldDeliverFollowUp,
        agentCount: workloads.filter((w) => !w.disconnectedAt).length,
        backlogCount: pendingBacklogCount,
      });
      recentRalphCycles = db.getRecentRalphCycles(5).map((cycle) => ({
        startedAt: cycle.startedAt,
        completedAt: cycle.completedAt,
        durationMs: cycle.durationMs,
        ghostAgentIds: cycle.ghostAgentIds,
        stuckAgentIds: cycle.stuckAgentIds,
        anomalies: cycle.anomalies,
        followUpDelivered: cycle.followUpDelivered,
        agentCount: cycle.agentCount,
        backlogCount: cycle.backlogCount,
      }));
    } catch {
      /* best effort */
    }

    const controlPlaneInput = {
      workloads,
      evaluation: visibleEvaluation,
      evaluationOptions,
      maintenance: lastMaintenance,
      assignments: projectedAssignments,
      lanes: db.listPinetLanes({ includeDone: true }),
      recentCycles: recentRalphCycles,
      cycleStartedAt,
      cycleDurationMs: Date.now() - cycleStartMs,
      currentBranch,
      homedir: os.homedir(),
      snooze: snoozeStatus,
    };
    const controlPlaneSnapshot = deps.buildControlPlaneDashboardSnapshot(controlPlaneInput);
    deps.setLastHomeTabSnapshot(controlPlaneSnapshot);

    try {
      await deps.refreshHomeTabs(ctx, controlPlaneSnapshot, cycleStartedAt);
    } catch (homeTabErr) {
      const homeTabMessage = `Pinet Home tab publish failed: ${errorMsg(homeTabErr)}`;
      if (homeTabMessage !== deps.getLastHomeTabError()) {
        ctx.ui.notify(homeTabMessage, "warning");
      }
      deps.setLastHomeTabError(homeTabMessage);
    }
  } catch (err) {
    ctx.ui.notify(buildRalphLoopStatusMessage(`failed: ${errorMsg(err)}`, cycleStartedAt), "error");
    deps.logActivity({
      kind: "ralph_error",
      level: "errors",
      title: "RALPH loop failed",
      summary: errorMsg(err),
      fields: [{ label: "Cycle", value: cycleStartedAt }],
      tone: "error",
    });
  } finally {
    state.running = false;
  }
}

// ─── Timer management ────────────────────────────────────

export function startRalphLoop(
  ctx: ExtensionContext,
  state: RalphLoopState,
  deps: RalphLoopDeps,
): void {
  stopRalphLoop(state);
  const intervalMs = resolveRalphLoopIntervalMs(deps.getSettings?.() ?? {});
  state.timer = setInterval(() => {
    void runRalphLoopCycle(ctx, state, deps);
  }, intervalMs);
  state.timer.unref?.();
  void runRalphLoopCycle(ctx, state, deps);
}

export function stopRalphLoop(state: RalphLoopState): void {
  resetRalphLoopState(state);
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
