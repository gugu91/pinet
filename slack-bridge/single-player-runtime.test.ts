import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackSocketModeClientConfig } from "./slack-access.js";
import {
  createSinglePlayerRuntime,
  type SinglePlayerPendingAttention,
  type SinglePlayerRuntimeDeps,
  type SinglePlayerThreadState,
} from "./single-player-runtime.js";

const socketState = vi.hoisted(() => ({
  config: null as unknown,
  connected: false,
  botUserId: "U_BOT",
}));

vi.mock("./slack-access.js", async () => {
  const actual = await vi.importActual("./slack-access.js");

  class FakeSlackSocketModeClient {
    private readonly config: SlackSocketModeClientConfig;

    constructor(config: SlackSocketModeClientConfig) {
      this.config = config;
      socketState.config = config;
    }

    getBotUserId(): string | null {
      return socketState.botUserId;
    }

    isConnected(): boolean {
      return socketState.connected;
    }

    async connect(): Promise<void> {
      socketState.connected = true;
    }

    async disconnect(): Promise<void> {
      socketState.connected = false;
      await this.config.abortAndWait?.();
    }
  }

  return {
    ...(actual as object),
    SlackSocketModeClient: FakeSlackSocketModeClient,
  };
});

type TestState = {
  threads: Map<string, SinglePlayerThreadState>;
  pendingEyes: Map<string, SinglePlayerPendingAttention[]>;
  unclaimedThreads: Set<string>;
  inbox: Array<{
    text: string;
    channel: string;
    threadTs: string;
    metadata?: Record<string, unknown>;
  }>;
  lastDmChannel: string | null;
};

function createContext(notify = vi.fn()): ExtensionContext {
  return {
    hasUI: true,
    ui: {
      notify,
      setStatus: vi.fn(),
      theme: {
        fg: (_color: string, text: string) => text,
      },
    },
  } as unknown as ExtensionContext;
}

function createDeps(state: TestState, overrides: Partial<SinglePlayerRuntimeDeps> = {}) {
  const pushInboxMessage = vi.fn(
    (message: {
      text: string;
      channel: string;
      threadTs: string;
      metadata?: Record<string, unknown>;
    }) => {
      state.inbox.push(message);
    },
  );
  const persistState = vi.fn();
  const updateBadge = vi.fn();
  const maybeDrainInboxIfIdle = vi.fn(() => true);
  const claimOwnedThread = vi.fn();
  const addReaction = vi.fn(async () => undefined);
  const removeReaction = vi.fn(async () => undefined);
  const resolveUser = vi.fn(async () => "Sender");
  const slack = vi.fn(async (method: string) =>
    method === "conversations.replies" ? { ok: true, messages: [] } : { ok: true },
  );
  const resolveThreadChannel = vi.fn(async (threadTs: string | undefined) =>
    threadTs ? `channel-for-${threadTs}` : null,
  );
  const setSuggestedPrompts = vi.fn(async () => undefined);
  const publishCurrentPinetHomeTab = vi.fn(async () => undefined);
  const fetchSlackMessageByTs = vi.fn(async () => null);
  const consumeConfirmationReply = vi.fn(() => null);
  const deps = {
    slack,
    getBotToken: () => "xoxb-test",
    getAppToken: () => "xapp-test",
    dedup: new Set<string>(),
    abortSlackRequests: vi.fn(async () => undefined),
    isSingleRuntimeActive: () => true,
    setExtStatus: vi.fn(),
    formatError: (error: unknown) => String(error),
    getAgentName: () => "Cobalt Olive Crane",
    getAgentAliases: () => ["Cobalt Olive Crane"],
    getAgentOwnerToken: () => "owner:crane",
    getBotUserId: () => socketState.botUserId,
    getThreads: () => state.threads,
    getPendingEyes: () => state.pendingEyes,
    getUnclaimedThreads: () => state.unclaimedThreads,
    pushInboxMessage,
    setLastDmChannel: (channelId) => {
      state.lastDmChannel = channelId;
    },
    persistState,
    updateBadge,
    maybeDrainInboxIfIdle,
    resolveThreadChannel,
    setSuggestedPrompts,
    publishCurrentPinetHomeTab,
    fetchSlackMessageByTs,
    addReaction,
    removeReaction,
    resolveUser,
    isUserAllowed: () => true,
    getReactionCommand: () => undefined,
    consumeConfirmationReply,
    claimOwnedThread,
    ...overrides,
  } as SinglePlayerRuntimeDeps;

  return {
    deps,
    spies: {
      pushInboxMessage,
      persistState,
      updateBadge,
      maybeDrainInboxIfIdle,
      claimOwnedThread,
      addReaction,
      removeReaction,
      resolveUser,
      slack,
      resolveThreadChannel,
      setSuggestedPrompts,
      publishCurrentPinetHomeTab,
      fetchSlackMessageByTs,
      consumeConfirmationReply,
    },
  };
}

describe("single-player-runtime", () => {
  beforeEach(() => {
    socketState.config = null;
    socketState.connected = false;
    socketState.botUserId = "U_BOT";
  });

  it("owns the slack tool thread-context port for local thread tracking", async () => {
    const state: TestState = {
      threads: new Map([
        [
          "123.456",
          { channelId: "C123", threadTs: "123.456", userId: "U_SENDER", source: undefined },
        ],
      ]),
      pendingEyes: new Map([
        [
          "123.456",
          [
            { channel: "C123", messageTs: "111.1" },
            { channel: "C123", messageTs: "111.2" },
          ],
        ],
      ]),
      unclaimedThreads: new Set(["123.456"]),
      inbox: [],
      lastDmChannel: null,
    };
    const { deps, spies } = createDeps(state);
    const runtime = createSinglePlayerRuntime(deps);

    const threadContext = runtime.getThreadContextPort();
    await expect(threadContext.resolveThreadChannel("123.456")).resolves.toBe(
      "channel-for-123.456",
    );

    threadContext.noteThreadReply("123.456", "C123");

    expect(state.threads.get("123.456")).toMatchObject({
      channelId: "C123",
      threadTs: "123.456",
      owner: "owner:crane",
      source: "slack",
    });
    expect(state.unclaimedThreads.has("123.456")).toBe(false);
    expect(spies.persistState).toHaveBeenCalledTimes(1);
    expect(spies.claimOwnedThread).toHaveBeenCalledWith("123.456", "C123", "slack");

    threadContext.clearPendingAttention("123.456");
    await Promise.resolve();

    expect(spies.removeReaction).toHaveBeenNthCalledWith(1, "C123", "111.1", "eyes");
    expect(spies.removeReaction).toHaveBeenNthCalledWith(2, "C123", "111.2", "eyes");
    expect(state.pendingEyes.has("123.456")).toBe(false);
  });

  it("tracks non-slack outbound threads without invoking remote claims", () => {
    const state: TestState = {
      threads: new Map(),
      pendingEyes: new Map(),
      unclaimedThreads: new Set(["chat:alice"]),
      inbox: [],
      lastDmChannel: null,
    };
    const { deps, spies } = createDeps(state);
    const runtime = createSinglePlayerRuntime(deps);

    runtime.trackOwnedThread("chat:alice", "chat:alice", "imessage");

    expect(state.threads.get("chat:alice")).toMatchObject({
      channelId: "chat:alice",
      threadTs: "chat:alice",
      userId: "",
      owner: "owner:crane",
      source: "imessage",
    });
    expect(state.unclaimedThreads.has("chat:alice")).toBe(false);
    expect(spies.persistState).toHaveBeenCalledTimes(1);
    expect(spies.claimOwnedThread).not.toHaveBeenCalled();
  });

  it("handles direct Slack messages inside the runtime and queues inbox work", async () => {
    const state: TestState = {
      threads: new Map(),
      pendingEyes: new Map(),
      unclaimedThreads: new Set(),
      inbox: [],
      lastDmChannel: null,
    };
    const notify = vi.fn();
    const ctx = createContext(notify);
    const { deps, spies } = createDeps(state);
    const runtime = createSinglePlayerRuntime(deps);

    await runtime.connect(ctx);

    const socketConfig = socketState.config as SlackSocketModeClientConfig | null;
    expect(socketConfig?.onMessage).toBeDefined();

    await socketConfig?.onMessage?.({
      type: "message",
      channel: "D123",
      channel_type: "im",
      user: "U_SENDER",
      text: "hello from Slack",
      ts: "100.1",
    });

    expect(state.threads.get("100.1")).toMatchObject({
      channelId: "D123",
      threadTs: "100.1",
      userId: "U_SENDER",
      source: "slack",
    });
    expect(state.lastDmChannel).toBe("D123");
    expect(spies.slack).toHaveBeenCalledWith(
      "conversations.replies",
      "xoxb-test",
      expect.objectContaining({ channel: "D123", ts: "100.1", include_all_metadata: true }),
    );
    expect(spies.persistState).toHaveBeenCalledTimes(1);
    expect(spies.resolveUser).toHaveBeenCalledWith("U_SENDER");
    expect(spies.addReaction).toHaveBeenCalledWith("D123", "100.1", "eyes");
    expect(state.pendingEyes.get("100.1")).toEqual([{ channel: "D123", messageTs: "100.1" }]);
    expect(spies.pushInboxMessage).toHaveBeenCalledWith({
      channel: "D123",
      threadTs: "100.1",
      userId: "U_SENDER",
      text: "hello from Slack",
      timestamp: "100.1",
      scope: {
        workspace: {
          provider: "slack",
          source: "compatibility",
          compatibilityKey: "default",
          channelId: "D123",
        },
        instance: {
          source: "compatibility",
          compatibilityKey: "default",
        },
      },
    });
    expect(spies.updateBadge).toHaveBeenCalledTimes(1);
    expect(spies.maybeDrainInboxIfIdle).toHaveBeenCalledWith(ctx);
  });

  it("ignores opt-in reactions in uninvoked single-player Slack threads", async () => {
    const state: TestState = {
      threads: new Map(),
      pendingEyes: new Map(),
      unclaimedThreads: new Set(),
      inbox: [],
      lastDmChannel: null,
    };
    const ctx = createContext();
    const { deps, spies } = createDeps(state, {
      getReactionCommand: (reactionName) =>
        reactionName === "white_check_mark" ? { action: "approve", prompt: "Approve." } : undefined,
      fetchSlackMessageByTs: vi.fn(async () => ({
        ts: "100.1",
        thread_ts: "100.0",
        text: "normal Slack thread",
        user: "U_TARGET",
      })),
    });
    const runtime = createSinglePlayerRuntime(deps);

    await runtime.connect(ctx);

    const socketConfig = socketState.config as SlackSocketModeClientConfig | null;
    await socketConfig?.onReactionAdded?.({
      type: "reaction_added",
      user: "U_REACTOR",
      reaction: "white_check_mark",
      item: { type: "message", channel: "C123", ts: "100.1" },
      event_ts: "999.1",
    });

    expect(spies.pushInboxMessage).not.toHaveBeenCalled();
    expect(spies.addReaction).not.toHaveBeenCalled();
    expect(spies.persistState).not.toHaveBeenCalled();
    expect(state.threads.size).toBe(0);
    expect(state.inbox).toHaveLength(0);
  });

  it("interrupts busy single-player turns from octagonal-sign reactions", async () => {
    const state: TestState = {
      threads: new Map(),
      pendingEyes: new Map(),
      unclaimedThreads: new Set(),
      inbox: [],
      lastDmChannel: null,
    };
    const abort = vi.fn();
    const notify = vi.fn();
    const ctx = {
      ...createContext(notify),
      isIdle: () => false,
      abort,
    } as unknown as ExtensionContext;
    const { deps, spies } = createDeps(state, {
      getReactionCommand: (reactionName) =>
        reactionName === "octagonal_sign"
          ? { action: "interrupt", prompt: "Interrupt now." }
          : undefined,
      fetchSlackMessageByTs: vi.fn(async () => ({
        ts: "100.1",
        text: "busy work",
        user: "U_TARGET",
      })),
      resolveUser: vi.fn(async () => "Alice"),
    });
    state.threads.set("100.1", {
      channelId: "C123",
      threadTs: "100.1",
      userId: "U_TARGET",
      source: "slack",
    });
    const runtime = createSinglePlayerRuntime(deps);

    await runtime.connect(ctx);

    const socketConfig = socketState.config as SlackSocketModeClientConfig | null;
    await socketConfig?.onReactionAdded?.({
      type: "reaction_added",
      user: "U_REACTOR",
      reaction: "octagonal_sign",
      item: { type: "message", channel: "C123", ts: "100.1" },
      event_ts: "999.1",
    });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(state.inbox).toHaveLength(0);
    expect(spies.addReaction).toHaveBeenCalledWith("C123", "100.1", "white_check_mark");
    expect(notify).toHaveBeenCalledWith(
      "Alice requested an interrupt with :octagonal_sign:",
      "warning",
    );
  });

  it("preserves file-share metadata on inbound Slack messages", async () => {
    const state: TestState = {
      threads: new Map(),
      pendingEyes: new Map(),
      unclaimedThreads: new Set(),
      inbox: [],
      lastDmChannel: null,
    };
    const ctx = createContext();
    const { deps, spies } = createDeps(state);
    const runtime = createSinglePlayerRuntime(deps);

    await runtime.connect(ctx);

    const socketConfig = socketState.config as SlackSocketModeClientConfig | null;
    await socketConfig?.onMessage?.({
      type: "message",
      subtype: "file_share",
      channel: "D123",
      channel_type: "im",
      user: "U_SENDER",
      text: "",
      ts: "100.1",
      files: [
        {
          id: "F123",
          title: "Incident notes",
          filetype: "markdown",
          mode: "snippet",
          permalink: "https://files.example/incident.md",
          url_private_download: "https://files.example/download/F123",
        },
      ],
    });

    expect(spies.pushInboxMessage).toHaveBeenCalledWith({
      channel: "D123",
      threadTs: "100.1",
      userId: "U_SENDER",
      text: [
        "(Slack message had no plain-text body)",
        "",
        "Slack message context:",
        "- Incident notes — markdown — snippet — id=F123 — https://files.example/incident.md",
      ].join("\n"),
      timestamp: "100.1",
      metadata: {
        slackSubtype: "file_share",
        slackFiles: [
          {
            id: "F123",
            title: "Incident notes",
            filetype: "markdown",
            permalink: "https://files.example/incident.md",
            mode: "snippet",
          },
        ],
      },
      scope: {
        workspace: {
          provider: "slack",
          source: "compatibility",
          compatibilityKey: "default",
          channelId: "D123",
        },
        instance: {
          source: "compatibility",
          compatibilityKey: "default",
        },
      },
    });
  });
});
