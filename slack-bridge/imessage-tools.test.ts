import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Broker } from "./broker/index.js";
import {
  registerIMessageTools,
  type IMessageToolSendInput,
  type RegisterIMessageToolsDeps,
} from "./imessage-tools.js";

type ToolResponse = {
  content?: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
};

type ToolDefinition = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResponse>;
};

function createBrokerStub() {
  const now = "2026-04-14T12:00:00.000Z";
  let thread: {
    threadId: string;
    source: string;
    channel: string;
    ownerAgent: string | null;
    createdAt: string;
    updatedAt: string;
  } | null = null;
  const adapterSend = vi.fn(async () => undefined);
  const db = {
    getThread: vi.fn((threadId: string) => (thread?.threadId === threadId ? thread : null)),
    createThread: vi.fn(
      (threadId: string, source: string, channel: string, ownerAgent: string | null) => {
        thread = {
          threadId,
          source,
          channel,
          ownerAgent,
          createdAt: now,
          updatedAt: now,
        };
        return thread;
      },
    ),
    updateThread: vi.fn(
      (threadId: string, updates: Partial<{ source: string; channel: string }>) => {
        if (thread?.threadId === threadId) {
          thread = { ...thread, ...updates };
        }
      },
    ),
    claimThread: vi.fn((threadId: string, ownerAgent: string, source = "slack", channel = "") => {
      if (thread && thread.threadId === threadId) {
        if (thread.ownerAgent && thread.ownerAgent !== ownerAgent) {
          return false;
        }
        thread = { ...thread, ownerAgent };
        return true;
      }
      thread = {
        threadId,
        source,
        channel,
        ownerAgent,
        createdAt: now,
        updatedAt: now,
      };
      return true;
    }),
    insertMessage: vi.fn(
      (
        threadId: string,
        source: string,
        direction: "inbound" | "outbound",
        sender: string,
        body: string,
        _targetAgentIds: string[],
        metadata?: Record<string, unknown>,
      ) => ({
        id: 41,
        threadId,
        source,
        direction,
        sender,
        body,
        metadata: metadata ?? null,
        createdAt: now,
      }),
    ),
  };

  const broker = {
    db,
    adapters: [{ name: "imessage", send: adapterSend }],
  } as unknown as Broker;

  return { broker, adapterSend };
}

function createDeps(overrides: Partial<RegisterIMessageToolsDeps> = {}): RegisterIMessageToolsDeps {
  const { broker } = createBrokerStub();

  return {
    pinetEnabled: () => true,
    brokerRole: () => "broker",
    requireToolPolicy: () => {},
    getActiveBroker: () => broker,
    getActiveBrokerSelfId: () => "broker-self",
    sendFollowerIMessage: async (_input: IMessageToolSendInput) => ({
      adapter: "imessage",
      messageId: 77,
    }),
    getAgentIdentity: () => ({
      name: "Cobalt Olive Crane",
      emoji: "🦩",
      ownerToken: "owner-token",
    }),
    trackOwnedThread: () => {},
    ...overrides,
  };
}

function registerWithDeps(deps: RegisterIMessageToolsDeps): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: vi.fn((definition: ToolDefinition) => {
      tools.set(definition.name, definition);
    }),
  } as unknown as ExtensionAPI;

  registerIMessageTools(pi, deps);
  return tools;
}

describe("registerIMessageTools", () => {
  it("registers imessage_send", () => {
    const tools = registerWithDeps(createDeps());

    expect([...tools.keys()]).toEqual(["imessage_send"]);
  });

  it("sends through the active broker adapter and tracks the owned thread", async () => {
    const { broker, adapterSend } = createBrokerStub();
    const trackOwnedThread = vi.fn();
    const deps = createDeps({
      getActiveBroker: () => broker,
      trackOwnedThread,
    });
    const tools = registerWithDeps(deps);

    const result = await tools.get("imessage_send")?.execute("tool-call-1", {
      to: "chat:alice",
      text: "hello from pi",
    });

    expect(adapterSend).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "imessage:chat:alice",
        channel: "chat:alice",
        text: "hello from pi",
        content: { text: "hello from pi" },
      }),
    );
    expect(trackOwnedThread).toHaveBeenCalledWith("imessage:chat:alice", "chat:alice", "imessage");
    expect(result).toMatchObject({
      details: {
        threadId: "imessage:chat:alice",
        channel: "chat:alice",
        source: "imessage",
        adapter: "imessage",
        messageId: 41,
      },
    });
  });

  it("routes follower sends through the follower callback", async () => {
    const sendFollowerIMessage = vi.fn(async (_input: IMessageToolSendInput) => ({
      adapter: "imessage",
      messageId: 52,
    }));
    const trackOwnedThread = vi.fn();
    const deps = createDeps({
      brokerRole: () => "follower",
      sendFollowerIMessage,
      trackOwnedThread,
    });
    const tools = registerWithDeps(deps);

    const result = await tools.get("imessage_send")?.execute("tool-call-2", {
      to: "+15555550123",
      text: "follower hello",
      thread_id: "custom-thread",
    });

    expect(sendFollowerIMessage).toHaveBeenCalledWith({
      threadId: "custom-thread",
      body: "follower hello",
      source: "imessage",
      channel: "+15555550123",
      content: { text: "follower hello" },
      agentName: "Cobalt Olive Crane",
      agentEmoji: "🦩",
      agentOwnerToken: "owner-token",
      metadata: { recipient: "+15555550123" },
    });
    expect(trackOwnedThread).toHaveBeenCalledWith("custom-thread", "+15555550123", "imessage");
    expect(result).toMatchObject({
      details: {
        threadId: "custom-thread",
        channel: "+15555550123",
        source: "imessage",
        adapter: "imessage",
        messageId: 52,
      },
    });
  });

  it("rejects empty text bodies", async () => {
    const tools = registerWithDeps(createDeps());

    await expect(
      tools.get("imessage_send")?.execute("tool-call-3", {
        to: "chat:alice",
        text: "   ",
      }),
    ).rejects.toThrow("text is required");
  });
});
