import * as net from "node:net";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SlackResult } from "../slack-api.js";
import type { WorkerIdentity, WorkerKeyRecord } from "./worker-keys.js";
import {
  computeBackoffDelay,
  createAbortError,
  isAbortError,
  createScope,
  withTimeout,
  type Scope,
} from "@pinet/transport-core/async";
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
import { reportDiagnostic } from "@pinet/transport-core/diagnostics";

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

type WireAgentSessionSearchInfo = Omit<AgentSessionSearchInfo, "runtimeKind" | "runtimeLocator"> &
  Partial<Pick<AgentSessionSearchInfo, "runtimeKind" | "runtimeLocator">>;

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

class BrokerRpcRequestError extends Error {
  readonly code: number;
  readonly data: NonNullable<JsonRpcResponse["error"]>["data"];
  readonly reason: string | null;

  constructor(
    readonly method: string,
    error: NonNullable<JsonRpcResponse["error"]>,
  ) {
    super(error.message);
    this.name = "BrokerRpcRequestError";
    this.code = error.code;
    this.data = error.data;
    const data = error.data;
    this.reason =
      data && typeof data === "object" && "code" in data && typeof data.code === "string"
        ? data.code
        : null;
  }
}

function isRpcMethodNotFoundError(err: unknown, method: string): boolean {
  return (
    err instanceof BrokerRpcRequestError &&
    err.method === method &&
    (err.code === RPC_METHOD_NOT_FOUND || err.message === `Unknown method: ${method}`)
  );
}

/**
 * A single-use, broker-issued wake fence presented by a runtime that the broker
 * cold-launched to revive a hibernated identity. Consumed on the first
 * successful register and never replayed on reconnect.
 */
interface WakeFence {
  wakeLeaseId: string;
  fenceToken: number;
  runtimeGeneration: number;
  reservationNonce: string;
}

export interface RegistrationRequest {
  /** Empty asks the broker to assign a name. */
  name: string;
  emoji: string;
  metadata?: Record<string, unknown>;
  stableId?: string;
  /** Sent on the first registration only; a reconnect never replays it. */
  wakeFence?: WakeFence;
}

export interface RegistrationResult {
  agentId: string;
  name: string;
  emoji: string;
  metadata?: Record<string, unknown> | null;
}

export type BrokerConnectionStatus =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "ready"; reconnected: boolean }
  | { kind: "backoff"; attempt: number; error: Error }
  | { kind: "closed" }
  | { kind: "failed"; error: Error };

export interface BrokerConnectHandlers {
  /** Reconnect with backoff after an established connection drops (default true). A failed first attempt never retries. */
  reconnect?: boolean;
  /**
   * Builds the registration sent on every connection. Without it the client
   * only authenticates. `signal` aborts when that connection or the client
   * closes; a registration that finishes afterwards is discarded.
   */
  registration?: (context: {
    workerStableId: string | null;
    signal: AbortSignal;
  }) => Promise<RegistrationRequest>;
  /**
   * Sets up each connection once registered; the connection is ready, and
   * `connect()` resolves for the first one, only after it succeeds. A failure
   * fails the attempt: the first rejects `connect()`, later ones reconnect.
   * It is bound to that connection: its requests fail once the connection
   * drops instead of moving to the next one, and `scope` (for timers and
   * follow-up work) closes with the connection.
   */
  onReady?: (
    identity: RegistrationResult | null,
    info: { reconnected: boolean; scope: Scope },
  ) => Promise<void>;
  onStatus?: (status: BrokerConnectionStatus) => void;
}

interface Session {
  readonly socket: net.Socket;
  readonly scope: Scope;
  readonly pending: Map<number, PendingRequest>;
  buffer: string;
  isClosed: boolean;
  heartbeating: boolean;
  readonly closed: Promise<void>;
}

export interface AgentBroadcastResult {
  channel: string;
  messageIds: number[];
  recipients: Array<{ id: string; name: string }>;
}

// ─── Connection options ──────────────────────────────────

export type BrokerConnectOpts = { path: string } | { host: string; port: number };

export type BrokerClientAuthOptions =
  | { meshSecret?: string; meshSecretPath?: string; workerKey?: never }
  | { workerKey: string; meshSecret?: never; meshSecretPath?: never };

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
  private readonly auth: BrokerClientAuthOptions;
  private readonly reconnectDelayMs: (attempt: number) => number;
  private readonly root = createScope();
  /** The connection that the current async work was started for, if any. */
  private readonly boundSession = new AsyncLocalStorage<Session>();
  private readonly statusWaiters = new Set<() => void>();
  private handlers: BrokerConnectHandlers = {};
  private registration: BrokerConnectHandlers["registration"];
  private currentStatus: BrokerConnectionStatus = { kind: "idle" };
  private session: Session | null = null;
  private assignedStableId: string | null = null;
  private registeredIdentity: RegistrationResult | null = null;
  private heartbeatMetadataProvider:
    | (() => Promise<Record<string, unknown> | null | undefined>)
    | null = null;
  private heartbeatMetadataInFlight: Promise<Record<string, unknown> | null | undefined> | null =
    null;
  private nextId = 1;

  constructor(options: string | BrokerClientOptions = DEFAULT_SOCKET_PATH) {
    const opts = typeof options === "string" ? { path: options } : options;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? computeReconnectDelay;

    if ("path" in opts) {
      this.connectOpts = { path: opts.path };
    } else {
      assertLoopbackTcpHost(opts.host, "broker client connect target");
      this.connectOpts = { host: opts.host, port: opts.port };
    }

    this.auth = { ...opts };
  }

  /** The stable ID the broker assigned to this client's worker key, known after connect(). */
  get workerStableId(): string | null {
    return this.assignedStableId;
  }

  // ─── Connection ──────────────────────────────────────

  /**
   * Open the one connection this client owns. Resolves with the registered
   * identity (null without `registration`) once the first connection is ready,
   * and rejects if that first attempt fails.
   */
  connect(handlers: BrokerConnectHandlers = {}): Promise<RegistrationResult | null> {
    assert.equal(this.currentStatus.kind, "idle", "BrokerClient.connect() may only be called once");
    this.handlers = handlers;
    this.registration = handlers.registration;
    // Claimed synchronously so a second call fails before any socket opens.
    this.setStatus({ kind: "connecting", attempt: 0 });
    return new Promise((resolve, reject) => {
      this.root.run(() => this.runConnection({ resolve, reject })).catch(reject);
    });
  }

  /** Stop for good. With `unregister`, tell the broker first; a failed unregister still closes. */
  async close(options: { unregister?: boolean } = {}): Promise<void> {
    const session = this.session;
    try {
      if (options.unregister && session && this.registeredIdentity) {
        await this.boundSession.run(session, () => this.request("unregister"));
      }
    } finally {
      await this.root.close();
    }
  }

  status(): BrokerConnectionStatus {
    return this.currentStatus;
  }

  isConnected(): boolean {
    return this.currentStatus.kind === "ready" && this.session !== null;
  }

  private setStatus(status: BrokerConnectionStatus): void {
    this.currentStatus = status;
    this.handlers.onStatus?.(status);
    for (const wake of [...this.statusWaiters]) wake();
  }

  private async runConnection(first: {
    resolve: (identity: RegistrationResult | null) => void;
    reject: (error: Error) => void;
  }): Promise<void> {
    let attempt = 0;
    let wasReady = false;
    let lastError: Error = createAbortError("Client closed while connecting");
    try {
      for (;;) {
        const scope = this.root.child();
        try {
          const session = await this.openSession(scope);
          const identity = await this.handshake(session, wasReady);
          const onReady = this.handlers.onReady;
          if (onReady) {
            const reconnected = wasReady;
            await this.boundSession.run(session, () =>
              scope.run(() => onReady(identity, { reconnected, scope })),
            );
          }
          scope.signal.throwIfAborted();
          attempt = 0;
          this.session = session;
          this.setStatus({ kind: "ready", reconnected: wasReady });
          if (!wasReady) first.resolve(identity);
          wasReady = true;
          await session.closed;
          lastError = new Error("Socket closed");
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        } finally {
          this.session = null;
          await scope.close();
        }
        if (this.root.signal.aborted || !wasReady) return;
        if (
          lastError instanceof BrokerRpcRequestError &&
          (lastError.code === RPC_AGENT_NAME_CONFLICT ||
            lastError.reason === "AGENT_NAME_CONFLICT" ||
            lastError.reason === "WORKER_KEY_REJECTED")
        ) {
          this.setStatus({ kind: "failed", error: lastError });
          return;
        }
        if (this.handlers.reconnect === false) return;
        this.setStatus({ kind: "backoff", attempt, error: lastError });
        await this.root.sleep(this.reconnectDelayMs(attempt));
        attempt++;
        this.setStatus({ kind: "connecting", attempt });
      }
    } catch (error) {
      // close() aborting the backoff sleep is the normal way out.
      if (!isAbortError(error)) {
        reportDiagnostic(
          "error",
          `[broker-client] connection loop failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      if (!wasReady) first.reject(lastError);
      if (this.currentStatus.kind !== "failed") this.setStatus({ kind: "closed" });
    }
  }

  private async openSession(scope: Scope): Promise<Session> {
    const socket = net.createConnection(this.connectOpts);
    const destroy = () => socket.destroy();
    if (scope.signal.aborted) destroy();
    scope.signal.addEventListener("abort", destroy, { once: true });
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        socket.off("connect", connected);
        reject(error);
      };
      const closedEarly = () => fail(new Error("Socket closed before connection completed"));
      const connected = () => {
        socket.off("error", fail);
        socket.off("close", closedEarly);
        resolve();
      };
      socket.once("connect", connected);
      socket.once("error", fail);
      socket.once("close", closedEarly);
    });

    let markClosed!: () => void;
    const session: Session = {
      socket,
      scope,
      pending: new Map(),
      buffer: "",
      isClosed: false,
      heartbeating: false,
      closed: new Promise((resolve) => {
        markClosed = resolve;
      }),
    };
    socket.on("data", (chunk: Buffer) => this.onData(session, chunk.toString("utf-8")));
    socket.on("error", () => {
      // "close" follows and owns the cleanup.
    });
    socket.on("close", () => {
      session.isClosed = true;
      if (this.session === session) this.session = null;
      for (const [id, entry] of session.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Socket closed"));
        session.pending.delete(id);
      }
      markClosed();
      // Ends this connection's setup and work; the loop reports any cleanup error.
      scope.close().catch(() => undefined);
    });
    return session;
  }

  /** Authenticate and register on `session`. */
  private handshake(session: Session, reconnected: boolean): Promise<RegistrationResult | null> {
    return this.boundSession.run(session, async () => {
      await this.authenticateIfNeeded();
      const buildRegistration = this.registration;
      if (!buildRegistration) return null;
      const { signal } = session.scope;
      const registration = await new Promise<RegistrationRequest>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        buildRegistration({ workerStableId: this.assignedStableId, signal })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
      return this.registerOn(
        session,
        reconnected ? { ...registration, wakeFence: undefined } : registration,
      );
    });
  }

  private async registerOn(
    session: Session,
    registration: RegistrationRequest,
  ): Promise<RegistrationResult> {
    const { wakeFence } = registration;
    const identity = (await this.boundSession.run(session, () =>
      this.request("register", {
        name: registration.name,
        emoji: registration.emoji,
        pid: process.pid,
        ...(registration.metadata ? { metadata: registration.metadata } : {}),
        ...(registration.stableId ? { stableId: registration.stableId } : {}),
        ...(wakeFence
          ? {
              wakeLeaseId: wakeFence.wakeLeaseId,
              fenceToken: wakeFence.fenceToken,
              runtimeGeneration: wakeFence.runtimeGeneration,
              reservationNonce: wakeFence.reservationNonce,
            }
          : {}),
      }),
    )) as RegistrationResult;
    this.registeredIdentity = identity;
    if (!session.heartbeating) {
      session.heartbeating = true;
      this.boundSession.run(session, () =>
        session.scope.setInterval(() => this.runHeartbeatTick(), HEARTBEAT_INTERVAL_MS),
      );
    }
    return identity;
  }

  /**
   * Register on the ready connection. Later reconnects register the same way:
   * a blank name asks the broker again, otherwise the assigned name is reused.
   */
  async register(
    name: string,
    emoji: string,
    metadata?: Record<string, unknown>,
    stableId?: string,
    wakeFence?: WakeFence,
  ): Promise<RegistrationResult> {
    const session = await this.sessionFor("register", Date.now() + REQUEST_TIMEOUT_MS);
    const request: RegistrationRequest = {
      name,
      emoji,
      ...(metadata ? { metadata } : {}),
      ...(stableId ? { stableId } : {}),
      ...(wakeFence ? { wakeFence } : {}),
    };
    const identity = await this.registerOn(session, request);
    const replay: RegistrationRequest =
      name.trim().length === 0
        ? { ...request, wakeFence: undefined }
        : {
            ...request,
            wakeFence: undefined,
            name: identity.name,
            emoji: identity.emoji,
            ...(identity.metadata ? { metadata: identity.metadata } : {}),
          };
    this.registration = async () => replay;
    return identity;
  }

  private async authenticateIfNeeded(): Promise<void> {
    const auth = this.auth;
    if (auth.workerKey !== undefined) {
      const result = await this.request("auth", { workerKey: auth.workerKey });
      assert(
        result &&
          typeof result === "object" &&
          "stableId" in result &&
          typeof result.stableId === "string" &&
          result.stableId.length > 0,
        "Broker did not assign a worker identity. Upgrade the broker to support worker keys.",
      );
      this.assignedStableId = result.stableId;
      return;
    }
    let meshSecret = auth.meshSecret?.trim();
    const meshSecretPath = auth.meshSecretPath?.trim();
    if (!meshSecret && meshSecretPath) {
      try {
        meshSecret = readMeshSecret(meshSecretPath);
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
          throw new Error(
            `Configured Pinet mesh secret file not found: ${meshSecretPath}. Set slack-bridge.meshSecretPath to an existing file, provide slack-bridge.meshSecret directly, or leave both unset to disable shared-secret auth.`,
          );
        }
        throw err;
      }
    }
    if (!meshSecret) {
      return;
    }

    try {
      await this.request("auth", { secret: meshSecret });
    } catch (err) {
      if (isRpcMethodNotFoundError(err, "auth")) {
        throw new Error(
          "Broker does not support Pinet mesh auth (`auth`). Upgrade the broker or disable follower mesh auth when connecting to older/no-auth brokers.",
        );
      }
      throw err;
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

  // ─── Worker keys (trusted connections only) ──────────

  /** Rotates the identity's key; the returned key is never retrievable again. */
  async issueWorkerKey(
    identity: WorkerIdentity,
  ): Promise<{ keyId: string; key: string; stableId: string }> {
    return (await this.request("admin.workerKey.issue", { ...identity })) as {
      keyId: string;
      key: string;
      stableId: string;
    };
  }

  async revokeWorkerKey(identity: WorkerIdentity): Promise<{ revoked: boolean; stableId: string }> {
    return (await this.request("admin.workerKey.revoke", { ...identity })) as {
      revoked: boolean;
      stableId: string;
    };
  }

  async listWorkerKeys(): Promise<Array<WorkerKeyRecord & { connected: boolean }>> {
    const result = (await this.request("admin.workerKey.list")) as {
      keys: Array<WorkerKeyRecord & { connected: boolean }>;
    };
    return result.keys;
  }

  async listLanes(options: PinetLaneListOptions = {}): Promise<PinetLaneInfo[]> {
    return (await this.request("lane.list", {
      laneId: options.laneId,
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
      const sessions = (await this.request(
        "agent.sessions.search",
        options as unknown as Record<string, unknown>,
      )) as WireAgentSessionSearchInfo[];
      return sessions.map((session) => ({
        ...session,
        runtimeKind: session.runtimeKind ?? (session.tmuxSession ? "tmux" : null),
        runtimeLocator:
          session.runtimeLocator ?? (session.runtimeKind === "herdr" ? null : session.tmuxSession),
      }));
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
  async slackProxy(method: string, params: Record<string, unknown>): Promise<SlackResult> {
    const result = await this.invokeAdapterCapability("slack", "api.call", {
      method,
      params,
    }).catch((err) => {
      if (!isRpcMethodNotFoundError(err, "adapter.capability")) throw err;
      return this.request("slack.proxy", { method, params });
    });
    if (
      typeof result !== "object" ||
      result === null ||
      !("ok" in result) ||
      typeof result.ok !== "boolean"
    ) {
      throw new Error("Invalid Slack proxy response: expected a boolean ok field.");
    }
    const error = "error" in result ? result.error : undefined;
    if (error !== undefined && typeof error !== "string") {
      throw new Error("Invalid Slack proxy response: expected a string error field.");
    }
    return { ...result, ok: result.ok, error };
  }

  getRegisteredIdentity(): RegistrationResult | null {
    return this.registeredIdentity ? { ...this.registeredIdentity } : null;
  }

  // ─── JSON-RPC transport ──────────────────────────────

  /**
   * Send on the connection the caller's work is bound to, or else wait for the
   * current connection to be ready. A connection that is reconnecting delays
   * the request rather than failing it; the timeout covers the wait.
   */
  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    const session = await this.sessionFor(method, deadline);
    const id = this.nextId++;
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          session.pending.delete(id);
          reject(new Error(`Request timed out: ${method}`));
        },
        Math.max(0, deadline - Date.now()),
      );
      session.pending.set(id, { method, resolve, reject, timer });
      session.socket.write(JSON.stringify(msg) + "\n", "utf-8", (err) => {
        if (err) {
          clearTimeout(timer);
          session.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private async sessionFor(method: string, deadline: number): Promise<Session> {
    const bound = this.boundSession.getStore();
    if (bound) {
      if (bound.isClosed) throw new Error("Socket closed");
      return bound;
    }
    for (;;) {
      const kind = this.currentStatus.kind;
      if (kind === "ready" && this.session) return this.session;
      if (kind === "idle" || kind === "closed" || kind === "failed") {
        throw new Error("Not connected to broker");
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            this.statusWaiters.delete(wake);
            reject(new Error(`Request timed out: ${method}`));
          },
          Math.max(0, deadline - Date.now()),
        );
        const wake = () => {
          clearTimeout(timer);
          this.statusWaiters.delete(wake);
          resolve();
        };
        this.statusWaiters.add(wake);
      });
    }
  }

  private onData(session: Session, chunk: string): void {
    session.buffer += chunk;
    const lines = session.buffer.split("\n");
    // Keep the last incomplete line in the buffer
    session.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // malformed JSON — skip
      }
      const entry = session.pending.get(msg.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      session.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new BrokerRpcRequestError(entry.method, msg.error));
      } else {
        entry.resolve(msg.result);
      }
    }
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
}
