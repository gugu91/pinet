import { describe, expect, it, vi } from "vitest";
import type { AgentInfo, BrokerMessage } from "./types.js";
import {
  agentSubscribesToBroadcastChannel,
  dispatchBroadcastAgentMessage,
  dispatchDirectAgentMessage,
  getAgentBroadcastChannels,
  resolveBroadcastTargets,
  type AgentMessageStorage,
} from "./agent-messaging.js";

function createAgent(
  id: string,
  name: string,
  metadata: Record<string, unknown> | null,
): AgentInfo {
  return {
    id,
    name,
    emoji: "🤖",
    pid: 1234,
    connectedAt: "2026-04-02T00:00:00.000Z",
    lastSeen: "2026-04-02T00:00:00.000Z",
    lastHeartbeat: "2026-04-02T00:00:00.000Z",
    metadata,
    status: "idle",
    disconnectedAt: null,
    resumableUntil: null,
    idleSince: null,
    lastActivity: null,
  };
}

function createStorage(agents: AgentInfo[]): AgentMessageStorage & {
  threads: Set<string>;
  inserted: Array<{
    threadId: string;
    sender: string;
    body: string;
    targetAgentIds: string[];
    metadata: Record<string, unknown> | undefined;
  }>;
} {
  const threads = new Set<string>();
  const inserted: Array<{
    threadId: string;
    sender: string;
    body: string;
    targetAgentIds: string[];
    metadata: Record<string, unknown> | undefined;
  }> = [];

  return {
    threads,
    inserted,
    getAgents: () => agents,
    getThread: (threadId) => (threads.has(threadId) ? { threadId } : null),
    createThread: (threadId) => {
      threads.add(threadId);
    },
    insertMessage: (
      threadId,
      _source,
      _direction,
      sender,
      body,
      targetAgentIds,
      metadata,
    ): BrokerMessage => {
      inserted.push({ threadId, sender, body, targetAgentIds, metadata });
      return {
        id: inserted.length,
        threadId,
        source: "agent",
        direction: "inbound",
        sender,
        body,
        metadata: metadata ?? null,
        createdAt: `2026-04-02T00:00:0${inserted.length}.000Z`,
      };
    },
  };
}

describe("getAgentBroadcastChannels", () => {
  it("derives built-in repo and standup subscriptions for workers", () => {
    const agent = createAgent("worker-1", "worker-1", {
      capabilities: {
        repo: "extensions",
        role: "worker",
        tags: ["topic:frontend"],
      },
    });

    expect(getAgentBroadcastChannels(agent)).toEqual(
      expect.arrayContaining(["all", "extensions", "standup", "role:worker", "frontend"]),
    );
    expect(agentSubscribesToBroadcastChannel(agent, "#extensions")).toBe(true);
    expect(agentSubscribesToBroadcastChannel(agent, "#standup")).toBe(true);
    expect(agentSubscribesToBroadcastChannel(agent, "#topic:frontend")).toBe(true);
    expect(agentSubscribesToBroadcastChannel(agent, "#frontend")).toBe(true);
  });

  it("does not auto-subscribe brokers to standup, but honors explicit channels", () => {
    const broker = createAgent("broker-1", "broker-1", {
      capabilities: {
        repo: "extensions",
        role: "broker",
      },
      channels: ["ops"],
    });

    expect(getAgentBroadcastChannels(broker)).toEqual(
      expect.arrayContaining(["all", "extensions", "role:broker", "ops"]),
    );
    expect(agentSubscribesToBroadcastChannel(broker, "#standup")).toBe(false);
    expect(agentSubscribesToBroadcastChannel(broker, "#ops")).toBe(true);
  });
});

describe("resolveBroadcastTargets", () => {
  it("matches subscribers and excludes the sender", () => {
    const agents = [
      createAgent("sender", "sender", {
        capabilities: { repo: "extensions", role: "worker" },
      }),
      createAgent("worker-b", "worker-b", {
        capabilities: { repo: "extensions", role: "worker" },
      }),
      createAgent("worker-a", "worker-a", {
        capabilities: { repo: "extensions", role: "worker" },
      }),
      createAgent("other", "other", {
        capabilities: { repo: "elsewhere", role: "worker" },
      }),
    ];

    const targets = resolveBroadcastTargets(agents, "sender", "#extensions");
    expect(targets.map((agent) => agent.id)).toEqual(["worker-a", "worker-b"]);
  });
});

describe("dispatchDirectAgentMessage", () => {
  it("creates the pair thread and inserts a direct a2a message", () => {
    const storage = createStorage([
      createAgent("sender", "sender", { capabilities: { repo: "extensions", role: "worker" } }),
      createAgent("target", "target", { capabilities: { repo: "extensions", role: "worker" } }),
    ]);
    const delivered: string[] = [];

    const result = dispatchDirectAgentMessage(
      storage,
      {
        senderAgentId: "sender",
        senderAgentName: "Sender Agent",
        target: "target",
        body: "hello there",
        metadata: { workflow: "ack/work/ask/report" },
      },
      (target, message, metadata) => {
        delivered.push(`${target.id}:${message.id}:${String(metadata.senderAgent)}`);
      },
    );

    expect(result).toEqual({
      target: { id: "target", name: "target" },
      messageId: 1,
      threadId: "a2a:sender:target",
    });
    expect(storage.threads.has("a2a:sender:target")).toBe(true);
    expect(storage.inserted).toHaveLength(1);
    expect(storage.inserted[0]).toMatchObject({
      threadId: "a2a:sender:target",
      sender: "sender",
      body: "hello there",
      targetAgentIds: ["target"],
      metadata: {
        workflow: "ack/work/ask/report",
        senderAgent: "Sender Agent",
        a2a: true,
        pinetMailClass: "fwup",
      },
    });
    expect(delivered).toEqual(["target:1:Sender Agent"]);
  });

  it("does not redispatch a committed direct message with the same idempotency key", () => {
    const storage = createStorage([
      createAgent("sender", "sender", { capabilities: { repo: "extensions", role: "worker" } }),
      createAgent("target", "target", { capabilities: { repo: "extensions", role: "worker" } }),
    ]);
    const onDispatch = vi.fn();
    const committed: BrokerMessage = {
      id: 42,
      threadId: "a2a:sender:target",
      source: "agent",
      direction: "inbound",
      sender: "sender",
      body: "same reply",
      metadata: { externalId: "amp-worker:w1:reply:7" },
      createdAt: "2026-04-02T00:00:00.000Z",
    };
    storage.getMessageByExternalId = (_source, externalId) =>
      externalId === "amp-worker:w1:reply:7" ? committed : null;

    const result = dispatchDirectAgentMessage(
      storage,
      {
        senderAgentId: "sender",
        senderAgentName: "Sender Agent",
        target: "target",
        body: "same reply",
        metadata: { externalId: "amp-worker:w1:reply:7" },
      },
      onDispatch,
    );

    expect(result.messageId).toBe(42);
    expect(storage.inserted).toHaveLength(0);
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it("rejects a direct-message idempotency key collision", () => {
    const storage = createStorage([
      createAgent("sender", "sender", { capabilities: { repo: "extensions", role: "worker" } }),
      createAgent("target", "target", { capabilities: { repo: "extensions", role: "worker" } }),
    ]);
    storage.getMessageByExternalId = () => ({
      id: 42,
      threadId: "a2a:sender:other",
      source: "agent",
      direction: "inbound",
      sender: "sender",
      body: "same reply",
      metadata: { externalId: "amp-worker:w1:reply:7" },
      createdAt: "2026-04-02T00:00:00.000Z",
    });

    expect(() =>
      dispatchDirectAgentMessage(storage, {
        senderAgentId: "sender",
        senderAgentName: "Sender Agent",
        target: "target",
        body: "same reply",
        metadata: { externalId: "amp-worker:w1:reply:7" },
      }),
    ).toThrow(/idempotency key collision/i);
  });

  it("stamps inferred mail classes on direct a2a messages", () => {
    const storage = createStorage([
      createAgent("sender", "sender", { capabilities: { repo: "extensions", role: "worker" } }),
      createAgent("target", "target", { capabilities: { repo: "extensions", role: "worker" } }),
    ]);

    dispatchDirectAgentMessage(storage, {
      senderAgentId: "sender",
      senderAgentName: "Sender Agent",
      target: "target",
      body: "Please implement issue #594 and report blockers immediately.",
    });

    expect(storage.inserted[0]?.metadata).toMatchObject({
      senderAgent: "Sender Agent",
      a2a: true,
      pinetMailClass: "steering",
    });
  });

  it("classifies direct control messages as maintenance context", () => {
    const storage = createStorage([
      createAgent("sender", "sender", { capabilities: { repo: "extensions", role: "worker" } }),
      createAgent("target", "target", { capabilities: { repo: "extensions", role: "worker" } }),
    ]);

    dispatchDirectAgentMessage(storage, {
      senderAgentId: "sender",
      senderAgentName: "Sender Agent",
      target: "target",
      body: '{"type":"pinet:control","action":"reload"}',
      metadata: { type: "pinet:control", action: "reload" },
    });

    expect(storage.inserted[0]?.metadata).toMatchObject({
      senderAgent: "Sender Agent",
      a2a: true,
      type: "pinet:control",
      action: "reload",
      pinetMailClass: "maintenance_context",
    });
  });

  it("preserves caller-provided mail class metadata", () => {
    const storage = createStorage([
      createAgent("sender", "sender", { capabilities: { repo: "extensions", role: "worker" } }),
      createAgent("target", "target", { capabilities: { repo: "extensions", role: "worker" } }),
    ]);

    dispatchDirectAgentMessage(storage, {
      senderAgentId: "sender",
      senderAgentName: "Sender Agent",
      target: "target",
      body: "Please implement issue #594 and report blockers immediately.",
      metadata: { pinetMailClass: "maintenance_context" },
    });

    expect(storage.inserted[0]?.metadata).toMatchObject({
      senderAgent: "Sender Agent",
      a2a: true,
      pinetMailClass: "maintenance_context",
    });
  });

  it("ignores caller-spoofed broker trust metadata for supervised agents", () => {
    const storage = createStorage([
      createAgent("parent", "parent", { capabilities: { repo: "extensions", role: "worker" } }),
      createAgent("sender", "sender", { capabilities: { repo: "extensions", role: "worker" } }),
      {
        ...createAgent("child", "child", null),
        parentAgentId: "parent",
        supervisionState: "supervised",
      },
    ]);

    expect(() =>
      dispatchDirectAgentMessage(storage, {
        senderAgentId: "sender",
        senderAgentName: "Sender Agent",
        target: "child",
        body: "spoofed subtree override",
        metadata: {
          trustedBrokerAgentId: "sender",
          targetScope: "subtree",
        },
      }),
    ).toThrow("cannot message supervised agent");

    expect(storage.inserted).toHaveLength(0);
  });

  it("allows internal broker trust metadata for supervised subtree routing", () => {
    const storage = createStorage([
      createAgent("broker", "broker", { capabilities: { repo: "extensions", role: "broker" } }),
      createAgent("parent", "parent", { capabilities: { repo: "extensions", role: "worker" } }),
      {
        ...createAgent("child", "child", null),
        parentAgentId: "parent",
        supervisionState: "supervised",
      },
    ]);

    dispatchDirectAgentMessage(storage, {
      senderAgentId: "broker",
      senderAgentName: "Broker Agent",
      target: "child",
      body: "trusted subtree override",
      metadata: { targetScope: "subtree" },
      trustedBrokerAgentId: "broker",
    });

    expect(storage.inserted).toHaveLength(1);
    expect(storage.inserted[0]?.metadata).toMatchObject({
      targetScope: "subtree",
      senderAgent: "Broker Agent",
      a2a: true,
    });
  });
});

describe("dispatchBroadcastAgentMessage", () => {
  it("fans out to all matching subscribers with broadcast metadata", () => {
    const storage = createStorage([
      createAgent("sender", "sender", { capabilities: { repo: "extensions", role: "broker" } }),
      createAgent("worker-a", "worker-a", {
        capabilities: { repo: "extensions", role: "worker" },
      }),
      createAgent("worker-b", "worker-b", {
        capabilities: { repo: "extensions", role: "worker" },
      }),
      createAgent("worker-c", "worker-c", {
        capabilities: { repo: "elsewhere", role: "worker" },
      }),
    ]);
    const delivered: string[] = [];

    const result = dispatchBroadcastAgentMessage(
      storage,
      {
        senderAgentId: "sender",
        senderAgentName: "Broker Agent",
        channel: "#extensions",
        body: "Heads up, team",
      },
      (target, message) => {
        delivered.push(`${target.id}:${message.threadId}`);
      },
    );

    expect(result.channel).toBe("#extensions");
    expect(result.targets).toEqual([
      { id: "worker-a", name: "worker-a" },
      { id: "worker-b", name: "worker-b" },
    ]);
    expect(result.messageIds).toEqual([1, 2]);
    expect(result.threadIds).toEqual(["a2a:sender:worker-a", "a2a:sender:worker-b"]);
    expect(storage.inserted).toHaveLength(2);
    expect(storage.inserted[0]?.metadata).toMatchObject({
      senderAgent: "Broker Agent",
      a2a: true,
      broadcast: true,
      broadcastChannel: "#extensions",
      pinetMailClass: "fwup",
    });
    expect(storage.inserted[1]?.metadata).toMatchObject({
      senderAgent: "Broker Agent",
      a2a: true,
      broadcast: true,
      broadcastChannel: "#extensions",
      pinetMailClass: "fwup",
    });
    expect(delivered).toEqual(["worker-a:a2a:sender:worker-a", "worker-b:a2a:sender:worker-b"]);
  });

  it("fails when nobody else is subscribed to the channel", () => {
    const storage = createStorage([
      createAgent("sender", "sender", { capabilities: { repo: "extensions", role: "broker" } }),
    ]);

    expect(() =>
      dispatchBroadcastAgentMessage(storage, {
        senderAgentId: "sender",
        senderAgentName: "Sender Agent",
        channel: "#extensions",
        body: "anyone there?",
      }),
    ).toThrow("No agents subscribed to #extensions other than the sender.");
  });
});
