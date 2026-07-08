import * as net from "node:net";
import { computeBackoffDelay, withTimeout } from "@pinet/transport-core/async";
import { readMeshSecret } from "./auth.js";
import { DEFAULT_SOCKET_PATH as PINET_DEFAULT_SOCKET_PATH } from "./paths.js";
import { assertLoopbackTcpHost } from "./raw-tcp-loopback.js";
import { RPC_AGENT_NAME_CONFLICT, RPC_METHOD_NOT_FOUND } from "./types.js";
import type {
  PinetReadOptions,
  PinetReadResult,
  PinetUnreadThreadSummary,
} from "@pinet/pinet-core/pinet-read-formatting";
import type {
  AgentSessionSearchInfo,
  AgentSessionSearchOptions,
  ClientAgentInfo,
  NormalizedMessageContent,
  OutboundAttachmentFile,
  PortLeaseAcquireInput,
  PortLeaseInfo,
  PortLeaseListOptions,
  PortLeaseReleaseInput,
  PortLeaseRenewInput,
  PinetLaneInfo,
  PinetLaneListOptions,
  PinetLaneParticipantInfo,
  PinetLaneParticipantUpsertInput,
  PinetLaneUpsertInput,
} from "./types.js";

// ─── Types ───────────────────────────────────────────────

export interface InboxItem {
  inboxId: number;
  message: {
    id: number;
    threadId: string;
    source: string;
    direction: string;
    sender: string;
    body: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  };
}

export type {
  PinetReadMessage,
  PinetReadOptions,
  PinetReadResult,
  PinetUnreadThreadSummary,
} from "@pinet/pinet-core/pinet-read-formatting";

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

export type AgentInfo = ClientAgentInfo;
export type { AgentSessionSearchInfo, AgentSessionSearchOptions };

export interface ScheduledWakeupInfo {
  id: number;
  threadId: string;
  fireAt: string;
}

export type {
  PortLeaseAcquireInput,
  PortLeaseInfo,
  PortLeaseListOptions,
  PortLeaseReleaseInput,
  PortLeaseRenewInput,
  PinetLaneInfo,
  PinetLaneListOptions,
  PinetLaneParticipantInfo,
  PinetLaneParticipantUpsertInput,
  PinetLaneUpsertInput,
};

// ─── JSON-RPC types ──────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Constants (exported for testing) ────────────────────

export const DEFAULT_SOCKET_PATH = PINET_DEFAULT_SOCKET_PATH;
export const REQUEST_TIMEOUT_MS = 5000;
export const RECONNECT_DELAY_MS = 3000;
export const INITIAL_RECONNECT_DELAY_MS = 1000;
export const MAX_RECONNECT_DELAY_MS = 30000;
export const HEARTBEAT_INTERVAL_MS = 5000;
export const HEARTBEAT_METADATA_PROVIDER_TIMEOUT_MS = 2500;

/** Compute reconnect delay with exponential backoff and jitter (±25%). */
export function computeReconnectDelay(attempt: number, random = Math.random()): number {
  return computeBackoffDelay(attempt, {
    initialMs: INITIAL_RECONNECT_DELAY_MS,
    maxMs: MAX_RECONNECT_DELAY_MS,
    random,
  });
}

// ─── Pending request tracker ─────────────────────────────

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BrokerRpcRequestError extends Error {
  code?: number;
  data?: unknown;
  method?: string;
}

function createRpcRequestError(
  method: string,
  error: { code: number; message: string; data?: unknown },
): BrokerRpcRequestError {
  const err = new Error(error.message) as BrokerRpcRequestError;
  err.name = "BrokerRpcRequestError";
  err.code = error.code;
  err.data = error.data;
  err.method = method;
  return err;
}

function isRpcMethodNotFoundError(err: unknown, method: string): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  const rpcErr = err as BrokerRpcRequestError;
  if (rpcErr.method !== method) {
    return false;
  }

  return rpcErr.code === RPC_METHOD_NOT_FOUND || err.message === `Unknown method: ${method}`;
}

function isRpcAgentNameConflictError(err: unknown): err is BrokerRpcRequestError {
  if (!(err instanceof Error)) {
    return false;
  }

  const rpcErr = err as BrokerRpcRequestError;
  if (rpcErr.code === RPC_AGENT_NAME_CONFLICT) {
    return true;
  }

  if (typeof rpcErr.data !== "object" || rpcErr.data == null) {
    return false;
  }

  return (rpcErr.data as { code?: unknown }).code === "AGENT_NAME_CONFLICT";
}

function getMeshAuthCompatibilityError(): Error {
  return new Error(
    "Broker does not support Pinet mesh auth (`auth`). Upgrade the broker or disable follower mesh auth when connecting to older/no-auth brokers.",
  );
}

interface RegistrationSnapshot {
  name: string;
  emoji: string;
  metadata?: Record<string, unknown>;
  stableId?: string;
  brokerAssignedIdentity?: boolean;
}

interface RegistrationResult {
  agentId: string;
  name: string;
  emoji: string;
  metadata?: Record<string, unknown> | null;
}

function getErrorCode(err: unknown): string | null {
  if (typeof err !== "object" || err == null || !("code" in err)) {
    return null;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export interface AgentBroadcastResult {
  channel: string;
  messageIds: number[];
  recipients: Array<{ id: string; name: string }>;
}

// ─── Connection options ──────────────────────────────────

export type BrokerConnectOpts = { path: string } | { host: string; port: number };

export interface BrokerClientAuthOptions {
  meshSecret?: string;
  meshSecretPath?: string;
}

export interface BrokerClientTimingOptions {
  /** @internal Allows tests to exercise reconnect behavior without waiting for production backoff. */
  reconnectDelayMs?: (attempt: number) => number;
}

export type BrokerClientOptions = BrokerConnectOpts &
  BrokerClientAuthOptions &
  BrokerClientTimingOptions;

// ─── BrokerClient ────────────────────────────────────────

export class BrokerClient {
  private readonly connectOpts: BrokerConnectOpts;
  private readonly meshSecret: string | null;
  private readonly meshSecretPath: string | null;
  private readonly reconnectDelayMs: (attempt: number) => number;
  private socket: net.Socket | null = null;
  private connected = false;
  private shuttingDown = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private disconnectHandler: (() => void) | null = null;
  private reconnectHandler: (() => void) | null = null;
  private reconnectFailedHandler: ((error: Error) => void) | null = null;
  private reconnectAttempt = 0;
  private registrationSnapshot: RegistrationSnapshot | null = null;
  private registeredIdentity: RegistrationResult | null = null;
  private heartbeatMetadataProvider:
    | (() => Promise<Record<string, unknown> | null | undefined>)
    | null = null;
  private heartbeatMetadataInFlight: Promise<Record<string, unknown> | null | undefined> | null =
    null;

  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";

  constructor(opts?: string | BrokerClientOptions) {
    this.reconnectDelayMs =
      typeof opts === "object" && opts !== null
        ? (opts.reconnectDelayMs ?? computeReconnectDelay)
        : computeReconnectDelay;

    if (opts === undefined) {
      this.connectOpts = { path: DEFAULT_SOCKET_PATH };
      this.meshSecret = null;
      this.meshSecretPath = null;
      return;
    }

    if (typeof opts === "string") {
      this.connectOpts = { path: opts };
      this.meshSecret = null;
      this.meshSecretPath = null;
      return;
    }

    if ("path" in opts) {
      this.connectOpts = { path: opts.path };
    } else {
      assertLoopbackTcpHost(opts.host, "broker client connect target");
      this.connectOpts = { host: opts.host, port: opts.port };
    }

    const meshSecret = opts.meshSecret?.trim();
    this.meshSecret = meshSecret && meshSecret.length > 0 ? meshSecret : null;
    const meshSecretPath = opts.meshSecretPath?.trim();
    this.meshSecretPath = meshSecretPath && meshSecretPath.length > 0 ? meshSecretPath : null;
  }

  // ─── Connection ──────────────────────────────────────

  async connect(): Promise<void> {
    this.shuttingDown = false;
    await this.connectSocket();
    try {
      await this.authenticateIfNeeded();
    } catch (err) {
      this.disconnect();
      throw err;
    }
  }

  disconnect(): void {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.rejectAllPending(new Error("Client disconnected"));
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.connected = false;
  }

  async disconnectGracefully(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    try {
      await this.unregister();
    } finally {
      this.disconnect();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  private resolveMeshSecret(): string | null {
    if (this.meshSecret) {
      return this.meshSecret;
    }
    if (this.meshSecretPath) {
      try {
        return readMeshSecret(this.meshSecretPath);
      } catch (err) {
        if (getErrorCode(err) === "ENOENT") {
          throw new Error(
            `Configured Pinet mesh secret file not found: ${this.meshSecretPath}. Set slack-bridge.meshSecretPath to an existing file, provide slack-bridge.meshSecret directly, or leave both unset to disable shared-secret auth.`,
          );
        }
        throw err;
      }
    }
    return null;
  }

  private async authenticateIfNeeded(): Promise<void> {
    const meshSecret = this.resolveMeshSecret();
    if (!meshSecret) {
      return;
    }

    try {
      await this.request("auth", { secret: meshSecret });
    } catch (err) {
      if (isRpcMethodNotFoundError(err, "auth")) {
        throw getMeshAuthCompatibilityError();
      }
      throw err;
    }
  }

  // ─── Registration ────────────────────────────────────

  async register(
    name: string,
    emoji: string,
    metadata?: Record<string, unknown>,
    stableId?: string,
  ): Promise<{
    agentId: string;
    name: string;
    emoji: string;
    metadata?: Record<string, unknown> | null;
  }> {
    this.registrationSnapshot = {
      name,
      emoji,
      ...(metadata ? { metadata } : {}),
      ...(stableId ? { stableId } : {}),
      ...(name.trim().length === 0 ? { brokerAssignedIdentity: true } : {}),
    };
    return this.performRegister(this.registrationSnapshot);
  }

  async unregister(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.request("unregister");
    } finally {
      this.stopHeartbeat();
      this.registrationSnapshot = null;
      this.registeredIdentity = null;
    }
  }

  async heartbeat(metadata?: Record<string, unknown> | null): Promise<void> {
    if (metadata === undefined) {
      await this.request("heartbeat");
      return;
    }
    await this.request("heartbeat", { metadata });
  }

  setHeartbeatMetadataProvider(
    provider: (() => Promise<Record<string, unknown> | null | undefined>) | null,
  ): void {
    this.heartbeatMetadataProvider = provider;
  }

  // ─── Messaging ───────────────────────────────────────

  async pollInbox(): Promise<InboxItem[]> {
    const result = (await this.request("inbox.poll")) as InboxItem[];
    return result;
  }

  async readInbox(options: PinetReadOptions = {}): Promise<PinetReadResult> {
    const result = (await this.request("inbox.read", {
      ...(options.threadId ? { threadId: options.threadId } : {}),
      ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
      ...(typeof options.unreadOnly === "boolean" ? { unreadOnly: options.unreadOnly } : {}),
      ...(typeof options.markRead === "boolean" ? { markRead: options.markRead } : {}),
    })) as {
      messages: Array<{
        entry: { id: number; delivered: boolean; readAt: string | null };
        message: InboxItem["message"];
      }>;
      unreadCountBefore: number;
      unreadCountAfter: number;
      unreadThreads: PinetUnreadThreadSummary[];
      markedReadIds: number[];
    };

    return {
      messages: result.messages.map((item) => ({
        inboxId: item.entry.id,
        delivered: item.entry.delivered,
        readAt: item.entry.readAt,
        message: item.message,
      })),
      unreadCountBefore: result.unreadCountBefore,
      unreadCountAfter: result.unreadCountAfter,
      unreadThreads: result.unreadThreads,
      markedReadIds: result.markedReadIds,
    };
  }

  async ackMessages(ids: number[]): Promise<void> {
    await this.request("inbox.ack", { ids });
  }

  async send(threadId: string, text: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.request("send", { threadId, body: text, ...(metadata ? { metadata } : {}) });
  }

  async sendMessage(input: {
    threadId: string;
    body: string;
    source?: string;
    channel?: string;
    content?: NormalizedMessageContent;
    blocks?: ReadonlyArray<Record<string, unknown>>;
    files?: ReadonlyArray<OutboundAttachmentFile>;
    agentName?: string;
    agentEmoji?: string;
    agentOwnerToken?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    adapter: string;
    messageId: number;
    threadId: string;
    channel: string;
    source: string;
  }> {
    const result = (await this.request("message.send", {
      threadId: input.threadId,
      body: input.body,
      ...(input.source ? { source: input.source } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.content ? { content: input.content } : {}),
      ...(input.blocks && input.blocks.length > 0 ? { blocks: input.blocks } : {}),
      ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
      ...(input.agentName ? { agentName: input.agentName } : {}),
      ...(input.agentEmoji ? { agentEmoji: input.agentEmoji } : {}),
      ...(input.agentOwnerToken ? { agentOwnerToken: input.agentOwnerToken } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })) as {
      adapter: string;
      messageId: number;
      threadId: string;
      channel: string;
      source: string;
    };
    return result;
  }

  // ─── Thread ownership ─────────────────────────────────

  async claimThread(
    threadId: string,
    channel?: string,
    source?: string,
  ): Promise<{ claimed: boolean }> {
    const params: Record<string, unknown> = { threadId };
    if (channel) params.channel = channel;
    if (source) params.source = source;
    const result = (await this.request("thread.claim", params)) as { claimed: boolean };
    return result;
  }

  async resolveThread(threadTs: string): Promise<string | null> {
    const result = (await this.request("resolveThread", { threadTs })) as {
      channelId?: string | null;
    };
    return typeof result.channelId === "string" ? result.channelId : null;
  }

  // ─── Status ────────────────────────────────────────────

  async updateStatus(status: "working" | "idle"): Promise<void> {
    await this.request("status.update", { status });
  }

  // ─── Agent-to-agent messaging ─────────────────────────

  async sendAgentMessage(
    target: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<number> {
    const result = (await this.request("agent.message", {
      targetAgent: target,
      body,
      ...(metadata ? { metadata } : {}),
    })) as { ok: boolean; messageId: number };
    return result.messageId;
  }

  async sendAgentBroadcast(channel: string, body: string): Promise<AgentBroadcastResult> {
    const result = (await this.request("agent.broadcast", {
      channel,
      body,
    })) as {
      ok: boolean;
      channel: string;
      messageIds: number[];
      recipients: AgentBroadcastResult["recipients"];
    };
    return {
      channel: result.channel,
      messageIds: result.messageIds,
      recipients: result.recipients,
    };
  }

  async scheduleWakeup(fireAt: string, body: string): Promise<ScheduledWakeupInfo> {
    const result = (await this.request("schedule.create", {
      fireAt,
      body,
    })) as { id: number; threadId: string; fireAt: string };
    return {
      id: result.id,
      threadId: result.threadId,
      fireAt: result.fireAt,
    };
  }

  async listLanes(options: PinetLaneListOptions = {}): Promise<PinetLaneInfo[]> {
    return (await this.request("lane.list", {
      ...(options.state ? { state: options.state } : {}),
      ...(options.ownerAgentId ? { ownerAgentId: options.ownerAgentId } : {}),
      ...(typeof options.includeDone === "boolean" ? { includeDone: options.includeDone } : {}),
    })) as PinetLaneInfo[];
  }

  async upsertLane(input: PinetLaneUpsertInput): Promise<PinetLaneInfo> {
    return (await this.request(
      "lane.upsert",
      input as unknown as Record<string, unknown>,
    )) as PinetLaneInfo;
  }

  async setLaneParticipant(
    input: PinetLaneParticipantUpsertInput,
  ): Promise<PinetLaneParticipantInfo> {
    return (await this.request(
      "lane.participant",
      input as unknown as Record<string, unknown>,
    )) as PinetLaneParticipantInfo;
  }

  async acquirePortLease(input: PortLeaseAcquireInput): Promise<PortLeaseInfo> {
    return (await this.request(
      "portLease.acquire",
      input as unknown as Record<string, unknown>,
    )) as PortLeaseInfo;
  }

  async renewPortLease(input: PortLeaseRenewInput): Promise<PortLeaseInfo> {
    return (await this.request(
      "portLease.renew",
      input as unknown as Record<string, unknown>,
    )) as PortLeaseInfo;
  }

  async releasePortLease(input: PortLeaseReleaseInput): Promise<PortLeaseInfo> {
    return (await this.request(
      "portLease.release",
      input as unknown as Record<string, unknown>,
    )) as PortLeaseInfo;
  }

  async getPortLease(leaseId: string): Promise<PortLeaseInfo | null> {
    return (await this.request("portLease.status", { leaseId })) as PortLeaseInfo | null;
  }

  async listPortLeases(options: PortLeaseListOptions = {}): Promise<PortLeaseInfo[]> {
    return (await this.request(
      "portLease.list",
      options as unknown as Record<string, unknown>,
    )) as PortLeaseInfo[];
  }

  async expirePortLeases(): Promise<PortLeaseInfo[]> {
    return (await this.request("portLease.expire")) as PortLeaseInfo[];
  }
  // ─── Queries ─────────────────────────────────────────

  async listThreads(): Promise<ThreadInfo[]> {
    const result = (await this.request("threads.list")) as ThreadInfo[];
    return result;
  }

  async listAgents(includeDisconnected = false): Promise<AgentInfo[]> {
    const result = (await this.request(
      "agents.list",
      includeDisconnected ? { includeDisconnected: true } : undefined,
    )) as AgentInfo[];
    return result;
  }

  async searchAgentSessions(
    options: AgentSessionSearchOptions = {},
  ): Promise<AgentSessionSearchInfo[]> {
    try {
      return (await this.request(
        "agent.sessions.search",
        options as unknown as Record<string, unknown>,
      )) as AgentSessionSearchInfo[];
    } catch (err) {
      if (isRpcMethodNotFoundError(err, "agent.sessions.search")) {
        throw new Error(
          "Broker does not support Pinet session search (`agent.sessions.search`). Upgrade the broker before using pinet action=sessions.",
        );
      }
      throw err;
    }
  }

  // ─── Adapter capabilities ───────────────────────────

  async invokeAdapterCapability(
    adapter: string,
    capability: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const result = (await this.request("adapter.capability", {
      adapter,
      capability,
      params,
    })) as Record<string, unknown>;
    return result;
  }

  /**
   * Compatibility wrapper for callers that still need direct Slack API access.
   * The broker RPC boundary remains adapter-neutral; Slack-specific payloads are
   * interpreted inside the Slack adapter's api.call capability.
   */
  async slackProxy(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.invokeAdapterCapability("slack", "api.call", { method, params });
    } catch (err) {
      if (!isRpcMethodNotFoundError(err, "adapter.capability")) {
        throw err;
      }
    }

    return (await this.request("slack.proxy", { method, params })) as Record<string, unknown>;
  }

  // ─── Events ──────────────────────────────────────────

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  onReconnect(handler: () => void): void {
    this.reconnectHandler = handler;
  }

  onReconnectFailed(handler: (error: Error) => void): void {
    this.reconnectFailedHandler = handler;
  }

  getReconnectAttempt(): number {
    return this.reconnectAttempt;
  }

  getRegisteredIdentity(): {
    agentId: string;
    name: string;
    emoji: string;
    metadata?: Record<string, unknown> | null;
  } | null {
    return this.registeredIdentity ? { ...this.registeredIdentity } : null;
  }

  // ─── JSON-RPC transport ──────────────────────────────

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error("Not connected to broker"));
    }

    const id = this.nextId++;
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { method, resolve, reject, timer });

      const line = JSON.stringify(msg) + "\n";
      this.socket!.write(line, "utf-8", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        this.handleResponse(msg);
      } catch {
        /* malformed JSON — skip */
      }
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(msg.id);

    if (msg.error) {
      entry.reject(createRpcRequestError(entry.method, msg.error));
    } else {
      entry.resolve(msg.result);
    }
  }

  // ─── Reconnect ──────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectOnce();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private connectSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(this.connectOpts);

      sock.on("connect", () => {
        this.socket = sock;
        this.connected = true;
        this.buffer = "";
        resolve();
      });

      sock.on("data", (chunk: Buffer) => {
        this.onData(chunk.toString("utf-8"));
      });

      sock.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        this.stopHeartbeat();
        this.rejectAllPending(new Error("Socket closed"));
        if (wasConnected && !this.shuttingDown) {
          this.disconnectHandler?.();
          this.scheduleReconnect();
        }
      });

      sock.on("error", (err: Error) => {
        if (!this.connected) {
          reject(err);
        }
        // If already connected, the close event handles cleanup
      });
    });
  }

  private async performRegister(snapshot: RegistrationSnapshot): Promise<{
    agentId: string;
    name: string;
    emoji: string;
    metadata?: Record<string, unknown> | null;
  }> {
    const result = (await this.request("register", {
      name: snapshot.name,
      emoji: snapshot.emoji,
      pid: process.pid,
      ...(snapshot.metadata ? { metadata: snapshot.metadata } : {}),
      ...(snapshot.stableId ? { stableId: snapshot.stableId } : {}),
    })) as RegistrationResult;
    this.registrationSnapshot = snapshot.brokerAssignedIdentity
      ? {
          ...snapshot,
          ...(result.metadata ? { metadata: result.metadata } : {}),
        }
      : {
          ...snapshot,
          name: result.name,
          emoji: result.emoji,
          ...(result.metadata ? { metadata: result.metadata } : {}),
        };
    this.registeredIdentity = result;
    this.startHeartbeat();
    return result;
  }

  private async reconnectOnce(): Promise<void> {
    try {
      await this.connectSocket();
    } catch {
      this.scheduleReconnect();
      return;
    }

    try {
      await this.authenticateIfNeeded();
      if (this.registrationSnapshot) {
        await this.performRegister(this.registrationSnapshot);
      }
      this.reconnectAttempt = 0;
      this.reconnectHandler?.();
    } catch (err) {
      // Re-registration failed after the socket connected. Clear the connection
      // state immediately instead of waiting for the async "close" event so the
      // client cannot stay in a broken "connected but not registered" state.
      // Then either surface a terminal reconnect failure or schedule the next
      // retry ourselves. (#139)
      const reconnectError = err instanceof Error ? err : new Error(String(err));
      const failedSocket = this.socket;
      this.socket = null;
      this.connected = false;
      this.buffer = "";
      this.stopHeartbeat();
      this.rejectAllPending(new Error("Socket closed"));
      this.registeredIdentity = null;
      try {
        failedSocket?.destroy();
      } catch {
        /* ignore */
      }
      if (isRpcAgentNameConflictError(reconnectError)) {
        this.reconnectAttempt = 0;
        this.reconnectFailedHandler?.(reconnectError);
        return;
      }
      this.scheduleReconnect();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      void this.runHeartbeatTick().catch(() => {
        /* best effort */
      });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private async readHeartbeatMetadata(): Promise<Record<string, unknown> | null | undefined> {
    const provider = this.heartbeatMetadataProvider;
    if (!provider || this.heartbeatMetadataInFlight) {
      return undefined;
    }

    const work = Promise.resolve()
      .then(() => provider())
      .finally(() => {
        if (this.heartbeatMetadataInFlight === work) {
          this.heartbeatMetadataInFlight = null;
        }
      });
    this.heartbeatMetadataInFlight = work;

    try {
      return await withTimeout(work, HEARTBEAT_METADATA_PROVIDER_TIMEOUT_MS);
    } catch {
      return undefined;
    }
  }

  private async runHeartbeatTick(): Promise<void> {
    await this.heartbeat(await this.readHeartbeatMetadata());
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }
}
