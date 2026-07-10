/**
 * Read-only mesh snapshot for pinet-sonar.
 *
 * Opens the Pinet broker SQLite database in read-only mode and produces a
 * typed picture of the mesh: pod (agents), lanes, threads, traffic, and the
 * duty roster (assignments, wakeups, port leases, backlog). Never writes.
 */

import { DatabaseSync } from "node:sqlite";
import * as os from "node:os";
import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────

export type AgentLiveness = "live" | "recent" | "stale";

export interface SonarAgent {
  id: string;
  name: string;
  emoji: string;
  status: "working" | "idle";
  supervisionState: string;
  treeDepth: number;
  parentAgentId: string | null;
  laneId: string | null;
  connectedAt: string;
  lastHeartbeat: string | null;
  heartbeatAgeMs: number | null;
  liveness: AgentLiveness;
  disconnected: boolean;
  ownedThreadCount: number;
}

export interface SonarLaneStateCount {
  state: string;
  count: number;
}

export interface SonarLane {
  laneId: string;
  name: string | null;
  task: string | null;
  state: string;
  issueNumber: number | null;
  prNumber: number | null;
  ownerAgentId: string | null;
  participantCount: number;
  lastActivityAt: string;
}

export interface SonarTrafficBucket {
  /** ISO timestamp for the start of the hour bucket (UTC). */
  hourStartIso: string;
  inbound: number;
  outbound: number;
}

export interface SonarTrafficTotal {
  source: string;
  direction: string;
  count: number;
}

export interface SonarThread {
  threadId: string;
  source: string;
  channel: string;
  ownerAgent: string | null;
  updatedAt: string;
}

export interface SonarBusyThread {
  threadId: string;
  source: string;
  count: number;
}

export interface SonarTaskAssignment {
  agentId: string;
  issueNumber: number;
  status: string;
  repoKey: string;
  taskKind: string;
  updatedAt: string;
}

export interface SonarWakeup {
  agentId: string;
  threadId: string;
  fireAt: string;
  body: string;
}

export interface SonarPortLease {
  purpose: string;
  port: number;
  host: string;
  ownerAgentId: string | null;
  expiresAt: string;
}

export interface MeshSnapshot {
  generatedAt: string;
  dbPath: string;
  schemaVersion: number;
  totals: {
    agents: number;
    threads: number;
    messages: number;
    lanes: number;
  };
  agents: SonarAgent[];
  laneStateCounts: SonarLaneStateCount[];
  openLanes: SonarLane[];
  trafficTotals: SonarTrafficTotal[];
  trafficLast24h: SonarTrafficBucket[];
  busiestThreads24h: SonarBusyThread[];
  recentThreads: SonarThread[];
  backlogPending: number;
  openTaskAssignments: SonarTaskAssignment[];
  upcomingWakeups: SonarWakeup[];
  activePortLeases: SonarPortLease[];
}

// ─── Pure helpers ────────────────────────────────────────

export const LIVE_HEARTBEAT_MAX_MS = 2 * 60_000;
export const RECENT_HEARTBEAT_MAX_MS = 15 * 60_000;

export function classifyLiveness(heartbeatAgeMs: number | null): AgentLiveness {
  if (heartbeatAgeMs === null) return "stale";
  if (heartbeatAgeMs <= LIVE_HEARTBEAT_MAX_MS) return "live";
  if (heartbeatAgeMs <= RECENT_HEARTBEAT_MAX_MS) return "recent";
  return "stale";
}

export function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export interface TrafficRowInput {
  createdAt: string;
  direction: string;
}

/**
 * Bucket message rows into hourly inbound/outbound counts covering the last
 * `hours` hours ending at `nowMs`. Buckets are aligned to the top of the hour
 * so the final bucket is the in-progress hour.
 */
export function bucketHourlyTraffic(
  rows: TrafficRowInput[],
  nowMs: number,
  hours = 24,
): SonarTrafficBucket[] {
  const hourMs = 60 * 60_000;
  const lastHourStart = Math.floor(nowMs / hourMs) * hourMs;
  const firstHourStart = lastHourStart - (hours - 1) * hourMs;

  const buckets: SonarTrafficBucket[] = [];
  for (let i = 0; i < hours; i += 1) {
    buckets.push({
      hourStartIso: new Date(firstHourStart + i * hourMs).toISOString(),
      inbound: 0,
      outbound: 0,
    });
  }

  for (const row of rows) {
    const ts = parseIsoMs(row.createdAt);
    if (ts === null || ts < firstHourStart || ts >= lastHourStart + hourMs) continue;
    const index = Math.floor((ts - firstHourStart) / hourMs);
    const bucket = buckets[index];
    if (!bucket) continue;
    if (row.direction === "inbound") {
      bucket.inbound += 1;
    } else {
      bucket.outbound += 1;
    }
  }

  return buckets;
}

export function getDefaultBrokerDbPath(): string {
  // Mirrors @pinet/broker-core paths.ts; duplicated so the sonar has zero
  // runtime dependencies and can sweep any broker database it is pointed at.
  return path.join(os.homedir(), ".pi", "pinet-broker.db");
}

// ─── Row DTOs (raw SQLite rows, parsed at the boundary) ──

type AgentSweepRow = {
  id: string;
  name: string;
  emoji: string;
  status: string;
  supervision_state: string | null;
  tree_depth: number | null;
  parent_agent_id: string | null;
  lane_id: string | null;
  connected_at: string;
  last_heartbeat: string | null;
  disconnected_at: string | null;
};

type ThreadOwnerCountRow = {
  owner_agent: string;
  owned: number;
};

type LaneStateCountRow = {
  state: string;
  count: number;
};

type LaneSweepRow = {
  lane_id: string;
  name: string | null;
  task: string | null;
  state: string;
  issue_number: number | null;
  pr_number: number | null;
  owner_agent_id: string | null;
  participant_count: number;
  last_activity_at: string;
};

type TrafficTotalRow = {
  source: string;
  direction: string;
  count: number;
};

type TrafficMessageRow = {
  created_at: string;
  direction: string;
};

type BusyThreadRow = {
  thread_id: string;
  source: string;
  count: number;
};

type RecentThreadRow = {
  thread_id: string;
  source: string;
  channel: string;
  owner_agent: string | null;
  updated_at: string;
};

type TaskAssignmentSweepRow = {
  agent_id: string;
  issue_number: number;
  status: string;
  repo_key: string;
  task_kind: string;
  updated_at: string;
};

type WakeupSweepRow = {
  agent_id: string;
  thread_id: string;
  fire_at: string;
  body: string;
};

type PortLeaseSweepRow = {
  purpose: string;
  port: number;
  host: string;
  owner_agent_id: string | null;
  expires_at: string;
};

type CountRow = {
  count: number;
};

// ─── Sweep ───────────────────────────────────────────────

const OPEN_LANE_STATES = ["planned", "active", "blocked", "review", "ready"] as const;

export interface ReadMeshSnapshotOptions {
  dbPath?: string;
  now?: Date;
  openLaneLimit?: number;
  recentThreadLimit?: number;
  busyThreadLimit?: number;
}

export function readMeshSnapshot(options: ReadMeshSnapshotOptions = {}): MeshSnapshot {
  const dbPath = options.dbPath ?? getDefaultBrokerDbPath();
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const openLaneLimit = options.openLaneLimit ?? 20;
  const recentThreadLimit = options.recentThreadLimit ?? 10;
  const busyThreadLimit = options.busyThreadLimit ?? 8;

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tableNames = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    const hasTable = (name: string): boolean => tableNames.has(name);

    const schemaVersionRow = db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    const schemaVersion = Number(schemaVersionRow?.user_version ?? 0);

    const countTable = (table: string): number => {
      if (!hasTable(table)) return 0;
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
        | CountRow
        | undefined;
      return row?.count ?? 0;
    };

    // Pod
    const ownedThreadCounts = new Map<string, number>();
    if (hasTable("threads")) {
      const ownerRows = db
        .prepare(
          `SELECT owner_agent, COUNT(*) AS owned
           FROM threads
           WHERE owner_agent IS NOT NULL
           GROUP BY owner_agent`,
        )
        .all() as ThreadOwnerCountRow[];
      for (const row of ownerRows) {
        ownedThreadCounts.set(row.owner_agent, row.owned);
      }
    }

    const agents: SonarAgent[] = [];
    if (hasTable("agents")) {
      const agentRows = db
        .prepare(
          `SELECT id, name, emoji, status, supervision_state, tree_depth,
                  parent_agent_id, lane_id, connected_at, last_heartbeat, disconnected_at
           FROM agents
           ORDER BY connected_at DESC`,
        )
        .all() as AgentSweepRow[];
      for (const row of agentRows) {
        const heartbeatMs = parseIsoMs(row.last_heartbeat);
        const heartbeatAgeMs = heartbeatMs === null ? null : Math.max(0, nowMs - heartbeatMs);
        agents.push({
          id: row.id,
          name: row.name,
          emoji: row.emoji,
          status: row.status === "working" ? "working" : "idle",
          supervisionState: row.supervision_state ?? "root",
          treeDepth: row.tree_depth ?? 0,
          parentAgentId: row.parent_agent_id,
          laneId: row.lane_id,
          connectedAt: row.connected_at,
          lastHeartbeat: row.last_heartbeat,
          heartbeatAgeMs,
          liveness: classifyLiveness(heartbeatAgeMs),
          disconnected: row.disconnected_at !== null,
          ownedThreadCount: ownedThreadCounts.get(row.id) ?? 0,
        });
      }
    }

    // Lanes
    const laneStateCounts: SonarLaneStateCount[] = hasTable("pinet_lanes")
      ? (
          db
            .prepare(
              `SELECT state, COUNT(*) AS count FROM pinet_lanes GROUP BY state ORDER BY count DESC`,
            )
            .all() as LaneStateCountRow[]
        ).map((row) => ({ state: row.state, count: row.count }))
      : [];

    const openLanes: SonarLane[] = hasTable("pinet_lanes")
      ? (
          db
            .prepare(
              `SELECT l.lane_id, l.name, l.task, l.state, l.issue_number, l.pr_number,
                      l.owner_agent_id, l.last_activity_at,
                      (SELECT COUNT(*) FROM pinet_lane_participants p WHERE p.lane_id = l.lane_id)
                        AS participant_count
               FROM pinet_lanes l
               WHERE l.state IN (${OPEN_LANE_STATES.map(() => "?").join(", ")})
               ORDER BY l.last_activity_at DESC
               LIMIT ?`,
            )
            .all(...OPEN_LANE_STATES, openLaneLimit) as LaneSweepRow[]
        ).map((row) => ({
          laneId: row.lane_id,
          name: row.name,
          task: row.task,
          state: row.state,
          issueNumber: row.issue_number,
          prNumber: row.pr_number,
          ownerAgentId: row.owner_agent_id,
          participantCount: row.participant_count,
          lastActivityAt: row.last_activity_at,
        }))
      : [];

    // Traffic
    const trafficTotals: SonarTrafficTotal[] = hasTable("messages")
      ? (
          db
            .prepare(
              `SELECT source, direction, COUNT(*) AS count
               FROM messages
               GROUP BY source, direction
               ORDER BY count DESC`,
            )
            .all() as TrafficTotalRow[]
        ).map((row) => ({ source: row.source, direction: row.direction, count: row.count }))
      : [];

    const trafficCutoffIso = new Date(nowMs - 24 * 60 * 60_000).toISOString();
    const trafficLast24h = hasTable("messages")
      ? bucketHourlyTraffic(
          (
            db
              .prepare(`SELECT created_at, direction FROM messages WHERE created_at >= ?`)
              .all(trafficCutoffIso) as TrafficMessageRow[]
          ).map((row) => ({ createdAt: row.created_at, direction: row.direction })),
          nowMs,
        )
      : bucketHourlyTraffic([], nowMs);

    const busiestThreads24h: SonarBusyThread[] = hasTable("messages")
      ? (
          db
            .prepare(
              `SELECT thread_id, source, COUNT(*) AS count
               FROM messages
               WHERE created_at >= ?
               GROUP BY thread_id
               ORDER BY count DESC
               LIMIT ?`,
            )
            .all(trafficCutoffIso, busyThreadLimit) as BusyThreadRow[]
        ).map((row) => ({ threadId: row.thread_id, source: row.source, count: row.count }))
      : [];

    // Threads
    const recentThreads: SonarThread[] = hasTable("threads")
      ? (
          db
            .prepare(
              `SELECT thread_id, source, channel, owner_agent, updated_at
               FROM threads
               ORDER BY updated_at DESC
               LIMIT ?`,
            )
            .all(recentThreadLimit) as RecentThreadRow[]
        ).map((row) => ({
          threadId: row.thread_id,
          source: row.source,
          channel: row.channel,
          ownerAgent: row.owner_agent,
          updatedAt: row.updated_at,
        }))
      : [];

    // Duty roster
    const backlogPending = hasTable("unrouted_backlog")
      ? ((
          db
            .prepare(`SELECT COUNT(*) AS count FROM unrouted_backlog WHERE status = 'pending'`)
            .get() as CountRow | undefined
        )?.count ?? 0)
      : 0;

    const openTaskAssignments: SonarTaskAssignment[] = hasTable("task_assignments")
      ? (
          db
            .prepare(
              `SELECT agent_id, issue_number, status, repo_key, task_kind, updated_at
               FROM task_assignments
               WHERE status NOT IN ('pr_merged', 'pr_closed')
               ORDER BY updated_at DESC
               LIMIT 20`,
            )
            .all() as TaskAssignmentSweepRow[]
        ).map((row) => ({
          agentId: row.agent_id,
          issueNumber: row.issue_number,
          status: row.status,
          repoKey: row.repo_key,
          taskKind: row.task_kind,
          updatedAt: row.updated_at,
        }))
      : [];

    const upcomingWakeups: SonarWakeup[] = hasTable("scheduled_wakeups")
      ? (
          db
            .prepare(
              `SELECT agent_id, thread_id, fire_at, body
               FROM scheduled_wakeups
               ORDER BY fire_at ASC
               LIMIT 10`,
            )
            .all() as WakeupSweepRow[]
        ).map((row) => ({
          agentId: row.agent_id,
          threadId: row.thread_id,
          fireAt: row.fire_at,
          body: row.body,
        }))
      : [];

    const activePortLeases: SonarPortLease[] = hasTable("port_leases")
      ? (
          db
            .prepare(
              `SELECT purpose, port, host, owner_agent_id, expires_at
               FROM port_leases
               WHERE status = 'active'
               ORDER BY expires_at ASC
               LIMIT 20`,
            )
            .all() as PortLeaseSweepRow[]
        ).map((row) => ({
          purpose: row.purpose,
          port: row.port,
          host: row.host,
          ownerAgentId: row.owner_agent_id,
          expiresAt: row.expires_at,
        }))
      : [];

    return {
      generatedAt: now.toISOString(),
      dbPath,
      schemaVersion,
      totals: {
        agents: countTable("agents"),
        threads: countTable("threads"),
        messages: countTable("messages"),
        lanes: countTable("pinet_lanes"),
      },
      agents,
      laneStateCounts,
      openLanes,
      trafficTotals,
      trafficLast24h,
      busiestThreads24h,
      recentThreads,
      backlogPending,
      openTaskAssignments,
      upcomingWakeups,
      activePortLeases,
    };
  } finally {
    db.close();
  }
}
