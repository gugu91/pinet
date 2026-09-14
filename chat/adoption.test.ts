import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerChat } from "./index.js";
import { createChatApp } from "./server.js";
import { SqliteChatStorage } from "./sqlite-storage.js";
import { RuntimeManager } from "./runtime-manager.js";

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("rejects duplicate managed ownership through both the tool and API without stopping the healthy process", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const directory = mkdtempSync(join(tmpdir(), "pinet-adoption-owner-"));
  directories.push(directory);
  const sessionPath = join(directory, "session.jsonl");
  const heartbeatPath = join(directory, "managed.heartbeat");
  const alternativeHeartbeat = join(directory, "alternative.heartbeat");
  writeFileSync(sessionPath, '{"type":"session","id":"session"}\n');
  const storage = new SqliteChatStorage(join(directory, "chat.sqlite"));
  try {
    storage.createRuntimeRequest({
      id: "managed",
      requestedBy: "coordinator",
      hostId: "host",
      prompt: "work",
      channelId: null,
      worktree: directory,
      adapter: "process",
      status: "running",
      createdAt: 1000,
      updatedAt: 1000,
      sessionId: "session",
      sessionPath,
      cwd: directory,
      handle: "42",
      identity: "generation",
      startedAt: 1000,
      lastSeen: 1000,
      stoppedAt: null,
      agentId: "agent",
      agentLastSeen: 1000,
      heartbeatPath,
    });
    const app = createChatApp({
      storage,
      credentials: [
        { token: "agent-token", principal: { kind: "agent", id: "agent" } },
        { token: "host-token", principal: { kind: "host", id: "host" } },
      ],
    });
    const transport: typeof fetch = async (input, init) => app.request(new Request(input, init));
    const handlers = new Map<string, (event: object, ctx: object) => void>();
    let execute!: (id: string, params: object) => Promise<{ isError?: boolean }>;
    registerChat(
      {
        on: (name: string, callback: (event: object, ctx: object) => void) =>
          handlers.set(name, callback),
        registerTool: (tool: { execute: typeof execute }) => {
          execute = tool.execute;
        },
        registerCommand: vi.fn(),
        sendUserMessage: vi.fn(),
      } as never,
      {
        baseUrl: "https://chat.test",
        token: "agent-token",
        agentId: "agent",
        fetch: transport,
        runtimeRequestId: "managed",
        localHeartbeatPath: heartbeatPath,
        localHeartbeatIntervalMs: 1000,
        cursorPath: join(directory, "cursor"),
      },
    );
    handlers.get("session_start")!({}, { sessionManager: { getSessionFile: () => sessionPath } });
    const registration = {
      hostId: "host",
      adapter: "process",
      handle: "42",
      identity: "generation",
      cwd: directory,
      heartbeatPath: alternativeHeartbeat,
      sessionId: "session",
      sessionPath,
      consent: true,
    };
    const toolResult = await execute("adopt", { action: "runtime_adopt", ...registration });
    expect(toolResult.isError).toBe(true);
    const direct = await app.request("/v1/runtime/registrations", {
      method: "POST",
      headers: { authorization: "Bearer agent-token", "content-type": "application/json" },
      body: JSON.stringify(registration),
    });
    expect(direct.status).toBe(409);
    expect(storage.listRuntimeRequests("host")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31000);
    expect(readFileSync(heartbeatPath, "utf8")).toBe("32000");
    expect(() => readFileSync(alternativeHeartbeat)).toThrow();
    // Filesystem mtime uses the real clock; make it match the test's local heartbeat clock.
    utimesSync(heartbeatPath, new Date(Date.now()), new Date(Date.now()));
    const stop = vi.fn(async () => true);
    const adapter = {
      isAlive: vi.fn(async () => true),
      stop,
      spawn: vi.fn(async () => {
        throw new Error("No pending launch expected");
      }),
    };
    const manager = new RuntimeManager({
      baseUrl: "https://chat.test",
      token: "host-token",
      hostId: "host",
      sessionDir: directory,
      staleTimeoutMs: 30000,
      fetch: transport,
      adapters: { process: adapter, tmux: adapter, herdr: adapter },
    });
    await manager.poll();
    expect(stop).not.toHaveBeenCalled();
    expect(storage.getRuntimeRequest("managed")?.status).toBe("running");
    handlers.get("session_shutdown")!({}, {});
  } finally {
    storage.close();
  }
});

it("accepts exact manual retries but rejects changed ownership fields and a second principal for the same process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pinet-adoption-retry-"));
  directories.push(directory);
  const storage = new SqliteChatStorage(join(directory, "chat.sqlite"));
  try {
    const app = createChatApp({
      storage,
      credentials: [
        { token: "agent-token", principal: { kind: "agent", id: "agent" } },
        { token: "other-token", principal: { kind: "agent", id: "other" } },
        { token: "host-token", principal: { kind: "host", id: "host" } },
      ],
    });
    const registration = {
      consent: true,
      hostId: "host",
      adapter: "process",
      handle: "42",
      identity: "generation",
      cwd: directory,
      heartbeatPath: join(directory, "heartbeat"),
      sessionId: "session",
      sessionPath: join(directory, "session.jsonl"),
    };
    const post = (value: typeof registration, token = "agent-token") =>
      app.request("/v1/runtime/registrations", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    const first = await post(registration);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { id: string } };
    const retry = await post(registration);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(firstBody);
    for (const field of [
      "heartbeatPath",
      "handle",
      "identity",
      "cwd",
      "sessionPath",
      "adapter",
    ] as const) {
      expect(
        (await post({ ...registration, [field]: field === "adapter" ? "tmux" : "changed" })).status,
      ).toBe(409);
    }
    expect(
      (await post({ ...registration, sessionId: "different-session" }, "other-token")).status,
    ).toBe(409);
    expect(storage.listRuntimeRequests("host")).toHaveLength(1);

    const firstId = firstBody.data.id;
    expect(
      (
        await app.request(`/v1/runtime/requests/${firstId}/report`, {
          method: "POST",
          headers: { authorization: "Bearer host-token", "content-type": "application/json" },
          body: JSON.stringify({ status: "stopped" }),
        })
      ).status,
    ).toBe(200);
    const resumed = await post(registration);
    expect(resumed.status).toBe(201);
    const resumedId = ((await resumed.json()) as { data: { id: string } }).data.id;
    expect(resumedId).not.toBe(firstId);
    const resumedRetry = await post(registration);
    expect(resumedRetry.status).toBe(200);
    expect(((await resumedRetry.json()) as { data: { id: string } }).data.id).toBe(resumedId);
    expect(storage.listRuntimeRequests("host")).toHaveLength(2);
  } finally {
    storage.close();
  }
});
