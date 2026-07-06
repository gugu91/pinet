import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readMeshSecret } from "@pinet/broker-core/auth";
import { WorkerBrokerClient } from "./broker-client.js";
import type { InboxItem } from "./broker-client.js";
import { runClaudeTask } from "./claude-runner.js";
import type { WorkerConfig } from "./config.js";
import { buildTaskPrompt, extractControlCommand, isAgentToAgentItem } from "./prompts.js";
import { SessionStore } from "./sessions.js";

function timestamp(): string {
  return new Date().toISOString();
}

export class ClaudeCodeWorker {
  private readonly config: WorkerConfig;
  private readonly client: WorkerBrokerClient;
  private readonly sessions: SessionStore;
  private readonly seenInboxIds = new Set<number>();
  private readonly queue: InboxItem[] = [];
  private readonly claimedThreads = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private draining = false;
  private shuttingDown = false;
  private activeThreadId: string | null = null;
  private taskAbort: AbortController | null = null;
  private agentName = "claude-code-worker";
  private agentEmoji = "";

  constructor(config: WorkerConfig) {
    this.config = config;
    fs.mkdirSync(config.stateDir, { recursive: true });
    this.sessions = new SessionStore(config.stateDir);
    this.client = new WorkerBrokerClient({
      socketPath: config.socketPath,
      meshSecret: config.meshSecretPath ? readMeshSecret(config.meshSecretPath) : null,
    });
  }

  async start(): Promise<void> {
    await this.client.connect();
    const registration = await this.client.register({
      name: this.config.name,
      emoji: this.config.emoji,
      stableId: this.config.stableId,
      metadata: this.buildMetadata(),
    });
    this.agentName = registration.name;
    this.agentEmoji = registration.emoji;
    this.client.setHeartbeatMetadataProvider(() => this.buildMetadata());
    this.client.onDisconnected(() => this.log("broker disconnected; reconnecting"));
    this.client.onReconnected(() => this.log("reconnected to broker"));

    this.log(
      `registered as "${registration.name}" ${registration.emoji} (agentId ${registration.agentId}, workdir ${this.config.workdir})`,
    );

    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.config.pollIntervalMs);
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log(`shutting down: ${reason}`);
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.taskAbort?.abort();
    await this.client.disconnectGracefully();
  }

  private buildMetadata(): Record<string, unknown> {
    return {
      runtime: "claude-code",
      cwd: this.config.workdir,
      host: os.hostname(),
      repo: path.basename(this.config.workdir),
      ...(this.activeThreadId ? { activeThreadId: this.activeThreadId } : {}),
      tags: [
        "role:worker",
        "runtime:claude-code",
        `repo:${path.basename(this.config.workdir)}`,
        "tool:git",
      ],
    };
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || this.shuttingDown || !this.client.isConnected()) return;
    this.polling = true;
    try {
      const entries = await this.client.pollInbox();
      for (const entry of entries) {
        if (this.seenInboxIds.has(entry.inboxId)) continue;
        this.seenInboxIds.add(entry.inboxId);

        const control = extractControlCommand(entry);
        if (control) {
          await this.handleControl(control, entry);
          continue;
        }
        this.queue.push(entry);
      }
      void this.drainQueue();
    } catch (err) {
      this.log(`inbox poll failed: ${formatError(err)}`);
    } finally {
      this.polling = false;
    }
  }

  private async handleControl(command: string, entry: InboxItem): Promise<void> {
    this.log(`control command "${command}" from ${entry.message.sender}`);
    await this.client.ackMessages([entry.inboxId]).catch(() => {});
    if (command === "exit") {
      await this.shutdown(`exit requested by ${entry.message.sender}`);
      return;
    }
    if (command === "interrupt") {
      this.taskAbort?.abort();
      return;
    }
    // "reload" has no meaning for this runtime; acknowledge and report.
    await this.replyTo(
      entry,
      `Control command "${command}" is not supported by the claude-code worker runtime.`,
    ).catch(() => {});
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.shuttingDown) {
        const entry = this.queue.shift()!;
        await this.runTask(entry);
      }
    } finally {
      this.draining = false;
      if (!this.shuttingDown) {
        await this.client.updateStatus("idle").catch(() => {});
      }
    }
  }

  private async runTask(entry: InboxItem): Promise<void> {
    const threadId = entry.message.threadId;
    this.activeThreadId = threadId;
    this.taskAbort = new AbortController();
    this.log(`task start: thread ${threadId} from ${entry.message.sender}`);

    await this.client.updateStatus("working").catch(() => {});
    if (!isAgentToAgentItem(entry) && !this.claimedThreads.has(threadId)) {
      const claim = await this.client.claimThread(threadId).catch(() => ({ claimed: false }));
      if (claim.claimed) this.claimedThreads.add(threadId);
    }

    const resumeSessionId = this.sessions.get(threadId);
    const prompt = buildTaskPrompt(entry, {
      agentName: this.agentName,
      workdir: this.config.workdir,
      isResume: resumeSessionId != null,
    });

    try {
      const result = await runClaudeTask({
        claudeBin: this.config.claudeBin,
        cwd: this.config.workdir,
        prompt,
        resumeSessionId,
        model: this.config.model,
        timeoutMs: this.config.taskTimeoutMs,
        signal: this.taskAbort.signal,
      });

      if (result.sessionId) {
        this.sessions.set(threadId, result.sessionId);
      } else if (resumeSessionId && result.isError) {
        // A stale session id can make --resume fail; drop it so the next
        // message starts a fresh session instead of failing forever.
        this.sessions.delete(threadId);
      }

      const replyText = result.text.trim() || "(task produced no output)";
      await this.replyTo(entry, replyText);
      this.log(
        `task done: thread ${threadId} (ok=${result.ok}, exit=${result.exitCode ?? "n/a"}, timedOut=${result.timedOut})`,
      );
      if (!result.ok) {
        this.log(`task stderr tail: ${result.stderrTail.slice(-500)}`);
      }
    } catch (err) {
      this.log(`task failed: thread ${threadId}: ${formatError(err)}`);
      await this.replyTo(
        entry,
        `Task failed inside the claude-code worker: ${formatError(err)}`,
      ).catch(() => {});
    } finally {
      // Ack regardless of outcome: redelivering a failing task would loop.
      await this.client.ackMessages([entry.inboxId]).catch(() => {});
      this.activeThreadId = null;
      this.taskAbort = null;
    }
  }

  private async replyTo(entry: InboxItem, body: string): Promise<void> {
    if (isAgentToAgentItem(entry)) {
      await this.client.sendAgentMessage(entry.message.sender, body);
      return;
    }
    await this.client.messageSend({
      threadId: entry.message.threadId,
      body,
      agentName: this.agentName,
      ...(this.agentEmoji ? { agentEmoji: this.agentEmoji } : {}),
    });
  }

  private log(message: string): void {
    console.log(`[${timestamp()}] [claude-code-worker] ${message}`);
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
