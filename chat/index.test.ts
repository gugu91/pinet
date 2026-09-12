import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerChat } from "./index.js";

type LifecycleHandler = (event: object, ctx: object) => Promise<void> | void;
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Chat extension lifecycle", () => {
  it("adopts the canonical current session idempotently and preserves an existing heartbeat on failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const directory = mkdtempSync(join(tmpdir(), "pinet-chat-adopt-"));
    directories.push(directory);
    const sessionPath = join(directory, "current.jsonl");
    const managedHeartbeat = join(directory, "managed.heartbeat");
    const adoptedHeartbeat = join(directory, "adopted.heartbeat");
    writeFileSync(sessionPath, '{"type":"session","id":"stable-session"}\n');
    const registrations: string[] = [];
    let failAdoption = false;
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/runtime/registrations") {
        registrations.push(init!.body!.toString());
        if (failAdoption) throw new Error("registration unavailable");
        return Response.json({ data: { id: "same-runtime", heartbeatPath: adoptedHeartbeat } });
      }
      if (url.pathname === "/v1/mentions") return Response.json({ data: [] });
      return Response.json({ data: {} });
    });
    const handlers = new Map<string, LifecycleHandler>();
    let tool: { execute(id: string, raw: object): Promise<{ details: object; isError?: boolean }> };
    registerChat(
      {
        on: (name: string, handler: LifecycleHandler) => handlers.set(name, handler),
        sendUserMessage: vi.fn(),
        registerTool: (value: typeof tool) => {
          tool = value;
        },
        registerCommand: vi.fn(),
      } as never,
      {
        baseUrl: "https://chat.test",
        token: "child",
        agentId: "runtime",
        localHeartbeatPath: managedHeartbeat,
        localHeartbeatIntervalMs: 1000,
        fetch: transport,
      },
    );
    handlers.get("session_start")!({}, { sessionManager: { getSessionFile: () => sessionPath } });
    await Promise.resolve();
    const adoption = {
      action: "runtime_adopt",
      hostId: "host",
      adapter: "process",
      handle: "42",
      identity: "generation",
      cwd: directory,
      heartbeatPath: adoptedHeartbeat,
    };
    failAdoption = true;
    const failedPath = join(directory, "failed.heartbeat");
    const failed = await tool!.execute("failed", { ...adoption, heartbeatPath: failedPath });
    expect(failed.isError).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(readFileSync(managedHeartbeat, "utf8")).toBe("2000");
    expect(() => readFileSync(failedPath, "utf8")).toThrow();

    failAdoption = false;
    const first = await tool!.execute("one", adoption);
    const second = await tool!.execute("two", adoption);
    expect(first.details).toEqual(second.details);
    expect(registrations.map((body) => JSON.parse(body))).toEqual([
      expect.objectContaining({ sessionId: "stable-session", sessionPath }),
      expect.objectContaining({ sessionId: "stable-session", sessionPath }),
      expect.objectContaining({ sessionId: "stable-session", sessionPath }),
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(readFileSync(adoptedHeartbeat, "utf8")).toBe("3000");
    expect(readFileSync(managedHeartbeat, "utf8")).toBe("2000");
    handlers.get("session_shutdown")!({}, {});
  });
  it("registers a scoped child, joins its channel, reports the real session, and recovers mention cursor", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "pinet-chat-extension-"));
    directories.push(directory);
    const cursorPath = join(directory, "cursor");
    const sessionPath = join(directory, "actual.jsonl");
    writeFileSync(sessionPath, '{"type":"session","id":"actual-session-id"}\n');
    const requests: Array<{ path: string; body?: string }> = [];
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ path: `${url.pathname}${url.search}`, body: init?.body?.toString() });
      if (url.pathname === "/v1/mentions") {
        return Response.json({
          data:
            url.searchParams.get("after") === "0"
              ? [{ cursor: 7, senderId: "sender", channelId: "channel", markdown: "wake" }]
              : [],
        });
      }
      return Response.json({ data: {} });
    });
    const handlers = new Map<string, LifecycleHandler>();
    const sendUserMessage = vi.fn();
    const pi = {
      on: vi.fn((name: string, handler: LifecycleHandler) => handlers.set(name, handler)),
      sendUserMessage,
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    };
    registerChat(pi as never, {
      baseUrl: "https://chat.test",
      token: "child-token",
      agentId: "runtime-request",
      runtimeRequestId: "request",
      channelId: "channel",
      cursorPath,
      fetch: transport,
    });
    await handlers.get("session_start")!(
      {},
      {
        sessionManager: {
          getSessionFile: () => sessionPath,
        },
      },
    );
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    expect(requests.map((request) => request.path)).toEqual([
      "/v1/mentions?after=0",
      "/v1/agents",
      "/v1/channels/channel/join",
      "/v1/runtime/requests/request/heartbeat",
    ]);
    expect(JSON.parse(requests[3]!.body!)).toEqual({
      sessionId: "actual-session-id",
      sessionPath,
    });
    expect(sendUserMessage).toHaveBeenCalledWith(
      "[Pinet Chat mention from sender in channel]\nwake",
      { deliverAs: "followUp" },
    );
    expect(vi.getTimerCount()).toBe(2);
    handlers.get("session_shutdown")!({}, {});
    expect(vi.getTimerCount()).toBe(0);

    const restartedHandlers = new Map<string, LifecycleHandler>();
    registerChat(
      {
        on: (name: string, handler: LifecycleHandler) => restartedHandlers.set(name, handler),
        sendUserMessage: vi.fn(),
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
      } as never,
      {
        baseUrl: "https://chat.test",
        token: "child-token",
        agentId: "runtime-request",
        cursorPath,
        fetch: transport,
      },
    );
    await restartedHandlers.get("session_start")!(
      {},
      {
        sessionManager: { getSessionFile: () => sessionPath },
      },
    );
    expect(requests.at(-1)?.path).toBe("/v1/mentions?after=7");
    restartedHandlers.get("session_shutdown")!({}, {});
  });

  it("installs independent retries and keeps the local heartbeat alive through remote bootstrap failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const directory = mkdtempSync(join(tmpdir(), "pinet-chat-outage-"));
    directories.push(directory);
    const heartbeatPath = join(directory, "runtime.heartbeat");
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new Error("mention outage"))
      .mockRejectedValueOnce(new Error("bootstrap outage"))
      .mockResolvedValue(Response.json({ data: [] }));
    const handlers = new Map<string, LifecycleHandler>();
    registerChat(
      {
        on: (name: string, handler: LifecycleHandler) => handlers.set(name, handler),
        sendUserMessage: vi.fn(),
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
      } as never,
      {
        baseUrl: "https://chat.test",
        token: "child",
        agentId: "runtime",
        runtimeRequestId: "request",
        localHeartbeatPath: heartbeatPath,
        localHeartbeatIntervalMs: 1000,
        pollIntervalMs: 2000,
        heartbeatIntervalMs: 5000,
        fetch: transport,
      },
    );
    handlers.get("session_start")!(
      {},
      {
        sessionManager: { getSessionFile: () => undefined },
      },
    );
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(3);
    expect(readFileSync(heartbeatPath, "utf8")).toBe("1000");
    vi.setSystemTime(2000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(readFileSync(heartbeatPath, "utf8")).toBe("3000");
    await vi.advanceTimersByTimeAsync(4000);
    expect(transport.mock.calls.length).toBeGreaterThan(2);
    handlers.get("session_shutdown")!({}, {});
    expect(vi.getTimerCount()).toBe(0);
  });
});
