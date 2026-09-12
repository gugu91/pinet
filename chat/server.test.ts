import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryChatStorage } from "./memory-storage.js";
import { createChatApp, parseCredentials } from "./server.js";
import { SqliteChatStorage } from "./sqlite-storage.js";

const credentials = [
  { token: "agent-secret", principal: { kind: "agent" as const, id: "agent-a" } },
  { token: "agent-b-secret", principal: { kind: "agent" as const, id: "agent-b" } },
  { token: "host-secret", principal: { kind: "host" as const, id: "host-a" } },
  { token: "other-host", principal: { kind: "host" as const, id: "host-b" } },
];
const auth = { authorization: "Bearer agent-secret", "content-type": "application/json" };
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function json(response: Response) {
  return response.json() as Promise<{
    data:
      | { id: string; cursor: number; markdown: string }
      | Array<{ id: string; cursor: number; markdown: string }>;
    duplicate?: boolean;
    error?: { code: string };
  }>;
}

describe("chat API", () => {
  it("authenticates, performs channel/message CRUD, deduplicates, and enforces mention/thread/cursor boundaries", async () => {
    let sequence = 0;
    const app = createChatApp({
      storage: new MemoryChatStorage(),
      credentials,
      now: () => 10,
      id: () => `id-${++sequence}`,
    });
    expect((await app.request("/v1/channels")).status).toBe(401);
    expect(
      (await app.request("/v1/channels", { method: "POST", headers: auth, body: "[]" })).status,
    ).toBe(400);
    const channelResponse = await app.request("/v1/channels", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "general" }),
    });
    expect(channelResponse.status).toBe(201);
    const channelId = ((await json(channelResponse)).data as { id: string }).id;
    await app.request("/v1/agents", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "Agent A", homeChannelId: channelId }),
    });
    await app.request("/v1/agents", {
      method: "POST",
      headers: {
        authorization: "Bearer agent-b-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Agent B", homeChannelId: channelId }),
    });
    const send = () =>
      app.request(`/v1/channels/${channelId}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ clientId: "retry-1", markdown: "hello", mentions: [] }),
      });
    const first = await send();
    expect(first.status).toBe(201);
    const message = (await json(first)).data as { id: string; cursor: number };
    const duplicate = await send();
    expect((await json(duplicate)).duplicate).toBe(true);
    expect(
      (
        await app.request(`/v1/channels/${channelId}/messages`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ clientId: "retry-1", markdown: "changed" }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request(`/v1/channels/${channelId}/messages`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            clientId: "retry-2",
            markdown: "bad mention",
            mentions: ["missing"],
          }),
        })
      ).status,
    ).toBe(400);
    const reply = await app.request(`/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ clientId: "retry-3", markdown: "reply", parentId: message.id }),
    });
    expect(reply.status).toBe(201);
    const history = await json(
      await app.request(`/v1/channels/${channelId}/messages?after=${message.cursor}`, {
        headers: auth,
      }),
    );
    expect(history.data).toHaveLength(1);
    const search = await json(await app.request("/v1/messages/search?q=reply", { headers: auth }));
    expect(search.data).toHaveLength(1);
    await app.request(`/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        clientId: "mention",
        markdown: "wake agent B",
        mentions: ["agent-b"],
      }),
    });
    const mentions = await json(
      await app.request("/v1/mentions?after=0", {
        headers: { authorization: "Bearer agent-b-secret" },
      }),
    );
    expect(mentions.data).toHaveLength(1);
    expect((mentions.data as Array<{ markdown: string }>)[0]?.markdown).toBe("wake agent B");
  });

  it("persists across SQLite restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pinet-chat-"));
    directories.push(directory);
    const path = join(directory, "chat.sqlite");
    const first = new SqliteChatStorage(path);
    first.createChannel({ id: "channel", name: "persisted", topic: "", createdAt: 1 });
    first.close();
    const second = new SqliteChatStorage(path);
    expect(second.getChannel("channel")?.name).toBe("persisted");
    second.close();
  });

  it("scopes runtime claims and reports to the requested host", async () => {
    const app = createChatApp({
      storage: new MemoryChatStorage(),
      credentials,
      id: () => "request",
      now: () => 1,
    });
    const created = await app.request("/v1/runtime/requests", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ hostId: "host-a", prompt: "work" }),
    });
    expect(created.status).toBe(202);
    expect(
      (
        await app.request("/v1/runtime/requests/request/claim", {
          method: "POST",
          headers: { authorization: "Bearer other-host" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/v1/runtime/requests/request/claim", {
          method: "POST",
          headers: { authorization: "Bearer host-secret" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/v1/runtime/requests/request/claim", {
          method: "POST",
          headers: { authorization: "Bearer host-secret" },
        })
      ).status,
    ).toBe(409);
    await app.request("/v1/runtime/requests/request/report", {
      method: "POST",
      headers: { authorization: "Bearer host-secret", "content-type": "application/json" },
      body: JSON.stringify({
        status: "running",
        sessionId: "session",
        sessionPath: "/tmp/session.jsonl",
        cwd: "/tmp",
        handle: "42",
        identity: "launch",
        startedAt: 1,
      }),
    });
    await app.request("/v1/runtime/requests/request/report", {
      method: "POST",
      headers: { authorization: "Bearer host-secret", "content-type": "application/json" },
      body: JSON.stringify({ status: "running", handle: "42", identity: "launch" }),
    });
    const reported = (await (
      await app.request("/v1/runtime/requests/request", { headers: auth })
    ).json()) as {
      data: { sessionId: string; sessionPath: string; cwd: string; startedAt: number };
    };
    expect(reported.data).toMatchObject({
      sessionId: "session",
      sessionPath: "/tmp/session.jsonl",
      cwd: "/tmp",
      startedAt: 1,
    });
    expect(
      (
        await app.request("/v1/runtime/registrations", {
          method: "POST",
          headers: { authorization: "Bearer host-secret", "content-type": "application/json" },
          body: JSON.stringify({
            adapter: "process",
            sessionId: "manual",
            cwd: "/tmp",
            handle: "42",
            identity: "launch",
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/v1/runtime/registrations", {
          method: "POST",
          headers: { authorization: "Bearer host-secret", "content-type": "application/json" },
          body: JSON.stringify({
            consent: true,
            adapter: "process",
            sessionId: "manual",
            cwd: "/tmp",
            handle: "42",
            identity: "launch",
          }),
        })
      ).status,
    ).toBe(201);
  });

  it("rejects malformed, empty, and duplicate deployment credentials", () => {
    expect(() => parseCredentials("[]")).toThrow("non-empty array");
    expect(() =>
      parseCredentials(JSON.stringify([{ token: "", principal: { kind: "agent", id: "agent" } }])),
    ).toThrow("token must be a non-empty string");
    expect(() =>
      parseCredentials(
        JSON.stringify([
          { token: "same", principal: { kind: "agent", id: "agent" } },
          { token: "same", principal: { kind: "host", id: "host" } },
        ]),
      ),
    ).toThrow("unique");
  });
});
