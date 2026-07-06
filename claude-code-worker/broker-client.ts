import * as net from "node:net";

/**
 * Lean Pinet broker client for non-Pi worker runtimes.
 *
 * Speaks the broker's newline-delimited JSON-RPC 2.0 protocol over the local
 * Unix socket. Covers the worker-lifecycle subset of the reference client in
 * `slack-bridge/broker/client.ts`: auth, register, heartbeat, inbox poll/ack,
 * thread claim, message send, status updates, and agent-to-agent messaging.
 */

export const REQUEST_TIMEOUT_MS = 5000;
export const HEARTBEAT_INTERVAL_MS = 5000;
export const INITIAL_RECONNECT_DELAY_MS = 1000;
export const MAX_RECONNECT_DELAY_MS = 30000;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

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

export interface RegistrationInput {
  name: string;
  emoji: string;
  stableId?: string;
  metadata?: Record<string, unknown>;
}

export interface RegistrationResult {
  agentId: string;
  name: string;
  emoji: string;
  metadata?: Record<string, unknown> | null;
}

export interface MessageSendInput {
  threadId: string;
  body: string;
  agentName?: string;
  agentEmoji?: string;
  metadata?: Record<string, unknown>;
}

/** Split buffered socket data into complete JSON lines plus the trailing partial line. */
export function splitJsonRpcLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.trim().length > 0), rest };
}

/** Compute reconnect delay with exponential backoff, capped. */
export function computeReconnectDelay(attempt: number): number {
  return Math.min(INITIAL_RECONNECT_DELAY_MS * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS);
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkerBrokerClient {
  private readonly socketPath: string;
  private readonly meshSecret: string | null;
  private socket: net.Socket | null = null;
  private connected = false;
  private shuttingDown = false;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private registration: RegistrationInput | null = null;
  private identity: RegistrationResult | null = null;
  private heartbeatMetadataProvider: (() => Record<string, unknown> | undefined) | null = null;
  private disconnectedHandler: (() => void) | null = null;
  private reconnectedHandler: (() => void) | null = null;

  constructor(options: { socketPath: string; meshSecret?: string | null }) {
    this.socketPath = options.socketPath;
    this.meshSecret = options.meshSecret?.trim() || null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getIdentity(): RegistrationResult | null {
    return this.identity ? { ...this.identity } : null;
  }

  onDisconnected(handler: () => void): void {
    this.disconnectedHandler = handler;
  }

  onReconnected(handler: () => void): void {
    this.reconnectedHandler = handler;
  }

  setHeartbeatMetadataProvider(provider: (() => Record<string, unknown> | undefined) | null): void {
    this.heartbeatMetadataProvider = provider;
  }

  async connect(): Promise<void> {
    this.shuttingDown = false;
    await this.connectSocket();
    if (this.meshSecret) {
      await this.request("auth", { secret: this.meshSecret });
    }
  }

  async register(input: RegistrationInput): Promise<RegistrationResult> {
    this.registration = input;
    const result = (await this.request("register", {
      name: input.name,
      emoji: input.emoji,
      pid: process.pid,
      ...(input.stableId ? { stableId: input.stableId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })) as RegistrationResult;
    this.identity = result;
    this.startHeartbeat();
    return result;
  }

  async disconnectGracefully(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.connected) {
      try {
        await this.request("unregister");
      } catch {
        /* best effort */
      }
    }
    this.destroySocket();
  }

  async pollInbox(): Promise<InboxItem[]> {
    return (await this.request("inbox.poll")) as InboxItem[];
  }

  async ackMessages(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.request("inbox.ack", { ids });
  }

  async messageSend(input: MessageSendInput): Promise<void> {
    await this.request("message.send", {
      threadId: input.threadId,
      body: input.body,
      ...(input.agentName ? { agentName: input.agentName } : {}),
      ...(input.agentEmoji ? { agentEmoji: input.agentEmoji } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  }

  async claimThread(threadId: string): Promise<{ claimed: boolean }> {
    return (await this.request("thread.claim", { threadId })) as { claimed: boolean };
  }

  async updateStatus(status: "working" | "idle"): Promise<void> {
    await this.request("status.update", { status });
  }

  async sendAgentMessage(
    target: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.request("agent.message", {
      targetAgent: target,
      body,
      ...(metadata ? { metadata } : {}),
    });
  }

  // ─── Transport ───────────────────────────────────────

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error(`Not connected to broker (method: ${method})`));
    }

    const id = this.nextId++;
    const line =
      JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n";

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { method, resolve, reject, timer });
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
    const { lines, rest } = splitJsonRpcLines(this.buffer + chunk);
    this.buffer = rest;
    for (const line of lines) {
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(`${entry.method} failed: ${msg.error.message}`));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  private connectSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ path: this.socketPath });

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
          this.disconnectedHandler?.();
          this.scheduleReconnect();
        }
      });

      sock.on("error", (err: Error) => {
        if (!this.connected) {
          reject(err);
        }
      });
    });
  }

  private destroySocket(): void {
    this.rejectAllPending(new Error("Client disconnected"));
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    const delay = computeReconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectOnce();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnectOnce(): Promise<void> {
    try {
      await this.connectSocket();
      if (this.meshSecret) {
        await this.request("auth", { secret: this.meshSecret });
      }
      if (this.registration) {
        const result = (await this.request("register", {
          name: this.registration.name,
          emoji: this.registration.emoji,
          pid: process.pid,
          ...(this.registration.stableId ? { stableId: this.registration.stableId } : {}),
          ...(this.registration.metadata ? { metadata: this.registration.metadata } : {}),
        })) as RegistrationResult;
        this.identity = result;
        this.startHeartbeat();
      }
      this.reconnectAttempt = 0;
      this.reconnectedHandler?.();
    } catch {
      this.destroySocket();
      this.scheduleReconnect();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      const metadata = this.heartbeatMetadataProvider?.();
      void this.request("heartbeat", metadata ? { metadata } : undefined).catch(() => {
        /* best effort */
      });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
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
