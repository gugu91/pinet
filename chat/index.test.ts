import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(requests.map((request) => request.path)).toEqual([
      "/v1/agents",
      "/v1/channels/channel/join",
      "/v1/runtime/requests/request/heartbeat",
      "/v1/mentions?after=0",
    ]);
    expect(JSON.parse(requests[2]!.body!)).toEqual({
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
    await restartedHandlers.get("session_start")!({}, {});
    expect(requests.at(-1)?.path).toBe("/v1/mentions?after=7");
    restartedHandlers.get("session_shutdown")!({}, {});
  });
});
