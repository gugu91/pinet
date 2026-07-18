import { describe, expect, it, vi } from "vitest";
import { sendBrokerMessage } from "./message-send.js";
import type { BrokerMessage, ThreadInfo } from "./types.js";

function createFakeDb() {
  const threads = new Map<string, ThreadInfo>();
  const messages: BrokerMessage[] = [];
  let nextMessageId = 1;

  return {
    threads,
    messages,
    getThread(threadId: string) {
      return threads.get(threadId) ?? null;
    },
    createThread(threadId: string, source: string, channel: string, ownerAgent: string | null) {
      const now = new Date().toISOString();
      const thread: ThreadInfo = {
        threadId,
        source,
        channel,
        ownerAgent,
        ownerBinding: null,
        createdAt: now,
        updatedAt: now,
      };
      threads.set(threadId, thread);
      return thread;
    },
    updateThread(threadId: string, updates: Partial<ThreadInfo>) {
      const existing = threads.get(threadId);
      if (!existing) {
        throw new Error(`Unknown thread ${threadId}`);
      }
      threads.set(threadId, { ...existing, ...updates });
    },
    claimThread(threadId: string, agentId: string, source = "slack", channel = "") {
      const existing = threads.get(threadId);
      if (existing) {
        if (existing.ownerAgent && existing.ownerAgent !== agentId) {
          return false;
        }
        threads.set(threadId, { ...existing, ownerAgent: agentId });
        return true;
      }
      const now = new Date().toISOString();
      threads.set(threadId, {
        threadId,
        source,
        channel,
        ownerAgent: agentId,
        ownerBinding: null,
        createdAt: now,
        updatedAt: now,
      });
      return true;
    },
    insertMessage(
      threadId: string,
      source: string,
      direction: "inbound" | "outbound",
      sender: string,
      body: string,
      _targetAgentIds: string[],
      metadata?: Record<string, unknown>,
    ): BrokerMessage {
      const externalId = typeof metadata?.externalId === "string" ? metadata.externalId : null;
      const message: BrokerMessage = {
        id: nextMessageId++,
        threadId,
        source,
        direction,
        sender,
        body,
        metadata: metadata ?? null,
        ...(externalId ? { externalId } : {}),
        createdAt: new Date().toISOString(),
      };
      messages.push(message);
      return message;
    },
    getMessageByExternalId(source: string, externalId: string): BrokerMessage | null {
      return (
        messages.find(
          (message) => message.source === source && message.externalId === externalId,
        ) ?? null
      );
    },
  };
}

describe("sendBrokerMessage", () => {
  it("creates a new thread and sends through the matching adapter", async () => {
    const db = createFakeDb();
    const send = vi.fn(async () => undefined);

    const result = await sendBrokerMessage(
      {
        db,
        adapters: [{ name: "imessage", send }],
      },
      {
        threadId: "imessage:chat:alice",
        body: "hello",
        senderAgentId: "agent-1",
        source: "imessage",
        channel: "chat:alice",
        agentName: "Sender",
        agentOwnerToken: "owner-token",
      },
    );

    expect(send).toHaveBeenCalledWith({
      threadId: "imessage:chat:alice",
      channel: "chat:alice",
      text: "hello",
      agentName: "Sender",
      agentOwnerToken: "owner-token",
    });
    expect(db.getThread("imessage:chat:alice")).toMatchObject({
      source: "imessage",
      channel: "chat:alice",
      ownerAgent: "agent-1",
    });
    expect(result.message.direction).toBe("outbound");
    expect(result.adapter).toBe("imessage");
  });

  it("passes normalized outbound content and fallback blocks through to the adapter", async () => {
    const db = createFakeDb();
    const send = vi.fn(async () => undefined);
    const legacyBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Legacy blocks*" },
      },
    ] satisfies ReadonlyArray<Record<string, unknown>>;
    const slackBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Transport-aware blocks*" },
      },
    ] satisfies ReadonlyArray<Record<string, unknown>>;

    const result = await sendBrokerMessage(
      {
        db,
        adapters: [{ name: "slack", send }],
      },
      {
        threadId: "100.200",
        body: "  raw fallback body  ",
        senderAgentId: "agent-1",
        source: "slack",
        channel: "C123",
        content: {
          text: " canonical fallback text ",
          markdown: " **canonical fallback text** ",
          slackBlocks,
        },
        blocks: legacyBlocks,
      },
    );

    expect(send).toHaveBeenCalledWith({
      threadId: "100.200",
      channel: "C123",
      text: "canonical fallback text",
      content: {
        text: "canonical fallback text",
        markdown: "**canonical fallback text**",
        slackBlocks,
      },
      blocks: legacyBlocks,
    });
    expect(result.message.body).toBe("canonical fallback text");
  });

  it("omits empty Slack-native content blocks so transports can use legacy fallback blocks", async () => {
    const db = createFakeDb();
    const send = vi.fn(async () => undefined);
    const legacyBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Legacy blocks*" },
      },
    ] satisfies ReadonlyArray<Record<string, unknown>>;

    await sendBrokerMessage(
      {
        db,
        adapters: [{ name: "slack", send }],
      },
      {
        threadId: "100.201",
        body: "fallback text",
        senderAgentId: "agent-1",
        source: "slack",
        channel: "C123",
        content: {
          text: "fallback text",
          slackBlocks: [],
        },
        blocks: legacyBlocks,
      },
    );

    expect(send).toHaveBeenCalledWith({
      threadId: "100.201",
      channel: "C123",
      text: "fallback text",
      content: {
        text: "fallback text",
      },
      blocks: legacyBlocks,
    });
  });

  it("reuses the stored thread transport when source and channel are omitted", async () => {
    const db = createFakeDb();
    db.createThread("imessage:chat:bob", "imessage", "chat:bob", "agent-1");
    const send = vi.fn(async () => undefined);

    await sendBrokerMessage(
      {
        db,
        adapters: [{ name: "imessage", send }],
      },
      {
        threadId: "imessage:chat:bob",
        body: "follow-up",
        senderAgentId: "agent-1",
      },
    );

    expect(send).toHaveBeenCalledWith({
      threadId: "imessage:chat:bob",
      channel: "chat:bob",
      text: "follow-up",
    });
  });

  it("claims an existing unowned transport thread for the sending agent", async () => {
    const db = createFakeDb();
    db.createThread("100.300", "slack", "C-OLD", null);
    const send = vi.fn(async () => undefined);

    const result = await sendBrokerMessage(
      {
        db,
        adapters: [{ name: "slack", send }],
      },
      {
        threadId: "100.300",
        body: "first agent response",
        senderAgentId: "agent-1",
        source: "slack",
        channel: "C-NEW",
      },
    );

    expect(db.getThread("100.300")).toMatchObject({
      source: "slack",
      channel: "C-NEW",
      ownerAgent: "agent-1",
    });
    expect(result.thread).toMatchObject({ ownerAgent: "agent-1", channel: "C-NEW" });
  });

  it("does not steal or send to an existing transport thread owned by another agent", async () => {
    const db = createFakeDb();
    db.createThread("100.301", "slack", "C123", "other-agent");
    const send = vi.fn(async () => undefined);

    await expect(
      sendBrokerMessage(
        {
          db,
          adapters: [{ name: "slack", send }],
        },
        {
          threadId: "100.301",
          body: "agent response",
          senderAgentId: "agent-1",
        },
      ),
    ).rejects.toThrow("Thread 100.301 is already owned by another agent.");

    expect(send).not.toHaveBeenCalled();
    expect(db.getThread("100.301")?.ownerAgent).toBe("other-agent");
  });

  it("sends only the winning first response for an existing unowned thread", async () => {
    const db = createFakeDb();
    db.createThread("100.302", "slack", "C123", null);
    const send = vi.fn(async () => undefined);
    const deps = { db, adapters: [{ name: "slack", send }] };

    const results = await Promise.allSettled([
      sendBrokerMessage(deps, {
        threadId: "100.302",
        body: "first response",
        senderAgentId: "agent-1",
      }),
      sendBrokerMessage(deps, {
        threadId: "100.302",
        body: "racing response",
        senderAgentId: "agent-2",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.getThread("100.302")?.ownerAgent).toBe("agent-1");
  });

  it("sends only the winning first response for a fresh thread", async () => {
    const db = createFakeDb();
    const send = vi.fn(async () => undefined);
    const deps = { db, adapters: [{ name: "slack", send }] };

    const results = await Promise.allSettled([
      sendBrokerMessage(deps, {
        threadId: "100.303",
        body: "first fresh response",
        senderAgentId: "agent-1",
        source: "slack",
        channel: "C123",
      }),
      sendBrokerMessage(deps, {
        threadId: "100.303",
        body: "racing fresh response",
        senderAgentId: "agent-2",
        source: "slack",
        channel: "C123",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.getThread("100.303")?.ownerAgent).toBe("agent-1");
  });

  it("does not re-deliver through the adapter when the same explicit externalId is retried", async () => {
    const db = createFakeDb();
    const send = vi.fn(async () => undefined);
    const deps = { db, adapters: [{ name: "slack", send }] };
    const input = {
      threadId: "slack:C9:100.500",
      body: "worker reply",
      senderAgentId: "agent-1",
      source: "slack",
      channel: "C9",
      metadata: { externalId: "amp-worker:w1:reply:42" },
    };

    const first = await sendBrokerMessage(deps, input);
    const retry = await sendBrokerMessage(deps, input);

    expect(send).toHaveBeenCalledTimes(1);
    expect(retry.message.id).toBe(first.message.id);
    expect(retry.adapter).toBe("slack");
    expect(db.messages).toHaveLength(1);
  });

  it("rejects an idempotency key reused for a different thread", async () => {
    const db = createFakeDb();
    const send = vi.fn(async () => undefined);
    const deps = { db, adapters: [{ name: "slack", send }] };

    await sendBrokerMessage(deps, {
      threadId: "slack:C9:100.500",
      body: "reply one",
      senderAgentId: "agent-1",
      source: "slack",
      channel: "C9",
      metadata: { externalId: "amp-worker:w1:reply:42" },
    });

    await expect(
      sendBrokerMessage(deps, {
        threadId: "slack:C9:100.501",
        body: "reply one",
        senderAgentId: "agent-1",
        source: "slack",
        channel: "C9",
        metadata: { externalId: "amp-worker:w1:reply:42" },
      }),
    ).rejects.toThrow(/idempotency key collision/i);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not let an idempotent retry bypass thread ownership", async () => {
    const db = createFakeDb();
    const send = vi.fn(async () => undefined);
    const deps = { db, adapters: [{ name: "slack", send }] };
    const input = {
      threadId: "slack:C9:100.500",
      body: "reply one",
      senderAgentId: "agent-1",
      source: "slack",
      channel: "C9",
      metadata: { externalId: "amp-worker:w1:reply:42" },
    };

    await sendBrokerMessage(deps, input);
    db.threads.set(input.threadId, { ...db.threads.get(input.threadId)!, ownerAgent: "agent-2" });

    await expect(sendBrokerMessage(deps, input)).rejects.toThrow(/owned by another agent/i);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("treats different explicit externalIds as distinct deliveries", async () => {
    const db = createFakeDb();
    const send = vi.fn(async () => undefined);
    const deps = { db, adapters: [{ name: "slack", send }] };

    const first = await sendBrokerMessage(deps, {
      threadId: "slack:C9:100.500",
      body: "reply one",
      senderAgentId: "agent-1",
      source: "slack",
      channel: "C9",
      metadata: { externalId: "amp-worker:w1:reply:1" },
    });
    const second = await sendBrokerMessage(deps, {
      threadId: "slack:C9:100.500",
      body: "reply two",
      senderAgentId: "agent-1",
      source: "slack",
      channel: "C9",
      metadata: { externalId: "amp-worker:w1:reply:2" },
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(second.message.id).not.toBe(first.message.id);
  });

  it("fails cleanly when no adapter is registered for the thread source", async () => {
    const db = createFakeDb();

    await expect(
      sendBrokerMessage(
        {
          db,
          adapters: [],
        },
        {
          threadId: "imessage:chat:carol",
          body: "hello",
          senderAgentId: "agent-1",
          source: "imessage",
          channel: "chat:carol",
        },
      ),
    ).rejects.toThrow('No adapter is registered for transport source "imessage".');
  });
});
