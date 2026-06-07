import type { AgentInfo, BacklogEntry, PortLeaseInfo, ThreadInfo } from "./types.js";

export const DEFAULT_BROKER_MAINTENANCE_INTERVAL_MS = 5_000;
export const DEFAULT_BUSY_ASSIGNMENT_AGE_MS = 30_000;
export const OVERLOADED_INBOX_THRESHOLD = 10;

export interface ThreadRepairResult {
  releasedClaimCount: number;
  releasedAgentIds: string[];
}

export interface BacklogAssignmentRepairResult {
  resetToPendingCount: number;
  droppedCount: number;
}

export interface BrokerMaintenanceDB {
  pruneStaleAgents(staleAfterMs: number): string[];
  purgeDisconnectedAgents(graceMs?: number): string[];
  repairThreadOwnership(): ThreadRepairResult;
  repairOrphanedAssignedBacklog(): BacklogAssignmentRepairResult;
  requeueUndeliveredMessages(agentId: string, reason?: string): number;
  getPendingBacklog(limit?: number): BacklogEntry[];
  getBacklogCount(status?: BacklogEntry["status"]): number;
  getAgentById(agentId: string): AgentInfo | null;
  getAgents(): AgentInfo[];
  getPendingInboxCount(agentId: string): number;
  getThread(threadId: string): ThreadInfo | null;
  assignBacklogEntry(id: number, agentId: string): BacklogEntry | null;
  dropBacklogEntry(id: number, reason: string): BacklogEntry | null;
  expirePortLeases?: (nowIso?: string) => PortLeaseInfo[];
}

export interface BrokerMaintenanceOptions {
  brokerAgentId?: string;
  staleAfterMs: number;
  backlogLimit?: number;
  busyAssignmentAgeMs?: number;
  now?: number;
}

export interface BrokerMaintenanceResult {
  reapedAgentIds: string[];
  repairedThreadClaims: number;
  assignedBacklogCount: number;
  nudgedAgentIds: string[];
  pendingBacklogCount: number;
  anomalies: string[];
}

interface AgentLoad {
  agent: AgentInfo;
  pendingInboxCount: number;
}

export function selectBacklogAssignee(
  backlog: BacklogEntry,
  agentLoads: AgentLoad[],
  now = Date.now(),
  busyAssignmentAgeMs = DEFAULT_BUSY_ASSIGNMENT_AGE_MS,
): AgentInfo | null {
  if (agentLoads.length === 0) {
    return null;
  }

  const idle = agentLoads.filter((entry) => entry.agent.status === "idle").sort(compareAgentLoad);
  if (idle.length > 0) {
    return idle[0].agent;
  }

  const backlogAgeMs = now - Date.parse(backlog.createdAt);
  if (backlogAgeMs < busyAssignmentAgeMs) {
    return null;
  }

  const working = [...agentLoads].sort(compareAgentLoad);
  return working[0]?.agent ?? null;
}

export function runBrokerMaintenancePass(
  db: BrokerMaintenanceDB,
  options: BrokerMaintenanceOptions,
): BrokerMaintenanceResult {
  const now = options.now ?? Date.now();
  const busyAssignmentAgeMs = options.busyAssignmentAgeMs ?? DEFAULT_BUSY_ASSIGNMENT_AGE_MS;
  const reapedAgentIds = db.pruneStaleAgents(options.staleAfterMs);
  const expiredPortLeases = db.expirePortLeases?.(new Date(now).toISOString()) ?? [];
  db.purgeDisconnectedAgents();
  const repaired = db.repairThreadOwnership();
  for (const agentId of repaired.releasedAgentIds) {
    db.requeueUndeliveredMessages(agentId, "agent_disconnected");
  }
  const repairedAssignments = db.repairOrphanedAssignedBacklog();
  const repairedThreadClaims = repaired.releasedClaimCount;
  const brokerAgentId = options.brokerAgentId;

  const agents = db
    .getAgents()
    .filter((agent) => agent.id !== brokerAgentId)
    .filter((agent) => agent.metadata?.role !== "broker")
    .filter(
      (agent) =>
        !agent.parentAgentId &&
        agent.supervisionState !== "supervised" &&
        agent.supervisionState !== "orphaned" &&
        agent.supervisionState !== "stopping",
    );

  const agentLoads = agents.map((agent) => ({
    agent,
    pendingInboxCount: db.getPendingInboxCount(agent.id),
  }));

  const nudgedAgentIds = new Set<string>();
  let assignedBacklogCount = 0;
  let reboundBrokerBacklogCount = 0;
  const resetAssignedBacklogCount = repairedAssignments.resetToPendingCount;
  let droppedBacklogCount = repairedAssignments.droppedCount;

  for (const backlog of db.getPendingBacklog(options.backlogLimit ?? 50)) {
    if (brokerAgentId && backlog.preferredAgentId === brokerAgentId) {
      const assigned = db.assignBacklogEntry(backlog.id, brokerAgentId);
      if (!assigned) {
        continue;
      }

      assignedBacklogCount += 1;
      reboundBrokerBacklogCount += 1;
      continue;
    }

    const preferredAgent = backlog.preferredAgentId
      ? (db.getAgents().find((agent) => agent.id === backlog.preferredAgentId) ?? null)
      : null;
    if (backlog.preferredAgentId && !preferredAgent) {
      const knownPreferredAgent = db.getAgentById(backlog.preferredAgentId);
      if (!knownPreferredAgent) {
        const dropped = db.dropBacklogEntry(backlog.id, "preferred_agent_missing");
        if (dropped) {
          droppedBacklogCount += 1;
        }
      }
      continue;
    }

    const threadOwner = db.getThread(backlog.threadId)?.ownerAgent ?? null;
    const ownerAgent = threadOwner ? agents.find((agent) => agent.id === threadOwner) : null;
    const assignee =
      preferredAgent ??
      ownerAgent ??
      selectBacklogAssignee(backlog, agentLoads, now, busyAssignmentAgeMs);

    if (!assignee) {
      continue;
    }

    const assigned = db.assignBacklogEntry(backlog.id, assignee.id);
    if (!assigned) {
      continue;
    }

    assignedBacklogCount += 1;
    nudgedAgentIds.add(assignee.id);

    const load = agentLoads.find((entry) => entry.agent.id === assignee.id);
    if (load) {
      load.pendingInboxCount += 1;
    }
  }

  const pendingBacklogCount = db.getBacklogCount("pending");
  const anomalies: string[] = [];

  if (reapedAgentIds.length > 0) {
    anomalies.push(
      `reaped ${reapedAgentIds.length} stale agent${reapedAgentIds.length === 1 ? "" : "s"}`,
    );
  }
  if (expiredPortLeases.length > 0) {
    anomalies.push(
      `expired ${expiredPortLeases.length} port lease${expiredPortLeases.length === 1 ? "" : "s"}`,
    );
  }
  if (repairedThreadClaims > 0) {
    anomalies.push(
      `released ${repairedThreadClaims} orphaned thread claim${repairedThreadClaims === 1 ? "" : "s"}`,
    );
  }
  if (reboundBrokerBacklogCount > 0) {
    anomalies.push(
      `rebound ${reboundBrokerBacklogCount} broker-targeted backlog item${reboundBrokerBacklogCount === 1 ? "" : "s"} to the live broker`,
    );
  }
  if (resetAssignedBacklogCount > 0) {
    anomalies.push(
      `reset ${resetAssignedBacklogCount} orphaned backlog assignment${resetAssignedBacklogCount === 1 ? "" : "s"} to pending`,
    );
  }
  if (droppedBacklogCount > 0) {
    anomalies.push(
      `dropped ${droppedBacklogCount} undeliverable targeted backlog entr${droppedBacklogCount === 1 ? "y" : "ies"}`,
    );
  }
  if (pendingBacklogCount > 0 && agentLoads.length === 0) {
    anomalies.push("pending unrouted backlog has no live workers");
  } else if (
    pendingBacklogCount > 0 &&
    !agentLoads.some((entry) => entry.agent.status === "idle")
  ) {
    anomalies.push("pending unrouted backlog is waiting for an idle worker");
  }

  const overloadedAgents = agentLoads
    .filter((entry) => entry.pendingInboxCount >= OVERLOADED_INBOX_THRESHOLD)
    .map((entry) => entry.agent.name);
  if (overloadedAgents.length > 0) {
    anomalies.push(`overloaded workers: ${overloadedAgents.join(", ")}`);
  }

  return {
    reapedAgentIds,
    repairedThreadClaims,
    assignedBacklogCount,
    nudgedAgentIds: [...nudgedAgentIds],
    pendingBacklogCount,
    anomalies,
  };
}

function compareAgentLoad(left: AgentLoad, right: AgentLoad): number {
  if (left.pendingInboxCount !== right.pendingInboxCount) {
    return left.pendingInboxCount - right.pendingInboxCount;
  }

  return Date.parse(left.agent.lastSeen) - Date.parse(right.agent.lastSeen);
}
