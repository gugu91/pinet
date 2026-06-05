import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseSocketFrame,
  extractThreadStarted,
  extractAppHomeOpened,
  classifyMessage,
  parseMemberJoinedChannel,
  SlackAdapter,
  RECONNECT_DELAY_MS,
  SLACK_PENDING_ATTENTION_MAX_MESSAGES_PER_THREAD,
  SLACK_THREAD_CACHE_MAX_SIZE,
} from "./slack.js";
import { SlackSocketModeClient, type SlackThreadContext } from "../../slack-access.js";
import type { OutboundMessage } from "./types.js";

async function waitForAssertion(assertion: () => void, attempts = 50): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ─── parseSocketFrame ────────────────────────────────────

describe("parseSocketFrame", () => {
  it("returns null for malformed JSON", () => {
    expect(parseSocketFrame("not json{{{")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSocketFrame("")).toBeNull();
  });

  it("parses a hello frame", () => {
    const frame = JSON.stringify({ type: "hello" });
    const result = parseSocketFrame(frame);
    expect(result).toEqual({ type: "hello" });
  });

  it("parses a disconnect frame", () => {
    const frame = JSON.stringify({ type: "disconnect", reason: "refresh" });
    const result = parseSocketFrame(frame);
    expect(result).toEqual({ type: "disconnect" });
  });

  it("extracts envelope_id", () => {
    const frame = JSON.stringify({
      envelope_id: "abc-123",
      type: "events_api",
      payload: {
        event: { type: "message", text: "hello" },
      },
    });
    const result = parseSocketFrame(frame);
    expect(result?.envelopeId).toBe("abc-123");
  });

  it("extracts event from events_api type", () => {
    const frame = JSON.stringify({
      type: "events_api",
      payload: {
        event: { type: "message", text: "hello", user: "U123" },
      },
    });
    const result = parseSocketFrame(frame);
    expect(result?.event).toEqual({
      type: "message",
      text: "hello",
      user: "U123",
    });
  });

  it("does not extract event from non-events_api types", () => {
    const frame = JSON.stringify({
      type: "hello",
      payload: { event: { type: "message" } },
    });
    const result = parseSocketFrame(frame);
    expect(result?.event).toBeUndefined();
  });

  it("handles missing payload in events_api", () => {
    const frame = JSON.stringify({ type: "events_api" });
    const result = parseSocketFrame(frame);
    expect(result?.event).toBeUndefined();
  });

  it("extracts interactive block_actions payloads", () => {
    const frame = JSON.stringify({
      envelope_id: "env-1",
      type: "interactive",
      payload: {
        type: "block_actions",
        actions: [{ action_id: "review.approve" }],
      },
    });
    const result = parseSocketFrame(frame);
    expect(result?.interactivePayload).toEqual({
      type: "block_actions",
      actions: [{ action_id: "review.approve" }],
    });
  });

  it("extracts Slack slash command payloads", () => {
    const frame = JSON.stringify({
      envelope_id: "env-1",
      type: "slash_commands",
      payload: {
        command: "/pinet",
        text: "agents list all",
        channel_id: "C123",
        user_id: "U123",
        response_url: "https://hooks.slack.com/commands/T/1/x",
        trigger_id: "trigger-1",
        team_id: "T123",
      },
    });

    expect(parseSocketFrame(frame)?.slashCommand).toEqual({
      command: "/pinet",
      text: "agents list all",
      channelId: "C123",
      userId: "U123",
      responseUrl: "https://hooks.slack.com/commands/T/1/x",
      triggerId: "trigger-1",
      teamId: "T123",
    });
  });
});

// ─── extractThreadStarted ────────────────────────────────

describe("extractThreadStarted", () => {
  it("returns null when assistant_thread is missing", () => {
    expect(extractThreadStarted({})).toBeNull();
  });

  it("extracts basic thread info", () => {
    const evt = {
      type: "assistant_thread_started",
      assistant_thread: {
        channel_id: "D123",
        thread_ts: "111.222",
        user_id: "U456",
      },
    };
    const result = extractThreadStarted(evt);
    expect(result).toEqual({
      channelId: "D123",
      threadTs: "111.222",
      userId: "U456",
    });
  });

  it("extracts context when present", () => {
    const evt = {
      type: "assistant_thread_started",
      assistant_thread: {
        channel_id: "D123",
        thread_ts: "111.222",
        user_id: "U456",
        context: {
          channel_id: "C789",
          team_id: "T001",
        },
      },
    };
    const result = extractThreadStarted(evt);
    expect(result?.context).toEqual({
      channelId: "C789",
      teamId: "T001",
      scope: {
        workspace: {
          provider: "slack",
          source: "compatibility",
          compatibilityKey: "default",
          workspaceId: "T001",
          channelId: "C789",
        },
        instance: {
          source: "compatibility",
          compatibilityKey: "default",
        },
      },
    });
  });

  it("keeps teamId unknown when Slack does not provide one", () => {
    const evt = {
      type: "assistant_thread_started",
      assistant_thread: {
        channel_id: "D123",
        thread_ts: "111.222",
        user_id: "U456",
        context: { channel_id: "C789" },
      },
    };
    const result = extractThreadStarted(evt);
    expect(result?.context).toEqual({
      channelId: "C789",
      scope: {
        workspace: {
          provider: "slack",
          source: "compatibility",
          compatibilityKey: "default",
          channelId: "C789",
        },
        instance: {
          source: "compatibility",
          compatibilityKey: "default",
        },
      },
    });
  });

  it("omits context when context has no channel_id", () => {
    const evt = {
      type: "assistant_thread_started",
      assistant_thread: {
        channel_id: "D123",
        thread_ts: "111.222",
        user_id: "U456",
        context: { team_id: "T001" },
      },
    };
    const result = extractThreadStarted(evt);
    expect(result?.context).toBeUndefined();
  });
});

describe("extractAppHomeOpened", () => {
  it("extracts the user, tab, and event timestamp", () => {
    expect(
      extractAppHomeOpened({
        type: "app_home_opened",
        user: "U123",
        tab: "home",
        event_ts: "123.456",
      }),
    ).toEqual({
      userId: "U123",
      tab: "home",
      eventTs: "123.456",
    });
  });

  it("defaults the tab to home and rejects missing users", () => {
    expect(extractAppHomeOpened({ user: "U123" })).toEqual({
      userId: "U123",
      tab: "home",
      eventTs: null,
    });
    expect(extractAppHomeOpened({ tab: "home" })).toBeNull();
  });
});

// ─── classifyMessage ─────────────────────────────────────

describe("classifyMessage", () => {
  const botId = "U_BOT";
  const emptyTracked = new Set<string>();

  it("rejects unrelated message subtypes", () => {
    const evt = {
      type: "message",
      subtype: "channel_join",
      user: "U1",
      text: "joined",
      channel: "C1",
      ts: "1.1",
    };
    expect(classifyMessage(evt, botId, emptyTracked)).toEqual({
      relevant: false,
    });
  });

  it("accepts file_share subtype messages and preserves fetchable file metadata", () => {
    const evt = {
      type: "message",
      subtype: "file_share",
      user: "U1",
      text: "",
      channel: "D1",
      channel_type: "im",
      ts: "1.1",
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
    };

    const result = classifyMessage(evt, botId, emptyTracked);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.text).toContain("Incident notes — markdown — snippet — id=F123");
      expect(result.metadata).toEqual({
        slackSubtype: "file_share",
        slackFiles: [
          {
            id: "F123",
            title: "Incident notes",
            filetype: "markdown",
            permalink: "https://files.example/incident.md",
            urlPrivate: "https://files.example/download/F123",
            mode: "snippet",
          },
        ],
      });
    }
  });

  it("rejects messages from bots", () => {
    const evt = {
      type: "message",
      bot_id: "B123",
      user: "U1",
      text: "hello",
      channel: "C1",
      ts: "1.1",
    };
    expect(classifyMessage(evt, botId, emptyTracked)).toEqual({
      relevant: false,
    });
  });

  it("rejects untracked channel messages without mention", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "hello",
      channel: "C1",
      channel_type: "channel",
      ts: "1.1",
    };
    expect(classifyMessage(evt, botId, emptyTracked)).toEqual({
      relevant: false,
    });
  });

  it("accepts DM messages", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "hello",
      channel: "D1",
      channel_type: "im",
      ts: "1.1",
    };
    const result = classifyMessage(evt, botId, emptyTracked);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.isDM).toBe(true);
      expect(result.isChannelMention).toBe(false);
      expect(result.text).toBe("hello");
      expect(result.threadTs).toBe("1.1");
      expect(result.userId).toBe("U1");
    }
  });

  it("accepts messages in tracked threads", () => {
    const tracked = new Set(["100.200"]);
    const evt = {
      type: "message",
      user: "U1",
      text: "follow up",
      channel: "C1",
      channel_type: "channel",
      thread_ts: "100.200",
      ts: "100.300",
    };
    const result = classifyMessage(evt, botId, tracked);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.threadTs).toBe("100.200");
      expect(result.isChannelMention).toBe(false);
    }
  });

  it("accepts channel mentions and strips bot mention", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "<@U_BOT> check this out",
      channel: "C1",
      channel_type: "channel",
      ts: "1.1",
    };
    const result = classifyMessage(evt, botId, emptyTracked);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.isChannelMention).toBe(true);
      expect(result.text).toBe("check this out");
      expect(result.isDM).toBe(false);
    }
  });

  it("preserves extra visible message context for canvas-style mentions", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "<@U_BOT> Alice mentioned you in a comment",
      channel: "C1",
      channel_type: "channel",
      ts: "1.1",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_quote",
              elements: [{ type: "text", text: "Can you update the rollout checklist?" }],
            },
          ],
        },
        {
          type: "context",
          elements: [{ type: "plain_text", text: "Canvas: Launch plan > Rollout" }],
        },
      ],
    };
    const result = classifyMessage(evt, botId, emptyTracked);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.isChannelMention).toBe(true);
      expect(result.text).toBe(
        [
          "Alice mentioned you in a comment",
          "",
          "Slack message context:",
          "- Can you update the rollout checklist?",
          "- Canvas: Launch plan > Rollout",
        ].join("\n"),
      );
    }
  });

  it("preserves fetchable canvas file references for normal mention events", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "<@U_BOT> Alice mentioned you in a comment",
      channel: "C1",
      channel_type: "channel",
      ts: "1.1",
      files: [
        {
          id: "F_CANVAS_1",
          title: "Launch plan",
          permalink: "https://example.slack.com/docs/T/F_CANVAS_1",
        },
      ],
    };

    const result = classifyMessage(evt, botId, emptyTracked);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.isChannelMention).toBe(true);
      expect(result.text).toBe(
        [
          "Alice mentioned you in a comment",
          "",
          "Slack message context:",
          "- Launch plan — id=F_CANVAS_1 — https://example.slack.com/docs/T/F_CANVAS_1",
        ].join("\n"),
      );
      expect(result.metadata).toEqual({
        slackFiles: [
          {
            id: "F_CANVAS_1",
            title: "Launch plan",
            permalink: "https://example.slack.com/docs/T/F_CANVAS_1",
          },
        ],
      });
    }
  });

  it("does not strip mention in tracked threads", () => {
    const tracked = new Set(["1.1"]);
    const evt = {
      type: "message",
      user: "U1",
      text: "<@U_BOT> hey again",
      channel: "C1",
      channel_type: "channel",
      thread_ts: "1.1",
      ts: "1.2",
    };
    const result = classifyMessage(evt, botId, tracked);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.isChannelMention).toBe(false);
      expect(result.text).toBe("<@U_BOT> hey again");
    }
  });

  it("does not strip mention in DMs", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "<@U_BOT> hi from DM",
      channel: "D1",
      channel_type: "im",
      ts: "1.1",
    };
    const result = classifyMessage(evt, botId, emptyTracked);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.isChannelMention).toBe(false);
      expect(result.text).toBe("<@U_BOT> hi from DM");
    }
  });

  it("uses ts as threadTs when thread_ts is absent", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "new DM",
      channel: "D1",
      channel_type: "im",
      ts: "999.111",
    };
    const result = classifyMessage(evt, botId, emptyTracked);
    if (result.relevant) {
      expect(result.threadTs).toBe("999.111");
      expect(result.messageTs).toBe("999.111");
    }
  });

  // ─── isKnownThread callback ─────────────────────────────

  it("accepts thread replies in broker-known threads without @mention", () => {
    const isKnownThread = (ts: string) => ts === "500.600";
    const evt = {
      type: "message",
      user: "U1",
      text: "follow up in known thread",
      channel: "C1",
      channel_type: "channel",
      thread_ts: "500.600",
      ts: "500.700",
    };
    const result = classifyMessage(evt, botId, emptyTracked, isKnownThread);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.threadTs).toBe("500.600");
      expect(result.isChannelMention).toBe(false);
      expect(result.text).toBe("follow up in known thread");
      expect(result.isDM).toBe(false);
    }
  });

  it("rejects thread replies in unknown threads without @mention", () => {
    const isKnownThread = () => false;
    const evt = {
      type: "message",
      user: "U1",
      text: "random thread reply",
      channel: "C1",
      channel_type: "channel",
      thread_ts: "600.700",
      ts: "600.800",
    };
    const result = classifyMessage(evt, botId, emptyTracked, isKnownThread);
    expect(result).toEqual({ relevant: false });
  });

  it("does not set isChannelMention for @mention in broker-known thread", () => {
    const isKnownThread = (ts: string) => ts === "700.800";
    const evt = {
      type: "message",
      user: "U1",
      text: "<@U_BOT> check this",
      channel: "C1",
      channel_type: "channel",
      thread_ts: "700.800",
      ts: "700.900",
    };
    const result = classifyMessage(evt, botId, emptyTracked, isKnownThread);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.isChannelMention).toBe(false);
      // Text is NOT stripped since it's not a channel mention
      expect(result.text).toBe("<@U_BOT> check this");
    }
  });

  it("uses the broker-known callback as the source of truth when provided", () => {
    const isKnownThread = vi.fn(() => false);
    const tracked = new Set(["800.900"]);
    const evt = {
      type: "message",
      user: "U1",
      text: "reply in stale locally tracked thread",
      channel: "C1",
      channel_type: "channel",
      thread_ts: "800.900",
      ts: "800.950",
    };
    const result = classifyMessage(evt, botId, tracked, isKnownThread);
    expect(result).toEqual({ relevant: false });
    expect(isKnownThread).toHaveBeenCalledWith("800.900");
  });

  it("does not call isKnownThread for messages without thread_ts", () => {
    const isKnownThread = vi.fn(() => true);
    const evt = {
      type: "message",
      user: "U1",
      text: "top-level channel message",
      channel: "C1",
      channel_type: "channel",
      ts: "900.100",
    };
    const result = classifyMessage(evt, botId, emptyTracked, isKnownThread);
    expect(result).toEqual({ relevant: false });
    expect(isKnownThread).not.toHaveBeenCalled();
  });

  it("works without isKnownThread callback (backward compatible)", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "reply in unknown thread",
      channel: "C1",
      channel_type: "channel",
      thread_ts: "999.111",
      ts: "999.222",
    };
    // No callback passed — same behavior as before
    const result = classifyMessage(evt, botId, emptyTracked);
    expect(result).toEqual({ relevant: false });
  });

  it("handles null botUserId (no mention detection)", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "<@U_BOT> hello",
      channel: "C1",
      channel_type: "channel",
      ts: "1.1",
    };
    // With null botUserId, mention detection is disabled
    expect(classifyMessage(evt, null, emptyTracked)).toEqual({
      relevant: false,
    });
  });
});

// ─── parseMemberJoinedChannel ────────────────────────────

describe("parseMemberJoinedChannel", () => {
  it("returns null when user is missing", () => {
    expect(parseMemberJoinedChannel({ channel: "C1" }, "U_BOT")).toBeNull();
  });

  it("returns null when channel is missing", () => {
    expect(parseMemberJoinedChannel({ user: "U1" }, "U_BOT")).toBeNull();
  });

  it("returns isSelf=true when bot joins", () => {
    const result = parseMemberJoinedChannel({ user: "U_BOT", channel: "C1" }, "U_BOT");
    expect(result).toEqual({ channel: "C1", isSelf: true });
  });

  it("returns isSelf=false when another user joins", () => {
    const result = parseMemberJoinedChannel({ user: "U_OTHER", channel: "C1" }, "U_BOT");
    expect(result).toEqual({ channel: "C1", isSelf: false });
  });

  it("handles null botUserId", () => {
    const result = parseMemberJoinedChannel({ user: "U1", channel: "C1" }, null);
    expect(result).toEqual({ channel: "C1", isSelf: false });
  });
});

// ─── SlackAdapter — construction ─────────────────────────

describe("SlackAdapter", () => {
  const baseConfig = {
    botToken: "xoxb-test-token",
    appToken: "xapp-test-token",
    allowAllWorkspaceUsers: true,
  };

  it("can be constructed with minimal config", () => {
    const adapter = new SlackAdapter(baseConfig);
    expect(adapter.name).toBe("slack");
    expect(adapter.getBotUserId()).toBeNull();
    expect(adapter.getTrackedThreadIds().size).toBe(0);
  });

  it("can be constructed with allowedUsers", () => {
    const adapter = new SlackAdapter({
      ...baseConfig,
      allowedUsers: ["U1", "U2"],
    });
    expect(adapter.name).toBe("slack");
  });

  it("can be constructed with suggestedPrompts", () => {
    const adapter = new SlackAdapter({
      ...baseConfig,
      suggestedPrompts: [{ title: "Hello", message: "Hi there" }],
    });
    expect(adapter.name).toBe("slack");
  });

  it("can be constructed with reactionCommands", () => {
    const adapter = new SlackAdapter({
      ...baseConfig,
      reactionCommands: { "👀": "review" },
    });
    expect(adapter.name).toBe("slack");
  });

  it("can be constructed with isKnownThread callback", () => {
    const adapter = new SlackAdapter({
      ...baseConfig,
      isKnownThread: () => false,
    });
    expect(adapter.name).toBe("slack");
  });

  it("handles authorized slash commands with an ephemeral Slack response", async () => {
    const onSlashCommand = vi.fn(() => "Pinet agents: 1 shown");
    const adapter = new SlackAdapter({
      ...baseConfig,
      onSlashCommand,
    });
    const callSlack = vi
      .spyOn(
        adapter as unknown as {
          callSlack: (
            method: string,
            token: string,
            body?: Record<string, unknown>,
          ) => Promise<Record<string, unknown>>;
        },
        "callSlack",
      )
      .mockResolvedValue({ ok: true });

    await (
      adapter as unknown as {
        onSlashCommand: (event: {
          command: string;
          text: string;
          channelId: string;
          userId: string;
        }) => Promise<void>;
      }
    ).onSlashCommand({
      command: "/pinet",
      text: "agents list",
      channelId: "C123",
      userId: "U123",
    });

    expect(onSlashCommand).toHaveBeenCalledWith({
      command: "/pinet",
      text: "agents list",
      channelId: "C123",
      userId: "U123",
    });
    expect(callSlack).toHaveBeenCalledWith("chat.postEphemeral", "xoxb-test-token", {
      channel: "C123",
      user: "U123",
      text: "Pinet agents: 1 shown",
    });
  });

  it("prefers Slack slash command response_url when present", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", {
        status: 200,
      }),
    );
    const adapter = new SlackAdapter({
      ...baseConfig,
      onSlashCommand: () => "Pinet agents: 1 shown",
    });
    const callSlack = vi.spyOn(
      adapter as unknown as {
        callSlack: (
          method: string,
          token: string,
          body?: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      },
      "callSlack",
    );

    await (
      adapter as unknown as {
        onSlashCommand: (event: {
          command: string;
          text: string;
          channelId: string;
          userId: string;
          responseUrl: string;
        }) => Promise<void>;
      }
    ).onSlashCommand({
      command: "/pinet",
      text: "agents list",
      channelId: "C123",
      userId: "U123",
      responseUrl: "https://hooks.slack.com/commands/T/1/x",
    });

    expect(fetchSpy).toHaveBeenCalledWith("https://hooks.slack.com/commands/T/1/x", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ response_type: "ephemeral", text: "Pinet agents: 1 shown" }),
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(callSlack).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("falls back to chat.postEphemeral when Slack slash command response_url fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("no", {
        status: 500,
      }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const adapter = new SlackAdapter({
      ...baseConfig,
      onSlashCommand: () => "Pinet agents: 1 shown",
    });
    const callSlack = vi
      .spyOn(
        adapter as unknown as {
          callSlack: (
            method: string,
            token: string,
            body?: Record<string, unknown>,
          ) => Promise<Record<string, unknown>>;
        },
        "callSlack",
      )
      .mockResolvedValue({ ok: true });

    await (
      adapter as unknown as {
        onSlashCommand: (event: {
          command: string;
          text: string;
          channelId: string;
          userId: string;
          responseUrl: string;
        }) => Promise<void>;
      }
    ).onSlashCommand({
      command: "/pinet",
      text: "agents list",
      channelId: "C123",
      userId: "U123",
      responseUrl: "https://hooks.slack.com/commands/T/1/x",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(callSlack).toHaveBeenCalledWith("chat.postEphemeral", "xoxb-test-token", {
      channel: "C123",
      user: "U123",
      text: "Pinet agents: 1 shown",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[slack-adapter] Slash command response_url failed: HTTP 500",
    );
    fetchSpy.mockRestore();
    consoleError.mockRestore();
  });

  it("uses chat.postEphemeral directly for slash command error responses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", {
        status: 200,
      }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const adapter = new SlackAdapter({
      ...baseConfig,
      onSlashCommand: () => {
        throw new Error("boom");
      },
    });
    const callSlack = vi
      .spyOn(
        adapter as unknown as {
          callSlack: (
            method: string,
            token: string,
            body?: Record<string, unknown>,
          ) => Promise<Record<string, unknown>>;
        },
        "callSlack",
      )
      .mockResolvedValue({ ok: true });

    await (
      adapter as unknown as {
        onSlashCommand: (event: {
          command: string;
          text: string;
          channelId: string;
          userId: string;
          responseUrl: string;
        }) => Promise<void>;
      }
    ).onSlashCommand({
      command: "/pinet",
      text: "agents list",
      channelId: "C123",
      userId: "U123",
      responseUrl: "https://hooks.slack.com/commands/T/1/x",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(callSlack).toHaveBeenCalledWith("chat.postEphemeral", "xoxb-test-token", {
      channel: "C123",
      user: "U123",
      text: "Slack command failed: boom",
    });
    fetchSpy.mockRestore();
    consoleError.mockRestore();
  });

  it("records known threads on assistant_thread_started without claiming ownership", async () => {
    const rememberKnownThread = vi.fn();
    const adapter = new SlackAdapter({
      ...baseConfig,
      rememberKnownThread,
    });
    vi.spyOn(
      adapter as unknown as { setSuggestedPrompts: () => Promise<void> },
      "setSuggestedPrompts",
    ).mockResolvedValue(undefined);

    await (
      adapter as unknown as {
        onThreadStarted: (evt: Record<string, unknown>) => Promise<void>;
      }
    ).onThreadStarted({
      type: "assistant_thread_started",
      assistant_thread: {
        channel_id: "C123",
        thread_ts: "123.456",
        user_id: "U123",
      },
    });

    expect(rememberKnownThread).toHaveBeenCalledWith("123.456", "C123", null);
  });

  it("bounds the in-memory tracked thread cache", async () => {
    const adapter = new SlackAdapter(baseConfig);
    vi.spyOn(
      adapter as unknown as { setSuggestedPrompts: () => Promise<void> },
      "setSuggestedPrompts",
    ).mockResolvedValue(undefined);

    const adapterPort = adapter as unknown as {
      onThreadStarted: (evt: Record<string, unknown>) => Promise<void>;
    };

    for (let i = 0; i <= SLACK_THREAD_CACHE_MAX_SIZE; i += 1) {
      await adapterPort.onThreadStarted({
        type: "assistant_thread_started",
        assistant_thread: {
          channel_id: "C123",
          thread_ts: `${i}.000`,
          user_id: "U123",
        },
      });
    }

    const tracked = adapter.getTrackedThreadIds();
    expect(tracked.size).toBe(SLACK_THREAD_CACHE_MAX_SIZE);
    expect(tracked.has("0.000")).toBe(false);
    expect(tracked.has(`${SLACK_THREAD_CACHE_MAX_SIZE}.000`)).toBe(true);
  });

  it("bounds pending attention reactions retained per thread", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/users.info")) {
        return new Response(JSON.stringify({ ok: true, user: { real_name: "Alice" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/reactions.add")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected Slack API call: ${url}`);
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const adapter = new SlackAdapter(baseConfig);
      adapter.onInbound(vi.fn());
      const adapterPort = adapter as unknown as {
        botUserId: string | null;
        onMessage: (evt: Record<string, unknown>) => Promise<void>;
        pendingEyes: {
          get: (threadTs: string) => { channel: string; messageTs: string }[] | undefined;
        };
      };
      adapterPort.botUserId = "U_BOT";

      for (let i = 0; i <= SLACK_PENDING_ATTENTION_MAX_MESSAGES_PER_THREAD; i += 1) {
        await adapterPort.onMessage({
          type: "message",
          user: "U_ALLOWED",
          text: `message ${i}`,
          channel: "D1",
          channel_type: "im",
          thread_ts: "1.1",
          ts: `1.${i + 2}`,
        });
      }

      const pending = adapterPort.pendingEyes.get("1.1") ?? [];
      expect(pending).toHaveLength(SLACK_PENDING_ATTENTION_MAX_MESSAGES_PER_THREAD);
      expect(pending[0]?.messageTs).toBe("1.3");
      expect(pending.at(-1)?.messageTs).toBe(
        `1.${SLACK_PENDING_ATTENTION_MAX_MESSAGES_PER_THREAD + 2}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("registers an inbound handler", () => {
    const adapter = new SlackAdapter(baseConfig);
    const handler = vi.fn();
    adapter.onInbound(handler);
    // handler is registered (can't easily verify without triggering a message)
    expect(adapter.name).toBe("slack");
  });

  it("forwards app_home_opened events to the configured callback", async () => {
    const onAppHomeOpened = vi.fn(async () => undefined);
    const adapter = new SlackAdapter({
      ...baseConfig,
      onAppHomeOpened,
    });

    await (
      adapter as unknown as {
        onAppHomeOpened: (evt: Record<string, unknown>) => Promise<void>;
      }
    ).onAppHomeOpened({
      type: "app_home_opened",
      user: "U123",
      tab: "home",
      event_ts: "123.456",
    });

    expect(onAppHomeOpened).toHaveBeenCalledWith({
      userId: "U123",
      tab: "home",
      eventTs: "123.456",
    });
  });

  it("ignores non-home app_home_opened events", async () => {
    const onAppHomeOpened = vi.fn(async () => undefined);
    const adapter = new SlackAdapter({
      ...baseConfig,
      onAppHomeOpened,
    });

    await (
      adapter as unknown as {
        onAppHomeOpened: (evt: Record<string, unknown>) => Promise<void>;
      }
    ).onAppHomeOpened({
      type: "app_home_opened",
      user: "U123",
      tab: "messages",
      event_ts: "123.456",
    });

    expect(onAppHomeOpened).not.toHaveBeenCalled();
  });

  it("contains app_home_opened callback failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const adapter = new SlackAdapter({
      ...baseConfig,
      onAppHomeOpened: vi.fn(async () => {
        throw new Error("views.publish failed");
      }),
    });

    await expect(
      (
        adapter as unknown as {
          onAppHomeOpened: (evt: Record<string, unknown>) => Promise<void>;
        }
      ).onAppHomeOpened({
        type: "app_home_opened",
        user: "U123",
        tab: "home",
        event_ts: "123.456",
      }),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      "[slack-adapter] Home tab callback failed: views.publish failed",
    );
  });

  it("ignores duplicate Socket Mode message deliveries with the same Slack event_id", async () => {
    const adapter = new SlackAdapter(baseConfig);
    const handler = vi.fn();
    adapter.onInbound(handler);
    (adapter as unknown as { botUserId: string | null }).botUserId = "U_BOT";

    const resolveUserSpy = vi
      .spyOn(
        adapter as unknown as { resolveUser: (userId: string) => Promise<string> },
        "resolveUser",
      )
      .mockResolvedValue("Alice");
    const addReactionSpy = vi
      .spyOn(
        adapter as unknown as {
          addReaction: (channel: string, ts: string, emoji: string) => Promise<void>;
        },
        "addReaction",
      )
      .mockResolvedValue(undefined);

    const client = new SlackSocketModeClient({
      slack: vi.fn(async () => ({})),
      botToken: "xoxb-test",
      appToken: "xapp-test",
      dedup: new Set<string>(),
      onMessage: (event) =>
        (
          adapter as unknown as {
            onMessage: (input: Record<string, unknown>) => Promise<void>;
          }
        ).onMessage(event),
    });

    const firstFrame = JSON.stringify({
      envelope_id: "env-1",
      type: "events_api",
      payload: {
        event_id: "Ev-duplicate",
        event: {
          type: "message",
          user: "U1",
          text: "hello",
          channel: "D1",
          channel_type: "im",
          ts: "1.1",
        },
      },
    });
    const secondFrame = JSON.stringify({
      envelope_id: "env-2",
      type: "events_api",
      payload: {
        event_id: "Ev-duplicate",
        event: {
          type: "message",
          user: "U1",
          text: "hello",
          channel: "D1",
          channel_type: "im",
          ts: "1.1",
        },
      },
    });

    await (
      client as unknown as {
        handleFrame: (raw: string) => Promise<void>;
      }
    ).handleFrame(firstFrame);
    await (
      client as unknown as {
        handleFrame: (raw: string) => Promise<void>;
      }
    ).handleFrame(secondFrame);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(resolveUserSpy).toHaveBeenCalledTimes(1);
    expect(addReactionSpy).toHaveBeenCalledTimes(1);
  });

  it("emits normalized block action payloads with structured metadata", async () => {
    const rememberKnownThread = vi.fn();
    const adapter = new SlackAdapter({
      ...baseConfig,
      rememberKnownThread,
    });
    const handler = vi.fn();
    adapter.onInbound(handler);
    vi.spyOn(
      adapter as unknown as { resolveUser: (userId: string) => Promise<string> },
      "resolveUser",
    ).mockResolvedValue("Will");

    const client = new SlackSocketModeClient({
      slack: vi.fn(async () => ({})),
      botToken: "xoxb-test",
      appToken: "xapp-test",
      onInteractive: (event) =>
        (
          adapter as unknown as {
            emitInteractiveInbound: (input: {
              channel: string;
              threadTs: string;
              userId: string;
              text: string;
              timestamp: string;
              metadata: Record<string, unknown>;
            }) => Promise<void>;
          }
        ).emitInteractiveInbound(event),
    });

    await (
      client as unknown as {
        handleFrame: (raw: string) => Promise<void>;
      }
    ).handleFrame(
      JSON.stringify({
        envelope_id: "env-1",
        type: "interactive",
        payload: {
          type: "block_actions",
          trigger_id: "trigger-1",
          user: { id: "U123" },
          channel: { id: "C123" },
          container: {
            channel_id: "C123",
            message_ts: "123.456",
            thread_ts: "123.000",
          },
          actions: [
            {
              action_id: "review.approve",
              block_id: "review-actions",
              type: "button",
              text: { type: "plain_text", text: "Approve" },
              value: '{"decision":"approve"}',
              action_ts: "123.789",
            },
          ],
        },
      }),
    );

    expect(rememberKnownThread).toHaveBeenCalledWith("123.000", "C123", null);
    expect(handler).toHaveBeenCalledWith({
      source: "slack",
      threadId: "123.000",
      channel: "C123",
      userId: "U123",
      userName: "Will",
      text: 'Clicked Slack "Approve" (action_id: review.approve).',
      timestamp: "123.789",
      scope: {
        workspace: {
          provider: "slack",
          source: "compatibility",
          compatibilityKey: "default",
          channelId: "C123",
        },
        instance: {
          source: "compatibility",
          compatibilityKey: "default",
        },
      },
      metadata: {
        kind: "slack_block_action",
        triggerId: "trigger-1",
        viewId: null,
        callbackId: null,
        viewHash: null,
        actionId: "review.approve",
        blockId: "review-actions",
        value: '{"decision":"approve"}',
        parsedValue: { decision: "approve" },
        actionText: "Approve",
        channel: "C123",
        threadTs: "123.000",
        messageTs: "123.456",
        modalPrivateMetadata: null,
        actions: [
          {
            actionId: "review.approve",
            blockId: "review-actions",
            text: "Approve",
            type: "button",
            style: null,
            value: '{"decision":"approve"}',
            parsedValue: { decision: "approve" },
            actionTs: "123.789",
          },
        ],
      },
    });
  });

  it("emits view submission payloads with parsed modal state", async () => {
    const rememberKnownThread = vi.fn();
    const adapter = new SlackAdapter({
      ...baseConfig,
      rememberKnownThread,
    });
    const handler = vi.fn();
    adapter.onInbound(handler);
    vi.spyOn(
      adapter as unknown as { resolveUser: (userId: string) => Promise<string> },
      "resolveUser",
    ).mockResolvedValue("Will");

    const client = new SlackSocketModeClient({
      slack: vi.fn(async () => ({})),
      botToken: "xoxb-test",
      appToken: "xapp-test",
      onInteractive: (event) =>
        (
          adapter as unknown as {
            emitInteractiveInbound: (input: {
              channel: string;
              threadTs: string;
              userId: string;
              text: string;
              timestamp: string;
              metadata: Record<string, unknown>;
            }) => Promise<void>;
          }
        ).emitInteractiveInbound(event),
    });

    await (
      client as unknown as {
        handleFrame: (raw: string) => Promise<void>;
      }
    ).handleFrame(
      JSON.stringify({
        envelope_id: "env-1",
        type: "interactive",
        payload: {
          type: "view_submission",
          trigger_id: "trigger-1",
          user: { id: "U123" },
          view: {
            id: "V123",
            callback_id: "deploy.confirm",
            title: { type: "plain_text", text: "Deploy approval" },
            private_metadata:
              '{"workflow":"deploy","__piSlackModalContext":{"threadTs":"123.000","channel":"C123"}}',
            state: {
              values: {
                confirm_phrase: {
                  confirm_phrase: {
                    type: "plain_text_input",
                    value: "CONFIRM",
                  },
                },
              },
            },
          },
        },
      }),
    );

    expect(rememberKnownThread).toHaveBeenCalledWith("123.000", "C123", null);
    expect(handler).toHaveBeenCalledWith({
      source: "slack",
      threadId: "123.000",
      channel: "C123",
      userId: "U123",
      userName: "Will",
      text: 'Submitted Slack modal (deploy.confirm) "Deploy approval".',
      timestamp: "V123",
      scope: {
        workspace: {
          provider: "slack",
          source: "compatibility",
          compatibilityKey: "default",
          channelId: "C123",
        },
        instance: {
          source: "compatibility",
          compatibilityKey: "default",
        },
      },
      metadata: {
        kind: "slack_view_submission",
        triggerId: "trigger-1",
        callbackId: "deploy.confirm",
        viewId: "V123",
        externalId: null,
        viewHash: null,
        channel: "C123",
        threadTs: "123.000",
        privateMetadata: { workflow: "deploy" },
        stateValues: {
          confirm_phrase: {
            confirm_phrase: {
              type: "plain_text_input",
              value: "CONFIRM",
            },
          },
        },
      },
    });
  });
});

// ─── SlackAdapter — allowlist filtering ──────────────────

describe("SlackAdapter — allowlist filtering", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockSlackResponse(data: Record<string, unknown> = {}) {
    return new Response(JSON.stringify({ ok: true, ...data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("blocks inbound DM events by default when no allowlist is configured", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("default-deny path should not call Slack APIs");
    });

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });
    const handler = vi.fn();
    adapter.onInbound(handler);

    const adapterPort = adapter as unknown as {
      botUserId: string | null;
      onMessage: (evt: Record<string, unknown>) => Promise<void>;
    };
    adapterPort.botUserId = "U_BOT";

    await adapterPort.onMessage({
      type: "message",
      user: "U_BLOCKED",
      text: "hello from Slack",
      channel: "D1",
      channel_type: "im",
      ts: "1.1",
    });

    expect(handler).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adapter.getTrackedThreadIds()).toEqual(new Set(["1.1"]));
  });

  it("admits inbound DM events when allowAllWorkspaceUsers is explicitly enabled", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const parsedBody = rawBody.startsWith("{")
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(rawBody));

      if (url.endsWith("/users.info")) {
        expect(parsedBody.user).toBe("U_ALLOWED");
        return mockSlackResponse({ user: { real_name: "Alice Example" } });
      }
      if (url.endsWith("/reactions.add")) {
        expect(parsedBody).toEqual({ channel: "D1", timestamp: "1.1", name: "eyes" });
        return mockSlackResponse();
      }

      throw new Error(`unexpected Slack API call: ${url}`);
    });

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowAllWorkspaceUsers: true,
    });
    const handler = vi.fn();
    adapter.onInbound(handler);

    const adapterPort = adapter as unknown as {
      botUserId: string | null;
      onMessage: (evt: Record<string, unknown>) => Promise<void>;
    };
    adapterPort.botUserId = "U_BOT";

    await adapterPort.onMessage({
      type: "message",
      user: "U_ALLOWED",
      text: "hello from Slack",
      channel: "D1",
      channel_type: "im",
      ts: "1.1",
    });

    expect(handler).toHaveBeenCalledWith({
      source: "slack",
      threadId: "1.1",
      channel: "D1",
      userId: "U_ALLOWED",
      userName: "Alice Example",
      text: "hello from Slack",
      timestamp: "1.1",
      scope: {
        workspace: {
          provider: "slack",
          source: "compatibility",
          compatibilityKey: "default",
          channelId: "D1",
        },
        instance: {
          source: "compatibility",
          compatibilityKey: "default",
        },
      },
    });
    await waitForAssertion(() => {
      const endpoints = fetchMock.mock.calls.map(([url]) => String(url));
      expect(endpoints).toContain("https://slack.com/api/users.info");
      expect(endpoints).toContain("https://slack.com/api/reactions.add");
    });
  });

  it("suppresses legacy broker-known threaded DMs when durable context is missing", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("legacy suppressed path should not call Slack APIs");
    });

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowAllWorkspaceUsers: true,
      isKnownThread: () => false,
      getKnownThread: (threadTs) =>
        threadTs === "1.1" ? { channelId: "D1", context: null } : null,
    });
    const handler = vi.fn();
    adapter.onInbound(handler);
    const adapterPort = adapter as unknown as {
      botUserId: string | null;
      onMessage: (evt: Record<string, unknown>) => Promise<void>;
    };
    adapterPort.botUserId = "U_BOT";

    await adapterPort.onMessage({
      type: "message",
      user: "U_ALLOWED",
      text: "legacy reply after restart",
      channel: "D1",
      channel_type: "im",
      thread_ts: "1.1",
      ts: "1.2",
    });

    expect(handler).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rehydrates known Slack thread context into inbound scope after cache eviction", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const parsedBody = rawBody.startsWith("{")
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(rawBody));

      if (url.endsWith("/users.info")) {
        expect(parsedBody.user).toBe("U_ALLOWED");
        return mockSlackResponse({ user: { real_name: "Alice Example" } });
      }
      if (url.endsWith("/reactions.add")) {
        return mockSlackResponse();
      }

      throw new Error(`unexpected Slack API call: ${url}`);
    });

    const knownThreads = new Map<
      string,
      {
        channelId: string;
        context?: SlackThreadContext | null;
      }
    >();
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowAllWorkspaceUsers: true,
      isKnownThread: (threadTs) => knownThreads.has(threadTs),
      getKnownThread: (threadTs) => knownThreads.get(threadTs) ?? null,
      rememberKnownThread: (threadTs, channelId, context) => {
        knownThreads.set(threadTs, { channelId, context });
      },
    });
    vi.spyOn(
      adapter as unknown as { setSuggestedPrompts: () => Promise<void> },
      "setSuggestedPrompts",
    ).mockResolvedValue(undefined);
    const handler = vi.fn();
    adapter.onInbound(handler);

    const adapterPort = adapter as unknown as {
      botUserId: string | null;
      onThreadStarted: (evt: Record<string, unknown>) => Promise<void>;
      onMessage: (evt: Record<string, unknown>) => Promise<void>;
    };
    adapterPort.botUserId = "U_BOT";

    await adapterPort.onThreadStarted({
      type: "assistant_thread_started",
      assistant_thread: {
        channel_id: "D1",
        thread_ts: "1.1",
        user_id: "U_ALLOWED",
        context: {
          channel_id: "C_TEAM",
          team_id: "T001",
        },
      },
    });

    for (let i = 0; i < SLACK_THREAD_CACHE_MAX_SIZE; i += 1) {
      await adapterPort.onThreadStarted({
        type: "assistant_thread_started",
        assistant_thread: {
          channel_id: "D1",
          thread_ts: `evict-${i}`,
          user_id: "U_ALLOWED",
        },
      });
    }
    expect(adapter.getTrackedThreadIds().has("1.1")).toBe(false);

    await adapterPort.onMessage({
      type: "message",
      user: "U_ALLOWED",
      text: "hello after eviction",
      channel: "D1",
      channel_type: "im",
      thread_ts: "1.1",
      ts: "1.2",
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "1.1",
        scope: {
          workspace: {
            provider: "slack",
            source: "compatibility",
            compatibilityKey: "default",
            workspaceId: "T001",
            channelId: "C_TEAM",
          },
          instance: {
            source: "compatibility",
            compatibilityKey: "default",
          },
        },
      }),
    );
  });

  it("carries known Slack thread team context into the inbound scope carrier", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const parsedBody = rawBody.startsWith("{")
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(rawBody));

      if (url.endsWith("/users.info")) {
        expect(parsedBody.user).toBe("U_ALLOWED");
        return mockSlackResponse({ user: { real_name: "Alice Example" } });
      }
      if (url.endsWith("/reactions.add")) {
        return mockSlackResponse();
      }

      throw new Error(`unexpected Slack API call: ${url}`);
    });

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowAllWorkspaceUsers: true,
    });
    const handler = vi.fn();
    adapter.onInbound(handler);

    await (
      adapter as unknown as {
        onThreadStarted: (evt: Record<string, unknown>) => Promise<void>;
      }
    ).onThreadStarted({
      type: "assistant_thread_started",
      assistant_thread: {
        channel_id: "D1",
        thread_ts: "1.1",
        user_id: "U_ALLOWED",
        context: {
          channel_id: "C_TEAM",
          team_id: "T001",
        },
      },
    });

    const adapterPort = adapter as unknown as {
      botUserId: string | null;
      onMessage: (evt: Record<string, unknown>) => Promise<void>;
    };
    adapterPort.botUserId = "U_BOT";

    await adapterPort.onMessage({
      type: "message",
      user: "U_ALLOWED",
      text: "hello from scoped Slack",
      channel: "D1",
      channel_type: "im",
      thread_ts: "1.1",
      ts: "1.2",
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "1.1",
        scope: {
          workspace: {
            provider: "slack",
            source: "compatibility",
            compatibilityKey: "default",
            workspaceId: "T001",
            channelId: "C_TEAM",
          },
          instance: {
            source: "compatibility",
            compatibilityKey: "default",
          },
        },
      }),
    );
  });
});

// ─── SlackAdapter — send (mocked fetch) ─────────────────

describe("SlackAdapter — reaction triggers", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockSlackResponse(data: Record<string, unknown> = {}) {
    return new Response(JSON.stringify({ ok: true, ...data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("queues mapped reaction_added events with structured context and acknowledges with ✅", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const parsedBody = rawBody.startsWith("{")
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(rawBody));

      if (url.endsWith("/conversations.history")) {
        return mockSlackResponse({
          messages: [
            {
              ts: "111.333",
              thread_ts: "111.222",
              text: "Please review PR #210",
              user: "U_TARGET",
            },
          ],
        });
      }

      if (url.endsWith("/users.info")) {
        if (parsedBody.user === "U_REACTOR") {
          return mockSlackResponse({ user: { real_name: "Alice" } });
        }
        if (parsedBody.user === "U_TARGET") {
          return mockSlackResponse({ user: { real_name: "Bob" } });
        }
      }

      if (url.endsWith("/reactions.add")) {
        return mockSlackResponse();
      }

      throw new Error(`unexpected Slack API call: ${url}`);
    });

    const rememberKnownThread = vi.fn();
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowAllWorkspaceUsers: true,
      reactionCommands: { "👀": "review" },
      rememberKnownThread,
    });
    (adapter as unknown as { botUserId: string | null }).botUserId = "U_BOT";

    const handler = vi.fn();
    adapter.onInbound(handler);

    await (
      adapter as unknown as { onReactionAdded: (evt: Record<string, unknown>) => Promise<void> }
    ).onReactionAdded({
      type: "reaction_added",
      user: "U_REACTOR",
      reaction: "eyes",
      item_user: "U_TARGET",
      item: {
        type: "message",
        channel: "C123",
        ts: "111.333",
      },
      event_ts: "999.000",
    });

    expect(rememberKnownThread).toHaveBeenCalledWith("111.222", "C123", null);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "slack",
        threadId: "111.222",
        channel: "C123",
        userId: "U_REACTOR",
        userName: "Alice",
        timestamp: "999.000",
        metadata: expect.objectContaining({
          reactionTrigger: true,
          reactionName: "eyes",
          reactionAction: "review",
          reactorUserId: "U_REACTOR",
          reactorName: "Alice",
          reactionEventTs: "999.000",
          referencedSource: "slack",
          referencedChannel: "C123",
          referencedThreadTs: "111.222",
          referencedMessageTs: "111.333",
          referencedExternalId: "C123:111.333",
          reactedMessageAuthor: "Bob",
          reactedMessageAuthorId: "U_TARGET",
        }),
      }),
    );
    expect(handler.mock.calls[0]?.[0]?.text).toContain("Reaction trigger from Slack:");
    expect(handler.mock.calls[0]?.[0]?.text).toContain("- action: review");
    expect(handler.mock.calls[0]?.[0]?.text).toContain("Please review PR #210");

    const reactionCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/reactions.add"),
    );
    expect(reactionCall).toBeDefined();
    const reactionBody = JSON.parse(reactionCall?.[1]?.body as string) as Record<string, unknown>;
    expect(reactionBody).toEqual({
      channel: "C123",
      timestamp: "111.333",
      name: "white_check_mark",
    });
  });

  it("routes octagonal-sign reactions as explicit interrupt controls for the thread owner", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const parsedBody = rawBody.startsWith("{")
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(rawBody));

      if (url.endsWith("/conversations.history")) {
        return mockSlackResponse({
          messages: [
            {
              ts: "111.333",
              thread_ts: "111.222",
              text: "Stop the active run",
              user: "U_TARGET",
            },
          ],
        });
      }

      if (url.endsWith("/users.info")) {
        if (parsedBody.user === "U_REACTOR") {
          return mockSlackResponse({ user: { real_name: "Alice" } });
        }
        if (parsedBody.user === "U_TARGET") {
          return mockSlackResponse({ user: { real_name: "Bob" } });
        }
      }

      if (url.endsWith("/reactions.add")) {
        return mockSlackResponse();
      }

      throw new Error(`unexpected Slack API call: ${url}`);
    });

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowAllWorkspaceUsers: true,
    });
    (adapter as unknown as { botUserId: string | null }).botUserId = "U_BOT";

    const handler = vi.fn();
    adapter.onInbound(handler);

    await (
      adapter as unknown as { onReactionAdded: (evt: Record<string, unknown>) => Promise<void> }
    ).onReactionAdded({
      type: "reaction_added",
      user: "U_REACTOR",
      reaction: "octagonal_sign",
      item_user: "U_TARGET",
      item: {
        type: "message",
        channel: "C123",
        ts: "111.333",
      },
      event_ts: "999.000",
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "slack",
        threadId: "111.222",
        channel: "C123",
        userId: "U_REACTOR",
        text: '{"type":"pinet:control","action":"interrupt"}',
        metadata: expect.objectContaining({
          type: "pinet:control",
          action: "interrupt",
          kind: "pinet_control",
          command: "interrupt",
          slackReactionControl: true,
          reactionTrigger: true,
          reactionName: "octagonal_sign",
          reactionAction: "interrupt",
          referencedExternalId: "C123:111.333",
        }),
      }),
    );
  });

  it("does not route interrupt controls when Slack cannot identify the reacted message thread", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/conversations.history")) {
        return mockSlackResponse({ messages: [] });
      }
      if (url.endsWith("/reactions.add")) {
        return mockSlackResponse();
      }
      throw new Error(`unexpected Slack API call: ${url}`);
    });

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowAllWorkspaceUsers: true,
    });
    (adapter as unknown as { botUserId: string | null }).botUserId = "U_BOT";

    const handler = vi.fn();
    adapter.onInbound(handler);

    await (
      adapter as unknown as { onReactionAdded: (evt: Record<string, unknown>) => Promise<void> }
    ).onReactionAdded({
      type: "reaction_added",
      user: "U_REACTOR",
      reaction: "octagonal_sign",
      item_user: "U_TARGET",
      item: { type: "message", channel: "C123", ts: "222.333" },
      event_ts: "999.222",
    });

    expect(handler).not.toHaveBeenCalled();
    const reactionBody = JSON.parse(
      String(
        fetchMock.mock.calls.find(([url]) => String(url).endsWith("/reactions.add"))?.[1]?.body ??
          "{}",
      ),
    ) as Record<string, unknown>;
    expect(reactionBody).toEqual({ channel: "C123", timestamp: "222.333", name: "x" });
  });

  it("routes custom interrupt reactions even when nonessential author lookup would fail", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const parsedBody = rawBody.startsWith("{")
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(rawBody));

      if (url.endsWith("/conversations.history")) {
        return mockSlackResponse({
          messages: [{ ts: "222.333", thread_ts: "222.222", text: "Busy work", user: "U_TARGET" }],
        });
      }

      if (url.endsWith("/users.info")) {
        if (parsedBody.user === "U_REACTOR") {
          return mockSlackResponse({ user: { real_name: "Alice" } });
        }
        throw new Error("author lookup should not be required for interrupt controls");
      }

      if (url.endsWith("/reactions.add")) {
        return mockSlackResponse();
      }

      throw new Error(`unexpected Slack API call: ${url}`);
    });

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowAllWorkspaceUsers: true,
      reactionCommands: { rotating_light: "interrupt" },
    });
    (adapter as unknown as { botUserId: string | null }).botUserId = "U_BOT";

    const handler = vi.fn();
    adapter.onInbound(handler);

    await (
      adapter as unknown as { onReactionAdded: (evt: Record<string, unknown>) => Promise<void> }
    ).onReactionAdded({
      type: "reaction_added",
      user: "U_REACTOR",
      reaction: "rotating_light",
      item_user: "U_TARGET",
      item: { type: "message", channel: "C123", ts: "222.333" },
      event_ts: "999.222",
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "222.222",
        text: '{"type":"pinet:control","action":"interrupt"}',
        metadata: expect.objectContaining({
          reactionName: "rotating_light",
          reactionAction: "interrupt",
          slackReactionControl: true,
        }),
      }),
    );
  });

  it("routes arrow-up steering reactions even when Slack cannot fetch the reacted message", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const parsedBody = rawBody.startsWith("{")
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(rawBody));

      if (url.endsWith("/conversations.history")) {
        return mockSlackResponse({ messages: [] });
      }

      if (url.endsWith("/users.info")) {
        if (parsedBody.user === "U_REACTOR") {
          return mockSlackResponse({ user: { real_name: "Alice" } });
        }
        if (parsedBody.user === "U_TARGET") {
          return mockSlackResponse({ user: { real_name: "Bob" } });
        }
      }

      if (url.endsWith("/reactions.add")) {
        return mockSlackResponse();
      }

      throw new Error(`unexpected Slack API call: ${url}`);
    });

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowAllWorkspaceUsers: true,
    });
    (adapter as unknown as { botUserId: string | null }).botUserId = "U_BOT";

    const handler = vi.fn();
    adapter.onInbound(handler);

    await (
      adapter as unknown as { onReactionAdded: (evt: Record<string, unknown>) => Promise<void> }
    ).onReactionAdded({
      type: "reaction_added",
      user: "U_REACTOR",
      reaction: "arrow_up",
      item_user: "U_TARGET",
      item: {
        type: "message",
        channel: "C123",
        ts: "111.333",
      },
      event_ts: "999.000",
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "slack",
        threadId: "111.333",
        channel: "C123",
        userId: "U_REACTOR",
        userName: "Alice",
        timestamp: "999.000",
        metadata: expect.objectContaining({
          reactionTrigger: true,
          reactionName: "arrow_up",
          reactionAction: "steer",
          reactedMessageFetchStatus: "unavailable",
          referencedMessageTs: "111.333",
          reactedMessageAuthor: "Bob",
          reactedMessageAuthorId: "U_TARGET",
        }),
      }),
    );
    expect(handler.mock.calls[0]?.[0]?.text).toContain("- action: steer");
    expect(handler.mock.calls[0]?.[0]?.text).toContain("message text unavailable");

    const reactionBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/reactions.add"))
      .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    expect(reactionBodies).toEqual([
      { channel: "C123", timestamp: "111.333", name: "white_check_mark" },
    ]);
  });
});

describe("SlackAdapter — send", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockSlackResponse(data: Record<string, unknown> = {}) {
    return new Response(JSON.stringify({ ok: true, ...data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("invokes Slack API calls through the adapter capability boundary", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ messages: [{ text: "hello" }] }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    const response = await adapter.invokeCapability({
      capability: "api.call",
      params: {
        method: "conversations.history",
        params: { channel: "C123", limit: 1 },
      },
    });

    expect(response.result).toEqual({ ok: true, messages: [{ text: "hello" }] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/conversations.history");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("channel")).toBe("C123");
    expect(body.get("limit")).toBe("1");
  });

  it("returns thread-claim effects for Slack postMessage capability calls", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ ts: "123.456", channel: "C123" }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    const response = await adapter.invokeCapability({
      capability: "api.call",
      params: {
        method: "chat.postMessage",
        params: { channel: "C123", text: "hello" },
      },
    });

    expect(response.effects).toEqual({
      claimThread: { threadId: "123.456", channel: "C123" },
    });
  });

  it("calls chat.postMessage with correct body", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ message: { ts: "1.1" } }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    const msg: OutboundMessage = {
      threadId: "100.200",
      channel: "C123",
      text: "Hello from adapter",
    };

    await adapter.send(msg);

    // First call is chat.postMessage; second is assistant.threads.setStatus (fire-and-forget)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.channel).toBe("C123");
    expect(body.text).toBe("Hello from adapter");
    expect(body.thread_ts).toBe("100.200");
  });

  it("includes agent metadata when agentName is provided", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ message: { ts: "1.1" } }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    const msg: OutboundMessage = {
      threadId: "100.200",
      channel: "C123",
      text: "Hello",
      agentName: "TestBot",
      agentEmoji: "🤖",
    };

    await adapter.send(msg);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const meta = body.metadata as {
      event_type: string;
      event_payload: Record<string, unknown>;
    };
    expect(meta.event_type).toBe("pi_agent_msg");
    expect(meta.event_payload.agent).toBe("TestBot");
    expect(meta.event_payload.emoji).toBe("🤖");
    expect(meta.event_payload.scope).toEqual({
      workspace: {
        provider: "slack",
        source: "compatibility",
        compatibilityKey: "default",
        channelId: "C123",
      },
      instance: {
        source: "compatibility",
        compatibilityKey: "default",
      },
    });
  });

  it("includes agent_owner in metadata when agentOwnerToken is provided", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ message: { ts: "1.1" } }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    await adapter.send({
      threadId: "100.200",
      channel: "C123",
      text: "Hello",
      agentName: "TestBot",
      agentOwnerToken: "owner:abcd1234efgh5678",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const meta = body.metadata as {
      event_type: string;
      event_payload: Record<string, unknown>;
    };
    expect(meta.event_payload.agent).toBe("TestBot");
    expect(meta.event_payload.agent_owner).toBe("owner:abcd1234efgh5678");
    expect(meta.event_payload.scope).toEqual({
      workspace: {
        provider: "slack",
        source: "compatibility",
        compatibilityKey: "default",
        channelId: "C123",
      },
      instance: {
        source: "compatibility",
        compatibilityKey: "default",
      },
    });
  });

  it("includes metadata when only agentOwnerToken is set (no agentName)", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ message: { ts: "1.1" } }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    await adapter.send({
      threadId: "100.200",
      channel: "C123",
      text: "Hello",
      agentOwnerToken: "owner:abcd1234efgh5678",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const meta = body.metadata as {
      event_type: string;
      event_payload: Record<string, unknown>;
    };
    expect(meta.event_type).toBe("pi_agent_msg");
    expect(meta.event_payload.agent_owner).toBe("owner:abcd1234efgh5678");
    expect(meta.event_payload.agent).toBeUndefined();
    expect(meta.event_payload.scope).toEqual({
      workspace: {
        provider: "slack",
        source: "compatibility",
        compatibilityKey: "default",
        channelId: "C123",
      },
      instance: {
        source: "compatibility",
        compatibilityKey: "default",
      },
    });
  });

  it("does not include metadata when no agentName or metadata", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ message: { ts: "1.1" } }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    await adapter.send({
      threadId: "1.1",
      channel: "C1",
      text: "plain message",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.metadata).toBeUndefined();
  });

  it("prefers transport-aware Slack blocks when present", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ message: { ts: "1.1" } }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });
    const slackBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Transport-aware*" },
      },
    ] satisfies ReadonlyArray<Record<string, unknown>>;
    const legacyBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Legacy*" },
      },
    ] satisfies ReadonlyArray<Record<string, unknown>>;

    await adapter.send({
      threadId: "1.1",
      channel: "C1",
      text: "legacy fallback",
      content: {
        text: "plain fallback",
        markdown: "**plain fallback**",
        slackBlocks,
      },
      blocks: legacyBlocks,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.text).toBe("plain fallback");
    expect(body.blocks).toEqual(slackBlocks);
  });

  it("falls back to legacy blocks when transport-aware Slack blocks are empty", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ message: { ts: "1.1" } }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });
    const legacyBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Legacy fallback*" },
      },
    ] satisfies ReadonlyArray<Record<string, unknown>>;

    await adapter.send({
      threadId: "1.1",
      channel: "C1",
      text: "legacy fallback",
      content: {
        text: "plain fallback",
        slackBlocks: [],
      },
      blocks: legacyBlocks,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.blocks).toEqual(legacyBlocks);
  });

  it("omits an empty blocks payload", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ message: { ts: "1.1" } }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    await adapter.send({
      threadId: "1.1",
      channel: "C1",
      text: "fallback",
      content: {
        text: "plain fallback",
        slackBlocks: [],
      },
      blocks: [],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.blocks).toBeUndefined();
  });

  it("uses buildSlackRequest for proper encoding", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ message: { ts: "1.1" } }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-secret",
      appToken: "xapp-test",
    });

    await adapter.send({
      threadId: "1.1",
      channel: "C1",
      text: "test",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    // chat.postMessage is a JSON method, not form-encoded
    expect((init.headers as Record<string, string>)["Content-Type"]).toContain("application/json");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer xoxb-secret");
  });

  it("throws on Slack API error", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    await expect(adapter.send({ threadId: "1.1", channel: "C1", text: "test" })).rejects.toThrow(
      "channel_not_found",
    );
  });
});

// ─── SlackAdapter — connect (mocked fetch) ───────────────

describe("SlackAdapter — connect", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws when auth.test fails", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const adapter = new SlackAdapter({
      botToken: "xoxb-bad",
      appToken: "xapp-test",
    });

    await expect(adapter.connect()).rejects.toThrow("invalid_auth");
  });
});

// ─── SlackAdapter — disconnect ───────────────────────────

describe("SlackAdapter — disconnect", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("can disconnect without prior connect", async () => {
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });
    // Should not throw
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it("aborts in-flight Slack API calls during shutdown", async () => {
    fetchMock.mockImplementation((_input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };

        if (signal?.aborted) {
          rejectAbort();
          return;
        }

        signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    });

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    const sendPromise = adapter.send({
      channel: "C123",
      threadId: "123.456",
      text: "hello",
    });

    await adapter.disconnect();

    await expect(sendPromise).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("SlackAdapter — e2e Socket Mode lifecycle", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  const originalWebSocket = globalThis.WebSocket;

  class FakeWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;

    static instances: FakeWebSocket[] = [];

    readonly url: string;
    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    private readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();

    constructor(url: string) {
      this.url = url;
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, handler: (event: { data?: string }) => void): void {
      const handlers = this.listeners.get(type) ?? [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }

    send(data: string): void {
      this.sent.push(String(data));
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", {});
    }

    emit(type: string, event: { data?: string }): void {
      for (const handler of this.listeners.get(type) ?? []) {
        handler(event);
      }
    }
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
    if (originalWebSocket) {
      globalThis.WebSocket = originalWebSocket;
    }
    vi.restoreAllMocks();
  });

  it("receives a DM, ACKs the envelope, emits inbound text, then removes 👀 after replying", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const parsedBody = rawBody.startsWith("{")
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(rawBody));

      const ok = (data: Record<string, unknown>) =>
        new Response(JSON.stringify({ ok: true, ...data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      if (url.endsWith("/auth.test")) {
        return ok({ user_id: "U_BOT" });
      }
      if (url.endsWith("/apps.connections.open")) {
        return ok({ url: "wss://slack.test/socket" });
      }
      if (url.endsWith("/users.info")) {
        expect(parsedBody.user).toBe("U123");
        return ok({ user: { real_name: "Alice Example" } });
      }
      if (url.endsWith("/reactions.add")) {
        expect(parsedBody).toEqual({ channel: "D123", timestamp: "111.222", name: "eyes" });
        return ok({});
      }
      if (url.endsWith("/chat.postMessage")) {
        expect(parsedBody).toMatchObject({
          channel: "D123",
          thread_ts: "111.222",
          text: "Roger that",
        });
        return ok({ message: { ts: "111.333" } });
      }
      if (url.endsWith("/reactions.remove")) {
        expect(parsedBody).toEqual({ channel: "D123", timestamp: "111.222", name: "eyes" });
        return ok({});
      }
      if (url.endsWith("/assistant.threads.setStatus")) {
        expect(parsedBody).toEqual({ channel_id: "D123", thread_ts: "111.222", status: "" });
        return ok({});
      }

      throw new Error(`unexpected Slack API call: ${url}`);
    });

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowAllWorkspaceUsers: true,
    });
    const handler = vi.fn();
    adapter.onInbound(handler);

    await adapter.connect();

    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe("wss://slack.test/socket");

    ws.emit("message", {
      data: JSON.stringify({
        envelope_id: "env-1",
        type: "events_api",
        payload: {
          event_id: "Ev-1",
          event: {
            type: "message",
            user: "U123",
            text: "Hello from Slack",
            channel: "D123",
            channel_type: "im",
            ts: "111.222",
          },
        },
      }),
    });

    await waitForAssertion(() => {
      expect(ws.sent).toContain(JSON.stringify({ envelope_id: "env-1" }));
      expect(handler).toHaveBeenCalledWith({
        source: "slack",
        threadId: "111.222",
        channel: "D123",
        userId: "U123",
        userName: "Alice Example",
        text: "Hello from Slack",
        timestamp: "111.222",
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

    await adapter.send({
      threadId: "111.222",
      channel: "D123",
      text: "Roger that",
      agentName: "Silent Crocodile",
      agentEmoji: "🐊",
    });

    await waitForAssertion(() => {
      const endpoints = fetchMock.mock.calls.map(([url]) => String(url));
      expect(endpoints).toContain("https://slack.com/api/reactions.remove");
      expect(endpoints).toContain("https://slack.com/api/assistant.threads.setStatus");
    });

    const endpoints = fetchMock.mock.calls.map(([url]) => String(url));
    expect(endpoints).toContain("https://slack.com/api/reactions.add");
    expect(endpoints).toContain("https://slack.com/api/chat.postMessage");
    expect(endpoints).toContain("https://slack.com/api/reactions.remove");
    expect(endpoints).toContain("https://slack.com/api/assistant.threads.setStatus");

    await adapter.disconnect();
  });

  it("emits structured file metadata for inbound file_share messages", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const parsedBody = rawBody.startsWith("{")
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(rawBody));

      const ok = (data: Record<string, unknown>) =>
        new Response(JSON.stringify({ ok: true, ...data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      if (url.endsWith("/auth.test")) {
        return ok({ user_id: "U_BOT" });
      }
      if (url.endsWith("/apps.connections.open")) {
        return ok({ url: "wss://slack.test/socket" });
      }
      if (url.endsWith("/users.info")) {
        expect(parsedBody.user).toBe("U123");
        return ok({ user: { real_name: "Alice Example" } });
      }
      if (url.endsWith("/reactions.add")) {
        expect(parsedBody).toEqual({ channel: "D123", timestamp: "111.222", name: "eyes" });
        return ok({});
      }

      throw new Error(`unexpected Slack API call: ${url}`);
    });

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      allowAllWorkspaceUsers: true,
    });
    const handler = vi.fn();
    adapter.onInbound(handler);

    await adapter.connect();

    const ws = FakeWebSocket.instances[0]!;
    ws.emit("message", {
      data: JSON.stringify({
        envelope_id: "env-2",
        type: "events_api",
        payload: {
          event_id: "Ev-2",
          event: {
            type: "message",
            subtype: "file_share",
            user: "U123",
            text: "",
            channel: "D123",
            channel_type: "im",
            ts: "111.222",
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
          },
        },
      }),
    });

    await waitForAssertion(() => {
      expect(ws.sent).toContain(JSON.stringify({ envelope_id: "env-2" }));
      expect(handler).toHaveBeenCalledWith({
        source: "slack",
        threadId: "111.222",
        channel: "D123",
        userId: "U123",
        userName: "Alice Example",
        text: [
          "(Slack message had no plain-text body)",
          "",
          "Slack message context:",
          "- Incident notes — markdown — snippet — id=F123 — https://files.example/incident.md",
        ].join("\n"),
        timestamp: "111.222",
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
        metadata: {
          slackSubtype: "file_share",
          slackFiles: [
            {
              id: "F123",
              title: "Incident notes",
              filetype: "markdown",
              permalink: "https://files.example/incident.md",
              urlPrivate: "https://files.example/download/F123",
              mode: "snippet",
            },
          ],
        },
      });
    });

    await adapter.disconnect();
  });
});

// ─── SlackAdapter — reconnect scheduling ─────────────────

describe("SlackAdapter — reconnect scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports RECONNECT_DELAY_MS as 5000", () => {
    expect(RECONNECT_DELAY_MS).toBe(5000);
  });

  it("disconnect clears pending reconnect timers", async () => {
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    // Manually trigger disconnect to verify timer cleanup
    await adapter.disconnect();

    // Advance timers — nothing should throw or reconnect
    vi.advanceTimersByTime(RECONNECT_DELAY_MS * 2);

    expect(adapter.isConnected()).toBe(false);
  });
});
