/**
 * Amp mesh worker orchestration.
 *
 * The worker polls its durable broker inbox, executes each assignment as an
 * Amp thread turn (one Amp thread per Pinet thread), replies through the
 * broker, and only then acks. Durable phases live in AmpWorkerStateStore so a
 * restart never re-runs Amp for an executed assignment and never drops a
 * reply:
 *
 *   poll ─▶ execute (Amp) ─▶ persist "executed" ─▶ reply ─▶ persist "replied" ─▶ ack
 *
 * Reply routing depends on where the assignment came from:
 * - mesh agent threads (source "agent" / a2a:*): durable direct agent message
 *   back to the originating agent (`agent.message`), which persists an inbox
 *   row for the target even if it is briefly disconnected.
 * - external transport threads (slack, imessage, …): the broker's adapter
 *   path (`message.send`), so success means the external delivery was
 *   accepted. Neither path can silently succeed with zero recipients.
 *
 * Replies carry a stable per-job `externalId` in their metadata. Broker and
 * a2a retries deduplicate committed sends. External adapters remain
 * at-least-once in the unavoidable crash window after their side effect but
 * before the broker DB commit unless that provider supports idempotency.
 *
 * Control envelopes (pinet:control) are honored per the shared mesh contract:
 * - interrupt: SIGTERM the locally owned Amp child process (Amp has no
 *   external cancel API). While a run is in flight a side control-watcher
 *   polls the inbox so interrupts are not stuck behind the busy loop.
 * - exit: interrupt any in-flight run, then unregister and stop.
 * - reload: re-register with refreshed metadata.
 *
 * Steering envelopes (pinet:steer) apply at the next safe boundary: the loop
 * is sequential per worker, so a steering message becomes the very next Amp
 * turn for its thread. Never logs message bodies, prompts, or secrets.
 */

import type { TransportJsonObject } from "@pinet/transport-core";
import {
  extractPinetControlCommand,
  extractPinetSteeringMessage,
  type PinetControlCommand,
} from "@pinet/broker-core/mail-control";
import { classifyPinetMail } from "@pinet/broker-core/mail-classification";
import type { InboxItem } from "@pinet/pinet-core/broker-client";
import type { AmpExecutionResult } from "./amp-runner.js";
import type { AmpWorkerStateStore, AmpJobRecord } from "./state-store.js";

// ─── Ports (dependency seams for tests and future harnesses) ──

export interface AmpWorkerBrokerPort {
  connect(): Promise<void>;
  register(
    name: string,
    emoji: string,
    metadata?: TransportJsonObject,
    stableId?: string,
  ): Promise<{ agentId: string; name: string; emoji: string }>;
  pollInbox(): Promise<InboxItem[]>;
  ackMessages(ids: number[]): Promise<void>;
  /**
   * Reply on an external transport thread (slack, imessage, …). The broker
   * routes through the matching transport adapter, so success means the
   * external delivery was accepted — never a silent no-recipient commit.
   */
  sendMessage(input: {
    threadId: string;
    body: string;
    agentName?: string;
    agentEmoji?: string;
    metadata?: TransportJsonObject;
  }): Promise<{ messageId: number }>;
  /**
   * Reply to a mesh agent. The broker persists a durable inbox row for the
   * target, so a briefly disconnected recipient still receives it; an unknown
   * target fails loudly and the worker retries via redelivery.
   */
  sendAgentMessage(target: string, body: string, metadata?: TransportJsonObject): Promise<number>;
  updateStatus(status: "working" | "idle"): Promise<void>;
  disconnectGracefully(): Promise<void>;
  onReconnectFailed(handler: (error: Error) => void): void;
}

export interface AmpWorkerRunnerPort {
  createThread(): Promise<string>;
  continueThread(ampThreadId: string, message: string): Promise<AmpExecutionResult>;
  interrupt(): boolean;
  isBusy(): boolean;
}

export interface AmpWorkerOptions {
  client: AmpWorkerBrokerPort;
  runner: AmpWorkerRunnerPort;
  store: AmpWorkerStateStore;
  name: string;
  emoji: string;
  stableId: string;
  /** Called at registration and on reload; must never contain secrets. */
  metadataProvider: () => TransportJsonObject;
  pollIntervalMs: number;
  /** Bounded in-process execution attempts before a durable failure outcome. */
  maxExecutionAttempts?: number;
  /** Diagnostics sink; receives short status lines without message bodies. */
  log?: (line: string) => void;
}

const DEFAULT_MAX_EXECUTION_ATTEMPTS = 3;

/**
 * A durable-state commit failed. This is terminal for the worker: retrying
 * around a broken state store risks duplicate Amp executions (a finished run
 * whose "executed" record never persisted would re-run), so the worker stops
 * and surfaces the fault to the operator instead.
 */
export class StateCommitError extends Error {
  constructor(operation: string, cause: Error) {
    super(`Durable state commit failed (${operation}): ${cause.message}`);
    this.name = "StateCommitError";
  }
}

// ─── Prompt/reply shaping ─────────────────────────────────

export function buildAmpPrompt(input: {
  threadId: string;
  sender: string;
  body: string;
  isSteering: boolean;
}): string {
  const kind = input.isSteering ? "Steering update for your current work" : "New message";
  return [
    `${kind} from Pinet mesh thread ${input.threadId} (sender: ${input.sender}).`,
    "",
    input.body,
    "",
    "Your final message will be delivered back to that Pinet thread as your reply.",
  ].join("\n");
}

export function buildReplyText(job: AmpJobRecord): string {
  if (job.outcome === "interrupted") {
    return "⚠️ Amp execution was interrupted before completion. The task may be partially done; send a follow-up message to continue.";
  }
  if (job.outcome === "error") {
    return job.resultText && job.resultText.trim().length > 0
      ? job.resultText
      : "❌ Amp execution failed before producing a final message. Check the amp-worker host for details and resend to retry.";
  }
  return job.resultText && job.resultText.trim().length > 0
    ? job.resultText
    : "(Amp finished without a final message.)";
}

// ─── Worker ───────────────────────────────────────────────

export class AmpWorker {
  private readonly client: AmpWorkerBrokerPort;
  private readonly runner: AmpWorkerRunnerPort;
  private readonly store: AmpWorkerStateStore;
  private readonly name: string;
  private readonly emoji: string;
  private readonly stableId: string;
  private readonly metadataProvider: () => TransportJsonObject;
  private readonly pollIntervalMs: number;
  private readonly maxExecutionAttempts: number;
  private readonly log: (line: string) => void;

  private stopRequested = false;
  private wake: (() => void) | null = null;
  private terminalError: Error | null = null;
  private readonly executionAttempts = new Map<number, number>();
  /** Inbox IDs the control-watcher already acked mid-run. */
  private readonly handledControlInboxIds = new Set<number>();

  constructor(options: AmpWorkerOptions) {
    this.client = options.client;
    this.runner = options.runner;
    this.store = options.store;
    this.name = options.name;
    this.emoji = options.emoji;
    this.stableId = options.stableId;
    this.metadataProvider = options.metadataProvider;
    this.pollIntervalMs = options.pollIntervalMs;
    this.maxExecutionAttempts = options.maxExecutionAttempts ?? DEFAULT_MAX_EXECUTION_ATTEMPTS;
    this.log = options.log ?? (() => {});
  }

  requestStop(): void {
    this.stopRequested = true;
    this.runner.interrupt();
    this.wake?.();
  }

  isStopRequested(): boolean {
    return this.stopRequested;
  }

  /** Connect, register, and run the poll loop until stop is requested. */
  async start(): Promise<void> {
    this.store.load();

    this.client.onReconnectFailed((error) => {
      this.terminalError = error;
      this.requestStop();
    });

    await this.client.connect();
    const registration = await this.client.register(
      this.name,
      this.emoji,
      this.metadataProvider(),
      this.stableId,
    );
    this.log(`registered as ${registration.name} (${registration.agentId})`);

    try {
      while (!this.stopRequested) {
        try {
          await this.processBatch();
        } catch (err) {
          this.log(`batch error: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (this.stopRequested) break;
        await this.sleepUntilWake();
      }
    } finally {
      try {
        await this.client.disconnectGracefully();
      } catch {
        /* already disconnected */
      }
    }

    if (this.terminalError) {
      throw this.terminalError;
    }
  }

  // ─── Poll loop ─────────────────────────────────────────

  private async processBatch(): Promise<void> {
    const items = await this.client.pollInbox();
    this.pruneHandledControlIds(items);
    if (items.length === 0) return;

    items.sort((left, right) => left.inboxId - right.inboxId);
    for (const item of items) {
      if (this.stopRequested) return;
      if (this.handledControlInboxIds.delete(item.inboxId)) continue;
      try {
        await this.processItem(item);
      } catch (err) {
        this.log(
          `message ${item.message.id} failed (will retry via redelivery): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async processItem(item: InboxItem): Promise<void> {
    const message = item.message;

    const control = extractPinetControlCommand({
      threadId: message.threadId,
      body: message.body,
      metadata: message.metadata,
    });
    if (control) {
      await this.handleControl(control, item);
      return;
    }

    const steering = extractPinetSteeringMessage({
      threadId: message.threadId,
      body: message.body,
      metadata: message.metadata,
    });

    if (!steering) {
      const classification = classifyPinetMail({
        source: message.source,
        threadId: message.threadId,
        sender: message.sender,
        body: message.body,
        metadata: message.metadata,
      });
      if (classification.class === "maintenance_context") {
        // Context-only mail must not burn an Amp execution; ack and move on.
        await this.client.ackMessages([item.inboxId]);
        return;
      }
    }

    const existing = this.store.getJob(message.id);
    if (existing) {
      // Restart/redelivery recovery: never re-run Amp for a recorded job.
      await this.finishJob(existing, item);
      return;
    }

    try {
      await this.executeAssignment(item, steering);
    } catch (err) {
      if (err instanceof StateCommitError) {
        // A finished Amp run may exist without a durable record; retrying
        // would re-run it. Stop instead of counting this as a startup failure.
        throw err;
      }
      const attempts = (this.executionAttempts.get(message.id) ?? 0) + 1;
      this.executionAttempts.set(message.id, attempts);
      if (attempts < this.maxExecutionAttempts) {
        throw err;
      }
      // Bounded durable failure instead of a redelivery loop.
      this.executionAttempts.delete(message.id);
      this.commitState("recordExecuted", () =>
        this.store.recordExecuted({
          messageId: message.id,
          threadId: message.threadId,
          outcome: "error",
          resultText: `❌ Amp worker could not start this execution after ${attempts} attempts: ${err instanceof Error ? err.message : String(err)}`,
          ampThreadId: this.store.getAmpThreadId(message.threadId),
        }),
      );
      const job = this.store.getJob(message.id);
      if (job) {
        await this.finishJob(job, item);
      }
      return;
    }

    this.executionAttempts.delete(message.id);
    const job = this.store.getJob(message.id);
    if (job) {
      await this.finishJob(job, item);
    }
  }

  private async executeAssignment(item: InboxItem, steering: string | null): Promise<void> {
    const message = item.message;

    // The control watcher covers the whole owned-child window, including
    // `amp threads new`, so an interrupt/exit control can stop a hung setup.
    await this.updateStatusQuietly("working");
    const watcher = this.startControlWatcher();
    let execution: AmpExecutionResult;
    let ampThreadId: string;
    try {
      const existingThread = this.store.getAmpThreadId(message.threadId);
      if (existingThread) {
        ampThreadId = existingThread;
      } else {
        ampThreadId = await this.runner.createThread();
        // Persist the mapping before executing so a crash mid-run reuses the
        // same Amp thread instead of forking the conversation.
        const createdThreadId = ampThreadId;
        this.commitState("setAmpThreadId", () =>
          this.store.setAmpThreadId(message.threadId, createdThreadId),
        );
        this.log(`thread ${message.threadId} -> new amp thread`);
      }

      if (this.stopRequested) {
        throw new Error("Worker stop was requested before the Amp turn started.");
      }

      const prompt = buildAmpPrompt({
        threadId: message.threadId,
        sender: message.sender,
        body: steering ?? message.body,
        isSteering: steering !== null,
      });
      execution = await this.runner.continueThread(ampThreadId, prompt);
    } finally {
      await watcher.stop();
      await this.updateStatusQuietly("idle");
    }

    this.commitState("recordExecuted", () =>
      this.store.recordExecuted({
        messageId: message.id,
        threadId: message.threadId,
        outcome: execution.status,
        resultText: execution.resultText,
        ampThreadId: execution.ampThreadId ?? ampThreadId,
      }),
    );
    this.log(`message ${message.id} executed (${execution.status})`);
  }

  /** Reply (if not already replied), then ack, then drop the durable record. */
  private async finishJob(job: AmpJobRecord, item: InboxItem): Promise<void> {
    if (job.phase === "executed") {
      const metadata: TransportJsonObject = {
        harness: "amp",
        adapter: "amp-worker",
        outcome: job.outcome,
        // Stable idempotency key: the broker dedupes on (source, externalId),
        // so if the send committed but the response was lost (or the worker
        // crashed before persisting "replied"), the restart's re-send returns
        // the existing message instead of duplicating the reply — and for
        // external transports it also skips the duplicate adapter delivery.
        externalId: `amp-worker:${this.stableId}:reply:${job.messageId}`,
        replyToThreadId: job.threadId,
        ...(job.ampThreadId ? { ampThreadId: job.ampThreadId } : {}),
      };
      const replyText = buildReplyText(job);
      if (item.message.source === "agent" || job.threadId.startsWith("a2a:")) {
        // Mesh assignment: reply as a durable direct agent message to the
        // originating agent. The legacy broadcast-style "send" RPC would
        // succeed with zero recipients if the originator was disconnected.
        await this.client.sendAgentMessage(item.message.sender, replyText, metadata);
      } else {
        // External transport thread: route through the broker's adapter path
        // so the reply actually reaches the external thread.
        await this.client.sendMessage({
          threadId: job.threadId,
          body: replyText,
          agentName: this.name,
          agentEmoji: this.emoji,
          metadata,
        });
      }
      this.commitState("recordReplied", () => this.store.recordReplied(job.messageId));
    }
    await this.client.ackMessages([item.inboxId]);
    this.commitState("completeJob", () => this.store.completeJob(job.messageId));
    this.log(`message ${job.messageId} completed (${job.outcome})`);
  }

  /**
   * Run a durable-state mutation; on failure, convert to a terminal
   * StateCommitError and stop the worker. The store keeps memory at the last
   * durable snapshot, so nothing here can be half-applied — but continuing to
   * poll with a broken store risks duplicate Amp executions.
   */
  private commitState(operation: string, mutate: () => void): void {
    try {
      mutate();
    } catch (err) {
      const error = new StateCommitError(
        operation,
        err instanceof Error ? err : new Error(String(err)),
      );
      this.terminalError = error;
      this.requestStop();
      throw error;
    }
  }

  // ─── Control plane ─────────────────────────────────────

  private async handleControl(command: PinetControlCommand, item: InboxItem): Promise<void> {
    this.log(`control: ${command}`);
    if (command === "interrupt") {
      this.runner.interrupt();
      await this.client.ackMessages([item.inboxId]);
      return;
    }
    if (command === "exit") {
      await this.client.ackMessages([item.inboxId]);
      this.requestStop();
      return;
    }
    // reload: refresh registration metadata; the Amp worker has no runtime to
    // restart, and this capability is advertised as "reregister-metadata".
    await this.client.register(this.name, this.emoji, this.metadataProvider(), this.stableId);
    await this.client.ackMessages([item.inboxId]);
  }

  /**
   * While an Amp execution is in flight the main loop is blocked, so a side
   * watcher polls the inbox for control envelopes only. Interrupt/exit take
   * effect immediately (SIGTERM of the owned child); everything else stays
   * unacked for the main loop.
   */
  private startControlWatcher(): { stop: () => Promise<void> } {
    let cancelled = false;
    let inFlight: Promise<void> | null = null;

    const tick = async (): Promise<void> => {
      try {
        const items = await this.client.pollInbox();
        for (const item of items) {
          if (cancelled) return;
          if (this.handledControlInboxIds.has(item.inboxId)) continue;
          const control = extractPinetControlCommand({
            threadId: item.message.threadId,
            body: item.message.body,
            metadata: item.message.metadata,
          });
          if (control !== "interrupt" && control !== "exit") continue;
          this.log(`control during run: ${control}`);
          this.runner.interrupt();
          if (control === "exit") {
            this.requestStop();
          }
          await this.client.ackMessages([item.inboxId]);
          this.handledControlInboxIds.add(item.inboxId);
        }
      } catch {
        /* transient poll failures are retried on the next tick */
      }
    };

    const timer = setInterval(() => {
      if (cancelled || inFlight) return;
      inFlight = tick().finally(() => {
        inFlight = null;
      });
    }, this.pollIntervalMs);
    timer.unref?.();

    return {
      // Await the in-flight tick so no watcher poll/ack overlaps the main
      // loop once the run has finished.
      stop: async () => {
        cancelled = true;
        clearInterval(timer);
        await inFlight;
      },
    };
  }

  /**
   * IDs the control-watcher acked mid-run only matter while a batch polled
   * before that ack can still contain them. Anything absent from the newest
   * poll is already acked broker-side and can never reappear, so drop it.
   */
  private pruneHandledControlIds(items: InboxItem[]): void {
    if (this.handledControlInboxIds.size === 0) return;
    const current = new Set(items.map((item) => item.inboxId));
    for (const id of this.handledControlInboxIds) {
      if (!current.has(id)) {
        this.handledControlInboxIds.delete(id);
      }
    }
  }

  // ─── Small utilities ───────────────────────────────────

  private async updateStatusQuietly(status: "working" | "idle"): Promise<void> {
    try {
      await this.client.updateStatus(status);
    } catch {
      /* status is advisory */
    }
  }

  private sleepUntilWake(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, this.pollIntervalMs);
      timer.unref?.();
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
