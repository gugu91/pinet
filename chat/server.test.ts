import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
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
    expect(
      (await app.request(`/v1/channels/${channelId}`, { method: "DELETE", headers: auth })).status,
    ).toBe(204);
    const agents = (await (await app.request("/v1/agents", { headers: auth })).json()) as {
      data: Array<{ homeChannelId: string | null }>;
    };
    expect(agents.data.every((agent) => agent.homeChannelId === null)).toBe(true);
    const deletedHistory = await json(
      await app.request(`/v1/channels/${channelId}/messages?after=0`, { headers: auth }),
    );
    expect(deletedHistory.data).toHaveLength(0);
  });

  it("returns validation details but keeps unexpected internal failures server-side", async () => {
    class FailingStorage extends MemoryChatStorage {
      override listChannels(): never {
        throw new Error("database unavailable at /secret/internal/chat.sqlite");
      }
    }
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createChatApp({ storage: new FailingStorage(), credentials });

    const invalid = await app.request("/v1/channels", {
      method: "POST",
      headers: auth,
      body: "not-json",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("valid JSON");

    const failed = await app.request("/v1/channels", { headers: auth });
    const responseBody = await failed.text();
    expect(failed.status).toBe(500);
    expect(responseBody).toContain("The request could not be completed");
    expect(responseBody).not.toContain("/secret/internal");
    expect(log).toHaveBeenCalledWith("Chat request failed", expect.any(Error));
  });

  it("persists across SQLite restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pinet-chat-"));
    directories.push(directory);
    const path = join(directory, "chat.sqlite");
    const first = new SqliteChatStorage(path);
    first.createChannel({ id: "channel", name: "persisted", topic: "", createdAt: 1 });
    first.putAgent({ id: "agent", name: "Agent", homeChannelId: "channel", lastSeen: 1 });
    first.insertMessage({
      id: "message",
      clientId: "client",
      channelId: "channel",
      senderId: "agent",
      markdown: "persisted",
      mentions: [],
      parentId: null,
      createdAt: 1,
    });
    expect(first.messages("channel", 0, 1)).toHaveLength(1);
    first.close();
    const second = new SqliteChatStorage(path);
    expect(second.getChannel("channel")?.name).toBe("persisted");
    expect(second.deleteChannel("channel")).toBe(true);
    expect(second.getAgent("agent")?.homeChannelId).toBeNull();
    expect(second.messages("channel", 0, 10)).toHaveLength(0);
    second.close();
  });

  it("scopes runtime claims and reports to the requested host", async () => {
    const app = createChatApp({
      storage: new MemoryChatStorage(),
      credentials,
      id: () => "request",
      now: () => 1,
    });
    expect(
      (
        await app.request("/v1/runtime/requests", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ hostId: "host-a", prompt: "work", channelId: "missing" }),
        })
      ).status,
    ).toBe(404);
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
    const claim = await app.request("/v1/runtime/requests/request/claim", {
      method: "POST",
      headers: { authorization: "Bearer host-secret" },
    });
    expect(claim.status).toBe(200);
    const claimBody = (await claim.json()) as {
      launch: { token: string; agentId: string };
    };
    expect(claimBody.launch.agentId).toBe("runtime-request");
    expect(claimBody.launch.token).not.toContain("host-secret");
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
    const childHeaders = {
      authorization: `Bearer ${claimBody.launch.token}`,
      "content-type": "application/json",
    };
    expect(
      (
        await app.request("/v1/agents", {
          method: "POST",
          headers: childHeaders,
          body: JSON.stringify({ name: "Runtime child" }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request("/v1/runtime/requests/request/heartbeat", {
          method: "POST",
          headers: childHeaders,
          body: JSON.stringify({
            sessionId: "actual-session",
            sessionPath: "/tmp/actual.jsonl",
          }),
        })
      ).status,
    ).toBe(200);
    const reported = (await (
      await app.request("/v1/runtime/requests/request", { headers: auth })
    ).json()) as {
      data: {
        sessionId: string;
        sessionPath: string;
        cwd: string;
        startedAt: number;
        agentLastSeen: number;
      };
    };
    expect(reported.data).toMatchObject({
      sessionId: "actual-session",
      sessionPath: "/tmp/actual.jsonl",
      cwd: "/tmp",
      startedAt: 1,
    });
    expect(
      (
        await app.request("/v1/runtime/requests/request/report", {
          method: "POST",
          headers: { authorization: "Bearer host-secret", "content-type": "application/json" },
          body: JSON.stringify({ status: "unknown" }),
        })
      ).status,
    ).toBe(200);
    expect((await app.request("/v1/agents", { headers: childHeaders })).status).toBe(401);
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
            heartbeatPath: "/tmp/manual.heartbeat",
          }),
        })
      ).status,
    ).toBe(409);
  });

  it("keeps host tokens lifecycle-only while scoped children retain free coordination", async () => {
    let sequence = 0;
    const app = createChatApp({
      storage: new MemoryChatStorage(),
      credentials,
      id: () => `id-${++sequence}`,
      now: () => 1,
    });
    expect(
      (
        await app.request("/v1/channels", {
          method: "POST",
          headers: { authorization: "Bearer host-secret", "content-type": "application/json" },
          body: JSON.stringify({ name: "forbidden" }),
        })
      ).status,
    ).toBe(403);
    const requested = await app.request("/v1/runtime/requests", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ hostId: "host-a", prompt: "child" }),
    });
    const requestId = ((await requested.json()) as { data: { id: string } }).data.id;
    const claim = await app.request(`/v1/runtime/requests/${requestId}/claim`, {
      method: "POST",
      headers: { authorization: "Bearer host-secret" },
    });
    const launch = (await claim.json()) as { launch: { token: string } };
    const childHeaders = {
      authorization: `Bearer ${launch.launch.token}`,
      "content-type": "application/json",
    };
    expect(
      (
        await app.request("/v1/channels", {
          method: "POST",
          headers: childHeaders,
          body: JSON.stringify({ name: "child-created" }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request("/v1/runtime/requests", {
          method: "POST",
          headers: childHeaders,
          body: JSON.stringify({ hostId: "host-a", prompt: "grandchild" }),
        })
      ).status,
    ).toBe(202);
    const adoption = {
      consent: true,
      hostId: "host-a",
      sessionId: "manual-session",
      adapter: "process",
      cwd: "/tmp",
      handle: "42",
      identity: "launch",
      heartbeatPath: "/tmp/manual.heartbeat",
    };
    const managedAdoption = await app.request("/v1/runtime/registrations", {
      method: "POST",
      headers: childHeaders,
      body: JSON.stringify(adoption),
    });
    expect(managedAdoption.status).toBe(409);
    const first = await app.request("/v1/runtime/registrations", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(adoption),
    });
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { data: { id: string } }).data.id;
    const retry = await app.request("/v1/runtime/registrations", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(adoption),
    });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { data: { id: string } }).data.id).toBe(firstId);
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
