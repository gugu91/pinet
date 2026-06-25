import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatPinetDispatcherResultForDisplay,
  registerPinetTools,
  type PinetToolsAgentRecord,
  type RegisterPinetToolsDeps,
} from "./pinet-tools.js";

interface MinimalRenderTheme {
  fg: (_color: string, text: string) => string;
  bold: (text: string) => string;
}

function expectJsonStatus(text: string | undefined, status: "succeeded" | "failed"): void {
  expect(JSON.parse(text ?? "{}").status).toBe(status);
}

interface MinimalComponent {
  render(width: number): string[];
}

type ToolDefinition = {
  name: string;
  promptSnippet?: string;
  parameters?: unknown;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
  renderResult?: (
    result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
    options: { expanded: boolean; isPartial?: boolean },
    theme: MinimalRenderTheme,
    context: unknown,
  ) => MinimalComponent;
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
    listSubtreeAgents: () => null,
    getSubtreeSelfAgentId: () => null,
    spawnSubtreeWorker: async (input) => ({
      status: "started",
      launchId: "launch-1",
      sessionName: "pinet-extensions-reviewer-launch-1",
      repoPath: `/tmp/${input.repo}`,
      role: input.role ?? "subworker",
      laneId: input.laneId ?? null,
      agentId: "child-1",
      agentName: "Child Worker",
      messageId: 42,
      threadId: "a2a:subbroker:child-1",
      monitorCommand: "tmux attach -t pinet-extensions-reviewer-launch-1",
      socketPath: "/tmp/pinet-subtrees/worker-1/pinet.sock",
      dbPath: "/tmp/pinet-subtrees/worker-1/pinet-broker.db",
      childLaunchEnv: {},
    }),
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
    expect(pinet?.promptSnippet).toContain("verbose/debug detail");
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

  it("formats Pinet dispatcher results for human-readable TUI display", async () => {
    const tools = registerWithDeps(createDeps());
    const result = (await tools.get("pinet")?.execute("tool-call-schedule-json", {
      action: "schedule",
      args: { at: "2026-07-01T00:05:00.000Z", message: "check queue", format: "json" },
    })) as { content: Array<{ type: string; text: string }>; details: unknown };

    expectJsonStatus(result.content[0]?.text, "succeeded");

    const collapsed = formatPinetDispatcherResultForDisplay(result, false);
    const expanded = formatPinetDispatcherResultForDisplay(result, true);

    expect(collapsed).toEqual({
      status: "succeeded",
      text: "Pinet wake-up scheduled for 2026-07-01T00:05:00.000Z (id 7).",
    });
    expect(expanded.text).toContain("status: succeeded");
    expect(expanded.text).toContain("action: schedule");
    expect(expanded.text).toContain("id: 7");
    expect(expanded.text).not.toContain('"errors"');
  });

  it("renders Pinet dispatcher results as readable text instead of raw JSON", async () => {
    const tools = registerWithDeps(createDeps());
    const pinet = tools.get("pinet");
    const result = (await pinet?.execute("tool-call-send-json", {
      action: "send",
      args: { to: "alpha", message: "dispatch now", format: "json" },
    })) as { content: Array<{ type: string; text: string }>; details: unknown };
    const theme: MinimalRenderTheme = { fg: (_color, text) => text, bold: (text) => text };

    const collapsed = pinet?.renderResult?.(result, { expanded: false }, theme, {}).render(200);
    const expanded = pinet?.renderResult?.(result, { expanded: true }, theme, {}).render(200);

    expectJsonStatus(result.content[0]?.text, "succeeded");
    const collapsedText = collapsed?.map((line) => line.trimEnd()).join("\n");
    const expandedText = expanded?.map((line) => line.trimEnd()).join("\n");

    // Collapsed shows the target plus a capped, operator-facing message preview.
    expect(collapsedText).toBe("✓ Pinet message sent to alpha · “dispatch now”.");
    // Expanded shows the sent envelope and full body, not a JSON wall.
    expect(expandedText).toContain("to: alpha");
    expect(expandedText).toContain("message id: 17");
    expect(expandedText).toContain("message (1 line, 12 chars):");
    expect(expandedText).toContain("dispatch now");
    expect(expandedText).not.toContain('"status"');
    expect(expandedText).not.toContain("details:");
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
          details: {
            channel: string;
            messageCount: number;
            recipientCount: number;
            recipients: string[];
          };
        };
      };
    };

    expect(sendPinetBroadcastMessage).toHaveBeenCalledWith("#extensions", "hello mesh");
    expect(result.details.data.text).toBe(
      "Pinet broadcast sent to #extensions (2 recipients) · “hello mesh”.",
    );
    expect(result.details.data.details).toEqual({
      channel: "#extensions",
      messageCount: 2,
      recipientCount: 2,
      recipients: ["Worker One", "Worker Two"],
      recipientsTruncated: 0,
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
        data: { text: string; details: { markedReadCount: number; messageCount: number } };
      };
    };

    expect(readPinetInbox).toHaveBeenCalledWith({ threadId: "a2a:broker:worker", limit: 5 });
    expect(result.details.data.text).toContain(
      "Pinet read: 1 unread message; unread 2→1; marked 1; 1 unread thread.",
    );
    expect(result.details.data.text).toContain("broker: please inspect #594");
    expect(result.details.data.text).not.toContain("Unread before:");
    expect(result.details.data.details.markedReadCount).toBe(1);
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
      args: {},
    })) as {
      content: Array<{ text: string }>;
      details: {
        data: {
          text: string;
          details: {
            messages: Array<{ id: number; preview?: string; message?: { body?: string } }>;
          };
          compact_details?: unknown;
          full_details?: unknown;
        };
      };
    };

    // Header summary line stays stable; inbox-wide compact reads now include the
    // same capped per-message preview previously gated behind `thread_id`.
    expect(result.content[0]?.text?.split("\n")[0]).toBe(
      "Pinet read: 1 unread message; unread 1→0; marked 1.",
    );
    expect(result.content[0]?.text).toContain(
      "- [steering] [agent/a2a:broker:worker #44] broker: please inspect important context",
    );
    // Preview must be truncated; raw long body stays out of the compact text.
    expect(result.content[0]?.text).toContain("…");
    expect(result.content[0]?.text).not.toContain(longBody);
    expect(result.content[0]?.text).not.toContain("keep exact body");
    expect(result.details.data.text).not.toContain(longBody);
    expect(result.details.data.details.messages[0]?.id).toBe(44);
    expect(result.details.data.details.messages[0]?.preview).toBeUndefined();
    expect(result.details.data.details.messages[0]?.message?.body).toBeUndefined();
    expect(JSON.stringify(result.details.data.details)).not.toContain(longBody);
    expect(result.details.data.compact_details).toBeUndefined();
    expect(result.details.data.full_details).toBeUndefined();
  });

  it("keeps default thread reads bounded with previews instead of exact bodies", async () => {
    const longBody = `thread context ${"dense detail ".repeat(40)}final exact suffix`;
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
    const tools = registerWithDeps(createDeps({ readPinetInbox }));

    const result = (await tools.get("pinet")?.execute("tool-call-read-thread-compact", {
      action: "read",
      args: { thread_id: "a2a:broker:worker" },
    })) as { content: Array<{ text: string }>; details: { data: { text: string } } };

    expect(result.content[0]?.text.length).toBeLessThan(500);
    expect(result.content[0]?.text).toContain("thread context dense detail");
    expect(result.content[0]?.text).toContain("args.full=true args.unread_only=false");
    expect(result.content[0]?.text).not.toContain("final exact suffix");
    expect(result.content[0]?.text).not.toContain("Unread before:");
    expect(result.details.data.text).not.toContain(longBody);
  });

  it("keeps pinet read format=json structured details compact by default", async () => {
    const body = `exact json ${"body detail ".repeat(30)}final suffix`;
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
      data: {
        details: { messages: Array<{ id: number; preview?: string; message?: { body: string } }> };
      };
    };

    expect(envelope.data.details.messages[0]?.id).toBe(44);
    expect(envelope.data.details.messages[0]?.preview).toBeUndefined();
    expect(envelope.data.details.messages[0]?.message).toBeUndefined();
    expect(result.content[0]?.text).not.toContain(body);
    expect(result.content[0]?.text).not.toContain("\n");
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

  it("keeps action-dispatched help format=json compact by default", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-dispatch-help-json", {
      action: "help",
      args: { format: "json" },
    })) as { content: Array<{ text: string }> };

    expectJsonStatus(result.content[0]?.text, "succeeded");
    expect(result.content[0]?.text).not.toContain('"args_schema"');
    expect(result.content[0]?.text).toContain("full catalog schemas/examples");
  });

  it("preserves explicit full output for action-dispatched help", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-dispatch-help-full", {
      action: "help",
      args: { full: true },
    })) as { content: Array<{ text: string }> };

    expectJsonStatus(result.content[0]?.text, "succeeded");
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

    expectJsonStatus(jsonResult.content[0]?.text, "failed");
    expect(jsonResult.content[0]?.text).toContain('"full must be a boolean when provided."');
    expectJsonStatus(fullResult.content[0]?.text, "failed");
    expect(fullResult.content[0]?.text).toContain('"format must be');
  });

  it("points compact help topic callers to JSON/full discovery", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-dispatch-help-topic", {
      action: "help",
      args: { topic: "read" },
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]?.text).toContain('Use args.format="json" for the compact envelope');
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
      details: { status: string; data: { details: { port: number; lease?: unknown } } };
    };

    expect(acquirePortLease).toHaveBeenCalledWith({
      purpose: "preview",
      ttlMs: 600_000,
      minPort: 52000,
      maxPort: 52010,
    });
    expect(result.details.status).toBe("succeeded");
    expect(result.details.data.details.port).toBe(52000);
    expect(result.details.data.details.lease).toBeUndefined();
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

    expectJsonStatus(result.content[0]?.text, "failed");
    expect(result.content[0]?.text).toContain('"errors"');
  });

  it("preserves explicit full output for dispatcher errors", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-error-full", {
      action: "skin",
      args: { theme: "foundation", full: true },
    })) as { content: Array<{ text: string }> };

    expectJsonStatus(result.content[0]?.text, "failed");
    expect(result.content[0]?.text).toContain('"errors"');
  });

  it("preserves explicit full output for action runtime errors", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-runtime-error-full", {
      action: "send",
      args: { message: "dispatch now", full: true },
    })) as { content: Array<{ text: string }> };

    expectJsonStatus(result.content[0]?.text, "failed");
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

    expectJsonStatus(jsonResult.content[0]?.text, "failed");
    expect(jsonResult.content[0]?.text).toContain('"full must be a boolean when provided."');
    expectJsonStatus(fullResult.content[0]?.text, "failed");
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
    expectJsonStatus(result.content[0]?.text, "succeeded");
    expect(result.content[0]?.text).not.toContain('"display"');
    expect(result.content[0]?.text).not.toContain("dispatch now");
  });

  it("passes broker thread ownership transfers through pinet send metadata", async () => {
    const sendPinetAgentMessage = vi.fn(async (_to: string, _message: string) => ({
      messageId: 41,
      target: "alpha",
      transferredThreadId: "1777798507.674009",
      transferredThreadChannel: "C123",
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
      "Pinet message sent to alpha; transferred Slack thread 1777798507.674009.",
    );
    expect(result.details.data.details.transferredThreadId).toBe("1777798507.674009");
    expect(result.details.data.details.transferredThreadChannel).toBe("C123");
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
    expect(result.details.data.text).toBe(
      "Pinet wake-up scheduled for 2026-04-14T12:05:00.000Z (id 7).",
    );
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

  it("lists local subtree children from a follower-owned subtree broker", async () => {
    const listSubtreeAgents = vi.fn(() => [
      makeAgent({ id: "subbroker", name: "Parent Subbroker" }),
      makeAgent({
        id: "child",
        name: "Child",
        parentAgentId: "subbroker",
        rootAgentId: "subbroker",
        treeDepth: 1,
        supervisionState: "supervised",
        subtreeRole: "reviewer",
      }),
    ]);
    const listFollowerAgents = vi.fn(async () => [makeAgent({ id: "central-worker" })]);
    const tools = registerWithDeps(
      createDeps({
        brokerRole: () => "follower",
        listFollowerAgents,
        listSubtreeAgents,
        getSubtreeSelfAgentId: () => "subbroker",
      }),
    );

    const result = (await tools.get("pinet")?.execute("tool-call-subtree-agents", {
      action: "agents",
      args: { scope: "subtree", full: true },
    })) as { details: { data: { details: { agents: Array<{ id: string }> } } } };

    expect(listSubtreeAgents).toHaveBeenCalledWith(false);
    expect(listFollowerAgents).not.toHaveBeenCalled();
    expect(result.details.data.details.agents.map((agent) => agent.id)).toEqual(["child"]);
  });

  it("filters pinet agents by explicit subtree scope and shows hierarchy metadata", async () => {
    const listBrokerAgents = vi.fn(() => [
      makeAgent({ id: "parent", name: "Parent" }),
      makeAgent({
        id: "child",
        name: "Child",
        parentAgentId: "parent",
        rootAgentId: "parent",
        treeDepth: 1,
        supervisionState: "supervised",
        subtreeRole: "reviewer",
        laneId: "issue-761",
      }),
    ]);
    const tools = registerWithDeps(createDeps({ listBrokerAgents }));

    const result = (await tools.get("pinet")?.execute("tool-call-agents-children", {
      action: "agents",
      args: { scope: "children", parent_agent: "parent", full: true },
    })) as { details: { data: { text: string; details: { agents: Array<{ id: string }> } } } };

    expect(result.details.data.details.agents.map((agent) => agent.id)).toEqual(["child"]);
    expect(result.details.data.text).toContain("subtree: parent=parent");
    expect(result.details.data.text).toContain("role=reviewer");
  });

  it("launches subtree workers through the dispatcher", async () => {
    const spawnSubtreeWorker = vi.fn(createDeps().spawnSubtreeWorker);
    const tools = registerWithDeps(
      createDeps({ brokerRole: () => "follower", spawnSubtreeWorker }),
    );

    const result = (await tools.get("pinet")?.execute("tool-call-spawn", {
      action: "spawn",
      args: { task: "Review PR #761", repo: "extensions", role: "reviewer", full: true },
    })) as {
      details: { data: { text: string; details: { status: string; agentId: string } } };
    };

    expect(spawnSubtreeWorker).toHaveBeenCalledWith({
      task: "Review PR #761",
      repo: "extensions",
      role: "reviewer",
    });
    expect(result.details.data.text).toContain("Pinet subtree worker started");
    expect(result.details.data.text).toContain("Monitor: tmux attach");
    expect(result.details.data.details).toMatchObject({
      status: "started",
      agentId: "child-1",
    });
  });

  it("keeps default subtree spawn output free of monitor commands", async () => {
    const spawnSubtreeWorker = vi.fn(createDeps().spawnSubtreeWorker);
    const tools = registerWithDeps(
      createDeps({ brokerRole: () => "follower", spawnSubtreeWorker }),
    );

    const result = (await tools.get("pinet")?.execute("tool-call-spawn-compact", {
      action: "spawn",
      args: { task: "Review PR #761", repo: "extensions", role: "reviewer" },
    })) as {
      content: Array<{ text: string }>;
      details: { data: { text: string; details: { monitorCommand?: string; agentId: string } } };
    };

    expect(result.content[0]?.text).toContain("Pinet subtree worker started: Child Worker");
    expect(result.content[0]?.text).not.toContain("tmux attach");
    expect(result.details.data.details.agentId).toBe("child-1");
    expect(result.details.data.details.monitorCommand).toBeUndefined();
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
            agents: Array<{
              name: string;
              repo: string | null;
              metadata?: unknown;
              tmuxSession?: string;
            }>;
            hint: { repo?: string };
          };
          compact_details?: unknown;
        };
      };
    };

    expect(result.content[0]?.text).toBe(
      "Pinet agents: 1 visible (0 working, 1 idle); hints repo=extensions.",
    );
    expect(result.content[0]?.text).not.toContain("Golden Chalk Rabbit");
    expect(result.details.data.text).not.toContain("pid:");
    expect(result.details.data.details.agents[0]?.name).toBe("Golden Chalk Rabbit");
    expect(result.details.data.details.agents[0]?.repo).toBe("extensions");
    expect(result.details.data.details.agents[0]?.metadata).toBeUndefined();
    expect(result.details.data.details.agents[0]?.tmuxSession).toBeUndefined();
    expect(result.details.data.details.hint.repo).toBe("extensions");
    expect(result.details.data.compact_details).toBeUndefined();
  });

  it("keeps pinet agents format=json compact unless full is requested", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));

    const listBrokerAgents = vi.fn(() => [
      makeAgent({
        metadata: {
          repo: "extensions",
          role: "worker",
          personality: "very long persona ".repeat(30),
          capabilities: { tools: ["read", "edit"], tags: ["implementation"] },
          tmuxSession: "pinet-secret-session",
        },
      }),
    ]);
    const tools = registerWithDeps(createDeps({ listBrokerAgents }));

    const compact = (await tools.get("pinet")?.execute("tool-call-agents-json-compact", {
      action: "agents",
      args: { repo: "extensions", format: "json" },
    })) as { content: Array<{ text: string }> };
    const compactEnvelope = JSON.parse(compact.content[0]?.text ?? "{}") as {
      data: {
        details: {
          agents: Array<{ metadata?: unknown; personality?: string; tmuxSession?: string }>;
        };
      };
    };

    expect(compact.content[0]?.text).not.toContain("very long persona");
    expect(compact.content[0]?.text).not.toContain('"display"');
    expect(compactEnvelope.data.details.agents[0]?.metadata).toBeUndefined();
    expect(compactEnvelope.data.details.agents[0]?.personality).toBeUndefined();
    expect(compactEnvelope.data.details.agents[0]?.tmuxSession).toBeUndefined();

    const full = (await tools.get("pinet")?.execute("tool-call-agents-json-full", {
      action: "agents",
      args: { repo: "extensions", format: "json", full: true },
    })) as { content: Array<{ text: string }> };

    expect(full.content[0]?.text).toContain("very long persona");
    expect(full.content[0]?.text).toContain("pinet-secret-session");
    expect(full.content[0]?.text).not.toContain('"display"');
  });

  it("keeps pinet send format=json free of renderer-only display and message body", async () => {
    const sendPinetAgentMessage = vi.fn(async () => ({ messageId: 99, target: "beta" }));
    const tools = registerWithDeps(createDeps({ sendPinetAgentMessage }));

    const result = (await tools.get("pinet")?.execute("tool-call-send-json-display-contract", {
      action: "send",
      args: { to: "beta", message: "sensitive body for tui only", format: "json" },
    })) as { content: Array<{ text: string }>; details: { data: { details: unknown } } };

    expect(result.content[0]?.text).not.toContain('"display"');
    expect(result.content[0]?.text).not.toContain("sensitive body for tui only");
    expect(JSON.stringify(result.details.data.details)).not.toContain(
      "sensitive body for tui only",
    );
  });

  it("renders pinet agents as a human table when expanded instead of raw JSON", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));

    const listBrokerAgents = vi.fn(() => [
      makeAgent({
        id: "a0f208e9-3de9-4c06",
        name: "Aurora Emerald Cobra",
        emoji: "🐍",
        status: "working",
        metadata: { repo: "garage-demo-may-26", branch: "main", role: "worker" },
      }),
      makeAgent({
        id: "50131fcf-909f-4a35",
        name: "Crystal Coral Bear",
        emoji: "🐻",
        status: "idle",
        metadata: { repo: "projects", role: "worker" },
      }),
    ]);
    const tools = registerWithDeps(createDeps({ listBrokerAgents }));
    const pinet = tools.get("pinet");
    const theme: MinimalRenderTheme = { fg: (_color, text) => text, bold: (text) => text };

    const result = (await pinet?.execute("tool-call-agents-table", {
      action: "agents",
      args: {},
    })) as {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
      expandedText?: string;
    };

    const collapsed = pinet
      ?.renderResult?.(result, { expanded: false }, theme, {})
      .render(200)
      .map((line) => line.trimEnd())
      .join("\n");
    const expanded = pinet
      ?.renderResult?.(result, { expanded: true }, theme, {})
      .render(200)
      .map((line) => line.trimEnd())
      .join("\n");

    expect(collapsed).toBe("✓ Pinet agents: 2 visible (1 working, 1 idle).");
    // Expanded shows a scannable per-agent table, not a JSON wall.
    expect(expanded).toContain("Aurora Emerald Cobra");
    expect(expanded).toContain("a0f208e9");
    expect(expanded).toContain("garage-demo-may-26/main");
    expect(expanded).toContain("working");
    expect(expanded).toContain("Crystal Coral Bear");
    expect(expanded).not.toContain("capabilityTags");
    expect(expanded).not.toContain("routingScore");
    expect(expanded).not.toContain('[{"id"');
    expect(expanded).not.toContain("status: succeeded");
  });

  it("caps long pinet send previews and shows the body when expanded", async () => {
    const longMessage = "L".repeat(200);
    const sendPinetAgentMessage = vi.fn(async () => ({ messageId: 99, target: "beta" }));
    const tools = registerWithDeps(createDeps({ sendPinetAgentMessage }));
    const pinet = tools.get("pinet");
    const theme: MinimalRenderTheme = { fg: (_color, text) => text, bold: (text) => text };

    const result = (await pinet?.execute("tool-call-send-long", {
      action: "send",
      args: { to: "beta", message: longMessage },
    })) as {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
      expandedText?: string;
    };

    const collapsed = pinet
      ?.renderResult?.(result, { expanded: false }, theme, {})
      .render(200)
      .join("\n");
    const expanded = pinet
      ?.renderResult?.(result, { expanded: true }, theme, {})
      .render(200)
      .join("\n");

    // Collapsed preview is capped (ellipsis) and never echoes the full body.
    expect(collapsed).toContain("…");
    expect(collapsed).not.toContain("L".repeat(100));
    // Expanded shows the envelope plus the (capped) body with a char count.
    expect(expanded).toContain("to: beta");
    expect(expanded).toContain("message id: 99");
    expect(expanded).toContain("200 chars");
  });

  it("reports multi-line pinet send line counts in collapsed and expanded views", async () => {
    const multiline = "line one\nline two\nline three";
    const sendPinetAgentMessage = vi.fn(async () => ({ messageId: 7, target: "gamma" }));
    const tools = registerWithDeps(createDeps({ sendPinetAgentMessage }));
    const pinet = tools.get("pinet");
    const theme: MinimalRenderTheme = { fg: (_color, text) => text, bold: (text) => text };

    const result = (await pinet?.execute("tool-call-send-multiline", {
      action: "send",
      args: { to: "gamma", message: multiline },
    })) as {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
      expandedText?: string;
    };

    const collapsed = pinet
      ?.renderResult?.(result, { expanded: false }, theme, {})
      .render(200)
      .join("\n");
    const expanded = pinet
      ?.renderResult?.(result, { expanded: true }, theme, {})
      .render(200)
      .join("\n");

    expect(collapsed).toContain("(3 lines)");
    expect(expanded).toContain("message (3 lines, 28 chars):");
    expect(expanded).toContain("line one");
    expect(expanded).toContain("line three");
  });

  function makeReadResult() {
    return {
      messages: [
        {
          inboxId: 31,
          delivered: true,
          readAt: null,
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
        {
          inboxId: 32,
          delivered: true,
          readAt: null,
          message: {
            id: 45,
            threadId: "a2a:broker:worker",
            source: "agent",
            direction: "inbound",
            sender: "broker",
            body: "and #595",
            metadata: { a2a: true },
            createdAt: "2026-04-25T12:00:00.000Z",
          },
        },
      ],
      unreadCountBefore: 2,
      unreadCountAfter: 0,
      unreadThreads: [],
      markedReadIds: [31, 32],
    };
  }

  it("renders pinet read messages as rows when expanded but stays compact collapsed", async () => {
    const readPinetInbox = vi.fn(async () => makeReadResult());
    const tools = registerWithDeps(createDeps({ readPinetInbox }));
    const pinet = tools.get("pinet");
    const theme: MinimalRenderTheme = { fg: (_color, text) => text, bold: (text) => text };

    const result = (await pinet?.execute("tool-call-read-rows", {
      action: "read",
      args: { unread_only: true },
    })) as { content?: Array<{ type: string; text?: string }>; details?: unknown };

    const collapsed = pinet
      ?.renderResult?.(result, { expanded: false }, theme, {})
      .render(200)
      .join("\n");
    const expanded = pinet
      ?.renderResult?.(result, { expanded: true }, theme, {})
      .render(200)
      .join("\n");

    // Collapsed keeps the header summary line and, since inbox-wide compact
    // reads now include the same capped per-message previews as thread-scoped
    // reads, surfaces them dimmed below the header so callers can act without
    // expanding or opting into `full=true`.
    expect(collapsed).toContain("Pinet read: 2 unread messages");
    expect(collapsed).toContain("please inspect #594");
    // Expanded shows the per-message rows in the rich view, not a JSON wall.
    expect(expanded).toContain("please inspect #594");
    expect(expanded).toContain("and #595");
    expect(expanded).not.toContain("[{");
    expect(expanded).not.toContain('"inboxId"');
  });

  it("summarizes arrays in expanded fallback details instead of dumping JSON", async () => {
    const lease = (id: string) => ({
      id,
      purpose: "preview",
      port: 49152,
      host: "127.0.0.1",
      ownerAgentId: "agent-1",
      pid: null,
      status: "expired" as const,
      metadata: null,
      acquiredAt: "2026-05-01T00:00:00.000Z",
      renewedAt: "2026-05-01T00:00:00.000Z",
      expiresAt: "2026-05-01T00:10:00.000Z",
      releasedAt: null,
    });
    const expirePortLeases = vi.fn(async () => [lease("lease-1"), lease("lease-2")]);
    const tools = registerWithDeps(createDeps({ expirePortLeases }));
    const pinet = tools.get("pinet");
    const theme: MinimalRenderTheme = { fg: (_color, text) => text, bold: (text) => text };

    // ports op=expire has no custom expanded view, so it exercises the hardened
    // fallback which summarizes arrays rather than emitting a JSON wall.
    const result = (await pinet?.execute("tool-call-ports-expire", {
      action: "ports",
      args: { op: "expire" },
    })) as { content?: Array<{ type: string; text?: string }>; details?: unknown };

    const expanded = pinet
      ?.renderResult?.(result, { expanded: true }, theme, {})
      .render(200)
      .join("\n");

    expect(expanded).toContain("leases: 2 items");
    expect(expanded).not.toContain("[{");
    expect(expanded).not.toContain('"expiresAt"');
  });

  it("renders pinet ports list rows on expand but a count when collapsed", async () => {
    const listPortLeases = vi.fn(async () => [
      {
        id: "lease-1",
        purpose: "preview",
        port: 49152,
        host: "127.0.0.1",
        ownerAgentId: "agent-1",
        pid: null,
        status: "active" as const,
        metadata: null,
        acquiredAt: "2026-05-01T00:00:00.000Z",
        renewedAt: "2026-05-01T00:00:00.000Z",
        expiresAt: "2026-05-01T00:10:00.000Z",
        releasedAt: null,
      },
    ]);
    const tools = registerWithDeps(createDeps({ listPortLeases }));
    const pinet = tools.get("pinet");
    const theme: MinimalRenderTheme = { fg: (_color, text) => text, bold: (text) => text };

    const result = (await pinet?.execute("tool-call-ports-list-rows", {
      action: "ports",
      args: { op: "list" },
    })) as { content?: Array<{ type: string; text?: string }>; details?: unknown };

    const collapsed = pinet
      ?.renderResult?.(result, { expanded: false }, theme, {})
      .render(200)
      .map((line) => line.trimEnd())
      .join("\n");
    const expanded = pinet
      ?.renderResult?.(result, { expanded: true }, theme, {})
      .render(200)
      .join("\n");

    expect(collapsed).toBe("✓ Pinet port leases: 1.");
    expect(expanded).toContain("127.0.0.1:49152");
    expect(expanded).toContain("lease=lease-1");
    expect(expanded).not.toContain("leases: 1 item");
  });

  it("renders pinet lanes rows on expand but a count when collapsed", async () => {
    const listPinetLanes = vi.fn(async () => [
      {
        laneId: "issue-688",
        name: "Dispatcher UX",
        task: null,
        issueNumber: 688,
        prNumber: null,
        threadId: null,
        ownerAgentId: "agent-1",
        implementationLeadAgentId: null,
        pmMode: true,
        state: "active" as const,
        summary: null,
        metadata: null,
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
        lastActivityAt: "2026-05-01T00:00:00.000Z",
        participants: [],
      },
    ]);
    const tools = registerWithDeps(createDeps({ listPinetLanes }));
    const pinet = tools.get("pinet");
    const theme: MinimalRenderTheme = { fg: (_color, text) => text, bold: (text) => text };

    const result = (await pinet?.execute("tool-call-lanes-list-rows", {
      action: "lanes",
      args: { op: "list" },
    })) as { content?: Array<{ type: string; text?: string }>; details?: unknown };

    const collapsed = pinet
      ?.renderResult?.(result, { expanded: false }, theme, {})
      .render(200)
      .map((line) => line.trimEnd())
      .join("\n");
    const expanded = pinet
      ?.renderResult?.(result, { expanded: true }, theme, {})
      .render(200)
      .join("\n");

    expect(collapsed).toBe("✓ Pinet lanes: 1 tracked.");
    expect(expanded).toContain("issue-688");
    expect(expanded).toContain("[active]");
    expect(expanded).toContain("#688");
  });
});
