import {
  BrokerDB as CoreBrokerDB,
  CURRENT_BROKER_SCHEMA_VERSION,
  DEFAULT_DISCONNECTED_PURGE_GRACE_MS,
  DEFAULT_RESUMABLE_WINDOW_MS,
  defaultDbPath,
  type TaskAssignmentAwaitingReplyInfo,
} from "@pinet/broker-core/schema";
import type { RalphCycleRecord } from "../helpers.js";

interface RalphCycleRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  ghost_agent_ids: string;
  nudge_agent_ids: string;
  idle_drain_agent_ids: string;
  stuck_agent_ids: string;
  anomalies: string;
  anomaly_signature: string;
  follow_up_delivered: number;
  agent_count: number;
  backlog_count: number;
}

function ensureRalphCycleTable(db: { exec: (sql: string) => unknown }): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ralph_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms INTEGER,
      ghost_agent_ids TEXT NOT NULL DEFAULT '[]',
      nudge_agent_ids TEXT NOT NULL DEFAULT '[]',
      idle_drain_agent_ids TEXT NOT NULL DEFAULT '[]',
      stuck_agent_ids TEXT NOT NULL DEFAULT '[]',
      anomalies TEXT NOT NULL DEFAULT '[]',
      anomaly_signature TEXT NOT NULL DEFAULT '',
      follow_up_delivered INTEGER NOT NULL DEFAULT 0,
      agent_count INTEGER NOT NULL DEFAULT 0,
      backlog_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_ralph_cycles_started
      ON ralph_cycles(started_at);
  `);
}

export {
  CURRENT_BROKER_SCHEMA_VERSION,
  DEFAULT_DISCONNECTED_PURGE_GRACE_MS,
  DEFAULT_RESUMABLE_WINDOW_MS,
  defaultDbPath,
};
export type { TaskAssignmentAwaitingReplyInfo };

export class BrokerDB extends CoreBrokerDB {
  override initialize(): void {
    super.initialize();
    ensureRalphCycleTable(this.getDb());
  }

  recordRalphCycle(record: Omit<RalphCycleRecord, "id">): number {
    const db = this.getDb();
    const info = db
      .prepare(
        `INSERT INTO ralph_cycles (
           started_at, completed_at, duration_ms,
           ghost_agent_ids, nudge_agent_ids, idle_drain_agent_ids, stuck_agent_ids,
           anomalies, anomaly_signature, follow_up_delivered,
           agent_count, backlog_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.startedAt,
        record.completedAt,
        record.durationMs,
        JSON.stringify(record.ghostAgentIds),
        JSON.stringify(record.nudgeAgentIds),
        JSON.stringify(record.idleDrainAgentIds),
        JSON.stringify(record.stuckAgentIds),
        JSON.stringify(record.anomalies),
        record.anomalySignature,
        record.followUpDelivered ? 1 : 0,
        record.agentCount,
        record.backlogCount,
      );
    return Number(info.lastInsertRowid);
  }

  getRecentRalphCycles(limit = 20): RalphCycleRecord[] {
    const db = this.getDb();
    const rows = db
      .prepare("SELECT * FROM ralph_cycles ORDER BY started_at DESC LIMIT ?")
      .all(limit) as unknown as RalphCycleRow[];
    return rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      ghostAgentIds: JSON.parse(row.ghost_agent_ids) as string[],
      nudgeAgentIds: JSON.parse(row.nudge_agent_ids) as string[],
      idleDrainAgentIds: JSON.parse(row.idle_drain_agent_ids) as string[],
      stuckAgentIds: JSON.parse(row.stuck_agent_ids) as string[],
      anomalies: JSON.parse(row.anomalies) as string[],
      anomalySignature: row.anomaly_signature,
      followUpDelivered: row.follow_up_delivered === 1,
      agentCount: row.agent_count,
      backlogCount: row.backlog_count,
    }));
  }
}
