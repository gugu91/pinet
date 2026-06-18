import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildCompatCommentMessage,
  mapPinetReadResultToCompatComments,
  registerPinetA2ACompatTools,
} from "./pinet-a2a-compat.js";
import type { PinetReadResult } from "@pinet/pinet-core/pinet-read-formatting";

function makeReadResult(): PinetReadResult {
  return {
    messages: [
      {
        inboxId: 7,
        delivered: true,
        readAt: null,
        message: {
          id: 42,
          threadId: "a2a:worker:broker",
          source: "agent",
          direction: "inbound",
          sender: "worker",
          body: "A2A compatibility comment\nThread: review\nActor: agent:reviewer\n\nLooks good",
          metadata: {
            a2a: true,
            a2aCompat: true,
            legacyThreadId: "review",
            legacyActorType: "agent",
            legacyActorId: "reviewer",
            legacyContext: { file: "src/app.ts", startLine: 4, endLine: 2 },
          },
          createdAt: "2026-01-02T03:04:05.000Z",
        },
      },
    ],
    unreadCountBefore: 1,
    unreadCountAfter: 1,
    unreadThreads: [],
    markedReadIds: [],
  };
}

describe("Pinet A2A compatibility helpers", () => {
  it("builds a Pinet message that preserves legacy comment fields in metadata", () => {
    const result = buildCompatCommentMessage({
      comment: "Please check this",
      thread_id: "ctx:src/app.ts:10-12",
      actor_type: "human",
      actor_id: "will",
      file: "src/app.ts",
      start_line: 12,
      end_line: 10,
    });

    expect(result.body).toContain("A2A compatibility comment");
    expect(result.body).toContain("Thread: ctx:src/app.ts:10-12");
    expect(result.body).toContain("Context: src/app.ts:10-12");
    expect(result.body).toContain("Please check this");
    expect(result.metadata).toMatchObject({
      a2aCompat: true,
      legacyTool: "comment_add",
      legacyThreadId: "ctx:src/app.ts:10-12",
      legacyActorType: "human",
      legacyActorId: "will",
      legacyContext: { file: "src/app.ts", startLine: 10, endLine: 12 },
    });
  });

  it("derives legacy context thread ids when no explicit thread id is supplied", () => {
    const result = buildCompatCommentMessage({
      comment: "Inline note",
      file: "src/app.ts",
      start_line: 12,
      end_line: 10,
    });

    expect(result.threadId).toBe("ctx:src/app.ts:10-12");
    expect(result.metadata).toMatchObject({
      legacyThreadId: "ctx:src/app.ts:10-12",
      legacyContext: { file: "src/app.ts", startLine: 10, endLine: 12 },
    });
  });

  it("maps Pinet inbox rows back into comment-shaped records", () => {
    const readResult = makeReadResult();
    readResult.totalMatching = 4;
    const result = mapPinetReadResultToCompatComments(readResult, "review");

    expect(result).toMatchObject({
      threadId: "review",
      total: 4,
      comments: [
        {
          id: "pinet-42",
          threadId: "review",
          actorType: "agent",
          actorId: "reviewer",
          bodyPath: "pinet:42",
          body: "Looks good",
          context: { file: "src/app.ts", startLine: 2, endLine: 4 },
          pinetThreadId: "a2a:worker:broker",
          pinetMessageId: 42,
        },
      ],
    });
  });
});

describe("registerPinetA2ACompatTools", () => {
  it("sends legacy comment_add through the visible broker agent", async () => {
    const tools = new Map<
      string,
      { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
    >();
    const sendPinetAgentMessage = vi.fn(async () => ({ messageId: 123, target: "broker-1" }));
    const pi = {
      registerTool: vi.fn(
        (definition: {
          name: string;
          execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
        }) => {
          tools.set(definition.name, definition);
        },
      ),
    } as unknown as ExtensionAPI;

    registerPinetA2ACompatTools(pi, {
      pinetEnabled: () => true,
      brokerRole: () => "follower",
      requireToolPolicy: vi.fn(),
      sendPinetAgentMessage,
      readPinetInbox: vi.fn(async () => makeReadResult()),
      listBrokerAgents: () => [],
      listFollowerAgents: vi.fn(async () => [
        {
          emoji: "📔",
          name: "The Broker",
          id: "broker-1",
          status: "idle" as const,
          metadata: { role: "broker" },
          lastHeartbeat: "2026-01-02T03:04:05.000Z",
        },
      ]),
    });

    const result = await tools.get("comment_add")?.execute("tool-1", {
      comment: "Review posted",
      thread_id: "pr-819-review",
    });

    expect(sendPinetAgentMessage).toHaveBeenCalledWith(
      "broker-1",
      expect.stringContaining("Review posted"),
      expect.objectContaining({
        a2aCompat: true,
        legacyThreadId: "pr-819-review",
      }),
    );
    expect(result).toMatchObject({
      details: { id: "pinet-123", threadId: "pr-819-review", target: "broker-1" },
    });
  });

  it("does not silently send legacy comment_add to a disconnected broker", async () => {
    const tools = new Map<
      string,
      { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
    >();
    const sendPinetAgentMessage = vi.fn(async () => ({ messageId: 123, target: "broker-1" }));
    const pi = {
      registerTool: vi.fn(
        (definition: {
          name: string;
          execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
        }) => {
          tools.set(definition.name, definition);
        },
      ),
    } as unknown as ExtensionAPI;

    registerPinetA2ACompatTools(pi, {
      pinetEnabled: () => true,
      brokerRole: () => "follower",
      requireToolPolicy: vi.fn(),
      sendPinetAgentMessage,
      readPinetInbox: vi.fn(async () => makeReadResult()),
      listBrokerAgents: () => [],
      listFollowerAgents: vi.fn(async () => [
        {
          emoji: "📔",
          name: "The Broker",
          id: "broker-1",
          status: "idle" as const,
          metadata: { role: "broker" },
          lastHeartbeat: "2026-01-02T03:04:05.000Z",
          disconnectedAt: "2026-01-02T03:05:00.000Z",
        },
      ]),
    });

    await expect(
      tools.get("comment_add")?.execute("tool-1", {
        comment: "Review posted",
        thread_id: "pr-819-review",
      }),
    ).rejects.toThrow("No live Pinet broker/subtree broker agent");
    expect(sendPinetAgentMessage).not.toHaveBeenCalled();
  });

  it("defaults comment_list to the legacy global thread", async () => {
    const tools = new Map<
      string,
      { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
    >();
    const readPinetInbox = vi.fn(async () => makeReadResult());
    const pi = {
      registerTool: vi.fn(
        (definition: {
          name: string;
          execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
        }) => {
          tools.set(definition.name, definition);
        },
      ),
    } as unknown as ExtensionAPI;

    registerPinetA2ACompatTools(pi, {
      pinetEnabled: () => true,
      brokerRole: () => "follower",
      requireToolPolicy: vi.fn(),
      sendPinetAgentMessage: vi.fn(async () => ({ messageId: 123, target: "broker-1" })),
      readPinetInbox,
      listBrokerAgents: () => [],
      listFollowerAgents: vi.fn(async () => []),
    });

    await tools.get("comment_list")?.execute("tool-2", {});

    expect(readPinetInbox).toHaveBeenCalledWith({
      legacyThreadId: "global",
      unreadOnly: false,
      markRead: false,
    });
  });

  it("reads legacy thread ids through the broker-side metadata filter before limiting", async () => {
    const tools = new Map<
      string,
      { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
    >();
    const readPinetInbox = vi.fn(async () => makeReadResult());
    const pi = {
      registerTool: vi.fn(
        (definition: {
          name: string;
          execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
        }) => {
          tools.set(definition.name, definition);
        },
      ),
    } as unknown as ExtensionAPI;

    registerPinetA2ACompatTools(pi, {
      pinetEnabled: () => true,
      brokerRole: () => "follower",
      requireToolPolicy: vi.fn(),
      sendPinetAgentMessage: vi.fn(async () => ({ messageId: 123, target: "broker-1" })),
      readPinetInbox,
      listBrokerAgents: () => [],
      listFollowerAgents: vi.fn(async () => []),
    });

    await tools.get("comment_list")?.execute("tool-2", {
      thread_id: "review",
      limit: 5,
    });

    expect(readPinetInbox).toHaveBeenCalledWith({
      legacyThreadId: "review",
      limit: 5,
      unreadOnly: false,
      markRead: false,
    });
  });
});
