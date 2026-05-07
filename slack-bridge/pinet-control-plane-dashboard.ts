import * as os from "node:os";
import { probeGitBranch } from "./git-metadata.js";
import {
  type RalphLoopAgentWorkload,
  type RalphLoopEvaluationOptions,
  DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
  filterAgentsForMeshVisibility,
  evaluateRalphLoopCycle,
} from "./helpers.js";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from "./broker/socket-server.js";
import { HEARTBEAT_INTERVAL_MS } from "./broker/client.js";
import type { BrokerMaintenanceResult } from "./broker/maintenance.js";
import type { RalphSnoozeStatus } from "./ralph-loop.js";
import type { PinetLaneInfo, TaskAssignmentInfo } from "./broker/types.js";
import {
  buildBrokerControlPlaneDashboardSnapshot,
  type BrokerControlPlaneDashboardSnapshot,
  type BrokerControlPlaneRecentCycle,
} from "./broker/control-plane-dashboard.js";
import {
  normalizeTrackedTaskAssignments,
  resolveTaskAssignments,
  type ResolvedTaskAssignment,
} from "./task-assignments.js";

export type PinetControlPlaneDashboardAgentRecord = Omit<
  RalphLoopAgentWorkload,
  "pendingInboxCount" | "ownedThreadCount"
>;

export interface PinetControlPlaneDashboardMessageRecord {
  id: number;
  body: string;
}

export interface PinetControlPlaneDashboardBrokerDbPort {
  getAllAgents: () => PinetControlPlaneDashboardAgentRecord[];
  getPendingInboxCount: (agentId: string) => number;
  getOwnedThreadCount: (agentId: string) => number;
  getBacklogCount: (status: "pending") => number;
  listTaskAssignments: () => TaskAssignmentInfo[];
  listPinetLanes: (options?: { includeDone?: boolean }) => PinetLaneInfo[];
  getMessagesByIds: (ids: number[]) => PinetControlPlaneDashboardMessageRecord[];
  getRecentRalphCycles: (limit: number) => BrokerControlPlaneRecentCycle[];
}

export interface PinetControlPlaneDashboardDeps {
  getActiveBrokerDb: () => PinetControlPlaneDashboardBrokerDbPort | null;
  getActiveBrokerSelfId: () => string | null;
  heartbeatTimerActive: () => boolean;
  maintenanceTimerActive: () => boolean;
  getLastMaintenance: () => BrokerMaintenanceResult | null;
  getRalphSnoozeStatus?: () => RalphSnoozeStatus | null;
}

export interface PinetControlPlaneDashboard {
  buildCurrentBrokerControlPlaneDashboardSnapshot: (
    cycleStartedAt?: string,
  ) => Promise<BrokerControlPlaneDashboardSnapshot | null>;
}

export function createPinetControlPlaneDashboard(
  deps: PinetControlPlaneDashboardDeps,
): PinetControlPlaneDashboard {
  async function buildCurrentBrokerControlPlaneDashboardSnapshot(
    cycleStartedAt: string = new Date().toISOString(),
  ): Promise<BrokerControlPlaneDashboardSnapshot | null> {
    const db = deps.getActiveBrokerDb();
    if (!db) {
      return null;
    }

    const currentBranch = (await probeGitBranch(process.cwd())) ?? null;
    const nowMs = Date.now();
    const recentGhostWindowMs = DEFAULT_HEARTBEAT_TIMEOUT_MS * 2;
    const workloads = filterAgentsForMeshVisibility(db.getAllAgents(), {
      now: nowMs,
      includeGhosts: true,
      recentDisconnectWindowMs: recentGhostWindowMs,
    }).map((agent) => ({
      ...agent,
      pendingInboxCount: db.getPendingInboxCount(agent.id),
      ownedThreadCount: db.getOwnedThreadCount(agent.id),
    }));
    const pendingBacklogCount = db.getBacklogCount("pending");
    const evaluationOptions: RalphLoopEvaluationOptions = {
      now: nowMs,
      heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
      pendingBacklogCount,
      currentBranch,
      brokerHeartbeatActive: deps.heartbeatTimerActive(),
      brokerMaintenanceActive: deps.maintenanceTimerActive(),
      brokerAgentId: deps.getActiveBrokerSelfId() ?? undefined,
    };
    const evaluation = evaluateRalphLoopCycle(workloads, evaluationOptions);

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
    let projectedAssignments: ResolvedTaskAssignment[] = [];
    if (trackedAssignments.length > 0) {
      const resolvedAssignments = await resolveTaskAssignments(trackedAssignments, process.cwd());
      projectedAssignments = resolvedAssignments.map((assignment) => ({
        ...assignment,
        status: assignment.nextStatus,
        prNumber: assignment.nextPrNumber,
      }));
    }

    const recentRalphCycles = db.getRecentRalphCycles(5).map((cycle) => ({
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

    return buildBrokerControlPlaneDashboardSnapshot({
      workloads,
      evaluation,
      evaluationOptions,
      maintenance: deps.getLastMaintenance(),
      assignments: projectedAssignments,
      lanes: db.listPinetLanes({ includeDone: true }),
      recentCycles: recentRalphCycles,
      cycleStartedAt,
      cycleDurationMs: 0,
      currentBranch,
      homedir: os.homedir(),
      snooze: deps.getRalphSnoozeStatus?.() ?? null,
    });
  }

  return {
    buildCurrentBrokerControlPlaneDashboardSnapshot,
  };
}
