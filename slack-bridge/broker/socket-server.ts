import * as net from "node:net";
import * as tls from "node:tls";
import * as fs from "node:fs";
import * as path from "node:path";

import * as crypto from "node:crypto";
import type { BrokerDB } from "./schema.js";
import { DEFAULT_SOCKET_PATH } from "./paths.js";
import { MessageRouter } from "./router.js";
import { dispatchDirectAgentMessage } from "./agent-messaging.js";
import { sendBrokerMessage } from "./message-send.js";
import { assertLoopbackTcpHost } from "./raw-tcp-loopback.js";
import { assertTlsListenTargetSecurity, type BrokerTlsServerConfig } from "./tls.js";
import { summarizePinetStableId } from "../pinet-session-formatting.js";
import type {
  AgentInfo,
  AgentSessionSearchOptions,
  BrokerMessage,
  ClientAgentInfo,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  AdapterCapabilityResult,
  MessageAdapter,
  NormalizedMessageContent,
  OutboundAttachmentFile,
  PortLeaseAcquireInput,
  PortLeaseListOptions,
  PortLeaseReleaseInput,
  PortLeaseRenewInput,
  PinetLaneListOptions,
  PinetLaneParticipantUpsertInput,
  PinetLaneRole,
  PinetLaneState,
  PinetLaneUpsertInput,
} from "./types.js";
import {
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
  RPC_AUTH_REQUIRED,
  RPC_AGENT_NAME_CONFLICT,
  RPC_AGENT_STABLE_ID_CONFLICT,
  RPC_AGENT_WAKE_FENCE_REJECTED,
} from "./types.js";

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
export const DEFAULT_PRUNE_INTERVAL_MS = 5_000;
export const DEFAULT_AUTH_TIMEOUT_MS = 2_000;

// ─── Listen target: Unix socket path or TCP host:port ────

export type ListenTarget =
  | { type: "unix"; path: string }
  | { type: "tcp"; host: string; port: number }
  | {
      /**
       * Encrypted remote transport. The only listen target allowed to bind a
       * non-loopback host, and then only when mesh authentication is also
       * configured (enforced fail-closed in the constructor).
       */
      type: "tls";
      host: string;
      port: number;
      tls: BrokerTlsServerConfig;
    };

export type AgentMessageCallback = (
  targetAgentId: string,
  msg: BrokerMessage,
  metadata: Record<string, unknown>,
) => void;

export type AgentStatusChangeCallback = (agentId: string, status: "working" | "idle") => void;

function toClientAgentInfo(agent: AgentInfo): ClientAgentInfo {
  const { stableId, ...clientAgent } = agent;
  return {
    ...clientAgent,
    session: summarizePinetStableId(stableId),
  };
}

export type AgentRegistrationResolver = (input: {
  agentId: string;
  name: string;
  emoji: string;
  pid: number;
  stableId?: string;
  metadata?: Record<string, unknown>;
}) => {
  name: string;
  emoji: string;
  metadata?: Record<string, unknown>;
} | null;
export interface BrokerSocketServerOptions {
  heartbeatTimeoutMs?: number;
  pruneIntervalMs?: number;
  authTimeoutMs?: number;
  meshSecret?: string;
}

// ─── Connection state ────────────────────────────────────

interface ConnectionState {
  agentId: string | null;
  buffer: string;
  authenticated: boolean;
  authTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * A validated fenced revival of a durable hibernation identity. `accept` is the
 * exact input passed to `acceptRuntimeGeneration` once registration commits.
 */
interface WakeRevival {
  agentId: string;
  accept: {
    agentId: string;
    wakeLeaseId: string;
    fenceToken: number;
    reservedGeneration: number;
    reservationNonce: string;
  };
}

// ─── RPC helpers ─────────────────────────────────────────

function rpcOk(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function isJsonRpcRequestId(value: unknown): value is number | string {
  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0;
  }
  return typeof value === "string" && value.length > 0;
}

function isJsonRpcRequestPayload(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const request = value as Record<string, unknown>;
  if (request.jsonrpc !== "2.0") {
    return false;
  }
  if (typeof request.method !== "string" || request.method.length === 0) {
    return false;
  }
  if (!isJsonRpcRequestId(request.id)) {
    return false;
  }
  if (
    request.params !== undefined &&
    (typeof request.params !== "object" || request.params === null || Array.isArray(request.params))
  ) {
    return false;
  }

  return true;
}

function extractJsonRpcRequestId(value: unknown): number | string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const id = (value as Record<string, unknown>).id;
  return isJsonRpcRequestId(id) ? id : null;
}

// ─── Socket server ───────────────────────────────────────

export class BrokerSocketServer {
  private server: net.Server | null = null;
  private readonly target: ListenTarget;
  private readonly db: BrokerDB;
  private readonly router: MessageRouter;
  private readonly connections = new Map<net.Socket, ConnectionState>();
  private readonly heartbeatTimeoutMs: number;
  private readonly pruneIntervalMs: number;
  private readonly authTimeoutMs: number;
  private readonly meshSecret: string | null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private assignedPort: number | null = null;
  private agentMessageCallback: AgentMessageCallback | null = null;
  private agentStatusChangeCallback: AgentStatusChangeCallback | null = null;
  private outboundMessageAdapters: ReadonlyArray<
    Pick<MessageAdapter, "name" | "send" | "invokeCapability">
  > = [];
  private agentRegistrationResolver: AgentRegistrationResolver | null = null;

  constructor(
    db: BrokerDB,
    target?: ListenTarget | string,
    options: BrokerSocketServerOptions = {},
  ) {
    this.db = db;
    this.router = new MessageRouter(db);
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    const meshSecret = options.meshSecret?.trim();
    this.meshSecret = meshSecret && meshSecret.length > 0 ? meshSecret : null;
    if (typeof target === "string") {
      this.target = { type: "unix", path: target };
    } else if (target) {
      this.target = target;
    } else {
      this.target = { type: "unix", path: DEFAULT_SOCKET_PATH };
    }
    if (this.target.type === "tcp") {
      assertLoopbackTcpHost(this.target.host, "broker listen target");
    }
    if (this.target.type === "tls") {
      assertTlsListenTargetSecurity({
        host: this.target.host,
        hasKey: this.target.tls.key.trim().length > 0,
        hasCert: this.target.tls.cert.trim().length > 0,
        hasMeshAuth: this.meshSecret != null,
      });
    }
  }

  async start(): Promise<void> {
    // Clean up stale socket file for Unix mode
    if (this.target.type === "unix") {
      if (fs.existsSync(this.target.path)) {
        fs.unlinkSync(this.target.path);
      }
      fs.mkdirSync(path.dirname(this.target.path), { recursive: true });
    }

    return new Promise((resolve, reject) => {
      if (this.target.type === "tls") {
        const tlsConfig = this.target.tls;
        this.server = tls.createServer(
          {
            key: tlsConfig.key,
            cert: tlsConfig.cert,
            ...(tlsConfig.clientCa
              ? { ca: tlsConfig.clientCa, requestCert: true, rejectUnauthorized: true }
              : {}),
          },
          (socket) => this.onConnection(socket),
        );
      } else {
        this.server = net.createServer((socket) => this.onConnection(socket));
      }

      this.server.on("error", (err) => {
        reject(err);
      });

      if (this.target.type === "unix") {
        this.server.listen(this.target.path, () => {
          this.startPruning();
          resolve();
        });
      } else {
        this.server.listen(this.target.port, this.target.host, () => {
          const addr = this.server!.address();
          if (addr && typeof addr === "object") {
            this.assignedPort = addr.port;
          }
          this.startPruning();
          resolve();
        });
      }
    });
  }

  async stop(): Promise<void> {
    this.stopPruning();

    // Mark all connected agents as resumably disconnected. Clear agentId so the
    // async close handler won't mark them a second time after db shutdown.
    for (const [socket, state] of this.connections) {
      if (state.agentId) {
        this.db.disconnectAgent(state.agentId, this.heartbeatTimeoutMs);
        state.agentId = null;
      }
      socket.destroy();
    }
    this.connections.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        // Clean up socket file for Unix mode
        if (this.target.type === "unix") {
          try {
            if (fs.existsSync(this.target.path)) {
              fs.unlinkSync(this.target.path);
            }
          } catch {
            // best effort
          }
        }
        this.server = null;
        this.assignedPort = null;
        resolve();
      });
    });
  }

  /**
   * Get connection info for clients. Returns the socket path (Unix)
   * or { host, port } (TCP).
   */
  getConnectInfo():
    | { type: "unix"; path: string }
    | { type: "tcp" | "tls"; host: string; port: number } {
    if (this.target.type === "unix") {
      return { type: "unix", path: this.target.path };
    }
    return {
      type: this.target.type,
      host: this.target.host,
      port: this.assignedPort ?? this.target.port,
    };
  }

  /**
   * Register a callback invoked whenever a worker sends an agent-to-agent
   * message via the socket server. The broker uses this to push messages
   * targeting itself into its in-memory inbox.
   */
  onAgentMessage(cb: AgentMessageCallback): void {
    this.agentMessageCallback = cb;
  }

  /**
   * Register a callback invoked whenever a connected agent explicitly updates
   * its broker status. The broker uses idle transitions to kick maintenance so
   * backlog can be reassigned immediately.
   */
  onAgentStatusChange(cb: AgentStatusChangeCallback): void {
    this.agentStatusChangeCallback = cb;
  }

  setAgentRegistrationResolver(resolver: AgentRegistrationResolver | null): void {
    this.agentRegistrationResolver = resolver;
  }

  setOutboundMessageAdapters(
    adapters: ReadonlyArray<Pick<MessageAdapter, "name" | "send" | "invokeCapability">>,
  ): void {
    this.outboundMessageAdapters = adapters;
  }

  private startPruning(): void {
    this.stopPruning();
    this.pruneTimer = setInterval(() => {
      try {
        this.db.pruneStaleAgents(this.heartbeatTimeoutMs);
      } catch {
        /* best effort */
      }
    }, this.pruneIntervalMs);
    this.pruneTimer.unref?.();
  }

  private stopPruning(): void {
    if (!this.pruneTimer) return;
    clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  private clearAuthTimer(state: ConnectionState): void {
    if (!state.authTimer) return;
    clearTimeout(state.authTimer);
    state.authTimer = null;
  }

  private startAuthTimer(socket: net.Socket, state: ConnectionState): void {
    this.clearAuthTimer(state);
    if (state.authenticated || !this.meshSecret) {
      return;
    }

    state.authTimer = setTimeout(() => {
      this.clearAuthTimer(state);
      socket.destroy();
    }, this.authTimeoutMs);
    state.authTimer.unref?.();
  }

  private disconnectDuplicateConnections(agentId: string, currentSocket: net.Socket): void {
    for (const [socket, state] of this.connections) {
      if (socket === currentSocket || state.agentId !== agentId) {
        continue;
      }
      state.agentId = null;
      socket.destroy();
    }
  }

  private findLiveStableIdConflict(
    stableId: string,
    currentSocket: net.Socket,
  ): { ownerAgentId: string } | null {
    const existing = this.db.getAgentByStableId(stableId);
    if (!existing) {
      return null;
    }

    for (const [socket, state] of this.connections) {
      if (socket === currentSocket || state.agentId !== existing.id) {
        continue;
      }
      return { ownerAgentId: existing.id };
    }

    return null;
  }

  // ─── Connection handling ─────────────────────────────

  private onConnection(socket: net.Socket): void {
    const state: ConnectionState = {
      agentId: null,
      buffer: "",
      authenticated: this.meshSecret == null,
      authTimer: null,
    };
    this.connections.set(socket, state);
    this.startAuthTimer(socket, state);

    socket.on("data", (chunk) => {
      state.buffer += chunk.toString("utf-8");
      void this.processBuffer(socket, state);
    });

    socket.on("close", () => {
      this.clearAuthTimer(state);
      if (state.agentId) {
        this.db.disconnectAgent(state.agentId, this.heartbeatTimeoutMs);
      }
      this.connections.delete(socket);
    });

    socket.on("error", () => {
      // close event will handle cleanup
    });
  }

  private processBuffer(socket: net.Socket, state: ConnectionState): void {
    let newlineIdx: number;
    while ((newlineIdx = state.buffer.indexOf("\n")) !== -1) {
      const line = state.buffer.slice(0, newlineIdx).trim();
      state.buffer = state.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.send(socket, rpcError(null, RPC_PARSE_ERROR, "Parse error"));
        continue;
      }

      if (!isJsonRpcRequestPayload(parsed)) {
        this.send(
          socket,
          rpcError(extractJsonRpcRequestId(parsed), RPC_INVALID_REQUEST, "Invalid request"),
        );
        continue;
      }

      void this.dispatchRequest(parsed, state, socket);
    }
  }

  private async dispatchRequest(
    req: JsonRpcRequest,
    state: ConnectionState,
    socket: net.Socket,
  ): Promise<void> {
    try {
      const response = await this.handleRequest(req, state, socket);
      this.send(socket, response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send(socket, rpcError(req.id, RPC_INTERNAL_ERROR, message));
    }
  }

  private send(socket: net.Socket, response: JsonRpcResponse): void {
    try {
      socket.write(JSON.stringify(response) + "\n");
    } catch {
      // connection may have closed
    }
  }

  // ─── Request dispatch ────────────────────────────────

  private async handleRequest(
    req: JsonRpcRequest,
    state: ConnectionState,
    socket: net.Socket,
  ): Promise<JsonRpcResponse> {
    try {
      if (!state.authenticated && req.method !== "auth") {
        setImmediate(() => socket.destroy());
        return rpcError(
          req.id,
          RPC_AUTH_REQUIRED,
          "Authentication required before calling broker methods.",
        );
      }

      switch (req.method) {
        case "auth":
          return this.handleAuth(req, state, socket);
        case "register":
          return this.handleRegister(req, state, socket);
        case "unregister":
          return this.handleUnregister(req, state);
        case "heartbeat":
          return this.handleHeartbeat(req, state);
        case "inbox.poll":
          return this.handleInboxPoll(req, state);
        case "inbox.read":
          return this.handleInboxRead(req, state);
        case "inbox.ack":
          return this.handleInboxAck(req, state);
        case "send":
          return this.handleSend(req, state);
        case "message.send":
          return await this.handleMessageSend(req, state);
        case "threads.list":
          return this.handleThreadsList(req, state);
        case "agents.list":
          return this.handleAgentsList(req);
        case "agent.sessions.search":
          return this.handleAgentSessionsSearch(req, state);
        case "thread.claim":
          return this.handleThreadClaim(req, state);
        case "resolveThread":
          return this.handleResolveThread(req, state);
        case "agent.message":
          return this.handleAgentMessage(req, state);
        case "agent.broadcast":
          return this.handleAgentBroadcast(req, state);
        case "lane.list":
          return this.handleLaneList(req, state);
        case "lane.upsert":
          return this.handleLaneUpsert(req, state);
        case "lane.participant":
          return this.handleLaneParticipant(req, state);
        case "portLease.acquire":
          return this.handlePortLeaseAcquire(req, state);
        case "portLease.renew":
          return this.handlePortLeaseRenew(req, state);
        case "portLease.release":
          return this.handlePortLeaseRelease(req, state);
        case "portLease.status":
          return this.handlePortLeaseStatus(req, state);
        case "portLease.list":
          return this.handlePortLeaseList(req, state);
        case "portLease.expire":
          return this.handlePortLeaseExpire(req, state);
        case "schedule.create":
          return this.handleScheduleCreate(req, state);
        case "status.update":
          return this.handleStatusUpdate(req, state);
        case "adapter.capability":
          return await this.handleAdapterCapability(req, state);
        case "slack.proxy":
          return await this.handleLegacySlackProxy(req, state);
        default:
          return rpcError(req.id, RPC_METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INTERNAL_ERROR, message);
    }
  }

  // ─── Method handlers ─────────────────────────────────

  private handleAuth(
    req: JsonRpcRequest,
    state: ConnectionState,
    socket: net.Socket,
  ): JsonRpcResponse {
    if (!this.meshSecret) {
      state.authenticated = true;
      this.clearAuthTimer(state);
      return rpcOk(req.id, { ok: true });
    }

    const params = req.params ?? {};
    const providedSecret = typeof params.secret === "string" ? params.secret.trim() : "";
    if (!providedSecret) {
      setImmediate(() => socket.destroy());
      return rpcError(req.id, RPC_AUTH_REQUIRED, "Mesh secret is required.");
    }

    if (providedSecret !== this.meshSecret) {
      setImmediate(() => socket.destroy());
      return rpcError(req.id, RPC_AUTH_REQUIRED, "Invalid mesh secret.");
    }

    state.authenticated = true;
    this.clearAuthTimer(state);
    return rpcOk(req.id, { ok: true });
  }

  /**
   * Enforce the accepted-generation wake fence for durable hibernation
   * identities. Returns a rejection response when the fence fails; on success
   * for a hibernation identity it accepts the generation and binds this
   * connection to the revived agent id. Ordinary registration returns no
   * rejection and leaves state untouched.
   */
  private enforceWakeFence(
    req: JsonRpcRequest,
    stableId: string | undefined,
    fence: {
      wakeLeaseId: string | undefined;
      fenceToken: number | undefined;
      reservedGeneration: number | undefined;
      reservationNonce: string | undefined;
    },
  ): { rejection: JsonRpcResponse | null; revive?: WakeRevival; rebind?: { agentId: string } } {
    const { wakeLeaseId, fenceToken, reservedGeneration, reservationNonce } = fence;
    const hasFence =
      wakeLeaseId !== undefined ||
      fenceToken !== undefined ||
      reservedGeneration !== undefined ||
      reservationNonce !== undefined;

    // A wake fence is only meaningful for a specific durable stable identity.
    // Compute `hasFence` BEFORE the ordinary-registration fast path so a runtime
    // cannot omit `stableId`, present its broker-issued fence, and register as a
    // fresh authorized agent that skipped fence enforcement entirely (a malformed
    // wake runtime could otherwise do exactly this during the wake window). A
    // fence with no stableId has no identity to revive → reject fail-closed; only
    // a fence-free, stableId-less registration is a legitimate ordinary one.
    if (!stableId) {
      if (hasFence) {
        return {
          rejection: rpcError(
            req.id,
            RPC_AGENT_WAKE_FENCE_REJECTED,
            "Wake fence presented without a stableId; no hibernated identity to revive.",
            { code: "WAKE_FENCE_REJECTED", reason: "fence_without_stable_id", retryable: false },
          ),
        };
      }
      return { rejection: null };
    }
    const existing = this.db.getAgentByStableId(stableId);
    const lifecycleState = existing?.lifecycleState;
    const durableHibernation = lifecycleState === "hibernated" || lifecycleState === "waking";
    // Non-live lifecycle states that must NEVER accept a self-registration into
    // their stable identity. `hibernating` is mid-teardown: the old runtime may
    // still be alive and only a broker-driven wake (from `hibernated`) may revive
    // it, so a fresh registration during the teardown window must not bind the
    // socket. `reap-candidate` is quarantined pending manual review and
    // `terminated` is a closed identity — neither may silently reconnect and
    // regain broker RPC access. Fail closed regardless of any presented fence.
    const registrationBlocked =
      lifecycleState === "hibernating" ||
      lifecycleState === "reap-candidate" ||
      lifecycleState === "terminated";

    if (registrationBlocked) {
      return {
        rejection: rpcError(
          req.id,
          RPC_AGENT_WAKE_FENCE_REJECTED,
          `Registration into a ${lifecycleState} identity is not permitted; this stableId is not awaiting wake.`,
          {
            code: "WAKE_FENCE_REJECTED",
            reason: `state_${lifecycleState}`,
            retryable: false,
          },
        ),
      };
    }

    if (!durableHibernation) {
      // Ordinary registration. A wake fence presented with no hibernation
      // identity to revive is a stale/mismatched wake — reject fail-closed
      // rather than silently registering a fresh row.
      if (hasFence) {
        // EXCEPTION — idempotent crash-recovery replay. If the durable row is now
        // `live` with the generation ALREADY advanced to the reserved generation,
        // and an exact acceptance receipt matches the presented single-use fence,
        // this is a runtime whose acceptance committed but whose register RPC
        // response was lost to a broker crash (recovery then promoted the
        // accepted-but-stranded wake to `live`). Re-bind it idempotently WITHOUT
        // accepting a new generation, rather than reject a legitimate,
        // already-accepted runtime and strand it. Fail-closed: only an EXACT
        // receipt match on a `live` identity qualifies; the receipt is cleared by
        // the next wake reservation, so a stale fence cannot rebind during a fresh
        // wake window. A live duplicate connection is already rejected earlier by
        // `findLiveStableIdConflict`, so this never double-binds a running runtime.
        if (
          lifecycleState === "live" &&
          existing &&
          wakeLeaseId !== undefined &&
          fenceToken !== undefined &&
          reservedGeneration !== undefined &&
          reservationNonce !== undefined
        ) {
          const receipt = this.db.getAgentWakeAcceptanceReceipt(existing.id);
          if (
            receipt &&
            receipt.stableId === stableId &&
            receipt.wakeLeaseId === wakeLeaseId &&
            receipt.fenceToken === fenceToken &&
            receipt.reservedGeneration === reservedGeneration &&
            receipt.reservationNonce === reservationNonce &&
            existing.runtimeGeneration === reservedGeneration
          ) {
            return { rejection: null, rebind: { agentId: existing.id } };
          }
        }
        return {
          rejection: rpcError(
            req.id,
            RPC_AGENT_WAKE_FENCE_REJECTED,
            "Wake fence presented but no hibernated identity is awaiting wake for this stableId.",
            { code: "WAKE_FENCE_REJECTED", reason: "no_hibernation_identity", retryable: false },
          ),
        };
      }
      return { rejection: null };
    }

    if (
      wakeLeaseId === undefined ||
      fenceToken === undefined ||
      reservedGeneration === undefined ||
      reservationNonce === undefined
    ) {
      return {
        rejection: rpcError(
          req.id,
          RPC_AGENT_WAKE_FENCE_REJECTED,
          "Registration into a hibernated identity requires a broker-issued wake lease, fence token, runtime generation, and reservation nonce.",
          { code: "WAKE_FENCE_REJECTED", reason: "missing_fence", retryable: false },
        ),
      };
    }

    // Preflight only: validate the fence WITHOUT advancing the generation or
    // consuming the reservation. The generation is accepted in handleRegister
    // *after* the agent registration commits, so a later name conflict or
    // registration failure can never advance the generation (and thus falsely
    // signal the orchestrator that a runtime registered) for a runtime that did
    // not actually register. Registration is synchronous, so a passing
    // preflight is immediately followed by acceptance with no interleaving.
    const accept = {
      agentId: existing!.id,
      wakeLeaseId,
      fenceToken,
      reservedGeneration,
      reservationNonce,
    };
    const preflight = this.db.checkRuntimeGenerationAcceptable(accept);
    if (!preflight.accepted) {
      return {
        rejection: rpcError(
          req.id,
          RPC_AGENT_WAKE_FENCE_REJECTED,
          `Wake fence rejected: ${preflight.reason}.`,
          { code: "WAKE_FENCE_REJECTED", reason: preflight.reason, retryable: false },
        ),
      };
    }
    return { rejection: null, revive: { agentId: existing!.id, accept } };
  }

  private handleRegister(
    req: JsonRpcRequest,
    state: ConnectionState,
    socket: net.Socket,
  ): JsonRpcResponse {
    const params = req.params ?? {};
    const requestedName = typeof params.name === "string" ? params.name.trim() : "";
    const requestedEmoji = typeof params.emoji === "string" ? params.emoji : "";
    const pid = typeof params.pid === "number" ? params.pid : 0;
    const stableId = typeof params.stableId === "string" ? params.stableId : undefined;
    const metadata =
      params.metadata && typeof params.metadata === "object"
        ? (params.metadata as Record<string, unknown>)
        : undefined;

    if (stableId) {
      const liveStableIdConflict = this.findLiveStableIdConflict(stableId, socket);
      if (liveStableIdConflict) {
        return rpcError(
          req.id,
          RPC_AGENT_STABLE_ID_CONFLICT,
          `Agent stableId "${stableId}" is already active on another live connection. Wait for that agent to disconnect before retrying.`,
          {
            code: "AGENT_STABLE_ID_CONFLICT",
            stableId,
            ownerAgentId: liveStableIdConflict.ownerAgentId,
            retryable: true,
          },
        );
      }
    }

    // Fenced revival of a durable hibernation identity. A hibernated/waking
    // agent row has no live process and may only be revived by a
    // broker-initiated wake presenting its exact wake lease, fence token, and
    // reserved runtime generation. Ordinary (non-wake) registration is
    // unaffected; a wake fence presented against a non-hibernation identity is
    // treated as stale and rejected. Fails closed: on any mismatch the socket
    // is not bound and the row is not revived.
    const wakeFence = this.enforceWakeFence(req, stableId, {
      wakeLeaseId: typeof params.wakeLeaseId === "string" ? params.wakeLeaseId : undefined,
      fenceToken: typeof params.fenceToken === "number" ? params.fenceToken : undefined,
      reservedGeneration:
        typeof params.runtimeGeneration === "number" ? params.runtimeGeneration : undefined,
      reservationNonce:
        typeof params.reservationNonce === "string" ? params.reservationNonce : undefined,
    });
    if (wakeFence.rejection) return wakeFence.rejection;

    // A fenced revival targets the existing hibernated row so registerAgent
    // updates it (preserving lifecycle + generation) instead of minting a new
    // one. state.agentId is bound only after full success below, so a failure
    // path never leaves this connection authorized as the revived agent. An
    // idempotent crash-recovery rebind likewise targets the existing (now `live`)
    // row: the plain-register branch below updates its pid/metadata and binds the
    // socket WITHOUT accepting a new generation (already accepted).
    const candidateId =
      wakeFence.revive?.agentId ??
      wakeFence.rebind?.agentId ??
      state.agentId ??
      crypto.randomUUID();
    const resolved = this.agentRegistrationResolver?.({
      agentId: candidateId,
      name: requestedName,
      emoji: requestedEmoji,
      pid,
      stableId,
      metadata,
    });
    const explicitNameRequest = requestedName.length > 0;
    const finalName = explicitNameRequest
      ? requestedName
      : (resolved?.name ?? requestedName) || "anonymous";
    const finalEmoji = explicitNameRequest
      ? requestedEmoji.trim() || resolved?.emoji?.trim() || ""
      : (resolved?.emoji ?? requestedEmoji).trim();
    const finalMetadata = resolved?.metadata ?? metadata;

    if (explicitNameRequest) {
      const conflict = this.db.findAgentNameConflict(finalName, candidateId, stableId);
      if (conflict) {
        // Do not expose raw ownerStableId on this client-visible payload (#495).
        // The message + code + requestedName are enough to drive the retry path.
        return rpcError(
          req.id,
          RPC_AGENT_NAME_CONFLICT,
          `Agent name "${finalName}" is already reserved. Retry with a different name or leave the name empty so the broker can assign one.`,
          {
            code: "AGENT_NAME_CONFLICT",
            requestedName: finalName,
            retryable: true,
          },
        );
      }
    }

    let agent: AgentInfo;
    if (wakeFence.revive) {
      // Fenced revival: perform the registration mutation AND accept the reserved
      // generation in ONE broker transaction. If acceptance fails (e.g. the wake
      // lease expires in the sub-ms window after the preflight), the whole
      // registration mutation rolls back and the socket is refused and unbound —
      // the durable row is never left with a mutated pid/metadata/connectivity.
      // The orchestrator's registration wait then times out and quarantines
      // rather than promoting a half-revived identity to live.
      const revived = this.db.registerAgentWithGenerationAcceptance({
        registration: {
          id: candidateId,
          name: finalName,
          emoji: finalEmoji,
          pid,
          metadata: finalMetadata,
          stableId,
        },
        accept: wakeFence.revive.accept,
      });
      if (!revived.agent || !revived.acceptance.accepted) {
        const reason = revived.acceptance.accepted ? "unknown" : revived.acceptance.reason;
        return rpcError(
          req.id,
          RPC_AGENT_WAKE_FENCE_REJECTED,
          `Wake fence rejected during revival: ${reason}.`,
          { code: "WAKE_FENCE_REJECTED", reason, retryable: false },
        );
      }
      agent = revived.agent;
    } else {
      agent = this.db.registerAgent(
        candidateId,
        finalName,
        finalEmoji,
        pid,
        finalMetadata,
        stableId,
      );
    }

    this.disconnectDuplicateConnections(agent.id, socket);
    state.agentId = agent.id;

    return rpcOk(req.id, {
      agentId: agent.id,
      name: agent.name,
      emoji: agent.emoji,
      metadata: agent.metadata,
    });
  }

  private handleUnregister(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    this.db.unregisterAgent(state.agentId);
    state.agentId = null;

    return rpcOk(req.id, { ok: true });
  }

  private handleHeartbeat(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const metadata = params.metadata;
    if (metadata !== undefined && (typeof metadata !== "object" || Array.isArray(metadata))) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "metadata must be an object or null");
    }

    this.db.heartbeatAgent(state.agentId);
    if (metadata !== undefined) {
      this.db.updateAgentMetadata(state.agentId, metadata as Record<string, unknown> | null);
    }
    return rpcOk(req.id, { ok: true });
  }

  private handleInboxPoll(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    this.db.touchAgent(state.agentId);

    const params = req.params ?? {};
    const limit = typeof params.limit === "number" ? params.limit : 50;
    if (params.controlOnly !== undefined && typeof params.controlOnly !== "boolean") {
      return rpcError(req.id, RPC_INVALID_PARAMS, "controlOnly must be a boolean");
    }
    const items = this.db.getInbox(state.agentId, limit, {
      controlOnly: params.controlOnly === true,
    });

    return rpcOk(
      req.id,
      items.map((item) => ({
        inboxId: item.entry.id,
        message: item.message,
      })),
    );
  }

  private handleInboxRead(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    this.db.touchAgent(state.agentId);

    const params = req.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId.trim() : undefined;
    if (params.threadId !== undefined && !threadId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "threadId must be a non-empty string");
    }

    const limit = params.limit === undefined ? undefined : params.limit;
    if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit))) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "limit must be a finite number");
    }

    const unreadOnly = params.unreadOnly === undefined ? undefined : params.unreadOnly;
    if (unreadOnly !== undefined && typeof unreadOnly !== "boolean") {
      return rpcError(req.id, RPC_INVALID_PARAMS, "unreadOnly must be a boolean");
    }

    const markRead = params.markRead === undefined ? undefined : params.markRead;
    if (markRead !== undefined && typeof markRead !== "boolean") {
      return rpcError(req.id, RPC_INVALID_PARAMS, "markRead must be a boolean");
    }

    return rpcOk(
      req.id,
      this.db.readInbox(state.agentId, {
        ...(threadId ? { threadId } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
        ...(typeof unreadOnly === "boolean" ? { unreadOnly } : {}),
        ...(typeof markRead === "boolean" ? { markRead } : {}),
      }),
    );
  }

  private handleInboxAck(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const ids = params.ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "number")) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "ids must be an array of numbers");
    }

    this.db.markDelivered(ids as number[], state.agentId);

    // Activity tracking: acknowledging messages proves the agent processed them
    if (state.agentId) {
      this.db.touchAgentActivity(state.agentId);
    }

    return rpcOk(req.id, { ok: true });
  }

  private handleSend(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const body = typeof params.body === "string" ? params.body : null;

    if (!threadId || !body) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "threadId and body are required");
    }

    const source = typeof params.source === "string" ? params.source : "agent";
    const direction =
      params.direction === "inbound" || params.direction === "outbound"
        ? params.direction
        : "outbound";
    const metadata =
      params.metadata && typeof params.metadata === "object"
        ? (params.metadata as Record<string, unknown>)
        : undefined;

    // Ensure thread exists
    let thread = this.db.getThread(threadId);
    if (!thread) {
      const channel = typeof params.channel === "string" ? params.channel : "";
      thread = this.db.createThread(threadId, source, channel, state.agentId);
    }

    // Route to all OTHER connected agents
    const allAgents = this.db.getAgents();
    const targetIds = allAgents.filter((a) => a.id !== state.agentId).map((a) => a.id);

    const msg = this.db.insertMessage(
      threadId,
      source,
      direction,
      state.agentId,
      body,
      targetIds,
      metadata,
    );

    // Activity tracking: sending a message proves the agent is working
    this.db.touchAgentActivity(state.agentId);

    return rpcOk(req.id, { messageId: msg.id });
  }

  private async handleMessageSend(
    req: JsonRpcRequest,
    state: ConnectionState,
  ): Promise<JsonRpcResponse> {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const body = typeof params.body === "string" ? params.body : null;
    const source = typeof params.source === "string" ? params.source : undefined;
    const channel = typeof params.channel === "string" ? params.channel : undefined;
    const agentName = typeof params.agentName === "string" ? params.agentName : undefined;
    const agentEmoji = typeof params.agentEmoji === "string" ? params.agentEmoji : undefined;
    const agentOwnerToken =
      typeof params.agentOwnerToken === "string" ? params.agentOwnerToken : undefined;
    const blocks = Array.isArray(params.blocks)
      ? params.blocks.filter(
          (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
        )
      : undefined;
    const files = Array.isArray(params.files)
      ? params.files.flatMap((entry): OutboundAttachmentFile[] => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const file = entry as Record<string, unknown>;
          if (typeof file.path !== "string" || file.path.trim().length === 0) return [];
          return [
            {
              path: file.path,
              ...(typeof file.filename === "string" ? { filename: file.filename } : {}),
              ...(typeof file.title === "string" ? { title: file.title } : {}),
              ...(typeof file.filetype === "string" ? { filetype: file.filetype } : {}),
            },
          ];
        })
      : undefined;
    let content: NormalizedMessageContent | undefined;
    if (params.content !== undefined) {
      if (!params.content || typeof params.content !== "object" || Array.isArray(params.content)) {
        return rpcError(req.id, RPC_INVALID_PARAMS, "content must be an object");
      }

      const raw = params.content as Record<string, unknown>;
      const text = typeof raw.text === "string" ? raw.text.trim() : "";
      if (!text) {
        return rpcError(
          req.id,
          RPC_INVALID_PARAMS,
          "content.text is required when content is provided",
        );
      }

      const markdown = typeof raw.markdown === "string" ? raw.markdown.trim() : undefined;
      const slackBlocks = Array.isArray(raw.slackBlocks)
        ? raw.slackBlocks.filter(
            (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
          )
        : undefined;
      content = {
        text,
        ...(markdown ? { markdown } : {}),
        ...(slackBlocks && slackBlocks.length > 0 ? { slackBlocks } : {}),
      };
    }
    const metadata =
      params.metadata && typeof params.metadata === "object"
        ? (params.metadata as Record<string, unknown>)
        : undefined;

    if (!threadId || !body) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "threadId and body are required");
    }

    const result = await sendBrokerMessage(
      {
        db: this.db,
        adapters: this.outboundMessageAdapters,
      },
      {
        threadId,
        body,
        senderAgentId: state.agentId,
        ...(source ? { source } : {}),
        ...(channel ? { channel } : {}),
        ...(content ? { content } : {}),
        ...(blocks && blocks.length > 0 ? { blocks } : {}),
        ...(files && files.length > 0 ? { files } : {}),
        ...(agentName ? { agentName } : {}),
        ...(agentEmoji ? { agentEmoji } : {}),
        ...(agentOwnerToken ? { agentOwnerToken } : {}),
        ...(metadata ? { metadata } : {}),
      },
    );

    this.db.touchAgentActivity(state.agentId);

    return rpcOk(req.id, {
      adapter: result.adapter,
      messageId: result.message.id,
      threadId: result.thread.threadId,
      channel: result.thread.channel,
      source: result.thread.source,
    });
  }

  private handleThreadsList(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const threads = this.db.getThreads(state.agentId);
    return rpcOk(req.id, threads);
  }

  private handleAgentsList(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params ?? {};
    const includeDisconnected = params.includeDisconnected === true;
    const agents = (includeDisconnected ? this.db.getAllAgents() : this.db.getAgents()).map(
      (agent) => ({
        ...toClientAgentInfo(agent),
        pendingInboxCount: this.db.getPendingInboxCount(agent.id),
      }),
    );
    return rpcOk(req.id, agents);
  }

  private handleAgentSessionsSearch(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const caller = this.db.getAgentById(state.agentId);
    const metadataRole =
      typeof caller?.metadata?.role === "string" ? caller.metadata.role.trim().toLowerCase() : "";
    const capabilities =
      caller?.metadata?.capabilities &&
      typeof caller.metadata.capabilities === "object" &&
      !Array.isArray(caller.metadata.capabilities)
        ? (caller.metadata.capabilities as Record<string, unknown>)
        : null;
    const capabilityRole =
      typeof capabilities?.role === "string" ? capabilities.role.trim().toLowerCase() : "";
    if (metadataRole !== "broker" && capabilityRole !== "broker") {
      return rpcError(req.id, RPC_INVALID_PARAMS, "agent.sessions.search requires a broker agent");
    }

    const params = req.params ?? {};
    const options: AgentSessionSearchOptions = {
      ...(typeof params.agentName === "string" ? { agentName: params.agentName } : {}),
      ...(typeof params.agentId === "string" ? { agentId: params.agentId } : {}),
      ...(typeof params.threadId === "string" ? { threadId: params.threadId } : {}),
      ...(typeof params.repo === "string" ? { repo: params.repo } : {}),
      ...(typeof params.worktreePath === "string" ? { worktreePath: params.worktreePath } : {}),
      ...(typeof params.tmuxSession === "string" ? { tmuxSession: params.tmuxSession } : {}),
      ...(typeof params.since === "string" ? { since: params.since } : {}),
      ...(typeof params.until === "string" ? { until: params.until } : {}),
      ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    };
    return rpcOk(req.id, this.db.searchAgentSessions(options));
  }

  // ─── Thread claim handler ─────────────────────────────

  private handleThreadClaim(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (!threadId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "threadId is required");
    }

    const channel = typeof params.channel === "string" ? params.channel : undefined;
    let source =
      typeof params.source === "string" && params.source.trim().length > 0
        ? params.source.trim()
        : undefined;
    // Backward compatibility: legacy Slack callers used channel-only thread.claim
    // requests. Keep those claims Slack-sendable while allowing truly source-less
    // claims to fall through to broker-core's neutral default.
    const legacyChannelOnlyClaim = !source && !!channel;
    if (legacyChannelOnlyClaim) {
      source = "slack";
    }
    const claimed = this.router.claimThread(threadId, state.agentId, channel, source);
    if (claimed && legacyChannelOnlyClaim) {
      this.db.updateThread(threadId, { source, channel });
    }
    return rpcOk(req.id, { claimed });
  }

  private handleResolveThread(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const threadTs = typeof params.threadTs === "string" ? params.threadTs : null;
    if (!threadTs) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "threadTs is required");
    }

    const channelId = this.db.getThread(threadTs)?.channel || null;
    return rpcOk(req.id, { channelId });
  }

  // ─── Agent-to-agent messaging ─────────────────────────

  private handleAgentMessage(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const targetAgent = typeof params.targetAgent === "string" ? params.targetAgent : null;
    const body = typeof params.body === "string" ? params.body : null;

    if (!targetAgent || !body) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "targetAgent and body are required");
    }

    const metadata =
      params.metadata && typeof params.metadata === "object"
        ? (params.metadata as Record<string, unknown>)
        : undefined;

    const sender = this.db.getAgents().find((agent) => agent.id === state.agentId);
    const senderName = sender?.name ?? state.agentId;

    try {
      const result = dispatchDirectAgentMessage(
        this.db,
        {
          senderAgentId: state.agentId,
          senderAgentName: senderName,
          target: targetAgent,
          body,
          metadata,
        },
        (target, msg, enrichedMeta) => {
          this.agentMessageCallback?.(target.id, msg, enrichedMeta);
        },
      );

      // Activity tracking: sending agent-to-agent messages proves the agent is working
      this.db.touchAgentActivity(state.agentId);
      return rpcOk(req.id, { ok: true, messageId: result.messageId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INVALID_PARAMS, message);
    }
  }

  private handleAgentBroadcast(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const channel = typeof params.channel === "string" ? params.channel : null;
    const body = typeof params.body === "string" ? params.body : null;

    if (!channel || !body) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "channel and body are required");
    }

    return rpcError(
      req.id,
      RPC_INVALID_PARAMS,
      "Broadcast channels are broker-only and cannot be sent by connected clients.",
    );
  }

  private handleLaneList(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const options: PinetLaneListOptions = {
      ...(typeof params.state === "string" ? { state: params.state as PinetLaneState } : {}),
      ...(typeof params.ownerAgentId === "string" ? { ownerAgentId: params.ownerAgentId } : {}),
      ...(typeof params.includeDone === "boolean" ? { includeDone: params.includeDone } : {}),
    };
    try {
      return rpcOk(req.id, this.db.listPinetLanes(options));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INVALID_PARAMS, message);
    }
  }

  private handleLaneUpsert(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    if (typeof params.laneId !== "string" || params.laneId.trim().length === 0) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "laneId is required");
    }

    const input: PinetLaneUpsertInput = {
      laneId: params.laneId,
      ...(typeof params.name === "string" || params.name === null
        ? { name: params.name as string | null }
        : {}),
      ...(typeof params.task === "string" || params.task === null
        ? { task: params.task as string | null }
        : {}),
      ...(typeof params.issueNumber === "number" || params.issueNumber === null
        ? { issueNumber: params.issueNumber as number | null }
        : {}),
      ...(typeof params.prNumber === "number" || params.prNumber === null
        ? { prNumber: params.prNumber as number | null }
        : {}),
      ...(typeof params.threadId === "string" || params.threadId === null
        ? { threadId: params.threadId as string | null }
        : {}),
      ...(typeof params.ownerAgentId === "string" || params.ownerAgentId === null
        ? { ownerAgentId: params.ownerAgentId as string | null }
        : {}),
      ...(typeof params.implementationLeadAgentId === "string" ||
      params.implementationLeadAgentId === null
        ? { implementationLeadAgentId: params.implementationLeadAgentId as string | null }
        : {}),
      ...(typeof params.pmMode === "boolean" ? { pmMode: params.pmMode } : {}),
      ...(typeof params.state === "string" ? { state: params.state as PinetLaneState } : {}),
      ...(typeof params.summary === "string" || params.summary === null
        ? { summary: params.summary as string | null }
        : {}),
      ...(params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
        ? { metadata: params.metadata as Record<string, unknown> }
        : params.metadata === null
          ? { metadata: null }
          : {}),
    };

    try {
      const lane = this.db.upsertPinetLane(input);
      this.db.touchAgentActivity(state.agentId);
      return rpcOk(req.id, lane);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INVALID_PARAMS, message);
    }
  }

  private handleLaneParticipant(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    if (typeof params.laneId !== "string" || params.laneId.trim().length === 0) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "laneId is required");
    }

    const agentId =
      typeof params.agentId === "string" && params.agentId.trim().length > 0
        ? params.agentId
        : state.agentId;
    const input: PinetLaneParticipantUpsertInput = {
      laneId: params.laneId,
      agentId,
      role: (typeof params.role === "string" ? params.role : "observer") as PinetLaneRole,
      ...(typeof params.status === "string" || params.status === null
        ? { status: params.status as string | null }
        : {}),
      ...(typeof params.summary === "string" || params.summary === null
        ? { summary: params.summary as string | null }
        : {}),
      ...(params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
        ? { metadata: params.metadata as Record<string, unknown> }
        : params.metadata === null
          ? { metadata: null }
          : {}),
    };

    try {
      const participant = this.db.setPinetLaneParticipant(input);
      this.db.touchAgentActivity(state.agentId);
      return rpcOk(req.id, participant);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INVALID_PARAMS, message);
    }
  }

  private handlePortLeaseAcquire(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const input: PortLeaseAcquireInput = {
      purpose: typeof params.purpose === "string" ? params.purpose : "",
      ttlMs: typeof params.ttlMs === "number" ? params.ttlMs : Number(params.ttlMs),
      ownerAgentId: state.agentId,
      ...(typeof params.host === "string" ? { host: params.host } : {}),
      ...(typeof params.port === "number" ? { port: params.port } : {}),
      ...(typeof params.minPort === "number" ? { minPort: params.minPort } : {}),
      ...(typeof params.maxPort === "number" ? { maxPort: params.maxPort } : {}),
      ...(typeof params.pid === "number" || params.pid === null
        ? { pid: params.pid as number | null }
        : {}),
      ...(params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
        ? { metadata: params.metadata as Record<string, unknown> }
        : params.metadata === null
          ? { metadata: null }
          : {}),
    };

    try {
      const lease = this.db.acquirePortLease(input);
      this.db.touchAgentActivity(state.agentId);
      return rpcOk(req.id, lease);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INVALID_PARAMS, message);
    }
  }

  private handlePortLeaseRenew(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const input: PortLeaseRenewInput = {
      leaseId: typeof params.leaseId === "string" ? params.leaseId : "",
      ttlMs: typeof params.ttlMs === "number" ? params.ttlMs : Number(params.ttlMs),
      ownerAgentId: state.agentId,
    };

    try {
      const lease = this.db.renewPortLease(input);
      this.db.touchAgentActivity(state.agentId);
      return rpcOk(req.id, lease);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INVALID_PARAMS, message);
    }
  }

  private handlePortLeaseRelease(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const input: PortLeaseReleaseInput = {
      leaseId: typeof params.leaseId === "string" ? params.leaseId : "",
      ownerAgentId: state.agentId,
    };

    try {
      const lease = this.db.releasePortLease(input);
      this.db.touchAgentActivity(state.agentId);
      return rpcOk(req.id, lease);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INVALID_PARAMS, message);
    }
  }

  private handlePortLeaseStatus(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const leaseId = typeof params.leaseId === "string" ? params.leaseId : "";
    try {
      const lease = this.db.getPortLease(leaseId);
      return rpcOk(req.id, lease?.ownerAgentId === state.agentId ? lease : null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INVALID_PARAMS, message);
    }
  }

  private handlePortLeaseList(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const options: PortLeaseListOptions = {
      ...(typeof params.includeInactive === "boolean"
        ? { includeInactive: params.includeInactive }
        : {}),
      ...(typeof params.expiredOnly === "boolean" ? { expiredOnly: params.expiredOnly } : {}),
      ownerAgentId: state.agentId,
      ...(typeof params.purpose === "string" ? { purpose: params.purpose } : {}),
      ...(typeof params.host === "string" ? { host: params.host } : {}),
    };
    try {
      return rpcOk(req.id, this.db.listPortLeases(options));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INVALID_PARAMS, message);
    }
  }

  private handlePortLeaseExpire(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    try {
      const leases = this.db
        .expirePortLeases()
        .filter((lease) => lease.ownerAgentId === state.agentId);
      if (leases.length > 0) {
        this.db.touchAgentActivity(state.agentId);
      }
      return rpcOk(req.id, leases);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INVALID_PARAMS, message);
    }
  }

  private handleScheduleCreate(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const fireAt = typeof params.fireAt === "string" ? params.fireAt : null;
    const body = typeof params.body === "string" ? params.body.trim() : null;

    if (!fireAt || !body) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "fireAt and body are required");
    }

    if (Number.isNaN(Date.parse(fireAt))) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "fireAt must be a valid ISO timestamp");
    }

    const wakeup = this.db.scheduleWakeup(state.agentId, body, fireAt);
    return rpcOk(req.id, {
      id: wakeup.id,
      threadId: wakeup.threadId,
      fireAt: wakeup.fireAt,
    });
  }

  // ─── Status update handler ─────────────────────────────

  private handleStatusUpdate(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const status = params.status === "working" ? "working" : "idle";
    this.db.updateAgentStatus(state.agentId, status);
    try {
      this.agentStatusChangeCallback?.(state.agentId, status);
    } catch {
      /* best effort */
    }
    return rpcOk(req.id, { ok: true });
  }

  // ─── Adapter capability handler ───────────────────────

  private async handleAdapterCapability(
    req: JsonRpcRequest,
    state: ConnectionState,
  ): Promise<JsonRpcResponse> {
    // #855: adapter.capability must be identity-bound so the broker can
    // enforce thread ownership. Unregistered callers cannot own or claim
    // threads, so they must not be able to invoke outbound-side capabilities
    // (chat.postMessage in particular) that would race a first-responder
    // claim or take over a thread already owned by another agent.
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const adapterName =
      typeof params.adapter === "string"
        ? params.adapter.trim()
        : typeof params.source === "string"
          ? params.source.trim()
          : "";
    const capability = typeof params.capability === "string" ? params.capability.trim() : "";

    if (!adapterName) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "adapter is required for adapter.capability");
    }
    if (!capability) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "capability is required for adapter.capability");
    }

    const capabilityParams =
      params.params && typeof params.params === "object" && !Array.isArray(params.params)
        ? (params.params as Record<string, unknown>)
        : {};

    return await this.dispatchAdapterCapability(
      req.id,
      adapterName,
      capability,
      capabilityParams,
      state,
    );
  }

  private async handleLegacySlackProxy(
    req: JsonRpcRequest,
    state: ConnectionState,
  ): Promise<JsonRpcResponse> {
    // #855: legacy slack.proxy is a compatibility wrapper over
    // adapter.capability and must enforce the same registration bar so
    // unregistered callers cannot bypass thread ownership via chat.postMessage.
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const method = typeof params.method === "string" ? params.method.trim() : "";
    if (!method) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "method is required for slack.proxy");
    }

    const apiParams =
      params.params && typeof params.params === "object" && !Array.isArray(params.params)
        ? (params.params as Record<string, unknown>)
        : {};

    return await this.dispatchAdapterCapability(
      req.id,
      "slack",
      "api.call",
      { method, params: apiParams },
      state,
      "slack.proxy",
    );
  }

  private async dispatchAdapterCapability(
    id: JsonRpcRequest["id"],
    adapterName: string,
    capability: string,
    capabilityParams: Record<string, unknown>,
    state: ConnectionState,
    errorPrefix = `${adapterName}.${capability}`,
  ): Promise<JsonRpcResponse> {
    const adapter = this.outboundMessageAdapters.find(
      (candidate) => candidate.name === adapterName,
    );
    if (!adapter?.invokeCapability) {
      return rpcError(
        id,
        RPC_METHOD_NOT_FOUND,
        `Adapter ${adapterName} does not implement capability ${capability}`,
      );
    }

    // #855: refuse cross-owner Slack chat.postMessage before hitting Slack.
    // Without this pre-check the adapter posts first and the broker races a
    // first-responder-wins claim via effects.claimThread — letting an
    // unauthorized follower take over a thread already owned by another
    // agent simply by winning the send.
    const ownershipError = this.checkAdapterCapabilityThreadOwnership(
      adapterName,
      capability,
      capabilityParams,
      state.agentId,
    );
    if (ownershipError) {
      return rpcError(id, RPC_INVALID_PARAMS, `${errorPrefix}: ${ownershipError}`);
    }

    try {
      const response = await adapter.invokeCapability({ capability, params: capabilityParams });
      this.applyAdapterCapabilityEffects(adapterName, response, state);
      return rpcOk(id, response.result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(id, RPC_INTERNAL_ERROR, `${errorPrefix}: ${message}`);
    }
  }

  private checkAdapterCapabilityThreadOwnership(
    adapterName: string,
    capability: string,
    capabilityParams: Record<string, unknown>,
    callerAgentId: string | null,
  ): string | null {
    if (adapterName !== "slack") return null;
    if (capability !== "api.call") return null;
    const method =
      typeof capabilityParams.method === "string" ? capabilityParams.method.trim() : "";
    if (method !== "chat.postMessage") return null;
    const inner =
      capabilityParams.params &&
      typeof capabilityParams.params === "object" &&
      !Array.isArray(capabilityParams.params)
        ? (capabilityParams.params as Record<string, unknown>)
        : {};
    const threadTs = typeof inner.thread_ts === "string" ? inner.thread_ts.trim() : "";
    if (!threadTs) return null;

    // Defense in depth (#855): even if a future call path forgot the
    // registration guard on the handler, refuse threaded chat.postMessage
    // for unregistered callers here — they cannot own a Slack thread and
    // must not be able to post into one.
    if (!callerAgentId) {
      return `Slack thread ${threadTs}: refusing threaded chat.postMessage from an unregistered caller`;
    }

    const thread = this.db.getThread(threadTs);
    if (!thread?.ownerAgent) return null;
    if (thread.ownerAgent === callerAgentId) return null;
    return `Slack thread ${threadTs} is already owned by another agent; refusing cross-owner chat.postMessage`;
  }

  private applyAdapterCapabilityEffects(
    adapterName: string,
    response: AdapterCapabilityResult,
    state: ConnectionState,
  ): void {
    if (!state.agentId) return;

    const claimThread = response.effects?.claimThread;
    const claims = Array.isArray(claimThread) ? claimThread : claimThread ? [claimThread] : [];
    for (const claim of claims) {
      if (!claim.threadId) continue;
      const claimed = this.router.claimThread(
        claim.threadId,
        state.agentId,
        claim.channel,
        adapterName,
      );
      if (claimed && claim.channel) {
        this.db.updateThread(claim.threadId, { source: adapterName, channel: claim.channel });
      }
    }
  }
}
