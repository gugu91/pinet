import { describe, it, expect, beforeEach } from "vitest";
import {
  MessageRouter,
  extractPiAgentThreadOwnerHint,
  findAgentMention,
  findExplicitThreadDirective,
} from "./router.js";
import type {
  AgentInfo,
  BrokerDBInterface,
  ChannelAssignment,
  InboundMessage,
  ThreadInfo,
} from "./types.js";

// ─── In-memory BrokerDBInterface stub ─────────────────────────────

class StubBrokerDBInterface implements BrokerDBInterface {
  threads = new Map<string, ThreadInfo>();
  agents: AgentInfo[] = [];
  channelAssignments = new Map<string, ChannelAssignment>();
  allowedUsers: Set<string> | null = null;
  inbox: Array<{ agentId: string; message: InboundMessage }> = [];

  getThread(threadId: string): ThreadInfo | null {
    return this.threads.get(threadId) ?? null;
  }

  getAgentById(agentId: string): AgentInfo | null {
    return this.agents.find((agent) => agent.id === agentId) ?? null;
  }

  getAgentByStableId(stableId: string): AgentInfo | null {
    return this.agents.find((agent) => agent.stableId === stableId) ?? null;
  }

  getAgents(): AgentInfo[] {
    return this.agents.filter((agent) => !agent.disconnectedAt);
  }

  getChannelAssignment(channel: string): ChannelAssignment | null {
    return this.channelAssignments.get(channel) ?? null;
  }

  getAllowedUsers(): Set<string> | null {
    return this.allowedUsers;
  }

  createThread(thread: ThreadInfo): void {
    this.threads.set(thread.threadId, thread);
  }

  updateThread(threadId: string, updates: Partial<ThreadInfo>): void {
    const existing = this.threads.get(threadId);
    if (!existing) {
      // Upsert: create with defaults
      const now = new Date().toISOString();
      this.threads.set(threadId, {
        threadId,
        source: updates.source ?? "slack",
        channel: updates.channel ?? "",
        ownerAgent: updates.ownerAgent !== undefined ? updates.ownerAgent : null,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }
    this.threads.set(threadId, { ...existing, ...updates });
  }

  claimThread(threadId: string, agentId: string, source = "slack", channel = ""): boolean {
    const existing = this.threads.get(threadId);
    if (existing) {
      if (existing.ownerAgent && existing.ownerAgent !== agentId) {
        return false;
      }
      this.threads.set(threadId, { ...existing, ownerAgent: agentId });
      return true;
    }
    const now = new Date().toISOString();
    this.threads.set(threadId, {
      threadId,
      source,
      channel,
      ownerAgent: agentId,
      createdAt: now,
      updatedAt: now,
    });
    return true;
  }

  queueMessage(agentId: string, message: InboundMessage): void {
    this.inbox.push({ agentId, message });
  }
}

// ─── Test helpers ────────────────────────────────────────

function makeAgent(overrides: Partial<AgentInfo> & { id: string; name: string }): AgentInfo {
  return {
    emoji: "🤖",
    pid: 1000,
    connectedAt: "2026-01-01T00:00:00Z",
    lastSeen: "2026-01-01T00:00:00Z",
    lastHeartbeat: "2026-01-01T00:00:00Z",
    metadata: null,
    status: "idle",
    ...overrides,
  };
}

function makeThread(overrides: Partial<ThreadInfo> & { threadId: string }): ThreadInfo {
  return {
    source: "slack",
    channel: "C001",
    ownerAgent: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeMessage(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    source: "slack",
    threadId: "t-100",
    channel: "C001",
    userId: "U001",
    text: "Hello",
    timestamp: "1700000000.000000",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────

describe("findAgentMention", () => {
  const agents = [
    makeAgent({ id: "a1", name: "CodeBot" }),
    makeAgent({ id: "a2", name: "ReviewBot" }),
  ];

  it("finds agent mentioned in text (case-insensitive)", () => {
    expect(findAgentMention("hey codebot, help me", agents)?.id).toBe("a1");
  });

  it("finds agent with @-prefix style", () => {
    expect(findAgentMention("@ReviewBot check this PR", agents)?.id).toBe("a2");
  });

  it("returns null when no agent mentioned", () => {
    expect(findAgentMention("just a regular message", agents)).toBeNull();
  });

  it("does not match partial names", () => {
    expect(findAgentMention("my codebotting is slow", agents)).toBeNull();
  });

  it("handles empty agent list", () => {
    expect(findAgentMention("CodeBot help", [])).toBeNull();
  });

  it("prefers the longest matching name to avoid prefix collisions", () => {
    const overlapping = [
      makeAgent({ id: "a-short", name: "Code" }),
      makeAgent({ id: "a-long", name: "CodeBot" }),
    ];
    expect(findAgentMention("hey CodeBot, review this", overlapping)?.id).toBe("a-long");
  });

  it("still matches the shorter name when only it appears", () => {
    const overlapping = [
      makeAgent({ id: "a-short", name: "Code" }),
      makeAgent({ id: "a-long", name: "CodeBot" }),
    ];
    expect(findAgentMention("fix the Code style please", overlapping)?.id).toBe("a-short");
  });
});

describe("extractPiAgentThreadOwnerHint", () => {
  it("returns the latest pi_agent_msg owner hint from thread replies", () => {
    expect(
      extractPiAgentThreadOwnerHint([
        {
          bot_id: "B1",
          metadata: {
            event_type: "pi_agent_msg",
            event_payload: {
              agent: "Pixel Lime Hippo",
              agent_owner: "owner:hippo",
            },
          },
        },
        {
          bot_id: "B2",
          metadata: {
            event_type: "pi_agent_msg",
            event_payload: {
              agent: "Aurora Pearl Cobra",
              agent_owner: "owner:cobra",
            },
          },
        },
      ]),
    ).toEqual({
      agentName: "Aurora Pearl Cobra",
      agentOwner: "owner:cobra",
    });
  });

  it("ignores non-pinet bot metadata and returns null when no owner hint exists", () => {
    expect(
      extractPiAgentThreadOwnerHint([
        {
          bot_id: "B1",
          metadata: {
            event_type: "other_event",
            event_payload: { agent: "Other Bot" },
          },
        },
      ]),
    ).toBeNull();
  });
});

describe("findExplicitThreadDirective", () => {
  const agents = [
    makeAgent({ id: "hippo", name: "Pixel Lime Hippo", stableId: "stable-hippo" }),
    makeAgent({ id: "cobra", name: "Aurora Pearl Cobra", stableId: "stable-cobra" }),
  ];

  it("finds a stand-down directive using a unique tail alias", () => {
    expect(findExplicitThreadDirective("cobra stand down", agents)).toMatchObject({
      kind: "stand_down",
      agent: expect.objectContaining({ id: "cobra" }),
    });
  });

  it("finds a reassignment directive in an owned thread", () => {
    expect(
      findExplicitThreadDirective("Pixel Lime Hippo please take over this thread", agents),
    ).toMatchObject({
      kind: "retarget",
      agent: expect.objectContaining({ id: "hippo" }),
    });
  });

  it("does not treat a plain parenthetical target as a reassignment signal", () => {
    expect(
      findExplicitThreadDirective(
        "ok nice I set that on merge, can you read them (Hippo) and come up with next steps?",
        agents,
      ),
    ).toBeNull();
  });
});

describe("MessageRouter — route", () => {
  let db: StubBrokerDBInterface;
  let router: MessageRouter;

  beforeEach(() => {
    db = new StubBrokerDBInterface();
    router = new MessageRouter(db);
  });

  it("routes to thread owner when thread has an owner", () => {
    const agent = makeAgent({ id: "a1", name: "Bot1" });
    db.agents = [agent];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    const decision = router.route(makeMessage({ threadId: "t-100" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a1" });
  });

  it("keeps a known Slack thread on its broker owner instead of latest bot owner hint", () => {
    const hippo = makeAgent({ id: "hippo", name: "Pixel Lime Hippo", stableId: "stable-hippo" });
    const cobra = makeAgent({ id: "cobra", name: "Aurora Pearl Cobra", stableId: "stable-cobra" });
    db.agents = [hippo, cobra];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "cobra" }));

    const decision = router.route(
      makeMessage({
        threadId: "t-100",
        text: "also check for hardcoded routes pls",
        metadata: {
          threadOwnerAgentOwner: "owner:99b0f2b5e8a7874e",
          threadOwnerAgentName: "Pixel Lime Hippo",
        },
      }),
    );

    expect(decision).toEqual({ action: "deliver", agentId: "cobra" });
    expect(db.threads.get("t-100")?.ownerAgent).toBe("cobra");
  });

  it("uses a Slack thread owner hint only for an existing unowned thread", () => {
    const hippo = makeAgent({ id: "hippo", name: "Pixel Lime Hippo", stableId: "stable-hippo" });
    const cobra = makeAgent({ id: "cobra", name: "Aurora Pearl Cobra", stableId: "stable-cobra" });
    db.agents = [hippo, cobra];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: null }));

    const decision = router.route(
      makeMessage({
        threadId: "t-100",
        text: "also check for hardcoded routes pls",
        metadata: {
          threadOwnerAgentOwner: "owner:99b0f2b5e8a7874e",
          threadOwnerAgentName: "Pixel Lime Hippo",
        },
      }),
    );

    expect(decision).toEqual({ action: "deliver", agentId: "hippo" });
    expect(db.threads.get("t-100")?.ownerAgent).toBe("hippo");
  });

  it("uses a neutral transport owner hint for an existing unowned non-Slack thread", () => {
    const hippo = makeAgent({ id: "hippo", name: "Pixel Lime Hippo", stableId: "stable-hippo" });
    const cobra = makeAgent({ id: "cobra", name: "Aurora Pearl Cobra", stableId: "stable-cobra" });
    db.agents = [hippo, cobra];
    db.threads.set(
      "chat:alice",
      makeThread({
        threadId: "chat:alice",
        source: "imessage",
        channel: "chat:alice",
        ownerAgent: null,
      }),
    );

    const decision = router.route(
      makeMessage({
        source: "imessage",
        threadId: "chat:alice",
        channel: "chat:alice",
        userId: "+15551234567",
        text: "please keep this with the current owner",
        timestamp: "msg-2",
        metadata: {
          threadOwnerHint: { stableId: "stable-hippo", agentName: "Pixel Lime Hippo" },
        },
      }),
    );

    expect(decision).toEqual({ action: "deliver", agentId: "hippo" });
    expect(db.threads.get("chat:alice")?.ownerAgent).toBe("hippo");
  });

  it("does not leak a known-thread reply to a channel assignment when ownership is missing", () => {
    const hippo = makeAgent({ id: "hippo", name: "Pixel Lime Hippo" });
    const cobra = makeAgent({ id: "cobra", name: "Aurora Pearl Cobra" });
    db.agents = [hippo, cobra];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: null, channel: "C001" }));
    db.channelAssignments.set("C001", { channel: "C001", agentId: "cobra" });

    const decision = router.route(
      makeMessage({
        threadId: "t-100",
        channel: "C001",
        text: "also check for hardcoded routes pls",
      }),
    );

    expect(decision).toEqual({ action: "unrouted" });
    expect(db.threads.get("t-100")?.ownerAgent).toBeNull();
  });

  it("routes to channel assignment and claims new Slack threads for later follow-up", () => {
    const agent = makeAgent({ id: "a2", name: "ChannelBot" });
    db.agents = [agent];
    db.channelAssignments.set("C001", { channel: "C001", agentId: "a2" });

    const decision = router.route(makeMessage({ channel: "C001" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a2" });
    expect(db.threads.get("t-100")).toMatchObject({
      source: "slack",
      channel: "C001",
      ownerAgent: "a2",
    });

    const followUp = router.route(
      makeMessage({
        threadId: "t-100",
        channel: "C001",
        text: "generic follow-up without another assignment cue",
      }),
    );

    expect(followUp).toEqual({ action: "deliver", agentId: "a2" });
  });

  it("routes by agent name mention when no thread owner or channel assignment", () => {
    const agent = makeAgent({ id: "a1", name: "CodeBot" });
    db.agents = [agent];

    const decision = router.route(makeMessage({ text: "hey CodeBot, review this" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a1" });
    expect(db.threads.get("t-100")?.ownerAgent).toBe("a1");
  });

  it("routes by agent name mention in an existing unclaimed thread", () => {
    const agent = makeAgent({ id: "a1", name: "CodeBot" });
    db.agents = [agent];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: null }));

    const decision = router.route(makeMessage({ text: "hey CodeBot, review this" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a1" });
    expect(db.threads.get("t-100")?.ownerAgent).toBe("a1");
  });

  it("returns unrouted when no match", () => {
    db.agents = [makeAgent({ id: "a1", name: "Bot1" })];

    const decision = router.route(makeMessage({ text: "generic message" }));

    expect(decision).toEqual({ action: "unrouted" });
  });

  it("rejects when user is not in allowlist", () => {
    db.allowedUsers = new Set(["U999"]);
    db.agents = [makeAgent({ id: "a1", name: "Bot1" })];

    const decision = router.route(makeMessage({ userId: "U001" }));

    expect(decision).toEqual({ action: "reject", reason: "User not in allowlist" });
  });

  it("rejects all users by default when the allowlist is empty", () => {
    db.allowedUsers = new Set();
    db.agents = [makeAgent({ id: "a1", name: "Bot1" })];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    const decision = router.route(makeMessage({ userId: "U001" }));

    expect(decision).toEqual({ action: "reject", reason: "User not in allowlist" });
  });

  it("allows all users only when allowlist is explicitly null", () => {
    db.allowedUsers = null;
    db.agents = [makeAgent({ id: "a1", name: "Bot1" })];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    const decision = router.route(makeMessage({ userId: "U001" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a1" });
  });

  it("thread ownership takes priority over channel assignment", () => {
    const agent1 = makeAgent({ id: "a1", name: "ThreadOwner" });
    const agent2 = makeAgent({ id: "a2", name: "ChannelBot" });
    db.agents = [agent1, agent2];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1", channel: "C001" }));
    db.channelAssignments.set("C001", { channel: "C001", agentId: "a2" });

    const decision = router.route(makeMessage({ threadId: "t-100", channel: "C001" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a1" });
  });

  it("channel assignment takes priority over agent mention", () => {
    const agent1 = makeAgent({ id: "a1", name: "ChannelBot" });
    const agent2 = makeAgent({ id: "a2", name: "MentionBot" });
    db.agents = [agent1, agent2];
    db.channelAssignments.set("C001", { channel: "C001", agentId: "a1" });

    const decision = router.route(makeMessage({ channel: "C001", text: "hey MentionBot, help" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a1" });
  });

  it("preserves explicit stand-down routing without transferring thread ownership", () => {
    const hippo = makeAgent({ id: "hippo", name: "Pixel Lime Hippo", stableId: "stable-hippo" });
    const cobra = makeAgent({ id: "cobra", name: "Aurora Pearl Cobra", stableId: "stable-cobra" });
    db.agents = [hippo, cobra];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "hippo" }));

    const decision = router.route(makeMessage({ threadId: "t-100", text: "cobra stand down" }));

    expect(decision).toEqual({ action: "deliver", agentId: "cobra" });
    expect(db.threads.get("t-100")?.ownerAgent).toBe("hippo");
  });

  it("preserves explicit reassignment by transferring thread ownership", () => {
    const hippo = makeAgent({ id: "hippo", name: "Pixel Lime Hippo", stableId: "stable-hippo" });
    const cobra = makeAgent({ id: "cobra", name: "Aurora Pearl Cobra", stableId: "stable-cobra" });
    db.agents = [hippo, cobra];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "cobra" }));

    const decision = router.route(
      makeMessage({ threadId: "t-100", text: "Pixel Lime Hippo please take over this thread" }),
    );

    expect(decision).toEqual({ action: "deliver", agentId: "hippo" });
    expect(db.threads.get("t-100")?.ownerAgent).toBe("hippo");
    expect(db.threads.get("t-100")?.ownerBinding).toBe("explicit");
  });

  it("keeps an explicitly retargeted thread on the new owner for later generic follow-ups", () => {
    const hippo = makeAgent({ id: "hippo", name: "Pixel Lime Hippo", stableId: "stable-hippo" });
    const cobra = makeAgent({ id: "cobra", name: "Aurora Pearl Cobra", stableId: "stable-cobra" });
    db.agents = [hippo, cobra];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "cobra" }));

    const retarget = router.route(
      makeMessage({ threadId: "t-100", text: "Pixel Lime Hippo please take over this thread" }),
    );
    expect(retarget).toEqual({ action: "deliver", agentId: "hippo" });

    const genericFollowUp = router.route(
      makeMessage({
        threadId: "t-100",
        text: "also check for hardcoded routes pls",
        metadata: {
          threadOwnerAgentOwner: "owner:stable-cobra",
          threadOwnerAgentName: "Aurora Pearl Cobra",
        },
      }),
    );

    expect(genericFollowUp).toEqual({ action: "deliver", agentId: "hippo" });
    expect(db.threads.get("t-100")).toMatchObject({
      ownerAgent: "hippo",
      ownerBinding: "explicit",
    });
  });

  it("falls back to unrouted when thread owner is gone", () => {
    // Agent a1 owns the thread but is NOT in the agents list (disconnected)
    db.agents = [];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    const decision = router.route(makeMessage({ threadId: "t-100" }));

    // Owner is gone — clears ownership and stops instead of using generic fallback routing.
    expect(decision).toEqual({ action: "unrouted" });
    // Ownership should be cleared
    expect(db.threads.get("t-100")?.ownerAgent).toBeNull();
  });

  it("routes to a disconnected owner only while it is explicitly resumable", () => {
    const agent = makeAgent({
      id: "a1",
      name: "ResumeBot",
      disconnectedAt: "2026-01-01T00:00:00Z",
      resumableUntil: "9999-12-31T23:59:59Z",
    });
    db.agents = [agent];
    db.threads.set("t-resume", makeThread({ threadId: "t-resume", ownerAgent: "a1" }));

    const decision = router.route(makeMessage({ threadId: "t-resume" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a1" });
    expect(db.threads.get("t-resume")?.ownerAgent).toBe("a1");
  });

  it("clears ownership when the owner is disconnected without a resumable window", () => {
    const agent = makeAgent({
      id: "a1",
      name: "OfflineBot",
      disconnectedAt: "2026-01-01T00:00:00Z",
      resumableUntil: null,
    });
    db.agents = [agent];
    db.threads.set("t-offline", makeThread({ threadId: "t-offline", ownerAgent: "a1" }));

    const decision = router.route(makeMessage({ threadId: "t-offline" }));

    expect(decision).toEqual({ action: "unrouted" });
    expect(db.threads.get("t-offline")?.ownerAgent).toBeNull();
  });

  it("falls back to stableId when the UUID owner is not found but a reconnected agent matches", () => {
    // Thread was owned by agent "old-uuid" which no longer exists.
    // A new agent "new-uuid" has reconnected with the same stableId.
    db.threads.set("t-stable", makeThread({ threadId: "t-stable", ownerAgent: "old-uuid" }));
    db.agents = [makeAgent({ id: "new-uuid", name: "ReconnectedBot", stableId: "old-uuid" })];

    const decision = router.route(makeMessage({ threadId: "t-stable" }));

    // Should deliver to the reconnected agent and re-bind the thread.
    expect(decision).toEqual({ action: "deliver", agentId: "new-uuid" });
    expect(db.threads.get("t-stable")?.ownerAgent).toBe("new-uuid");
  });

  it("does not stableId-match when the reconnected agent is disconnected and not resumable", () => {
    db.threads.set("t-stable2", makeThread({ threadId: "t-stable2", ownerAgent: "old-uuid" }));
    db.agents = [
      makeAgent({
        id: "new-uuid",
        name: "OfflineBot",
        stableId: "old-uuid",
        disconnectedAt: "2026-01-01T00:00:00Z",
        resumableUntil: null,
      }),
    ];

    const decision = router.route(makeMessage({ threadId: "t-stable2" }));

    // Agent is disconnected without resumable window — should clear and fall through.
    expect(decision).toEqual({ action: "unrouted" });
    expect(db.threads.get("t-stable2")?.ownerAgent).toBeNull();
  });
});

describe("MessageRouter — claimThread", () => {
  let db: StubBrokerDBInterface;
  let router: MessageRouter;

  beforeEach(() => {
    db = new StubBrokerDBInterface();
    router = new MessageRouter(db);
  });

  it("claims an unclaimed thread (first-responder-wins)", () => {
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: null }));

    const claimed = router.claimThread("t-100", "a1");

    expect(claimed).toBe(true);
    expect(db.threads.get("t-100")?.ownerAgent).toBe("a1");
  });

  it("creates a new thread when claiming a nonexistent thread", () => {
    const claimed = router.claimThread("t-new", "a1");

    expect(claimed).toBe(true);
    const thread = db.threads.get("t-new");
    expect(thread).toBeDefined();
    expect(thread?.ownerAgent).toBe("a1");
  });

  it("stores the provided source when claiming a new thread", () => {
    const claimed = router.claimThread("t-imessage", "a1", "chat:alice", "imessage");

    expect(claimed).toBe(true);
    const thread = db.threads.get("t-imessage");
    expect(thread).toBeDefined();
    expect(thread?.ownerAgent).toBe("a1");
    expect(thread?.source).toBe("imessage");
    expect(thread?.channel).toBe("chat:alice");
  });

  it("allows re-claiming by the same agent", () => {
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    const claimed = router.claimThread("t-100", "a1");

    expect(claimed).toBe(true);
  });

  it("rejects claim when another agent already owns the thread", () => {
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    const claimed = router.claimThread("t-100", "a2");

    expect(claimed).toBe(false);
    expect(db.threads.get("t-100")?.ownerAgent).toBe("a1");
  });
});

describe("MessageRouter — getThreadOwner", () => {
  let db: StubBrokerDBInterface;
  let router: MessageRouter;

  beforeEach(() => {
    db = new StubBrokerDBInterface();
    router = new MessageRouter(db);
  });

  it("returns owner agent id", () => {
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    expect(router.getThreadOwner("t-100")).toBe("a1");
  });

  it("returns null for unclaimed thread", () => {
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: null }));

    expect(router.getThreadOwner("t-100")).toBeNull();
  });

  it("returns null for nonexistent thread", () => {
    expect(router.getThreadOwner("t-unknown")).toBeNull();
  });
});

describe("MessageRouter — claimThread with upsert", () => {
  let db: StubBrokerDBInterface;
  let router: MessageRouter;

  beforeEach(() => {
    db = new StubBrokerDBInterface();
    router = new MessageRouter(db);
  });

  it("updateThread upserts a non-existent thread", () => {
    db.updateThread("t-new", { ownerAgent: "a1" });

    const thread = db.threads.get("t-new");
    expect(thread).toBeDefined();
    expect(thread?.ownerAgent).toBe("a1");
    expect(thread?.source).toBe("slack");
  });

  it("updateThread upsert preserves provided channel", () => {
    db.updateThread("t-new", { ownerAgent: "a1", channel: "C999" });

    const thread = db.threads.get("t-new");
    expect(thread?.channel).toBe("C999");
  });

  it("claimThread works via updateThread upsert path", () => {
    // Thread doesn't exist — claimThread creates it
    const claimed = router.claimThread("t-fresh", "a1");
    expect(claimed).toBe(true);
    expect(db.threads.get("t-fresh")?.ownerAgent).toBe("a1");
  });
});

describe("MessageRouter — getAvailableAgents", () => {
  let db: StubBrokerDBInterface;
  let router: MessageRouter;

  beforeEach(() => {
    db = new StubBrokerDBInterface();
    router = new MessageRouter(db);
  });

  it("returns connected agents", () => {
    db.agents = [makeAgent({ id: "a1", name: "Bot1" }), makeAgent({ id: "a2", name: "Bot2" })];

    const agents = router.getAvailableAgents();

    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  it("returns empty array when no agents", () => {
    db.agents = [];

    expect(router.getAvailableAgents()).toEqual([]);
  });
});

describe("MessageRouter — multi-agent scenarios", () => {
  let db: StubBrokerDBInterface;
  let router: MessageRouter;

  beforeEach(() => {
    db = new StubBrokerDBInterface();
    router = new MessageRouter(db);
    db.agents = [
      makeAgent({ id: "a1", name: "CodeBot" }),
      makeAgent({ id: "a2", name: "ReviewBot" }),
      makeAgent({ id: "a3", name: "DeployBot" }),
    ];
  });

  it("routes different threads to different owners", () => {
    db.threads.set("t-1", makeThread({ threadId: "t-1", ownerAgent: "a1" }));
    db.threads.set("t-2", makeThread({ threadId: "t-2", ownerAgent: "a2" }));
    db.threads.set("t-3", makeThread({ threadId: "t-3", ownerAgent: "a3" }));

    expect(router.route(makeMessage({ threadId: "t-1" }))).toEqual({
      action: "deliver",
      agentId: "a1",
    });
    expect(router.route(makeMessage({ threadId: "t-2" }))).toEqual({
      action: "deliver",
      agentId: "a2",
    });
    expect(router.route(makeMessage({ threadId: "t-3" }))).toEqual({
      action: "deliver",
      agentId: "a3",
    });
  });

  it("first agent to claim wins, second is rejected", () => {
    db.threads.set("t-race", makeThread({ threadId: "t-race", ownerAgent: null }));

    expect(router.claimThread("t-race", "a1")).toBe(true);
    expect(router.claimThread("t-race", "a2")).toBe(false);
    expect(router.getThreadOwner("t-race")).toBe("a1");
  });

  it("mentions route to the correct agent among many", () => {
    const d1 = router.route(
      makeMessage({ threadId: "t-review", text: "hey ReviewBot, check this" }),
    );
    expect(d1).toEqual({ action: "deliver", agentId: "a2" });

    const d2 = router.route(
      makeMessage({ threadId: "t-deploy", text: "DeployBot deploy to staging" }),
    );
    expect(d2).toEqual({ action: "deliver", agentId: "a3" });
  });

  it("route after agent disconnect — clears ownership and re-routes", () => {
    // a2 owns the thread but is disconnected
    db.threads.set("t-owned", makeThread({ threadId: "t-owned", ownerAgent: "a2" }));
    db.agents = db.agents.filter((a) => a.id !== "a2");

    const decision = router.route(makeMessage({ threadId: "t-owned" }));

    // Owner gone — ownership cleared, falls through to agent mention or unrouted
    expect(db.threads.get("t-owned")?.ownerAgent).toBeNull();
    // a1 is still connected but not mentioned — unrouted
    expect(decision).toEqual({ action: "unrouted" });
  });

  it("allowlist rejection happens before any routing", () => {
    db.allowedUsers = new Set(["U999"]);
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    const decision = router.route(makeMessage({ threadId: "t-100", userId: "U001" }));

    expect(decision).toEqual({ action: "reject", reason: "User not in allowlist" });
  });
});
