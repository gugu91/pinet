import { describe, expect, it, vi } from "vitest";
import { RuntimeManager } from "./runtime-manager.js";
import type { RuntimeAdapter, RuntimeHandle, SpawnSpec } from "./runtime.js";

class FakeAdapter implements RuntimeAdapter {
  spawned: SpawnSpec[] = [];
  stop = vi.fn(async () => true);
  isAlive = vi.fn(async () => true);
  async spawn(spec: SpawnSpec): Promise<RuntimeHandle> {
    this.spawned.push(spec);
    return { adapter: "process", handle: "42", identity: "launch" };
  }
}
const pending = {
  id: "request",
  prompt: "work",
  worktree: null,
  adapter: "process" as const,
  status: "pending",
  channelId: "channel",
  handle: null,
  identity: null,
  agentLastSeen: null,
  startedAt: null,
};

describe("RuntimeManager", () => {
  it("passes only the per-child launch credential and channel identity to the adapter", async () => {
    const adapter = new FakeAdapter();
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/claim"))
        return Response.json({
          data: { ...pending, status: "claimed" },
          launch: { token: "scoped-child-token", agentId: "runtime-request" },
        });
      if (url.pathname === "/v1/runtime/requests" && url.searchParams.get("status") === "pending")
        return Response.json({ data: [pending] });
      if (url.pathname === "/v1/runtime/requests" && url.searchParams.get("status") === "running")
        return Response.json({ data: [] });
      return Response.json({ data: {} });
    });
    const manager = new RuntimeManager({
      baseUrl: "https://chat.test",
      token: "host-token",
      hostId: "host",
      sessionDir: "/sessions",
      adapters: { process: adapter, tmux: adapter, herdr: adapter },
      fetch: transport,
    });
    await manager.poll();
    expect(adapter.spawned).toHaveLength(1);
    expect(adapter.spawned[0]?.env).toEqual({
      PINET_CHAT_URL: "https://chat.test",
      PINET_CHAT_TOKEN: "scoped-child-token",
      PINET_AGENT_ID: "runtime-request",
      PINET_RUNTIME_REQUEST_ID: "request",
      PINET_CHAT_CHANNEL_ID: "channel",
    });
    expect(adapter.spawned[0]?.env.PINET_CHAT_TOKEN).not.toBe("host-token");
  });

  it("identity-checks and stops a stale child only while the service is reachable", async () => {
    const adapter = new FakeAdapter();
    const running = {
      ...pending,
      status: "running",
      handle: "42",
      identity: "launch",
      agentLastSeen: 10,
      startedAt: 1,
    };
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/runtime/requests" && url.searchParams.get("status") === "pending")
        return Response.json({ data: [] });
      if (url.pathname === "/v1/runtime/requests" && url.searchParams.get("status") === "running")
        return Response.json({ data: [running] });
      return Response.json({ data: {} });
    });
    const manager = new RuntimeManager({
      baseUrl: "https://chat.test",
      token: "host-token",
      hostId: "host",
      sessionDir: "/sessions",
      staleTimeoutMs: 50,
      now: () => 100,
      adapters: { process: adapter, tmux: adapter, herdr: adapter },
      fetch: transport,
    });
    await manager.poll();
    expect(adapter.isAlive).toHaveBeenCalledWith({
      adapter: "process",
      handle: "42",
      identity: "launch",
    });
    expect(adapter.stop).toHaveBeenCalledTimes(1);

    const outageAdapter = new FakeAdapter();
    const outageManager = new RuntimeManager({
      baseUrl: "https://chat.test",
      token: "host-token",
      hostId: "host",
      sessionDir: "/sessions",
      staleTimeoutMs: 50,
      now: () => 100,
      adapters: { process: outageAdapter, tmux: outageAdapter, herdr: outageAdapter },
      fetch: vi.fn(async () => Promise.reject(new Error("service outage"))),
    });
    await expect(outageManager.poll()).rejects.toThrow("service outage");
    expect(outageAdapter.stop).not.toHaveBeenCalled();
  });
});
