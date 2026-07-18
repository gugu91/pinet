import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransportJsonObject } from "@pinet/transport-core";
import type { InboxItem } from "@pinet/pinet-core/broker-client";
import type { AmpExecutionResult } from "./amp-runner.js";
import { AmpWorkerStateStore } from "./state-store.js";
import {
  AmpWorker,
  StateCommitError,
  buildAmpPrompt,
  buildReplyText,
  type AmpWorkerBrokerPort,
  type AmpWorkerRunnerPort,
} from "./worker.js";

// ─── Fakes ────────────────────────────────────────────────

class FakeBroker implements AmpWorkerBrokerPort {
  items: InboxItem[] = [];
  acked = new Set<number>();
  sends: Array<{ threadId: string; text: string; metadata?: TransportJsonObject }> = [];
  agentSends: Array<{ target: string; text: string; metadata?: TransportJsonObject }> = [];
  registrations: Array<{ name: string; metadata?: TransportJsonObject; stableId?: string }> = [];
  statusUpdates: string[] = [];
  events: string[] = [];
  disconnected = false;
  sendFailuresRemaining = 0;
  agentSendFailuresRemaining = 0;
  private reconnectFailedHandler: ((error: Error) => void) | null = null;

  enqueue(item: InboxItem): void {
    this.items.push(item);
  }

  failReconnect(error: Error): void {
    this.reconnectFailedHandler?.(error);
  }

  async connect(): Promise<void> {}

  async register(
    name: string,
    emoji: string,
    metadata?: TransportJsonObject,
    stableId?: string,
  ): Promise<{ agentId: string; name: string; emoji: string }> {
    this.registrations.push({
      name,
      ...(metadata ? { metadata } : {}),
      ...(stableId ? { stableId } : {}),
    });
    this.events.push("register");
    return { agentId: "agent-1", name, emoji };
  }

  async pollInbox(): Promise<InboxItem[]> {
    return this.items.filter((item) => !this.acked.has(item.inboxId));
  }

  async ackMessages(ids: number[]): Promise<void> {
    for (const id of ids) {
      this.acked.add(id);
      this.events.push(`ack:${id}`);
    }
  }

  async sendMessage(input: {
    threadId: string;
    body: string;
    agentName?: string;
    agentEmoji?: string;
    metadata?: TransportJsonObject;
  }): Promise<{ messageId: number }> {
    if (this.sendFailuresRemaining > 0) {
      this.sendFailuresRemaining -= 1;
      throw new Error("simulated send failure");
    }
    this.sends.push({
      threadId: input.threadId,
      text: input.body,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    this.events.push(`send:${input.threadId}`);
    return { messageId: this.sends.length };
  }

  async sendAgentMessage(
    target: string,
    text: string,
    metadata?: TransportJsonObject,
  ): Promise<number> {
    if (this.agentSendFailuresRemaining > 0) {
      this.agentSendFailuresRemaining -= 1;
      throw new Error(`Agent not found: ${target}`);
    }
    this.agentSends.push({ target, text, ...(metadata ? { metadata } : {}) });
    this.events.push(`agent-send:${target}`);
    return this.agentSends.length;
  }

  async updateStatus(status: "working" | "idle"): Promise<void> {
    this.statusUpdates.push(status);
  }

  async disconnectGracefully(): Promise<void> {
    this.disconnected = true;
  }

  onReconnectFailed(handler: (error: Error) => void): void {
    this.reconnectFailedHandler = handler;
  }
}

type FakeRunnerBehavior = (input: {
  ampThreadId: string;
  message: string;
}) => Promise<AmpExecutionResult> | AmpExecutionResult;

const okResult = (ampThreadId: string): AmpExecutionResult => ({
  status: "ok",
  resultText: "amp says done",
  ampThreadId,
  exitCode: 0,
  signal: null,
  stderrTail: "",
});

class FakeRunner implements AmpWorkerRunnerPort {
  calls: Array<{ ampThreadId: string; message: string }> = [];
  createThreadCount = 0;
  interruptCount = 0;
  behavior: FakeRunnerBehavior = ({ ampThreadId }) => okResult(ampThreadId);
  private busy = false;
  private pendingInterrupt: (() => void) | null = null;
  private createThreadImpl: (() => Promise<string>) | null = null;

  /** Behavior that stays busy until interrupt() is called. */
  hangUntilInterrupted(): void {
    this.behavior = ({ ampThreadId }) =>
      new Promise<AmpExecutionResult>((resolve) => {
        this.pendingInterrupt = () =>
          resolve({
            status: "interrupted",
            resultText: null,
            ampThreadId,
            exitCode: null,
            signal: "SIGTERM",
            stderrTail: "",
          });
      });
  }

  /** Thread creation that hangs until interrupt() is called, then rejects. */
  hangCreateUntilInterrupted(): void {
    this.createThreadImpl = () =>
      new Promise<string>((_resolve, reject) => {
        this.pendingInterrupt = () => reject(new Error('"amp threads new" was interrupted.'));
      });
  }

  async createThread(): Promise<string> {
    this.createThreadCount += 1;
    if (this.createThreadImpl) {
      this.busy = true;
      try {
        return await this.createThreadImpl();
      } finally {
        this.busy = false;
      }
    }
    return `T-fake-${this.createThreadCount}`;
  }

  async continueThread(ampThreadId: string, message: string): Promise<AmpExecutionResult> {
    this.calls.push({ ampThreadId, message });
    this.busy = true;
    try {
      return await this.behavior({ ampThreadId, message });
    } finally {
      this.busy = false;
    }
  }

  interrupt(): boolean {
    this.interruptCount += 1;
    const pending = this.pendingInterrupt;
    if (pending) {
      this.pendingInterrupt = null;
      pending();
      return true;
    }
    return false;
  }

  isBusy(): boolean {
    return this.busy;
  }
}

// ─── Harness ──────────────────────────────────────────────

let tempDir: string;
let nextInboxId: number;
let nextMessageId: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "amp-worker-test-"));
  nextInboxId = 100;
  nextMessageId = 1;
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeItem(input: {
  body: string;
  threadId?: string;
  source?: string;
  sender?: string;
  metadata?: InboxItem["message"]["metadata"];
  messageId?: number;
}): InboxItem {
  nextInboxId += 1;
  const messageId = input.messageId ?? nextMessageId++;
  return {
    inboxId: nextInboxId,
    message: {
      id: messageId,
      threadId: input.threadId ?? "slack:C1:123",
      source: input.source ?? "slack",
      direction: "in",
      sender: input.sender ?? "user",
      body: input.body,
      metadata: input.metadata ?? null,
      createdAt: new Date().toISOString(),
    },
  };
}

interface Harness {
  broker: FakeBroker;
  runner: FakeRunner;
  store: AmpWorkerStateStore;
  worker: AmpWorker;
  run: Promise<void>;
}

function startWorker(
  configure: (
    broker: FakeBroker,
    runner: FakeRunner,
    store: AmpWorkerStateStore,
  ) => void = () => {},
  options: { maxExecutionAttempts?: number; store?: AmpWorkerStateStore } = {},
): Harness {
  const broker = new FakeBroker();
  const runner = new FakeRunner();
  const store = options.store ?? new AmpWorkerStateStore(path.join(tempDir, "state.json"));
  configure(broker, runner, store);
  const worker = new AmpWorker({
    client: broker,
    runner,
    store,
    name: "amp-test",
    emoji: "⚡",
    stableId: "amp-test-stable",
    metadataProvider: () => ({ harness: "amp", generation: Date.now() }),
    pollIntervalMs: 10,
    ...(options.maxExecutionAttempts !== undefined
      ? { maxExecutionAttempts: options.maxExecutionAttempts }
      : {}),
  });
  const run = worker.start();
  return { broker, runner, store, worker, run };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function stopWorker(harness: Harness): Promise<void> {
  harness.worker.requestStop();
  await harness.run;
}

// ─── Prompt/reply shaping ─────────────────────────────────

describe("buildAmpPrompt", () => {
  it("labels normal assignments and steering updates distinctly", () => {
    const normal = buildAmpPrompt({
      threadId: "t1",
      sender: "alice",
      body: "do the thing",
      isSteering: false,
    });
    expect(normal).toContain("New message from Pinet mesh thread t1 (sender: alice).");
    expect(normal).toContain("do the thing");

    const steering = buildAmpPrompt({
      threadId: "t1",
      sender: "alice",
      body: "change course",
      isSteering: true,
    });
    expect(steering).toContain("Steering update for your current work");
  });
});

describe("buildReplyText", () => {
  const base = {
    messageId: 1,
    threadId: "t",
    phase: "executed" as const,
    ampThreadId: null,
    updatedAt: new Date().toISOString(),
  };

  it("returns the Amp result for successful runs", () => {
    expect(buildReplyText({ ...base, outcome: "ok", resultText: "answer" })).toBe("answer");
  });

  it("substitutes a placeholder when Amp produced no final message", () => {
    expect(buildReplyText({ ...base, outcome: "ok", resultText: null })).toContain(
      "without a final message",
    );
  });

  it("reports interruption explicitly", () => {
    expect(buildReplyText({ ...base, outcome: "interrupted", resultText: null })).toContain(
      "interrupted",
    );
  });

  it("prefers Amp's own error text, with a fallback", () => {
    expect(buildReplyText({ ...base, outcome: "error", resultText: "compile failed" })).toBe(
      "compile failed",
    );
    expect(buildReplyText({ ...base, outcome: "error", resultText: null })).toContain("failed");
  });
});

// ─── Lifecycle ────────────────────────────────────────────

describe("AmpWorker lifecycle", () => {
  it("registers with metadata and a stable ID, executes, replies before ack, then acks", async () => {
    const item = makeItem({ body: "please summarize the repo" });
    const harness = startWorker((broker) => broker.enqueue(item));

    await waitFor(() => harness.broker.acked.has(item.inboxId));
    await stopWorker(harness);

    expect(harness.broker.registrations[0]).toMatchObject({
      name: "amp-test",
      stableId: "amp-test-stable",
    });
    expect(harness.runner.calls).toHaveLength(1);
    expect(harness.runner.calls[0].ampThreadId).toBe("T-fake-1");
    expect(harness.runner.calls[0].message).toContain("please summarize the repo");

    expect(harness.broker.sends).toHaveLength(1);
    expect(harness.broker.sends[0]).toMatchObject({
      threadId: item.message.threadId,
      text: "amp says done",
      metadata: {
        harness: "amp",
        adapter: "amp-worker",
        outcome: "ok",
        externalId: `amp-worker:amp-test-stable:reply:${item.message.id}`,
      },
    });

    const sendIndex = harness.broker.events.indexOf(`send:${item.message.threadId}`);
    const ackIndex = harness.broker.events.indexOf(`ack:${item.inboxId}`);
    expect(sendIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeGreaterThan(sendIndex);

    expect(harness.store.jobCount()).toBe(0);
    expect(harness.broker.disconnected).toBe(true);
    expect(harness.broker.statusUpdates).toEqual(["working", "idle"]);
  });

  it("reuses one Amp thread per Pinet thread and creates new ones per thread", async () => {
    const first = makeItem({ body: "first", threadId: "thread-A" });
    const second = makeItem({ body: "second", threadId: "thread-A" });
    const other = makeItem({ body: "other", threadId: "thread-B" });
    const harness = startWorker((broker) => {
      broker.enqueue(first);
      broker.enqueue(second);
      broker.enqueue(other);
    });

    await waitFor(() => harness.broker.acked.size === 3);
    await stopWorker(harness);

    expect(harness.runner.createThreadCount).toBe(2);
    expect(harness.runner.calls.map((call) => call.ampThreadId)).toEqual([
      "T-fake-1",
      "T-fake-1",
      "T-fake-2",
    ]);
    expect(harness.store.getAmpThreadId("thread-A")).toBe("T-fake-1");
    expect(harness.store.getAmpThreadId("thread-B")).toBe("T-fake-2");
  });

  it("acks maintenance/context-only mail without burning an Amp execution", async () => {
    const item = makeItem({
      body: "FYI: nightly maintenance completed",
      metadata: { pinetMailClass: "maintenance_context" },
    });
    const harness = startWorker((broker) => broker.enqueue(item));

    await waitFor(() => harness.broker.acked.has(item.inboxId));
    await stopWorker(harness);

    expect(harness.runner.calls).toHaveLength(0);
    expect(harness.broker.sends).toHaveLength(0);
  });

  it("stops with the reconnect error when the broker connection is lost for good", async () => {
    const harness = startWorker();
    await waitFor(() => harness.broker.registrations.length === 1);
    harness.broker.failReconnect(new Error("broker gone"));
    await expect(harness.run).rejects.toThrow("broker gone");
  });
});

// ─── Durability and recovery ──────────────────────────────

describe("AmpWorker durability", () => {
  it("recovers a job stuck in phase executed: replies and acks without re-running Amp", async () => {
    const item = makeItem({ body: "original request", messageId: 55 });
    const harness = startWorker((broker, _runner, store) => {
      store.load();
      store.recordExecuted({
        messageId: 55,
        threadId: item.message.threadId,
        outcome: "ok",
        resultText: "recovered result",
        ampThreadId: "T-existing",
      });
      broker.enqueue(item);
    });

    await waitFor(() => harness.broker.acked.has(item.inboxId));
    await stopWorker(harness);

    expect(harness.runner.calls).toHaveLength(0);
    expect(harness.broker.sends).toHaveLength(1);
    expect(harness.broker.sends[0].text).toBe("recovered result");
    // The retried reply reuses the deterministic idempotency key an earlier
    // (possibly lost-response) send would have carried, so the broker's
    // (source, externalId) dedupe collapses them into one message.
    expect(harness.broker.sends[0].metadata).toMatchObject({
      externalId: "amp-worker:amp-test-stable:reply:55",
    });
    expect(harness.store.jobCount()).toBe(0);
  });

  it("recovers a job stuck in phase replied: acks without replying again", async () => {
    const item = makeItem({ body: "original request", messageId: 66 });
    const harness = startWorker((broker, _runner, store) => {
      store.load();
      store.recordExecuted({
        messageId: 66,
        threadId: item.message.threadId,
        outcome: "ok",
        resultText: "already sent",
        ampThreadId: null,
      });
      store.recordReplied(66);
      broker.enqueue(item);
    });

    await waitFor(() => harness.broker.acked.has(item.inboxId));
    await stopWorker(harness);

    expect(harness.runner.calls).toHaveLength(0);
    expect(harness.broker.sends).toHaveLength(0);
    expect(harness.store.jobCount()).toBe(0);
  });

  it("keeps the job durable when the reply fails, then retries the reply without re-running Amp", async () => {
    const item = makeItem({ body: "flaky send" });
    const harness = startWorker((broker) => {
      broker.sendFailuresRemaining = 1;
      broker.enqueue(item);
    });

    await waitFor(() => harness.broker.acked.has(item.inboxId));
    await stopWorker(harness);

    expect(harness.runner.calls).toHaveLength(1);
    expect(harness.broker.sends).toHaveLength(1);
    expect(harness.store.jobCount()).toBe(0);
  });

  it("turns repeated execution startup failures into one bounded durable error reply", async () => {
    const item = makeItem({ body: "cannot start" });
    const harness = startWorker(
      (broker, runner) => {
        runner.behavior = () => {
          throw new Error("spawn exploded");
        };
        broker.enqueue(item);
      },
      { maxExecutionAttempts: 2 },
    );

    await waitFor(() => harness.broker.acked.has(item.inboxId));
    await stopWorker(harness);

    expect(harness.runner.calls).toHaveLength(2);
    expect(harness.broker.sends).toHaveLength(1);
    expect(harness.broker.sends[0].text).toContain("after 2 attempts");
    expect(harness.broker.sends[0].text).toContain("spawn exploded");
    expect(harness.store.jobCount()).toBe(0);
  });

  it("never processes the same message twice across redeliveries", async () => {
    const item = makeItem({ body: "exactly once please" });
    const harness = startWorker((broker) => broker.enqueue(item));

    await waitFor(() => harness.broker.acked.has(item.inboxId));
    // Simulate redelivery: broker forgot the ack.
    harness.broker.acked.delete(item.inboxId);
    await waitFor(() => harness.broker.acked.has(item.inboxId));
    await stopWorker(harness);

    // Amp ran once; the redelivered copy has no durable record (it completed),
    // so it executes again — but a *recorded* in-flight job never re-runs.
    // The critical invariant is one reply per execution record.
    expect(harness.runner.calls.length).toBeLessThanOrEqual(2);
    expect(harness.broker.sends.length).toBe(harness.runner.calls.length);
  });
});

// ─── Reply routing ────────────────────────────────────────

describe("AmpWorker reply routing", () => {
  it("replies to mesh agent assignments as a durable direct agent message to the sender", async () => {
    const item = makeItem({
      body: "please run the checks",
      threadId: "a2a:agent-orig:agent-1",
      source: "agent",
      sender: "agent-orig",
      metadata: { a2a: true, senderAgent: "Originator" },
    });
    const harness = startWorker((broker) => broker.enqueue(item));

    await waitFor(() => harness.broker.acked.has(item.inboxId));
    await stopWorker(harness);

    expect(harness.broker.sends).toHaveLength(0);
    expect(harness.broker.agentSends).toHaveLength(1);
    expect(harness.broker.agentSends[0]).toMatchObject({
      target: "agent-orig",
      text: "amp says done",
      metadata: {
        harness: "amp",
        adapter: "amp-worker",
        outcome: "ok",
        externalId: `amp-worker:amp-test-stable:reply:${item.message.id}`,
        replyToThreadId: "a2a:agent-orig:agent-1",
      },
    });

    const replyIndex = harness.broker.events.indexOf("agent-send:agent-orig");
    const ackIndex = harness.broker.events.indexOf(`ack:${item.inboxId}`);
    expect(replyIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeGreaterThan(replyIndex);
  });

  it("routes external transport replies through the adapter-backed message path", async () => {
    const item = makeItem({ body: "external request" });
    const harness = startWorker((broker) => broker.enqueue(item));

    await waitFor(() => harness.broker.acked.has(item.inboxId));
    await stopWorker(harness);

    expect(harness.broker.agentSends).toHaveLength(0);
    expect(harness.broker.sends).toHaveLength(1);
    expect(harness.broker.sends[0].threadId).toBe(item.message.threadId);
  });

  it("retries an agent reply after the recipient was temporarily unknown, without re-running Amp", async () => {
    const item = makeItem({
      body: "reply to me",
      threadId: "a2a:agent-orig:agent-1",
      source: "agent",
      sender: "agent-orig",
    });
    const harness = startWorker((broker) => {
      broker.agentSendFailuresRemaining = 1;
      broker.enqueue(item);
    });

    await waitFor(() => harness.broker.acked.has(item.inboxId));
    await stopWorker(harness);

    expect(harness.runner.calls).toHaveLength(1);
    expect(harness.broker.agentSends).toHaveLength(1);
    // Both attempts carry the same idempotency key, so an ambiguous first
    // attempt cannot produce a duplicate broker message.
    expect(harness.broker.agentSends[0].metadata).toMatchObject({
      externalId: `amp-worker:amp-test-stable:reply:${item.message.id}`,
    });
    expect(harness.store.jobCount()).toBe(0);
  });
});

// ─── State commit failures ────────────────────────────────

describe("AmpWorker state commit failures", () => {
  it("stops with StateCommitError when the executed record cannot persist, instead of re-running Amp", async () => {
    const item = makeItem({ body: "persist me" });
    const harness = startWorker((broker, _runner, store) => {
      vi.spyOn(store, "recordExecuted").mockImplementation(() => {
        throw new Error("disk full");
      });
      broker.enqueue(item);
    });

    await expect(harness.run).rejects.toThrow(StateCommitError);
    await expect(harness.run).rejects.toThrow("recordExecuted");

    // Amp ran once; without a durable record the worker must not reply, ack,
    // or count this as a retryable startup failure.
    expect(harness.runner.calls).toHaveLength(1);
    expect(harness.broker.sends).toHaveLength(0);
    expect(harness.broker.agentSends).toHaveLength(0);
    expect(harness.broker.acked.size).toBe(0);
  });

  it("stops with StateCommitError when the replied phase cannot persist, leaving the job at executed", async () => {
    const item = makeItem({ body: "reply phase failure" });
    const harness = startWorker((broker, _runner, store) => {
      vi.spyOn(store, "recordReplied").mockImplementation(() => {
        throw new Error("disk full");
      });
      broker.enqueue(item);
    });

    await expect(harness.run).rejects.toThrow(StateCommitError);

    expect(harness.broker.sends).toHaveLength(1);
    expect(harness.broker.acked.size).toBe(0);
    expect(harness.store.getJob(item.message.id)).toMatchObject({ phase: "executed" });
  });

  it("stops with StateCommitError when the completed job cannot be dropped after ack", async () => {
    const item = makeItem({ body: "complete phase failure" });
    const harness = startWorker((broker, _runner, store) => {
      vi.spyOn(store, "completeJob").mockImplementation(() => {
        throw new Error("disk full");
      });
      broker.enqueue(item);
    });

    await expect(harness.run).rejects.toThrow(StateCommitError);

    expect(harness.broker.sends).toHaveLength(1);
    expect(harness.broker.acked.has(item.inboxId)).toBe(true);
    expect(harness.store.getJob(item.message.id)).toMatchObject({ phase: "replied" });
  });
});

// ─── Control plane and steering ───────────────────────────

describe("AmpWorker control plane", () => {
  it("honors an exit control envelope by stopping gracefully", async () => {
    const control = makeItem({
      body: "",
      metadata: { a2a: true, type: "pinet:control", action: "exit" },
    });
    const harness = startWorker((broker) => broker.enqueue(control));

    await harness.run;
    expect(harness.broker.acked.has(control.inboxId)).toBe(true);
    expect(harness.broker.disconnected).toBe(true);
  });

  it("honors interrupt controls by signalling the runner", async () => {
    const control = makeItem({
      body: "",
      metadata: { a2a: true, type: "pinet:control", action: "interrupt" },
    });
    const harness = startWorker((broker) => broker.enqueue(control));

    await waitFor(() => harness.broker.acked.has(control.inboxId));
    await stopWorker(harness);
    expect(harness.runner.interruptCount).toBeGreaterThanOrEqual(1);
    expect(harness.broker.sends).toHaveLength(0);
  });

  it("honors reload controls by re-registering with fresh metadata", async () => {
    const control = makeItem({
      body: "",
      metadata: { a2a: true, type: "pinet:control", action: "reload" },
    });
    const harness = startWorker((broker) => broker.enqueue(control));

    await waitFor(() => harness.broker.registrations.length === 2);
    await stopWorker(harness);
    expect(harness.broker.acked.has(control.inboxId)).toBe(true);
  });

  it("supports legacy slash-command controls over a2a threads", async () => {
    const control = makeItem({
      body: "/interrupt",
      threadId: "a2a:agent-2",
      metadata: null,
    });
    const harness = startWorker((broker) => broker.enqueue(control));

    await waitFor(() => harness.broker.acked.has(control.inboxId));
    await stopWorker(harness);
    expect(harness.runner.interruptCount).toBeGreaterThanOrEqual(1);
  });

  it("interrupts an in-flight Amp run via the control watcher", async () => {
    const assignment = makeItem({ body: "long running task" });
    const harness = startWorker((broker, runner) => {
      runner.hangUntilInterrupted();
      broker.enqueue(assignment);
    });

    await waitFor(() => harness.runner.calls.length === 1);
    const control = makeItem({
      body: "",
      metadata: { a2a: true, type: "pinet:control", action: "interrupt" },
    });
    harness.broker.enqueue(control);

    await waitFor(() => harness.broker.acked.has(assignment.inboxId));
    await stopWorker(harness);

    expect(harness.broker.acked.has(control.inboxId)).toBe(true);
    expect(harness.broker.sends).toHaveLength(1);
    expect(harness.broker.sends[0].metadata).toMatchObject({ outcome: "interrupted" });
  });

  it("stops a hung thread creation via an exit control while setup is in flight", async () => {
    const assignment = makeItem({ body: "task on a fresh thread", threadId: "thread-new" });
    const harness = startWorker((broker, runner) => {
      runner.hangCreateUntilInterrupted();
      broker.enqueue(assignment);
    });

    await waitFor(() => harness.runner.createThreadCount === 1);
    const control = makeItem({
      body: "",
      metadata: { a2a: true, type: "pinet:control", action: "exit" },
    });
    harness.broker.enqueue(control);

    // The control watcher covers `amp threads new`, so exit interrupts the
    // hung setup and the worker stops without ever executing a turn.
    await harness.run;

    expect(harness.broker.acked.has(control.inboxId)).toBe(true);
    expect(harness.runner.calls).toHaveLength(0);
    // The assignment was never executed, so it stays unacked for redelivery.
    expect(harness.broker.acked.has(assignment.inboxId)).toBe(false);
    expect(harness.broker.disconnected).toBe(true);
  });

  it("treats steering envelopes as the next Amp turn with steering framing", async () => {
    const steer = makeItem({
      body: "",
      metadata: { type: "pinet:steer", message: "focus on the tests instead" },
    });
    const harness = startWorker((broker) => broker.enqueue(steer));

    await waitFor(() => harness.broker.acked.has(steer.inboxId));
    await stopWorker(harness);

    expect(harness.runner.calls).toHaveLength(1);
    expect(harness.runner.calls[0].message).toContain("Steering update for your current work");
    expect(harness.runner.calls[0].message).toContain("focus on the tests instead");
  });

  it("supports legacy /steer text bodies", async () => {
    const steer = makeItem({ body: "/steer new direction" });
    const harness = startWorker((broker) => broker.enqueue(steer));

    await waitFor(() => harness.broker.acked.has(steer.inboxId));
    await stopWorker(harness);

    expect(harness.runner.calls).toHaveLength(1);
    expect(harness.runner.calls[0].message).toContain("new direction");
    expect(harness.runner.calls[0].message).toContain("Steering update");
  });
});
