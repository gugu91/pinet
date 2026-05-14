import { DatabaseSync } from "node:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyPinetMail } from "./mail-classification.js";
import { getDefaultDbPath } from "./paths.js";
import type { PinetMailClass } from "./mail-classification.js";
import type {
  AgentInfo,
  ThreadInfo,
  BrokerMessage,
  InboxEntry,
  InboxReadOptions,
  InboxReadResult,
  InboxThreadUnreadSummary,
  DeliveredInboundMessageResult,
  BacklogEntry,
  BrokerDBInterface,
  InboundMessage,
  ChannelAssignment,
  TaskAssignmentInfo,
  TaskAssignmentStatus,
  ScheduledWakeupInfo,
  ScheduledWakeupDelivery,
  PortLeaseAcquireInput,
  PortLeaseInfo,
  PortLeaseListOptions,
  PortLeaseReleaseInput,
  PortLeaseRenewInput,
  PortLeaseStatus,
  PinetLaneInfo,
  PinetLaneListOptions,
  PinetLaneParticipantInfo,
  PinetLaneParticipantUpsertInput,
  PinetLaneRole,
  PinetLaneState,
  PinetLaneUpsertInput,
} from "./types.js";
interface SqliteJournalModeResult {
  journal_mode?: string | null;
}

function getSqliteJournalMode(result?: SqliteJournalModeResult): string {
  const mode = result?.journal_mode?.trim().toLowerCase();
  return mode && mode.length > 0 ? mode : "unknown";
}

function isSqliteWalEnabled(result?: SqliteJournalModeResult): boolean {
  return getSqliteJournalMode(result) === "wal";
}

function buildSqliteWalFallbackWarning(
  component: string,
  result?: SqliteJournalModeResult,
): string {
  return `[${component}] SQLite WAL mode not available, using ${getSqliteJournalMode(result)} journal mode fallback`;
}

// ─── Row types (raw SQLite rows) ─────────────────────────

interface AgentRow {
  id: string;
  stable_id: string | null;
  name: string;
  emoji: string;
  pid: number;
  connected_at: string;
  last_seen: string;
  last_heartbeat: string;
  metadata: string | null;
  status: string;
  disconnected_at: string | null;
  resumable_until: string | null;
  idle_since: string | null;
  last_activity: string | null;
}

interface ThreadRow {
  thread_id: string;
  source: string;
  channel: string;
  owner_agent: string | null;
  owner_binding: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface BacklogRow {
  id: number;
  thread_id: string;
  channel: string;
  message_id: number;
  reason: string;
  status: string;
  preferred_agent_id: string | null;
  assigned_agent_id: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskAssignmentRow {
  id: number;
  agent_id: string;
  issue_number: number;
  branch: string | null;
  pr_number: number | null;
  status: string;
  thread_id: string;
  source_message_id: number | null;
  created_at: string;
  updated_at: string;
}

interface ScheduledWakeupRow {
  id: number;
  agent_id: string;
  agent_stable_id: string | null;
  thread_id: string;
  body: string;
  fire_at: string;
  created_at: string;
}

interface PortLeaseRow {
  id: string;
  purpose: string;
  port: number;
  host: string;
  owner_agent_id: string | null;
  pid: number | null;
  status: string;
  metadata: string | null;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
  released_at: string | null;
}

interface PinetLaneRow {
  lane_id: string;
  name: string | null;
  task: string | null;
  issue_number: number | null;
  pr_number: number | null;
  thread_id: string | null;
  owner_agent_id: string | null;
  implementation_lead_agent_id: string | null;
  pm_mode: number;
  state: string;
  summary: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
}

interface PinetLaneParticipantRow {
  lane_id: string;
  agent_id: string;
  lane_role: string;
  status: string | null;
  summary: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
}

export interface TaskAssignmentAwaitingReplyInfo {
  id: number;
  agentId: string;
  issueNumber: number;
  status: TaskAssignmentStatus;
  sourceMessageId: number;
  originalSenderAgentId: string;
}

// ─── Mappers ─────────────────────────────────────────────

function rowToAgent(row: AgentRow): AgentInfo {
  return {
    id: row.id,
    stableId: row.stable_id,
    name: row.name,
    emoji: row.emoji,
    pid: row.pid,
    connectedAt: row.connected_at,
    lastSeen: row.last_seen,
    lastHeartbeat: row.last_heartbeat,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    status: row.status === "working" ? "working" : "idle",
    disconnectedAt: row.disconnected_at,
    resumableUntil: row.resumable_until,
    idleSince: row.idle_since,
    lastActivity: row.last_activity,
  };
}

function rowToThread(row: ThreadRow): ThreadInfo {
  return {
    threadId: row.thread_id,
    source: row.source,
    channel: row.channel,
    ownerAgent: row.owner_agent,
    ownerBinding: row.owner_binding === "explicit" ? "explicit" : null,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPortLease(row: PortLeaseRow): PortLeaseInfo {
  return {
    id: row.id,
    purpose: row.purpose,
    port: row.port,
    host: row.host,
    ownerAgentId: row.owner_agent_id,
    pid: row.pid,
    status: normalizePortLeaseStatus(row.status),
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
  };
}

function normalizePortLeaseStatus(value: string): PortLeaseStatus {
  if (value === "released" || value === "expired") {
    return value;
  }
  return "active";
}

function getStringMetadataValue(
  metadata: Record<string, unknown> | undefined,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function deriveMessageSyncIdentity(
  source: string,
  metadata?: Record<string, unknown>,
): { externalId: string | null; externalTs: string | null } {
  const explicitExternalId = getStringMetadataValue(metadata, [
    "externalId",
    "external_id",
    "transportMessageId",
    "transport_message_id",
  ]);
  const explicitExternalTs = getStringMetadataValue(metadata, [
    "externalTs",
    "external_ts",
    "timestamp",
    "ts",
  ]);
  if (explicitExternalId) {
    return { externalId: explicitExternalId, externalTs: explicitExternalTs };
  }

  if (source === "slack") {
    const channel = getStringMetadataValue(metadata, ["channel", "channelId", "channel_id"]);
    const timestamp = getStringMetadataValue(metadata, ["timestamp", "ts"]);
    if (timestamp && channel) {
      return { externalId: `${channel}:${timestamp}`, externalTs: timestamp };
    }
    if (timestamp) {
      return { externalId: timestamp, externalTs: timestamp };
    }
  }

  return { externalId: null, externalTs: explicitExternalTs };
}

function parseJsonMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isArrowUpReactionName(value: string | null): boolean {
  return value === "arrow_up" || value === "⬆" || value === "⬆️";
}

function appendMetadataAudit(
  metadata: Record<string, unknown>,
  key: string,
  audit: Record<string, unknown>,
): void {
  const existing = Array.isArray(metadata[key])
    ? (metadata[key] as unknown[]).filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  metadata[key] = [...existing.slice(-19), audit];
}

const PINET_MAIL_CLASS_PRIORITY: Record<PinetMailClass, number> = {
  steering: 0,
  fwup: 1,
  maintenance_context: 2,
};

function comparePinetMailClassPriority(a: PinetMailClass, b: PinetMailClass): number {
  return PINET_MAIL_CLASS_PRIORITY[a] - PINET_MAIL_CLASS_PRIORITY[b];
}

function emptyMailClassCounts(): Record<PinetMailClass, number> {
  return { steering: 0, fwup: 0, maintenance_context: 0 };
}

function rowToBrokerMessage(row: {
  id: number;
  thread_id: string;
  source: string;
  direction: string;
  sender: string;
  body: string;
  metadata: string | null;
  external_id?: string | null;
  external_ts?: string | null;
  created_at: string;
}): BrokerMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    source: row.source,
    direction: row.direction as "inbound" | "outbound",
    sender: row.sender,
    body: row.body,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    ...(row.external_ts ? { externalTs: row.external_ts } : {}),
    createdAt: row.created_at,
  };
}

function rowToBacklog(row: BacklogRow): BacklogEntry {
  return {
    id: row.id,
    threadId: row.thread_id,
    channel: row.channel,
    messageId: row.message_id,
    reason: row.reason,
    status:
      row.status === "assigned" ? "assigned" : row.status === "dropped" ? "dropped" : "pending",
    preferredAgentId: row.preferred_agent_id,
    assignedAgentId: row.assigned_agent_id,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTaskAssignment(row: TaskAssignmentRow): TaskAssignmentInfo {
  return {
    id: row.id,
    agentId: row.agent_id,
    issueNumber: row.issue_number,
    branch: row.branch,
    prNumber: row.pr_number,
    status: row.status as TaskAssignmentStatus,
    threadId: row.thread_id,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToScheduledWakeup(row: ScheduledWakeupRow): ScheduledWakeupInfo {
  return {
    id: row.id,
    agentId: row.agent_id,
    threadId: row.thread_id,
    body: row.body,
    fireAt: row.fire_at,
    createdAt: row.created_at,
  };
}

const PINET_LANE_STATES = new Set<PinetLaneState>([
  "planned",
  "active",
  "blocked",
  "review",
  "ready",
  "done",
  "cancelled",
  "detached",
]);

const PINET_LANE_ROLES = new Set<PinetLaneRole>([
  "broker",
  "coordinator",
  "pm",
  "lead",
  "implementer",
  "reviewer",
  "second_pass_reviewer",
  "observer",
]);

function parseMetadataJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function rowToPinetLaneParticipant(row: PinetLaneParticipantRow): PinetLaneParticipantInfo {
  return {
    laneId: row.lane_id,
    agentId: row.agent_id,
    role: normalizePinetLaneRole(row.lane_role),
    status: row.status,
    summary: row.summary,
    metadata: parseMetadataJson(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
  };
}

function rowToPinetLane(
  row: PinetLaneRow,
  participants: PinetLaneParticipantInfo[] = [],
): PinetLaneInfo {
  return {
    laneId: row.lane_id,
    name: row.name,
    task: row.task,
    issueNumber: row.issue_number,
    prNumber: row.pr_number,
    threadId: row.thread_id,
    ownerAgentId: row.owner_agent_id,
    implementationLeadAgentId: row.implementation_lead_agent_id,
    pmMode: row.pm_mode === 1,
    state: normalizePinetLaneState(row.state),
    summary: row.summary,
    metadata: parseMetadataJson(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    participants,
  };
}

function normalizePinetLaneState(
  value: unknown,
  fallback: PinetLaneState = "active",
): PinetLaneState {
  return typeof value === "string" && PINET_LANE_STATES.has(value as PinetLaneState)
    ? (value as PinetLaneState)
    : fallback;
}

function requirePinetLaneState(value: unknown): PinetLaneState {
  if (typeof value === "string" && PINET_LANE_STATES.has(value as PinetLaneState)) {
    return value as PinetLaneState;
  }
  throw new Error(`Invalid Pinet lane state: ${String(value)}`);
}

function normalizePinetLaneRole(
  value: unknown,
  fallback: PinetLaneRole = "observer",
): PinetLaneRole {
  return typeof value === "string" && PINET_LANE_ROLES.has(value as PinetLaneRole)
    ? (value as PinetLaneRole)
    : fallback;
}

function requirePinetLaneRole(value: unknown): PinetLaneRole {
  if (typeof value === "string" && PINET_LANE_ROLES.has(value as PinetLaneRole)) {
    return value as PinetLaneRole;
  }
  throw new Error(`Invalid Pinet lane role: ${String(value)}`);
}

function normalizeLaneId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("laneId must be a non-empty string");
  }
  return trimmed;
}

function normalizeOptionalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalInteger(value: number | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("lane issue/PR numbers must be non-negative integers");
  }
  return value;
}

function serializeOptionalMetadata(
  value: Record<string, unknown> | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : JSON.stringify(value);
}

function normalizePortLeasePurpose(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("purpose must be a non-empty string");
  }
  return trimmed;
}

function normalizePortLeaseId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("leaseId must be a non-empty string");
  }
  return trimmed;
}

function normalizeOptionalPortLeaseOwner(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePortLeaseHost(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "127.0.0.1";
}

function normalizePortLeasePort(value: number, label = "port"): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return value;
}

function normalizePortLeaseTtlMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("ttlMs must be a positive finite number");
  }
  return Math.max(1, Math.round(value));
}

function normalizePortLeasePid(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("pid must be a positive integer");
  }
  return value;
}

function normalizePortLeaseRange(
  minPort?: number,
  maxPort?: number,
): { minPort: number; maxPort: number } {
  const min = normalizePortLeasePort(minPort ?? 49152, "minPort");
  const max = normalizePortLeasePort(maxPort ?? 65535, "maxPort");
  if (min > max) {
    throw new Error("minPort must be less than or equal to maxPort");
  }
  return { minPort: min, maxPort: max };
}

// ─── Default DB path ─────────────────────────────────────

export function defaultDbPath(): string {
  return getDefaultDbPath();
}

export const DEFAULT_RESUMABLE_WINDOW_MS = 15_000;
export const DEFAULT_DISCONNECTED_PURGE_GRACE_MS = 60 * 60_000;
export const CURRENT_BROKER_SCHEMA_VERSION = 16;

const REQUIRED_AGENT_LIFECYCLE_COLUMNS = [
  "stable_id",
  "metadata",
  "status",
  "last_heartbeat",
  "disconnected_at",
  "resumable_until",
] as const;

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function setUserVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}

function getTableColumns(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { present: number } | undefined;
  return row !== undefined;
}

function ensureColumn(db: DatabaseSync, tableName: string, columnName: string, sql: string): void {
  if (!getTableColumns(db, tableName).has(columnName)) {
    db.exec(sql);
  }
}

function createCoreTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      pid INTEGER NOT NULL,
      connected_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      thread_id TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL,
      channel TEXT NOT NULL,
      owner_agent TEXT,
      owner_binding TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      source TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      metadata TEXT,
      external_id TEXT,
      external_ts TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      read_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_thread
      ON messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_inbox_agent_delivered
      ON inbox(agent_id, delivered, created_at);
    CREATE INDEX IF NOT EXISTS idx_inbox_message
      ON inbox(message_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_agent_message_pending_unique
      ON inbox(agent_id, message_id)
      WHERE delivered = 0;
  `);

  const messageColumns = getTableColumns(db, "messages");
  if (messageColumns.has("external_id")) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_external_id
        ON messages(source, external_id)
        WHERE external_id IS NOT NULL;
    `);
  }
  if (messageColumns.has("external_ts")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_source_external_ts
        ON messages(source, external_ts);
    `);
  }

  if (getTableColumns(db, "inbox").has("read_at")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inbox_agent_read
        ON inbox(agent_id, read_at, created_at);
    `);
  }
}

function createBacklogTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unrouted_backlog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      message_id INTEGER NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'assigned', 'dropped')),
      preferred_agent_id TEXT,
      assigned_agent_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_backlog_status_created
      ON unrouted_backlog(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_backlog_thread_status
      ON unrouted_backlog(thread_id, status);
    CREATE INDEX IF NOT EXISTS idx_backlog_preferred_agent_status
      ON unrouted_backlog(preferred_agent_id, status);
  `);
}

function createSettingsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function addAgentLifecycleColumns(db: DatabaseSync): void {
  ensureColumn(db, "agents", "stable_id", "ALTER TABLE agents ADD COLUMN stable_id TEXT");
  ensureColumn(db, "agents", "metadata", "ALTER TABLE agents ADD COLUMN metadata TEXT");
  ensureColumn(
    db,
    "agents",
    "status",
    "ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'",
  );
  ensureColumn(db, "agents", "last_heartbeat", "ALTER TABLE agents ADD COLUMN last_heartbeat TEXT");
  ensureColumn(
    db,
    "agents",
    "disconnected_at",
    "ALTER TABLE agents ADD COLUMN disconnected_at TEXT",
  );
  ensureColumn(
    db,
    "agents",
    "resumable_until",
    "ALTER TABLE agents ADD COLUMN resumable_until TEXT",
  );

  db.exec(`
    UPDATE agents
    SET last_heartbeat = COALESCE(last_heartbeat, last_seen)
    WHERE last_heartbeat IS NULL;

    CREATE INDEX IF NOT EXISTS idx_agents_last_heartbeat
      ON agents(last_heartbeat);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_stable_id
      ON agents(stable_id)
      WHERE stable_id IS NOT NULL;
  `);
}

function addObservabilityColumns(db: DatabaseSync): void {
  ensureColumn(db, "agents", "idle_since", "ALTER TABLE agents ADD COLUMN idle_since TEXT");
  ensureColumn(db, "agents", "last_activity", "ALTER TABLE agents ADD COLUMN last_activity TEXT");

  // Set idle_since for currently idle agents that lack it
  db.exec(`
    UPDATE agents
    SET idle_since = COALESCE(idle_since, last_seen)
    WHERE status = 'idle' AND idle_since IS NULL;
  `);
}

function addThreadOwnershipBindingColumn(db: DatabaseSync): void {
  createCoreTables(db);
  ensureColumn(db, "threads", "owner_binding", "ALTER TABLE threads ADD COLUMN owner_binding TEXT");
}

function addInboxReadCursorColumn(db: DatabaseSync): void {
  createCoreTables(db);
  ensureColumn(db, "inbox", "read_at", "ALTER TABLE inbox ADD COLUMN read_at TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_inbox_agent_read
      ON inbox(agent_id, read_at, created_at);
  `);
}

function addThreadMetadataColumn(db: DatabaseSync): void {
  createCoreTables(db);
  ensureColumn(db, "threads", "metadata", "ALTER TABLE threads ADD COLUMN metadata TEXT");
}

function backfillMessageSyncIdentities(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT id, source, metadata FROM messages WHERE metadata IS NOT NULL")
    .all() as Array<{ id: number; source: string; metadata: string | null }>;
  const update = db.prepare("UPDATE messages SET external_id = ?, external_ts = ? WHERE id = ?");

  for (const row of rows) {
    if (!row.metadata) continue;
    try {
      const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      const identity = deriveMessageSyncIdentity(row.source, metadata);
      if (identity.externalId || identity.externalTs) {
        update.run(identity.externalId, identity.externalTs, row.id);
      }
    } catch {
      // Keep corrupt legacy metadata readable; it simply cannot receive a sync identity.
    }
  }
}

function pickBacklogStatus(left: string, right: string): BacklogEntry["status"] {
  if (left === "assigned" || right === "assigned") return "assigned";
  if (left === "pending" || right === "pending") return "pending";
  return "dropped";
}

function maxNullableIso(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function minIso(left: string, right: string): string {
  return left <= right ? left : right;
}

function mergeBacklogMessageId(
  db: DatabaseSync,
  keepMessageId: number,
  duplicateMessageId: number,
): void {
  const getBacklog = db.prepare("SELECT * FROM unrouted_backlog WHERE message_id = ?");
  const keep = getBacklog.get(keepMessageId) as BacklogRow | undefined;
  const duplicate = getBacklog.get(duplicateMessageId) as BacklogRow | undefined;
  if (!duplicate) return;

  if (!keep) {
    db.prepare("UPDATE unrouted_backlog SET message_id = ? WHERE id = ?").run(
      keepMessageId,
      duplicate.id,
    );
    return;
  }

  const mergedStatus = pickBacklogStatus(keep.status, duplicate.status);
  db.prepare(
    `UPDATE unrouted_backlog
     SET reason = ?,
         status = ?,
         preferred_agent_id = ?,
         assigned_agent_id = ?,
         attempt_count = ?,
         last_attempt_at = ?,
         created_at = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    keep.reason || duplicate.reason,
    mergedStatus,
    keep.preferred_agent_id ?? duplicate.preferred_agent_id,
    mergedStatus === "assigned" ? (keep.assigned_agent_id ?? duplicate.assigned_agent_id) : null,
    Math.max(keep.attempt_count, duplicate.attempt_count),
    maxNullableIso(keep.last_attempt_at, duplicate.last_attempt_at),
    minIso(keep.created_at, duplicate.created_at),
    maxNullableIso(keep.updated_at, duplicate.updated_at) ?? keep.updated_at,
    keep.id,
  );
  db.prepare("DELETE FROM unrouted_backlog WHERE id = ?").run(duplicate.id);
}

function consolidateDuplicateMessageSyncIdentities(db: DatabaseSync): void {
  const duplicateRows = db
    .prepare(
      `SELECT source, external_id, MIN(id) AS keep_id
       FROM messages
       WHERE external_id IS NOT NULL
       GROUP BY source, external_id
       HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ source: string; external_id: string; keep_id: number }>;
  const findDuplicates = db.prepare(
    `SELECT id
     FROM messages
     WHERE source = ?
       AND external_id = ?
       AND id <> ?`,
  );
  const repointInbox = db.prepare("UPDATE inbox SET message_id = ? WHERE message_id = ?");
  const repointTaskAssignments = tableExists(db, "task_assignments")
    ? db.prepare("UPDATE task_assignments SET source_message_id = ? WHERE source_message_id = ?")
    : null;
  const hasBacklog = tableExists(db, "unrouted_backlog");
  const clearDuplicate = db.prepare(
    `UPDATE messages
     SET external_id = NULL,
         external_ts = NULL
     WHERE id = ?`,
  );

  for (const row of duplicateRows) {
    const duplicates = findDuplicates.all(row.source, row.external_id, row.keep_id) as Array<{
      id: number;
    }>;
    for (const duplicate of duplicates) {
      repointInbox.run(row.keep_id, duplicate.id);
      repointTaskAssignments?.run(row.keep_id, duplicate.id);
      if (hasBacklog) {
        mergeBacklogMessageId(db, row.keep_id, duplicate.id);
      }
      clearDuplicate.run(duplicate.id);
    }
  }
}

function deleteDuplicateInboxRows(db: DatabaseSync): void {
  db.exec(`
    UPDATE inbox
    SET read_at = (
      SELECT MAX(duplicate.read_at)
      FROM inbox AS duplicate
      WHERE duplicate.agent_id = inbox.agent_id
        AND duplicate.message_id = inbox.message_id
        AND duplicate.read_at IS NOT NULL
    )
    WHERE EXISTS (
      SELECT 1
      FROM inbox AS duplicate
      WHERE duplicate.agent_id = inbox.agent_id
        AND duplicate.message_id = inbox.message_id
        AND duplicate.read_at IS NOT NULL
    );

    DELETE FROM inbox
    WHERE id NOT IN (
      SELECT COALESCE(
        MIN(CASE WHEN delivered = 1 THEN id END),
        MIN(id)
      )
      FROM inbox
      GROUP BY agent_id, message_id
    );
  `);
}

function addMessageSyncIdentityColumns(db: DatabaseSync): void {
  ensureColumn(db, "messages", "external_id", "ALTER TABLE messages ADD COLUMN external_id TEXT");
  ensureColumn(db, "messages", "external_ts", "ALTER TABLE messages ADD COLUMN external_ts TEXT");
  backfillMessageSyncIdentities(db);
  consolidateDuplicateMessageSyncIdentities(db);
  deleteDuplicateInboxRows(db);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_external_id
      ON messages(source, external_id)
      WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_source_external_ts
      ON messages(source, external_ts);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_agent_message_pending_unique
      ON inbox(agent_id, message_id)
      WHERE delivered = 0;
  `);
}

function addBacklogAffinityColumns(db: DatabaseSync): void {
  ensureColumn(
    db,
    "unrouted_backlog",
    "preferred_agent_id",
    "ALTER TABLE unrouted_backlog ADD COLUMN preferred_agent_id TEXT",
  );

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_backlog_preferred_agent_status
      ON unrouted_backlog(preferred_agent_id, status);
  `);
}

function createTaskAssignmentTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      branch TEXT,
      pr_number INTEGER,
      status TEXT NOT NULL DEFAULT 'assigned'
        CHECK(status IN ('assigned', 'branch_pushed', 'pr_open', 'pr_merged', 'pr_closed')),
      thread_id TEXT NOT NULL,
      source_message_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(issue_number)
    );

    CREATE INDEX IF NOT EXISTS idx_task_assignments_agent_status
      ON task_assignments(agent_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_assignments_branch
      ON task_assignments(branch);
  `);
}

function migrateTaskAssignmentsToIssueOwnership(db: DatabaseSync): void {
  const existingTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_assignments'")
    .get() as { name?: string } | undefined;
  if (!existingTable) {
    createTaskAssignmentTable(db);
    return;
  }

  db.exec(`
    ALTER TABLE task_assignments RENAME TO task_assignments_legacy;
    DROP INDEX IF EXISTS idx_task_assignments_agent_status;
    DROP INDEX IF EXISTS idx_task_assignments_branch;
  `);

  createTaskAssignmentTable(db);

  db.exec(`
    INSERT INTO task_assignments (
      agent_id,
      issue_number,
      branch,
      pr_number,
      status,
      thread_id,
      source_message_id,
      created_at,
      updated_at
    )
    SELECT
      legacy.agent_id,
      legacy.issue_number,
      legacy.branch,
      legacy.pr_number,
      legacy.status,
      legacy.thread_id,
      legacy.source_message_id,
      legacy.created_at,
      legacy.updated_at
    FROM task_assignments_legacy AS legacy
    WHERE legacy.id = (
      SELECT latest.id
      FROM task_assignments_legacy AS latest
      WHERE latest.issue_number = legacy.issue_number
      ORDER BY latest.updated_at DESC, latest.created_at DESC, latest.id DESC
      LIMIT 1
    );

    DROP TABLE task_assignments_legacy;
  `);
}

function createScheduledWakeupsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_wakeups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      agent_stable_id TEXT,
      thread_id TEXT NOT NULL,
      body TEXT NOT NULL,
      fire_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_wakeups_fire_target
      ON scheduled_wakeups(fire_at, agent_stable_id, agent_id);
  `);
}

function addScheduledWakeupStableIdColumn(db: DatabaseSync): void {
  ensureColumn(
    db,
    "scheduled_wakeups",
    "agent_stable_id",
    "ALTER TABLE scheduled_wakeups ADD COLUMN agent_stable_id TEXT",
  );

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_wakeups_fire_target
      ON scheduled_wakeups(fire_at, agent_stable_id, agent_id);
  `);

  db.prepare(
    `UPDATE scheduled_wakeups
     SET agent_stable_id = (
       SELECT stable_id FROM agents WHERE agents.id = scheduled_wakeups.agent_id
     )
     WHERE agent_stable_id IS NULL`,
  ).run();
}

function createPortLeaseTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS port_leases (
      id TEXT PRIMARY KEY NOT NULL,
      purpose TEXT NOT NULL,
      port INTEGER NOT NULL,
      host TEXT NOT NULL DEFAULT '127.0.0.1',
      owner_agent_id TEXT,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'released', 'expired')),
      metadata TEXT,
      acquired_at TEXT NOT NULL,
      renewed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      released_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_port_leases_active_port
      ON port_leases(host, port)
      WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_port_leases_expiry
      ON port_leases(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_port_leases_owner
      ON port_leases(owner_agent_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_port_leases_purpose
      ON port_leases(purpose, status, expires_at);
  `);
}

function createPinetLaneTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pinet_lanes (
      lane_id TEXT PRIMARY KEY NOT NULL,
      name TEXT,
      task TEXT,
      issue_number INTEGER,
      pr_number INTEGER,
      thread_id TEXT,
      owner_agent_id TEXT,
      implementation_lead_agent_id TEXT,
      pm_mode INTEGER NOT NULL DEFAULT 0 CHECK(pm_mode IN (0, 1)),
      state TEXT NOT NULL DEFAULT 'active'
        CHECK(state IN ('planned', 'active', 'blocked', 'review', 'ready', 'done', 'cancelled', 'detached')),
      summary TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pinet_lane_participants (
      lane_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      lane_role TEXT NOT NULL
        CHECK(lane_role IN ('broker', 'coordinator', 'pm', 'lead', 'implementer', 'reviewer', 'second_pass_reviewer', 'observer')),
      status TEXT,
      summary TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      PRIMARY KEY(lane_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pinet_lanes_state_updated
      ON pinet_lanes(state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pinet_lanes_owner_state
      ON pinet_lanes(owner_agent_id, state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pinet_lanes_issue
      ON pinet_lanes(issue_number);
    CREATE INDEX IF NOT EXISTS idx_pinet_lane_participants_agent
      ON pinet_lane_participants(agent_id, lane_role, updated_at DESC);
  `);
}

function runSchemaMigrations(db: DatabaseSync): void {
  const currentVersion = getUserVersion(db);
  if (currentVersion >= CURRENT_BROKER_SCHEMA_VERSION) {
    return;
  }

  for (
    let nextVersion = currentVersion + 1;
    nextVersion <= CURRENT_BROKER_SCHEMA_VERSION;
    nextVersion += 1
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      switch (nextVersion) {
        case 1:
          createCoreTables(db);
          break;
        case 2:
          createBacklogTable(db);
          break;
        case 3:
          addAgentLifecycleColumns(db);
          break;
        case 4:
          addObservabilityColumns(db);
          break;
        case 5:
          addBacklogAffinityColumns(db);
          break;
        case 6:
          createTaskAssignmentTable(db);
          break;
        case 7:
          migrateTaskAssignmentsToIssueOwnership(db);
          break;
        case 8:
          createScheduledWakeupsTable(db);
          break;
        case 9:
          addScheduledWakeupStableIdColumn(db);
          break;
        case 10:
          createSettingsTable(db);
          break;
        case 11:
          addThreadOwnershipBindingColumn(db);
          break;
        case 12:
          addInboxReadCursorColumn(db);
          break;
        case 13:
          addMessageSyncIdentityColumns(db);
          break;
        case 14:
          addThreadMetadataColumn(db);
          break;
        case 15:
          createPinetLaneTables(db);
          break;
        case 16:
          createPortLeaseTable(db);
          break;
        default:
          throw new Error(`Unsupported broker schema migration target: ${nextVersion}`);
      }
      setUserVersion(db, nextVersion);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* best effort */
      }
      throw new Error(`Broker schema migration v${nextVersion} failed`, { cause: error });
    }
  }
}

// ─── BrokerDB ────────────────────────────────────────────

export class BrokerDB implements BrokerDBInterface {
  private db: DatabaseSync | null = null;
  private readonly dbPath: string;
  private allowedUsers: Set<string> | null = new Set();

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? defaultDbPath();
  }

  initialize(): void {
    if (this.db) return;

    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    try {
      this.openAndMigrate();
    } catch (error) {
      console.error(
        `[BrokerDB] Failed to open or migrate ${this.dbPath}; recreating from scratch`,
        error,
      );
      this.resetDatabaseFiles();

      try {
        this.openAndMigrate();
      } catch (recreateError) {
        console.error(`[BrokerDB] Failed to recreate ${this.dbPath} from scratch`, recreateError);
        this.close();
        throw recreateError;
      }
    }

    // Broker startup reconciliation: any connected rows belong to a previous
    // broker session, so mark them resumably disconnected and wait for workers
    // to reconnect by stableId.
    this.reconcileStartupAgents();
  }

  /**
   * Mark all previously connected agents as resumably disconnected on broker
   * startup. Their inbox/thread ownership stays intact during the lease window
   * so reconnecting workers can resume by stableId.
   */
  reconcileStartupAgents(resumableForMs = DEFAULT_RESUMABLE_WINDOW_MS): void {
    const db = this.getDb();
    const missingColumns = this.getMissingRequiredAgentLifecycleColumns(db);
    if (missingColumns.length > 0) {
      console.error(
        `[BrokerDB] Skipping startup reconciliation; agents table is missing columns: ${missingColumns.join(", ")}`,
      );
      return;
    }

    const now = new Date();
    const disconnectedAt = now.toISOString();
    const resumableUntil = new Date(now.getTime() + resumableForMs).toISOString();

    db.prepare(
      `UPDATE agents
       SET disconnected_at = ?,
           resumable_until = COALESCE(resumable_until, ?)
       WHERE disconnected_at IS NULL`,
    ).run(disconnectedAt, resumableUntil);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ─── Agents ──────────────────────────────────────────

  registerAgent(
    id: string,
    name: string,
    emoji: string,
    pid: number,
    metadata?: Record<string, unknown>,
    stableId?: string,
  ): AgentInfo {
    const db = this.getDb();
    const now = new Date().toISOString();
    const existing = stableId ? this.getAgentRowByStableId(stableId) : null;
    const existingById = this.getAgentRowById(existing?.id ?? id);
    const existingRow = existingById ?? existing;
    const agentId = existing?.id ?? id;
    const finalName = this.ensureUniqueAgentName(name, agentId);
    const finalEmoji = emoji.trim() || existingRow?.emoji || "";
    const persistedStableId = stableId ?? existing?.stable_id ?? existingById?.stable_id ?? null;
    // Reconnecting agents are authoritative for their current runtime identity. If a
    // stable session comes back with a new name/emoji, refresh the broker roster
    // instead of replaying stale values from the previous broker DB row.
    const finalMetadata =
      metadata ??
      (existingRow?.metadata
        ? (JSON.parse(existingRow.metadata) as Record<string, unknown>)
        : undefined);
    const meta = finalMetadata ? JSON.stringify(finalMetadata) : null;

    db.prepare(
      `INSERT INTO agents (
         id, stable_id, name, emoji, pid,
         connected_at, last_seen, last_heartbeat,
         metadata, status, disconnected_at, resumable_until,
         idle_since, last_activity
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, NULL, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         stable_id = COALESCE(excluded.stable_id, agents.stable_id),
         name = excluded.name,
         emoji = excluded.emoji,
         pid = excluded.pid,
         connected_at = excluded.connected_at,
         last_seen = excluded.last_seen,
         last_heartbeat = excluded.last_heartbeat,
         metadata = excluded.metadata,
         status = 'idle',
         disconnected_at = NULL,
         resumable_until = NULL,
         idle_since = excluded.idle_since,
         last_activity = NULL`,
    ).run(agentId, persistedStableId, finalName, finalEmoji, pid, now, now, now, meta, now);

    return {
      id: agentId,
      name: finalName,
      emoji: finalEmoji,
      pid,
      connectedAt: now,
      lastSeen: now,
      lastHeartbeat: now,
      metadata: finalMetadata ?? null,
      status: "idle" as const,
      idleSince: now,
      lastActivity: null,
    };
  }

  unregisterAgent(id: string): void {
    const db = this.getDb();
    const now = new Date().toISOString();

    this.withTransaction(() => {
      this.requeueUndeliveredMessagesInternal(id, "agent_disconnected");
      db.prepare("DELETE FROM inbox WHERE agent_id = ?").run(id);
      db.prepare("UPDATE agents SET disconnected_at = ?, resumable_until = NULL WHERE id = ?").run(
        now,
        id,
      );
      db.prepare("UPDATE threads SET owner_agent = NULL WHERE owner_agent = ?").run(id);
    });
  }

  disconnectAgent(id: string, resumableForMs = DEFAULT_RESUMABLE_WINDOW_MS): void {
    const db = this.getDb();
    const now = new Date();
    const resumableUntil = new Date(now.getTime() + resumableForMs).toISOString();
    db.prepare("UPDATE agents SET disconnected_at = ?, resumable_until = ? WHERE id = ?").run(
      now.toISOString(),
      resumableUntil,
      id,
    );
  }

  getAgentById(id: string): AgentInfo | null {
    const row = this.getAgentRowById(id);
    return row ? rowToAgent(row) : null;
  }

  private getCurrentSessionOutboundCount(agentId: string, connectedAt: string): number {
    const db = this.getDb();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messages
         WHERE sender = ?
           AND source = 'agent'
           AND created_at >= ?`,
      )
      .get(agentId, connectedAt) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private rowToAgentWithCurrentSessionOutboundCount(row: AgentRow): AgentInfo {
    const agent = rowToAgent(row);
    return {
      ...agent,
      outboundCount: this.getCurrentSessionOutboundCount(agent.id, agent.connectedAt),
    };
  }

  getAgents(): AgentInfo[] {
    const db = this.getDb();
    const rows = db
      .prepare("SELECT * FROM agents WHERE disconnected_at IS NULL ORDER BY connected_at ASC")
      .all() as unknown as AgentRow[];
    return rows.map((row) => this.rowToAgentWithCurrentSessionOutboundCount(row));
  }

  getAllAgents(): AgentInfo[] {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT * FROM agents
         ORDER BY CASE WHEN disconnected_at IS NULL THEN 0 ELSE 1 END, connected_at ASC`,
      )
      .all() as unknown as AgentRow[];
    return rows.map((row) => this.rowToAgentWithCurrentSessionOutboundCount(row));
  }

  getSetting<T = unknown>(key: string): T | null {
    const db = this.getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as T;
  }

  setSetting(key: string, value: unknown): void {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(value), now);
  }

  deleteSetting(key: string): void {
    const db = this.getDb();
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  // ─── Port leases ─────────────────────────────────────

  acquirePortLease(input: PortLeaseAcquireInput): PortLeaseInfo {
    const db = this.getDb();
    const purpose = normalizePortLeasePurpose(input.purpose);
    const ttlMs = normalizePortLeaseTtlMs(input.ttlMs);
    const host = normalizePortLeaseHost(input.host);
    const requestedPort = input.port === undefined ? undefined : normalizePortLeasePort(input.port);
    const explicitRange = input.minPort !== undefined || input.maxPort !== undefined;
    const { minPort, maxPort } = explicitRange
      ? normalizePortLeaseRange(input.minPort, input.maxPort)
      : requestedPort === undefined
        ? normalizePortLeaseRange(input.minPort, input.maxPort)
        : { minPort: requestedPort, maxPort: requestedPort };
    const ownerAgentId = normalizeOptionalPortLeaseOwner(input.ownerAgentId) ?? null;
    const pid = normalizePortLeasePid(input.pid);
    const metadata = serializeOptionalMetadata(input.metadata) ?? null;

    if (requestedPort !== undefined && (requestedPort < minPort || requestedPort > maxPort)) {
      throw new Error("port must be within minPort and maxPort");
    }

    return this.withTransaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      this.expirePortLeasesInternal(nowIso);

      const port = requestedPort ?? this.findAvailablePortLeasePort(host, minPort, maxPort);
      if (port === null) {
        throw new Error(`No available port lease in range ${minPort}-${maxPort} for ${host}`);
      }

      const leaseId = crypto.randomUUID();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      try {
        db.prepare(
          `INSERT INTO port_leases (
             id, purpose, port, host, owner_agent_id, pid, status, metadata,
             acquired_at, renewed_at, expires_at, released_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL)`,
        ).run(leaseId, purpose, port, host, ownerAgentId, pid, metadata, nowIso, nowIso, expiresAt);
      } catch (error) {
        if (requestedPort !== undefined) {
          throw new Error(`Port ${host}:${requestedPort} already has an active lease`, {
            cause: error,
          });
        }
        throw error;
      }

      const lease = this.getPortLeaseRowById(leaseId);
      if (!lease) {
        throw new Error(`Failed to create port lease ${leaseId}`);
      }
      return rowToPortLease(lease);
    });
  }

  renewPortLease(input: PortLeaseRenewInput): PortLeaseInfo {
    const db = this.getDb();
    const leaseId = normalizePortLeaseId(input.leaseId);
    const ttlMs = normalizePortLeaseTtlMs(input.ttlMs);
    const ownerAgentId = normalizeOptionalPortLeaseOwner(input.ownerAgentId);

    return this.withTransaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      this.expirePortLeasesInternal(nowIso);
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

      const result =
        ownerAgentId === undefined
          ? db
              .prepare(
                `UPDATE port_leases
                 SET renewed_at = ?, expires_at = ?
                 WHERE id = ? AND status = 'active'`,
              )
              .run(nowIso, expiresAt, leaseId)
          : db
              .prepare(
                `UPDATE port_leases
                 SET renewed_at = ?, expires_at = ?
                 WHERE id = ? AND status = 'active' AND owner_agent_id IS ?`,
              )
              .run(nowIso, expiresAt, leaseId, ownerAgentId);

      if (Number(result.changes ?? 0) === 0) {
        throw new Error("No active port lease matched leaseId/ownerAgentId");
      }
      const lease = this.getPortLeaseRowById(leaseId);
      if (!lease) {
        throw new Error(`Port lease ${leaseId} disappeared after renew`);
      }
      return rowToPortLease(lease);
    });
  }

  releasePortLease(input: PortLeaseReleaseInput): PortLeaseInfo {
    const db = this.getDb();
    const leaseId = normalizePortLeaseId(input.leaseId);
    const ownerAgentId = normalizeOptionalPortLeaseOwner(input.ownerAgentId);

    return this.withTransaction(() => {
      const nowIso = new Date().toISOString();
      this.expirePortLeasesInternal(nowIso);
      const result =
        ownerAgentId === undefined
          ? db
              .prepare(
                `UPDATE port_leases
                 SET status = 'released', released_at = ?
                 WHERE id = ? AND status = 'active'`,
              )
              .run(nowIso, leaseId)
          : db
              .prepare(
                `UPDATE port_leases
                 SET status = 'released', released_at = ?
                 WHERE id = ? AND status = 'active' AND owner_agent_id IS ?`,
              )
              .run(nowIso, leaseId, ownerAgentId);

      if (Number(result.changes ?? 0) === 0) {
        throw new Error("No active port lease matched leaseId/ownerAgentId");
      }
      const lease = this.getPortLeaseRowById(leaseId);
      if (!lease) {
        throw new Error(`Port lease ${leaseId} disappeared after release`);
      }
      return rowToPortLease(lease);
    });
  }

  getPortLease(leaseId: string): PortLeaseInfo | null {
    const id = normalizePortLeaseId(leaseId);
    this.expirePortLeases();
    const row = this.getPortLeaseRowById(id);
    return row ? rowToPortLease(row) : null;
  }

  listPortLeases(options: PortLeaseListOptions = {}): PortLeaseInfo[] {
    const db = this.getDb();
    this.expirePortLeases();
    const clauses: string[] = [];
    const values: (string | number | null)[] = [];

    if (options.expiredOnly) {
      clauses.push("status = 'expired'");
    } else if (!options.includeInactive) {
      clauses.push("status = 'active'");
    }
    if (options.ownerAgentId !== undefined) {
      clauses.push("owner_agent_id IS ?");
      values.push(normalizeOptionalPortLeaseOwner(options.ownerAgentId) ?? null);
    }
    if (options.purpose !== undefined) {
      clauses.push("purpose = ?");
      values.push(normalizePortLeasePurpose(options.purpose));
    }
    if (options.host !== undefined) {
      clauses.push("host = ?");
      values.push(normalizePortLeaseHost(options.host));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT * FROM port_leases
         ${where}
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'expired' THEN 1 ELSE 2 END,
                  expires_at ASC,
                  acquired_at ASC`,
      )
      .all(...values) as unknown as PortLeaseRow[];
    return rows.map(rowToPortLease);
  }

  expirePortLeases(nowIso = new Date().toISOString()): PortLeaseInfo[] {
    return this.withTransaction(() => this.expirePortLeasesInternal(nowIso));
  }

  private expirePortLeasesInternal(nowIso: string): PortLeaseInfo[] {
    const db = this.getDb();
    if (Number.isNaN(Date.parse(nowIso))) {
      throw new Error("nowIso must be a valid ISO timestamp");
    }

    const expiredRows = db
      .prepare(
        `SELECT * FROM port_leases
         WHERE status = 'active' AND expires_at <= ?
         ORDER BY expires_at ASC, acquired_at ASC`,
      )
      .all(nowIso) as unknown as PortLeaseRow[];
    if (expiredRows.length === 0) {
      return [];
    }

    const expire = db.prepare(
      `UPDATE port_leases
       SET status = 'expired', released_at = COALESCE(released_at, ?)
       WHERE id = ? AND status = 'active'`,
    );
    for (const row of expiredRows) {
      expire.run(nowIso, row.id);
    }

    const placeholders = expiredRows.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT * FROM port_leases WHERE id IN (${placeholders}) ORDER BY expires_at ASC`)
      .all(...expiredRows.map((row) => row.id)) as unknown as PortLeaseRow[];
    return rows.map(rowToPortLease);
  }

  private findAvailablePortLeasePort(
    host: string,
    minPort: number,
    maxPort: number,
  ): number | null {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT port FROM port_leases
         WHERE host = ? AND status = 'active' AND port BETWEEN ? AND ?
         ORDER BY port ASC`,
      )
      .all(host, minPort, maxPort) as Array<{ port: number }>;
    const activePorts = new Set(rows.map((row) => row.port));
    for (let port = minPort; port <= maxPort; port += 1) {
      if (!activePorts.has(port)) {
        return port;
      }
    }
    return null;
  }

  private getPortLeaseRowById(leaseId: string): PortLeaseRow | null {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM port_leases WHERE id = ?").get(leaseId) as
      | PortLeaseRow
      | undefined;
    return row ?? null;
  }

  touchAgent(id: string): void {
    const db = this.getDb();
    db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  heartbeatAgent(id: string): void {
    const db = this.getDb();
    db.prepare(
      "UPDATE agents SET last_heartbeat = ?, disconnected_at = NULL, resumable_until = NULL WHERE id = ?",
    ).run(new Date().toISOString(), id);
  }

  pruneStaleAgents(staleAfterMs: number): string[] {
    const db = this.getDb();
    const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
    const now = new Date().toISOString();

    return this.withTransaction(() => {
      const staleRows = db
        .prepare(
          `SELECT id FROM agents
           WHERE (disconnected_at IS NULL AND last_heartbeat <= ?)
              OR (disconnected_at IS NOT NULL AND resumable_until IS NOT NULL AND resumable_until <= ?)`,
        )
        .all(cutoff, now) as Array<{ id: string }>;

      if (staleRows.length === 0) {
        return [];
      }

      const disconnectAgent = db.prepare(
        "UPDATE agents SET disconnected_at = COALESCE(disconnected_at, ?), resumable_until = NULL WHERE id = ?",
      );
      const releaseClaims = db.prepare(
        "UPDATE threads SET owner_agent = NULL WHERE owner_agent = ?",
      );

      for (const row of staleRows) {
        this.requeueUndeliveredMessagesInternal(row.id, "agent_disconnected");
        disconnectAgent.run(now, row.id);
        releaseClaims.run(row.id);
      }

      return staleRows.map((row) => row.id);
    });
  }

  purgeDisconnectedAgents(graceMs = DEFAULT_DISCONNECTED_PURGE_GRACE_MS): string[] {
    const db = this.getDb();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const cutoff = new Date(now - graceMs).toISOString();

    return this.withTransaction(() => {
      const rows = db
        .prepare(
          `SELECT id FROM agents
           WHERE disconnected_at IS NOT NULL
             AND disconnected_at <= ?
             AND (resumable_until IS NULL OR resumable_until <= ?)`,
        )
        .all(cutoff, nowIso) as Array<{ id: string }>;

      if (rows.length === 0) {
        return [];
      }

      const releaseThreads = db.prepare(
        "UPDATE threads SET owner_agent = NULL WHERE owner_agent = ?",
      );
      const deleteInbox = db.prepare("DELETE FROM inbox WHERE agent_id = ?");

      for (const row of rows) {
        // Requeue undelivered messages to the backlog
        this.requeueUndeliveredMessagesInternal(row.id, "agent_disconnected");
        // Release thread ownership for the purged agent
        releaseThreads.run(row.id);
        // Clean up all inbox entries (both delivered and undelivered) for the agent
        deleteInbox.run(row.id);
      }

      db.prepare(
        `DELETE FROM agents
         WHERE disconnected_at IS NOT NULL
           AND disconnected_at <= ?
           AND (resumable_until IS NULL OR resumable_until <= ?)`,
      ).run(cutoff, nowIso);

      return rows.map((row) => row.id);
    });
  }

  updateAgentStatus(id: string, status: "working" | "idle"): void {
    const db = this.getDb();
    const now = new Date().toISOString();
    if (status === "idle") {
      // Transitioning to idle: set idle_since, preserve last_activity
      db.prepare(
        `UPDATE agents
         SET status = ?, last_seen = ?,
             idle_since = COALESCE(CASE WHEN status = 'idle' THEN idle_since ELSE NULL END, ?)
         WHERE id = ?`,
      ).run(status, now, now, id);
    } else {
      // Transitioning to working: clear idle_since, update last_activity
      db.prepare(
        "UPDATE agents SET status = ?, last_seen = ?, idle_since = NULL, last_activity = ? WHERE id = ?",
      ).run(status, now, now, id);
    }
  }

  updateAgentIdentity(
    id: string,
    identity: { name: string; emoji: string; metadata?: Record<string, unknown> | null },
  ): AgentInfo | null {
    const db = this.getDb();
    const existing = this.getAgentRowById(id);
    if (!existing) return null;

    const finalName = this.ensureUniqueAgentName(identity.name, id);
    const finalEmoji = identity.emoji.trim() || existing.emoji;
    const metadata =
      identity.metadata ?? (existing.metadata ? JSON.parse(existing.metadata) : null);
    const metadataJson = metadata ? JSON.stringify(metadata) : null;

    db.prepare(
      `UPDATE agents
       SET name = ?, emoji = ?, metadata = ?, last_seen = ?
       WHERE id = ?`,
    ).run(finalName, finalEmoji, metadataJson, new Date().toISOString(), id);

    const updated = this.getAgentRowById(id);
    return updated ? rowToAgent(updated) : null;
  }

  touchAgentActivity(id: string): void {
    const db = this.getDb();
    db.prepare("UPDATE agents SET last_activity = ?, last_seen = ? WHERE id = ?").run(
      new Date().toISOString(),
      new Date().toISOString(),
      id,
    );
  }

  private ensureUniqueAgentName(name: string, agentId: string): string {
    const db = this.getDb();
    const baseName = name.trim() || "Agent";
    let candidate = baseName;
    let suffix = 2;

    while (true) {
      const row = db
        .prepare("SELECT id FROM agents WHERE lower(name) = lower(?) AND id != ? LIMIT 1")
        .get(candidate, agentId) as { id: string } | undefined;
      if (!row) {
        return candidate;
      }
      candidate = `${baseName} ${suffix}`;
      suffix += 1;
    }
  }

  private getAgentRowById(id: string): AgentRow | null {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row ?? null;
  }

  getAgentByStableId(stableId: string): AgentInfo | null {
    const row = this.getAgentRowByStableId(stableId);
    return row ? rowToAgent(row) : null;
  }

  findAgentNameConflict(
    name: string,
    id: string,
    stableId?: string,
  ): { id: string; stableId: string | null; name: string } | null {
    const db = this.getDb();
    const existing = stableId ? this.getAgentRowByStableId(stableId) : null;
    const existingById = this.getAgentRowById(existing?.id ?? id);
    const agentId = existing?.id ?? existingById?.id ?? id;
    const normalizedName = name.trim();
    if (!normalizedName) {
      return null;
    }

    const row = db
      .prepare(
        `SELECT id, stable_id, name
         FROM agents
         WHERE lower(name) = lower(?) AND id != ?
         LIMIT 1`,
      )
      .get(normalizedName, agentId) as
      | { id: string; stable_id: string | null; name: string }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      stableId: row.stable_id,
      name: row.name,
    };
  }

  private getAgentRowByStableId(stableId: string): AgentRow | null {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM agents WHERE stable_id = ?").get(stableId) as
      | AgentRow
      | undefined;
    return row ?? null;
  }

  // ─── Threads ─────────────────────────────────────────

  createThread(thread: ThreadInfo): ThreadInfo;
  createThread(
    threadId: string,
    source: string,
    channel: string,
    ownerAgent: string | null,
  ): ThreadInfo;
  createThread(
    threadOrId: ThreadInfo | string,
    source?: string,
    channel?: string,
    ownerAgent?: string | null,
  ): ThreadInfo {
    const db = this.getDb();
    const now = new Date().toISOString();

    const tId = typeof threadOrId === "string" ? threadOrId : threadOrId.threadId;
    const src = typeof threadOrId === "string" ? source! : threadOrId.source;
    const ch = typeof threadOrId === "string" ? channel! : threadOrId.channel;
    const owner = typeof threadOrId === "string" ? (ownerAgent ?? null) : threadOrId.ownerAgent;

    const ownerBinding = typeof threadOrId === "string" ? null : (threadOrId.ownerBinding ?? null);
    const metadata = typeof threadOrId === "string" ? null : (threadOrId.metadata ?? null);
    const serializedMetadata = metadata ? JSON.stringify(metadata) : null;

    db.prepare(
      `INSERT INTO threads (thread_id, source, channel, owner_agent, owner_binding, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(tId, src, ch, owner, ownerBinding, serializedMetadata, now, now);

    return {
      threadId: tId,
      source: src,
      channel: ch,
      ownerAgent: owner,
      ownerBinding,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateThread(threadId: string, updates: Partial<ThreadInfo>): void {
    const db = this.getDb();
    const now = new Date().toISOString();

    // Upsert: create the thread if it doesn't exist yet
    const existing = this.getThread(threadId);
    if (!existing) {
      db.prepare(
        `INSERT INTO threads (thread_id, source, channel, owner_agent, owner_binding, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        threadId,
        updates.source ?? "slack",
        updates.channel ?? "",
        updates.ownerAgent !== undefined ? updates.ownerAgent : null,
        updates.ownerBinding !== undefined ? updates.ownerBinding : null,
        updates.metadata !== undefined && updates.metadata !== null
          ? JSON.stringify(updates.metadata)
          : null,
        now,
        now,
      );
      return;
    }

    const sets: string[] = [];
    const values: (string | null)[] = [];

    if (updates.ownerAgent !== undefined) {
      sets.push("owner_agent = ?");
      values.push(updates.ownerAgent);
    }
    if (updates.channel !== undefined) {
      sets.push("channel = ?");
      values.push(updates.channel);
    }
    if (updates.source !== undefined) {
      sets.push("source = ?");
      values.push(updates.source);
    }
    if (updates.ownerBinding !== undefined) {
      sets.push("owner_binding = ?");
      values.push(updates.ownerBinding);
    }
    if (updates.metadata !== undefined) {
      sets.push("metadata = ?");
      values.push(updates.metadata === null ? null : JSON.stringify(updates.metadata));
    }

    sets.push("updated_at = ?");
    values.push(now);
    values.push(threadId);

    db.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE thread_id = ?`).run(...values);
  }

  transferThreadOwnership(
    threadId: string,
    ownerAgent: string,
  ): { reassignedInboxCount: number; updatedMessageCount: number } {
    const db = this.getDb();
    const now = new Date().toISOString();
    const thread = this.getThread(threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${threadId}`);
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE threads
         SET owner_agent = ?, owner_binding = 'explicit', updated_at = ?
         WHERE thread_id = ?`,
      ).run(ownerAgent, now, threadId);

      const rows = db
        .prepare(
          `SELECT i.id AS inbox_id,
                  i.agent_id AS agent_id,
                  i.message_id AS message_id,
                  m.metadata AS metadata
           FROM inbox i
           JOIN messages m ON m.id = i.message_id
           WHERE m.thread_id = ?
             AND m.source = 'slack'
             AND m.direction = 'inbound'
             AND i.read_at IS NULL`,
        )
        .all(threadId) as Array<{
        inbox_id: number;
        agent_id: string;
        message_id: number;
        metadata: string | null;
      }>;

      let reassignedInboxCount = 0;
      const updatedMessageIds = new Set<number>();
      const updateMessageMetadata = db.prepare("UPDATE messages SET metadata = ? WHERE id = ?");
      const findExistingInbox = db.prepare(
        "SELECT id FROM inbox WHERE agent_id = ? AND message_id = ?",
      );
      const reassignInbox = db.prepare(
        "UPDATE inbox SET agent_id = ?, delivered = 0 WHERE id = ? AND agent_id = ?",
      );
      const markDuplicateRead = db.prepare(
        "UPDATE inbox SET delivered = 1, read_at = COALESCE(read_at, ?) WHERE id = ?",
      );

      for (const row of rows) {
        if (!updatedMessageIds.has(row.message_id)) {
          const metadata = row.metadata ? parseJsonMetadata(row.metadata) : {};
          metadata.threadAffinityOwnerAgentId = ownerAgent;
          updateMessageMetadata.run(JSON.stringify(metadata), row.message_id);
          updatedMessageIds.add(row.message_id);
        }

        if (row.agent_id === ownerAgent) {
          continue;
        }

        const existing = findExistingInbox.get(ownerAgent, row.message_id) as
          | { id: number }
          | undefined;
        if (existing) {
          markDuplicateRead.run(now, row.inbox_id);
          continue;
        }

        const result = reassignInbox.run(ownerAgent, row.inbox_id, row.agent_id);
        reassignedInboxCount += Number(result.changes ?? 0);
      }

      db.exec("COMMIT");
      return { reassignedInboxCount, updatedMessageCount: updatedMessageIds.size };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  claimThread(threadId: string, agentId: string, source = "slack", channel = ""): boolean {
    const db = this.getDb();
    const now = new Date().toISOString();

    // Atomic claim: insert the thread if new, or update the owner only
    // if the thread is currently unclaimed or already owned by this agent.
    // A single statement avoids the TOCTOU race of read-then-write. (#125)
    db.prepare(
      `INSERT INTO threads (thread_id, source, channel, owner_agent, owner_binding, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         owner_agent = excluded.owner_agent,
         updated_at = excluded.updated_at
       WHERE threads.owner_agent IS NULL OR threads.owner_agent = excluded.owner_agent`,
    ).run(threadId, source, channel, agentId, null, null, now, now);

    // Verify: read back the owner.  If the WHERE clause above didn't
    // match (another agent owns the thread), the row was not updated
    // and the owner will differ from agentId.
    const thread = this.getThread(threadId);
    return thread?.ownerAgent === agentId;
  }

  setAllowedUsers(users: Iterable<string> | null): void {
    this.allowedUsers = users === null ? null : new Set(users);
  }

  getAllowedUsers(): Set<string> | null {
    return this.allowedUsers === null ? null : new Set(this.allowedUsers);
  }

  getChannelAssignment(_channel: string): ChannelAssignment | null {
    return null;
  }

  getThread(threadId: string): ThreadInfo | null {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId) as unknown as
      | ThreadRow
      | undefined;
    return row ? rowToThread(row) : null;
  }

  getThreads(ownerAgent?: string): ThreadInfo[] {
    const db = this.getDb();
    if (ownerAgent) {
      const rows = db
        .prepare("SELECT * FROM threads WHERE owner_agent = ? ORDER BY updated_at DESC")
        .all(ownerAgent) as unknown as ThreadRow[];
      return rows.map(rowToThread);
    }
    const rows = db
      .prepare("SELECT * FROM threads ORDER BY updated_at DESC")
      .all() as unknown as ThreadRow[];
    return rows.map(rowToThread);
  }

  getPendingBacklog(limit = 50): BacklogEntry[] {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT * FROM unrouted_backlog
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit) as unknown as BacklogRow[];
    return rows.map(rowToBacklog);
  }

  getBacklogCount(status: BacklogEntry["status"] = "pending"): number {
    const db = this.getDb();
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM unrouted_backlog WHERE status = ?")
      .get(status) as { count: number };
    return row.count;
  }

  queueUnroutedMessage(message: InboundMessage, reason = "no_route"): BacklogEntry {
    const metadata = this.withInboundMailClassMetadata(message, {
      ...message.metadata,
      channel: message.channel,
      userName: message.userName,
      userId: message.userId,
      timestamp: message.timestamp,
      ...(message.isChannelMention ? { isChannelMention: true } : {}),
    });

    const existingThread = this.getThread(message.threadId);
    if (!existingThread) {
      this.createThread(message.threadId, message.source, message.channel, null);
    }

    const brokerMessage = this.insertMessage(
      message.threadId,
      message.source,
      "inbound",
      message.userId,
      message.text,
      [],
      metadata,
    );

    const existingBacklog = this.getBacklogByMessageId(brokerMessage.id);
    if (existingBacklog) {
      return existingBacklog;
    }

    if (existingThread) {
      this.updateThread(message.threadId, {
        channel: message.channel,
        source: message.source,
        ownerAgent: null,
      });
    }

    return this.upsertBacklogEntry(
      brokerMessage.id,
      message.threadId,
      message.channel,
      reason,
      "pending",
      null,
      null,
    );
  }

  assignBacklogEntry(id: number, agentId: string): BacklogEntry | null {
    const db = this.getDb();

    return this.withTransaction(() => {
      const row = db
        .prepare("SELECT * FROM unrouted_backlog WHERE id = ? AND status = 'pending'")
        .get(id) as BacklogRow | undefined;
      if (!row) return null;

      const now = new Date().toISOString();
      const message = db
        .prepare("SELECT source, direction, metadata FROM messages WHERE id = ?")
        .get(row.message_id) as
        | { source: string; direction: string; metadata: string | null }
        | undefined;
      if (message?.source === "slack" && message.direction === "inbound") {
        let metadata: Record<string, unknown> = {};
        if (message.metadata) {
          try {
            metadata = JSON.parse(message.metadata) as Record<string, unknown>;
          } catch {
            metadata = {};
          }
        }
        metadata.threadAffinityOwnerAgentId = agentId;
        db.prepare("UPDATE messages SET metadata = ? WHERE id = ?").run(
          JSON.stringify(metadata),
          row.message_id,
        );
      }

      db.prepare(
        `INSERT OR IGNORE INTO inbox (agent_id, message_id, delivered, created_at)
         VALUES (?, ?, 0, ?)`,
      ).run(agentId, row.message_id, now);

      db.prepare(
        `UPDATE unrouted_backlog
         SET status = 'assigned',
             assigned_agent_id = ?,
             attempt_count = attempt_count + 1,
             last_attempt_at = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(agentId, now, now, id);

      this.updateThread(row.thread_id, { ownerAgent: agentId, channel: row.channel });

      return this.getBacklogById(id);
    });
  }

  recoverPendingTargetedBacklog(agentId: string): number {
    const agent = this.getAgentRowById(agentId);
    if (!agent || agent.disconnected_at) {
      return 0;
    }

    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT id
           FROM unrouted_backlog
          WHERE status = 'pending'
            AND preferred_agent_id = ?
          ORDER BY created_at ASC`,
      )
      .all(agentId) as Array<{ id: number }>;

    let recoveredCount = 0;
    for (const row of rows) {
      if (this.assignBacklogEntry(row.id, agentId)) {
        recoveredCount += 1;
      }
    }

    return recoveredCount;
  }

  dropBacklogEntry(id: number, reason: string): BacklogEntry | null {
    const db = this.getDb();
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE unrouted_backlog
         SET status = 'dropped',
             reason = ?,
             assigned_agent_id = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'pending'`,
      )
      .run(reason, now, id);

    if (Number(result.changes ?? 0) === 0) {
      return null;
    }

    return this.getBacklogById(id);
  }

  repairOrphanedAssignedBacklog(): { resetToPendingCount: number; droppedCount: number } {
    const db = this.getDb();

    return this.withTransaction(() => {
      const rows = db
        .prepare(
          `SELECT id, message_id, preferred_agent_id, assigned_agent_id
           FROM unrouted_backlog
           WHERE status = 'assigned'
             AND (
               (
                 preferred_agent_id IS NOT NULL
                 AND (
                   assigned_agent_id IS NULL
                   OR assigned_agent_id NOT IN (SELECT id FROM agents)
                   OR NOT EXISTS (
                     SELECT 1
                     FROM inbox
                     WHERE inbox.message_id = unrouted_backlog.message_id
                       AND inbox.agent_id = unrouted_backlog.assigned_agent_id
                   )
                 )
               )
               OR (
                 preferred_agent_id IS NULL
                 AND (
                   assigned_agent_id IS NULL
                   OR assigned_agent_id NOT IN (SELECT id FROM agents)
                 )
               )
             )`,
        )
        .all() as Array<{
        id: number;
        message_id: number;
        preferred_agent_id: string | null;
        assigned_agent_id: string | null;
      }>;

      if (rows.length === 0) {
        return { resetToPendingCount: 0, droppedCount: 0 };
      }

      const now = new Date().toISOString();
      const clearStaleInbox = db.prepare(
        `DELETE FROM inbox
         WHERE message_id = ?
           AND agent_id = ?`,
      );
      const resetPending = db.prepare(
        `UPDATE unrouted_backlog
         SET status = 'pending',
             assigned_agent_id = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'assigned'`,
      );
      const dropAssigned = db.prepare(
        `UPDATE unrouted_backlog
         SET status = 'dropped',
             reason = 'preferred_agent_missing',
             assigned_agent_id = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'assigned'`,
      );

      let resetToPendingCount = 0;
      let droppedCount = 0;

      for (const row of rows) {
        if (row.assigned_agent_id) {
          clearStaleInbox.run(row.message_id, row.assigned_agent_id);
        }

        if (!row.preferred_agent_id) {
          resetToPendingCount += Number(resetPending.run(now, row.id).changes ?? 0);
          continue;
        }

        if (this.getAgentRowById(row.preferred_agent_id)) {
          resetToPendingCount += Number(resetPending.run(now, row.id).changes ?? 0);
          continue;
        }

        droppedCount += Number(dropAssigned.run(now, row.id).changes ?? 0);
      }

      return { resetToPendingCount, droppedCount };
    });
  }

  requeueUndeliveredMessages(agentId: string, reason = "agent_disconnected"): number {
    return this.withTransaction(() => this.requeueUndeliveredMessagesInternal(agentId, reason));
  }

  getPendingInboxCount(agentId: string): number {
    return this.withTransaction(() => {
      this.dropStaleSlackInboxRows(agentId);
      const db = this.getDb();
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM inbox WHERE agent_id = ? AND delivered = 0")
        .get(agentId) as { count: number };
      return row.count;
    });
  }

  getOwnedThreadCount(agentId: string): number {
    const db = this.getDb();
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM threads WHERE owner_agent = ?")
      .get(agentId) as { count: number };
    return row.count;
  }

  releaseThreadClaims(agentId: string): number {
    const db = this.getDb();
    const result = db
      .prepare("UPDATE threads SET owner_agent = NULL WHERE owner_agent = ?")
      .run(agentId);
    return Number(result.changes ?? 0);
  }

  // ─── Task assignments ───────────────────────────────

  recordTaskAssignment(
    agentId: string,
    issueNumber: number,
    branch: string | null,
    threadId: string,
    sourceMessageId: number | null,
  ): TaskAssignmentInfo {
    const db = this.getDb();
    const now = new Date().toISOString();
    const existing = db
      .prepare("SELECT * FROM task_assignments WHERE issue_number = ?")
      .get(issueNumber) as TaskAssignmentRow | undefined;

    if (!existing) {
      const info = db
        .prepare(
          `INSERT INTO task_assignments (
             agent_id, issue_number, branch, pr_number, status,
             thread_id, source_message_id, created_at, updated_at
           ) VALUES (?, ?, ?, NULL, 'assigned', ?, ?, ?, ?)`,
        )
        .run(agentId, issueNumber, branch, threadId, sourceMessageId, now, now);

      const row = db
        .prepare("SELECT * FROM task_assignments WHERE id = ?")
        .get(Number(info.lastInsertRowid)) as TaskAssignmentRow | undefined;
      if (!row) {
        throw new Error(`Failed to create task assignment for ${agentId}#${issueNumber}`);
      }
      return rowToTaskAssignment(row);
    }

    const isReassignment = existing.agent_id !== agentId;
    const nextBranch = isReassignment ? branch : (branch ?? existing.branch);
    const shouldResetProgress = isReassignment || nextBranch !== existing.branch;
    db.prepare(
      `UPDATE task_assignments
       SET agent_id = ?,
           branch = ?,
           pr_number = CASE WHEN ? THEN NULL ELSE pr_number END,
           status = CASE WHEN ? THEN 'assigned' ELSE status END,
           thread_id = ?,
           source_message_id = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      agentId,
      nextBranch,
      shouldResetProgress ? 1 : 0,
      shouldResetProgress ? 1 : 0,
      threadId,
      sourceMessageId,
      now,
      existing.id,
    );

    const row = db.prepare("SELECT * FROM task_assignments WHERE id = ?").get(existing.id) as
      | TaskAssignmentRow
      | undefined;
    if (!row) {
      throw new Error(`Failed to update task assignment for ${agentId}#${issueNumber}`);
    }
    return rowToTaskAssignment(row);
  }

  listTaskAssignments(): TaskAssignmentInfo[] {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT * FROM task_assignments
         ORDER BY updated_at DESC, created_at DESC, id DESC`,
      )
      .all() as unknown as TaskAssignmentRow[];
    return rows.map(rowToTaskAssignment);
  }

  listTaskAssignmentsAwaitingFirstReply(): TaskAssignmentAwaitingReplyInfo[] {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT
           ta.id AS id,
           ta.agent_id AS agent_id,
           ta.issue_number AS issue_number,
           ta.status AS status,
           ta.source_message_id AS source_message_id,
           source.sender AS original_sender_agent_id
         FROM task_assignments ta
         JOIN messages source ON source.id = ta.source_message_id
         WHERE ta.source_message_id IS NOT NULL
           AND ta.status IN ('assigned', 'branch_pushed', 'pr_open')
           AND source.source = 'agent'
           AND source.direction = 'inbound'
           AND source.sender != ta.agent_id
           AND NOT EXISTS (
             SELECT 1
             FROM messages reply
             JOIN inbox reply_inbox ON reply_inbox.message_id = reply.id
             WHERE reply.source = 'agent'
               AND reply.direction = 'inbound'
               AND reply.sender = ta.agent_id
               AND reply.id > source.id
               AND reply_inbox.agent_id = source.sender
           )
         ORDER BY ta.updated_at DESC, ta.created_at DESC, ta.id DESC`,
      )
      .all() as Array<{
      id: number;
      agent_id: string;
      issue_number: number;
      status: string;
      source_message_id: number;
      original_sender_agent_id: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      issueNumber: row.issue_number,
      status: row.status as TaskAssignmentStatus,
      sourceMessageId: row.source_message_id,
      originalSenderAgentId: row.original_sender_agent_id,
    }));
  }

  updateTaskAssignmentProgress(
    id: number,
    status: TaskAssignmentStatus,
    prNumber: number | null,
  ): void {
    const db = this.getDb();
    db.prepare(
      `UPDATE task_assignments
       SET status = ?,
           pr_number = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(status, prNumber, new Date().toISOString(), id);
  }

  // ─── Pinet lane metadata ─────────────────────────────

  upsertPinetLane(input: PinetLaneUpsertInput): PinetLaneInfo {
    const db = this.getDb();
    const laneId = normalizeLaneId(input.laneId);
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT * FROM pinet_lanes WHERE lane_id = ?").get(laneId) as
      | PinetLaneRow
      | undefined;
    const nextState =
      input.state === undefined
        ? existing
          ? rowToPinetLane(existing).state
          : "active"
        : requirePinetLaneState(input.state);

    if (!existing) {
      db.prepare(
        `INSERT INTO pinet_lanes (
           lane_id, name, task, issue_number, pr_number, thread_id,
           owner_agent_id, implementation_lead_agent_id, pm_mode, state,
           summary, metadata, created_at, updated_at, last_activity_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        laneId,
        normalizeOptionalText(input.name) ?? null,
        normalizeOptionalText(input.task) ?? null,
        normalizeOptionalInteger(input.issueNumber) ?? null,
        normalizeOptionalInteger(input.prNumber) ?? null,
        normalizeOptionalText(input.threadId) ?? null,
        normalizeOptionalText(input.ownerAgentId) ?? null,
        normalizeOptionalText(input.implementationLeadAgentId) ?? null,
        input.pmMode === true ? 1 : 0,
        nextState,
        normalizeOptionalText(input.summary) ?? null,
        serializeOptionalMetadata(input.metadata) ?? null,
        now,
        now,
        now,
      );
      return this.getPinetLane(laneId)!;
    }

    db.prepare(
      `UPDATE pinet_lanes
       SET name = ?,
           task = ?,
           issue_number = ?,
           pr_number = ?,
           thread_id = ?,
           owner_agent_id = ?,
           implementation_lead_agent_id = ?,
           pm_mode = ?,
           state = ?,
           summary = ?,
           metadata = ?,
           updated_at = ?,
           last_activity_at = ?
       WHERE lane_id = ?`,
    ).run(
      input.name === undefined ? existing.name : (normalizeOptionalText(input.name) ?? null),
      input.task === undefined ? existing.task : (normalizeOptionalText(input.task) ?? null),
      input.issueNumber === undefined
        ? existing.issue_number
        : (normalizeOptionalInteger(input.issueNumber) ?? null),
      input.prNumber === undefined
        ? existing.pr_number
        : (normalizeOptionalInteger(input.prNumber) ?? null),
      input.threadId === undefined
        ? existing.thread_id
        : (normalizeOptionalText(input.threadId) ?? null),
      input.ownerAgentId === undefined
        ? existing.owner_agent_id
        : (normalizeOptionalText(input.ownerAgentId) ?? null),
      input.implementationLeadAgentId === undefined
        ? existing.implementation_lead_agent_id
        : (normalizeOptionalText(input.implementationLeadAgentId) ?? null),
      input.pmMode === undefined ? existing.pm_mode : input.pmMode ? 1 : 0,
      nextState,
      input.summary === undefined
        ? existing.summary
        : (normalizeOptionalText(input.summary) ?? null),
      input.metadata === undefined
        ? existing.metadata
        : (serializeOptionalMetadata(input.metadata) ?? null),
      now,
      now,
      laneId,
    );

    return this.getPinetLane(laneId)!;
  }

  setPinetLaneParticipant(input: PinetLaneParticipantUpsertInput): PinetLaneParticipantInfo {
    const db = this.getDb();
    const laneId = normalizeLaneId(input.laneId);
    const agentId = normalizeLaneId(input.agentId);
    const role = requirePinetLaneRole(input.role);
    if (!this.getPinetLane(laneId)) {
      throw new Error(`Pinet lane not found: ${laneId}`);
    }

    const now = new Date().toISOString();
    const existing = db
      .prepare("SELECT * FROM pinet_lane_participants WHERE lane_id = ? AND agent_id = ?")
      .get(laneId, agentId) as PinetLaneParticipantRow | undefined;

    if (!existing) {
      db.prepare(
        `INSERT INTO pinet_lane_participants (
           lane_id, agent_id, lane_role, status, summary, metadata,
           created_at, updated_at, last_activity_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        laneId,
        agentId,
        role,
        normalizeOptionalText(input.status) ?? null,
        normalizeOptionalText(input.summary) ?? null,
        serializeOptionalMetadata(input.metadata) ?? null,
        now,
        now,
        now,
      );
    } else {
      db.prepare(
        `UPDATE pinet_lane_participants
         SET lane_role = ?,
             status = ?,
             summary = ?,
             metadata = ?,
             updated_at = ?,
             last_activity_at = ?
         WHERE lane_id = ? AND agent_id = ?`,
      ).run(
        role,
        input.status === undefined
          ? existing.status
          : (normalizeOptionalText(input.status) ?? null),
        input.summary === undefined
          ? existing.summary
          : (normalizeOptionalText(input.summary) ?? null),
        input.metadata === undefined
          ? existing.metadata
          : (serializeOptionalMetadata(input.metadata) ?? null),
        now,
        now,
        laneId,
        agentId,
      );
    }

    db.prepare(
      `UPDATE pinet_lanes
       SET updated_at = ?, last_activity_at = ?
       WHERE lane_id = ?`,
    ).run(now, now, laneId);

    const row = db
      .prepare("SELECT * FROM pinet_lane_participants WHERE lane_id = ? AND agent_id = ?")
      .get(laneId, agentId) as PinetLaneParticipantRow | undefined;
    if (!row) {
      throw new Error(`Failed to update Pinet lane participant ${agentId} for ${laneId}`);
    }
    return rowToPinetLaneParticipant(row);
  }

  getPinetLane(laneId: string): PinetLaneInfo | null {
    const db = this.getDb();
    const canonicalLaneId = normalizeLaneId(laneId);
    const row = db.prepare("SELECT * FROM pinet_lanes WHERE lane_id = ?").get(canonicalLaneId) as
      | PinetLaneRow
      | undefined;
    if (!row) return null;
    const participantRows = db
      .prepare("SELECT * FROM pinet_lane_participants WHERE lane_id = ? ORDER BY updated_at DESC")
      .all(canonicalLaneId) as unknown as PinetLaneParticipantRow[];
    return rowToPinetLane(row, participantRows.map(rowToPinetLaneParticipant));
  }

  listPinetLanes(options: PinetLaneListOptions = {}): PinetLaneInfo[] {
    const db = this.getDb();
    const clauses: string[] = [];
    const values: string[] = [];
    if (options.state) {
      clauses.push("state = ?");
      values.push(requirePinetLaneState(options.state));
    } else if (!options.includeDone) {
      clauses.push("state NOT IN ('done', 'cancelled', 'detached')");
    }
    const ownerAgentId = normalizeOptionalText(options.ownerAgentId);
    if (ownerAgentId) {
      clauses.push("owner_agent_id = ?");
      values.push(ownerAgentId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT * FROM pinet_lanes ${where} ORDER BY updated_at DESC, created_at DESC`)
      .all(...values) as unknown as PinetLaneRow[];
    return rows.map((row) => this.getPinetLane(row.lane_id)!);
  }

  // ─── Scheduled wake-ups ──────────────────────────────

  scheduleWakeup(
    agentId: string,
    body: string,
    fireAt: string,
    threadId = `wakeup:${agentId}`,
  ): ScheduledWakeupInfo {
    const db = this.getDb();
    const createdAt = new Date().toISOString();
    const canonicalFireAt = new Date(fireAt).toISOString();
    const agentStableId = this.getAgentRowById(agentId)?.stable_id ?? null;

    const info = db
      .prepare(
        `INSERT INTO scheduled_wakeups (
           agent_id,
           agent_stable_id,
           thread_id,
           body,
           fire_at,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(agentId, agentStableId, threadId, body, canonicalFireAt, createdAt);

    const row = db
      .prepare("SELECT * FROM scheduled_wakeups WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as ScheduledWakeupRow | undefined;
    if (!row) {
      throw new Error(`Failed to create scheduled wake-up for ${agentId}`);
    }
    return rowToScheduledWakeup(row);
  }

  listScheduledWakeups(agentId?: string): ScheduledWakeupInfo[] {
    const db = this.getDb();
    const agentStableId = agentId ? (this.getAgentRowById(agentId)?.stable_id ?? null) : null;
    const rows = (agentId
      ? agentStableId
        ? db
            .prepare(
              `SELECT * FROM scheduled_wakeups
               WHERE agent_stable_id = ?
                  OR (agent_stable_id IS NULL AND agent_id = ?)
               ORDER BY fire_at ASC, id ASC`,
            )
            .all(agentStableId, agentId)
        : db
            .prepare(
              `SELECT * FROM scheduled_wakeups
               WHERE agent_id = ?
               ORDER BY fire_at ASC, id ASC`,
            )
            .all(agentId)
      : db
          .prepare(
            `SELECT * FROM scheduled_wakeups
             ORDER BY fire_at ASC, id ASC`,
          )
          .all()) as unknown as ScheduledWakeupRow[];
    return rows.map(rowToScheduledWakeup);
  }

  deliverDueScheduledWakeups(
    now = new Date().toISOString(),
    limit = 50,
  ): ScheduledWakeupDelivery[] {
    const db = this.getDb();

    return this.withTransaction(() => {
      const rows = db
        .prepare(
          `SELECT
             sw.*,
             COALESCE(stable_agent.id, direct_agent.id) AS target_agent_id
           FROM scheduled_wakeups sw
           LEFT JOIN agents stable_agent
             ON sw.agent_stable_id IS NOT NULL
            AND stable_agent.stable_id = sw.agent_stable_id
            AND stable_agent.disconnected_at IS NULL
           LEFT JOIN agents direct_agent
             ON sw.agent_stable_id IS NULL
            AND direct_agent.id = sw.agent_id
            AND direct_agent.disconnected_at IS NULL
           WHERE sw.fire_at <= ?
             AND COALESCE(stable_agent.id, direct_agent.id) IS NOT NULL
           ORDER BY sw.fire_at ASC, sw.id ASC
           LIMIT ?`,
        )
        .all(now, limit) as unknown as Array<ScheduledWakeupRow & { target_agent_id: string }>;

      if (rows.length === 0) {
        return [];
      }

      const deleteWakeup = db.prepare("DELETE FROM scheduled_wakeups WHERE id = ?");
      const deliveries: ScheduledWakeupDelivery[] = [];

      for (const row of rows) {
        const targetAgentId = row.target_agent_id;

        if (!this.getThread(row.thread_id)) {
          this.createThread(row.thread_id, "agent", "", targetAgentId);
        } else {
          this.updateThread(row.thread_id, { ownerAgent: targetAgentId });
        }

        const message = this.insertMessage(
          row.thread_id,
          "agent",
          "inbound",
          "scheduler",
          row.body,
          [targetAgentId],
          {
            senderAgent: "Pinet Scheduler",
            scheduledWakeup: true,
            a2a: true,
            pinetMailClass: "fwup",
            wakeupId: row.id,
            fireAt: row.fire_at,
          },
        );
        deleteWakeup.run(row.id);
        deliveries.push({ wakeup: rowToScheduledWakeup(row), message });
      }

      return deliveries;
    });
  }

  repairThreadOwnership(): { releasedClaimCount: number; releasedAgentIds: string[] } {
    const db = this.getDb();

    return this.withTransaction(() => {
      const rows = db
        .prepare(
          `SELECT owner_agent, COUNT(*) AS claim_count
           FROM threads
           WHERE owner_agent IS NOT NULL
             AND owner_agent NOT IN (
               SELECT id FROM agents WHERE disconnected_at IS NULL
             )
           GROUP BY owner_agent`,
        )
        .all() as Array<{ owner_agent: string; claim_count: number }>;

      if (rows.length === 0) {
        return { releasedClaimCount: 0, releasedAgentIds: [] };
      }

      db.prepare(
        `UPDATE threads
         SET owner_agent = NULL
         WHERE owner_agent IS NOT NULL
           AND owner_agent NOT IN (
             SELECT id FROM agents WHERE disconnected_at IS NULL
           )`,
      ).run();

      return {
        releasedClaimCount: rows.reduce((count, row) => count + Number(row.claim_count), 0),
        releasedAgentIds: rows.map((row) => row.owner_agent),
      };
    });
  }

  // ─── Messages + Inbox ────────────────────────────────

  // ─── Interface-compatible queueMessage (single agent) ──

  queueMessage(agentId: string, message: InboundMessage): void {
    this.withTransaction(() => {
      this.insertMessage(
        message.threadId,
        message.source,
        "inbound",
        message.userId,
        message.text,
        [agentId],
        this.buildInboundMessageMetadata(message),
      );
      this.reclassifyReferencedMessageFromReaction(message);
    });
  }

  queueDeliveredMessage(agentId: string, message: InboundMessage): DeliveredInboundMessageResult {
    return this.withTransaction(() => {
      const db = this.getDb();
      const brokerMessage = this.insertMessage(
        message.threadId,
        message.source,
        "inbound",
        message.userId,
        message.text,
        [],
        this.buildInboundMessageMetadata(message),
      );
      this.reclassifyReferencedMessageFromReaction(message);

      const existing = db
        .prepare(
          "SELECT id FROM inbox WHERE agent_id = ? AND message_id = ? ORDER BY id ASC LIMIT 1",
        )
        .get(agentId, brokerMessage.id) as { id: number } | undefined;
      if (existing) {
        db.prepare("UPDATE inbox SET delivered = 1 WHERE id = ? AND agent_id = ?").run(
          existing.id,
          agentId,
        );
        const entry = this.getInboxEntryById(existing.id, agentId);
        if (!entry) {
          throw new Error("Failed to read delivered inbox entry");
        }
        return { entry, message: brokerMessage, freshDelivery: false };
      }

      const now = new Date().toISOString();
      const result = db
        .prepare(
          `INSERT INTO inbox (agent_id, message_id, delivered, created_at)
           VALUES (?, ?, 1, ?)`,
        )
        .run(agentId, brokerMessage.id, now);
      const inboxId = Number(result.lastInsertRowid);
      return {
        entry: {
          id: inboxId,
          agentId,
          messageId: brokerMessage.id,
          delivered: true,
          readAt: null,
          createdAt: now,
        },
        message: brokerMessage,
        freshDelivery: true,
      };
    });
  }

  private buildInboundMessageMetadata(message: InboundMessage): Record<string, unknown> {
    const threadOwner =
      message.source === "slack" && message.threadId
        ? this.getThread(message.threadId)?.ownerAgent
        : null;
    return this.withInboundMailClassMetadata(message, {
      ...message.metadata,
      channel: message.channel,
      userName: message.userName,
      userId: message.userId,
      timestamp: message.timestamp,
      ...(threadOwner ? { threadAffinityOwnerAgentId: threadOwner } : {}),
      ...(message.isChannelMention ? { isChannelMention: true } : {}),
      ...(message.scope ? { scope: message.scope } : {}),
    });
  }

  private withInboundMailClassMetadata(
    message: InboundMessage,
    metadata: Record<string, unknown>,
  ): Record<string, unknown> {
    if (message.source !== "slack") {
      return metadata;
    }

    const classification = classifyPinetMail({
      source: message.source,
      threadId: message.threadId,
      sender: message.userId,
      body: message.text,
      metadata,
    });
    if (classification.explicit) {
      return metadata;
    }

    return {
      ...metadata,
      pinetMailClass: classification.class,
    };
  }

  private reclassifyReferencedMessageFromReaction(message: InboundMessage): void {
    const metadata = message.metadata;
    if (!metadata) return;

    const reactionName = getStringMetadataValue(metadata, ["reactionName", "reaction_name"]);
    if (!isArrowUpReactionName(reactionName)) return;

    const referencedSource =
      getStringMetadataValue(metadata, ["referencedSource", "referenced_source"]) ?? message.source;
    const referencedExternalId = getStringMetadataValue(metadata, [
      "referencedExternalId",
      "referenced_external_id",
    ]);
    const referencedChannel = getStringMetadataValue(metadata, [
      "referencedChannel",
      "referenced_channel",
    ]);
    const referencedMessageTs = getStringMetadataValue(metadata, [
      "referencedMessageTs",
      "referenced_message_ts",
      "messageTs",
      "message_ts",
    ]);
    const externalId =
      referencedExternalId ??
      (referencedSource === "slack" && referencedChannel && referencedMessageTs
        ? `${referencedChannel}:${referencedMessageTs}`
        : null);
    if (!externalId) return;

    this.reclassifyMessageByExternalId(referencedSource, externalId, "steering", {
      reason: "slack_reaction_arrow_up",
      reactionName,
      reactorUserId: getStringMetadataValue(metadata, ["reactorUserId", "reactor_user_id"]),
      reactorName: getStringMetadataValue(metadata, ["reactorName", "reactor_name"]),
      reactionEventTs: getStringMetadataValue(metadata, ["reactionEventTs", "reaction_event_ts"]),
      referencedThreadId: message.threadId,
      referencedMessageTs,
    });
  }

  reclassifyMessageByExternalId(
    source: string,
    externalId: string,
    mailClass: PinetMailClass,
    audit: Record<string, unknown>,
  ): BrokerMessage | null {
    const db = this.getDb();
    const row = db
      .prepare("SELECT id, metadata FROM messages WHERE source = ? AND external_id = ?")
      .get(source, externalId) as { id: number; metadata: string | null } | undefined;
    if (!row) return null;

    const metadata = parseJsonMetadata(row.metadata);
    metadata.pinetMailClass = mailClass;
    metadata.pinet_mail_class = mailClass;
    metadata.pinet_mail_class_reason = audit.reason ?? "manual_reclassification";
    appendMetadataAudit(metadata, "pinet_mail_class_audit", {
      ...audit,
      class: mailClass,
      at: new Date().toISOString(),
    });

    db.prepare("UPDATE messages SET metadata = ? WHERE id = ?").run(
      JSON.stringify(metadata),
      row.id,
    );
    return this.getMessageById(row.id);
  }

  private getInboxEntryById(id: number, agentId: string): InboxEntry | null {
    const row = this.getDb()
      .prepare(
        "SELECT id, agent_id, message_id, delivered, read_at, created_at FROM inbox WHERE id = ? AND agent_id = ?",
      )
      .get(id, agentId) as
      | {
          id: number;
          agent_id: string;
          message_id: number;
          delivered: number;
          read_at: string | null;
          created_at: string;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          agentId: row.agent_id,
          messageId: row.message_id,
          delivered: row.delivered === 1,
          readAt: row.read_at,
          createdAt: row.created_at,
        }
      : null;
  }

  // ─── Detailed message insert (used by socket server) ──

  insertMessage(
    threadId: string,
    source: string,
    direction: "inbound" | "outbound",
    sender: string,
    body: string,
    targetAgentIds: string[],
    metadata?: Record<string, unknown>,
  ): BrokerMessage {
    const db = this.getDb();
    const now = new Date().toISOString();
    const metaJson = metadata ? JSON.stringify(metadata) : null;
    const identity = deriveMessageSyncIdentity(source, metadata);

    const info = db
      .prepare(
        `INSERT OR IGNORE INTO messages (
           thread_id,
           source,
           direction,
           sender,
           body,
           metadata,
           external_id,
           external_ts,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        source,
        direction,
        sender,
        body,
        metaJson,
        identity.externalId,
        identity.externalTs,
        now,
      );

    const insertedMessageId = Number(info.lastInsertRowid);
    const messageId =
      Number(info.changes ?? 0) > 0
        ? insertedMessageId
        : this.getExistingMessageIdForIdentity(source, identity.externalId);
    if (messageId == null) {
      throw new Error("Failed to persist broker message");
    }

    const insertInbox = db.prepare(
      `INSERT INTO inbox (agent_id, message_id, delivered, created_at)
       SELECT ?, ?, 0, ?
       WHERE NOT EXISTS (
         SELECT 1
         FROM inbox
         WHERE agent_id = ?
           AND message_id = ?
       )`,
    );

    for (const agentId of targetAgentIds) {
      insertInbox.run(agentId, messageId, now, agentId, messageId);
    }

    // Update thread timestamp
    db.prepare("UPDATE threads SET updated_at = ? WHERE thread_id = ?").run(now, threadId);

    return (
      this.getMessageById(messageId) ?? {
        id: messageId,
        threadId,
        source,
        direction,
        sender,
        body,
        metadata: metadata ?? null,
        ...(identity.externalId ? { externalId: identity.externalId } : {}),
        ...(identity.externalTs ? { externalTs: identity.externalTs } : {}),
        createdAt: now,
      }
    );
  }

  private getExistingMessageIdForIdentity(
    source: string,
    externalId: string | null,
  ): number | null {
    if (!externalId) {
      return null;
    }
    const row = this.getDb()
      .prepare("SELECT id FROM messages WHERE source = ? AND external_id = ?")
      .get(source, externalId) as { id?: number } | undefined;
    return typeof row?.id === "number" ? row.id : null;
  }

  private getMessageById(messageId: number): BrokerMessage | null {
    const row = this.getDb()
      .prepare(
        `SELECT id, thread_id, source, direction, sender, body, metadata, external_id, external_ts, created_at
         FROM messages
         WHERE id = ?`,
      )
      .get(messageId) as
      | {
          id: number;
          thread_id: string;
          source: string;
          direction: string;
          sender: string;
          body: string;
          metadata: string | null;
          external_id: string | null;
          external_ts: string | null;
          created_at: string;
        }
      | undefined;
    return row ? rowToBrokerMessage(row) : null;
  }

  private dropStaleSlackInboxRows(agentId: string): number {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT i.id AS inbox_id,
                i.agent_id AS agent_id,
                m.metadata AS metadata,
                t.owner_agent AS owner_agent
         FROM inbox i
         JOIN messages m ON m.id = i.message_id
         JOIN threads t ON t.thread_id = m.thread_id
         WHERE i.agent_id = ?
           AND (i.delivered = 0 OR i.read_at IS NULL)
           AND m.source = 'slack'
           AND m.direction = 'inbound'
           AND t.owner_agent IS NOT NULL`,
      )
      .all(agentId) as Array<{
      inbox_id: number;
      agent_id: string;
      metadata: string | null;
      owner_agent: string;
    }>;

    const staleIds: number[] = [];
    for (const row of rows) {
      if (!row.metadata) continue;
      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        continue;
      }
      const affinityOwner = metadata.threadAffinityOwnerAgentId;
      if (typeof affinityOwner !== "string" || affinityOwner.length === 0) continue;
      if (row.agent_id !== row.owner_agent || affinityOwner !== row.owner_agent) {
        staleIds.push(row.inbox_id);
      }
    }

    if (staleIds.length === 0) return 0;

    const now = new Date().toISOString();
    const stmt = db.prepare(
      "UPDATE inbox SET delivered = 1, read_at = COALESCE(read_at, ?) WHERE id = ? AND agent_id = ?",
    );
    for (const staleId of staleIds) {
      stmt.run(now, staleId, agentId);
    }
    return staleIds.length;
  }

  getInbox(agentId: string, limit = 50): { entry: InboxEntry; message: BrokerMessage }[] {
    this.dropStaleSlackInboxRows(agentId);
    const db = this.getDb();

    const rows = db
      .prepare(
        `SELECT
           i.id AS i_id, i.agent_id AS i_agent_id, i.message_id AS i_message_id,
           i.delivered AS i_delivered, i.read_at AS i_read_at, i.created_at AS i_created_at,
           m.id AS m_id, m.thread_id AS m_thread_id, m.source AS m_source,
           m.direction AS m_direction, m.sender AS m_sender, m.body AS m_body,
           m.metadata AS m_metadata, m.external_id AS m_external_id,
           m.external_ts AS m_external_ts, m.created_at AS m_created_at
         FROM inbox i
         JOIN messages m ON m.id = i.message_id
         WHERE i.agent_id = ? AND i.delivered = 0
         ORDER BY i.created_at ASC
         LIMIT ?`,
      )
      .all(agentId, limit) as unknown as Array<{
      i_id: number;
      i_agent_id: string;
      i_message_id: number;
      i_delivered: number;
      i_read_at: string | null;
      i_created_at: string;
      m_id: number;
      m_thread_id: string;
      m_source: string;
      m_direction: string;
      m_sender: string;
      m_body: string;
      m_metadata: string | null;
      m_external_id: string | null;
      m_external_ts: string | null;
      m_created_at: string;
    }>;

    return rows.map((r) => ({
      entry: {
        id: r.i_id,
        agentId: r.i_agent_id,
        messageId: r.i_message_id,
        delivered: r.i_delivered === 1,
        readAt: r.i_read_at,
        createdAt: r.i_created_at,
      },
      message: {
        id: r.m_id,
        threadId: r.m_thread_id,
        source: r.m_source,
        direction: r.m_direction as "inbound" | "outbound",
        sender: r.m_sender,
        body: r.m_body,
        metadata: r.m_metadata ? (JSON.parse(r.m_metadata) as Record<string, unknown>) : null,
        ...(r.m_external_id ? { externalId: r.m_external_id } : {}),
        ...(r.m_external_ts ? { externalTs: r.m_external_ts } : {}),
        createdAt: r.m_created_at,
      },
    }));
  }

  readInbox(agentId: string, options: InboxReadOptions = {}): InboxReadResult {
    this.dropStaleSlackInboxRows(agentId);
    const db = this.getDb();
    const unreadOnly = options.unreadOnly ?? true;
    const markRead = options.markRead ?? true;
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
    const threadId = options.threadId?.trim();
    const unreadCountBefore = this.getUnreadInboxCount(agentId);

    const clauses = ["i.agent_id = ?"];
    const values: Array<string | number> = [agentId];
    if (unreadOnly) {
      clauses.push("i.read_at IS NULL");
    }
    if (threadId) {
      clauses.push("m.thread_id = ?");
      values.push(threadId);
    }

    const order = unreadOnly ? "m.created_at ASC, i.id ASC" : "m.created_at DESC, i.id DESC";
    const limitClause = unreadOnly ? "" : "\n         LIMIT ?";
    const queryValues = unreadOnly ? values : [...values, limit];
    const rows = db
      .prepare(
        `SELECT
           i.id AS i_id, i.agent_id AS i_agent_id, i.message_id AS i_message_id,
           i.delivered AS i_delivered, i.read_at AS i_read_at, i.created_at AS i_created_at,
           m.id AS m_id, m.thread_id AS m_thread_id, m.source AS m_source,
           m.direction AS m_direction, m.sender AS m_sender, m.body AS m_body,
           m.metadata AS m_metadata, m.external_id AS m_external_id,
           m.external_ts AS m_external_ts, m.created_at AS m_created_at
         FROM inbox i
         JOIN messages m ON m.id = i.message_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY ${order}${limitClause}`,
      )
      .all(...queryValues) as unknown as Array<{
      i_id: number;
      i_agent_id: string;
      i_message_id: number;
      i_delivered: number;
      i_read_at: string | null;
      i_created_at: string;
      m_id: number;
      m_thread_id: string;
      m_source: string;
      m_direction: string;
      m_sender: string;
      m_body: string;
      m_metadata: string | null;
      m_external_id: string | null;
      m_external_ts: string | null;
      m_created_at: string;
    }>;

    const orderedRows = unreadOnly ? rows : rows.reverse();
    const messages = orderedRows.map((r) => ({
      entry: {
        id: r.i_id,
        agentId: r.i_agent_id,
        messageId: r.i_message_id,
        delivered: r.i_delivered === 1,
        readAt: r.i_read_at,
        createdAt: r.i_created_at,
      },
      message: {
        id: r.m_id,
        threadId: r.m_thread_id,
        source: r.m_source,
        direction: r.m_direction as "inbound" | "outbound",
        sender: r.m_sender,
        body: r.m_body,
        metadata: r.m_metadata ? (JSON.parse(r.m_metadata) as Record<string, unknown>) : null,
        ...(r.m_external_id ? { externalId: r.m_external_id } : {}),
        ...(r.m_external_ts ? { externalTs: r.m_external_ts } : {}),
        createdAt: r.m_created_at,
      },
    }));

    const prioritizedMessages = unreadOnly
      ? messages
          .map((item, index) => ({
            item,
            index,
            mailClass: classifyPinetMail({
              source: item.message.source,
              threadId: item.message.threadId,
              sender: item.message.sender,
              body: item.message.body,
              metadata: item.message.metadata,
            }).class,
          }))
          .sort((a, b) => {
            const classOrder = comparePinetMailClassPriority(a.mailClass, b.mailClass);
            if (classOrder !== 0) return classOrder;
            const createdOrder = a.item.message.createdAt.localeCompare(b.item.message.createdAt);
            if (createdOrder !== 0) return createdOrder;
            return a.index - b.index;
          })
          .slice(0, limit)
          .map(({ item }) => item)
      : messages;

    const markedReadIds = prioritizedMessages
      .filter((item) => item.entry.readAt === null)
      .map((item) => item.entry.id);
    if (markRead && markedReadIds.length > 0) {
      this.markRead(markedReadIds, agentId);
      const readAt = new Date().toISOString();
      for (const item of prioritizedMessages) {
        if (markedReadIds.includes(item.entry.id)) {
          item.entry.readAt = readAt;
        }
      }
    }

    const unreadCountAfter = this.getUnreadInboxCount(agentId);
    const unreadThreads = this.getUnreadThreadSummary(agentId);
    return {
      messages: prioritizedMessages,
      unreadCountBefore,
      unreadCountAfter,
      unreadThreads,
      markedReadIds: markRead ? markedReadIds : [],
    };
  }

  getUnreadInboxCount(agentId: string): number {
    this.dropStaleSlackInboxRows(agentId);
    const db = this.getDb();
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM inbox WHERE agent_id = ? AND read_at IS NULL")
      .get(agentId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  getUnreadThreadSummary(agentId: string, limit = 20): InboxThreadUnreadSummary[] {
    this.dropStaleSlackInboxRows(agentId);
    const db = this.getDb();
    const clampedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = db
      .prepare(
        `SELECT
           m.thread_id AS thread_id,
           m.source AS source,
           COALESCE(t.channel, '') AS channel,
           m.id AS message_id,
           m.sender AS sender,
           m.body AS body,
           m.metadata AS metadata,
           m.created_at AS created_at
         FROM inbox i
         JOIN messages m ON m.id = i.message_id
         LEFT JOIN threads t ON t.thread_id = m.thread_id
         WHERE i.agent_id = ? AND i.read_at IS NULL
         ORDER BY m.created_at DESC, m.id DESC`,
      )
      .all(agentId) as unknown as Array<{
      thread_id: string;
      source: string;
      channel: string;
      message_id: number;
      sender: string;
      body: string;
      metadata: string | null;
      created_at: string;
    }>;

    const summaries = new Map<string, InboxThreadUnreadSummary>();
    for (const row of rows) {
      const key = `${row.source}\u0000${row.thread_id}\u0000${row.channel}`;
      const metadata = row.metadata ? parseJsonMetadata(row.metadata) : null;
      const mailClass = classifyPinetMail({
        source: row.source,
        threadId: row.thread_id,
        sender: row.sender,
        body: row.body,
        metadata,
      }).class;
      const existing = summaries.get(key);
      if (!existing) {
        const counts = emptyMailClassCounts();
        counts[mailClass] = 1;
        summaries.set(key, {
          threadId: row.thread_id,
          source: row.source,
          channel: row.channel,
          unreadCount: 1,
          latestMessageId: row.message_id,
          latestAt: row.created_at,
          highestMailClass: mailClass,
          mailClassCounts: counts,
        });
        continue;
      }

      existing.unreadCount += 1;
      existing.mailClassCounts[mailClass] += 1;
      if (comparePinetMailClassPriority(mailClass, existing.highestMailClass) < 0) {
        existing.highestMailClass = mailClass;
      }
      if (
        row.created_at > existing.latestAt ||
        (row.created_at === existing.latestAt && row.message_id > existing.latestMessageId)
      ) {
        existing.latestAt = row.created_at;
        existing.latestMessageId = row.message_id;
      }
    }

    return Array.from(summaries.values())
      .sort((a, b) => {
        const classOrder = comparePinetMailClassPriority(a.highestMailClass, b.highestMailClass);
        if (classOrder !== 0) return classOrder;
        const latestOrder = b.latestAt.localeCompare(a.latestAt);
        if (latestOrder !== 0) return latestOrder;
        return b.latestMessageId - a.latestMessageId;
      })
      .slice(0, clampedLimit);
  }

  markRead(inboxIds: number[], agentId: string): void {
    if (inboxIds.length === 0) return;
    const db = this.getDb();
    const now = new Date().toISOString();
    const stmt = db.prepare(
      "UPDATE inbox SET read_at = COALESCE(read_at, ?) WHERE id = ? AND agent_id = ?",
    );
    for (const id of inboxIds) {
      stmt.run(now, id, agentId);
    }
  }

  getMessagesByIds(messageIds: number[]): BrokerMessage[] {
    if (messageIds.length === 0) {
      return [];
    }

    const db = this.getDb();
    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT id, thread_id, source, direction, sender, body, metadata, external_id, external_ts, created_at
         FROM messages
         WHERE id IN (${placeholders})
         ORDER BY id ASC`,
      )
      .all(...messageIds) as unknown as Array<{
      id: number;
      thread_id: string;
      source: string;
      direction: string;
      sender: string;
      body: string;
      metadata: string | null;
      external_id: string | null;
      external_ts: string | null;
      created_at: string;
    }>;

    return rows.map(rowToBrokerMessage);
  }

  markDelivered(inboxIds: number[], agentId?: string): void {
    if (inboxIds.length === 0) return;
    const db = this.getDb();
    const lookup = db.prepare("SELECT message_id, agent_id FROM inbox WHERE id = ?");

    if (agentId) {
      const stmt = db.prepare("UPDATE inbox SET delivered = 1 WHERE id = ? AND agent_id = ?");
      for (const id of inboxIds) {
        const result = stmt.run(id, agentId);
        if (Number(result.changes ?? 0) === 0) continue;
        const row = lookup.get(id) as { message_id: number; agent_id: string } | undefined;
        if (row) {
          this.completeTargetedBacklogAssignment(row.message_id, row.agent_id);
        }
      }
      return;
    }

    const stmt = db.prepare("UPDATE inbox SET delivered = 1 WHERE id = ?");
    for (const id of inboxIds) {
      const result = stmt.run(id);
      if (Number(result.changes ?? 0) === 0) continue;
      const row = lookup.get(id) as { message_id: number; agent_id: string } | undefined;
      if (row) {
        this.completeTargetedBacklogAssignment(row.message_id, row.agent_id);
      }
    }
  }

  /** Mark all undelivered inbox rows for a given message+agent as delivered. */
  markDeliveredByMessageId(messageId: number, agentId: string): void {
    const db = this.getDb();
    const result = db
      .prepare(
        "UPDATE inbox SET delivered = 1 WHERE message_id = ? AND agent_id = ? AND delivered = 0",
      )
      .run(messageId, agentId);
    if (Number(result.changes ?? 0) > 0) {
      this.completeTargetedBacklogAssignment(messageId, agentId);
    }
  }

  private completeTargetedBacklogAssignment(messageId: number, agentId: string): void {
    const db = this.getDb();
    db.prepare(
      `DELETE FROM unrouted_backlog
       WHERE message_id = ?
         AND status = 'assigned'
         AND preferred_agent_id IS NOT NULL
         AND assigned_agent_id = ?`,
    ).run(messageId, agentId);
  }

  // ─── Internal ────────────────────────────────────────

  private requeueUndeliveredMessagesInternal(
    agentId: string,
    reason = "agent_disconnected",
  ): number {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT
           i.id AS inbox_id,
           i.agent_id AS target_agent_id,
           m.id AS message_id,
           m.thread_id AS thread_id,
           m.source AS source,
           m.metadata AS metadata
         FROM inbox i
         JOIN messages m ON m.id = i.message_id
         WHERE i.agent_id = ?
           AND i.delivered = 0
           AND m.direction = 'inbound'`,
      )
      .all(agentId) as Array<{
      inbox_id: number;
      target_agent_id: string;
      message_id: number;
      thread_id: string;
      source: string;
      metadata: string | null;
    }>;

    if (rows.length === 0) {
      return 0;
    }

    const markDelivered = db.prepare("UPDATE inbox SET delivered = 1 WHERE id = ?");
    for (const row of rows) {
      const metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
      const channel = typeof metadata.channel === "string" ? metadata.channel : "";
      const preferredAgentId = row.source === "agent" ? row.target_agent_id : null;
      this.upsertBacklogEntry(
        row.message_id,
        row.thread_id,
        channel,
        reason,
        "pending",
        preferredAgentId,
        null,
      );
      markDelivered.run(row.inbox_id);
    }

    return rows.length;
  }

  private getBacklogById(id: number): BacklogEntry | null {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM unrouted_backlog WHERE id = ?").get(id) as
      | BacklogRow
      | undefined;
    return row ? rowToBacklog(row) : null;
  }

  private getBacklogByMessageId(messageId: number): BacklogEntry | null {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM unrouted_backlog WHERE message_id = ?").get(messageId) as
      | BacklogRow
      | undefined;
    return row ? rowToBacklog(row) : null;
  }

  private upsertBacklogEntry(
    messageId: number,
    threadId: string,
    channel: string,
    reason: string,
    status: BacklogEntry["status"],
    preferredAgentId: string | null,
    assignedAgentId: string | null,
  ): BacklogEntry {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO unrouted_backlog (
         thread_id,
         channel,
         message_id,
         reason,
         status,
         preferred_agent_id,
         assigned_agent_id,
         attempt_count,
         last_attempt_at,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         thread_id = excluded.thread_id,
         channel = excluded.channel,
         reason = excluded.reason,
         status = excluded.status,
         preferred_agent_id = excluded.preferred_agent_id,
         assigned_agent_id = excluded.assigned_agent_id,
         updated_at = excluded.updated_at`,
    ).run(
      threadId,
      channel,
      messageId,
      reason,
      status,
      preferredAgentId,
      assignedAgentId,
      now,
      now,
    );

    const row = db.prepare("SELECT * FROM unrouted_backlog WHERE message_id = ?").get(messageId) as
      | BacklogRow
      | undefined;
    if (!row) {
      throw new Error(`Failed to upsert backlog entry for message ${messageId}`);
    }
    return rowToBacklog(row);
  }

  private withTransaction<T>(operation: () => T): T {
    const db = this.getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* best effort */
      }
      throw err;
    }
  }

  private openAndMigrate(): void {
    const db = this.openDatabase();
    this.db = db;
    runSchemaMigrations(db);
    this.ensureRequiredAgentLifecycleColumns(db);
  }

  private openDatabase(): DatabaseSync {
    const db = new DatabaseSync(this.dbPath, { timeout: 5000 });
    const journalMode = db.prepare("PRAGMA journal_mode=WAL").get() as
      | SqliteJournalModeResult
      | undefined;
    if (!isSqliteWalEnabled(journalMode)) {
      console.warn(buildSqliteWalFallbackWarning("BrokerDB", journalMode));
    }
    db.exec("PRAGMA busy_timeout=5000");
    return db;
  }

  private resetDatabaseFiles(): void {
    this.close();
    for (const file of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  private getMissingRequiredAgentLifecycleColumns(db: DatabaseSync): string[] {
    const columns = getTableColumns(db, "agents");
    return REQUIRED_AGENT_LIFECYCLE_COLUMNS.filter((column) => !columns.has(column));
  }

  private ensureRequiredAgentLifecycleColumns(db: DatabaseSync): void {
    const missingColumns = this.getMissingRequiredAgentLifecycleColumns(db);
    if (missingColumns.length > 0) {
      throw new Error(`agents table missing required columns: ${missingColumns.join(", ")}`);
    }
  }

  protected getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("BrokerDB not initialized — call initialize() first");
    }
    return this.db;
  }
}
