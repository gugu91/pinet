import type { PinetMailClass } from "./mail-classification.js";

// ─── Domain types ─────────────────────────────────────────

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
  disconnectedAt?: string | null;
  resumableUntil?: string | null;
  idleSince?: string | null;
  lastActivity?: string | null;
  outboundCount?: number;
  pendingInboxCount?: number;
}

export type ClientAgentInfo = Omit<AgentInfo, "stableId">;

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

export interface TaskAssignmentInfo {
  id: number;
  agentId: string;
  issueNumber: number;
  branch: string | null;
  prNumber: number | null;
  status: TaskAssignmentStatus;
  threadId: string;
  sourceMessageId: number | null;
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

// ─── Message adapter (canonical transport contracts) ─────

import {
  buildCompatibilityInstanceScope as _buildCompatibilityInstanceScope,
  buildCompatibilityWorkspaceScope as _buildCompatibilityWorkspaceScope,
  buildRuntimeScopeCarrier as _buildRuntimeScopeCarrier,
} from "@gugu910/pi-transport-core";
import type {
  InboundMessage as _InboundMessage,
  NormalizedMessageContent as _NormalizedMessageContent,
  OutboundMessage as _OutboundMessage,
  MessageAdapter as _MessageAdapter,
  RuntimeScopeCarrier as _RuntimeScopeCarrier,
  WorkspaceInstallScopeCarrier as _WorkspaceInstallScopeCarrier,
  InstanceScopeCarrier as _InstanceScopeCarrier,
} from "@gugu910/pi-transport-core";

export type InboundMessage = _InboundMessage;
export type NormalizedMessageContent = _NormalizedMessageContent;
export type OutboundMessage = _OutboundMessage;
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
