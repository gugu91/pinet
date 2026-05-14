import { describe, expect, it, vi } from "vitest";
import type { ActivityLogEntry } from "./activity-log.js";
import type { AgentInfo, BrokerMessage, TaskAssignmentInfo } from "./broker/types.js";
import {
  createPinetMeshOps,
  type PinetMeshOpsBrokerDbPort,
  type PinetMeshOpsDeps,
  type PinetMeshOpsFollowerClientPort,
} from "./pinet-mesh-ops.js";

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "agent-1",
    stableId: "stable-agent-1",
    name: "Agent One",
    emoji: "🐇",
    pid: 101,
    connectedAt: "2026-04-15T13:00:00.000Z",
    lastSeen: "2026-04-15T13:04:00.000Z",
    lastHeartbeat: "2026-04-15T13:04:30.000Z",
    metadata: { role: "worker", repo: "extensions" },
    status: "idle",
    disconnectedAt: null,
    resumableUntil: null,
    ...overrides,
  };
}

function createBrokerDeps(overrides: Partial<PinetMeshOpsDeps> = {}) {
  const agents: AgentInfo[] = [
    makeAgent({
      id: "broker-1",
      stableId: "stable-broker-1",
      name: "Broker Crane",
      emoji: "🦩",
      metadata: { role: "broker", repo: "extensions" },
    }),
    makeAgent({
      id: "worker-1",
      stableId: "stable-worker-1",
      name: "Worker One",
      emoji: "🦊",
      outboundCount: 3,
    }),
    makeAgent({
      id: "worker-2",
      stableId: "stable-worker-2",
      name: "Worker Two",
      emoji: "🐻",
      metadata: { role: "worker", channels: ["all"] },
    }),
  ];
  let nextMessageId = 1;
  const threads = new Map<
    string,
    {
      threadId: string;
      source?: string;
      channel?: string;
      ownerAgent?: string | null;
      ownerBinding?: "explicit" | null;
    }
  >();
  const insertedMessages: BrokerMessage[] = [];
  const createThread = vi.fn(
    (threadId: string, source: string, channel: string, ownerAgent: string | null) => {
      threads.set(threadId, { threadId, source, channel, ownerAgent, ownerBinding: null });
    },
  );
  const transferThreadOwnership = vi.fn((threadId: string, ownerAgent: string) => {
    const existing = threads.get(threadId);
    if (!existing) throw new Error(`Unknown thread ${threadId}`);
    threads.set(threadId, { ...existing, ownerAgent, ownerBinding: "explicit" });
    return { reassignedInboxCount: 2, updatedMessageCount: 1 };
  });
  const insertMessage = vi.fn(
    (
      threadId: string,
      source: string,
      direction: "inbound" | "outbound",
      sender: string,
      body: string,
      _targetAgentIds: string[],
      metadata?: Record<string, unknown>,
    ) => {
      const message: BrokerMessage = {
        id: nextMessageId++,
        threadId,
        source,
        direction,
        sender,
        body,
        metadata: metadata ?? null,
        createdAt: `2026-04-15T13:05:0${nextMessageId}.000Z`,
      };
      insertedMessages.push(message);
      return message;
    },
  );
  const recordTaskAssignment = vi.fn(
    (
      agentId: string,
      issueNumber: number,
      branch: string | null,
      threadId: string,
      sourceMessageId: number,
    ): TaskAssignmentInfo => ({
      id: sourceMessageId,
      agentId,
      issueNumber,
      branch,
      prNumber: null,
      status: "assigned",
      threadId,
      sourceMessageId,
      createdAt: "2026-04-15T13:06:00.000Z",
      updatedAt: "2026-04-15T13:06:00.000Z",
    }),
  );
  const scheduleWakeup = vi.fn((agentId: string, message: string, fireAt: string) => ({
    id: 7,
    fireAt,
    agentId,
    message,
  }));
  const getPendingInboxCount = vi.fn((agentId: string) => (agentId === "worker-1" ? 2 : 0));
  const logActivity = vi.fn((_entry: ActivityLogEntry) => undefined);

  const db: PinetMeshOpsBrokerDbPort = {
    getAgents: () => agents,
    getThread: (threadId) => threads.get(threadId) ?? null,
    createThread,
    insertMessage,
    getAllAgents: () => agents,
    getPendingInboxCount,
    transferThreadOwnership,
    recordTaskAssignment,
    scheduleWakeup,
  };

  const deps: PinetMeshOpsDeps = {
    getPinetEnabled: () => true,
    getBrokerRole: () => "broker",
    getActiveBrokerDb: () => db,
    getActiveBrokerSelfId: () => "broker-1",
    getAgentName: () => "Broker Crane",
    getFollowerClient: () => null,
    formatTrackedAgent: (agentId) =>
      agentId === "worker-1" ? "🦊 Worker One" : agentId === "worker-2" ? "🐻 Worker Two" : agentId,
    logActivity,
    ...overrides,
  };

  return {
    deps,
    db,
    agents,
    createThread,
    transferThreadOwnership,
    insertMessage,
    insertedMessages,
    recordTaskAssignment,
    scheduleWakeup,
    getPendingInboxCount,
    logActivity,
  };
}

function createFollowerDeps(overrides: Partial<PinetMeshOpsDeps> = {}) {
  const sendAgentMessage = vi.fn(
    async (_target: string, _body: string, _metadata?: Record<string, unknown>) => 17,
  );
  const scheduleWakeup = vi.fn(async (fireAt: string, _message: string) => ({ id: 9, fireAt }));
  const listAgents = vi.fn(async (_includeGhosts: boolean) => [
    {
      id: "worker-2",
      name: "Worker Two",
      emoji: "🐻",
      pid: 202,
      metadata: { role: "worker", repo: "extensions" },
      lastHeartbeat: "2026-04-15T13:09:00.000Z",
      lastSeen: "2026-04-15T13:09:30.000Z",
      disconnectedAt: null,
      resumableUntil: null,
      outboundCount: 2,
      pendingInboxCount: 4,
    },
  ]);
  const followerClient: PinetMeshOpsFollowerClientPort = {
    sendAgentMessage,
    scheduleWakeup,
    listAgents,
  };

  const deps: PinetMeshOpsDeps = {
    getPinetEnabled: () => true,
    getBrokerRole: () => "follower",
    getActiveBrokerDb: () => null,
    getActiveBrokerSelfId: () => null,
    getAgentName: () => "Follower Crane",
    getFollowerClient: () => followerClient,
    formatTrackedAgent: (agentId) => agentId,
    logActivity: vi.fn(),
    ...overrides,
  };

  return {
    deps,
    followerClient,
    sendAgentMessage,
    scheduleWakeup,
    listAgents,
  };
}

describe("createPinetMeshOps", () => {
  it("normalizes broker direct control messages before dispatch", async () => {
    const { deps, createThread, insertedMessages } = createBrokerDeps();
    const pinetMeshOps = createPinetMeshOps(deps);

    const result = await pinetMeshOps.sendPinetAgentMessage("worker-1", "/reload");

    expect(result).toEqual({ messageId: 1, target: "Worker One" });
    expect(createThread).toHaveBeenCalledWith("a2a:broker-1:worker-1", "agent", "", "broker-1");
    expect(insertedMessages).toHaveLength(1);
    expect(insertedMessages[0]).toMatchObject({
      threadId: "a2a:broker-1:worker-1",
      body: '{"type":"pinet:control","action":"reload"}',
      metadata: {
        senderAgent: "Broker Crane",
        a2a: true,
        type: "pinet:control",
        action: "reload",
      },
    });
  });

  it("records broker task assignments and logs assignment activity", async () => {
    const { deps, recordTaskAssignment, logActivity } = createBrokerDeps();
    const pinetMeshOps = createPinetMeshOps(deps);

    const message = [
      "ack/work/ask/report",
      "Issue: #418",
      "git worktree add .worktrees/refactor-418-pinet-mesh-ops -b refactor/418-pinet-mesh-ops",
    ].join("\n");

    await pinetMeshOps.sendPinetAgentMessage("worker-1", message);

    expect(recordTaskAssignment).toHaveBeenCalledWith(
      "worker-1",
      418,
      "refactor/418-pinet-mesh-ops",
      "a2a:broker-1:worker-1",
      1,
    );
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "task_assignment",
        title: "Task assigned",
        summary: "Assigned #418 to 🦊 Worker One.",
        details: ["#418 on `refactor/418-pinet-mesh-ops`"],
        fields: [
          { label: "Worker", value: "🦊 Worker One" },
          { label: "Thread", value: "a2a:broker-1:worker-1" },
          { label: "Message", value: 1 },
        ],
        tone: "info",
      }),
    );
  });

  it("transfers broker thread ownership to the direct recipient when requested", async () => {
    const { deps, insertedMessages, logActivity, transferThreadOwnership } = createBrokerDeps();
    const db = deps.getActiveBrokerDb();
    db?.createThread("1777798507.674009", "slack", "C123", "broker-1");
    const pinetMeshOps = createPinetMeshOps(deps);

    const result = await pinetMeshOps.sendPinetAgentMessage("worker-1", "please report back", {
      threadOwnershipTransfer: { mode: "transfer", threadId: "1777798507.674009" },
    });

    expect(result).toEqual({
      messageId: 1,
      target: "Worker One",
      transferredThreadId: "1777798507.674009",
    });
    expect(transferThreadOwnership).toHaveBeenCalledWith("1777798507.674009", "worker-1");
    expect(insertedMessages[0]?.metadata).toMatchObject({
      threadOwnershipTransfer: { mode: "transfer", threadId: "1777798507.674009" },
      senderAgent: "Broker Crane",
      a2a: true,
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "thread_transfer",
        title: "Thread ownership transferred",
        summary: "Transferred 1777798507.674009 to 🦊 Worker One.",
      }),
    );
  });

  it("rejects unknown thread ownership transfer requests before dispatch", async () => {
    const { deps, insertMessage, transferThreadOwnership } = createBrokerDeps();
    const pinetMeshOps = createPinetMeshOps(deps);

    await expect(
      pinetMeshOps.sendPinetAgentMessage("worker-1", "please report back", {
        threadOwnershipTransfer: { mode: "transfer", threadId: "missing-thread" },
      }),
    ).rejects.toThrow("Cannot transfer unknown thread missing-thread.");

    expect(insertMessage).not.toHaveBeenCalled();
    expect(transferThreadOwnership).not.toHaveBeenCalled();
  });

  it("rejects non-Slack thread ownership transfer requests", async () => {
    const { deps, insertMessage, transferThreadOwnership } = createBrokerDeps();
    const db = deps.getActiveBrokerDb();
    db?.createThread("a2a:broker-1:worker-1", "agent", "", "broker-1");
    const pinetMeshOps = createPinetMeshOps(deps);

    await expect(
      pinetMeshOps.sendPinetAgentMessage("worker-1", "please report back", {
        threadOwnershipTransfer: { mode: "transfer", threadId: "a2a:broker-1:worker-1" },
      }),
    ).rejects.toThrow("Thread a2a:broker-1:worker-1 is not a transferable Slack thread.");

    expect(insertMessage).not.toHaveBeenCalled();
    expect(transferThreadOwnership).not.toHaveBeenCalled();
  });

  it("rejects non-Slack transport ownership transfer requests", async () => {
    const { deps, insertMessage, transferThreadOwnership } = createBrokerDeps();
    const db = deps.getActiveBrokerDb();
    db?.createThread("imessage:chat:alice", "imessage", "chat:alice", "broker-1");
    const pinetMeshOps = createPinetMeshOps(deps);

    await expect(
      pinetMeshOps.sendPinetAgentMessage("worker-1", "please report back", {
        threadOwnershipTransfer: { mode: "transfer", threadId: "imessage:chat:alice" },
      }),
    ).rejects.toThrow("Thread imessage:chat:alice is not a transferable Slack thread.");

    expect(insertMessage).not.toHaveBeenCalled();
    expect(transferThreadOwnership).not.toHaveBeenCalled();
  });

  it("routes follower direct messages through the follower client", async () => {
    const { deps, sendAgentMessage } = createFollowerDeps();
    const pinetMeshOps = createPinetMeshOps(deps);

    const result = await pinetMeshOps.sendPinetAgentMessage("worker-2", "/exit");

    expect(sendAgentMessage).toHaveBeenCalledWith(
      "worker-2",
      '{"type":"pinet:control","action":"exit"}',
      { type: "pinet:control", action: "exit" },
    );
    expect(result).toEqual({ messageId: 17, target: "worker-2" });
  });

  it("sends broker broadcasts and returns the subscribed recipients", () => {
    const { deps, insertedMessages } = createBrokerDeps();
    const pinetMeshOps = createPinetMeshOps(deps);

    const result = pinetMeshOps.sendPinetBroadcastMessage("#all", "hello mesh");

    expect(result).toEqual({
      channel: "#all",
      messageIds: [1, 2],
      recipients: ["Worker One", "Worker Two"],
    });
    expect(insertedMessages.map((message) => message.body)).toEqual(["hello mesh", "hello mesh"]);
  });

  it("schedules broker and follower wakeups through the extracted ports", async () => {
    const broker = createBrokerDeps();
    const brokerMeshOps = createPinetMeshOps(broker.deps);
    const follower = createFollowerDeps();
    const followerMeshOps = createPinetMeshOps(follower.deps);

    await expect(
      brokerMeshOps.scheduleBrokerWakeup("2026-04-15T14:00:00.000Z", "check queue"),
    ).resolves.toEqual({
      id: 7,
      fireAt: "2026-04-15T14:00:00.000Z",
      agentId: "broker-1",
      message: "check queue",
    });
    await expect(
      followerMeshOps.scheduleFollowerWakeup("2026-04-15T14:05:00.000Z", "check queue"),
    ).resolves.toEqual({ id: 9, fireAt: "2026-04-15T14:05:00.000Z" });
    expect(broker.scheduleWakeup).toHaveBeenCalledWith(
      "broker-1",
      "check queue",
      "2026-04-15T14:00:00.000Z",
    );
    expect(follower.scheduleWakeup).toHaveBeenCalledWith("2026-04-15T14:05:00.000Z", "check queue");
  });

  it("lists broker and follower agents through the extracted ports", async () => {
    const broker = createBrokerDeps();
    const brokerMeshOps = createPinetMeshOps(broker.deps);
    const follower = createFollowerDeps();
    const followerMeshOps = createPinetMeshOps(follower.deps);

    expect(brokerMeshOps.listBrokerAgents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "worker-1",
          status: "idle",
          name: "Worker One",
          outboundCount: 3,
          pendingInboxCount: 2,
        }),
        expect.objectContaining({ id: "worker-2", status: "idle", name: "Worker Two" }),
      ]),
    );
    await expect(followerMeshOps.listFollowerAgents(true)).resolves.toEqual([
      expect.objectContaining({
        id: "worker-2",
        status: "idle",
        name: "Worker Two",
        outboundCount: 2,
        pendingInboxCount: 4,
      }),
    ]);
    expect(follower.listAgents).toHaveBeenCalledWith(true);
  });
});
