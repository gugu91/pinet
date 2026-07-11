import type { PinetMailClass } from "./mail-classification.js";

export const DEFAULT_EXTERNAL_THREAD_SOURCE = "external";

// ─── Domain types ─────────────────────────────────────────

export type AgentSupervisionState = "root" | "supervised" | "orphaned" | "stopping";
export type AgentLifecycleState =
  | "live"
  | "active"
  | "grace"
  | "idle"
  | "hibernating"
  | "hibernated"
  | "waking"
  | "reap-candidate"
  | "terminated";
export type AgentHibernatePolicy = "auto" | "never" | "manual";

export interface HibernateEligibility {
  eligible: boolean;
  reason: string;
}

export type AgentLifecycleOperation = "hibernate" | "wake";
export interface AgentLifecycleLease {
  agentId: string;
  operation: AgentLifecycleOperation;
  fenceToken: number;
  ownerBrokerInstanceId: string;
  leaseId: string;
  acquiredAt: string;
  expiresAt: string;
  attempt: number;
  triggerMessageId: number | null;
}
export interface AgentLifecycleRetentionInfo {
  retainedCount: number;
  prunedCount: number;
  lastPrunedAt: string | null;
}

/** Optional structured telemetry captured alongside lifecycle events. */
export interface AgentLifecycleEventMetrics {
  fenceToken?: number | null;
  queueDepth?: number | null;
  oldestQueueAgeMs?: number | null;
  durationMs?: number | null;
  rssBytesBefore?: number | null;
  rssBytesAfter?: number | null;
}

export interface AgentLifecycleTransitionInput extends AgentLifecycleEventMetrics {
  agentId: string;
  expectedVersion: number;
  toState: AgentLifecycleState;
  reason: string;
  actor: string;
  correlationId: string;
  triggerSource?: string;
  /**
   * Optional strict lease-identity binding for fenced transitions. When
   * `fenceToken` is presented these tighten the fence check so that only the
   * live, matching lease can drive the transition: `leaseId` must equal the
   * held lease's id, `expectedOperation` its operation, and (with `now`) the
   * lease must be unexpired. This rejects an expired, superseded, or
   * wrong-operation lease that would otherwise pass on the fence token alone.
   */
  leaseId?: string;
  expectedOperation?: AgentLifecycleOperation;
  now?: number;
}

/**
 * Audit-only lifecycle event that records an outcome (typically a refusal,
 * fenced stale attempt, or duplicate-launch prevention) without transitioning
 * the agent's lifecycle state.
 */
export interface AgentLifecycleEventInput extends AgentLifecycleEventMetrics {
  agentId: string;
  fromState: AgentLifecycleState;
  toState: AgentLifecycleState;
  lifecycleVersion: number;
  reason: string;
  actor: string;
  correlationId: string;
  outcome: string;
  errorCode?: string | null;
  triggerSource?: string;
}

export interface AgentLifecycleEvent {
  id: number;
  correlationId: string;
  agentId: string;
  fromState: AgentLifecycleState;
  toState: AgentLifecycleState;
  lifecycleVersion: number;
  fenceToken: number | null;
  reason: string;
  triggerSource: string | null;
  actor: string;
  outcome: string;
  errorCode: string | null;
  queueDepth: number | null;
  oldestQueueAgeMs: number | null;
  durationMs: number | null;
  rssBytesBefore: number | null;
  rssBytesAfter: number | null;
  createdAt: string;
}

/**
 * Durable, sanitized launch/resume manifest for a broker-managed follower.
 *
 * This is the record used to cold-wake exactly the same logical agent. It must
 * never persist secrets, tokens, prompt/message bodies, or an unrestricted
 * environment: only an env allowlist and opaque credential references. Secrets
 * are injected from broker memory/config at launch time.
 */
export interface AgentRuntimeSpec {
  agentId: string;
  stableId: string;
  brokerOwnerId: string;
  cwd: string;
  repoRoot: string;
  worktreePath: string;
  /** Canonical tmux server socket path recorded at launch; never searched for. */
  tmuxSocket: string;
  tmuxSession: string;
  /** Fully-qualified tmux target (session:window.pane) recorded at launch. */
  tmuxTarget: string;
  executable: string;
  /** Argument vector without secrets; credential values are references only. */
  argv: string[];
  /** Allowlisted environment variable names (never values). */
  envAllowlist: string[];
  /** Opaque, broker-resolvable session resume reference (not a raw path). */
  sessionResumeRef: string;
  configFingerprint: string;
  expectedHost: string;
  expectedUser: string;
  launchSource: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentRuntimeSpecInput = Omit<AgentRuntimeSpec, "createdAt" | "updatedAt">;

/**
 * Client-facing redacted view of a runtime spec. Raw stable paths, private
 * socket paths, and env details are withheld unless an authorized operator
 * requests full inspection.
 */
export interface RedactedAgentRuntimeSpec {
  agentId: string;
  session: AgentSessionSummary;
  repo: string | null;
  hasWorktree: boolean;
  hasTmuxSession: boolean;
  configFingerprint: string;
  expectedHost: string;
  launchSource: string;
  envAllowlistCount: number;
  updatedAt: string;
}

/**
 * Receipt confirming a follower cooperatively flushed a checkpoint before a
 * clean process exit. `hibernateSafe=false` records a refusal reason so the
 * orchestrator fails closed rather than exiting an unsafe runtime.
 */
export interface AgentCheckpointReceipt {
  agentId: string;
  runtimeGeneration: number;
  correlationId: string;
  hibernateSafe: boolean;
  reason: string | null;
  sessionResumeRef: string | null;
  pendingInboxCount: number;
  rssBytes: number | null;
  createdAt: string;
}

export type AgentCheckpointReceiptInput = Omit<AgentCheckpointReceipt, "createdAt">;

/**
 * Single-winner wake reservation. Exactly one may exist per agent; it binds the
 * wake lease/fence to the specific runtime generation the broker will accept on
 * registration. Any registration presenting a different generation/lease/fence
 * is a stale runtime and is rejected.
 */
export interface AgentWakeReservation {
  agentId: string;
  wakeLeaseId: string;
  fenceToken: number;
  reservedGeneration: number;
  correlationId: string;
  createdAt: string;
}

export interface AcceptRuntimeGenerationInput {
  agentId: string;
  wakeLeaseId: string;
  fenceToken: number;
  reservedGeneration: number;
  /** Epoch ms for lease-expiry comparison. Defaults to Date.now(). */
  now?: number;
}

export type RuntimeGenerationAcceptance =
  | { accepted: true; runtimeGeneration: number }
  | { accepted: false; reason: string };

export type WakeTriggerKind =
  | "slack_thread"
  | "direct_a2a"
  | "lane_assignment"
  | "scheduled"
  | "manual";

export interface AgentWakeQueueEntry {
  id: number;
  agentId: string;
  repoRoot: string | null;
  triggerKind: WakeTriggerKind;
  triggerMessageId: number | null;
  /** Lower sorts first; targeted (direct/affinity) work uses a smaller value. */
  priority: number;
  reason: string;
  correlationId: string;
  status: "queued" | "dispatching" | "done" | "cancelled";
  attempt: number;
  enqueuedAt: string;
  updatedAt: string;
}

export interface EnqueueWakeInput {
  agentId: string;
  repoRoot?: string | null;
  triggerKind: WakeTriggerKind;
  triggerMessageId?: number | null;
  priority?: number;
  reason: string;
  correlationId: string;
}

export interface AgentInfo {
  id: string;
  stableId?: string | null;
  name: string;
  emoji: string;
  pid: number;
  connectedAt: string;
  lastSeen: string;
  lastHeartbeat: string;
  metadata: Record<string, unknown> | null;
  status: "working" | "idle";
  parentAgentId?: string | null;
  rootAgentId?: string | null;
  treeDepth?: number;
  spawnedByAgentId?: string | null;
  supervisionState?: AgentSupervisionState;
  launchId?: string | null;
  subtreeRole?: string | null;
  laneId?: string | null;
  disconnectedAt?: string | null;
  resumableUntil?: string | null;
  idleSince?: string | null;
  lastActivity?: string | null;
  lifecycleState?: AgentLifecycleState;
  lifecycleVersion?: number;
  hibernatePolicy?: AgentHibernatePolicy;
  graceUntil?: string | null;
  idleEligibleAt?: string | null;
  hibernatedAt?: string | null;
  terminatedAt?: string | null;
  hibernateReason?: string | null;
  lastWakeReason?: string | null;
  runtimeGeneration?: number;
  outboundCount?: number;
  pendingInboxCount?: number;
}

export type AgentSessionKind = "session" | "leaf" | "cwd" | "broker" | "unknown";

export interface AgentSessionSummary {
  kind: AgentSessionKind;
  /**
   * Broker-safe, path-free session reference of the form "<kind>:#<fp>" where
   * <fp> is a stable, non-reversible fingerprint of the raw session resume ref.
   * The raw payload (which for cwd/leaf kinds may be a filesystem path) is never
   * surfaced.
   */
  ref: string;
  host?: string | null;
  /** True when the raw ref payload looked path-like (still never exposed). */
  hasPath?: boolean;
}

export type ClientAgentInfo = Omit<AgentInfo, "stableId"> & {
  /** Redacted session indicator. Raw stableId/session paths are intentionally not exposed here. */
  session?: AgentSessionSummary | null;
};

export interface AgentSessionSearchOptions {
  agentName?: string;
  agentId?: string;
  threadId?: string;
  repo?: string;
  worktreePath?: string;
  tmuxSession?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface AgentSessionSearchInfo {
  agentId: string;
  agentName: string;
  emoji: string;
  pid: number;
  status: "working" | "idle";
  stableId: string | null;
  connectedAt: string;
  lastSeen: string;
  lastHeartbeat: string;
  disconnectedAt: string | null;
  resumableUntil: string | null;
  idleSince: string | null;
  lastActivity: string | null;
  cwd: string | null;
  repo: string | null;
  repoRoot: string | null;
  worktreePath: string | null;
  branch: string | null;
  tmuxSession: string | null;
  brokerManaged: boolean;
  brokerManagedBy: string | null;
  launchSource: string | null;
  parentAgentId: string | null;
  rootAgentId: string | null;
  treeDepth: number;
  supervisionState: AgentSupervisionState;
  subtreeRole: string | null;
  laneId: string | null;
  relatedThreadIds: string[];
  matchedBy: string[];
}

export interface ThreadInfo {
  threadId: string;
  source: string;
  channel: string;
  ownerAgent: string | null;
  ownerBinding?: "explicit" | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrokerMessage {
  id: number;
  threadId: string;
  source: string;
  direction: "inbound" | "outbound";
  sender: string;
  body: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  externalId?: string;
  externalTs?: string;
}

export interface InboxEntry {
  id: number;
  agentId: string;
  messageId: number;
  delivered: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface InboxReadOptions {
  threadId?: string;
  limit?: number;
  unreadOnly?: boolean;
  markRead?: boolean;
}

export interface InboxThreadUnreadSummary {
  threadId: string;
  source: string;
  channel: string;
  unreadCount: number;
  latestMessageId: number;
  latestAt: string;
  highestMailClass: PinetMailClass;
  mailClassCounts: Record<PinetMailClass, number>;
}

export interface InboxReadResult {
  messages: Array<{ entry: InboxEntry; message: BrokerMessage }>;
  unreadCountBefore: number;
  unreadCountAfter: number;
  unreadThreads: InboxThreadUnreadSummary[];
  markedReadIds: number[];
}

export interface DeliveredInboundMessageResult {
  entry: InboxEntry;
  message: BrokerMessage;
  freshDelivery: boolean;
}

export interface ChannelAssignment {
  channel: string;
  agentId: string;
}

export interface BacklogEntry {
  id: number;
  threadId: string;
  channel: string;
  messageId: number;
  reason: string;
  status: "pending" | "assigned" | "dropped";
  preferredAgentId: string | null;
  assignedAgentId: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TaskAssignmentStatus =
  | "assigned"
  | "branch_pushed"
  | "pr_open"
  | "pr_merged"
  | "pr_closed";

export type TaskAssignmentKind =
  | "implementation"
  | "review"
  | "qa"
  | "merge"
  | "interactive"
  | "unknown";

export interface TaskAssignmentInfo {
  id: number;
  agentId: string;
  issueNumber: number;
  branch: string | null;
  prNumber: number | null;
  status: TaskAssignmentStatus;
  threadId: string;
  sourceMessageId: number | null;
  repoOwner: string | null;
  repoName: string | null;
  repoRoot: string | null;
  taskKind: TaskAssignmentKind;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledWakeupInfo {
  id: number;
  agentId: string;
  threadId: string;
  body: string;
  fireAt: string;
  createdAt: string;
}

export interface ScheduledWakeupDelivery {
  wakeup: ScheduledWakeupInfo;
  message: BrokerMessage;
}

export type PortLeaseStatus = "active" | "released" | "expired";

export interface PortLeaseInfo {
  id: string;
  purpose: string;
  port: number;
  host: string;
  ownerAgentId: string | null;
  pid: number | null;
  status: PortLeaseStatus;
  metadata: Record<string, unknown> | null;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  releasedAt: string | null;
}

export interface PortLeaseAcquireInput {
  purpose: string;
  ttlMs: number;
  ownerAgentId?: string | null;
  host?: string;
  port?: number;
  minPort?: number;
  maxPort?: number;
  pid?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface PortLeaseRenewInput {
  leaseId: string;
  ttlMs: number;
  ownerAgentId?: string | null;
}

export interface PortLeaseReleaseInput {
  leaseId: string;
  ownerAgentId?: string | null;
}

export interface PortLeaseListOptions {
  includeInactive?: boolean;
  expiredOnly?: boolean;
  ownerAgentId?: string;
  purpose?: string;
  host?: string;
}

export type PinetLaneState =
  | "planned"
  | "active"
  | "blocked"
  | "review"
  | "ready"
  | "done"
  | "cancelled"
  | "detached";

export type PinetLaneRole =
  | "broker"
  | "coordinator"
  | "pm"
  | "lead"
  | "implementer"
  | "reviewer"
  | "second_pass_reviewer"
  | "observer";

export interface PinetLaneParticipantInfo {
  laneId: string;
  agentId: string;
  role: PinetLaneRole;
  status: string | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export interface PinetLaneInfo {
  laneId: string;
  name: string | null;
  task: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  threadId: string | null;
  ownerAgentId: string | null;
  implementationLeadAgentId: string | null;
  pmMode: boolean;
  state: PinetLaneState;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  participants: PinetLaneParticipantInfo[];
}

export interface PinetLaneUpsertInput {
  laneId: string;
  name?: string | null;
  task?: string | null;
  issueNumber?: number | null;
  prNumber?: number | null;
  threadId?: string | null;
  ownerAgentId?: string | null;
  implementationLeadAgentId?: string | null;
  pmMode?: boolean;
  state?: PinetLaneState;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PinetLaneParticipantUpsertInput {
  laneId: string;
  agentId: string;
  role: PinetLaneRole;
  status?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PinetLaneListOptions {
  state?: PinetLaneState;
  ownerAgentId?: string;
  includeDone?: boolean;
}
// ─── Routing ──────────────────────────────────────────────

export type RoutingDecision =
  | { action: "deliver"; agentId: string }
  | { action: "broadcast"; agentIds: string[] }
  | { action: "unrouted" }
  | { action: "reject"; reason: string };

// ─── JSON-RPC protocol ───────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

// Server-defined broker auth / registration error codes
export const RPC_AUTH_REQUIRED = -32001;
export const RPC_AGENT_NAME_CONFLICT = -32002;
export const RPC_AGENT_STABLE_ID_CONFLICT = -32003;
/**
 * A registration targeted a durable hibernation identity but did not present a
 * valid broker-issued wake fence (missing/stale wake lease, fence token, or
 * runtime generation). Only a broker-initiated fenced wake may revive it.
 */
export const RPC_AGENT_WAKE_FENCE_REJECTED = -32004;

// ─── Message adapter (canonical transport contracts) ─────

import {
  buildCompatibilityInstanceScope as _buildCompatibilityInstanceScope,
  buildCompatibilityWorkspaceScope as _buildCompatibilityWorkspaceScope,
  buildRuntimeScopeCarrier as _buildRuntimeScopeCarrier,
} from "@pinet/transport-core";
import type {
  InboundMessage as _InboundMessage,
  NormalizedMessageContent as _NormalizedMessageContent,
  OutboundAttachmentFile as _OutboundAttachmentFile,
  OutboundMessage as _OutboundMessage,
  AdapterCapabilityRequest as _AdapterCapabilityRequest,
  AdapterCapabilityResult as _AdapterCapabilityResult,
  AdapterCapabilityEffects as _AdapterCapabilityEffects,
  AdapterThreadClaimEffect as _AdapterThreadClaimEffect,
  MessageAdapter as _MessageAdapter,
  RuntimeScopeCarrier as _RuntimeScopeCarrier,
  WorkspaceInstallScopeCarrier as _WorkspaceInstallScopeCarrier,
  InstanceScopeCarrier as _InstanceScopeCarrier,
} from "@pinet/transport-core";

export type InboundMessage = _InboundMessage;
export type NormalizedMessageContent = _NormalizedMessageContent;
export type OutboundAttachmentFile = _OutboundAttachmentFile;
export type OutboundMessage = _OutboundMessage;
export type AdapterCapabilityRequest = _AdapterCapabilityRequest;
export type AdapterCapabilityResult = _AdapterCapabilityResult;
export type AdapterCapabilityEffects = _AdapterCapabilityEffects;
export type AdapterThreadClaimEffect = _AdapterThreadClaimEffect;
export type MessageAdapter = _MessageAdapter;
export type RuntimeScopeCarrier = _RuntimeScopeCarrier;
export type WorkspaceInstallScopeCarrier = _WorkspaceInstallScopeCarrier;
export type InstanceScopeCarrier = _InstanceScopeCarrier;
export const buildCompatibilityWorkspaceScope = _buildCompatibilityWorkspaceScope;
export const buildCompatibilityInstanceScope = _buildCompatibilityInstanceScope;
export const buildRuntimeScopeCarrier = _buildRuntimeScopeCarrier;

// ─── BrokerDB interface (subset used by the router) ──────

export interface BrokerDBInterface {
  getThread(threadId: string): ThreadInfo | null;
  getAgentById(agentId: string): AgentInfo | null;
  getAgentByStableId(stableId: string): AgentInfo | null;
  getAgents(): AgentInfo[];
  searchAgentSessions?(options?: AgentSessionSearchOptions): AgentSessionSearchInfo[];
  getChannelAssignment(channel: string): ChannelAssignment | null;
  acquirePortLease?(input: PortLeaseAcquireInput): PortLeaseInfo;
  renewPortLease?(input: PortLeaseRenewInput): PortLeaseInfo;
  releasePortLease?(input: PortLeaseReleaseInput): PortLeaseInfo;
  getPortLease?(leaseId: string): PortLeaseInfo | null;
  listPortLeases?(options?: PortLeaseListOptions): PortLeaseInfo[];
  expirePortLeases?(nowIso?: string): PortLeaseInfo[];
  /**
   * Inbound user access policy for routing.
   * - `null` => explicit allow-all
   * - non-empty Set => explicit allowlist
   * - empty Set => default-deny / allow nobody
   */
  getAllowedUsers(): Set<string> | null;

  createThread(thread: ThreadInfo): void;
  updateThread(threadId: string, updates: Partial<ThreadInfo>): void;

  /**
   * Atomically claim a thread for an agent (first-responder-wins).
   * Creates the thread if it doesn't exist. Returns true if the claim
   * succeeded, false if another agent already owns the thread.
   */
  claimThread(threadId: string, agentId: string, source?: string, channel?: string): boolean;

  queueMessage(agentId: string, message: InboundMessage): void;
}
