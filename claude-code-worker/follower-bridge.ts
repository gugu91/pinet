import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { readMeshSecret } from "@pinet/broker-core/auth";
import { WorkerBrokerClient } from "./broker-client.js";
import type { InboxItem } from "./broker-client.js";
import type { WorkerConfig } from "./config.js";
import { extractControlCommand, isAgentToAgentItem } from "./prompts.js";

/**
 * Follower bridge: the mesh-mechanics half of an interactive follower.
 *
 * Owns the broker connection (register/heartbeat/poll/ack/claim/send) and a
 * local spool of pending inbox items. The harness half (for Claude Code: the
 * MCP server in `mcp-server.ts` plus the `wait` CLI subcommand) only delivers
 * spool contents into a live conversation and routes replies back — the seam
 * that later becomes `@pinet/follower-bridge` for other harnesses.
 */

export interface FollowResult {
  name: string;
  emoji: string;
  agentId: string;
  waiterSocketPath: string;
}

export interface PendingMessage {
  inboxId: number;
  threadId: string;
  /** Raw sender as the broker reports it (agentId for a2a) — used for routing. */
  sender: string;
  /** Human-readable sender name when resolvable from the roster. */
  senderDisplay?: string;
  source: string;
  body: string;
  a2a: boolean;
  createdAt: string;
}

interface WaiterResponse {
  pending?: number;
  summaries?: string[];
  exit?: boolean;
}

interface ThreadRoute {
  a2a: boolean;
  sender: string;
}

export function toPendingMessage(item: InboxItem): PendingMessage {
  return {
    inboxId: item.inboxId,
    threadId: item.message.threadId,
    sender: item.message.sender,
    source: item.message.source,
    body: item.message.body ?? "",
    a2a: isAgentToAgentItem(item),
    createdAt: item.message.createdAt,
  };
}

/** Human/model-readable rendering of pending messages for `pinet_read`. */
export function formatPendingMessages(messages: PendingMessage[]): string {
  if (messages.length === 0) return "No pending mesh messages.";
  const blocks = messages.map((msg, i) => {
    const kind = msg.a2a ? "agent-to-agent" : `thread (source: ${msg.source})`;
    const who = msg.senderDisplay ?? msg.sender;
    return [
      `[${i + 1}] ${kind} from "${who}" — threadId: ${msg.threadId} (${msg.createdAt})`,
      msg.body.trim() || "(empty message)",
    ].join("\n");
  });
  return [
    `${messages.length} pending mesh message(s):`,
    "",
    blocks.join("\n\n"),
    "",
    "Handle each as a task; reply with pinet_send using the same threadId.",
  ].join("\n");
}

export function summarizeForWaiter(messages: PendingMessage[]): string[] {
  return messages.map((msg) => {
    const body = msg.body.trim().replace(/\s+/g, " ");
    const preview = body.length > 120 ? `${body.slice(0, 117)}...` : body;
    return `${msg.senderDisplay ?? msg.sender}: ${preview || "(empty)"}`;
  });
}

export class FollowerBridge {
  private readonly config: WorkerConfig;
  private client: WorkerBrokerClient | null = null;
  private readonly spool: PendingMessage[] = [];
  private readonly seenInboxIds = new Set<number>();
  private readonly threadRoutes = new Map<string, ThreadRoute>();
  private readonly claimedThreads = new Set<string>();
  private readonly parkedWaiters = new Set<net.Socket>();
  private waiterServer: net.Server | null = null;
  private waiterSocketPath: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private following = false;
  private exitRequested = false;
  private agentName = "";
  private agentEmoji = "";

  constructor(config: WorkerConfig) {
    this.config = config;
  }

  isFollowing(): boolean {
    return this.following;
  }

  wasExitRequested(): boolean {
    return this.exitRequested;
  }

  getIdentity(): { name: string; emoji: string } | null {
    return this.following ? { name: this.agentName, emoji: this.agentEmoji } : null;
  }

  async follow(opts: { name?: string; emoji?: string } = {}): Promise<FollowResult> {
    if (this.following && this.client) {
      const identity = this.client.getIdentity();
      return {
        name: identity?.name ?? this.agentName,
        emoji: identity?.emoji ?? this.agentEmoji,
        agentId: identity?.agentId ?? "",
        waiterSocketPath: this.waiterSocketPath!,
      };
    }

    this.exitRequested = false;
    this.client = new WorkerBrokerClient({
      socketPath: this.config.socketPath,
      meshSecret: this.config.meshSecretPath ? readMeshSecret(this.config.meshSecretPath) : null,
    });
    await this.client.connect();
    const registration = await this.client.register({
      name: opts.name ?? "",
      emoji: opts.emoji ?? "",
      stableId: `claude-code-interactive:${os.hostname()}:${process.pid}`,
      metadata: this.buildMetadata(),
    });
    this.agentName = registration.name;
    this.agentEmoji = registration.emoji;
    this.client.setHeartbeatMetadataProvider(() => this.buildMetadata());

    this.waiterSocketPath = await this.startWaiterServer();
    this.following = true;

    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.config.pollIntervalMs);
    this.pollTimer.unref?.();

    await this.client.updateStatus("idle").catch(() => {});
    this.log(`following as "${registration.name}" ${registration.emoji}`);
    return {
      name: registration.name,
      emoji: registration.emoji,
      agentId: registration.agentId,
      waiterSocketPath: this.waiterSocketPath,
    };
  }

  async unfollow(reason: string): Promise<void> {
    if (!this.following && !this.client) return;
    this.following = false;
    this.log(`unfollowing: ${reason}`);
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.respondToWaiters({ exit: true });
    await this.stopWaiterServer();
    if (this.client) {
      await this.client.disconnectGracefully().catch(() => {});
      this.client = null;
    }
  }

  /** Drain the spool: ack everything handed out and flip status to working. */
  async read(): Promise<PendingMessage[]> {
    const drained = this.spool.splice(0, this.spool.length);
    if (drained.length === 0) return drained;
    if (this.client?.isConnected()) {
      await this.client.ackMessages(drained.map((m) => m.inboxId)).catch(() => {});
      await this.client.updateStatus("working").catch(() => {});
    }
    return drained;
  }

  async send(threadId: string, body: string): Promise<string> {
    if (!this.client?.isConnected()) {
      throw new Error("Not connected to the mesh — call pinet_follow first.");
    }
    const route = this.threadRoutes.get(threadId);
    if (route?.a2a || threadId.startsWith("a2a:")) {
      const target = route?.sender;
      if (!target) {
        throw new Error(
          `No known sender for agent-to-agent thread ${threadId}; cannot route the reply.`,
        );
      }
      await this.client.sendAgentMessage(target, body);
      return `Sent agent-to-agent reply to "${target}".`;
    }
    if (!this.claimedThreads.has(threadId)) {
      const claim = await this.client.claimThread(threadId).catch(() => ({ claimed: false }));
      if (claim.claimed) this.claimedThreads.add(threadId);
    }
    await this.client.messageSend({
      threadId,
      body,
      agentName: this.agentName,
      ...(this.agentEmoji ? { agentEmoji: this.agentEmoji } : {}),
    });
    return `Sent to thread ${threadId}.`;
  }

  async listAgents(): Promise<unknown> {
    if (!this.client?.isConnected()) {
      throw new Error("Not connected to the mesh — call pinet_follow first.");
    }
    return this.client.listAgents();
  }

  async setStatus(status: "working" | "idle"): Promise<void> {
    if (!this.client?.isConnected()) {
      throw new Error("Not connected to the mesh — call pinet_follow first.");
    }
    await this.client.updateStatus(status);
  }

  private buildMetadata(): Record<string, unknown> {
    return {
      runtime: "claude-code",
      harness: "interactive",
      cwd: this.config.workdir,
      host: os.hostname(),
      repo: path.basename(this.config.workdir),
      tags: [
        "role:follower",
        "runtime:claude-code",
        "harness:interactive",
        `repo:${path.basename(this.config.workdir)}`,
      ],
    };
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || !this.following || !this.client?.isConnected()) return;
    this.polling = true;
    try {
      const entries = await this.client.pollInbox();
      let spooled = false;
      for (const entry of entries) {
        if (this.seenInboxIds.has(entry.inboxId)) continue;
        this.seenInboxIds.add(entry.inboxId);

        const control = extractControlCommand(entry);
        if (control) {
          await this.handleControl(control, entry);
          continue;
        }
        const pending = toPendingMessage(entry);
        this.threadRoutes.set(pending.threadId, { a2a: pending.a2a, sender: pending.sender });
        this.spool.push(pending);
        spooled = true;
      }
      if (spooled) {
        await this.resolveSenderNames();
        this.notifyWaiters();
      }
    } catch (err) {
      this.log(`inbox poll failed: ${formatError(err)}`);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Best-effort: a2a senders arrive as agentIds; map them to roster names so
   * the model (and waiter summaries) see "The Broker Lion", not a UUID. The
   * roster reports short id prefixes, so match by prefix either way.
   */
  private async resolveSenderNames(): Promise<void> {
    const unresolved = this.spool.filter((m) => m.a2a && !m.senderDisplay);
    if (unresolved.length === 0 || !this.client?.isConnected()) return;
    try {
      const roster = (await this.client.listAgents()) as { id?: string; name?: string }[];
      if (!Array.isArray(roster)) return;
      for (const msg of unresolved) {
        const agent = roster.find(
          (a) => a.id && (msg.sender === a.id || msg.sender.startsWith(a.id)),
        );
        if (agent?.name) msg.senderDisplay = agent.name;
      }
    } catch {
      /* display-only; raw sender still routes replies */
    }
  }

  private async handleControl(command: string, entry: InboxItem): Promise<void> {
    this.log(`control command "${command}" from ${entry.message.sender}`);
    await this.client?.ackMessages([entry.inboxId]).catch(() => {});
    if (command === "exit") {
      this.exitRequested = true;
      await this.unfollow(`exit requested by ${entry.message.sender}`);
      return;
    }
    // Interactive sessions cannot be interrupted or reloaded from the mesh.
    await this.client
      ?.sendAgentMessage(
        entry.message.sender,
        `Control command "${command}" is not supported in interactive follower mode; only "exit" is honored.`,
      )
      .catch(() => {});
  }

  // ─── Waiter socket ───────────────────────────────────

  private startWaiterServer(): Promise<string> {
    const dir = path.join(this.config.stateDir, "sessions");
    fs.mkdirSync(dir, { recursive: true });
    const socketPath = path.join(dir, `bridge-${process.pid}.sock`);
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* no stale socket */
    }

    return new Promise<string>((resolve, reject) => {
      const server = net.createServer((socket) => this.handleWaiterConnection(socket));
      server.on("error", reject);
      server.listen(socketPath, () => {
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch {
          /* best effort */
        }
        this.waiterServer = server;
        server.unref?.();
        resolve(socketPath);
      });
    });
  }

  private handleWaiterConnection(socket: net.Socket): void {
    socket.on("error", () => {
      this.parkedWaiters.delete(socket);
    });
    socket.on("close", () => {
      this.parkedWaiters.delete(socket);
    });
    socket.on("data", () => {
      // Any request line means "wait for messages"; respond now or park.
      if (this.exitRequested || !this.following) {
        this.respondTo(socket, { exit: true });
        return;
      }
      if (this.spool.length > 0) {
        this.respondTo(socket, {
          pending: this.spool.length,
          summaries: summarizeForWaiter(this.spool),
        });
        return;
      }
      this.parkedWaiters.add(socket);
      // Waiter armed with an empty spool is the definition of idle.
      void this.client?.updateStatus("idle").catch(() => {});
    });
  }

  private notifyWaiters(): void {
    if (this.parkedWaiters.size === 0 || this.spool.length === 0) return;
    this.respondToWaiters({
      pending: this.spool.length,
      summaries: summarizeForWaiter(this.spool),
    });
  }

  private respondToWaiters(response: WaiterResponse): void {
    for (const socket of [...this.parkedWaiters]) {
      this.respondTo(socket, response);
    }
  }

  private respondTo(socket: net.Socket, response: WaiterResponse): void {
    this.parkedWaiters.delete(socket);
    try {
      socket.end(JSON.stringify(response) + "\n");
    } catch {
      /* waiter already gone */
    }
  }

  private async stopWaiterServer(): Promise<void> {
    if (!this.waiterServer) return;
    const server = this.waiterServer;
    this.waiterServer = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.waiterSocketPath) {
      try {
        fs.unlinkSync(this.waiterSocketPath);
      } catch {
        /* already gone */
      }
    }
  }

  private log(message: string): void {
    // stderr only: stdout belongs to the MCP protocol when embedded there.
    console.error(`[follower-bridge] ${message}`);
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
