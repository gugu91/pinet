import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  registerPinetTools,
  type PinetToolsAgentRecord,
  type RegisterPinetToolsDeps,
} from "./pinet-tools.js";

type ToolDefinition = {
  name: string;
  promptSnippet?: string;
  parameters?: unknown;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

function makeAgent(overrides: Partial<PinetToolsAgentRecord> = {}): PinetToolsAgentRecord {
  return {
    emoji: "🐇",
    name: "Golden Chalk Rabbit",
    id: "agent-1",
    pid: 101,
    status: "idle",
    metadata: { repo: "extensions", tools: ["read", "edit"] },
    lastHeartbeat: new Date(Date.now() - 1_000).toISOString(),
    lastSeen: new Date(Date.now() - 500).toISOString(),
    disconnectedAt: null,
    resumableUntil: null,
    ...overrides,
  };
}

function createDeps(overrides: Partial<RegisterPinetToolsDeps> = {}): RegisterPinetToolsDeps {
  const defaults: RegisterPinetToolsDeps = {
    pinetEnabled: () => true,
    brokerRole: () => "broker",
    requireToolPolicy: () => {},
    sendPinetAgentMessage: async (target, _body, _metadata) => ({ messageId: 17, target }),
    sendPinetBroadcastMessage: (channel) => ({
      channel,
      messageIds: [11, 12],
      recipients: ["Worker One", "Worker Two"],
    }),
    signalAgentFree: async (_ctx: ExtensionContext | undefined, _options) => ({
      queuedInboxCount: 0,
      drainedQueuedInbox: false,
    }),
    scheduleBrokerWakeup: async (fireAt: string, _message: string) => ({ id: 7, fireAt }),
    scheduleFollowerWakeup: async (fireAt: string, _message: string) => ({ id: 9, fireAt }),
    readPinetInbox: async () => ({
      messages: [],
      unreadCountBefore: 0,
      unreadCountAfter: 0,
      unreadThreads: [],
      markedReadIds: [],
    }),
    listBrokerAgents: () => [makeAgent()],
    listFollowerAgents: async (_includeGhosts: boolean) => [makeAgent({ id: "agent-2" })],
    listPinetLanes: async () => [],
    upsertPinetLane: async (input) => ({
      laneId: input.laneId,
      name: input.name ?? null,
      task: input.task ?? null,
      issueNumber: input.issueNumber ?? null,
      prNumber: input.prNumber ?? null,
      threadId: input.threadId ?? null,
      ownerAgentId: input.ownerAgentId ?? null,
      implementationLeadAgentId: input.implementationLeadAgentId ?? null,
      pmMode: input.pmMode ?? false,
      state: input.state ?? "active",
      summary: input.summary ?? null,
      metadata: input.metadata ?? null,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
      lastActivityAt: "2026-05-01T00:00:00.000Z",
      participants: [],
    }),
    setPinetLaneParticipant: async (input) => ({
      laneId: input.laneId,
      agentId: input.agentId,
      role: input.role,
      status: input.status ?? null,
      summary: input.summary ?? null,
      metadata: input.metadata ?? null,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
      lastActivityAt: "2026-05-01T00:00:00.000Z",
    }),
    acquirePortLease: async (input) => ({
      id: "lease-1",
      purpose: input.purpose,
      port: input.port ?? input.minPort ?? 49152,
      host: input.host ?? "127.0.0.1",
      ownerAgentId: input.ownerAgentId ?? "agent-1",
      pid: input.pid ?? null,
      status: "active",
      metadata: input.metadata ?? null,
      acquiredAt: "2026-05-01T00:00:00.000Z",
      renewedAt: "2026-05-01T00:00:00.000Z",
      expiresAt: "2026-05-01T00:10:00.000Z",
      releasedAt: null,
    }),
    renewPortLease: async (input) => ({
      id: input.leaseId,
      purpose: "preview",
      port: 49152,
      host: "127.0.0.1",
      ownerAgentId: input.ownerAgentId ?? "agent-1",
      pid: null,
      status: "active",
      metadata: null,
      acquiredAt: "2026-05-01T00:00:00.000Z",
      renewedAt: "2026-05-01T00:05:00.000Z",
      expiresAt: "2026-05-01T00:15:00.000Z",
      releasedAt: null,
    }),
    releasePortLease: async (input) => ({
      id: input.leaseId,
      purpose: "preview",
      port: 49152,
      host: "127.0.0.1",
      ownerAgentId: input.ownerAgentId ?? "agent-1",
      pid: null,
      status: "released",
      metadata: null,
      acquiredAt: "2026-05-01T00:00:00.000Z",
      renewedAt: "2026-05-01T00:00:00.000Z",
      expiresAt: "2026-05-01T00:10:00.000Z",
      releasedAt: "2026-05-01T00:03:00.000Z",
    }),
    getPortLease: async (leaseId) => ({
      id: leaseId,
      purpose: "preview",
      port: 49152,
      host: "127.0.0.1",
      ownerAgentId: "agent-1",
      pid: null,
      status: "active",
      metadata: null,
      acquiredAt: "2026-05-01T00:00:00.000Z",
      renewedAt: "2026-05-01T00:00:00.000Z",
      expiresAt: "2026-05-01T00:10:00.000Z",
      releasedAt: null,
    }),
    listPortLeases: async () => [],
    expirePortLeases: async () => [],
    ralphSnoozeStatus: () => ({
      active: false,
      until: null,
      remainingMs: 0,
      reason: null,
      source: null,
      emptyCycleCount: 0,
    }),
    snoozeRalphLoop: ({ durationMs, reason }) => ({
      active: true,
      until: "2026-05-01T00:30:00.000Z",
      remainingMs: durationMs,
      reason: reason ?? null,
      source: "manual",
      emptyCycleCount: 0,
    }),
    clearRalphSnooze: () => ({
      active: false,
      until: null,
      remainingMs: 0,
      reason: null,
      source: null,
      emptyCycleCount: 0,
    }),
  };

  return { ...defaults, ...overrides };
}

function registerWithDeps(deps: RegisterPinetToolsDeps): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: vi.fn((definition: ToolDefinition) => {
      tools.set(definition.name, definition);
    }),
  } as unknown as ExtensionAPI;

  registerPinetTools(pi, deps);
  return tools;
}

describe("registerPinetTools", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("registers the default Pinet surface", () => {
    const tools = registerWithDeps(createDeps());

    expect([...tools.keys()]).toEqual(["pinet"]);
  });

  it("standardizes send/delegation on the dispatcher", () => {
    const tools = registerWithDeps(createDeps());
    const pinet = tools.get("pinet");

    expect(pinet?.promptSnippet).toContain("Use this compact dispatcher for Pinet actions");
    expect(pinet?.promptSnippet).toContain("lanes, ports, reload");
    expect(pinet?.promptSnippet).not.toContain("skin");
    expect(pinet?.promptSnippet).toContain('args.format="json"');
    expect(pinet?.promptSnippet).toContain("fill context quickly");
    expect(JSON.stringify(pinet?.parameters)).toContain(
      "help, send, read, free, snooze, schedule, agents, lanes, ports, reload, or exit",
    );
  });

  it("routes reload and exit through the dispatcher remote-control actions", async () => {
    const sendPinetAgentMessage = vi.fn(async (target: string, body: string) => ({
      messageId: body === "/reload" ? 31 : 32,
      target,
    }));
    const deps = createDeps({ sendPinetAgentMessage });
    const tools = registerWithDeps(deps);

    const reload = (await tools.get("pinet")?.execute("tool-call-1", {
      action: "reload",
      args: { target: "Golden Chalk Rabbit" },
    })) as { details: { data: { details: { command: string; target: string } } } };
    const exit = (await tools.get("pinet")?.execute("tool-call-2", {
      action: "exit",
      args: { target: "Golden Chalk Rabbit" },
    })) as { details: { data: { details: { command: string; target: string } } } };

    expect(sendPinetAgentMessage).toHaveBeenCalledWith("Golden Chalk Rabbit", "/reload");
    expect(sendPinetAgentMessage).toHaveBeenCalledWith("Golden Chalk Rabbit", "/exit");
    expect(reload.details.data.details).toMatchObject({
      command: "/reload",
      target: "Golden Chalk Rabbit",
    });
    expect(exit.details.data.details).toMatchObject({
      command: "/exit",
      target: "Golden Chalk Rabbit",
    });
  });

  it("sets and clears broker RALPH snooze through the dispatcher", async () => {
    const snoozeRalphLoop = vi.fn(({ durationMs, reason }) => ({
      active: true,
      until: "2026-05-01T00:30:00.000Z",
      remainingMs: durationMs,
      reason,
      source: "manual" as const,
      emptyCycleCount: 0,
    }));
    const clearRalphSnooze = vi.fn(() => ({
      active: false,
      until: null,
      remainingMs: 0,
      reason: null,
      source: null,
      emptyCycleCount: 0,
    }));
    const tools = registerWithDeps(createDeps({ snoozeRalphLoop, clearRalphSnooze }));

    const setResult = (await tools.get("pinet")?.execute("tool-call-1", {
      action: "snooze",
      args: { op: "set", duration: "30m", reason: "empty cycles" },
    })) as { details: { data: { details: { active: boolean; reason: string } } } };
    const clearResult = (await tools.get("pinet")?.execute("tool-call-2", {
      action: "snooze",
      args: { op: "clear" },
    })) as { details: { data: { details: { active: boolean } } } };

    expect(snoozeRalphLoop).toHaveBeenCalledWith({
      durationMs: 30 * 60_000,
      reason: "empty cycles",
    });
    expect(setResult.details.data.details).toMatchObject({ active: true, reason: "empty cycles" });
    expect(clearRalphSnooze).toHaveBeenCalled();
    expect(clearResult.details.data.details).toMatchObject({ active: false });
  });

  it("rejects the removed dispatcher skin action with compact CLI text by default", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-1", {
      action: "skin",
      args: { theme: "foundation" },
    })) as {
      content: Array<{ text: string }>;
      details: { status: string; errors: Array<{ message: string }> };
    };

    expect(result.content[0]?.text).toContain("Pinet failed: Unknown Pinet action: skin");
    expect(result.content[0]?.text).not.toContain('"errors"');
    expect(result.details.status).toBe("failed");
    expect(result.details.errors[0]?.message).toBe("Unknown Pinet action: skin");
  });

  it("uses the broker broadcast path for broadcast dispatcher send targets", async () => {
    const sendPinetBroadcastMessage = vi.fn((channel: string, _body: string) => ({
      channel,
      messageIds: [21, 22],
      recipients: ["Worker One", "Worker Two"],
    }));
    const deps = createDeps({ sendPinetBroadcastMessage });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-1", {
      action: "send",
      args: {
        to: "#extensions",
        message: "hello mesh",
      },
    })) as {
      details: {
        data: {
          text: string;
          details: { channel: string; messageIds: number[]; recipients: string[] };
        };
      };
    };

    expect(sendPinetBroadcastMessage).toHaveBeenCalledWith("#extensions", "hello mesh");
    expect(result.details.data.text).toBe("Pinet broadcast sent to #extensions (2 recipients).");
    expect(result.details.data.details).toEqual({
      channel: "#extensions",
      messageIds: [21, 22],
      recipients: ["Worker One", "Worker Two"],
    });
  });

  it("reads durable Pinet inbox context and marks returned rows read by default", async () => {
    const readPinetInbox = vi.fn(async () => ({
      messages: [
        {
          inboxId: 31,
          delivered: true,
          readAt: "2026-04-25T12:00:00.000Z",
          message: {
            id: 44,
            threadId: "a2a:broker:worker",
            source: "agent",
            direction: "inbound",
            sender: "broker",
            body: "please inspect #594",
            metadata: { a2a: true },
            createdAt: "2026-04-25T11:59:00.000Z",
          },
        },
      ],
      unreadCountBefore: 2,
      unreadCountAfter: 1,
      unreadThreads: [
        {
          threadId: "a2a:broker:worker",
          source: "agent",
          channel: "",
          unreadCount: 1,
          latestMessageId: 45,
          latestAt: "2026-04-25T12:01:00.000Z",
          highestMailClass: "steering" as const,
          mailClassCounts: { steering: 1, fwup: 0, maintenance_context: 0 },
        },
      ],
      markedReadIds: [31],
    }));
    const deps = createDeps({ readPinetInbox });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-read", {
      action: "read",
      args: {
        thread_id: "a2a:broker:worker",
        limit: 5,
      },
    })) as {
      details: {
        status: "succeeded";
        data: { text: string; details: { markedReadIds: number[]; messageCount: number } };
      };
    };

    expect(readPinetInbox).toHaveBeenCalledWith({ threadId: "a2a:broker:worker", limit: 5 });
    expect(result.details.data.text).toBe(
      "Pinet read: 1 unread message; unread 2→1; marked 1; 1 unread thread.",
    );
    expect(result.details.data.text).not.toContain("please inspect #594");
    expect(result.details.data.text).not.toContain("pointer=pinet action=read");
    expect(result.details.data.details.markedReadIds).toEqual([31]);
    expect(result.details.data.details.messageCount).toBe(1);
  });

  it("keeps pinet read default cli details compact without exposing full bodies", async () => {
    const longBody = `please inspect ${"important context ".repeat(20)}and keep exact body`;
    const readPinetInbox = vi.fn(async () => ({
      messages: [
        {
          inboxId: 31,
          delivered: true,
          readAt: "2026-04-25T12:00:00.000Z",
          message: {
            id: 44,
            threadId: "a2a:broker:worker",
            source: "agent" as const,
            direction: "inbound" as const,
            sender: "broker",
            body: longBody,
            metadata: { a2a: true, priority: "high" },
            createdAt: "2026-04-25T11:59:00.000Z",
          },
        },
      ],
      unreadCountBefore: 1,
      unreadCountAfter: 0,
      unreadThreads: [],
      markedReadIds: [31],
    }));
    const deps = createDeps({ readPinetInbox });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-read-compact-details", {
      action: "read",
      args: { thread_id: "a2a:broker:worker" },
    })) as {
      content: Array<{ text: string }>;
      details: {
        data: {
          text: string;
          details: { messages: Array<{ preview: string; message?: { body?: string } }> };
          compact_details?: unknown;
          full_details?: unknown;
        };
      };
    };

    expect(result.content[0]?.text).toBe("Pinet read: 1 unread message; unread 1→0; marked 1.");
    expect(result.content[0]?.text).not.toContain(longBody);
    expect(result.details.data.text).not.toContain(longBody);
    expect(result.details.data.details.messages[0]?.preview).toContain("…");
    expect(result.details.data.details.messages[0]?.preview).not.toContain("keep exact body");
    expect(result.details.data.details.messages[0]?.message?.body).toBeUndefined();
    expect(result.details.data.compact_details).toBeUndefined();
    expect(result.details.data.full_details).toBeUndefined();
  });

  it("keeps pinet read format=json structured details backward-compatible", async () => {
    const body = "exact json body";
    const readPinetInbox = vi.fn(async () => ({
      messages: [
        {
          inboxId: 31,
          delivered: true,
          readAt: "2026-04-25T12:00:00.000Z",
          message: {
            id: 44,
            threadId: "a2a:broker:worker",
            source: "agent" as const,
            direction: "inbound" as const,
            sender: "broker",
            body,
            metadata: { a2a: true },
            createdAt: "2026-04-25T11:59:00.000Z",
          },
        },
      ],
      unreadCountBefore: 1,
      unreadCountAfter: 0,
      unreadThreads: [],
      markedReadIds: [31],
    }));
    const deps = createDeps({ readPinetInbox });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-read-json-details", {
      action: "read",
      args: { thread_id: "a2a:broker:worker", f: "json" },
    })) as { content: Array<{ text: string }> };
    const envelope = JSON.parse(result.content[0]?.text ?? "{}") as {
      data: { details: { messages: Array<{ message: { body: string } }> } };
    };

    expect(envelope.data.details.messages[0]?.message.body).toBe(body);
  });

  it("shows exact Pinet read bodies only with explicit full output", async () => {
    const body = "exact full body";
    const readPinetInbox = vi.fn(async () => ({
      messages: [
        {
          inboxId: 31,
          delivered: true,
          readAt: "2026-04-25T12:00:00.000Z",
          message: {
            id: 44,
            threadId: "a2a:broker:worker",
            source: "agent" as const,
            direction: "inbound" as const,
            sender: "broker",
            body,
            metadata: { a2a: true },
            createdAt: "2026-04-25T11:59:00.000Z",
          },
        },
      ],
      unreadCountBefore: 1,
      unreadCountAfter: 0,
      unreadThreads: [],
      markedReadIds: [31],
    }));
    const deps = createDeps({ readPinetInbox });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-read-full-details", {
      action: "read",
      args: { thread_id: "a2a:broker:worker", full: true },
    })) as {
      content: Array<{ text: string }>;
      details: {
        data: {
          details: { messages: Array<{ message: { body: string } }> };
          full_details?: unknown;
        };
      };
    };

    expect(result.content[0]?.text).toContain(body);
    expect(result.details.data.details.messages[0]?.message.body).toBe(body);
    expect(result.details.data.full_details).toBeUndefined();
  });

  it("keeps format=json plus full from duplicating read bodies into full_details", async () => {
    const body = "exact json full body";
    const readPinetInbox = vi.fn(async () => ({
      messages: [
        {
          inboxId: 31,
          delivered: true,
          readAt: "2026-04-25T12:00:00.000Z",
          message: {
            id: 44,
            threadId: "a2a:broker:worker",
            source: "agent" as const,
            direction: "inbound" as const,
            sender: "broker",
            body,
            metadata: { a2a: true },
            createdAt: "2026-04-25T11:59:00.000Z",
          },
        },
      ],
      unreadCountBefore: 1,
      unreadCountAfter: 0,
      unreadThreads: [],
      markedReadIds: [31],
    }));
    const deps = createDeps({ readPinetInbox });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-read-json-full-details", {
      action: "read",
      args: { thread_id: "a2a:broker:worker", format: "json", full: true },
    })) as { content: Array<{ text: string }> };
    const envelope = JSON.parse(result.content[0]?.text ?? "{}") as {
      data: {
        details: { messages: Array<{ message: { body: string } }> };
        full_details?: unknown;
      };
    };

    expect(envelope.data.details.messages[0]?.message.body).toBe(body);
    expect(envelope.data.full_details).toBeUndefined();
  });

  it("routes action-dispatched help through the dispatcher with compact CLI text by default", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-dispatch-help", {
      action: "help",
    })) as {
      content: Array<{ text: string }>;
      details: {
        status: "succeeded";
        data: {
          actions: Array<{ action: string; guardrail_tool: string; description: string }>;
          note: string;
        };
      };
    };

    expect(result.content[0]?.text).toContain("Pinet actions:");
    expect(result.content[0]?.text).toContain("send");
    expect(result.content[0]?.text).not.toContain('"args_schema"');
    expect(result.details.status).toBe("succeeded");
    expect(result.details.data.note).toContain("Use args.topic");
    expect(result.details.data.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "send", guardrail_tool: "pinet:send" }),
        expect.objectContaining({ action: "read", guardrail_tool: "pinet:read" }),
        expect.objectContaining({ action: "free", guardrail_tool: "pinet:free" }),
        expect.objectContaining({ action: "schedule", guardrail_tool: "pinet:schedule" }),
        expect.objectContaining({ action: "agents", guardrail_tool: "pinet:agents" }),
        expect.objectContaining({ action: "lanes", guardrail_tool: "pinet:lanes" }),
        expect.objectContaining({ action: "ports", guardrail_tool: "pinet:ports" }),
      ]),
    );
  });

  it("preserves explicit JSON output for action-dispatched help", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-dispatch-help-json", {
      action: "help",
      args: { format: "json" },
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]?.text).toContain('"status": "succeeded"');
    expect(result.content[0]?.text).toContain('"args_schema"');
  });

  it("preserves explicit full output for action-dispatched help", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-dispatch-help-full", {
      action: "help",
      args: { full: true },
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]?.text).toContain('"status": "succeeded"');
    expect(result.content[0]?.text).toContain('"args_schema"');
  });

  it("preserves valid structured help output flags when a sibling output flag is invalid", async () => {
    const tools = registerWithDeps(createDeps());

    const jsonResult = (await tools.get("pinet")?.execute("tool-call-help-json-invalid-full", {
      action: "help",
      args: { format: "json", full: "true" },
    })) as { content: Array<{ text: string }> };
    const fullResult = (await tools.get("pinet")?.execute("tool-call-help-full-invalid-format", {
      action: "help",
      args: { format: "yaml", full: true },
    })) as { content: Array<{ text: string }> };

    expect(jsonResult.content[0]?.text).toContain('"status": "failed"');
    expect(jsonResult.content[0]?.text).toContain('"full must be a boolean when provided."');
    expect(fullResult.content[0]?.text).toContain('"status": "failed"');
    expect(fullResult.content[0]?.text).toContain('"format must be');
  });

  it("warns compact help topic callers that JSON/full output can fill context quickly", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-dispatch-help-topic", {
      action: "help",
      args: { topic: "read" },
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]?.text).toContain("JSON/full output can fill context quickly");
  });

  it("routes action-dispatched port lease acquire", async () => {
    const acquirePortLease = vi.fn(createDeps().acquirePortLease);
    const tools = registerWithDeps(createDeps({ acquirePortLease }));

    const result = (await tools.get("pinet")?.execute("tool-call-ports-acquire", {
      action: "ports",
      args: {
        op: "acquire",
        purpose: "preview",
        ttl_ms: 600_000,
        min_port: 52000,
        max_port: 52010,
        format: "json",
      },
    })) as {
      details: { status: string; data: { details: { lease: { port: number } } } };
    };

    expect(acquirePortLease).toHaveBeenCalledWith({
      purpose: "preview",
      ttlMs: 600_000,
      minPort: 52000,
      maxPort: 52010,
    });
    expect(result.details.status).toBe("succeeded");
    expect(result.details.data.details.lease.port).toBe(52000);
  });

  it("routes action-dispatched port lease list", async () => {
    const listPortLeases = vi.fn(createDeps().listPortLeases);
    const tools = registerWithDeps(createDeps({ listPortLeases }));

    const result = (await tools.get("pinet")?.execute("tool-call-ports-list", {
      action: "ports",
      args: { op: "list", include_inactive: true },
    })) as { details: { status: string; data: { details: { leases: unknown[] } } } };

    expect(listPortLeases).toHaveBeenCalledWith({ includeInactive: true });
    expect(result.details.status).toBe("succeeded");
    expect(result.details.data.details.leases).toEqual([]);
  });

  it("rejects legacy direct-tool names as dispatcher action values", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-legacy-action", {
      action: "pinet_send",
    })) as { details: { status: string; errors: Array<{ message: string }> } };

    expect(result.details.status).toBe("failed");
    expect(result.details.errors[0]?.message).toContain("Unknown Pinet action: pinet_send");
  });

  it("preserves explicit JSON output for dispatcher errors", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-error-json", {
      action: "skin",
      args: { theme: "foundation", format: "json" },
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]?.text).toContain('"status": "failed"');
    expect(result.content[0]?.text).toContain('"errors"');
  });

  it("preserves explicit full output for dispatcher errors", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-error-full", {
      action: "skin",
      args: { theme: "foundation", full: true },
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]?.text).toContain('"status": "failed"');
    expect(result.content[0]?.text).toContain('"errors"');
  });

  it("preserves explicit full output for action runtime errors", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-runtime-error-full", {
      action: "send",
      args: { message: "dispatch now", full: true },
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]?.text).toContain('"status": "failed"');
    expect(result.content[0]?.text).toContain('"to is required"');
  });

  it("preserves valid structured action output flags when a sibling output flag is invalid", async () => {
    const tools = registerWithDeps(createDeps());

    const jsonResult = (await tools.get("pinet")?.execute("tool-call-send-json-invalid-full", {
      action: "send",
      args: { to: "alpha", message: "dispatch now", format: "json", full: "true" },
    })) as { content: Array<{ text: string }> };
    const fullResult = (await tools.get("pinet")?.execute("tool-call-send-full-invalid-format", {
      action: "send",
      args: { to: "alpha", message: "dispatch now", format: "yaml", full: true },
    })) as { content: Array<{ text: string }> };

    expect(jsonResult.content[0]?.text).toContain('"status": "failed"');
    expect(jsonResult.content[0]?.text).toContain('"full must be a boolean when provided."');
    expect(fullResult.content[0]?.text).toContain('"status": "failed"');
    expect(fullResult.content[0]?.text).toContain('"format must be');
  });

  it("reports invalid output options as compact CLI text by default", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-invalid-output", {
      action: "send",
      args: { to: "alpha", message: "dispatch now", full: "true" },
    })) as {
      content: Array<{ text: string }>;
      details: { status: string; errors: Array<{ message: string }> };
    };

    expect(result.content[0]?.text).toContain(
      "Pinet failed: full must be a boolean when provided.",
    );
    expect(result.content[0]?.text).not.toContain('"errors"');
    expect(result.details.status).toBe("failed");
    expect(result.details.errors[0]?.message).toBe("full must be a boolean when provided.");
  });

  it("routes action-dispatched pinet send", async () => {
    const sendPinetAgentMessage = vi.fn(async (_to: string, _message: string) => ({
      messageId: 41,
      target: "alpha",
    }));
    const deps = createDeps({ sendPinetAgentMessage });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-dispatch-send", {
      action: "send",
      args: {
        to: "alpha",
        message: "dispatch now",
        format: "json",
      },
    })) as {
      content: Array<{ text: string }>;
      details: { status: string; data: { action: string; text: string } };
    };

    expect(sendPinetAgentMessage).toHaveBeenCalledWith("alpha", "dispatch now");
    expect(result.details.status).toBe("succeeded");
    expect(result.details.data.action).toBe("send");
    expect(result.details.data.text).toBe("Pinet message sent to alpha.");
    expect(result.content[0]?.text).toContain('"status": "succeeded"');
  });

  it("passes broker thread ownership transfers through pinet send metadata", async () => {
    const sendPinetAgentMessage = vi.fn(async (_to: string, _message: string) => ({
      messageId: 41,
      target: "alpha",
      transferredThreadId: "1777798507.674009",
    }));
    const deps = createDeps({ sendPinetAgentMessage });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-dispatch-send-transfer", {
      action: "send",
      args: {
        to: "alpha",
        message: "dispatch now",
        transfer_thread_id: "1777798507.674009",
        format: "json",
      },
    })) as {
      details: { status: string; data: { text: string; details: Record<string, unknown> } };
    };

    expect(sendPinetAgentMessage).toHaveBeenCalledWith("alpha", "dispatch now", {
      threadOwnershipTransfer: { mode: "transfer", threadId: "1777798507.674009" },
    });
    expect(result.details.status).toBe("succeeded");
    expect(result.details.data.text).toBe(
      "Pinet message sent to alpha; transferred thread 1777798507.674009.",
    );
    expect(result.details.data.details.transferredThreadId).toBe("1777798507.674009");
  });

  it("rejects follower thread ownership transfers", async () => {
    const sendPinetAgentMessage = vi.fn(async (_to: string, _message: string) => ({
      messageId: 41,
      target: "alpha",
    }));
    const deps = createDeps({ brokerRole: () => "follower", sendPinetAgentMessage });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-dispatch-send-transfer-follower", {
      action: "send",
      args: {
        to: "alpha",
        message: "dispatch now",
        transfer_thread_id: "1777798507.674009",
      },
    })) as { details: { status: string; errors: Array<{ message: string }> } };

    expect(result.details.status).toBe("failed");
    expect(result.details.errors[0]?.message).toContain("transfer_thread_id is broker-only");
    expect(sendPinetAgentMessage).not.toHaveBeenCalled();
  });

  it("honors explicit full output for pinet send", async () => {
    const sendPinetAgentMessage = vi.fn(async (_to: string, _message: string) => ({
      messageId: 41,
      target: "alpha",
    }));
    const deps = createDeps({ sendPinetAgentMessage });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-dispatch-send-full", {
      action: "send",
      args: {
        to: "alpha",
        message: "dispatch now",
        "--full": true,
      },
    })) as { details: { data: { text: string; details: { messageId: number } } } };

    expect(result.details.data.text).toBe("Message sent to alpha (id: 41).");
    expect(result.details.data.details.messageId).toBe(41);
  });

  it("formats action-dispatched free responses with note and queued inbox count", async () => {
    const signalAgentFree = vi.fn(async () => ({
      queuedInboxCount: 2,
      drainedQueuedInbox: false,
    }));
    const deps = createDeps({ signalAgentFree });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-2", {
      action: "free",
      args: { note: "wrapped up #395" },
    })) as {
      details: {
        status: "succeeded";
        data: {
          text: string;
          details: { status: string; note: string | null; queuedInboxCount: number };
        };
      };
    };

    expect(signalAgentFree).toHaveBeenCalledWith(undefined, { requirePinet: true });
    expect(result.details.data.text).toBe("Pinet free: idle; 2 queued.");
    expect(result.details.data.details).toEqual({
      status: "idle",
      note: "wrapped up #395",
      queuedInboxCount: 2,
    });
  });

  it("routes action-dispatched schedule through the broker wake-up callback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));

    const scheduleBrokerWakeup = vi.fn(async (fireAt: string, _message: string) => ({
      id: 7,
      fireAt,
    }));
    const deps = createDeps({ scheduleBrokerWakeup });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-3", {
      action: "schedule",
      args: { delay: "5m", message: "check queue" },
    })) as {
      details: {
        status: "succeeded";
        data: { text: string; details: { id: number; fireAt: string } };
      };
    };

    expect(scheduleBrokerWakeup).toHaveBeenCalledWith("2026-04-14T12:05:00.000Z", "check queue");
    expect(result.details.data.text).toBe("Pinet wake-up scheduled for 2026-04-14T12:05:00.000Z.");
    expect(result.details.data.details).toEqual({ id: 7, fireAt: "2026-04-14T12:05:00.000Z" });
  });

  it("updates durable PM lane metadata through the lanes dispatcher", async () => {
    const upsertPinetLane = vi.fn(createDeps().upsertPinetLane);
    const setPinetLaneParticipant = vi.fn(createDeps().setPinetLaneParticipant);
    const deps = createDeps({ upsertPinetLane, setPinetLaneParticipant });
    const tools = registerWithDeps(deps);

    const laneResult = (await tools.get("pinet")?.execute("tool-call-lane-upsert", {
      action: "lanes",
      args: {
        op: "upsert",
        lane_id: "issue-688",
        issue_number: 688,
        owner_agent: "worker-pm",
        implementation_lead: "worker-lead",
        pm_mode: true,
        state: "active",
        summary: "maintainer-consented PM mode",
        full: true,
      },
    })) as {
      details: { status: string; data: { text: string; details: { lane: { pmMode: boolean } } } };
    };

    const participantResult = (await tools.get("pinet")?.execute("tool-call-lane-participant", {
      action: "lanes",
      args: {
        op: "participant",
        lane_id: "issue-688",
        agent_id: "worker-pm",
        lane_role: "pm",
        status: "coordinating",
      },
    })) as { details: { status: string; data: { text: string } } };

    expect(upsertPinetLane).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "issue-688",
        issueNumber: 688,
        ownerAgentId: "worker-pm",
        implementationLeadAgentId: "worker-lead",
        pmMode: true,
        state: "active",
      }),
    );
    expect(setPinetLaneParticipant).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "issue-688", agentId: "worker-pm", role: "pm" }),
    );
    expect(laneResult.details.status).toBe("succeeded");
    expect(laneResult.details.data.details.lane.pmMode).toBe(true);
    expect(participantResult.details.data.text).toContain("participant worker-pm saved as pm");
  });

  it("passes explicit null clears through the lanes dispatcher", async () => {
    const upsertPinetLane = vi.fn(createDeps().upsertPinetLane);
    const setPinetLaneParticipant = vi.fn(createDeps().setPinetLaneParticipant);
    const tools = registerWithDeps(createDeps({ upsertPinetLane, setPinetLaneParticipant }));

    await tools.get("pinet")?.execute("tool-call-lane-clear", {
      action: "lanes",
      args: {
        op: "upsert",
        lane_id: "issue-688",
        pr_number: null,
        owner_agent: null,
        implementation_lead: null,
        summary: null,
        metadata: null,
      },
    });
    await tools.get("pinet")?.execute("tool-call-participant-clear", {
      action: "lanes",
      args: {
        op: "participant",
        lane_id: "issue-688",
        agent_id: "worker-pm",
        lane_role: "observer",
        status: null,
        summary: null,
        metadata: null,
      },
    });

    expect(upsertPinetLane).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "issue-688",
        prNumber: null,
        ownerAgentId: null,
        implementationLeadAgentId: null,
        summary: null,
        metadata: null,
      }),
    );
    expect(setPinetLaneParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "issue-688",
        agentId: "worker-pm",
        role: "observer",
        status: null,
        summary: null,
        metadata: null,
      }),
    );
  });

  it("renders detached lanes only when explicitly included or filtered", async () => {
    const listPinetLanes = vi.fn(async () => [
      {
        laneId: "issue-123",
        name: null,
        task: null,
        issueNumber: 123,
        prNumber: null,
        threadId: null,
        ownerAgentId: "worker-human",
        implementationLeadAgentId: null,
        pmMode: false,
        state: "detached" as const,
        summary: "manual supervision",
        metadata: null,
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
        lastActivityAt: "2026-05-01T00:00:00.000Z",
        participants: [],
      },
    ]);
    const tools = registerWithDeps(createDeps({ listPinetLanes }));

    const result = (await tools.get("pinet")?.execute("tool-call-lanes-list", {
      action: "lanes",
      args: { state: "detached", full: true },
    })) as { details: { data: { text: string } } };

    expect(listPinetLanes).toHaveBeenCalledWith({ state: "detached" });
    expect(result.details.data.text).toContain("issue-123 [detached]");
    expect(result.details.data.text).toContain("manual supervision");
  });

  it("renders broker pinet agents output with routing hints, outbound counts, and pending inbox", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));

    const listBrokerAgents = vi.fn(() => [makeAgent({ outboundCount: 3, pendingInboxCount: 2 })]);
    const deps = createDeps({ listBrokerAgents });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-4", {
      action: "agents",
      args: {
        repo: "extensions",
        required_tools: "read, edit",
        task: "review #395",
        full: true,
      },
    })) as {
      details: {
        status: "succeeded";
        data: {
          text: string;
          details: { hint: { repo?: string; requiredTools?: string[]; task?: string } };
        };
      };
    };

    expect(listBrokerAgents).toHaveBeenCalledTimes(1);
    expect(result.details.data.text).toContain(
      "Agent routing hints: repo=extensions · tools=read,edit · task=review #395",
    );
    expect(result.details.data.text).toContain("Golden Chalk Rabbit");
    expect(result.details.data.text).toContain("outbound: 3 this session");
    expect(result.details.data.text).toContain("pending inbox: 2 queued items");
    expect(result.details.data.details.hint).toEqual({
      repo: "extensions",
      branch: undefined,
      role: undefined,
      requiredTools: ["read", "edit"],
      task: "review #395",
    });
  });

  it("hides recently disconnected agents from pinet agents unless ghosts are requested", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));

    const listBrokerAgents = vi.fn(() => [
      makeAgent({ id: "live", name: "Live Lynx" }),
      makeAgent({
        id: "exited",
        name: "Exited Egret",
        disconnectedAt: "2026-04-14T11:59:59.000Z",
      }),
    ]);
    const tools = registerWithDeps(createDeps({ listBrokerAgents }));

    const defaultResult = (await tools.get("pinet")?.execute("tool-call-agents-live", {
      action: "agents",
      args: { full: true },
    })) as { details: { data: { text: string; details: { agents: Array<{ id: string }> } } } };
    expect(defaultResult.details.data.details.agents.map((agent) => agent.id)).toEqual(["live"]);
    expect(defaultResult.details.data.text).not.toContain("Exited Egret");

    const withGhostsResult = (await tools.get("pinet")?.execute("tool-call-agents-ghosts", {
      action: "agents",
      args: { full: true, include_ghosts: true },
    })) as { details: { data: { text: string; details: { agents: Array<{ id: string }> } } } };
    expect(withGhostsResult.details.data.details.agents.map((agent) => agent.id)).toEqual([
      "live",
      "exited",
    ]);
    expect(withGhostsResult.details.data.text).toContain("Exited Egret");
  });

  it("passes the ghost visibility preference through follower agent listing", async () => {
    const listFollowerAgents = vi.fn(async (_includeGhosts: boolean) => [
      makeAgent({ id: "agent-2" }),
    ]);
    const tools = registerWithDeps(
      createDeps({ brokerRole: () => "follower", listFollowerAgents }),
    );

    await tools.get("pinet")?.execute("tool-call-follower-agents-live", {
      action: "agents",
      args: {},
    });
    await tools.get("pinet")?.execute("tool-call-follower-agents-ghosts", {
      action: "agents",
      args: { include_ghosts: true },
    });

    expect(listFollowerAgents).toHaveBeenNthCalledWith(1, false);
    expect(listFollowerAgents).toHaveBeenNthCalledWith(2, true);
  });

  it("keeps pinet agents default cli details compact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));

    const listBrokerAgents = vi.fn(() => [makeAgent({ metadata: { repo: "extensions" } })]);
    const deps = createDeps({ listBrokerAgents });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-agents-compact-details", {
      action: "agents",
      args: { repo: "extensions" },
    })) as {
      content: Array<{ text: string }>;
      details: {
        data: {
          text: string;
          details: {
            count: number;
            agents: Array<{ name: string; repo: string | null; metadata?: unknown }>;
            hint: { repo?: string };
          };
          compact_details?: unknown;
        };
      };
    };

    expect(result.content[0]?.text).toBe("Pinet agents: 1 visible; hints repo=extensions.");
    expect(result.content[0]?.text).not.toContain("Golden Chalk Rabbit");
    expect(result.details.data.text).not.toContain("pid:");
    expect(result.details.data.details.agents[0]?.name).toBe("Golden Chalk Rabbit");
    expect(result.details.data.details.agents[0]?.repo).toBe("extensions");
    expect(result.details.data.details.agents[0]?.metadata).toBeUndefined();
    expect(result.details.data.details.hint.repo).toBe("extensions");
    expect(result.details.data.compact_details).toBeUndefined();
  });
});
