import type {
  AgentDisplayInfo,
  RalphLoopAgentWorkload,
  RalphLoopEvaluationOptions,
  RalphLoopEvaluationResult,
} from "../helpers.js";
import { buildAgentDisplayInfo, shortenPath } from "../helpers.js";
import type { ResolvedTaskAssignment } from "../task-assignments.js";
import type { BrokerMaintenanceResult } from "./maintenance.js";
import type { PinetLaneInfo } from "./types.js";

export type BrokerControlPlaneRecentCycle = {
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  ghostAgentIds: string[];
  stuckAgentIds: string[];
  anomalies: string[];
  followUpDelivered: boolean;
  agentCount: number;
  backlogCount: number;
};

export interface BrokerControlPlaneAgentRow {
  id: string;
  role: string;
  label: string;
  status: string;
  health: string;
  workload: string;
  taskSummary: string;
  heartbeat: string;
  branch: string;
  worktree: string;
}

export interface BrokerControlPlaneDashboardSnapshot {
  cycleStartedAt: string;
  cycleDurationMs: number;
  currentBranch: string | null;
  ralphSnooze?: {
    active: boolean;
    until: string | null;
    reason: string | null;
    source: string | null;
    emptyCycleCount: number;
  } | null;
  totalAgents: number;
  liveAgents: number;
  brokerCount: number;
  workerCount: number;
  idleWorkers: number;
  workingWorkers: number;
  ghostAgents: number;
  stuckAgents: number;
  pendingBacklogCount: number;
  nudgesThisCycle: number;
  idleDrainCandidates: number;
  assignedBacklogCount: number;
  reapedAgents: number;
  repairedThreadClaims: number;
  maintenanceAnomalies: string[];
  anomalies: string[];
  taskCounts: {
    assigned: number;
    branchPushed: number;
    openPrs: number;
    mergedPrs: number;
    closedPrs: number;
  };
  activeTasks: string[];
  recentOutcomes: string[];
  activeLanes: string[];
  detachedLanes: string[];
  roster: BrokerControlPlaneAgentRow[];
  recentCycles: Array<{
    startedAt: string;
    duration: string;
    agentCount: number;
    backlogCount: number;
    ghostCount: number;
    stuckCount: number;
    anomalySummary: string;
    followUpDelivered: boolean;
  }>;
}

export interface BuildBrokerControlPlaneDashboardSnapshotInput {
  workloads: RalphLoopAgentWorkload[];
  evaluation: RalphLoopEvaluationResult;
  evaluationOptions?: RalphLoopEvaluationOptions;
  maintenance: BrokerMaintenanceResult | null;
  assignments: Array<
    Pick<
      ResolvedTaskAssignment,
      "agentId" | "issueNumber" | "branch" | "status" | "prNumber" | "updatedAt" | "issueState"
    >
  >;
  lanes?: PinetLaneInfo[];
  recentCycles: BrokerControlPlaneRecentCycle[];
  cycleStartedAt: string;
  cycleDurationMs: number;
  currentBranch: string | null;
  homedir?: string;
  snooze?: {
    active: boolean;
    until: string | null;
    reason: string | null;
    source: string | null;
    emptyCycleCount: number;
  } | null;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "n/a";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = seconds / 60;
  return `${minutes.toFixed(minutes < 10 ? 1 : 0)}m`;
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }

  return new Date(parsed)
    .toISOString()
    .replace("T", " ")
    .replace(".000", "")
    .replace(/:\d\dZ$/, "Z");
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function getAgentRole(agent: Pick<AgentDisplayInfo, "metadata">): string {
  const capabilitiesRole = agent.metadata?.capabilities?.role;
  const metadataRole = agent.metadata?.role;
  return capabilitiesRole ?? metadataRole ?? "worker";
}

function buildWorkloadSummary(
  workload: Pick<RalphLoopAgentWorkload, "pendingInboxCount" | "ownedThreadCount">,
): string {
  const parts = [
    `${workload.pendingInboxCount} inbox`,
    `${workload.ownedThreadCount} thread${workload.ownedThreadCount === 1 ? "" : "s"}`,
  ];
  return parts.join(" / ");
}

function formatTaskStatusShort(
  assignment: Pick<ResolvedTaskAssignment, "issueNumber" | "status" | "prNumber" | "branch">,
): string {
  switch (assignment.status) {
    case "pr_open":
      return `#${assignment.issueNumber} PR #${assignment.prNumber ?? "?"} open`;
    case "pr_merged":
      return `#${assignment.issueNumber} PR #${assignment.prNumber ?? "?"} merged`;
    case "pr_closed":
      return `#${assignment.issueNumber} PR #${assignment.prNumber ?? "?"} closed`;
    case "branch_pushed":
      return `#${assignment.issueNumber} pushed ${assignment.branch ?? "branch"}`;
    case "assigned":
    default:
      return `#${assignment.issueNumber} assigned`;
  }
}

function formatLaneStatusShort(lane: PinetLaneInfo): string {
  const refs = [
    lane.issueNumber != null ? `#${lane.issueNumber}` : null,
    lane.prNumber != null ? `PR #${lane.prNumber}` : null,
    lane.pmMode ? "PM" : null,
  ].filter((ref): ref is string => Boolean(ref));
  const owner = lane.ownerAgentId ? ` owner ${lane.ownerAgentId}` : "";
  const lead = lane.implementationLeadAgentId ? ` lead ${lane.implementationLeadAgentId}` : "";
  return `${lane.laneId} [${lane.state}]${refs.length > 0 ? ` (${refs.join(" · ")})` : ""}${owner}${lead}${lane.summary ? ` — ${lane.summary}` : ""}`;
}

function summarizeAgentTasks(
  assignments: Array<
    Pick<ResolvedTaskAssignment, "issueNumber" | "status" | "prNumber" | "branch">
  >,
): string {
  if (assignments.length === 0) return "—";

  const ordered = [...assignments].sort((left, right) => left.issueNumber - right.issueNumber);
  const visible = ordered.slice(0, 2).map(formatTaskStatusShort);
  if (ordered.length > 2) {
    visible.push(`+${ordered.length - 2} more`);
  }
  return visible.join("; ");
}

function summarizeCycleAnomalies(anomalies: string[]): string {
  if (anomalies.length === 0) return "healthy";
  return truncateText(anomalies.join("; "), 72);
}

export function buildBrokerControlPlaneDashboardSnapshot(
  input: BuildBrokerControlPlaneDashboardSnapshotInput,
): BrokerControlPlaneDashboardSnapshot {
  const homedir = input.homedir ?? process.env.HOME ?? "";
  const visibleAssignments = input.assignments.filter(
    (assignment) => assignment.issueState !== "CLOSED",
  );
  const assignmentsByAgent = new Map<
    string,
    Array<Pick<ResolvedTaskAssignment, "issueNumber" | "status" | "prNumber" | "branch">>
  >();

  for (const assignment of visibleAssignments) {
    const bucket = assignmentsByAgent.get(assignment.agentId);
    const summaryAssignment = {
      issueNumber: assignment.issueNumber,
      status: assignment.status,
      prNumber: assignment.prNumber,
      branch: assignment.branch,
    };
    if (bucket) {
      bucket.push(summaryAssignment);
    } else {
      assignmentsByAgent.set(assignment.agentId, [summaryAssignment]);
    }
  }

  const displays = input.workloads
    .map((workload) => ({
      workload,
      display: buildAgentDisplayInfo(workload, input.evaluationOptions ?? {}),
    }))
    .sort((left, right) => {
      const leftRole = getAgentRole(left.display);
      const rightRole = getAgentRole(right.display);
      if (leftRole !== rightRole) {
        return leftRole === "broker" ? -1 : 1;
      }
      return left.display.name.localeCompare(right.display.name);
    });

  const brokerCount = displays.filter(({ display }) => getAgentRole(display) === "broker").length;
  const workerDisplays = displays.filter(({ display }) => getAgentRole(display) !== "broker");
  const liveAgents = displays.filter(({ workload }) => !workload.disconnectedAt).length;

  const roster = displays.map(({ workload, display }) => {
    const worktree =
      display.metadata?.worktreeKind === "linked" && display.metadata.worktreePath
        ? shortenPath(display.metadata.worktreePath, homedir)
        : display.metadata?.worktreeKind === "main"
          ? "main checkout"
          : "—";
    const branch = display.metadata?.branch ?? "—";
    const heartbeat = display.heartbeatSummary ?? display.leaseSummary ?? "unknown";
    const health = display.stuck
      ? `${display.health ?? "unknown"} / stuck`
      : (display.health ?? "unknown");
    return {
      id: display.id,
      role: getAgentRole(display),
      label: `${display.emoji} ${display.name}`,
      status: display.status,
      health,
      workload: buildWorkloadSummary(workload),
      taskSummary: summarizeAgentTasks(assignmentsByAgent.get(display.id) ?? []),
      heartbeat,
      branch,
      worktree,
    };
  });

  const sortedAssignments = [...visibleAssignments].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  const sortedLanes = [...(input.lanes ?? [])].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  const activeTasks = sortedAssignments
    .filter(
      (assignment) =>
        assignment.status === "assigned" ||
        assignment.status === "branch_pushed" ||
        assignment.status === "pr_open",
    )
    .map((assignment) => formatTaskStatusShort(assignment))
    .slice(0, 8);
  const recentOutcomes = sortedAssignments
    .filter((assignment) => assignment.status === "pr_merged" || assignment.status === "pr_closed")
    .map((assignment) => formatTaskStatusShort(assignment))
    .slice(0, 8);

  return {
    cycleStartedAt: input.cycleStartedAt,
    cycleDurationMs: input.cycleDurationMs,
    currentBranch: input.currentBranch,
    ralphSnooze: input.snooze
      ? {
          active: input.snooze.active,
          until: input.snooze.until,
          reason: input.snooze.reason,
          source: input.snooze.source,
          emptyCycleCount: input.snooze.emptyCycleCount,
        }
      : null,
    totalAgents: displays.length,
    liveAgents,
    brokerCount,
    workerCount: workerDisplays.length,
    idleWorkers: workerDisplays.filter(({ display }) => display.status === "idle").length,
    workingWorkers: workerDisplays.filter(({ display }) => display.status === "working").length,
    ghostAgents: input.evaluation.ghostAgentIds.length,
    stuckAgents: input.evaluation.stuckAgentIds.length,
    pendingBacklogCount: input.maintenance?.pendingBacklogCount ?? 0,
    nudgesThisCycle: input.evaluation.nudgeAgentIds.length,
    idleDrainCandidates: input.evaluation.idleDrainAgentIds.length,
    assignedBacklogCount: input.maintenance?.assignedBacklogCount ?? 0,
    reapedAgents: input.maintenance?.reapedAgentIds.length ?? 0,
    repairedThreadClaims: input.maintenance?.repairedThreadClaims ?? 0,
    maintenanceAnomalies: input.maintenance?.anomalies ?? [],
    anomalies: input.evaluation.anomalies,
    taskCounts: {
      assigned: visibleAssignments.filter((assignment) => assignment.status === "assigned").length,
      branchPushed: visibleAssignments.filter((assignment) => assignment.status === "branch_pushed")
        .length,
      openPrs: visibleAssignments.filter((assignment) => assignment.status === "pr_open").length,
      mergedPrs: visibleAssignments.filter((assignment) => assignment.status === "pr_merged")
        .length,
      closedPrs: visibleAssignments.filter((assignment) => assignment.status === "pr_closed")
        .length,
    },
    activeTasks,
    recentOutcomes,
    activeLanes: sortedLanes
      .filter(
        (lane) => lane.state !== "done" && lane.state !== "cancelled" && lane.state !== "detached",
      )
      .map(formatLaneStatusShort)
      .slice(0, 8),
    detachedLanes: sortedLanes
      .filter((lane) => lane.state === "detached")
      .map(formatLaneStatusShort)
      .slice(0, 8),
    roster,
    recentCycles: input.recentCycles.slice(0, 5).map((cycle) => ({
      startedAt: formatTimestamp(cycle.startedAt),
      duration: formatDuration(cycle.durationMs),
      agentCount: cycle.agentCount,
      backlogCount: cycle.backlogCount,
      ghostCount: cycle.ghostAgentIds.length,
      stuckCount: cycle.stuckAgentIds.length,
      anomalySummary: summarizeCycleAnomalies(cycle.anomalies),
      followUpDelivered: cycle.followUpDelivered,
    })),
  };
}
