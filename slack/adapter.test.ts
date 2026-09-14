import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackAdapter } from "./adapter.js";
import { SlackChatPoller } from "./index.js";
import { MemoryMappingStore, SqliteMappingStore } from "./mapping.js";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("Slack adapter", () => {
  it("maps inbound/outbound threads, identities and mentions without echoing relays", async () => {
    const mappings = new MemoryMappingStore();
    mappings.bindChannel({ slackChannelId: "C1", chatChannelId: "chat-1" });
    const chat = { send: vi.fn(async () => ({ id: "chat-root" })) };
    const slack = { postMessage: vi.fn(async () => ({ ts: "200.1" })) };
    const adapter = new SlackAdapter({
      mappings,
      chat,
      slack,
      ownSlackUserId: "BOT",
      mentionMap: { U2: "agent-2" },
    });
    expect(
      (
        await adapter.receive({
          channel: "C1",
          ts: "100.1",
          threadTs: null,
          user: "U1",
          text: "hi <@U2>",
          botId: null,
        })
      ).status,
    ).toBe("relayed");
    expect(chat.send).toHaveBeenCalledWith(
      expect.objectContaining({
        markdown: "**Slack user U1:** hi <@U2>",
        mentions: ["agent-2"],
        parentId: null,
      }),
    );
    expect(
      (
        await adapter.receive({
          channel: "C1",
          ts: "100.1",
          threadTs: null,
          user: "U1",
          text: "hi",
          botId: null,
        })
      ).status,
    ).toBe("ignored");
    chat.send.mockResolvedValueOnce({ id: "chat-reply" });
    await adapter.receive({
      channel: "C1",
      ts: "100.2",
      threadTs: "100.1",
      user: "U1",
      text: "reply",
      botId: null,
    });
    expect(chat.send).toHaveBeenLastCalledWith(expect.objectContaining({ parentId: "chat-root" }));
    const sent = await adapter.send({
      id: "out",
      channelId: "chat-1",
      parentId: "chat-root",
      markdown: "answer",
      senderId: "a",
      clientId: "c",
      mentions: [],
    });
    expect(sent.status).toBe("relayed");
    expect(slack.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "answer",
      threadTs: "100.1",
    });
    expect(
      await adapter.send({
        id: "bad",
        channelId: "chat-1",
        parentId: "other",
        markdown: "wrong",
        senderId: "a",
        clientId: "c2",
        mentions: [],
      }),
    ).toEqual({ status: "ignored", reason: "unmapped thread" });
  });
  it("serializes Chat polling and advances the cursor only after delivery", async () => {
    const mappings = new MemoryMappingStore();
    mappings.bindChannel({ slackChannelId: "C", chatChannelId: "chat" });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slack = {
      postMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockImplementationOnce(async () => {
          await blocked;
          return { ts: "1" };
        }),
    };
    const adapter = new SlackAdapter({
      mappings,
      slack,
      chat: { send: vi.fn() },
      ownSlackUserId: "BOT",
    });
    const cursors: number[] = [];
    const transport = vi.fn(async (input: string | URL | Request) => {
      cursors.push(Number(new URL(String(input)).searchParams.get("after")));
      return Response.json({
        data: [
          {
            id: "m",
            channelId: "chat",
            parentId: null,
            markdown: "hello",
            senderId: "a",
            clientId: "c",
            mentions: [],
            cursor: 1,
          },
        ],
      });
    });
    const poller = new SlackChatPoller(mappings, adapter, "https://chat.test", "token", transport);
    await expect(poller.poll()).rejects.toThrow("temporary");
    await expect(poller.poll()).rejects.toThrow("ambiguous");
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(mappings.listAmbiguousOutbound()).toEqual(["m"]);
    expect(mappings.retryOutbound("m")).toBe(true);
    const active = poller.poll();
    await poller.poll();
    expect(transport).toHaveBeenCalledTimes(3);
    release!();
    await active;
    await poller.poll();
    expect(cursors).toEqual([0, 0, 0, 1]);
    expect(slack.postMessage).toHaveBeenCalledTimes(2);
  });
  it("persists and serially retries inbound roots before replies", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pinet-slack-inbox-"));
    dirs.push(directory);
    const path = join(directory, "map.sqlite");
    const first = new SqliteMappingStore(path);
    first.bindChannel({ slackChannelId: "C", chatChannelId: "chat" });
    first.enqueueInbound({
      channel: "C",
      ts: "2",
      threadTs: "1",
      user: "U",
      text: "reply",
      botId: null,
    });
    const earlyChat = { send: vi.fn(async () => ({ id: "unexpected" })) };
    const earlyAdapter = new SlackAdapter({
      mappings: first,
      chat: earlyChat,
      slack: { postMessage: vi.fn() },
      ownSlackUserId: "BOT",
    });
    await earlyAdapter.drain();
    expect(earlyChat.send).not.toHaveBeenCalled();
    expect(first.pendingInbound()).toHaveLength(1);
    first.enqueueInbound({
      channel: "C",
      ts: "1",
      threadTs: null,
      user: "U",
      text: "root",
      botId: null,
    });
    first.close();
    const second = new SqliteMappingStore(path);
    const chat = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary Chat failure"))
        .mockResolvedValueOnce({ id: "chat-root" })
        .mockResolvedValueOnce({ id: "chat-reply" }),
    };
    const adapter = new SlackAdapter({
      mappings: second,
      chat,
      slack: { postMessage: vi.fn() },
      ownSlackUserId: "BOT",
    });
    await expect(adapter.drain()).rejects.toThrow("temporary Chat failure");
    expect(second.pendingInbound()).toHaveLength(2);
    await Promise.all([adapter.drain(), adapter.drain()]);
    expect(chat.send).toHaveBeenNthCalledWith(2, expect.objectContaining({ parentId: null }));
    expect(chat.send).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ parentId: "chat-root" }),
    );
    expect(second.pendingInbound()).toHaveLength(0);
    second.close();
  });
  it("rolls back inbound completion checkpoints and retries the idempotent Chat send", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pinet-slack-checkpoint-"));
    dirs.push(directory);
    let fail = true;
    const mappings = new SqliteMappingStore(join(directory, "map.sqlite"), () => {
      if (fail) {
        fail = false;
        throw new Error("checkpoint failure");
      }
    });
    mappings.bindChannel({ slackChannelId: "C", chatChannelId: "chat" });
    mappings.enqueueInbound({
      channel: "C",
      ts: "1",
      threadTs: null,
      user: "U",
      text: "root",
      botId: null,
    });
    const chat = { send: vi.fn(async () => ({ id: "stable-chat-id" })) };
    const adapter = new SlackAdapter({
      mappings,
      chat,
      slack: { postMessage: vi.fn() },
      ownSlackUserId: "BOT",
    });
    await expect(adapter.drain()).rejects.toThrow("checkpoint failure");
    expect(mappings.pendingInbound()).toHaveLength(1);
    expect(mappings.hasChatMessage("stable-chat-id")).toBe(false);
    expect(mappings.threadBySlack("C", "1")).toBeUndefined();
    await adapter.drain();
    expect(chat.send).toHaveBeenCalledTimes(2);
    expect(mappings.pendingInbound()).toHaveLength(0);
    expect(mappings.hasChatMessage("stable-chat-id")).toBe(true);
    expect(mappings.threadBySlack("C", "1")?.chatParentId).toBe("stable-chat-id");
    mappings.close();
  });

  it("persists outbound cursors and requires operator retry after ambiguous completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pinet-slack-outbound-"));
    dirs.push(directory);
    const path = join(directory, "map.sqlite");
    let fail = true;
    const first = new SqliteMappingStore(
      path,
      () => {
        if (fail) {
          fail = false;
          throw new Error("checkpoint failure");
        }
      },
      3,
    );
    first.bindChannel({ slackChannelId: "C", chatChannelId: "chat" });
    const slack = { postMessage: vi.fn(async () => ({ ts: "10" })) };
    const configured = new SlackAdapter({
      mappings: first,
      chat: { send: vi.fn() },
      slack,
      ownSlackUserId: "BOT",
    });
    const message = {
      id: "out",
      channelId: "chat",
      parentId: null,
      markdown: "hello",
      senderId: "agent",
      clientId: "client",
      mentions: [],
      cursor: 9,
    };
    await expect(configured.send(message)).rejects.toThrow("checkpoint failure");
    await expect(configured.send(message)).rejects.toThrow("ambiguous");
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(first.listAmbiguousOutbound()).toEqual(["out"]);
    expect(first.retryOutbound("out")).toBe(true);
    await configured.send(message);
    expect(slack.postMessage).toHaveBeenCalledTimes(2);
    expect(first.getCursor("chat")).toBe(9);
    first.recordRelay("slack-to-chat", "other", "1", "newer");
    expect(first.hasChatMessage("out")).toBe(false);
    first.close();
    const second = new SqliteMappingStore(path);
    expect(second.getCursor("chat")).toBe(9);
    expect(second.beginOutbound("out")).toBe("complete");
    second.close();
  });

  it("persists explicit mappings and relay IDs", () => {
    const directory = mkdtempSync(join(tmpdir(), "pinet-slack-"));
    dirs.push(directory);
    const path = join(directory, "map.sqlite");
    const first = new SqliteMappingStore(path);
    first.bindChannel({ slackChannelId: "C", chatChannelId: "chat" });
    first.recordRelay("chat-to-slack", "C", "1", "m");
    expect(() => new SqliteMappingStore(path)).toThrow("already owned");
    first.close();
    const second = new SqliteMappingStore(path);
    expect(second.channelBySlack("C")?.chatChannelId).toBe("chat");
    expect(second.hasSlackMessage("C", "1")).toBe(true);
    expect(second.hasChatMessage("m")).toBe(true);
    second.bindThread({
      slackChannelId: "C",
      chatChannelId: "chat",
      slackThreadTs: "1",
      chatParentId: "m",
    });
    expect(() =>
      second.bindThread({
        slackChannelId: "C",
        chatChannelId: "chat",
        slackThreadTs: "1",
        chatParentId: "different",
      }),
    ).toThrow("slack thread is already mapped");
    expect(() =>
      second.bindThread({
        slackChannelId: "missing",
        chatChannelId: "chat",
        slackThreadTs: "2",
        chatParentId: "other",
      }),
    ).toThrow("match its channel");
    expect(() => second.bindChannel({ slackChannelId: "C", chatChannelId: "different" })).toThrow(
      "mapped threads",
    );
    second.close();
  });
});
