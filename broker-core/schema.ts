import { DatabaseSync } from "node:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyPinetMail } from "./mail-classification.js";
import { assertLegalLifecycleTransition } from "./lifecycle.js";
import { getDefaultDbPath } from "./paths.js";
import { DEFAULT_EXTERNAL_THREAD_SOURCE } from "./types.js";
import type { PinetMailClass } from "./mail-classification.js";
import type {
  AgentInfo,
  AgentSupervisionState,
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
  TaskAssignmentKind,
  TaskAssignmentStatus,
  ScheduledWakeupInfo,
  ScheduledWakeupDelivery,
  PortLeaseAcquireInput,
  PortLeaseInfo,
  PortLeaseListOptions,
  PortLeaseReleaseInput,
  PortLeaseRenewInput,
  PortLeaseStatus,
  AgentSessionSearchInfo,
  AgentSessionSearchOptions,
  PinetLaneInfo,
  PinetLaneListOptions,
  PinetLaneParticipantInfo,
  PinetLaneParticipantUpsertInput,
  PinetLaneRole,
  PinetLaneState,
  PinetLaneUpsertInput,
  AgentLifecycleState,
  AgentHibernatePolicy,
  AgentLifecycleLease,
  AgentLifecycleOperation,
  AgentLifecycleTransitionInput,
  AgentLifecycleRetentionInfo,
  AgentRuntimeSpec,
  AgentRuntimeSpecInput,
  AgentCheckpointReceipt,
  AgentCheckpointReceiptInput,
  AgentWakeReservation,
  AgentWakeAcceptanceReceipt,
  AcceptRuntimeGenerationInput,
  RuntimeGenerationAcceptance,
  AgentWakeQueueEntry,
  WakeTriggerKind,
  EnqueueWakeInput,
  AgentLifecycleEvent,
  AgentLifecycleEventInput,
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
  parent_agent_id: string | null;
  root_agent_id: string | null;
  tree_depth: number | null;
  spawned_by_agent_id: string | null;
  supervision_state: string | null;
  launch_id: string | null;
  subtree_role: string | null;
  lane_id: string | null;
  disconnected_at: string | null;
  resumable_until: string | null;
  idle_since: string | null;
  last_activity: string | null;
  lifecycle_state: string;
  lifecycle_version: number;
  grace_until: string | null;
  idle_eligible_at: string | null;
  hibernated_at: string | null;
  terminated_at: string | null;
  hibernate_policy: string;
  hibernate_reason: string | null;
  last_wake_reason: string | null;
  runtime_generation: number;
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
  repo_key: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  repo_root: string | null;
  task_kind: string | null;
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
    parentAgentId: row.parent_agent_id,
    rootAgentId: row.root_agent_id,
    treeDepth: row.tree_depth ?? 0,
    spawnedByAgentId: row.spawned_by_agent_id,
    supervisionState: normalizeAgentSupervisionState(row.supervision_state),
    launchId: row.launch_id,
    subtreeRole: row.subtree_role,
    laneId: row.lane_id,
    disconnectedAt: row.disconnected_at,
    resumableUntil: row.resumable_until,
    idleSince: row.idle_since,
    lastActivity: row.last_activity,
    lifecycleState: row.lifecycle_state as AgentLifecycleState,
    lifecycleVersion: row.lifecycle_version,
    graceUntil: row.grace_until,
    idleEligibleAt: row.idle_eligible_at,
    hibernatedAt: row.hibernated_at,
    terminatedAt: row.terminated_at,
    hibernatePolicy: row.hibernate_policy as AgentHibernatePolicy,
    hibernateReason: row.hibernate_reason,
    lastWakeReason: row.last_wake_reason,
    runtimeGeneration: row.runtime_generation,
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

interface WakeQueueRow {
  id: number;
  agent_id: string;
  repo_root: string | null;
  trigger_kind: string;
  trigger_message_id: number | null;
  priority: number;
  reason: string;
  correlation_id: string;
  status: string;
  attempt: number;
  enqueued_at: string;
  updated_at: string;
}

function rowToWakeQueueEntry(row: WakeQueueRow): AgentWakeQueueEntry {
  return {
    id: row.id,
    agentId: row.agent_id,
    repoRoot: row.repo_root,
    triggerKind: row.trigger_kind as WakeTriggerKind,
    triggerMessageId: row.trigger_message_id,
    priority: row.priority,
    reason: row.reason,
    correlationId: row.correlation_id,
    status: row.status as AgentWakeQueueEntry["status"],
    attempt: row.attempt,
    enqueuedAt: row.enqueued_at,
    updatedAt: row.updated_at,
  };
}

/** Parse a JSON array-of-strings column, tolerating malformed/legacy values. */
function parseStringArray(value: string): string[] {
  try {
    const parsed: string[] = [];
    const raw = JSON.parse(value);
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === "string") parsed.push(item);
      }
    }
    return parsed;
  } catch {
    return [];
  }
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

const INTERNAL_AGENT_SOURCE = "agent";
const STALE_SLACK_MESSAGE_MAX_AGE_MS = 15 * 60 * 1000;
// Slack ts values are epoch seconds. Small fixture/sentinel values are treated
// as ambiguous instead of stale so replay filtering only applies to plausible
// real Slack event timestamps.
const MIN_PLAUSIBLE_SLACK_TIMESTAMP_SECONDS = 1_000_000_000;

function parseSlackTimestampMs(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds < MIN_PLAUSIBLE_SLACK_TIMESTAMP_SECONDS) {
    return null;
  }
  return Math.trunc(seconds * 1000);
}

function getSlackMessageAgeMs(
  source: string,
  timestamp: string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (source !== "slack") return null;
  const timestampMs = parseSlackTimestampMs(timestamp);
  return timestampMs === null ? null : nowMs - timestampMs;
}

function isStaleSlackMessageTimestamp(
  source: string,
  timestamp: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  const ageMs = getSlackMessageAgeMs(source, timestamp, nowMs);
  return ageMs !== null && ageMs > STALE_SLACK_MESSAGE_MAX_AGE_MS;
}

function isExternalTransportSource(source: string): boolean {
  return source.trim().length > 0 && source !== INTERNAL_AGENT_SOURCE;
}

function deriveMessageSyncIdentity(
  threadId: string,
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

  if (!isExternalTransportSource(source)) {
    return { externalId: null, externalTs: explicitExternalTs };
  }

  const channel = getStringMetadataValue(metadata, [
    "transportChannelId",
    "transport_channel_id",
    "conversationId",
    "conversation_id",
    "channel",
    "channelId",
    "channel_id",
  ]);
  const timestamp = getStringMetadataValue(metadata, [
    "transportTimestamp",
    "transport_timestamp",
    "timestamp",
    "ts",
  ]);
  if (timestamp && channel) {
    return { externalId: `${channel}:${timestamp}`, externalTs: timestamp };
  }
  if (timestamp && threadId.trim().length > 0) {
    return { externalId: `${threadId}:${timestamp}`, externalTs: timestamp };
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

function normalizeTaskAssignmentKind(value: string | null | undefined): TaskAssignmentKind {
  switch (value) {
    case "implementation":
    case "review":
    case "qa":
    case "merge":
    case "interactive":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function buildTaskAssignmentRepoKey(input: {
  repoOwner?: string | null;
  repoName?: string | null;
  repoRoot?: string | null;
}): string {
  const owner = input.repoOwner?.trim().toLowerCase();
  const name = input.repoName?.trim().toLowerCase();
  if (owner && name) {
    return `${owner}/${name}`;
  }
  const repoRoot = input.repoRoot?.trim();
  return repoRoot ? `root:${repoRoot}` : "repo_unknown";
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
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoRoot: row.repo_root,
    taskKind: normalizeTaskAssignmentKind(row.task_kind),
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

const AGENT_SUPERVISION_STATES = new Set<AgentSupervisionState>([
  "root",
  "supervised",
  "orphaned",
  "stopping",
]);

function normalizeAgentSupervisionState(value: unknown): AgentSupervisionState {
  return typeof value === "string" && AGENT_SUPERVISION_STATES.has(value as AgentSupervisionState)
    ? (value as AgentSupervisionState)
    : "root";
}

function getOptionalMetadataString(
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

function getOptionalNestedMetadataString(
  metadata: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  const direct = getOptionalMetadataString(metadata ?? undefined, keys);
  if (direct) return direct;
  const capabilities =
    metadata?.capabilities &&
    typeof metadata.capabilities === "object" &&
    !Array.isArray(metadata.capabilities)
      ? (metadata.capabilities as Record<string, unknown>)
      : undefined;
  return getOptionalMetadataString(capabilities, keys);
}

function normalizeSessionSearchNeedle(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function matchesSessionSearchNeedle(
  value: string | null | undefined,
  needle: string | null,
): boolean {
  if (!needle) return true;
  return Boolean(value?.toLowerCase().includes(needle));
}

function matchesSessionSearchPrefixOrExact(
  value: string | null | undefined,
  needle: string | null,
): boolean {
  if (!needle) return true;
  const normalized = value?.toLowerCase();
  return Boolean(normalized && (normalized === needle || normalized.startsWith(needle)));
}

function parseSessionSearchTime(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeSessionSearchLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function agentSessionOverlapsRange(
  agent: AgentInfo,
  sinceMs: number | null,
  untilMs: number | null,
): boolean {
  const connectedMs = Date.parse(agent.connectedAt);
  const lastSeenMs = Date.parse(agent.lastSeen || agent.lastHeartbeat || agent.connectedAt);
  const startMs = Number.isNaN(connectedMs) ? null : connectedMs;
  const endMs = Number.isNaN(lastSeenMs) ? startMs : lastSeenMs;
  if (sinceMs !== null && endMs !== null && endMs < sinceMs) return false;
  if (untilMs !== null && startMs !== null && startMs > untilMs) return false;
  return true;
}

function getAgentSessionMatchedBy(input: {
  agent: AgentInfo;
  metadata: Record<string, unknown> | null;
  relatedThreadIds: string[];
  options: AgentSessionSearchOptions;
}): string[] {
  const matchedBy: string[] = [];
  const agentName = normalizeSessionSearchNeedle(input.options.agentName);
  const agentId = normalizeSessionSearchNeedle(input.options.agentId);
  const threadId = normalizeSessionSearchNeedle(input.options.threadId);
  const repo = normalizeSessionSearchNeedle(input.options.repo);
  const worktreePath = normalizeSessionSearchNeedle(input.options.worktreePath);
  const tmuxSession = normalizeSessionSearchNeedle(input.options.tmuxSession);

  if (agentName && matchesSessionSearchNeedle(input.agent.name, agentName)) {
    matchedBy.push("agent_name");
  }
  if (agentId && matchesSessionSearchPrefixOrExact(input.agent.id, agentId)) {
    matchedBy.push("agent_id");
  }
  if (
    threadId &&
    input.relatedThreadIds.some((candidate) => candidate.toLowerCase().includes(threadId))
  ) {
    matchedBy.push("thread_id");
  }

  const repoValues = [
    getOptionalNestedMetadataString(input.metadata, ["repo"]),
    getOptionalNestedMetadataString(input.metadata, ["repoRoot"]),
    getOptionalNestedMetadataString(input.metadata, ["cwd"]),
  ];
  if (repo && repoValues.some((value) => matchesSessionSearchNeedle(value, repo))) {
    matchedBy.push("repo");
  }

  const worktreeValues = [
    getOptionalNestedMetadataString(input.metadata, ["worktreePath"]),
    getOptionalNestedMetadataString(input.metadata, ["cwd"]),
    getOptionalNestedMetadataString(input.metadata, ["repoRoot"]),
  ];
  if (
    worktreePath &&
    worktreeValues.some((value) => matchesSessionSearchNeedle(value, worktreePath))
  ) {
    matchedBy.push("worktree_path");
  }

  const tmux = getOptionalNestedMetadataString(input.metadata, ["tmuxSession", "tmux"]);
  if (tmuxSession && matchesSessionSearchNeedle(tmux, tmuxSession)) {
    matchedBy.push("tmux_session");
  }

  if (input.options.since || input.options.until) {
    matchedBy.push("time_range");
  }

  if (matchedBy.length === 0) {
    matchedBy.push("recent");
  }
  return matchedBy;
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
export const CURRENT_BROKER_SCHEMA_VERSION = 22;

/**
 * Lifecycle states whose durable identity, inbox, thread ownership, and runtime
 * mapping MUST survive routine maintenance. A hibernation identity is
 * intentionally "disconnected" (no live socket) yet must be revivable by a later
 * wake, so ordinary disconnect-driven prune/purge/ownership-repair would destroy
 * exactly the state hibernation preserves. `reap-candidate` is quarantined
 * pending manual review and must likewise not be auto-released or deleted (that
 * would discard evidence). `terminated` is a closed identity and remains
 * ordinarily purgeable. This is a fixed constant list — never interpolated with
 * external input — so it is safe to embed directly in SQL predicates.
 */
const PRESERVED_LIFECYCLE_STATES_SQL = "'hibernating','hibernated','waking','reap-candidate'";

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

function addAgentHierarchyColumns(db: DatabaseSync): void {
  ensureColumn(
    db,
    "agents",
    "parent_agent_id",
    "ALTER TABLE agents ADD COLUMN parent_agent_id TEXT",
  );
  ensureColumn(db, "agents", "root_agent_id", "ALTER TABLE agents ADD COLUMN root_agent_id TEXT");
  ensureColumn(
    db,
    "agents",
    "tree_depth",
    "ALTER TABLE agents ADD COLUMN tree_depth INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "agents",
    "spawned_by_agent_id",
    "ALTER TABLE agents ADD COLUMN spawned_by_agent_id TEXT",
  );
  ensureColumn(
    db,
    "agents",
    "supervision_state",
    "ALTER TABLE agents ADD COLUMN supervision_state TEXT NOT NULL DEFAULT 'root'",
  );
  ensureColumn(db, "agents", "launch_id", "ALTER TABLE agents ADD COLUMN launch_id TEXT");
  ensureColumn(db, "agents", "subtree_role", "ALTER TABLE agents ADD COLUMN subtree_role TEXT");
  ensureColumn(db, "agents", "lane_id", "ALTER TABLE agents ADD COLUMN lane_id TEXT");

  db.exec(`
    UPDATE agents
    SET tree_depth = COALESCE(tree_depth, 0),
        supervision_state = COALESCE(supervision_state, 'root')
    WHERE tree_depth IS NULL OR supervision_state IS NULL;

    CREATE INDEX IF NOT EXISTS idx_agents_parent_agent_id
      ON agents(parent_agent_id);
    CREATE INDEX IF NOT EXISTS idx_agents_root_agent_id
      ON agents(root_agent_id);
    CREATE INDEX IF NOT EXISTS idx_agents_supervision_state
      ON agents(supervision_state, parent_agent_id);
    CREATE INDEX IF NOT EXISTS idx_agents_lane_id
      ON agents(lane_id);
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
    .prepare("SELECT id, thread_id, source, metadata FROM messages WHERE metadata IS NOT NULL")
    .all() as Array<{ id: number; thread_id: string; source: string; metadata: string | null }>;
  const update = db.prepare("UPDATE messages SET external_id = ?, external_ts = ? WHERE id = ?");

  for (const row of rows) {
    if (!row.metadata) continue;
    try {
      const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      const identity = deriveMessageSyncIdentity(row.thread_id, row.source, metadata);
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
      repo_key TEXT NOT NULL DEFAULT 'repo_unknown',
      repo_owner TEXT,
      repo_name TEXT,
      repo_root TEXT,
      task_kind TEXT NOT NULL DEFAULT 'unknown'
        CHECK(task_kind IN ('implementation', 'review', 'qa', 'merge', 'interactive', 'unknown')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repo_key, issue_number)
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
      repo_key,
      repo_owner,
      repo_name,
      repo_root,
      task_kind,
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
      'repo_unknown',
      NULL,
      NULL,
      NULL,
      'unknown',
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

function migrateTaskAssignmentsToRepoScopedTracking(db: DatabaseSync): void {
  if (!tableExists(db, "task_assignments")) {
    createTaskAssignmentTable(db);
    return;
  }

  const existingColumns = getTableColumns(db, "task_assignments");
  if (!existingColumns.has("agent_id") || !existingColumns.has("issue_number")) {
    db.exec("DROP TABLE task_assignments");
    createTaskAssignmentTable(db);
    return;
  }

  db.exec(`
    ALTER TABLE task_assignments RENAME TO task_assignments_legacy;
    DROP INDEX IF EXISTS idx_task_assignments_agent_status;
    DROP INDEX IF EXISTS idx_task_assignments_branch;
  `);

  createTaskAssignmentTable(db);

  const legacyColumns = getTableColumns(db, "task_assignments_legacy");
  const repoKeyExpr = legacyColumns.has("repo_key")
    ? "COALESCE(repo_key, 'repo_unknown')"
    : "'repo_unknown'";
  const repoOwnerExpr = legacyColumns.has("repo_owner") ? "repo_owner" : "NULL";
  const repoNameExpr = legacyColumns.has("repo_name") ? "repo_name" : "NULL";
  const repoRootExpr = legacyColumns.has("repo_root") ? "repo_root" : "NULL";
  const taskKindExpr = legacyColumns.has("task_kind")
    ? "COALESCE(task_kind, 'unknown')"
    : "'unknown'";

  db.exec(`
    INSERT INTO task_assignments (
      agent_id,
      issue_number,
      branch,
      pr_number,
      status,
      thread_id,
      source_message_id,
      repo_key,
      repo_owner,
      repo_name,
      repo_root,
      task_kind,
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
      ${repoKeyExpr},
      ${repoOwnerExpr},
      ${repoNameExpr},
      ${repoRootExpr},
      ${taskKindExpr},
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

// agent-standards-ignore prefer-inline-single-use-helper: schema migrations stay isolated and auditable by version.
function createAgentHibernationTables(db: DatabaseSync): void {
  for (const [name, sql] of [
    [
      "lifecycle_state",
      "ALTER TABLE agents ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'live'",
    ],
    [
      "lifecycle_version",
      "ALTER TABLE agents ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 0",
    ],
    ["grace_until", "ALTER TABLE agents ADD COLUMN grace_until TEXT"],
    ["idle_eligible_at", "ALTER TABLE agents ADD COLUMN idle_eligible_at TEXT"],
    ["hibernated_at", "ALTER TABLE agents ADD COLUMN hibernated_at TEXT"],
    ["terminated_at", "ALTER TABLE agents ADD COLUMN terminated_at TEXT"],
    [
      "hibernate_policy",
      "ALTER TABLE agents ADD COLUMN hibernate_policy TEXT NOT NULL DEFAULT 'never'",
    ],
    ["hibernate_reason", "ALTER TABLE agents ADD COLUMN hibernate_reason TEXT"],
    ["last_wake_reason", "ALTER TABLE agents ADD COLUMN last_wake_reason TEXT"],
    [
      "runtime_generation",
      "ALTER TABLE agents ADD COLUMN runtime_generation INTEGER NOT NULL DEFAULT 0",
    ],
  ] as const)
    ensureColumn(db, "agents", name, sql);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runtime_specs (
      agent_id TEXT PRIMARY KEY NOT NULL, stable_id TEXT NOT NULL, broker_owner_id TEXT NOT NULL,
      cwd TEXT NOT NULL, repo_root TEXT NOT NULL, worktree_path TEXT NOT NULL,
      tmux_socket TEXT NOT NULL, tmux_session TEXT NOT NULL, tmux_target TEXT NOT NULL,
      executable TEXT NOT NULL, argv_json TEXT NOT NULL, env_allowlist_json TEXT NOT NULL,
      session_resume_ref TEXT NOT NULL, config_fingerprint TEXT NOT NULL,
      expected_host TEXT NOT NULL, expected_user TEXT NOT NULL, launch_source TEXT NOT NULL,
      vcs_identity TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_lifecycle_leases (
      agent_id TEXT PRIMARY KEY NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('hibernate','wake')),
      fence_token INTEGER NOT NULL, owner_broker_instance_id TEXT NOT NULL, lease_id TEXT NOT NULL UNIQUE,
      acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL, attempt INTEGER NOT NULL,
      trigger_message_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS agent_lifecycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, correlation_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      from_state TEXT NOT NULL, to_state TEXT NOT NULL, lifecycle_version INTEGER NOT NULL,
      fence_token INTEGER, reason TEXT NOT NULL, trigger_source TEXT, actor TEXT NOT NULL,
      outcome TEXT NOT NULL, error_code TEXT, queue_depth INTEGER, oldest_queue_age_ms INTEGER,
      duration_ms INTEGER, rss_bytes_before INTEGER, rss_bytes_after INTEGER, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_events_agent_created
      ON agent_lifecycle_events(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_events_created
      ON agent_lifecycle_events(created_at DESC);
    CREATE TABLE IF NOT EXISTS agent_lifecycle_retention (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
      pruned_count INTEGER NOT NULL DEFAULT 0,
      last_pruned_at TEXT
    );
    INSERT OR IGNORE INTO agent_lifecycle_retention (singleton, pruned_count) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS agent_checkpoint_receipts (
      agent_id TEXT NOT NULL, runtime_generation INTEGER NOT NULL, correlation_id TEXT NOT NULL,
      hibernate_safe INTEGER NOT NULL, reason TEXT, session_resume_ref TEXT,
      pending_inbox_count INTEGER NOT NULL DEFAULT 0, rss_bytes INTEGER, created_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, runtime_generation)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_checkpoint_receipts_agent
      ON agent_checkpoint_receipts(agent_id, runtime_generation DESC);
    CREATE TABLE IF NOT EXISTS agent_wake_reservations (
      agent_id TEXT PRIMARY KEY NOT NULL, wake_lease_id TEXT NOT NULL, fence_token INTEGER NOT NULL,
      reserved_generation INTEGER NOT NULL, reservation_nonce TEXT NOT NULL DEFAULT '',
      correlation_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_wake_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, repo_root TEXT,
      trigger_kind TEXT NOT NULL, trigger_message_id INTEGER, priority INTEGER NOT NULL DEFAULT 100,
      reason TEXT NOT NULL, correlation_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','dispatching','done','cancelled')),
      attempt INTEGER NOT NULL DEFAULT 0, enqueued_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_wake_queue_active_agent
      ON agent_wake_queue(agent_id) WHERE status IN ('queued','dispatching');
    CREATE INDEX IF NOT EXISTS idx_agent_wake_queue_dispatch
      ON agent_wake_queue(status, priority, id);
  `);
}

/**
 * Per-attempt wake nonce: a fresh, opaque token minted on every wake reservation
 * so that two wake attempts for the same identity (which necessarily reuse the
 * same lease id, fence token, and `runtime_generation + 1`) are distinguishable.
 * Without it a slow runtime from an earlier, timed-out attempt could satisfy a
 * later attempt's otherwise-identical reservation. Added for dogfood DBs already
 * at v19 (fresh DBs get the column from the CREATE TABLE above).
 */
// agent-standards-ignore prefer-inline-single-use-helper: one-function-per-
// migration-case is the established schema-migration seam (mirrors case 19's
// createAgentHibernationTables); keeps the version switch a readable index.
function addWakeReservationNonceColumn(db: DatabaseSync): void {
  ensureColumn(
    db,
    "agent_wake_reservations",
    "reservation_nonce",
    "ALTER TABLE agent_wake_reservations ADD COLUMN reservation_nonce TEXT NOT NULL DEFAULT ''",
  );
}

/**
 * Acceptance receipt: a single-row-per-agent record of the EXACT wake fence that
 * accepted a generation. It lets a runtime whose registration was accepted but
 * whose register RPC response was lost to a broker crash (committed acceptance
 * but never bound the socket / returned) replay its single-use wake fence and be
 * re-bound idempotently instead of being rejected and stranded. Superseded by
 * the next wake reservation (cleared in `reserveWakeGeneration`) so a stale fence
 * can never rebind during a fresh wake window. Added for dogfood DBs already at
 * v20 (fresh DBs also create it via this migration).
 */
// agent-standards-ignore prefer-inline-single-use-helper: one-function-per-
// migration-case is the established schema-migration seam; keeps the version
// switch a readable index.
function createWakeAcceptanceReceiptTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_wake_acceptance_receipts (
      agent_id TEXT PRIMARY KEY NOT NULL,
      stable_id TEXT NOT NULL,
      wake_lease_id TEXT NOT NULL,
      fence_token INTEGER NOT NULL,
      reserved_generation INTEGER NOT NULL,
      reservation_nonce TEXT NOT NULL,
      accepted_at TEXT NOT NULL
    );
  `);
}

/**
 * Canonical VCS identity column: a broker-derived `owner/repo` captured at spawn
 * from the runtime's git remote (never inferred from directory names). The repo
 * allowlist authorization matches this identity EXACTLY, so distinct filesystem
 * roots that happen to share their final path segments (e.g.
 * `/trusted/gugu91/pinet` vs `/tmp/impostor/gugu91/pinet`) do not
 * collapse onto one authorization identity, and a repo shares one identity with
 * all of its git worktrees. Nullable — a spec captured without a resolvable
 * remote leaves it null and the fail-closed gate refuses. Added for dogfood DBs
 * already at v21 (fresh DBs get the column from the CREATE TABLE above).
 */
// agent-standards-ignore prefer-inline-single-use-helper: one-function-per-
// migration-case is the established schema-migration seam; keeps the version
// switch a readable index.
function addRuntimeSpecVcsIdentityColumn(db: DatabaseSync): void {
  ensureColumn(
    db,
    "agent_runtime_specs",
    "vcs_identity",
    "ALTER TABLE agent_runtime_specs ADD COLUMN vcs_identity TEXT",
  );
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
        case 17:
          migrateTaskAssignmentsToRepoScopedTracking(db);
          break;
        case 18:
          addAgentHierarchyColumns(db);
          break;
        case 19:
          createAgentHibernationTables(db);
          break;
        case 20:
          addWakeReservationNonceColumn(db);
          break;
        case 21:
          createWakeAcceptanceReceiptTable(db);
          break;
        case 22:
          addRuntimeSpecVcsIdentityColumn(db);
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

/**
 * Internal sentinel used to roll back a combined register+accept transaction:
 * thrown when generation acceptance is rejected so `withTransaction` rolls back
 * the registration mutation, then caught at the method boundary and converted
 * back into a normal rejection result (never propagated to callers).
 */
class GenerationAcceptanceRollback extends Error {
  constructor(readonly rejection: Extract<RuntimeGenerationAcceptance, { accepted: false }>) {
    super("generation_acceptance_rollback");
    this.name = "GenerationAcceptanceRollback";
  }
}

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
    const hierarchy = this.resolveAgentHierarchy(agentId, finalMetadata, existingRow);

    db.prepare(
      `INSERT INTO agents (
         id, stable_id, name, emoji, pid,
         connected_at, last_seen, last_heartbeat,
         metadata, status,
         parent_agent_id, root_agent_id, tree_depth, spawned_by_agent_id,
         supervision_state, launch_id, subtree_role, lane_id,
         disconnected_at, resumable_until, idle_since, last_activity
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)
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
         parent_agent_id = excluded.parent_agent_id,
         root_agent_id = excluded.root_agent_id,
         tree_depth = excluded.tree_depth,
         spawned_by_agent_id = excluded.spawned_by_agent_id,
         supervision_state = excluded.supervision_state,
         launch_id = excluded.launch_id,
         subtree_role = excluded.subtree_role,
         lane_id = excluded.lane_id,
         disconnected_at = NULL,
         resumable_until = NULL,
         idle_since = excluded.idle_since,
         last_activity = NULL`,
    ).run(
      agentId,
      persistedStableId,
      finalName,
      finalEmoji,
      pid,
      now,
      now,
      now,
      meta,
      hierarchy.parentAgentId,
      hierarchy.rootAgentId,
      hierarchy.treeDepth,
      hierarchy.spawnedByAgentId,
      hierarchy.supervisionState,
      hierarchy.launchId,
      hierarchy.subtreeRole,
      hierarchy.laneId,
      now,
    );

    return {
      id: agentId,
      stableId: persistedStableId,
      name: finalName,
      emoji: finalEmoji,
      pid,
      connectedAt: now,
      lastSeen: now,
      lastHeartbeat: now,
      metadata: finalMetadata ?? null,
      status: "idle" as const,
      parentAgentId: hierarchy.parentAgentId,
      rootAgentId: hierarchy.rootAgentId,
      treeDepth: hierarchy.treeDepth,
      spawnedByAgentId: hierarchy.spawnedByAgentId,
      supervisionState: hierarchy.supervisionState,
      launchId: hierarchy.launchId,
      subtreeRole: hierarchy.subtreeRole,
      laneId: hierarchy.laneId,
      idleSince: now,
      lastActivity: null,
    };
  }

  private resolveAgentHierarchy(
    agentId: string,
    metadata: Record<string, unknown> | undefined,
    existingRow: AgentRow | null | undefined,
  ): {
    parentAgentId: string | null;
    rootAgentId: string | null;
    treeDepth: number;
    spawnedByAgentId: string | null;
    supervisionState: AgentSupervisionState;
    launchId: string | null;
    subtreeRole: string | null;
    laneId: string | null;
  } {
    const requestedParentId = getOptionalMetadataString(metadata, [
      "parentAgentId",
      "pinetParentAgentId",
    ]);
    const parentId = requestedParentId ?? existingRow?.parent_agent_id ?? null;
    const parent = parentId ? this.getAgentById(parentId) : null;

    if (parentId && (!parent || parent.disconnectedAt)) {
      throw new Error(`Cannot register supervised Pinet agent; parent ${parentId} is not live.`);
    }
    if (parent && parent.id === agentId) {
      throw new Error("Cannot register a Pinet agent as its own parent.");
    }
    if (parent && this.isAgentAncestor(agentId, parent.id)) {
      throw new Error("Cannot register a Pinet agent under one of its descendants.");
    }

    const supervisionState = parent
      ? "supervised"
      : normalizeAgentSupervisionState(
          getOptionalMetadataString(metadata, ["supervisionState", "pinetSupervisionState"]) ??
            existingRow?.supervision_state,
        );
    const rootAgentId = parent
      ? (parent.rootAgentId ?? parent.id)
      : (getOptionalMetadataString(metadata, ["rootAgentId", "pinetRootAgentId"]) ??
        existingRow?.root_agent_id ??
        null);
    const treeDepth = parent ? (parent.treeDepth ?? 0) + 1 : (existingRow?.tree_depth ?? 0);
    const spawnedByAgentId =
      getOptionalMetadataString(metadata, ["spawnedByAgentId", "pinetSpawnedByAgentId"]) ??
      (parent ? parent.id : (existingRow?.spawned_by_agent_id ?? null));

    return {
      parentAgentId: parent?.id ?? null,
      rootAgentId,
      treeDepth,
      spawnedByAgentId,
      supervisionState,
      launchId:
        getOptionalMetadataString(metadata, ["launchId", "pinetLaunchId"]) ??
        existingRow?.launch_id ??
        null,
      subtreeRole:
        getOptionalMetadataString(metadata, ["subtreeRole", "pinetSubtreeRole"]) ??
        existingRow?.subtree_role ??
        null,
      laneId:
        getOptionalMetadataString(metadata, ["laneId", "pinetLaneId"]) ??
        existingRow?.lane_id ??
        null,
    };
  }

  transitionAgentLifecycle(input: AgentLifecycleTransitionInput): AgentInfo {
    return this.withTransaction(() => {
      const db = this.getDb();
      const current = this.getAgentById(input.agentId);
      if (!current?.lifecycleState || current.lifecycleVersion === undefined) {
        throw new Error(`Unknown lifecycle agent: ${input.agentId}`);
      }
      if (current.lifecycleVersion !== input.expectedVersion) {
        throw new Error(
          `Lifecycle CAS conflict for ${input.agentId}: expected ${input.expectedVersion}, got ${current.lifecycleVersion}`,
        );
      }
      // Fence-identity validation: a transition that presents a fence token must
      // prove it holds the live, matching lease. Lease fences are monotonic per
      // agent (a re-acquisition after expiry bumps the fence), so matching the
      // fence rejects a superseded holder that would otherwise drive a fenced
      // transition purely on a matching version CAS. When the caller also binds
      // the lease identity (`leaseId`/`expectedOperation`/`now`) we additionally
      // reject an expired-but-unsuperseded lease and a wrong-operation lease —
      // the fence token alone is not sufficient authority. Unfenced
      // administrative/recovery transitions (no fenceToken) are unaffected.
      if (input.fenceToken != null) {
        const lease = this.getAgentLifecycleLease(input.agentId);
        if (!lease || lease.fenceToken !== input.fenceToken) {
          throw new Error(
            `Lifecycle fence rejected for ${input.agentId}: presented fence ${input.fenceToken} is not the currently held lease`,
          );
        }
        if (input.leaseId != null && lease.leaseId !== input.leaseId) {
          throw new Error(
            `Lifecycle fence rejected for ${input.agentId}: presented lease is not the currently held lease`,
          );
        }
        if (input.expectedOperation != null && lease.operation !== input.expectedOperation) {
          throw new Error(
            `Lifecycle fence rejected for ${input.agentId}: held lease operation ${lease.operation} does not authorize a ${input.expectedOperation} transition`,
          );
        }
        if (input.now != null && Date.parse(lease.expiresAt) <= input.now) {
          throw new Error(`Lifecycle fence rejected for ${input.agentId}: held lease is expired`);
        }
      }
      assertLegalLifecycleTransition(current.lifecycleState, input.toState);
      const now = new Date().toISOString();
      const result = db
        .prepare(
          `UPDATE agents SET lifecycle_state = ?, lifecycle_version = lifecycle_version + 1,
           hibernated_at = CASE WHEN ? = 'hibernated' THEN ? ELSE hibernated_at END,
           terminated_at = CASE WHEN ? = 'terminated' THEN ? ELSE terminated_at END,
           hibernate_reason = CASE WHEN ? IN ('hibernating','hibernated','reap-candidate') THEN ? ELSE hibernate_reason END,
           last_wake_reason = CASE WHEN ? = 'waking' THEN ? ELSE last_wake_reason END
         WHERE id = ? AND lifecycle_version = ?`,
        )
        .run(
          input.toState,
          input.toState,
          now,
          input.toState,
          now,
          input.toState,
          input.reason,
          input.toState,
          input.reason,
          input.agentId,
          input.expectedVersion,
        );
      if (Number(result.changes) !== 1)
        throw new Error(`Lifecycle CAS conflict for ${input.agentId}`);
      const nextVersion = input.expectedVersion + 1;
      this.insertLifecycleEventRow({
        correlationId: input.correlationId,
        agentId: input.agentId,
        fromState: current.lifecycleState,
        toState: input.toState,
        lifecycleVersion: nextVersion,
        reason: input.reason,
        triggerSource: input.triggerSource,
        actor: input.actor,
        outcome: "accepted",
        fenceToken: input.fenceToken ?? null,
        queueDepth: input.queueDepth ?? null,
        oldestQueueAgeMs: input.oldestQueueAgeMs ?? null,
        durationMs: input.durationMs ?? null,
        rssBytesBefore: input.rssBytesBefore ?? null,
        rssBytesAfter: input.rssBytesAfter ?? null,
        createdAt: now,
      });
      const updated = this.getAgentById(input.agentId);
      if (!updated) throw new Error(`Lifecycle agent disappeared: ${input.agentId}`);
      return updated;
    });
  }

  /**
   * Append an audit-only lifecycle event (a refusal, fenced stale attempt, or
   * duplicate-launch prevention) without changing the agent's lifecycle state.
   */
  recordAgentLifecycleEvent(input: AgentLifecycleEventInput): void {
    this.withTransaction(() => {
      this.insertLifecycleEventRow({
        correlationId: input.correlationId,
        agentId: input.agentId,
        fromState: input.fromState,
        toState: input.toState,
        lifecycleVersion: input.lifecycleVersion,
        reason: input.reason,
        triggerSource: input.triggerSource,
        actor: input.actor,
        outcome: input.outcome,
        errorCode: input.errorCode ?? null,
        fenceToken: input.fenceToken ?? null,
        queueDepth: input.queueDepth ?? null,
        oldestQueueAgeMs: input.oldestQueueAgeMs ?? null,
        durationMs: input.durationMs ?? null,
        rssBytesBefore: input.rssBytesBefore ?? null,
        rssBytesAfter: input.rssBytesAfter ?? null,
        createdAt: new Date().toISOString(),
      });
    });
  }

  private insertLifecycleEventRow(row: {
    correlationId: string;
    agentId: string;
    fromState: AgentLifecycleState;
    toState: AgentLifecycleState;
    lifecycleVersion: number;
    reason: string;
    triggerSource?: string | null;
    actor: string;
    outcome: string;
    errorCode?: string | null;
    fenceToken: number | null;
    queueDepth: number | null;
    oldestQueueAgeMs: number | null;
    durationMs: number | null;
    rssBytesBefore: number | null;
    rssBytesAfter: number | null;
    createdAt: string;
  }): void {
    const db = this.getDb();
    db.prepare(
      `INSERT INTO agent_lifecycle_events
       (correlation_id, agent_id, from_state, to_state, lifecycle_version, fence_token, reason,
        trigger_source, actor, outcome, error_code, queue_depth, oldest_queue_age_ms, duration_ms,
        rss_bytes_before, rss_bytes_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.correlationId,
      row.agentId,
      row.fromState,
      row.toState,
      row.lifecycleVersion,
      row.fenceToken,
      row.reason,
      row.triggerSource ?? null,
      row.actor,
      row.outcome,
      row.errorCode ?? null,
      row.queueDepth,
      row.oldestQueueAgeMs,
      row.durationMs,
      row.rssBytesBefore,
      row.rssBytesAfter,
      row.createdAt,
    );
    const pruned = db
      .prepare(
        `DELETE FROM agent_lifecycle_events WHERE id IN (
        SELECT id FROM agent_lifecycle_events ORDER BY id DESC LIMIT -1 OFFSET 10000
      )`,
      )
      .run();
    if (Number(pruned.changes) > 0) {
      db.prepare(
        `UPDATE agent_lifecycle_retention
         SET pruned_count = pruned_count + ?, last_pruned_at = ? WHERE singleton = 1`,
      ).run(Number(pruned.changes), row.createdAt);
    }
  }

  getRecentAgentLifecycleEvents(agentId?: string, limit = 50): AgentLifecycleEvent[] {
    const db = this.getDb();
    const cappedLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);
    const rows = agentId
      ? db
          .prepare(
            `SELECT * FROM agent_lifecycle_events WHERE agent_id = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(agentId, cappedLimit)
      : db
          .prepare(`SELECT * FROM agent_lifecycle_events ORDER BY id DESC LIMIT ?`)
          .all(cappedLimit);
    return rows.map((row) => ({
      id: Number(row.id),
      correlationId: String(row.correlation_id),
      agentId: String(row.agent_id),
      fromState: String(row.from_state) as AgentLifecycleState,
      toState: String(row.to_state) as AgentLifecycleState,
      lifecycleVersion: Number(row.lifecycle_version),
      fenceToken: row.fence_token == null ? null : Number(row.fence_token),
      reason: String(row.reason),
      triggerSource: row.trigger_source == null ? null : String(row.trigger_source),
      actor: String(row.actor),
      outcome: String(row.outcome),
      errorCode: row.error_code == null ? null : String(row.error_code),
      queueDepth: row.queue_depth == null ? null : Number(row.queue_depth),
      oldestQueueAgeMs: row.oldest_queue_age_ms == null ? null : Number(row.oldest_queue_age_ms),
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      rssBytesBefore: row.rss_bytes_before == null ? null : Number(row.rss_bytes_before),
      rssBytesAfter: row.rss_bytes_after == null ? null : Number(row.rss_bytes_after),
      createdAt: String(row.created_at),
    }));
  }

  getAgentLifecycleRetentionInfo(): AgentLifecycleRetentionInfo {
    const db = this.getDb();
    const retained = db.prepare("SELECT COUNT(*) AS count FROM agent_lifecycle_events").get() as
      | { count: number }
      | undefined;
    const retention = db
      .prepare(
        "SELECT pruned_count, last_pruned_at FROM agent_lifecycle_retention WHERE singleton = 1",
      )
      .get() as { pruned_count: number; last_pruned_at: string | null } | undefined;
    return {
      retainedCount: Number(retained?.count ?? 0),
      prunedCount: Number(retention?.pruned_count ?? 0),
      lastPrunedAt: retention?.last_pruned_at ?? null,
    };
  }

  acquireAgentLifecycleLease(input: {
    agentId: string;
    operation: AgentLifecycleOperation;
    ownerBrokerInstanceId: string;
    leaseId: string;
    ttlMs: number;
    triggerMessageId?: number | null;
    now?: number;
  }): AgentLifecycleLease | null {
    return this.withTransaction(() => {
      const db = this.getDb();
      const nowMs = input.now ?? Date.now();
      const now = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + input.ttlMs).toISOString();
      const existing = db
        .prepare(
          "SELECT fence_token, expires_at, attempt FROM agent_lifecycle_leases WHERE agent_id = ?",
        )
        .get(input.agentId) as
        | { fence_token: number; expires_at: string; attempt: number }
        | undefined;
      if (existing && existing.expires_at > now) return null;
      const fence = (existing?.fence_token ?? 0) + 1;
      const attempt = (existing?.attempt ?? 0) + 1;
      db.prepare(
        `INSERT INTO agent_lifecycle_leases
        (agent_id, operation, fence_token, owner_broker_instance_id, lease_id, acquired_at, expires_at, attempt, trigger_message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET operation=excluded.operation, fence_token=excluded.fence_token,
          owner_broker_instance_id=excluded.owner_broker_instance_id, lease_id=excluded.lease_id,
          acquired_at=excluded.acquired_at, expires_at=excluded.expires_at, attempt=excluded.attempt,
          trigger_message_id=excluded.trigger_message_id`,
      ).run(
        input.agentId,
        input.operation,
        fence,
        input.ownerBrokerInstanceId,
        input.leaseId,
        now,
        expiresAt,
        attempt,
        input.triggerMessageId ?? null,
      );
      return {
        agentId: input.agentId,
        operation: input.operation,
        fenceToken: fence,
        ownerBrokerInstanceId: input.ownerBrokerInstanceId,
        leaseId: input.leaseId,
        acquiredAt: now,
        expiresAt,
        attempt,
        triggerMessageId: input.triggerMessageId ?? null,
      };
    });
  }

  releaseAgentLifecycleLease(agentId: string, leaseId: string, fenceToken: number): boolean {
    const result = this.getDb()
      .prepare(
        "DELETE FROM agent_lifecycle_leases WHERE agent_id = ? AND lease_id = ? AND fence_token = ?",
      )
      .run(agentId, leaseId, fenceToken);
    return Number(result.changes) === 1;
  }

  /**
   * Extend an already-held, still-valid lease's expiry WITHOUT bumping the
   * fence, so a legitimately long-running operation (e.g. a wake that waits on
   * process launch + runtime registration across several attempts) keeps a valid
   * lease across adapter waits and can still complete its fenced forward
   * transition. The fence is preserved so revival fencing is unaffected.
   *
   * Renewal only succeeds while the lease is still unexpired and held by this
   * exact owner (matching `leaseId` + `fenceToken`); this preserves the takeover
   * guarantee (a stalled owner past expiry cannot reclaim a lease another broker
   * may take over). Returns the refreshed lease, or null when ownership was lost
   * (expired, released, or the fence moved) — a null result means the caller
   * must fail closed rather than continue driving forward transitions.
   */
  renewAgentLifecycleLease(input: {
    agentId: string;
    leaseId: string;
    fenceToken: number;
    ttlMs: number;
    now?: number;
  }): AgentLifecycleLease | null {
    return this.withTransaction(() => {
      const db = this.getDb();
      const nowMs = input.now ?? Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + input.ttlMs).toISOString();
      const result = db
        .prepare(
          `UPDATE agent_lifecycle_leases SET expires_at = ?
           WHERE agent_id = ? AND lease_id = ? AND fence_token = ? AND expires_at > ?`,
        )
        .run(expiresAt, input.agentId, input.leaseId, input.fenceToken, nowIso);
      if (Number(result.changes) !== 1) return null;
      return this.getAgentLifecycleLease(input.agentId);
    });
  }

  /** Set the opt-in hibernation policy for an agent (auto | manual | never). */
  setAgentHibernatePolicy(agentId: string, policy: AgentHibernatePolicy): void {
    this.getDb()
      .prepare("UPDATE agents SET hibernate_policy = ? WHERE id = ?")
      .run(policy, agentId);
  }

  /** Record grace/idle eligibility timestamps used by the auto-hibernation scheduler. */
  setAgentHibernationSchedule(
    agentId: string,
    schedule: { graceUntil?: string | null; idleEligibleAt?: string | null },
  ): void {
    const db = this.getDb();
    if (schedule.graceUntil !== undefined) {
      db.prepare("UPDATE agents SET grace_until = ? WHERE id = ?").run(
        schedule.graceUntil,
        agentId,
      );
    }
    if (schedule.idleEligibleAt !== undefined) {
      db.prepare("UPDATE agents SET idle_eligible_at = ? WHERE id = ?").run(
        schedule.idleEligibleAt,
        agentId,
      );
    }
  }

  getAgentLifecycleLease(agentId: string): AgentLifecycleLease | null {
    const row = this.getDb()
      .prepare(
        `SELECT agent_id, operation, fence_token, owner_broker_instance_id, lease_id,
                acquired_at, expires_at, attempt, trigger_message_id
         FROM agent_lifecycle_leases WHERE agent_id = ?`,
      )
      .get(agentId) as
      | {
          agent_id: string;
          operation: string;
          fence_token: number;
          owner_broker_instance_id: string;
          lease_id: string;
          acquired_at: string;
          expires_at: string;
          attempt: number;
          trigger_message_id: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      agentId: row.agent_id,
      operation: row.operation as AgentLifecycleOperation,
      fenceToken: row.fence_token,
      ownerBrokerInstanceId: row.owner_broker_instance_id,
      leaseId: row.lease_id,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
      attempt: row.attempt,
      triggerMessageId: row.trigger_message_id,
    };
  }

  // ─── Durable runtime specs (sanitized launch/resume manifest) ──────

  upsertAgentRuntimeSpec(input: AgentRuntimeSpecInput): AgentRuntimeSpec {
    return this.withTransaction(() => {
      const db = this.getDb();
      const now = new Date().toISOString();
      const existing = db
        .prepare("SELECT created_at FROM agent_runtime_specs WHERE agent_id = ?")
        .get(input.agentId) as { created_at: string } | undefined;
      const createdAt = existing?.created_at ?? now;
      db.prepare(
        `INSERT INTO agent_runtime_specs
         (agent_id, stable_id, broker_owner_id, cwd, repo_root, worktree_path, tmux_socket,
          tmux_session, tmux_target, executable, argv_json, env_allowlist_json,
          session_resume_ref, config_fingerprint, expected_host, expected_user, launch_source,
          vcs_identity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET stable_id=excluded.stable_id,
           broker_owner_id=excluded.broker_owner_id, cwd=excluded.cwd, repo_root=excluded.repo_root,
           worktree_path=excluded.worktree_path, tmux_socket=excluded.tmux_socket,
           tmux_session=excluded.tmux_session, tmux_target=excluded.tmux_target,
           executable=excluded.executable, argv_json=excluded.argv_json,
           env_allowlist_json=excluded.env_allowlist_json,
           session_resume_ref=excluded.session_resume_ref,
           config_fingerprint=excluded.config_fingerprint, expected_host=excluded.expected_host,
           expected_user=excluded.expected_user, launch_source=excluded.launch_source,
           vcs_identity=excluded.vcs_identity,
           updated_at=excluded.updated_at`,
      ).run(
        input.agentId,
        input.stableId,
        input.brokerOwnerId,
        input.cwd,
        input.repoRoot,
        input.worktreePath,
        input.tmuxSocket,
        input.tmuxSession,
        input.tmuxTarget,
        input.executable,
        JSON.stringify(input.argv),
        JSON.stringify(input.envAllowlist),
        input.sessionResumeRef,
        input.configFingerprint,
        input.expectedHost,
        input.expectedUser,
        input.launchSource,
        input.vcsIdentity ?? null,
        createdAt,
        now,
      );
      const spec = this.getAgentRuntimeSpec(input.agentId);
      if (!spec) throw new Error(`Failed to persist runtime spec for ${input.agentId}`);
      return spec;
    });
  }

  getAgentRuntimeSpec(agentId: string): AgentRuntimeSpec | null {
    const row = this.getDb()
      .prepare("SELECT * FROM agent_runtime_specs WHERE agent_id = ?")
      .get(agentId) as
      | {
          agent_id: string;
          stable_id: string;
          broker_owner_id: string;
          cwd: string;
          repo_root: string;
          worktree_path: string;
          tmux_socket: string;
          tmux_session: string;
          tmux_target: string;
          executable: string;
          argv_json: string;
          env_allowlist_json: string;
          session_resume_ref: string;
          config_fingerprint: string;
          expected_host: string;
          expected_user: string;
          launch_source: string;
          vcs_identity: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      agentId: row.agent_id,
      stableId: row.stable_id,
      brokerOwnerId: row.broker_owner_id,
      cwd: row.cwd,
      repoRoot: row.repo_root,
      worktreePath: row.worktree_path,
      tmuxSocket: row.tmux_socket,
      tmuxSession: row.tmux_session,
      tmuxTarget: row.tmux_target,
      executable: row.executable,
      argv: parseStringArray(row.argv_json),
      envAllowlist: parseStringArray(row.env_allowlist_json),
      sessionResumeRef: row.session_resume_ref,
      configFingerprint: row.config_fingerprint,
      expectedHost: row.expected_host,
      expectedUser: row.expected_user,
      launchSource: row.launch_source,
      vcsIdentity: row.vcs_identity ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  deleteAgentRuntimeSpec(agentId: string): void {
    this.getDb().prepare("DELETE FROM agent_runtime_specs WHERE agent_id = ?").run(agentId);
  }

  // ─── Cooperative checkpoint receipts ───────────────────────────────

  recordAgentCheckpointReceipt(input: AgentCheckpointReceiptInput): AgentCheckpointReceipt {
    const now = new Date().toISOString();
    this.getDb()
      .prepare(
        `INSERT INTO agent_checkpoint_receipts
         (agent_id, runtime_generation, correlation_id, hibernate_safe, reason,
          session_resume_ref, pending_inbox_count, rss_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, runtime_generation) DO UPDATE SET correlation_id=excluded.correlation_id,
           hibernate_safe=excluded.hibernate_safe, reason=excluded.reason,
           session_resume_ref=excluded.session_resume_ref,
           pending_inbox_count=excluded.pending_inbox_count, rss_bytes=excluded.rss_bytes,
           created_at=excluded.created_at`,
      )
      .run(
        input.agentId,
        input.runtimeGeneration,
        input.correlationId,
        input.hibernateSafe ? 1 : 0,
        input.reason ?? null,
        input.sessionResumeRef ?? null,
        input.pendingInboxCount,
        input.rssBytes ?? null,
        now,
      );
    return { ...input, createdAt: now };
  }

  getLatestAgentCheckpointReceipt(agentId: string): AgentCheckpointReceipt | null {
    const row = this.getDb()
      .prepare(
        `SELECT agent_id, runtime_generation, correlation_id, hibernate_safe, reason,
                session_resume_ref, pending_inbox_count, rss_bytes, created_at
         FROM agent_checkpoint_receipts WHERE agent_id = ?
         ORDER BY runtime_generation DESC LIMIT 1`,
      )
      .get(agentId) as
      | {
          agent_id: string;
          runtime_generation: number;
          correlation_id: string;
          hibernate_safe: number;
          reason: string | null;
          session_resume_ref: string | null;
          pending_inbox_count: number;
          rss_bytes: number | null;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      agentId: row.agent_id,
      runtimeGeneration: row.runtime_generation,
      correlationId: row.correlation_id,
      hibernateSafe: row.hibernate_safe === 1,
      reason: row.reason,
      sessionResumeRef: row.session_resume_ref,
      pendingInboxCount: row.pending_inbox_count,
      rssBytes: row.rss_bytes,
      createdAt: row.created_at,
    };
  }

  // ─── Accepted-generation fencing (single-winner cold wake) ─────────

  /**
   * Reserve the exact runtime generation the broker will accept for a wake.
   * Requires an unexpired wake lease held with the given fence token. Exactly
   * one reservation may exist per agent (PK). The reserved generation is the
   * agent's current runtime_generation + 1, so any older runtime is fenced out.
   */
  reserveWakeGeneration(input: {
    agentId: string;
    wakeLeaseId: string;
    fenceToken: number;
    correlationId: string;
    /** Optional injected nonce (tests); production mints a fresh UUID. */
    reservationNonce?: string;
    now?: number;
  }): AgentWakeReservation {
    return this.withTransaction(() => {
      const db = this.getDb();
      const nowIso = new Date(input.now ?? Date.now()).toISOString();
      const lease = this.getAgentLifecycleLease(input.agentId);
      if (
        !lease ||
        lease.operation !== "wake" ||
        lease.leaseId !== input.wakeLeaseId ||
        lease.fenceToken !== input.fenceToken
      ) {
        throw new Error(
          `Wake reservation requires a matching held wake lease for ${input.agentId}`,
        );
      }
      if (lease.expiresAt <= nowIso) {
        throw new Error(`Wake lease for ${input.agentId} has expired`);
      }
      const agent = this.getAgentById(input.agentId);
      if (!agent) throw new Error(`Unknown agent for wake reservation: ${input.agentId}`);
      const reservedGeneration = (agent.runtimeGeneration ?? 0) + 1;
      // Mint a fresh per-attempt nonce. Successive wake attempts for the same
      // identity necessarily reuse the same lease id, fence token, and
      // `reserved_generation` (= runtime_generation + 1, which does not advance
      // until a runtime is accepted), so those three fields alone cannot tell a
      // slow, timed-out earlier attempt's runtime apart from the current
      // attempt's runtime. The nonce, minted here and threaded through the launch
      // context into the runtime's registration, fences the earlier runtime out.
      const reservationNonce = input.reservationNonce ?? crypto.randomUUID();
      // A NEW wake attempt supersedes any prior acceptance receipt: clear it so a
      // stale fence from a previously-accepted (crash-stranded) runtime can never
      // be replayed to rebind during this fresh wake window.
      db.prepare("DELETE FROM agent_wake_acceptance_receipts WHERE agent_id = ?").run(
        input.agentId,
      );
      db.prepare(
        `INSERT INTO agent_wake_reservations
         (agent_id, wake_lease_id, fence_token, reserved_generation, reservation_nonce,
          correlation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET wake_lease_id=excluded.wake_lease_id,
           fence_token=excluded.fence_token, reserved_generation=excluded.reserved_generation,
           reservation_nonce=excluded.reservation_nonce,
           correlation_id=excluded.correlation_id, created_at=excluded.created_at`,
      ).run(
        input.agentId,
        input.wakeLeaseId,
        input.fenceToken,
        reservedGeneration,
        reservationNonce,
        input.correlationId,
        nowIso,
      );
      return {
        agentId: input.agentId,
        wakeLeaseId: input.wakeLeaseId,
        fenceToken: input.fenceToken,
        reservedGeneration,
        reservationNonce,
        correlationId: input.correlationId,
        createdAt: nowIso,
      };
    });
  }

  getAgentWakeReservation(agentId: string): AgentWakeReservation | null {
    const row = this.getDb()
      .prepare(
        `SELECT agent_id, wake_lease_id, fence_token, reserved_generation, reservation_nonce,
                correlation_id, created_at
         FROM agent_wake_reservations WHERE agent_id = ?`,
      )
      .get(agentId) as
      | {
          agent_id: string;
          wake_lease_id: string;
          fence_token: number;
          reserved_generation: number;
          reservation_nonce: string;
          correlation_id: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      agentId: row.agent_id,
      wakeLeaseId: row.wake_lease_id,
      fenceToken: row.fence_token,
      reservedGeneration: row.reserved_generation,
      reservationNonce: row.reservation_nonce,
      correlationId: row.correlation_id,
      createdAt: row.created_at,
    };
  }

  clearAgentWakeReservation(agentId: string): void {
    this.getDb().prepare("DELETE FROM agent_wake_reservations WHERE agent_id = ?").run(agentId);
  }

  /**
   * Record the EXACT wake fence that just accepted a generation, so a runtime
   * whose register RPC response was lost to a crash can replay its single-use
   * fence and be re-bound idempotently. Called INSIDE the acceptance transaction
   * (via {@link acceptRuntimeGeneration} / {@link registerAgentWithGenerationAcceptance})
   * so the receipt is atomic with the generation advance. The stable id is read
   * from the just-registered row so the receipt binds to the durable identity.
   */
  private writeWakeAcceptanceReceipt(input: AcceptRuntimeGenerationInput, nowMs: number): void {
    const db = this.getDb();
    const row = db.prepare("SELECT stable_id FROM agents WHERE id = ?").get(input.agentId) as
      | { stable_id: string | null }
      | undefined;
    const stableId = row?.stable_id;
    // Only a durable stable identity can be revived by a fenced replay; a row
    // without a stable id cannot be a hibernation identity, so no receipt.
    if (!stableId) return;
    db.prepare(
      `INSERT INTO agent_wake_acceptance_receipts
         (agent_id, stable_id, wake_lease_id, fence_token, reserved_generation,
          reservation_nonce, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET stable_id=excluded.stable_id,
         wake_lease_id=excluded.wake_lease_id, fence_token=excluded.fence_token,
         reserved_generation=excluded.reserved_generation,
         reservation_nonce=excluded.reservation_nonce, accepted_at=excluded.accepted_at`,
    ).run(
      input.agentId,
      stableId,
      input.wakeLeaseId,
      input.fenceToken,
      input.reservedGeneration,
      input.reservationNonce,
      new Date(nowMs).toISOString(),
    );
  }

  getAgentWakeAcceptanceReceipt(agentId: string): AgentWakeAcceptanceReceipt | null {
    const row = this.getDb()
      .prepare(
        `SELECT agent_id, stable_id, wake_lease_id, fence_token, reserved_generation,
                reservation_nonce, accepted_at
         FROM agent_wake_acceptance_receipts WHERE agent_id = ?`,
      )
      .get(agentId) as
      | {
          agent_id: string;
          stable_id: string;
          wake_lease_id: string;
          fence_token: number;
          reserved_generation: number;
          reservation_nonce: string;
          accepted_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      agentId: row.agent_id,
      stableId: row.stable_id,
      wakeLeaseId: row.wake_lease_id,
      fenceToken: row.fence_token,
      reservedGeneration: row.reserved_generation,
      reservationNonce: row.reservation_nonce,
      acceptedAt: row.accepted_at,
    };
  }

  /**
   * Accept exactly one runtime generation for a waking agent. The registration
   * must present the same wake lease id, fence token, and reserved generation,
   * AND the bound lease must still be an unexpired `wake` lease while the agent
   * is still in the `waking` lifecycle state. A stale, expired, wrong-operation,
   * wrong-state, or duplicate registration returns `{ accepted: false }` without
   * mutating state. On success the agent's runtime_generation is advanced and
   * the reservation is consumed. `now` (epoch ms) is injectable for tests.
   */
  /**
   * Non-mutating validation shared by {@link acceptRuntimeGeneration} and
   * {@link checkRuntimeGenerationAcceptable}. Returns a `{ accepted: false }`
   * rejection when the fence does not bind, or `null` when acceptance is legal.
   * Never advances the generation or consumes the reservation.
   */
  private validateRuntimeGenerationAcceptance(
    input: AcceptRuntimeGenerationInput,
    nowMs: number,
  ): Extract<RuntimeGenerationAcceptance, { accepted: false }> | null {
    const db = this.getDb();
    const reservation = this.getAgentWakeReservation(input.agentId);
    if (!reservation) return { accepted: false, reason: "no_reservation" };
    if (reservation.wakeLeaseId !== input.wakeLeaseId) {
      return { accepted: false, reason: "lease_mismatch" };
    }
    if (reservation.fenceToken !== input.fenceToken) {
      return { accepted: false, reason: "fence_mismatch" };
    }
    if (reservation.reservedGeneration !== input.reservedGeneration) {
      return { accepted: false, reason: "generation_mismatch" };
    }
    // Per-attempt nonce: a matching lease/fence/generation is NOT sufficient,
    // because retries reuse all three. Only the runtime launched by THIS
    // attempt carries the current reservation's nonce; a slow runtime from a
    // superseded earlier attempt presents a stale nonce and is fenced out.
    if (reservation.reservationNonce !== input.reservationNonce) {
      return { accepted: false, reason: "nonce_mismatch" };
    }
    const lease = this.getAgentLifecycleLease(input.agentId);
    if (!lease || lease.leaseId !== input.wakeLeaseId || lease.fenceToken !== input.fenceToken) {
      return { accepted: false, reason: "lease_lost" };
    }
    // Strict lease binding: only an unexpired wake lease may accept a
    // generation, and only while the agent is still waking. This closes the
    // window where a delayed runtime presents an otherwise matching
    // reservation under an expired/wrong-operation lease or after the wake
    // was already resolved/aborted.
    if (lease.operation !== "wake") {
      return { accepted: false, reason: "lease_not_wake" };
    }
    const leaseExpiryMs = Date.parse(lease.expiresAt);
    if (!Number.isFinite(leaseExpiryMs) || leaseExpiryMs <= nowMs) {
      return { accepted: false, reason: "lease_expired" };
    }
    const stateRow = db
      .prepare("SELECT lifecycle_state, runtime_generation FROM agents WHERE id = ?")
      .get(input.agentId) as { lifecycle_state: string; runtime_generation: number } | undefined;
    if (!stateRow || stateRow.lifecycle_state !== "waking") {
      return { accepted: false, reason: "not_waking" };
    }
    if (Number(stateRow.runtime_generation) !== input.reservedGeneration - 1) {
      return { accepted: false, reason: "generation_race" };
    }
    return null;
  }

  acceptRuntimeGeneration(input: AcceptRuntimeGenerationInput): RuntimeGenerationAcceptance {
    return this.withTransaction(() => {
      const db = this.getDb();
      const nowMs = input.now ?? Date.now();
      const rejection = this.validateRuntimeGenerationAcceptance(input, nowMs);
      if (rejection) return rejection;
      const result = db
        .prepare("UPDATE agents SET runtime_generation = ? WHERE id = ? AND runtime_generation = ?")
        .run(input.reservedGeneration, input.agentId, input.reservedGeneration - 1);
      if (Number(result.changes) !== 1) {
        return { accepted: false as const, reason: "generation_race" };
      }
      db.prepare("DELETE FROM agent_wake_reservations WHERE agent_id = ?").run(input.agentId);
      // Persist the accepting fence so a crash between this commit and the socket
      // bind/response can be recovered by an idempotent fenced replay.
      this.writeWakeAcceptanceReceipt(input, nowMs);
      return { accepted: true as const, runtimeGeneration: input.reservedGeneration };
    });
  }

  /**
   * Atomically settle a wake attempt against the acceptance boundary BEFORE the
   * orchestrator stops or quarantines a launched-but-unaccepted runtime. This
   * closes the timeout-boundary race: the socket layer accepts a generation
   * atomically, so an acceptance can land in the window between the
   * orchestrator's last waiter read and its decision to stop the attempt. In one
   * transaction:
   *
   *  - If the reserved generation was ALREADY accepted (the agent's
   *    `runtime_generation` reached `reservedGeneration` — the socket won the
   *    race), report `{ accepted: true }` and leave the accepted runtime and its
   *    (already consumed) reservation untouched. The caller must then treat the
   *    attempt as the live runtime and NEVER stop it.
   *  - Otherwise, consume ONLY this attempt's exact-nonce reservation, so any
   *    later registration by the launched runtime can no longer be accepted
   *    (`no_reservation`). This makes the caller's subsequent prove-stop safe:
   *    once this returns `{ accepted: false }` the launched runtime can never
   *    become live. A reservation minted by a superseded/newer attempt (a
   *    different nonce) is left intact.
   *
   * `runtime_generation === reservedGeneration` uniquely identifies acceptance of
   * THIS attempt because reserved generations are `current_generation + 1` at
   * reserve time and only advance on acceptance.
   */
  finalizeWakeAttempt(input: {
    agentId: string;
    reservedGeneration: number;
    reservationNonce: string;
  }): { accepted: boolean } {
    return this.withTransaction(() => {
      const db = this.getDb();
      const row = db
        .prepare("SELECT runtime_generation FROM agents WHERE id = ?")
        .get(input.agentId) as { runtime_generation: number } | undefined;
      if (row && Number(row.runtime_generation) === input.reservedGeneration) {
        return { accepted: true };
      }
      db.prepare(
        "DELETE FROM agent_wake_reservations WHERE agent_id = ? AND reservation_nonce = ?",
      ).run(input.agentId, input.reservationNonce);
      return { accepted: false };
    });
  }

  /**
   * Atomically revive a hibernated identity: perform the agent registration
   * mutation AND accept the reserved runtime generation in ONE transaction, so a
   * rejected acceptance rolls the registration mutation back. This closes the
   * window where a revival whose wake lease expires between the socket-layer
   * preflight and acceptance would otherwise leave the durable row with a
   * mutated pid/metadata/connectivity even though the socket is refused and
   * unbound. On rejection the transaction is rolled back and `agent` is null.
   */
  registerAgentWithGenerationAcceptance(input: {
    registration: {
      id: string;
      name: string;
      emoji: string;
      pid: number;
      // Reuse the roster metadata shape rather than restating it, so this stays
      // in lockstep with `registerAgent` / `AgentInfo`.
      metadata?: NonNullable<AgentInfo["metadata"]>;
      stableId?: string;
    };
    accept: AcceptRuntimeGenerationInput;
  }): { agent: AgentInfo | null; acceptance: RuntimeGenerationAcceptance } {
    try {
      return this.withTransaction(() => {
        const db = this.getDb();
        const nowMs = input.accept.now ?? Date.now();
        // Register first so the durable row exists/updates, then accept the
        // generation against that just-registered row within the same tx.
        const agent = this.registerAgent(
          input.registration.id,
          input.registration.name,
          input.registration.emoji,
          input.registration.pid,
          input.registration.metadata,
          input.registration.stableId,
        );
        const rejection = this.validateRuntimeGenerationAcceptance(input.accept, nowMs);
        if (rejection) throw new GenerationAcceptanceRollback(rejection);
        const result = db
          .prepare(
            "UPDATE agents SET runtime_generation = ? WHERE id = ? AND runtime_generation = ?",
          )
          .run(
            input.accept.reservedGeneration,
            input.accept.agentId,
            input.accept.reservedGeneration - 1,
          );
        if (Number(result.changes) !== 1) {
          throw new GenerationAcceptanceRollback({ accepted: false, reason: "generation_race" });
        }
        db.prepare("DELETE FROM agent_wake_reservations WHERE agent_id = ?").run(
          input.accept.agentId,
        );
        // Persist the accepting fence (atomic with the registration + acceptance)
        // so a crash before this connection is bound/acknowledged can be recovered
        // by an idempotent fenced replay of the same single-use wake fence.
        this.writeWakeAcceptanceReceipt(input.accept, nowMs);
        return {
          agent,
          acceptance: {
            accepted: true as const,
            runtimeGeneration: input.accept.reservedGeneration,
          },
        };
      });
    } catch (err) {
      if (err instanceof GenerationAcceptanceRollback) {
        return { agent: null, acceptance: err.rejection };
      }
      throw err;
    }
  }

  /**
   * Non-mutating preflight for {@link acceptRuntimeGeneration}: runs the exact
   * same fence validation without advancing the generation or consuming the
   * reservation. The socket layer uses this to validate a wake fence BEFORE
   * committing the agent registration, and only accepts the generation once
   * registration has succeeded. Because broker registration is synchronous, a
   * passing preflight followed immediately by `acceptRuntimeGeneration` cannot
   * be interleaved by another connection, so this closes the window where a
   * generation was advanced for a runtime whose registration then failed.
   */
  checkRuntimeGenerationAcceptable(
    input: AcceptRuntimeGenerationInput,
  ): RuntimeGenerationAcceptance {
    const nowMs = input.now ?? Date.now();
    return (
      this.validateRuntimeGenerationAcceptance(input, nowMs) ?? {
        accepted: true as const,
        runtimeGeneration: input.reservedGeneration,
      }
    );
  }

  // ─── Wake queue (ordered, capacity-bounded) ────────────────────────

  /**
   * Idempotently enqueue a wake trigger. If an active (queued/dispatching)
   * entry already exists for the agent it is returned unchanged except that the
   * effective priority is lowered to the strongest (smallest) trigger and the
   * trigger message id is preserved when still unset. Never fans out.
   */
  enqueueWake(input: EnqueueWakeInput): AgentWakeQueueEntry {
    return this.withTransaction(() => {
      const db = this.getDb();
      const now = new Date().toISOString();
      const priority = input.priority ?? 100;
      const existing = this.getActiveWakeQueueEntry(input.agentId);
      if (existing) {
        const nextPriority = Math.min(existing.priority, priority);
        const nextTriggerMessageId = existing.triggerMessageId ?? input.triggerMessageId ?? null;
        db.prepare(
          `UPDATE agent_wake_queue
           SET priority = ?, trigger_message_id = ?, updated_at = ?
           WHERE id = ?`,
        ).run(nextPriority, nextTriggerMessageId, now, existing.id);
        const refreshed = this.getWakeQueueEntryById(existing.id);
        if (!refreshed) throw new Error("Failed to refresh wake queue entry");
        return refreshed;
      }
      const inserted = db
        .prepare(
          `INSERT INTO agent_wake_queue
           (agent_id, repo_root, trigger_kind, trigger_message_id, priority, reason,
            correlation_id, status, attempt, enqueued_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
        )
        .run(
          input.agentId,
          input.repoRoot ?? null,
          input.triggerKind,
          input.triggerMessageId ?? null,
          priority,
          input.reason,
          input.correlationId,
          now,
          now,
        );
      const entry = this.getWakeQueueEntryById(Number(inserted.lastInsertRowid));
      if (!entry) throw new Error("Failed to enqueue wake");
      return entry;
    });
  }

  private getActiveWakeQueueEntry(agentId: string): AgentWakeQueueEntry | null {
    const row = this.getDb()
      .prepare(
        `SELECT * FROM agent_wake_queue
         WHERE agent_id = ? AND status IN ('queued','dispatching') LIMIT 1`,
      )
      .get(agentId) as WakeQueueRow | undefined;
    return row ? rowToWakeQueueEntry(row) : null;
  }

  private getWakeQueueEntryById(id: number): AgentWakeQueueEntry | null {
    const row = this.getDb().prepare("SELECT * FROM agent_wake_queue WHERE id = ?").get(id) as
      | WakeQueueRow
      | undefined;
    return row ? rowToWakeQueueEntry(row) : null;
  }

  listWakeQueue(status?: AgentWakeQueueEntry["status"]): AgentWakeQueueEntry[] {
    const db = this.getDb();
    const rows = status
      ? db
          .prepare("SELECT * FROM agent_wake_queue WHERE status = ? ORDER BY priority ASC, id ASC")
          .all(status)
      : db.prepare("SELECT * FROM agent_wake_queue ORDER BY priority ASC, id ASC").all();
    return rows.map((row) =>
      rowToWakeQueueEntry({
        id: Number(row.id),
        agent_id: String(row.agent_id),
        repo_root: row.repo_root == null ? null : String(row.repo_root),
        trigger_kind: String(row.trigger_kind),
        trigger_message_id: row.trigger_message_id == null ? null : Number(row.trigger_message_id),
        priority: Number(row.priority),
        reason: String(row.reason),
        correlation_id: String(row.correlation_id),
        status: String(row.status),
        attempt: Number(row.attempt),
        enqueued_at: String(row.enqueued_at),
        updated_at: String(row.updated_at),
      }),
    );
  }

  countInflightWakes(repoRoot?: string | null): number {
    const db = this.getDb();
    if (repoRoot === undefined) {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM agent_wake_queue WHERE status = 'dispatching'")
        .get() as { count: number } | undefined;
      return Number(row?.count ?? 0);
    }
    const row = db
      .prepare(
        "SELECT COUNT(*) AS count FROM agent_wake_queue WHERE status = 'dispatching' AND repo_root IS ?",
      )
      .get(repoRoot) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  markWakeDispatching(id: number): AgentWakeQueueEntry | null {
    return this.withTransaction(() => {
      const now = new Date().toISOString();
      const result = this.getDb()
        .prepare(
          `UPDATE agent_wake_queue SET status = 'dispatching', attempt = attempt + 1, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(now, id);
      if (Number(result.changes) !== 1) return null;
      return this.getWakeQueueEntryById(id);
    });
  }

  requeueWake(id: number): AgentWakeQueueEntry | null {
    return this.withTransaction(() => {
      const now = new Date().toISOString();
      this.getDb()
        .prepare(
          `UPDATE agent_wake_queue SET status = 'queued', updated_at = ?
           WHERE id = ? AND status = 'dispatching'`,
        )
        .run(now, id);
      return this.getWakeQueueEntryById(id);
    });
  }

  completeWakeQueueEntry(id: number, status: "done" | "cancelled" = "done"): void {
    const now = new Date().toISOString();
    this.getDb()
      .prepare("UPDATE agent_wake_queue SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);
  }

  cancelWake(agentId: string): void {
    const now = new Date().toISOString();
    this.getDb()
      .prepare(
        `UPDATE agent_wake_queue SET status = 'cancelled', updated_at = ?
         WHERE agent_id = ? AND status IN ('queued','dispatching')`,
      )
      .run(now, agentId);
  }

  /** Mark any active wake-queue entry for an agent as completed (idempotent). */
  completeWakeForAgent(agentId: string): void {
    const now = new Date().toISOString();
    this.getDb()
      .prepare(
        `UPDATE agent_wake_queue SET status = 'done', updated_at = ?
         WHERE agent_id = ? AND status IN ('queued','dispatching')`,
      )
      .run(now, agentId);
  }

  unregisterAgent(id: string): void {
    const db = this.getDb();
    const now = new Date().toISOString();

    this.withTransaction(() => {
      const agent = this.getAgentById(id);
      // Durable hibernation identities MUST survive a graceful worker disconnect.
      // During hibernation teardown the broker stops the worker process, whose
      // shutdown path may send an `unregister`. A full teardown here would
      // delete the queued inbox and release owned threads — exactly the durable
      // state a later wake is supposed to drain. For hibernation lifecycle
      // states, treat unregister as a soft disconnect that preserves the inbox,
      // thread ownership, and resumability instead of tearing them down.
      //
      // `reap-candidate` is included: a hibernate/wake fault may have quarantined
      // the agent while its runtime was still asynchronously exiting; a late
      // unregister from that runtime must not destroy the inbox, ownership, and
      // runtime spec an operator needs to review the quarantine. This mirrors the
      // routine-maintenance preservation set.
      const state = agent?.lifecycleState;
      if (
        state === "hibernating" ||
        state === "hibernated" ||
        state === "waking" ||
        state === "reap-candidate"
      ) {
        db.prepare("UPDATE agents SET disconnected_at = ? WHERE id = ?").run(now, id);
        return;
      }
      this.requeueUndeliveredMessagesInternal(id, "agent_disconnected");
      db.prepare("DELETE FROM inbox WHERE agent_id = ?").run(id);
      db.prepare("UPDATE agents SET disconnected_at = ?, resumable_until = NULL WHERE id = ?").run(
        now,
        id,
      );
      db.prepare("UPDATE threads SET owner_agent = NULL WHERE owner_agent = ?").run(id);
      if (agent?.parentAgentId) {
        this.notifyParentOfChildExit(agent, "unregistered");
      }
      this.markDescendantsOrphaned(id, "parent_unregistered");
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

  private getDirectChildren(parentAgentId: string): AgentInfo[] {
    const rows = this.getDb()
      .prepare("SELECT * FROM agents WHERE parent_agent_id = ? ORDER BY connected_at ASC")
      .all(parentAgentId) as unknown as AgentRow[];
    return rows.map(rowToAgent);
  }

  getAgentDescendants(parentAgentId: string, includeDisconnected = false): AgentInfo[] {
    const descendants: AgentInfo[] = [];
    const seen = new Set<string>();
    const queue = this.getDirectChildren(parentAgentId);
    while (queue.length > 0) {
      const child = queue.shift();
      if (!child || seen.has(child.id)) continue;
      seen.add(child.id);
      if (includeDisconnected || !child.disconnectedAt) {
        descendants.push(child);
      }
      queue.push(...this.getDirectChildren(child.id));
    }
    return descendants;
  }

  isAgentAncestor(ancestorAgentId: string, descendantAgentId: string): boolean {
    let current = this.getAgentById(descendantAgentId);
    const seen = new Set<string>();
    while (current?.parentAgentId) {
      if (current.parentAgentId === ancestorAgentId) return true;
      if (seen.has(current.parentAgentId)) return false;
      seen.add(current.parentAgentId);
      current = this.getAgentById(current.parentAgentId);
    }
    return false;
  }

  private notifyParentOfChildExit(agent: AgentInfo, reason: string): void {
    const parentId = agent.parentAgentId;
    if (!parentId) return;
    const parent = this.getAgentById(parentId);
    if (!parent || parent.disconnectedAt) return;
    const threadId = `a2a:${agent.id}:${parentId}`;
    this.createThread(threadId, "agent", `agent:${parentId}`, parentId);
    this.insertMessage(
      threadId,
      "agent",
      "inbound",
      agent.id,
      `Child worker ${agent.name} (${agent.id}) exited: ${reason}.`,
      [parentId],
      {
        a2a: true,
        senderAgent: agent.name,
        pinetMailClass: "fwup",
        subtree: true,
        childAgentId: agent.id,
        parentAgentId: parentId,
        lifecycle: "child_exit",
        reason,
      },
    );
  }

  private markDescendantsOrphaned(parentAgentId: string, reason: string): void {
    const descendants = this.getAgentDescendants(parentAgentId, true);
    if (descendants.length === 0) return;
    const db = this.getDb();
    const update = db.prepare(
      "UPDATE agents SET supervision_state = 'orphaned', parent_agent_id = NULL WHERE id = ?",
    );
    for (const child of descendants) {
      update.run(child.id);
      if (!child.disconnectedAt) {
        const threadId = `a2a:${parentAgentId}:${child.id}`;
        this.createThread(threadId, "agent", `agent:${child.id}`, child.id);
        this.insertMessage(
          threadId,
          "agent",
          "inbound",
          parentAgentId,
          `Parent worker ${parentAgentId} is no longer supervising this subtree (${reason}); this worker is now orphaned and should stop or await broker recovery instructions.`,
          [child.id],
          {
            a2a: true,
            senderAgent: "Pinet lifecycle",
            pinetMailClass: "steering",
            subtree: true,
            parentAgentId,
            childAgentId: child.id,
            lifecycle: "parent_orphaned_child",
            reason,
          },
        );
      }
    }
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

  private getAgentRelatedThreadIds(agentId: string, limit = 12): string[] {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT thread_id, MAX(activity_at) AS activity_at
         FROM (
           SELECT thread_id, updated_at AS activity_at
             FROM threads
            WHERE owner_agent = ? OR channel = ?
           UNION ALL
           SELECT thread_id, created_at AS activity_at
             FROM messages
            WHERE sender = ?
           UNION ALL
           SELECT m.thread_id, i.created_at AS activity_at
             FROM inbox i
             JOIN messages m ON m.id = i.message_id
            WHERE i.agent_id = ?
           UNION ALL
           SELECT thread_id, updated_at AS activity_at
             FROM threads
            WHERE thread_id LIKE ? OR thread_id LIKE ?
         ) related
         GROUP BY thread_id
         ORDER BY activity_at DESC
         LIMIT ?`,
      )
      .all(
        agentId,
        `agent:${agentId}`,
        agentId,
        agentId,
        `a2a:${agentId}:%`,
        `a2a:%:${agentId}`,
        limit,
      ) as Array<{ thread_id: string }>;
    return rows.map((row) => row.thread_id);
  }

  searchAgentSessions(options: AgentSessionSearchOptions = {}): AgentSessionSearchInfo[] {
    const agentName = normalizeSessionSearchNeedle(options.agentName);
    const agentId = normalizeSessionSearchNeedle(options.agentId);
    const threadId = normalizeSessionSearchNeedle(options.threadId);
    const repo = normalizeSessionSearchNeedle(options.repo);
    const worktreePath = normalizeSessionSearchNeedle(options.worktreePath);
    const tmuxSession = normalizeSessionSearchNeedle(options.tmuxSession);
    const sinceMs = parseSessionSearchTime(options.since);
    const untilMs = parseSessionSearchTime(options.until);
    const limit = normalizeSessionSearchLimit(options.limit);

    const results = this.getAllAgents()
      .map((agent) => {
        const metadata = agent.metadata ?? null;
        const relatedThreadIds = this.getAgentRelatedThreadIds(agent.id);
        const matchedBy = getAgentSessionMatchedBy({ agent, metadata, relatedThreadIds, options });
        return {
          agent,
          metadata,
          relatedThreadIds,
          matchedBy,
          lastSeenMs: Date.parse(agent.lastSeen || agent.lastHeartbeat || agent.connectedAt),
        };
      })
      .filter(({ agent, metadata, relatedThreadIds }) => {
        if (agentName && !matchesSessionSearchNeedle(agent.name, agentName)) return false;
        if (agentId && !matchesSessionSearchPrefixOrExact(agent.id, agentId)) return false;
        if (
          threadId &&
          !relatedThreadIds.some((candidate) => candidate.toLowerCase().includes(threadId))
        ) {
          return false;
        }
        if (repo) {
          const values = [
            getOptionalNestedMetadataString(metadata, ["repo"]),
            getOptionalNestedMetadataString(metadata, ["repoRoot"]),
            getOptionalNestedMetadataString(metadata, ["cwd"]),
          ];
          if (!values.some((value) => matchesSessionSearchNeedle(value, repo))) return false;
        }
        if (worktreePath) {
          const values = [
            getOptionalNestedMetadataString(metadata, ["worktreePath"]),
            getOptionalNestedMetadataString(metadata, ["cwd"]),
            getOptionalNestedMetadataString(metadata, ["repoRoot"]),
          ];
          if (!values.some((value) => matchesSessionSearchNeedle(value, worktreePath))) {
            return false;
          }
        }
        if (tmuxSession) {
          const tmux = getOptionalNestedMetadataString(metadata, ["tmuxSession", "tmux"]);
          if (!matchesSessionSearchNeedle(tmux, tmuxSession)) return false;
        }
        return agentSessionOverlapsRange(agent, sinceMs, untilMs);
      })
      .sort((left, right) => {
        const liveDelta =
          Number(Boolean(left.agent.disconnectedAt)) - Number(Boolean(right.agent.disconnectedAt));
        if (liveDelta !== 0) return liveDelta;
        const leftSeen = Number.isNaN(left.lastSeenMs) ? 0 : left.lastSeenMs;
        const rightSeen = Number.isNaN(right.lastSeenMs) ? 0 : right.lastSeenMs;
        if (leftSeen !== rightSeen) return rightSeen - leftSeen;
        return left.agent.name.localeCompare(right.agent.name);
      })
      .slice(0, limit)
      .map(({ agent, metadata, relatedThreadIds, matchedBy }) => ({
        agentId: agent.id,
        agentName: agent.name,
        emoji: agent.emoji,
        pid: agent.pid,
        status: agent.status,
        stableId: agent.stableId ?? null,
        connectedAt: agent.connectedAt,
        lastSeen: agent.lastSeen,
        lastHeartbeat: agent.lastHeartbeat,
        disconnectedAt: agent.disconnectedAt ?? null,
        resumableUntil: agent.resumableUntil ?? null,
        idleSince: agent.idleSince ?? null,
        lastActivity: agent.lastActivity ?? null,
        cwd: getOptionalNestedMetadataString(metadata, ["cwd"]),
        repo: getOptionalNestedMetadataString(metadata, ["repo"]),
        repoRoot: getOptionalNestedMetadataString(metadata, ["repoRoot"]),
        worktreePath: getOptionalNestedMetadataString(metadata, ["worktreePath"]),
        branch: getOptionalNestedMetadataString(metadata, ["branch"]),
        tmuxSession: getOptionalNestedMetadataString(metadata, ["tmuxSession", "tmux"]),
        brokerManaged: metadata?.brokerManaged === true,
        brokerManagedBy: getOptionalNestedMetadataString(metadata, ["brokerManagedBy"]),
        launchSource: getOptionalNestedMetadataString(metadata, ["launchSource"]),
        parentAgentId: agent.parentAgentId ?? null,
        rootAgentId: agent.rootAgentId ?? null,
        treeDepth: agent.treeDepth ?? 0,
        supervisionState: agent.supervisionState ?? "root",
        subtreeRole: agent.subtreeRole ?? null,
        laneId: agent.laneId ?? null,
        relatedThreadIds,
        matchedBy,
      }));

    return results;
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
          `SELECT * FROM agents
           WHERE lifecycle_state NOT IN (${PRESERVED_LIFECYCLE_STATES_SQL})
             AND ((disconnected_at IS NULL AND last_heartbeat <= ?)
              OR (disconnected_at IS NOT NULL AND resumable_until IS NOT NULL AND resumable_until <= ?))`,
        )
        .all(cutoff, now) as unknown as AgentRow[];

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
        const agent = rowToAgent(row);
        this.requeueUndeliveredMessagesInternal(row.id, "agent_disconnected");
        disconnectAgent.run(now, row.id);
        releaseClaims.run(row.id);
        if (agent.parentAgentId) {
          this.notifyParentOfChildExit(agent, "stale_heartbeat");
        }
        this.markDescendantsOrphaned(row.id, "parent_stale");
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
          `SELECT * FROM agents
           WHERE lifecycle_state NOT IN (${PRESERVED_LIFECYCLE_STATES_SQL})
             AND disconnected_at IS NOT NULL
             AND disconnected_at <= ?
             AND (resumable_until IS NULL OR resumable_until <= ?)`,
        )
        .all(cutoff, nowIso) as unknown as AgentRow[];

      if (rows.length === 0) {
        return [];
      }

      const releaseThreads = db.prepare(
        "UPDATE threads SET owner_agent = NULL WHERE owner_agent = ?",
      );
      const deleteInbox = db.prepare("DELETE FROM inbox WHERE agent_id = ?");

      for (const row of rows) {
        const agent = rowToAgent(row);
        // Requeue undelivered messages to the backlog
        this.requeueUndeliveredMessagesInternal(row.id, "agent_disconnected");
        // Release thread ownership for the purged agent
        releaseThreads.run(row.id);
        // Clean up all inbox entries (both delivered and undelivered) for the agent
        deleteInbox.run(row.id);
        if (agent.parentAgentId) {
          this.notifyParentOfChildExit(agent, "purged");
        }
        this.markDescendantsOrphaned(row.id, "parent_purged");
      }

      db.prepare(
        `DELETE FROM agents
         WHERE lifecycle_state NOT IN (${PRESERVED_LIFECYCLE_STATES_SQL})
           AND disconnected_at IS NOT NULL
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

  updateAgentMetadata(id: string, metadata: Record<string, unknown> | null): AgentInfo | null {
    const db = this.getDb();
    if (!this.getAgentRowById(id)) return null;
    db.prepare("UPDATE agents SET metadata = ?, last_seen = ? WHERE id = ?").run(
      metadata ? JSON.stringify(metadata) : null,
      new Date().toISOString(),
      id,
    );
    const updated = this.getAgentRowById(id);
    return updated ? rowToAgent(updated) : null;
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
        updates.source ?? DEFAULT_EXTERNAL_THREAD_SOURCE,
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
             AND m.source <> 'agent'
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

  claimThread(
    threadId: string,
    agentId: string,
    source = DEFAULT_EXTERNAL_THREAD_SOURCE,
    channel = "",
  ): boolean {
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
    this.dropStaleSlackDeliveryRows();
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
    if (status === "pending") {
      this.dropStaleSlackDeliveryRows();
    }
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
      this.dropStaleSlackDeliveryRows(agentId);
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
      if (message && isExternalTransportSource(message.source) && message.direction === "inbound") {
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
    this.dropStaleSlackDeliveryRows(agentId);
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
      this.dropStaleTransportInboxRows(agentId);
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
    options: {
      repoOwner?: string | null;
      repoName?: string | null;
      repoRoot?: string | null;
      taskKind?: TaskAssignmentKind;
    } = {},
  ): TaskAssignmentInfo {
    const db = this.getDb();
    const now = new Date().toISOString();
    const repoOwner = options.repoOwner ?? null;
    const repoName = options.repoName ?? null;
    const repoRoot = options.repoRoot ?? null;
    const repoKey = buildTaskAssignmentRepoKey({ repoOwner, repoName, repoRoot });
    const taskKind = normalizeTaskAssignmentKind(options.taskKind ?? "implementation");
    const existing = db
      .prepare("SELECT * FROM task_assignments WHERE repo_key = ? AND issue_number = ?")
      .get(repoKey, issueNumber) as TaskAssignmentRow | undefined;

    if (!existing) {
      const info = db
        .prepare(
          `INSERT INTO task_assignments (
             agent_id, issue_number, branch, pr_number, status,
             thread_id, source_message_id, repo_key, repo_owner, repo_name, repo_root, task_kind,
             created_at, updated_at
           ) VALUES (?, ?, ?, NULL, 'assigned', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          agentId,
          issueNumber,
          branch,
          threadId,
          sourceMessageId,
          repoKey,
          repoOwner,
          repoName,
          repoRoot,
          taskKind,
          now,
          now,
        );

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
    const nextTaskKind =
      taskKind === "unknown" ? normalizeTaskAssignmentKind(existing.task_kind) : taskKind;
    const shouldResetProgress = isReassignment || nextBranch !== existing.branch;
    db.prepare(
      `UPDATE task_assignments
       SET agent_id = ?,
           branch = ?,
           pr_number = CASE WHEN ? THEN NULL ELSE pr_number END,
           status = CASE WHEN ? THEN 'assigned' ELSE status END,
           thread_id = ?,
           source_message_id = ?,
           repo_owner = ?,
           repo_name = ?,
           repo_root = ?,
           task_kind = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      agentId,
      nextBranch,
      shouldResetProgress ? 1 : 0,
      shouldResetProgress ? 1 : 0,
      threadId,
      sourceMessageId,
      repoOwner,
      repoName,
      repoRoot,
      nextTaskKind,
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
      // Preserve ownership for live agents AND for durable hibernation /
      // quarantine identities: a hibernated owner is intentionally disconnected
      // but must keep its owned threads so a later wake resumes them.
      const rows = db
        .prepare(
          `SELECT owner_agent, COUNT(*) AS claim_count
           FROM threads
           WHERE owner_agent IS NOT NULL
             AND owner_agent NOT IN (
               SELECT id FROM agents
               WHERE disconnected_at IS NULL
                  OR lifecycle_state IN (${PRESERVED_LIFECYCLE_STATES_SQL})
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
             SELECT id FROM agents
             WHERE disconnected_at IS NULL
                OR lifecycle_state IN (${PRESERVED_LIFECYCLE_STATES_SQL})
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
      isExternalTransportSource(message.source) && message.threadId
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
    if (!isExternalTransportSource(message.source)) {
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

    if (metadata.reactionTrigger !== true) return;

    const reactionAction = getStringMetadataValue(metadata, ["reactionAction", "reaction_action"]);
    if (reactionAction !== "steer") return;

    const reactionName = getStringMetadataValue(metadata, ["reactionName", "reaction_name"]);

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
      (referencedChannel && referencedMessageTs
        ? `${referencedChannel}:${referencedMessageTs}`
        : null);
    if (!externalId) return;

    const referenced = this.getMessageByExternalId(referencedSource, externalId);
    if (!referenced) return;

    const targetAgentIds = this.getUnreadReactionEscalationTargets(referenced);
    if (targetAgentIds.length === 0) return;

    const reclassified = this.reclassifyMessageByExternalId(
      referencedSource,
      externalId,
      "steering",
      {
        reason: "reaction_steer",
        reactionName,
        reactorUserId: getStringMetadataValue(metadata, ["reactorUserId", "reactor_user_id"]),
        reactorName: getStringMetadataValue(metadata, ["reactorName", "reactor_name"]),
        reactionEventTs: getStringMetadataValue(metadata, ["reactionEventTs", "reaction_event_ts"]),
        referencedThreadId: message.threadId,
        referencedMessageTs,
      },
    );
    if (reclassified) {
      this.redeliverReclassifiedReactionMessage(reclassified, targetAgentIds);
    }
  }

  private getUnreadReactionEscalationTargets(message: BrokerMessage): string[] {
    const db = this.getDb();
    const ownerAgent = this.getThread(message.threadId)?.ownerAgent;
    if (ownerAgent) {
      const row = db
        .prepare("SELECT 1 FROM inbox WHERE agent_id = ? AND message_id = ? AND read_at IS NULL")
        .get(ownerAgent, message.id);
      return row ? [ownerAgent] : [];
    }

    const existingUnreadRecipients = db
      .prepare("SELECT DISTINCT agent_id FROM inbox WHERE message_id = ? AND read_at IS NULL")
      .all(message.id) as Array<{ agent_id: string }>;

    return existingUnreadRecipients.map((row) => row.agent_id).filter(Boolean);
  }

  private redeliverReclassifiedReactionMessage(
    message: BrokerMessage,
    targetAgentIds: readonly string[],
  ): void {
    if (targetAgentIds.length === 0) return;

    const reopenUnreadInbox = this.getDb().prepare(
      "UPDATE inbox SET delivered = 0 WHERE agent_id = ? AND message_id = ? AND read_at IS NULL",
    );

    for (const agentId of targetAgentIds) {
      reopenUnreadInbox.run(agentId, message.id);
    }
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
    const identity = deriveMessageSyncIdentity(threadId, source, metadata);

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

  getMessageByExternalId(source: string, externalId: string): BrokerMessage | null {
    const messageId = this.getExistingMessageIdForIdentity(source, externalId);
    return messageId === null ? null : this.getMessageById(messageId);
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

  private dropStaleSlackDeliveryRows(agentId?: string): {
    inboxCount: number;
    backlogCount: number;
  } {
    const db = this.getDb();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const agentClause = agentId ? " AND i.agent_id = ?" : "";
    const inboxRows = db
      .prepare(
        `SELECT i.id AS inbox_id,
                i.agent_id AS agent_id,
                i.message_id AS message_id,
                m.source AS source,
                m.metadata AS metadata,
                m.external_ts AS external_ts
           FROM inbox i
           JOIN messages m ON m.id = i.message_id
          WHERE (i.delivered = 0 OR i.read_at IS NULL)
            AND m.direction = 'inbound'
            AND m.source = 'slack'${agentClause}`,
      )
      .all(...(agentId ? [agentId] : [])) as Array<{
      inbox_id: number;
      agent_id: string;
      message_id: number;
      source: string;
      metadata: string | null;
      external_ts: string | null;
    }>;

    const staleInboxRows = inboxRows.filter((row) => {
      const metadata = parseJsonMetadata(row.metadata);
      const timestamp =
        getStringMetadataValue(metadata, ["timestamp", "ts", "externalTs", "external_ts"]) ??
        row.external_ts;
      return isStaleSlackMessageTimestamp(row.source, timestamp, nowMs);
    });

    const markInboxStale = db.prepare(
      "UPDATE inbox SET delivered = 1, read_at = COALESCE(read_at, ?) WHERE id = ?",
    );
    for (const row of staleInboxRows) {
      markInboxStale.run(now, row.inbox_id);
      this.completeTargetedBacklogAssignment(row.message_id, row.agent_id);
    }

    const backlogRows = tableExists(db, "unrouted_backlog")
      ? (db
          .prepare(
            `SELECT b.id AS backlog_id,
                    m.source AS source,
                    m.metadata AS metadata,
                    m.external_ts AS external_ts
               FROM unrouted_backlog b
               JOIN messages m ON m.id = b.message_id
              WHERE b.status = 'pending'
                AND m.direction = 'inbound'
                AND m.source = 'slack'`,
          )
          .all() as Array<{
          backlog_id: number;
          source: string;
          metadata: string | null;
          external_ts: string | null;
        }>)
      : [];

    const staleBacklogIds = backlogRows
      .filter((row) => {
        const metadata = parseJsonMetadata(row.metadata);
        const timestamp =
          getStringMetadataValue(metadata, ["timestamp", "ts", "externalTs", "external_ts"]) ??
          row.external_ts;
        return isStaleSlackMessageTimestamp(row.source, timestamp, nowMs);
      })
      .map((row) => row.backlog_id);

    if (staleBacklogIds.length > 0) {
      const dropBacklog = db.prepare(
        `UPDATE unrouted_backlog
            SET status = 'dropped',
                reason = 'stale_slack_message',
                assigned_agent_id = NULL,
                updated_at = ?
          WHERE id = ?
            AND status = 'pending'`,
      );
      for (const id of staleBacklogIds) {
        dropBacklog.run(now, id);
      }
    }

    if (staleInboxRows.length > 0 || staleBacklogIds.length > 0) {
      console.info(
        `[broker-core] skipped stale Slack delivery rows older than 15m: inbox=${staleInboxRows.length} backlog=${staleBacklogIds.length}`,
      );
    }

    return { inboxCount: staleInboxRows.length, backlogCount: staleBacklogIds.length };
  }

  private dropStaleTransportInboxRows(agentId: string): number {
    this.dropStaleSlackDeliveryRows(agentId);
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
           AND m.source <> 'agent'
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

  ensureInboxDelivery(agentId: string, messageId: number): void {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO inbox (agent_id, message_id, delivered, created_at)
       SELECT ?, ?, 0, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM inbox WHERE agent_id = ? AND message_id = ?
       )`,
    ).run(agentId, messageId, now, agentId, messageId);
  }

  getInbox(
    agentId: string,
    limit = 50,
    options: { controlOnly?: boolean } = {},
  ): { entry: InboxEntry; message: BrokerMessage }[] {
    this.dropStaleTransportInboxRows(agentId);
    const db = this.getDb();
    const controlFilter = options.controlOnly
      ? `AND m.thread_id LIKE 'a2a:%'
         AND (
           (
             json_valid(m.metadata)
             AND (
               (json_extract(m.metadata, '$.type') = 'pinet:control'
                AND json_extract(m.metadata, '$.action') IN ('interrupt', 'exit'))
               OR
               (json_extract(m.metadata, '$.kind') = 'pinet_control'
                AND json_extract(m.metadata, '$.command') IN ('interrupt', 'exit'))
             )
           )
           OR TRIM(m.body) IN ('/interrupt', '/exit')
           OR (
             json_valid(m.body)
             AND json_extract(m.body, '$.type') = 'pinet:control'
             AND json_extract(m.body, '$.action') IN ('interrupt', 'exit')
           )
         )`
      : "";

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
         ${controlFilter}
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
    this.dropStaleTransportInboxRows(agentId);
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
    this.dropStaleTransportInboxRows(agentId);
    const db = this.getDb();
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM inbox WHERE agent_id = ? AND read_at IS NULL")
      .get(agentId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  getUnreadThreadSummary(agentId: string, limit = 20): InboxThreadUnreadSummary[] {
    this.dropStaleTransportInboxRows(agentId);
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
           m.metadata AS metadata,
           m.external_ts AS external_ts
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
      external_ts: string | null;
    }>;

    if (rows.length === 0) {
      return 0;
    }

    const markDelivered = db.prepare("UPDATE inbox SET delivered = 1 WHERE id = ?");
    const markStaleRead = db.prepare(
      "UPDATE inbox SET delivered = 1, read_at = COALESCE(read_at, ?) WHERE id = ?",
    );
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    let requeuedCount = 0;
    let staleCount = 0;
    for (const row of rows) {
      const metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
      const timestamp =
        getStringMetadataValue(metadata, ["timestamp", "ts", "externalTs", "external_ts"]) ??
        row.external_ts;
      if (isStaleSlackMessageTimestamp(row.source, timestamp, nowMs)) {
        markStaleRead.run(now, row.inbox_id);
        staleCount += 1;
        continue;
      }
      const channel = typeof metadata.channel === "string" ? metadata.channel : "";
      const preferredAgentId = row.target_agent_id || null;
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
      requeuedCount += 1;
    }

    if (staleCount > 0) {
      console.info(
        `[broker-core] skipped stale Slack requeue rows older than 15m: inbox=${staleCount}`,
      );
    }

    return requeuedCount;
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
