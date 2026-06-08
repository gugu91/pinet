import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSlackTools, type SlackPinetDeliveryInput } from "./slack-tools.js";
import type { InboxMessage } from "./helpers.js";
import type { SlackResult } from "./slack-api.js";

type ToolResponse = {
  content?: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
};

type ToolDefinition = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResponse>;
};

type SlackDispatcherEnvelope = {
  status: "succeeded" | "failed";
  data: unknown;
  errors: Array<{ message: string; class?: string }>;
};

type SlackDispatcherData = {
  text?: string;
  details?: Record<string, unknown>;
};

function unwrapSlackDispatcherResponse(response: ToolResponse): ToolResponse {
  const envelope = response.details as SlackDispatcherEnvelope;
  if (envelope.status === "failed") {
    throw new Error(envelope.errors[0]?.message ?? "Slack dispatcher action failed");
  }

  const data = envelope.data as SlackDispatcherData;
  return {
    content: data.text ? [{ type: "text", text: data.text }] : response.content,
    details: data.details ?? {},
  };
}

describe("registerSlackTools", () => {
  function setup() {
    const tools = new Map<string, ToolDefinition>();
    const pi = {
      registerTool: vi.fn((definition: ToolDefinition) => {
        tools.set(definition.name, definition);
      }),
    } as unknown as ExtensionAPI;

    const inbox: InboxMessage[] = [];
    let botToken = "xoxb-initial";
    let defaultChannel: string | undefined = "general";
    let securityPrompt = "INITIAL SECURITY PROMPT";
    let lastDmChannel: string | null = null;
    let resolveUser = async (userId: string) => userId;
    let conversationsRepliesResponses: SlackResult[] = [];
    let usersListResponse: SlackResult = {
      ok: true,
      members: [],
      response_metadata: { next_cursor: "" },
    } as SlackResult;
    let conversationsInfoResponse: SlackResult = {
      ok: true,
      channel: { id: "C_PROJ", properties: {} },
    } as SlackResult;
    let canvasesSectionsLookupResponse: SlackResult = {
      ok: true,
      sections: [],
    } as SlackResult;
    let filesInfoResponse: SlackResult = {
      ok: true,
      file: {
        id: "F_CANVAS",
        title: "Canvas",
        comments_count: 0,
      },
      comments: [],
      response_metadata: { next_cursor: "" },
    } as SlackResult;
    const presenceResponses = new Map<string, SlackResult>();
    const dndResponses = new Map<string, SlackResult>();

    const slack = vi.fn<
      (method: string, token: string, body?: Record<string, unknown>) => Promise<SlackResult>
    >(async (method, token, body) => {
      if (method === "chat.postMessage") {
        return {
          ok: true,
          token,
          body,
          message: { ts: "123.456" },
        } as SlackResult;
      }

      if (method === "chat.scheduleMessage") {
        return {
          ok: true,
          token,
          body,
          channel: typeof body?.channel === "string" ? body.channel : "C123",
          post_at: typeof body?.post_at === "number" ? body.post_at : 1_800_000_000,
          scheduled_message_id: "Q12345",
        } as SlackResult;
      }

      if (method === "chat.delete") {
        return {
          ok: true,
          token,
          body,
          channel: typeof body?.channel === "string" ? body.channel : "C123",
          ts: typeof body?.ts === "string" ? body.ts : "123.456",
        } as SlackResult;
      }

      if (method === "views.open" || method === "views.push" || method === "views.update") {
        return {
          ok: true,
          token,
          body,
          view: {
            id: "V123",
            external_id: typeof body?.external_id === "string" ? body.external_id : undefined,
            hash: "hash-123",
            ...(body?.view as Record<string, unknown> | undefined),
          },
        } as SlackResult;
      }

      if (method === "pins.add" || method === "pins.remove") {
        return {
          ok: true,
          token,
          body,
        } as SlackResult;
      }

      if (method === "bookmarks.add") {
        return {
          ok: true,
          token,
          body,
          bookmark: {
            id: "Bk123",
            title: body?.title,
            link: body?.link,
            emoji: body?.emoji,
          },
        } as SlackResult;
      }

      if (method === "bookmarks.list") {
        return {
          ok: true,
          token,
          body,
          bookmarks: [
            {
              id: "Bk123",
              title: "Repo",
              link: "https://github.com/gugu91/extensions",
              emoji: ":rabbit:",
            },
          ],
        } as SlackResult;
      }

      if (method === "bookmarks.remove") {
        return {
          ok: true,
          token,
          body,
        } as SlackResult;
      }

      if (method === "users.getPresence") {
        const user = typeof body?.user === "string" ? body.user : "";
        return (
          presenceResponses.get(user) ??
          ({ ok: true, token, body, presence: "away", online: false } as SlackResult)
        );
      }

      if (method === "dnd.info") {
        const user = typeof body?.user === "string" ? body.user : "";
        return (
          dndResponses.get(user) ??
          ({ ok: true, token, body, dnd_enabled: false, snooze_enabled: false } as SlackResult)
        );
      }

      if (method === "users.list") {
        return usersListResponse;
      }

      if (method === "conversations.replies" && conversationsRepliesResponses.length > 0) {
        return conversationsRepliesResponses.shift() as SlackResult;
      }

      if (method === "conversations.create") {
        const name = typeof body?.name === "string" ? body.name : "test-channel";
        return {
          ok: true,
          channel: { id: "C_PROJ", name },
        } as unknown as SlackResult;
      }

      if (method === "conversations.canvases.create") {
        return { ok: true, canvas_id: "CANVAS_1" } as unknown as SlackResult;
      }

      if (method === "conversations.info") {
        return conversationsInfoResponse;
      }

      if (method === "canvases.sections.lookup") {
        return canvasesSectionsLookupResponse;
      }

      if (method === "files.info") {
        return filesInfoResponse;
      }

      if (method === "files.getUploadURLExternal") {
        return {
          ok: true,
          upload_url: `https://uploads.slack.test/${typeof body?.filename === "string" ? body.filename : "file"}`,
          file_id: "F_UPLOAD",
        } as SlackResult;
      }

      if (method === "files.completeUploadExternal") {
        const channelId = typeof body?.channel_id === "string" ? body.channel_id : "C_UPLOAD";
        const uploadTs = typeof body?.thread_ts === "string" ? body.thread_ts : "1712345678.999999";
        return {
          ok: true,
          body,
          files: [
            {
              id: "F_UPLOAD",
              permalink: "https://slack.test/files/F_UPLOAD",
              shares: { public: { [channelId]: [{ ts: uploadTs }] } },
            },
          ],
        } as SlackResult;
      }

      return {
        ok: true,
        token,
        body,
        messages: [],
      } as SlackResult;
    });

    let resolveThreadChannel: (threadTs: string | undefined) => Promise<string | null> = async () =>
      null;
    const noteThreadReply = vi.fn();
    const clearPendingAttention = vi.fn();
    const requireToolPolicy = vi.fn();
    let pinetDeliveryAvailable = false;
    const sendPinetSlackMessage = vi.fn(async (input: SlackPinetDeliveryInput) => ({
      adapter: "slack",
      messageId: 42,
      threadId: input.threadId,
      channel: input.channel,
      source: "slack",
    }));

    registerSlackTools(pi, {
      getBotToken: () => botToken,
      getDefaultChannel: () => defaultChannel,
      getSecurityPrompt: () => securityPrompt,
      inbox,
      slack,
      getAgentName: () => "Radiant Koala",
      getAgentEmoji: () => "🐨",
      getAgentOwnerToken: () => "owner:test-token",
      getLastDmChannel: () => lastDmChannel,
      updateBadge: () => {},
      resolveUser: async (userId) => resolveUser(userId),
      threadContext: {
        resolveThreadChannel: (threadTs) => resolveThreadChannel(threadTs),
        noteThreadReply,
        clearPendingAttention,
      },
      resolveChannel: async (nameOrId) => `resolved:${nameOrId}`,
      rememberChannel: () => {},
      requireToolPolicy,
      registerConfirmationRequest: () => ({ status: "created" }),
      getBotUserId: () => "U_BOT",
      pinetDelivery: {
        isAvailable: () => pinetDeliveryAvailable,
        sendSlackMessage: sendPinetSlackMessage,
      },
    });

    const registeredTools = new Map(tools);
    const slackDispatcher = tools.get("slack");
    if (!slackDispatcher) {
      throw new Error("Expected slack dispatcher to be registered");
    }
    const legacyActions = [
      "modal_open",
      "modal_push",
      "modal_update",
      "react",
      "upload",
      "file",
      "read",
      "presence",
      "export",
      "create_channel",
      "project_create",
      "post_channel",
      "delete",
      "pin",
      "bookmark",
      "schedule",
      "read_channel",
      "canvas_comments_read",
      "canvas_create",
      "canvas_update",
      "confirm_action",
    ];
    for (const action of legacyActions) {
      tools.set(`slack_${action}`, {
        name: `slack_${action}`,
        execute: async (_id, params) =>
          unwrapSlackDispatcherResponse(
            await slackDispatcher.execute(`slack:${action}`, { action, args: params }),
          ),
      });
    }

    return {
      inbox,
      slack,
      tools,
      registeredTools,
      setBotToken: (value: string) => {
        botToken = value;
      },
      setDefaultChannel: (value: string | undefined) => {
        defaultChannel = value;
      },
      setSecurityPrompt: (value: string) => {
        securityPrompt = value;
      },
      setLastDmChannel: (value: string | null) => {
        lastDmChannel = value;
      },
      setResolveUser: (fn: (userId: string) => Promise<string>) => {
        resolveUser = fn;
      },
      setConversationsReplies: (responses: SlackResult[]) => {
        conversationsRepliesResponses = [...responses];
      },
      setUsersListResponse: (response: SlackResult) => {
        usersListResponse = response;
      },
      setConversationsInfoResponse: (response: SlackResult) => {
        conversationsInfoResponse = response;
      },
      setCanvasesSectionsLookupResponse: (response: SlackResult) => {
        canvasesSectionsLookupResponse = response;
      },
      setFilesInfoResponse: (response: SlackResult) => {
        filesInfoResponse = response;
      },
      setPresenceResponse: (userId: string, response: SlackResult) => {
        presenceResponses.set(userId, response);
      },
      setDndResponse: (userId: string, response: SlackResult) => {
        dndResponses.set(userId, response);
      },
      setResolveThreadChannel: (fn: (threadTs: string | undefined) => Promise<string | null>) => {
        resolveThreadChannel = fn;
      },
      noteThreadReply,
      clearPendingAttention,
      requireToolPolicy,
      setPinetDeliveryAvailable: (value: boolean) => {
        pinetDeliveryAvailable = value;
      },
      sendPinetSlackMessage,
    };
  }

  it("reads the latest security prompt when slack_inbox executes", async () => {
    const { inbox, tools, setSecurityPrompt } = setup();
    inbox.push({
      channel: "D123",
      threadTs: "123.456",
      userId: "U123",
      text: "hello",
      timestamp: "123.456",
    });

    setSecurityPrompt("UPDATED SECURITY PROMPT");

    const response = await tools.get("slack_inbox")!.execute("tool-1", {});
    expect(response.content?.[0]?.text).toContain("UPDATED SECURITY PROMPT");
    expect(response.content?.[0]?.text).not.toContain("INITIAL SECURITY PROMPT");
  });

  it("reads the latest bot token and default channel when slack_post_channel executes", async () => {
    const { slack, tools, setBotToken, setDefaultChannel } = setup();
    setBotToken("xoxb-reloaded");
    setDefaultChannel("ops-alerts");

    await tools.get("slack_post_channel")!.execute("tool-2", {
      text: "hello from reloaded config",
    });

    expect(slack).toHaveBeenCalledWith(
      "chat.postMessage",
      "xoxb-reloaded",
      expect.objectContaining({
        channel: "resolved:ops-alerts",
        text: "hello from reloaded config",
      }),
    );
  });

  it("deletes a single bot-posted message when confirm=true", async () => {
    const { slack, tools, setBotToken, setDefaultChannel, requireToolPolicy } = setup();
    setBotToken("xoxb-reloaded");
    setDefaultChannel("ops-alerts");

    const response = await tools.get("slack_delete")!.execute("tool-2b", {
      ts: "123.789",
      confirm: true,
    });

    expect(requireToolPolicy).toHaveBeenCalledWith(
      "slack:delete",
      undefined,
      "channel=ops-alerts | thread_ts= | ts=123.789 | thread=false",
    );
    expect(slack).toHaveBeenCalledWith("chat.delete", "xoxb-reloaded", {
      channel: "resolved:ops-alerts",
      ts: "123.789",
    });
    expect(response.content?.[0]?.text).toContain("Deleted message 123.789");
    expect(response.details).toMatchObject({
      channel: "resolved:ops-alerts",
      ts: "123.789",
      thread: false,
      deleted_count: 1,
      deleted_ts: ["123.789"],
    });
  });

  it("requires confirm=true before deleting Slack messages", async () => {
    const { tools, setDefaultChannel, requireToolPolicy } = setup();
    setDefaultChannel("ops-alerts");

    await expect(
      tools.get("slack_delete")!.execute("tool-2c", {
        ts: "123.789",
      }),
    ).rejects.toThrow(
      "Deleting Slack messages is irreversible. Re-run with confirm=true once you've verified the target.",
    );
    expect(requireToolPolicy).not.toHaveBeenCalled();
  });

  it("uses read-through thread resolution for slack_read", async () => {
    const { slack, tools, setResolveThreadChannel } = setup();
    setResolveThreadChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });

    await tools.get("slack_read")!.execute("tool-3", { thread_ts: "123.456" });

    expect(slack).toHaveBeenCalledWith("conversations.replies", "xoxb-initial", {
      channel: "C-DB",
      ts: "123.456",
      limit: 20,
    });
  });

  it("returns compact Slack read previews by default and full text on request", async () => {
    const { tools, setConversationsReplies, setResolveThreadChannel, setResolveUser } = setup();
    setResolveThreadChannel(async () => "C-DB");
    setResolveUser(async (userId: string) => (userId === "U123" ? "Ada" : userId));
    const longText = `${"status ".repeat(40)}done`;
    setConversationsReplies([
      {
        ok: true,
        messages: [{ ts: "123.001", user: "U123", text: longText }],
      } as SlackResult,
      {
        ok: true,
        messages: [{ ts: "123.001", user: "U123", text: longText }],
      } as SlackResult,
    ]);

    const compact = await tools.get("slack_read")!.execute("tool-read-compact", {
      thread_ts: "123.456",
    });
    expect(compact.content?.[0]?.text).toContain("Use args.full=true for exact message text.");
    expect(compact.content?.[0]?.text).not.toContain(longText);
    expect(compact.details?.messages).toEqual([
      expect.objectContaining({
        ts: "123.001",
        user: "Ada",
        preview: expect.stringContaining("status"),
        files: [],
      }),
    ]);

    const full = await tools.get("slack_read")!.execute("tool-read-full", {
      thread_ts: "123.456",
      full: true,
    });
    expect(full.content?.[0]?.text).toContain(longText);
    expect(full.details?.messages).toEqual([
      expect.objectContaining({ ts: "123.001", user: "Ada", text: longText, files: [] }),
    ]);
  });

  it("downloads Slack read message attachments to temp cache by default", async () => {
    const { tools, setConversationsReplies, setResolveThreadChannel, setFilesInfoResponse } =
      setup();
    setResolveThreadChannel(async () => "C-DB");
    const messageWithFile = {
      ts: "123.001",
      user: "U123",
      text: "See attached",
      files: [
        {
          id: "F_READ",
          name: "brief.pdf",
          mimetype: "application/pdf",
          filetype: "pdf",
          pretty_type: "PDF",
          size: 8,
          url_private_download: "https://files.slack.com/private/read-brief",
        },
      ],
    };
    setConversationsReplies([
      {
        ok: true,
        messages: [messageWithFile],
      } as SlackResult,
      {
        ok: true,
        messages: [messageWithFile],
      } as SlackResult,
    ]);
    setFilesInfoResponse({
      ok: true,
      file: {
        id: "F_READ",
        name: "brief.pdf",
        mimetype: "application/pdf",
        filetype: "pdf",
        pretty_type: "PDF",
        size: 8,
        url_private_download: "https://files.slack.com/private/read-brief",
      },
    } as SlackResult);
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toEqual({ Authorization: "Bearer xoxb-initial" });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => Buffer.from("pdf body").buffer,
        text: async () => "",
      };
    });
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const response = await tools.get("slack_read")!.execute("tool-read-file", {
        thread_ts: "123.456",
      });
      const text = response.content?.[0]?.text ?? "";
      expect(text).toContain("[file downloaded] F_READ brief.pdf (PDF) ->");
      expect(text).toContain("File attachments: 1 downloaded to the local temp cache.");
      expect(text).not.toContain("files.slack.com/private");
      expect(response.details).toMatchObject({
        downloadedFilesCount: 1,
        failedFilesCount: 0,
        messages: [
          expect.objectContaining({
            files: [
              expect.objectContaining({
                fileId: "F_READ",
                filename: "brief.pdf",
                downloadStatus: "downloaded",
                path: expect.stringContaining("pi-slack-files"),
                sha256: expect.any(String),
              }),
            ],
          }),
        ],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses compact dispatcher text by default and JSON when requested", async () => {
    const { registeredTools, setConversationsReplies, setResolveThreadChannel, setResolveUser } =
      setup();
    setResolveThreadChannel(async () => "C-DB");
    setResolveUser(async (userId: string) => (userId === "U123" ? "Ada" : userId));
    setConversationsReplies([
      {
        ok: true,
        messages: [{ ts: "123.001", user: "U123", text: "compact dispatcher body" }],
      } as SlackResult,
      {
        ok: true,
        messages: [{ ts: "123.002", user: "U123", text: "json dispatcher body" }],
      } as SlackResult,
    ]);
    const dispatcher = registeredTools.get("slack")!;

    const compact = await dispatcher.execute("tool-dispatch-read-compact", {
      action: "read",
      args: { thread_ts: "123.456" },
    });
    expect(compact.content?.[0]?.text).toContain("Ada: compact dispatcher body");
    expect(compact.content?.[0]?.text).not.toContain('"status": "succeeded"');

    const json = await dispatcher.execute("tool-dispatch-read-json", {
      action: "read",
      args: { thread_ts: "123.456", format: "json" },
    });
    expect(json.content?.[0]?.text).toContain('"status": "succeeded"');
    expect(json.content?.[0]?.text).toContain("json dispatcher body");
  });

  it("uses thread channel resolution for slack_delete", async () => {
    const { slack, tools, setResolveThreadChannel } = setup();
    setResolveThreadChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });

    await tools.get("slack_delete")!.execute("tool-3b", {
      ts: "123.789",
      thread_ts: "123.456",
      confirm: true,
    });

    expect(slack).toHaveBeenCalledWith("chat.delete", "xoxb-initial", {
      channel: "C-DB",
      ts: "123.789",
    });
  });

  it("reports presence and dnd status for a single user", async () => {
    const { tools, setPresenceResponse, setDndResponse, setResolveUser } = setup();
    setResolveUser(async (userId: string) => (userId === "U123" ? "Alice" : userId));
    setPresenceResponse("U123", {
      ok: true,
      presence: "active",
      online: true,
      auto_away: false,
      manual_away: false,
      connection_count: 2,
      last_activity: 1_700_000_000,
    } as SlackResult);
    setDndResponse("U123", {
      ok: true,
      dnd_enabled: true,
      next_dnd_end_ts: 1_800_000_000,
      snooze_enabled: false,
    } as SlackResult);

    const response = await tools.get("slack_presence")!.execute("tool-4", { user: "U123" });

    expect(response.content?.[0]?.text).toContain("Alice (U123) | presence: active");
    expect(response.content?.[0]?.text).toContain("DND: on until 2027-01-15T08:00:00.000Z");
    expect(response.details?.count).toBe(1);
  });

  it("supports batch presence lookups by name via users.list", async () => {
    const { slack, tools, setUsersListResponse, setPresenceResponse, setDndResponse } = setup();
    setUsersListResponse({
      ok: true,
      members: [
        {
          id: "U123",
          name: "alice",
          real_name: "Alice Example",
          profile: { display_name: "Ali" },
        },
        {
          id: "U456",
          name: "bob",
          real_name: "Bob Example",
          profile: { display_name: "Bobby" },
        },
      ],
      response_metadata: { next_cursor: "" },
    } as SlackResult);
    setPresenceResponse("U123", { ok: true, presence: "active", online: true } as SlackResult);
    setPresenceResponse("U456", { ok: true, presence: "away", online: false } as SlackResult);
    setDndResponse("U123", {
      ok: true,
      dnd_enabled: false,
      snooze_enabled: false,
    } as SlackResult);
    setDndResponse("U456", {
      ok: true,
      dnd_enabled: false,
      snooze_enabled: false,
    } as SlackResult);

    const response = await tools.get("slack_presence")!.execute("tool-5", {
      users: ["Ali", "@bob"],
    });

    expect(slack).toHaveBeenCalledWith("users.list", "xoxb-initial", {
      limit: 1000,
    });
    expect(response.content?.[0]?.text).toContain("Ali (U123)");
    expect(response.content?.[0]?.text).toContain("Bobby (U456)");
    expect(response.details?.count).toBe(2);
  });

  it("caches presence lookups briefly to avoid duplicate Slack API calls", async () => {
    const { slack, tools, setPresenceResponse, setDndResponse, setResolveUser } = setup();
    setResolveUser(async (userId: string) => userId);
    setPresenceResponse("U123", { ok: true, presence: "active", online: true } as SlackResult);
    setDndResponse("U123", {
      ok: true,
      dnd_enabled: false,
      snooze_enabled: false,
    } as SlackResult);

    await tools.get("slack_presence")!.execute("tool-6", { user: "U123" });
    await tools.get("slack_presence")!.execute("tool-7", { user: "U123" });

    expect(slack.mock.calls.filter(([method]) => method === "users.getPresence")).toHaveLength(1);
    expect(slack.mock.calls.filter(([method]) => method === "dnd.info")).toHaveLength(1);
  });

  it("adds reactions with normalized emoji names via slack_react", async () => {
    const { slack, tools, setResolveThreadChannel } = setup();
    setResolveThreadChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });

    const response = await tools.get("slack_react")!.execute("tool-4", {
      emoji: "✅",
      thread_ts: "123.456",
    });

    expect(slack).toHaveBeenCalledWith("reactions.add", "xoxb-initial", {
      channel: "C-DB",
      timestamp: "123.456",
      name: "white_check_mark",
    });
    expect(response.content?.[0]?.text).toContain("Added :white_check_mark:");
  });

  it("reads the latest bot token and default channel when slack_schedule executes", async () => {
    const { slack, tools, setBotToken, setDefaultChannel } = setup();
    setBotToken("xoxb-reloaded");
    setDefaultChannel("ops-alerts");

    await tools.get("slack_schedule")!.execute("tool-5", {
      text: "hello from the future",
      at: "2030-01-02T03:04:05Z",
    });

    expect(slack).toHaveBeenCalledWith(
      "chat.scheduleMessage",
      "xoxb-reloaded",
      expect.objectContaining({
        channel: "resolved:ops-alerts",
        text: "hello from the future",
        post_at: Math.floor(Date.parse("2030-01-02T03:04:05Z") / 1000),
      }),
    );
  });

  it("uses thread channel resolution for slack_schedule delays", async () => {
    const { slack, tools, setResolveThreadChannel } = setup();
    setResolveThreadChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-02T14:00:00Z"));
    try {
      await tools.get("slack_schedule")!.execute("tool-6", {
        text: "follow up later",
        thread_ts: "123.456",
        delay: "30m",
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(slack).toHaveBeenCalledWith(
      "chat.scheduleMessage",
      "xoxb-initial",
      expect.objectContaining({
        channel: "C-DB",
        thread_ts: "123.456",
        text: "follow up later",
        post_at: Math.floor(Date.parse("2026-04-02T14:30:00.000Z") / 1000),
      }),
    );
  });

  it("deletes thread replies before deleting the root message", async () => {
    const { slack, tools, setConversationsReplies } = setup();
    setConversationsReplies([
      {
        ok: true,
        messages: [
          {
            ts: "123.456",
            metadata: {
              event_type: "pi_agent_msg",
              event_payload: { agent_owner: "owner:test-token" },
            },
          },
          {
            ts: "123.457",
            metadata: {
              event_type: "pi_agent_msg",
              event_payload: { agent_owner: "owner:test-token" },
            },
          },
          {
            ts: "123.458",
            metadata: {
              event_type: "pi_agent_msg",
              event_payload: { agent_owner: "owner:test-token" },
            },
          },
        ],
        response_metadata: { next_cursor: "" },
      } as SlackResult,
    ]);

    const response = await tools.get("slack_delete")!.execute("tool-6b", {
      channel: "deployments",
      ts: "123.456",
      thread: true,
      confirm: true,
    });

    expect(slack).toHaveBeenNthCalledWith(1, "conversations.replies", "xoxb-initial", {
      channel: "resolved:deployments",
      ts: "123.456",
      limit: 1000,
      include_all_metadata: true,
    });
    expect(slack).toHaveBeenNthCalledWith(2, "chat.delete", "xoxb-initial", {
      channel: "resolved:deployments",
      ts: "123.457",
    });
    expect(slack).toHaveBeenNthCalledWith(3, "chat.delete", "xoxb-initial", {
      channel: "resolved:deployments",
      ts: "123.458",
    });
    expect(slack).toHaveBeenNthCalledWith(4, "chat.delete", "xoxb-initial", {
      channel: "resolved:deployments",
      ts: "123.456",
    });
    expect(response.details).toMatchObject({
      channel: "resolved:deployments",
      ts: "123.456",
      thread: true,
      deleted_count: 3,
      deleted_ts: ["123.457", "123.458", "123.456"],
    });
  });

  it("rejects whole-thread deletion when the thread includes other authors", async () => {
    const { slack, tools, setConversationsReplies } = setup();
    setConversationsReplies([
      {
        ok: true,
        messages: [
          { ts: "123.456", user: "U_BOT" },
          { ts: "123.457", user: "U_HUMAN" },
        ],
        response_metadata: { next_cursor: "" },
      } as SlackResult,
    ]);

    await expect(
      tools.get("slack_delete")!.execute("tool-6c", {
        channel: "deployments",
        ts: "123.456",
        thread: true,
        confirm: true,
      }),
    ).rejects.toThrow(
      "Cannot delete thread 123.456 because it includes message(s) not posted by the current bot: 123.457. Delete those messages individually instead.",
    );
    expect(slack.mock.calls.filter(([method]) => method === "chat.delete")).toHaveLength(0);
  });

  it("requires the thread root ts when deleting an entire thread", async () => {
    const { tools, setConversationsReplies } = setup();
    setConversationsReplies([
      {
        ok: true,
        messages: [
          { ts: "123.000", user: "U_BOT" },
          { ts: "123.789", user: "U_BOT" },
        ],
        response_metadata: { next_cursor: "" },
      } as SlackResult,
    ]);

    await expect(
      tools.get("slack_delete")!.execute("tool-6d", {
        channel: "deployments",
        ts: "123.789",
        thread: true,
        confirm: true,
      }),
    ).rejects.toThrow("When thread=true, ts must be the thread root timestamp.");
  });

  it("handles already_pinned gracefully", async () => {
    const { slack, tools, setResolveThreadChannel } = setup();
    setResolveThreadChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });
    slack.mockImplementationOnce(async () => {
      throw new Error("Slack pins.add: already_pinned");
    });

    const response = await tools.get("slack_pin")!.execute("tool-7", {
      action: "pin",
      message_ts: "123.789",
      thread_ts: "123.456",
    });

    expect(slack).toHaveBeenCalledWith("pins.add", "xoxb-initial", {
      channel: "C-DB",
      timestamp: "123.789",
    });
    expect(response.details?.status).toBe("already_pinned");
  });

  it("handles no_pin gracefully when unpinning", async () => {
    const { slack, tools, setDefaultChannel } = setup();
    setDefaultChannel("ops-alerts");
    slack.mockImplementationOnce(async () => {
      throw new Error("Slack pins.remove: no_pin");
    });

    const response = await tools.get("slack_pin")!.execute("tool-8", {
      action: "unpin",
      message_ts: "123.789",
    });

    expect(slack).toHaveBeenCalledWith("pins.remove", "xoxb-initial", {
      channel: "resolved:ops-alerts",
      timestamp: "123.789",
    });
    expect(response.details?.status).toBe("not_pinned");
  });

  it("adds channel bookmarks", async () => {
    const { slack, tools, setDefaultChannel } = setup();
    setDefaultChannel("docs");

    const response = await tools.get("slack_bookmark")!.execute("tool-9", {
      action: "add",
      title: "Repo",
      url: "https://github.com/gugu91/extensions",
      emoji: ":rocket:",
    });

    expect(slack).toHaveBeenCalledWith(
      "bookmarks.add",
      "xoxb-initial",
      expect.objectContaining({
        channel_id: "resolved:docs",
        title: "Repo",
        type: "link",
        link: "https://github.com/gugu91/extensions",
        emoji: ":rocket:",
      }),
    );
    expect(response.details?.bookmark_id).toBe("Bk123");
  });

  it("lists bookmarks from the resolved thread channel", async () => {
    const { slack, tools, setResolveThreadChannel } = setup();
    setResolveThreadChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });

    const response = await tools.get("slack_bookmark")!.execute("tool-10", {
      action: "list",
      thread_ts: "123.456",
    });

    expect(slack).toHaveBeenCalledWith("bookmarks.list", "xoxb-initial", {
      channel_id: "C-DB",
    });
    expect(response.content?.[0]?.text).toContain("Bk123");
  });

  it("handles missing bookmarks gracefully when removing", async () => {
    const { slack, tools, setDefaultChannel } = setup();
    setDefaultChannel("docs");
    slack.mockImplementationOnce(async () => {
      throw new Error("Slack bookmarks.remove: not_found");
    });

    const response = await tools.get("slack_bookmark")!.execute("tool-11", {
      action: "remove",
      bookmark_id: "Bk404",
    });

    expect(slack).toHaveBeenCalledWith("bookmarks.remove", "xoxb-initial", {
      channel_id: "resolved:docs",
      bookmark_id: "Bk404",
    });
    expect(response.details?.status).toBe("not_found");
  });

  it("exports paginated thread content as markdown", async () => {
    const { slack, tools, setConversationsReplies, setResolveThreadChannel, setResolveUser } =
      setup();
    setResolveThreadChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });
    setResolveUser(async (userId: string) => ({ U123: "alice", U456: "bob" })[userId] ?? userId);
    setConversationsReplies([
      {
        ok: true,
        messages: [
          {
            ts: "123.456",
            user: "U123",
            text: "Hello <@U456>",
          },
        ],
        response_metadata: { next_cursor: "cursor-1" },
      } as SlackResult,
      {
        ok: true,
        messages: [
          {
            ts: "123.789",
            user: "U456",
            text: "See <https://example.com|the doc>",
            files: [
              {
                title: "incident.md",
                filetype: "markdown",
                permalink: "https://files.example/incident.md",
              },
            ],
          },
        ],
        response_metadata: { next_cursor: "" },
      } as SlackResult,
    ]);

    const response = await tools.get("slack_export")!.execute("tool-12", {
      thread_ts: "123.456",
      format: "markdown",
    });

    expect(slack).toHaveBeenNthCalledWith(1, "conversations.replies", "xoxb-initial", {
      channel: "C-DB",
      ts: "123.456",
      limit: 1000,
    });
    expect(slack).toHaveBeenNthCalledWith(2, "conversations.replies", "xoxb-initial", {
      channel: "C-DB",
      ts: "123.456",
      limit: 1000,
      cursor: "cursor-1",
    });
    expect(response.content?.[0]?.text).toContain("# Slack Thread Export");
    expect(response.content?.[0]?.text).toContain("Hello @bob");
    expect(response.content?.[0]?.text).toContain("[the doc](https://example.com)");
    expect(response.content?.[0]?.text).toContain(
      "incident.md (markdown) — https://files.example/incident.md",
    );
    expect(response.details?.count).toBe(2);
  });

  it("redacts private Slack file URLs from markdown, plain, and JSON exports", async () => {
    const { tools, setConversationsReplies, setResolveThreadChannel } = setup();
    setResolveThreadChannel(async () => "C-DB");

    for (const format of ["markdown", "plain", "json"]) {
      setConversationsReplies([
        {
          ok: true,
          messages: [
            {
              ts: "123.456",
              user: "U123",
              text: "attached",
              files: [
                {
                  id: "F_PRIVATE",
                  title: "private.pdf",
                  filetype: "pdf",
                  url_private_download:
                    "https://files.slack.com/files-pri/T/F_PRIVATE/download/doc",
                  url_private: "https://files.slack.com/files-pri/T/F_PRIVATE/fallback/doc",
                },
              ],
            },
          ],
          response_metadata: { next_cursor: "" },
        } as SlackResult,
      ]);

      const response = await tools.get("slack_export")!.execute(`tool-export-redaction-${format}`, {
        thread_ts: "123.456",
        format,
      });
      const text = response.content?.[0]?.text ?? "";

      expect(text).toContain("F_PRIVATE");
      expect(text).toContain("private.pdf");
      expect(text).not.toContain("files-pri");
      expect(text).not.toContain("url_private");
      expect(text).not.toContain("download/doc");
    }
  });

  it("filters exported threads by oldest/latest boundaries", async () => {
    const { tools, setConversationsReplies, setDefaultChannel } = setup();
    setDefaultChannel("docs");
    setConversationsReplies([
      {
        ok: true,
        messages: [
          { ts: "100.000001", user: "U100", text: "too early" },
          { ts: "200.000002", user: "U200", text: "keep me" },
          { ts: "300.000003", user: "U300", text: "too late" },
        ],
        response_metadata: { next_cursor: "" },
      } as SlackResult,
    ]);

    const response = await tools.get("slack_export")!.execute("tool-13", {
      thread_ts: "100.000001",
      format: "plain",
      oldest: "150",
      latest: "250",
      channel: "docs",
    });

    expect(response.content?.[0]?.text).toContain("keep me");
    expect(response.content?.[0]?.text).not.toContain("too early");
    expect(response.content?.[0]?.text).not.toContain("too late");
    expect(response.details?.count).toBe(1);
  });

  it("keeps slack_export format separate from dispatcher response_format", async () => {
    const { registeredTools, setConversationsReplies, setResolveThreadChannel, setResolveUser } =
      setup();
    setResolveThreadChannel(async () => "C-DB");
    setResolveUser(async (userId: string) => (userId === "U123" ? "alice" : userId));
    setConversationsReplies([
      {
        ok: true,
        messages: [{ ts: "123.456", user: "U123", text: "export json body" }],
        response_metadata: { next_cursor: "" },
      } as SlackResult,
      {
        ok: true,
        messages: [{ ts: "123.456", user: "U123", text: "export envelope body" }],
        response_metadata: { next_cursor: "" },
      } as SlackResult,
    ]);
    const dispatcher = registeredTools.get("slack")!;

    const exportJson = await dispatcher.execute("tool-export-json", {
      action: "export",
      args: { thread_ts: "123.456", format: "json" },
    });
    expect(exportJson.content?.[0]?.text).toContain("export json body");
    expect(exportJson.content?.[0]?.text).toContain('"messages"');
    expect(exportJson.content?.[0]?.text).not.toContain('"status": "succeeded"');

    const envelopeJson = await dispatcher.execute("tool-export-response-json", {
      action: "export",
      args: { thread_ts: "123.456", format: "json", response_format: "json" },
    });
    expect(envelopeJson.content?.[0]?.text).toContain('"status": "succeeded"');
    expect(envelopeJson.content?.[0]?.text).toContain("export envelope body");
  });

  it("sends slack_send to the configured default channel when no thread context exists", async () => {
    const { slack, tools, setDefaultChannel, setLastDmChannel, noteThreadReply } = setup();
    setDefaultChannel("ops-alerts");
    setLastDmChannel("D-STALE");

    const response = await tools.get("slack_send")!.execute("tool-send-default-channel", {
      text: "Default channel update",
    });

    expect(slack).toHaveBeenCalledWith(
      "chat.postMessage",
      "xoxb-initial",
      expect.objectContaining({
        channel: "resolved:ops-alerts",
        text: "Default channel update",
      }),
    );
    expect(response.content?.[0]?.text).toBe(
      "Sent message (thread_ts: 123.456). Use this to continue the conversation.",
    );
    expect(response.details).toMatchObject({
      ts: "123.456",
      channel: "resolved:ops-alerts",
      delivery: "slack",
    });
    expect(noteThreadReply).toHaveBeenCalledWith("123.456", "resolved:ops-alerts");
  });

  it("keeps a clear slack_send error when no thread context or default channel exists", async () => {
    const { slack, tools, setDefaultChannel } = setup();
    setDefaultChannel(undefined);

    await expect(
      tools.get("slack_send")!.execute("tool-send-no-default-channel", {
        text: "No target update",
      }),
    ).rejects.toThrow(
      "No active Slack thread and no defaultChannel configured in settings.json. Set slack-bridge.defaultChannel or use the slack dispatcher action post_channel with a channel.",
    );

    expect(slack).not.toHaveBeenCalledWith(
      "chat.postMessage",
      expect.any(String),
      expect.any(Object),
    );
  });

  it("includes blocks when slack_send posts a rich message", async () => {
    const { slack, tools, setResolveThreadChannel, noteThreadReply, clearPendingAttention } =
      setup();
    setResolveThreadChannel(async () => "D123");

    await tools.get("slack_send")!.execute("tool-14", {
      thread_ts: "123.456",
      text: "Deploy complete",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "*Deploy complete*" } },
        { type: "actions", elements: [] },
      ],
    });

    expect(slack).toHaveBeenCalledWith(
      "chat.postMessage",
      "xoxb-initial",
      expect.objectContaining({
        channel: "D123",
        thread_ts: "123.456",
        text: "Deploy complete",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "*Deploy complete*" } },
          { type: "actions", elements: [] },
        ],
      }),
    );
    expect(noteThreadReply).toHaveBeenCalledWith("123.456", "D123");
    expect(clearPendingAttention).toHaveBeenCalledWith("123.456");
  });

  it("includes blocks when slack_post_channel posts a rich message", async () => {
    const { slack, tools } = setup();

    await tools.get("slack_post_channel")!.execute("tool-15", {
      channel: "deployments",
      text: "Status update",
      blocks: [{ type: "header", text: { type: "plain_text", text: "Deploy status" } }],
    });

    expect(slack).toHaveBeenCalledWith(
      "chat.postMessage",
      "xoxb-initial",
      expect.objectContaining({
        channel: "resolved:deployments",
        text: "Status update",
        blocks: [{ type: "header", text: { type: "plain_text", text: "Deploy status" } }],
      }),
    );
  });

  it("prefers Pinet delivery for slack_send thread replies when available", async () => {
    const {
      slack,
      tools,
      setResolveThreadChannel,
      setPinetDeliveryAvailable,
      sendPinetSlackMessage,
    } = setup();
    setResolveThreadChannel(async () => "D123");
    setPinetDeliveryAvailable(true);

    const response = await tools.get("slack_send")!.execute("tool-pinet-send", {
      thread_ts: "123.456",
      text: "Steady reply",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Steady reply*" } }],
    });

    expect(sendPinetSlackMessage).toHaveBeenCalledWith({
      threadId: "123.456",
      channel: "D123",
      text: "Steady reply",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Steady reply*" } }],
    });
    expect(slack).not.toHaveBeenCalledWith(
      "chat.postMessage",
      expect.any(String),
      expect.any(Object),
    );
    expect(response.details).toMatchObject({
      thread_ts: "123.456",
      channel: "D123",
      delivery: "pinet",
      adapter: "slack",
      messageId: 42,
    });
    expect(response.details).not.toHaveProperty("ts");
  });

  it("passes local file attachments through slack_send Pinet thread delivery", async () => {
    const { tools, setResolveThreadChannel, setPinetDeliveryAvailable, sendPinetSlackMessage } =
      setup();
    setResolveThreadChannel(async () => "D123");
    setPinetDeliveryAvailable(true);

    await tools.get("slack_send")!.execute("tool-pinet-send-files", {
      thread_ts: "123.456",
      text: "See attached binary",
      files: [{ path: "/tmp/report.bin", filename: "report.bin", title: "Report" }],
    });

    expect(sendPinetSlackMessage).toHaveBeenCalledWith({
      threadId: "123.456",
      channel: "D123",
      text: "See attached binary",
      files: [{ path: "/tmp/report.bin", filename: "report.bin", title: "Report" }],
    });
  });

  it("sends direct Slack text and a binary file in one threaded external upload", async () => {
    const { slack, tools, setResolveThreadChannel, setPinetDeliveryAvailable } = setup();
    setResolveThreadChannel(async () => "D123");
    setPinetDeliveryAvailable(false);
    const dir = await mkdtemp(path.join(os.tmpdir(), "slack-send-file-test-"));
    const filePath = path.join(dir, "payload.bin");
    await writeFile(filePath, Buffer.from([0, 1, 2, 3]));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchImpl);
    try {
      await tools.get("slack_send")!.execute("tool-direct-send-files", {
        thread_ts: "123.456",
        text: "Here is the binary",
        files: [{ path: filePath, filename: "payload.bin" }],
      });
    } finally {
      vi.unstubAllGlobals();
      await rm(dir, { recursive: true, force: true });
    }

    expect(slack).toHaveBeenCalledWith(
      "files.completeUploadExternal",
      "xoxb-initial",
      expect.objectContaining({
        channel_id: "D123",
        thread_ts: "123.456",
        initial_comment: "Here is the binary",
        files: [{ id: "F_UPLOAD", title: "payload.bin" }],
      }),
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends slack_post_channel text and local files in one external upload", async () => {
    const { slack, tools } = setup();
    const dir = await mkdtemp(path.join(os.tmpdir(), "slack-post-channel-file-test-"));
    const filePath = path.join(dir, "evidence.bin");
    await writeFile(filePath, Buffer.from([4, 5, 6]));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const response = await tools.get("slack_post_channel")!.execute("tool-post-files", {
        channel: "deployments",
        text: "Deploy evidence",
        files: [{ path: filePath, filename: "evidence.bin", title: "Evidence" }],
      });
      expect(response.details).toMatchObject({
        channel: "resolved:deployments",
        delivery: "slack",
        filesCount: 1,
      });
    } finally {
      vi.unstubAllGlobals();
      await rm(dir, { recursive: true, force: true });
    }

    expect(slack).toHaveBeenCalledWith(
      "files.completeUploadExternal",
      "xoxb-initial",
      expect.objectContaining({
        channel_id: "resolved:deployments",
        initial_comment: "Deploy evidence",
        files: [{ id: "F_UPLOAD", title: "Evidence" }],
      }),
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("downloads Slack-hosted files through slack file action with safe descriptor output", async () => {
    const { tools, setFilesInfoResponse } = setup();
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "slack-file-action-test-"));
    setFilesInfoResponse({
      ok: true,
      file: {
        id: "FPDF",
        name: "brief.pdf",
        mimetype: "application/pdf",
        filetype: "pdf",
        pretty_type: "PDF",
        size: 8,
        url_private_download: "https://files.slack.com/private/brief",
      },
    } as SlackResult);
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toEqual({ Authorization: "Bearer xoxb-initial" });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => Buffer.from("pdf body").buffer,
        text: async () => "",
      };
    });
    vi.stubGlobal("fetch", fetchImpl);
    let response: ToolResponse;
    try {
      response = await tools.get("slack_file")!.execute("tool-file-download", {
        op: "download",
        file_id: "FPDF",
      });
    } finally {
      vi.unstubAllGlobals();
      await rm(cacheDir, { recursive: true, force: true });
    }

    expect(response!.details).toMatchObject({
      fileId: "FPDF",
      filename: "brief.pdf",
      mimetype: "application/pdf",
      filetype: "pdf",
    });
    expect(JSON.stringify(response!.details)).not.toContain("files.slack.com/private");
  });

  it("falls back to direct Slack delivery when Pinet thread delivery fails", async () => {
    const {
      slack,
      tools,
      setResolveThreadChannel,
      setPinetDeliveryAvailable,
      sendPinetSlackMessage,
    } = setup();
    setResolveThreadChannel(async () => "D123");
    setPinetDeliveryAvailable(true);
    sendPinetSlackMessage.mockRejectedValueOnce(new Error("broker unavailable"));

    const response = await tools.get("slack_send")!.execute("tool-pinet-fallback", {
      thread_ts: "123.456",
      text: "Fallback reply",
    });

    expect(sendPinetSlackMessage).toHaveBeenCalledOnce();
    expect(slack).toHaveBeenCalledWith(
      "chat.postMessage",
      "xoxb-initial",
      expect.objectContaining({
        channel: "D123",
        thread_ts: "123.456",
        text: "Fallback reply",
      }),
    );
    expect(response.details).toMatchObject({
      ts: "123.456",
      channel: "D123",
      delivery: "slack",
      fallbackReason: "broker unavailable",
    });
  });

  it("prefers Pinet delivery for threaded slack_post_channel messages", async () => {
    const { slack, tools, setPinetDeliveryAvailable, sendPinetSlackMessage } = setup();
    setPinetDeliveryAvailable(true);

    const response = await tools.get("slack_post_channel")!.execute("tool-pinet-channel", {
      channel: "deployments",
      thread_ts: "222.333",
      text: "Threaded status",
      files: [{ path: "/tmp/status.txt", filename: "status.txt" }],
    });

    expect(sendPinetSlackMessage).toHaveBeenCalledWith({
      threadId: "222.333",
      channel: "resolved:deployments",
      text: "Threaded status",
      files: [{ path: "/tmp/status.txt", filename: "status.txt" }],
    });
    expect(slack).not.toHaveBeenCalledWith(
      "chat.postMessage",
      expect.any(String),
      expect.any(Object),
    );
    expect(response.details).toMatchObject({
      thread_ts: "222.333",
      channel: "resolved:deployments",
      delivery: "pinet",
      filesCount: 1,
    });
    expect(response.details).not.toHaveProperty("ts");
  });

  it("falls back to direct Slack delivery when Pinet message.send times out", async () => {
    const {
      slack,
      tools,
      setResolveThreadChannel,
      setPinetDeliveryAvailable,
      sendPinetSlackMessage,
    } = setup();
    setResolveThreadChannel(async () => "D123");
    setPinetDeliveryAvailable(true);
    sendPinetSlackMessage.mockRejectedValueOnce(new Error("Request timed out: message.send"));

    const response = await tools.get("slack_send")!.execute("tool-pinet-timeout-fallback", {
      thread_ts: "123.456",
      text: "Timeout fallback reply",
    });

    expect(sendPinetSlackMessage).toHaveBeenCalledOnce();
    expect(slack).toHaveBeenCalledWith(
      "chat.postMessage",
      "xoxb-initial",
      expect.objectContaining({
        channel: "D123",
        thread_ts: "123.456",
        text: "Timeout fallback reply",
      }),
    );
    expect(response.details).toMatchObject({
      ts: "123.456",
      channel: "D123",
      delivery: "slack",
      fallbackReason: "Request timed out: message.send",
    });
  });

  it("does not bypass healthy Pinet ownership rejections with direct Slack fallback", async () => {
    const {
      slack,
      tools,
      setResolveThreadChannel,
      setPinetDeliveryAvailable,
      sendPinetSlackMessage,
    } = setup();
    setResolveThreadChannel(async () => "D123");
    setPinetDeliveryAvailable(true);
    sendPinetSlackMessage.mockRejectedValueOnce(
      new Error("Thread 123.456 is already owned by another agent."),
    );

    await expect(
      tools.get("slack_send")!.execute("tool-pinet-owned-thread", {
        thread_ts: "123.456",
        text: "Do not bypass ownership",
      }),
    ).rejects.toThrow("already owned");

    expect(slack).not.toHaveBeenCalledWith(
      "chat.postMessage",
      expect.any(String),
      expect.any(Object),
    );
  });

  it("returns structured inbox messages including block action metadata", async () => {
    const { inbox, tools } = setup();
    inbox.push({
      channel: "C123",
      threadTs: "123.456",
      userId: "U123",
      text: 'Clicked Slack "Approve" (action_id: review.approve).',
      timestamp: "123.789",
      metadata: {
        kind: "slack_block_action",
        actionId: "review.approve",
        parsedValue: { decision: "approve" },
      },
    });

    const response = await tools.get("slack_inbox")!.execute("tool-16", {});

    expect(response.content?.[0]?.text).toContain('metadata={"kind":"slack_block_action"');
    expect(response.content?.[0]?.text).toContain('"actionId":"review.approve"');
    expect(response.details).toEqual({
      count: 1,
      messages: [
        {
          channel: "C123",
          threadTs: "123.456",
          userId: "U123",
          text: 'Clicked Slack "Approve" (action_id: review.approve).',
          timestamp: "123.789",
          metadata: {
            kind: "slack_block_action",
            actionId: "review.approve",
            parsedValue: { decision: "approve" },
          },
        },
      ],
    });
  });

  it("registers only the hot Slack tools plus the dispatcher", () => {
    const { registeredTools } = setup();

    const slackTools = [...registeredTools.keys()].filter((name) => name.startsWith("slack"));

    expect(slackTools).toEqual(["slack", "slack_inbox", "slack_send"]);
    expect(registeredTools.has("slack_blocks_build")).toBe(false);
    expect(registeredTools.has("slack_modal_build")).toBe(false);
    expect(registeredTools.has("slack_post_channel")).toBe(false);
    expect(registeredTools.has("slack_canvas_update")).toBe(false);
  });

  it("returns structured dispatcher help with per-action schemas and examples", async () => {
    const { registeredTools } = setup();
    const dispatcher = registeredTools.get("slack")!;

    const catalogResponse = await dispatcher.execute("tool-help", { action: "help" });
    const catalogEnvelope = catalogResponse.details as SlackDispatcherEnvelope;
    expect(catalogEnvelope.status).toBe("succeeded");
    expect(catalogResponse.content?.[0]?.text).toContain('"status": "succeeded"');
    expect(catalogResponse.content?.[0]?.text).toContain('"action": "post_channel"');

    const schemaResponse = await dispatcher.execute("tool-help-topic", {
      action: "help",
      args: { topic: "post_channel" },
    });
    const schemaEnvelope = schemaResponse.details as SlackDispatcherEnvelope;
    expect(schemaEnvelope.status).toBe("succeeded");
    expect(schemaEnvelope.data).toMatchObject({
      action: "post_channel",
      guardrail_tool: "slack:post_channel",
    });
    expect(schemaEnvelope.data).toEqual(
      expect.objectContaining({
        examples: expect.arrayContaining([expect.objectContaining({ action: "post_channel" })]),
      }),
    );
    expect(schemaResponse.content?.[0]?.text).toContain("args_schema");
    expect(JSON.stringify(schemaEnvelope.data)).toContain("output_controls");
    expect(JSON.stringify(schemaEnvelope.data)).toContain("response_format");
    expect(JSON.stringify(schemaEnvelope.data)).toContain("files");
    expect(JSON.stringify(schemaEnvelope.data)).toContain("Local file path to attach");

    const confirmationHelp = await dispatcher.execute("tool-help-confirm", {
      action: "help",
      args: { topic: "confirm_action" },
    });
    const confirmationEnvelope = confirmationHelp.details as SlackDispatcherEnvelope;
    expect(confirmationEnvelope.status).toBe("succeeded");
    expect(JSON.stringify(confirmationEnvelope.data)).toContain("Exact action string");
    expect(JSON.stringify(confirmationEnvelope.data)).toContain("slack:<action>");
    expect(confirmationEnvelope.data).toMatchObject({
      action: "confirm_action",
      guardrail_tool: "slack:confirm_action",
      examples: [
        expect.objectContaining({
          action: "confirm_action",
          args: expect.objectContaining({ tool: "slack:delete" }),
        }),
      ],
    });
  });

  it("opens a modal and embeds thread context in private_metadata", async () => {
    const { slack, tools, setResolveThreadChannel } = setup();
    setResolveThreadChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });

    const response = await tools.get("slack_modal_open")!.execute("tool-19", {
      trigger_id: "trigger-1",
      thread_ts: "123.456",
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Deploy" },
        submit: { type: "plain_text", text: "Approve" },
        close: { type: "plain_text", text: "Cancel" },
        private_metadata: JSON.stringify({ workflow: "deploy" }),
        blocks: [],
      },
    });

    expect(slack).toHaveBeenCalledWith(
      "views.open",
      "xoxb-initial",
      expect.objectContaining({
        trigger_id: "trigger-1",
        view: expect.objectContaining({
          private_metadata: expect.stringContaining("123.456"),
        }),
      }),
    );
    expect(response.details).toMatchObject({
      thread_ts: "123.456",
      view_id: "V123",
    });
  });

  it("updates a modal by view_id", async () => {
    const { slack, tools } = setup();

    await tools.get("slack_modal_update")!.execute("tool-20", {
      view_id: "V555",
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Step 2" },
        submit: { type: "plain_text", text: "Continue" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [],
      },
    });

    expect(slack).toHaveBeenCalledWith(
      "views.update",
      "xoxb-initial",
      expect.objectContaining({
        view_id: "V555",
        view: expect.objectContaining({ type: "modal" }),
      }),
    );
  });

  it("returns structured inbox messages including modal submission metadata", async () => {
    const { inbox, tools } = setup();
    inbox.push({
      channel: "C123",
      threadTs: "123.456",
      userId: "U123",
      text: 'Submitted Slack modal (deploy.confirm) "Deploy approval".',
      timestamp: "hash-123",
      metadata: {
        kind: "slack_view_submission",
        triggerId: "trigger-1",
        callbackId: "deploy.confirm",
        viewId: "V123",
        stateValues: {
          confirm_phrase: {
            confirm_phrase: { type: "plain_text_input", value: "CONFIRM" },
          },
        },
      },
    });

    const response = await tools.get("slack_inbox")!.execute("tool-21", {});

    expect(response.content?.[0]?.text).toContain('metadata={"kind":"slack_view_submission"');
    expect(response.content?.[0]?.text).toContain('"triggerId":"trigger-1"');
    expect(response.details).toEqual({
      count: 1,
      messages: [
        {
          channel: "C123",
          threadTs: "123.456",
          userId: "U123",
          text: 'Submitted Slack modal (deploy.confirm) "Deploy approval".',
          timestamp: "hash-123",
          metadata: {
            kind: "slack_view_submission",
            triggerId: "trigger-1",
            callbackId: "deploy.confirm",
            viewId: "V123",
            stateValues: {
              confirm_phrase: {
                confirm_phrase: { type: "plain_text_input", value: "CONFIRM" },
              },
            },
          },
        },
      ],
    });
  });

  it("falls back and bookmarks a standalone canvas when channel canvas tab creation fails", async () => {
    const { slack, tools, setFilesInfoResponse } = setup();
    setFilesInfoResponse({
      ok: true,
      file: {
        id: "F_FALLBACK",
        title: "Agent Vault setup spike review",
        permalink: "https://example.slack.com/docs/T/F_FALLBACK",
      },
      comments: [],
      response_metadata: { next_cursor: "" },
    } as SlackResult);

    const originalSlack = slack.getMockImplementation()!;
    slack.mockImplementation(
      async (method: string, token: string, body?: Record<string, unknown>) => {
        if (method === "conversations.canvases.create") {
          throw new Error("Slack conversations.canvases.create: canvas_tab_creation_failed");
        }
        if (method === "canvases.create") {
          return { ok: true, token, body, canvas_id: "F_FALLBACK" } as SlackResult;
        }
        return originalSlack(method, token, body);
      },
    );

    const result = await tools.get("slack_canvas_create")!.execute("tool-canvas-create-1", {
      kind: "channel",
      channel: "proj-alpha",
      title: "Agent Vault setup spike review",
      markdown: "# Review",
    });

    expect(slack).toHaveBeenCalledWith(
      "conversations.canvases.create",
      "xoxb-initial",
      expect.objectContaining({ channel_id: "resolved:proj-alpha" }),
    );
    expect(slack).toHaveBeenCalledWith(
      "canvases.create",
      "xoxb-initial",
      expect.objectContaining({
        channel_id: "resolved:proj-alpha",
        title: "Agent Vault setup spike review",
      }),
    );
    expect(slack).toHaveBeenCalledWith("files.info", "xoxb-initial", { file: "F_FALLBACK" });
    expect(slack).toHaveBeenCalledWith(
      "bookmarks.add",
      "xoxb-initial",
      expect.objectContaining({
        channel_id: "resolved:proj-alpha",
        title: "Agent Vault setup spike review",
        link: "https://example.slack.com/docs/T/F_FALLBACK",
      }),
    );
    expect(result.content?.[0]?.text).toContain("Created standalone fallback canvas F_FALLBACK");
    expect(result.content?.[0]?.text).toContain("canvas_id=F_FALLBACK");
    expect(result.details).toEqual(
      expect.objectContaining({
        canvas_id: "F_FALLBACK",
        kind: "standalone",
        requested_kind: "channel",
        channel: "resolved:proj-alpha",
        fallback: true,
        fallback_reason: "canvas_tab_creation_failed",
        bookmark_status: "added",
        bookmark_id: "Bk123",
        permalink: "https://example.slack.com/docs/T/F_FALLBACK",
      }),
    );
  });

  it("does not bookmark private file URLs as fallback canvas permalinks", async () => {
    const { slack, tools, setFilesInfoResponse } = setup();
    setFilesInfoResponse({
      ok: true,
      file: {
        id: "F_FALLBACK_PRIVATE",
        title: "Private URL only",
        url_private: "https://files.slack.com/files-pri/T/F_FALLBACK_PRIVATE/download/doc",
      },
      comments: [],
      response_metadata: { next_cursor: "" },
    } as SlackResult);

    const originalSlack = slack.getMockImplementation()!;
    slack.mockImplementation(
      async (method: string, token: string, body?: Record<string, unknown>) => {
        if (method === "conversations.canvases.create") {
          throw new Error("Slack conversations.canvases.create: canvas_tab_creation_failed");
        }
        if (method === "canvases.create") {
          return { ok: true, token, body, canvas_id: "F_FALLBACK_PRIVATE" } as SlackResult;
        }
        return originalSlack(method, token, body);
      },
    );

    const result = await tools.get("slack_canvas_create")!.execute("tool-canvas-create-private", {
      kind: "channel",
      channel: "proj-alpha",
      title: "Private URL only",
      markdown: "# Review",
    });

    expect(slack.mock.calls.some(([method]) => method === "bookmarks.add")).toBe(false);
    expect(result.content?.[0]?.text).toContain("Slack did not expose a permalink");
    expect(result.details).toEqual(
      expect.not.objectContaining({
        permalink: "https://files.slack.com/files-pri/T/F_FALLBACK_PRIVATE/download/doc",
      }),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        canvas_id: "F_FALLBACK_PRIVATE",
        bookmark_status: "skipped",
      }),
    );
  });

  it("guides channel canvas updates toward fallback canvas IDs when Slack exposes no channel canvas", async () => {
    const { tools } = setup();

    await expect(
      tools.get("slack_canvas_update")!.execute("tool-canvas-update-missing-1", {
        channel: "proj-alpha",
        markdown: "## Update",
      }),
    ).rejects.toThrow("canvas_create will auto-create and bookmark a standalone fallback");
  });

  it("validates a direct canvas id before reading its comments", async () => {
    const { slack, tools, setFilesInfoResponse, setResolveUser } = setup();
    setResolveUser(async (userId) => (userId === "U123" ? "Alice" : userId));
    setFilesInfoResponse({
      ok: true,
      file: {
        id: "F123",
        title: "Launch plan",
        permalink: "https://example.slack.com/docs/T/F123",
        comments_count: 2,
      },
      comments: [{ id: "Fc1", user: "U123", comment: "Please update rollout" }],
      response_metadata: { next_cursor: "cursor-2" },
    } as SlackResult);

    const result = await tools.get("slack_canvas_comments_read")!.execute("tool-canvas-1", {
      canvas_id: "F123",
    });

    expect(slack).toHaveBeenCalledWith("canvases.sections.lookup", "xoxb-initial", {
      canvas_id: "F123",
      criteria: { section_types: ["any_header"] },
    });
    expect(slack).toHaveBeenCalledWith("files.info", "xoxb-initial", {
      file: "F123",
      limit: 20,
    });
    expect(result.content?.[0]?.text).toContain("Canvas comments for Launch plan (F123)");
    expect(result.content?.[0]?.text).toContain("Alice: Please update rollout");
    expect(result.content?.[0]?.text).toContain("cursor=cursor-2");
    expect(result.details).toEqual(
      expect.objectContaining({
        canvas_id: "F123",
        title: "Launch plan",
        permalink: "https://example.slack.com/docs/T/F123",
        comments_count: 2,
        returned_count: 1,
        next_cursor: "cursor-2",
      }),
    );
  });

  it("resolves and validates a channel canvas before reading its comments", async () => {
    const { slack, tools, setConversationsInfoResponse, setFilesInfoResponse } = setup();
    setConversationsInfoResponse({
      ok: true,
      channel: {
        id: "resolved:proj-alpha",
        properties: { canvas: { id: "F_CANVAS_1" } },
      },
    } as SlackResult);
    setFilesInfoResponse({
      ok: true,
      file: {
        id: "F_CANVAS_1",
        title: "Project canvas",
        comments_count: 0,
      },
      comments: [],
      response_metadata: { next_cursor: "" },
    } as SlackResult);

    const result = await tools.get("slack_canvas_comments_read")!.execute("tool-canvas-2", {
      channel: "proj-alpha",
      limit: 5,
    });

    expect(slack).toHaveBeenCalledWith("conversations.info", "xoxb-initial", {
      channel: "resolved:proj-alpha",
    });
    expect(slack).toHaveBeenCalledWith("canvases.sections.lookup", "xoxb-initial", {
      canvas_id: "F_CANVAS_1",
      criteria: { section_types: ["any_header"] },
    });
    expect(slack).toHaveBeenCalledWith("files.info", "xoxb-initial", {
      file: "F_CANVAS_1",
      limit: 5,
    });
    expect(result.content?.[0]?.text).toContain("Returned 0 of 0 comment(s).");
    expect(result.details).toEqual(
      expect.objectContaining({
        canvas_id: "F_CANVAS_1",
        channel: "resolved:proj-alpha",
        title: "Project canvas",
        comments_count: 0,
        returned_count: 0,
      }),
    );
  });

  it("rejects non-canvas file ids before calling files.info", async () => {
    const { slack, tools } = setup();
    const originalSlack = slack.getMockImplementation()!;
    slack.mockImplementation(
      async (method: string, token: string, body?: Record<string, unknown>) => {
        if (method === "canvases.sections.lookup") {
          throw new Error("Slack canvases.sections.lookup: canvas_not_found");
        }
        return originalSlack(method, token, body);
      },
    );

    await expect(
      tools.get("slack_canvas_comments_read")!.execute("tool-canvas-3", {
        canvas_id: "F_NOT_A_CANVAS",
      }),
    ).rejects.toThrow(
      "Canvas F_NOT_A_CANVAS is unavailable, inaccessible, or not a canvas. This tool only reads comments for Slack canvases.",
    );
    expect(slack.mock.calls.some(([method]) => method === "files.info")).toBe(false);
  });

  it("surfaces inaccessible canvases clearly", async () => {
    const { slack, tools } = setup();
    const originalSlack = slack.getMockImplementation()!;
    slack.mockImplementation(
      async (method: string, token: string, body?: Record<string, unknown>) => {
        if (method === "canvases.sections.lookup") {
          throw new Error("Slack canvases.sections.lookup: access_denied");
        }
        return originalSlack(method, token, body);
      },
    );

    await expect(
      tools.get("slack_canvas_comments_read")!.execute("tool-canvas-4", {
        canvas_id: "F_PRIVATE_CANVAS",
      }),
    ).rejects.toThrow("Canvas F_PRIVATE_CANVAS is not accessible with the current bot token.");
    expect(slack.mock.calls.some(([method]) => method === "files.info")).toBe(false);
  });

  it("surfaces deleted channel canvases clearly", async () => {
    const { slack, tools, setConversationsInfoResponse } = setup();
    setConversationsInfoResponse({
      ok: true,
      channel: {
        id: "resolved:proj-alpha",
        properties: { canvas: { id: "F_CANVAS_1" } },
      },
    } as SlackResult);

    const originalSlack = slack.getMockImplementation()!;
    slack.mockImplementation(
      async (method: string, token: string, body?: Record<string, unknown>) => {
        if (method === "files.info") {
          throw new Error("Slack files.info: channel_canvas_deleted");
        }
        return originalSlack(method, token, body);
      },
    );

    await expect(
      tools.get("slack_canvas_comments_read")!.execute("tool-canvas-5", {
        channel: "proj-alpha",
      }),
    ).rejects.toThrow("Canvas F_CANVAS_1 is no longer available.");
  });

  // ─── slack_project_create ─────────────────────────────

  it("creates a project channel with canvas and bot invite in one call", async () => {
    const { slack, tools } = setup();

    const result = await tools.get("slack_project_create")!.execute("tool-proj-1", {
      name: "proj-alpha",
      topic: "Alpha project",
      canvas_title: "Alpha RFC",
      canvas_markdown: "# Overview\nProject goals.",
    });

    expect(slack).toHaveBeenCalledWith("conversations.create", "xoxb-initial", {
      name: "proj-alpha",
    });
    expect(slack).toHaveBeenCalledWith("conversations.setTopic", "xoxb-initial", {
      channel: "C_PROJ",
      topic: "Alpha project",
    });
    expect(slack).toHaveBeenCalledWith(
      "conversations.invite",
      "xoxb-initial",
      expect.objectContaining({ channel: "C_PROJ", users: "U_BOT" }),
    );
    expect(slack).toHaveBeenCalledWith(
      "conversations.canvases.create",
      "xoxb-initial",
      expect.objectContaining({ channel_id: "C_PROJ", title: "Alpha RFC" }),
    );

    const details = (result as { details: Record<string, unknown> }).details;
    expect(details.channel_id).toBe("C_PROJ");
    expect(details.channel_name).toBe("proj-alpha");
    expect(details.canvas_id).toBe("CANVAS_1");
    expect(details.bot_invited).toBe(true);
  });

  it("creates project channel even when canvas creation fails", async () => {
    const { slack, tools } = setup();

    // Override slack to fail on canvas creation
    const originalSlack = slack.getMockImplementation()!;
    slack.mockImplementation(
      async (method: string, token: string, body?: Record<string, unknown>) => {
        if (method === "conversations.canvases.create") {
          throw new Error("canvas_error");
        }
        return originalSlack(method, token, body);
      },
    );

    const result = await tools.get("slack_project_create")!.execute("tool-proj-2", {
      name: "proj-beta",
    });

    const details = (result as { details: Record<string, unknown> }).details;
    expect(details.channel_id).toBe("C_PROJ");
    expect(details.canvas_id).toBeNull();
  });

  it("falls back and bookmarks a standalone project canvas when channel tab creation fails", async () => {
    const { slack, tools, setFilesInfoResponse } = setup();
    setFilesInfoResponse({
      ok: true,
      file: {
        id: "F_PROJECT_FALLBACK",
        title: "Beta RFC",
        permalink: "https://example.slack.com/docs/T/F_PROJECT_FALLBACK",
      },
      comments: [],
      response_metadata: { next_cursor: "" },
    } as SlackResult);

    const originalSlack = slack.getMockImplementation()!;
    slack.mockImplementation(
      async (method: string, token: string, body?: Record<string, unknown>) => {
        if (method === "conversations.canvases.create") {
          throw new Error("Slack conversations.canvases.create: canvas_tab_creation_failed");
        }
        if (method === "canvases.create") {
          return { ok: true, token, body, canvas_id: "F_PROJECT_FALLBACK" } as SlackResult;
        }
        return originalSlack(method, token, body);
      },
    );

    const result = await tools.get("slack_project_create")!.execute("tool-proj-fallback", {
      name: "proj-beta",
      canvas_title: "Beta RFC",
      canvas_markdown: "# Beta",
    });

    expect(slack).toHaveBeenCalledWith(
      "canvases.create",
      "xoxb-initial",
      expect.objectContaining({
        channel_id: "C_PROJ",
        title: "Beta RFC",
      }),
    );
    expect(slack).toHaveBeenCalledWith("files.info", "xoxb-initial", {
      file: "F_PROJECT_FALLBACK",
    });
    expect(slack).toHaveBeenCalledWith(
      "bookmarks.add",
      "xoxb-initial",
      expect.objectContaining({
        channel_id: "C_PROJ",
        title: "Beta RFC",
        link: "https://example.slack.com/docs/T/F_PROJECT_FALLBACK",
      }),
    );
    expect(result.content?.[0]?.text).toContain("Created standalone fallback RFC canvas");
    expect(result.content?.[0]?.text).toContain("canvas_id=F_PROJECT_FALLBACK");

    const details = (result as { details: Record<string, unknown> }).details;
    expect(details).toEqual(
      expect.objectContaining({
        channel_id: "C_PROJ",
        canvas_id: "F_PROJECT_FALLBACK",
        canvas_kind: "standalone",
        canvas_fallback: true,
        canvas_fallback_reason: "canvas_tab_creation_failed",
        bookmark_status: "added",
        bookmark_id: "Bk123",
        permalink: "https://example.slack.com/docs/T/F_PROJECT_FALLBACK",
        next_action: "canvas_update canvas_id=F_PROJECT_FALLBACK",
      }),
    );
  });

  it("classifies raw upload 403 responses as input when no proxy marker is present", async () => {
    const { slack, tools } = setup();
    const originalSlack = slack.getMockImplementation()!;
    slack.mockImplementation(
      async (method: string, token: string, body?: Record<string, unknown>) => {
        if (method === "files.getUploadURLExternal") {
          return {
            ok: true,
            upload_url: "https://uploads.slack.test/file",
            file_id: "F123",
          } as SlackResult;
        }
        if (method === "files.completeUploadExternal") {
          return { ok: true, files: [{ id: "F123" }] } as SlackResult;
        }
        return originalSlack(method, token, body);
      },
    );

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("forbidden", { status: 403, statusText: "Forbidden" }));

    const response = await tools.get("slack")!.execute("tool-upload-1", {
      action: "upload",
      args: { content: "hello", filename: "hello.txt" },
    });

    const envelope = response.details as SlackDispatcherEnvelope;
    expect(envelope.status).toBe("failed");
    expect(envelope.errors[0]?.class).toBe("input");
    expect(envelope.errors[0]?.message).toContain("Slack raw upload failed (HTTP 403");

    fetchSpy.mockRestore();
  });

  it("classifies raw upload responses as network when proxy/firewall markers appear", async () => {
    const { slack, tools } = setup();
    const originalSlack = slack.getMockImplementation()!;
    slack.mockImplementation(
      async (method: string, token: string, body?: Record<string, unknown>) => {
        if (method === "files.getUploadURLExternal") {
          return {
            ok: true,
            upload_url: "https://files.slack.com/upload/abc",
            file_id: "F123",
          } as SlackResult;
        }
        if (method === "files.completeUploadExternal") {
          return { ok: true, files: [{ id: "F123" }] } as SlackResult;
        }
        return originalSlack(method, token, body);
      },
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("X-Proxy-Error: blocked-by-allowlist", {
        status: 403,
        statusText: "Forbidden",
      }),
    );

    const response = await tools.get("slack")!.execute("tool-upload-2", {
      action: "upload",
      args: { content: "hello", filename: "hello.txt" },
    });

    const envelope = response.details as SlackDispatcherEnvelope;
    expect(envelope.status).toBe("failed");
    expect(envelope.errors[0]?.class).toBe("network");
    expect(envelope.errors[0]?.message).toContain("possible outbound proxy/firewall block");

    fetchSpy.mockRestore();
  });
});
