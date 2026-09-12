import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackAdapter } from "./adapter.js";
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
  it("persists explicit mappings and relay IDs", () => {
    const directory = mkdtempSync(join(tmpdir(), "pinet-slack-"));
    dirs.push(directory);
    const path = join(directory, "map.sqlite");
    const first = new SqliteMappingStore(path);
    first.bindChannel({ slackChannelId: "C", chatChannelId: "chat" });
    first.recordRelay("chat-to-slack", "C", "1", "m");
    first.close();
    const second = new SqliteMappingStore(path);
    expect(second.channelBySlack("C")?.chatChannelId).toBe("chat");
    expect(second.hasSlackMessage("C", "1")).toBe(true);
    expect(second.hasChatMessage("m")).toBe(true);
    second.close();
  });
});
