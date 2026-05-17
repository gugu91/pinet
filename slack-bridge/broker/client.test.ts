import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BrokerClient,
  DEFAULT_SOCKET_PATH,
  REQUEST_TIMEOUT_MS,
  RECONNECT_DELAY_MS,
  INITIAL_RECONNECT_DELAY_MS,
  MAX_RECONNECT_DELAY_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_METADATA_PROVIDER_TIMEOUT_MS,
  computeReconnectDelay,
} from "./client.js";
import type { BrokerConnectOpts } from "./client.js";
import { RPC_AGENT_NAME_CONFLICT, RPC_METHOD_NOT_FOUND } from "./types.js";

// ─── Helpers ─────────────────────────────────────────────

interface MockServer {
  server: net.Server;
  port: number;
  connections: net.Socket[];
  received: string[];
  close: () => Promise<void>;
  respondTo: (conn: net.Socket, id: number, result: unknown) => void;
  respondError: (conn: net.Socket, id: number, code: number, message: string) => void;
  connectOpts: BrokerConnectOpts;
}

function createMockServer(port = 0): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const connections: net.Socket[] = [];
    const received: string[] = [];

    const server = net.createServer((conn) => {
      connections.push(conn);
      let buffer = "";
      conn.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) received.push(line);
        }
      });
    });

    server.on("error", reject);

    // Use TCP on localhost (Unix sockets may be blocked in CI/sandbox)
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      const opts: BrokerConnectOpts = { host: "127.0.0.1", port: addr.port };
      resolve({
        server,
        port: addr.port,
        connections,
        received,
        connectOpts: opts,
        close: () =>
          new Promise<void>((res) => {
            for (const c of connections) c.destroy();
            server.close(() => res());
          }),
        respondTo: (conn, id, result) => {
          const msg = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
          conn.write(msg);
        },
        respondError: (conn, id, code, message) => {
          const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n";
          conn.write(msg);
        },
      });
    });
  });
}

/** Wait for a condition with timeout */
async function waitFor(fn: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ─── Tests ───────────────────────────────────────────────

describe("BrokerClient — constants", () => {
  it("DEFAULT_SOCKET_PATH points to ~/.pi/pinet.sock", () => {
    expect(DEFAULT_SOCKET_PATH).toBe(path.join(os.homedir(), ".pi", "pinet.sock"));
  });

  it("REQUEST_TIMEOUT_MS is 5000", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(5000);
  });

  it("RECONNECT_DELAY_MS is 3000", () => {
    expect(RECONNECT_DELAY_MS).toBe(3000);
  });

  it("INITIAL_RECONNECT_DELAY_MS is 1000", () => {
    expect(INITIAL_RECONNECT_DELAY_MS).toBe(1000);
  });

  it("MAX_RECONNECT_DELAY_MS is 30000", () => {
    expect(MAX_RECONNECT_DELAY_MS).toBe(30000);
  });
});

describe("BrokerClient — construction", () => {
  it("can be constructed with default socket path", () => {
    const client = new BrokerClient();
    expect(client.isConnected()).toBe(false);
  });

  it("can be constructed with custom socket path string", () => {
    const client = new BrokerClient("/tmp/custom.sock");
    expect(client.isConnected()).toBe(false);
  });

  it("can be constructed with TCP connect opts", () => {
    const client = new BrokerClient({ host: "127.0.0.1", port: 9999 });
    expect(client.isConnected()).toBe(false);
  });

  it("allows loopback TCP connect opts", () => {
    expect(() => new BrokerClient({ host: "localhost", port: 9999 })).not.toThrow();
    expect(() => new BrokerClient({ host: "127.0.0.42", port: 9999 })).not.toThrow();
    expect(() => new BrokerClient({ host: "::1", port: 9999 })).not.toThrow();
  });

  it("rejects non-loopback TCP connect opts", () => {
    expect(() => new BrokerClient({ host: "0.0.0.0", port: 9999 })).toThrow(/loopback-only/i);
    expect(() => new BrokerClient({ host: "192.168.1.25", port: 9999 })).toThrow(/loopback-only/i);
  });
});

describe("BrokerClient — connect / disconnect", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("connects to the server", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();
    expect(client.isConnected()).toBe(true);
    client.disconnect();
  });

  it("disconnect clears connected state", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();
    expect(client.isConnected()).toBe(true);
    client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  it("disconnect is safe to call without connect", () => {
    const client = new BrokerClient(mock.connectOpts);
    client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  it("rejects connect when server is not running", async () => {
    const client = new BrokerClient({ host: "127.0.0.1", port: 1 });
    await expect(client.connect()).rejects.toThrow();
  });
});

describe("BrokerClient — mesh auth", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("sends an auth RPC during connect when a mesh secret is configured", async () => {
    const client = new BrokerClient({ ...mock.connectOpts, meshSecret: "shared-secret" });
    const connectPromise = client.connect();

    await waitFor(() => mock.received.length === 1);
    const authReq = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { secret: string };
    };

    expect(authReq.method).toBe("auth");
    expect(authReq.params.secret).toBe("shared-secret");

    mock.respondTo(mock.connections[0], authReq.id, { ok: true });
    await connectPromise;
    expect(client.isConnected()).toBe(true);

    client.disconnect();
  });

  it("rejects connect when broker auth rejects the mesh secret", async () => {
    const client = new BrokerClient({ ...mock.connectOpts, meshSecret: "wrong-secret" });
    const connectPromise = client.connect();

    await waitFor(() => mock.received.length === 1);
    const authReq = JSON.parse(mock.received[0]) as { id: number };
    mock.respondError(mock.connections[0], authReq.id, -32001, "Invalid mesh secret.");

    await expect(connectPromise).rejects.toThrow("Invalid mesh secret.");
    expect(client.isConnected()).toBe(false);
  });

  it("surfaces a friendly error when a configured mesh secret file is missing", async () => {
    const client = new BrokerClient({
      ...mock.connectOpts,
      meshSecretPath: path.join(os.tmpdir(), `missing-${Date.now()}-pinet.secret`),
    });

    await expect(client.connect()).rejects.toThrow("Configured Pinet mesh secret file not found");
    expect(client.isConnected()).toBe(false);
    expect(mock.received).toHaveLength(0);
  });

  it("surfaces a compatibility error when the broker does not support auth", async () => {
    const client = new BrokerClient({ ...mock.connectOpts, meshSecret: "shared-secret" });
    const connectPromise = client.connect();

    await waitFor(() => mock.received.length === 1);
    const authReq = JSON.parse(mock.received[0]) as { id: number; method: string };

    expect(authReq.method).toBe("auth");
    mock.respondError(
      mock.connections[0],
      authReq.id,
      RPC_METHOD_NOT_FOUND,
      "Unknown method: auth",
    );

    await expect(connectPromise).rejects.toThrow(
      "Broker does not support Pinet mesh auth (`auth`). Upgrade the broker or disable follower mesh auth when connecting to older/no-auth brokers.",
    );
    expect(client.isConnected()).toBe(false);
  });
});

describe("BrokerClient — register", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("sends register RPC and returns agent identity", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const registerPromise = client.register("TestAgent", "🤖");

    // Wait for the server to receive the request
    await waitFor(() => mock.received.length > 0);

    const req = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { name: string; emoji: string; pid: number };
    };
    expect(req.method).toBe("register");
    expect(req.params.name).toBe("TestAgent");
    expect(req.params.emoji).toBe("🤖");
    expect(req.params.pid).toBe(process.pid);

    // Respond
    mock.respondTo(mock.connections[0], req.id, {
      agentId: "agent-001",
      name: "TestAgent",
      emoji: "🤖",
    });

    const result = await registerPromise;
    expect(result).toEqual({ agentId: "agent-001", name: "TestAgent", emoji: "🤖" });

    client.disconnect();
  });

  it("includes stableId when provided", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const registerPromise = client.register("StableBot", "🧷", undefined, "host:session:/tmp/a");

    await waitFor(() => mock.received.length > 0);

    const req = JSON.parse(mock.received[0]) as {
      id: number;
      params: { stableId?: string };
    };
    expect(req.params.stableId).toBe("host:session:/tmp/a");

    mock.respondTo(mock.connections[0], req.id, {
      agentId: "agent-stable",
      name: "StableBot",
      emoji: "🧷",
    });

    await expect(registerPromise).resolves.toEqual({
      agentId: "agent-stable",
      name: "StableBot",
      emoji: "🧷",
    });

    client.disconnect();
  });
});

describe("BrokerClient — heartbeat / unregister", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await mock.close();
  });

  it("starts sending heartbeats after register", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");

    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const registerPromise = client.register("HeartbeatBot", "💓");
    await waitFor(() => mock.received.length > 0);

    const registerReq = JSON.parse(mock.received[0]) as { id: number };
    mock.respondTo(mock.connections[0], registerReq.id, {
      agentId: "hb-1",
      name: "HeartbeatBot",
      emoji: "💓",
    });
    await registerPromise;

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), HEARTBEAT_INTERVAL_MS);
    const heartbeatTick = setIntervalSpy.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    expect(heartbeatTick).toBeDefined();
    heartbeatTick?.();

    await waitFor(() => mock.received.length > 1);

    const heartbeatReq = JSON.parse(mock.received[1]) as { id: number; method: string };
    expect(heartbeatReq.method).toBe("heartbeat");
    mock.respondTo(mock.connections[0], heartbeatReq.id, { ok: true });

    setIntervalSpy.mockRestore();
    client.disconnect();
  });

  it("sends heartbeat metadata when the provider resolves", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();
    client.setHeartbeatMetadataProvider(async () => ({
      branch: "feature/live",
      workdirDirty: true,
    }));

    const registerPromise = client.register("HeartbeatBot", "💓");
    await waitFor(() => mock.received.length > 0);
    const registerReq = JSON.parse(mock.received[0]) as { id: number };
    mock.respondTo(mock.connections[0], registerReq.id, {
      agentId: "hb-meta",
      name: "HeartbeatBot",
      emoji: "💓",
    });
    await registerPromise;

    const heartbeatTick = setIntervalSpy.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    heartbeatTick?.();

    await waitFor(() => mock.received.length > 1);
    const heartbeatReq = JSON.parse(mock.received[1]) as {
      id: number;
      method: string;
      params?: { metadata?: Record<string, unknown> };
    };
    expect(heartbeatReq.method).toBe("heartbeat");
    expect(heartbeatReq.params?.metadata).toEqual({ branch: "feature/live", workdirDirty: true });
    mock.respondTo(mock.connections[0], heartbeatReq.id, { ok: true });

    setIntervalSpy.mockRestore();
    client.disconnect();
  });

  it("falls back to a plain heartbeat while a metadata provider is hung", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();
    const metadataProvider = vi.fn(
      () =>
        new Promise<Record<string, unknown>>(() => {
          // never resolves
        }),
    );
    client.setHeartbeatMetadataProvider(metadataProvider);

    const registerPromise = client.register("HeartbeatBot", "💓");
    await waitFor(() => mock.received.length > 0);
    const registerReq = JSON.parse(mock.received[0]) as { id: number };
    mock.respondTo(mock.connections[0], registerReq.id, {
      agentId: "hb-timeout",
      name: "HeartbeatBot",
      emoji: "💓",
    });
    await registerPromise;

    const heartbeatTick = setIntervalSpy.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    vi.useFakeTimers();
    try {
      heartbeatTick?.();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_METADATA_PROVIDER_TIMEOUT_MS + 1);
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => mock.received.length > 1);
    const heartbeatReq = JSON.parse(mock.received[1]) as {
      id: number;
      method: string;
      params?: { metadata?: unknown };
    };
    expect(heartbeatReq.method).toBe("heartbeat");
    expect(heartbeatReq.params?.metadata).toBeUndefined();
    mock.respondTo(mock.connections[0], heartbeatReq.id, { ok: true });

    heartbeatTick?.();
    await waitFor(() => mock.received.length > 2);
    expect(metadataProvider).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
    client.disconnect();
  });

  it("sends unregister RPC", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const registerPromise = client.register("GracefulBot", "👋");
    await waitFor(() => mock.received.length > 0);
    const registerReq = JSON.parse(mock.received[0]) as { id: number };
    mock.respondTo(mock.connections[0], registerReq.id, {
      agentId: "grace-1",
      name: "GracefulBot",
      emoji: "👋",
    });
    await registerPromise;

    const unregisterPromise = client.unregister();
    await waitFor(() => mock.received.length > 1);

    const unregisterReq = JSON.parse(mock.received[1]) as { id: number; method: string };
    expect(unregisterReq.method).toBe("unregister");

    mock.respondTo(mock.connections[0], unregisterReq.id, { ok: true });
    await unregisterPromise;

    client.disconnect();
  });

  it("disconnectGracefully unregisters, stops heartbeat, and closes the socket", async () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const registerPromise = client.register("GracefulBot", "👋");
    await waitFor(() => mock.received.length > 0);
    const registerReq = JSON.parse(mock.received[0]) as { id: number };
    mock.respondTo(mock.connections[0], registerReq.id, {
      agentId: "grace-2",
      name: "GracefulBot",
      emoji: "👋",
    });
    await registerPromise;

    const disconnectPromise = client.disconnectGracefully();
    await waitFor(() => mock.received.length > 1);

    const unregisterReq = JSON.parse(mock.received[1]) as { id: number; method: string };
    expect(unregisterReq.method).toBe("unregister");

    mock.respondTo(mock.connections[0], unregisterReq.id, { ok: true });
    await disconnectPromise;

    await waitFor(() => mock.connections[0]?.destroyed === true);
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(client.isConnected()).toBe(false);

    clearIntervalSpy.mockRestore();
  });

  it("disconnectGracefully still disconnects locally when unregister fails", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const registerPromise = client.register("GracefulBot", "👋");
    await waitFor(() => mock.received.length > 0);
    const registerReq = JSON.parse(mock.received[0]) as { id: number };
    mock.respondTo(mock.connections[0], registerReq.id, {
      agentId: "grace-3",
      name: "GracefulBot",
      emoji: "👋",
    });
    await registerPromise;

    const disconnectPromise = client.disconnectGracefully();
    await waitFor(() => mock.received.length > 1);

    const unregisterReq = JSON.parse(mock.received[1]) as { id: number; method: string };
    expect(unregisterReq.method).toBe("unregister");

    mock.respondError(mock.connections[0], unregisterReq.id, -32000, "broker unavailable");
    await expect(disconnectPromise).rejects.toThrow("broker unavailable");
    await waitFor(() => mock.connections[0]?.destroyed === true);
    expect(client.isConnected()).toBe(false);
  });
});

describe("BrokerClient — pollInbox", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("sends inbox.poll and parses response", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const pollPromise = client.pollInbox();

    await waitFor(() => mock.received.length > 0);

    const req = JSON.parse(mock.received[0]) as { id: number; method: string };
    expect(req.method).toBe("inbox.poll");

    const items = [
      {
        inboxId: 1,
        message: {
          id: 1,
          threadId: "100.200",
          source: "slack",
          direction: "inbound",
          sender: "U456",
          body: "Hello",
          metadata: { userName: "Alice", channel: "D123" },
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
      {
        inboxId: 2,
        message: {
          id: 2,
          threadId: "100.200",
          source: "slack",
          direction: "inbound",
          sender: "U789",
          body: "Hi there",
          metadata: { channel: "D123" },
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
    ];

    mock.respondTo(mock.connections[0], req.id, items);

    const result = await pollPromise;
    expect(result).toHaveLength(2);
    expect(result[0].message.threadId).toBe("100.200");
    expect(result[0].message.metadata?.userName).toBe("Alice");
    expect(result[1].message.body).toBe("Hi there");

    client.disconnect();
  });

  it("returns empty array when no messages", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const pollPromise = client.pollInbox();

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as { id: number };
    mock.respondTo(mock.connections[0], req.id, []);

    const result = await pollPromise;
    expect(result).toEqual([]);

    client.disconnect();
  });
});

describe("BrokerClient — readInbox", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("sends inbox.read and normalizes durable read rows", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const readPromise = client.readInbox({ threadId: "a2a:broker:worker", limit: 5 });

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { threadId: string; limit: number };
    };
    expect(req.method).toBe("inbox.read");
    expect(req.params).toEqual({ threadId: "a2a:broker:worker", limit: 5 });

    mock.respondTo(mock.connections[0], req.id, {
      messages: [
        {
          entry: { id: 31, delivered: true, readAt: "2026-04-25T12:00:00.000Z" },
          message: {
            id: 44,
            threadId: "a2a:broker:worker",
            source: "agent",
            direction: "inbound",
            sender: "broker",
            body: "please inspect #594",
            metadata: { a2a: true },
            createdAt: "2026-04-25T11:59:00.000Z",
          },
        },
      ],
      unreadCountBefore: 2,
      unreadCountAfter: 1,
      unreadThreads: [],
      markedReadIds: [31],
    });

    const result = await readPromise;
    expect(result.messages).toEqual([
      {
        inboxId: 31,
        delivered: true,
        readAt: "2026-04-25T12:00:00.000Z",
        message: {
          id: 44,
          threadId: "a2a:broker:worker",
          source: "agent",
          direction: "inbound",
          sender: "broker",
          body: "please inspect #594",
          metadata: { a2a: true },
          createdAt: "2026-04-25T11:59:00.000Z",
        },
      },
    ]);
    expect(result.unreadCountBefore).toBe(2);
    expect(result.unreadCountAfter).toBe(1);
    expect(result.markedReadIds).toEqual([31]);

    client.disconnect();
  });
});

describe("BrokerClient — ackMessages", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("sends inbox.ack with message ids", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const ackPromise = client.ackMessages([1, 2, 3]);

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { ids: number[] };
    };
    expect(req.method).toBe("inbox.ack");
    expect(req.params.ids).toEqual([1, 2, 3]);

    mock.respondTo(mock.connections[0], req.id, {});

    await ackPromise;

    client.disconnect();
  });
});

describe("BrokerClient — send", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("sends message.send with correct payload", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const sendPromise = client.send("100.200", "Hello world");

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { threadId: string; body: string };
    };
    expect(req.method).toBe("send");
    expect(req.params.threadId).toBe("100.200");
    expect(req.params.body).toBe("Hello world");

    mock.respondTo(mock.connections[0], req.id, {});

    await sendPromise;

    client.disconnect();
  });

  it("includes metadata when provided", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const sendPromise = client.send("100.200", "Hello", { agent: "TestBot" });

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as {
      id: number;
      params: { metadata: { agent: string } };
    };
    expect(req.params.metadata).toEqual({ agent: "TestBot" });

    mock.respondTo(mock.connections[0], req.id, {});

    await sendPromise;

    client.disconnect();
  });

  it("omits metadata key when not provided", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const sendPromise = client.send("100.200", "Hello");

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as {
      id: number;
      params: Record<string, unknown>;
    };
    expect(req.params).not.toHaveProperty("metadata");

    mock.respondTo(mock.connections[0], req.id, {});

    await sendPromise;

    client.disconnect();
  });
});

describe("BrokerClient — message.send", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("sends message.send with the transport payload", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const sendPromise = client.sendMessage({
      threadId: "imessage:chat:alice",
      body: "hello",
      source: "imessage",
      channel: "chat:alice",
      agentName: "Sender",
    });

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: {
        threadId: string;
        body: string;
        source: string;
        channel: string;
        agentName: string;
      };
    };
    expect(req.method).toBe("message.send");
    expect(req.params).toMatchObject({
      threadId: "imessage:chat:alice",
      body: "hello",
      source: "imessage",
      channel: "chat:alice",
      agentName: "Sender",
    });

    mock.respondTo(mock.connections[0], req.id, {
      adapter: "imessage",
      messageId: 9,
      threadId: "imessage:chat:alice",
      channel: "chat:alice",
      source: "imessage",
    });

    await expect(sendPromise).resolves.toEqual({
      adapter: "imessage",
      messageId: 9,
      threadId: "imessage:chat:alice",
      channel: "chat:alice",
      source: "imessage",
    });

    client.disconnect();
  });

  it("includes normalized content and blocks in message.send payload when provided", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();
    const blocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Transport-aware*" },
      },
    ] satisfies ReadonlyArray<Record<string, unknown>>;

    const sendPromise = client.sendMessage({
      threadId: "100.200",
      body: "fallback text",
      source: "slack",
      channel: "C123",
      content: {
        text: "fallback text",
        markdown: "**fallback text**",
        slackBlocks: blocks,
      },
      blocks,
    });

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(req.method).toBe("message.send");
    expect(req.params).toMatchObject({
      threadId: "100.200",
      body: "fallback text",
      source: "slack",
      channel: "C123",
      content: {
        text: "fallback text",
        markdown: "**fallback text**",
        slackBlocks: blocks,
      },
      blocks,
    });

    mock.respondTo(mock.connections[0], req.id, {
      adapter: "slack",
      messageId: 10,
      threadId: "100.200",
      channel: "C123",
      source: "slack",
    });

    await expect(sendPromise).resolves.toEqual({
      adapter: "slack",
      messageId: 10,
      threadId: "100.200",
      channel: "C123",
      source: "slack",
    });

    client.disconnect();
  });
});

describe("BrokerClient — listThreads / listAgents", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("lists threads via RPC", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const threadsPromise = client.listThreads();

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as { id: number; method: string };
    expect(req.method).toBe("threads.list");

    const threads = [
      {
        threadId: "100.200",
        source: "slack",
        channel: "C1",
        ownerAgent: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    mock.respondTo(mock.connections[0], req.id, threads);

    const result = await threadsPromise;
    expect(result).toEqual(threads);

    client.disconnect();
  });

  it("lists agents via RPC", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const agentsPromise = client.listAgents();

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as { id: number; method: string };
    expect(req.method).toBe("agents.list");

    const agents = [
      {
        id: "a1",
        name: "Bot1",
        emoji: "🤖",
        pid: 1000,
        connectedAt: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        lastHeartbeat: "2026-01-01T00:00:00Z",
      },
    ];
    mock.respondTo(mock.connections[0], req.id, agents);

    const result = await agentsPromise;
    expect(result).toEqual(agents);

    client.disconnect();
  });

  it("includes includeDisconnected when requested", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const agentsPromise = client.listAgents(true);

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params?: { includeDisconnected?: boolean };
    };
    expect(req.method).toBe("agents.list");
    expect(req.params?.includeDisconnected).toBe(true);

    mock.respondTo(mock.connections[0], req.id, []);
    await expect(agentsPromise).resolves.toEqual([]);

    client.disconnect();
  });
});

describe("BrokerClient — resolveThread", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("sends resolveThread RPC and returns the channelId", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const resolvePromise = client.resolveThread("1234.5678");

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { threadTs: string };
    };
    expect(req.method).toBe("resolveThread");
    expect(req.params.threadTs).toBe("1234.5678");

    mock.respondTo(mock.connections[0], req.id, { channelId: "C123" });

    await expect(resolvePromise).resolves.toBe("C123");

    client.disconnect();
  });

  it("returns null when the broker has no channel for the thread", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const resolvePromise = client.resolveThread("missing-thread");

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as { id: number };

    mock.respondTo(mock.connections[0], req.id, { channelId: null });

    await expect(resolvePromise).resolves.toBeNull();

    client.disconnect();
  });
});

describe("BrokerClient — sendAgentMessage", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("sends agent.message RPC and returns messageId", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const msgPromise = client.sendAgentMessage("target-agent", "Hello agent", {
      kind: "pinet_control",
      command: "reload",
    });

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { targetAgent: string; body: string; metadata?: Record<string, unknown> };
    };
    expect(req.method).toBe("agent.message");
    expect(req.params.targetAgent).toBe("target-agent");
    expect(req.params.body).toBe("Hello agent");
    expect(req.params.metadata).toEqual({ kind: "pinet_control", command: "reload" });

    mock.respondTo(mock.connections[0], req.id, { ok: true, messageId: 42 });

    const result = await msgPromise;
    expect(result).toBe(42);

    client.disconnect();
  });

  it("rejects when target agent not found", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const msgPromise = client.sendAgentMessage("ghost", "Hello?");

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as { id: number };

    mock.respondError(mock.connections[0], req.id, -32602, "Agent not found: ghost");

    await expect(msgPromise).rejects.toThrow("Agent not found: ghost");

    client.disconnect();
  });
});

describe("BrokerClient — sendAgentBroadcast", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("sends agent.broadcast RPC and returns recipient details", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const broadcastPromise = client.sendAgentBroadcast("#extensions", "Hello everyone");

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { channel: string; body: string };
    };
    expect(req.method).toBe("agent.broadcast");
    expect(req.params.channel).toBe("#extensions");
    expect(req.params.body).toBe("Hello everyone");

    mock.respondTo(mock.connections[0], req.id, {
      ok: true,
      channel: "#extensions",
      messageIds: [11, 12],
      recipients: [
        { id: "agent-a", name: "Alpha" },
        { id: "agent-b", name: "Beta" },
      ],
    });

    await expect(broadcastPromise).resolves.toEqual({
      channel: "#extensions",
      messageIds: [11, 12],
      recipients: [
        { id: "agent-a", name: "Alpha" },
        { id: "agent-b", name: "Beta" },
      ],
    });

    client.disconnect();
  });
});

describe("BrokerClient — scheduleWakeup", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("sends schedule.create RPC and returns the scheduled wake-up", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const wakeupPromise = client.scheduleWakeup("2026-04-02T14:05:00.000Z", "Check PR #62");

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { fireAt: string; body: string };
    };
    expect(req.method).toBe("schedule.create");
    expect(req.params.fireAt).toBe("2026-04-02T14:05:00.000Z");
    expect(req.params.body).toBe("Check PR #62");

    mock.respondTo(mock.connections[0], req.id, {
      id: 7,
      threadId: "wakeup:agent-1",
      fireAt: "2026-04-02T14:05:00.000Z",
    });

    await expect(wakeupPromise).resolves.toEqual({
      id: 7,
      threadId: "wakeup:agent-1",
      fireAt: "2026-04-02T14:05:00.000Z",
    });

    client.disconnect();
  });
});
describe("BrokerClient — slackProxy", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("sends slack.proxy RPC with method and params", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const proxyPromise = client.slackProxy("conversations.history", {
      channel: "C123",
      limit: 10,
    });

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { method: string; params: Record<string, unknown> };
    };
    expect(req.method).toBe("slack.proxy");
    expect(req.params.method).toBe("conversations.history");
    expect(req.params.params.channel).toBe("C123");

    mock.respondTo(mock.connections[0], req.id, { messages: [] });

    const result = await proxyPromise;
    expect(result).toEqual({ messages: [] });

    client.disconnect();
  });
});

describe("BrokerClient — error handling", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("rejects on JSON-RPC error response", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const registerPromise = client.register("Bot", "🤖");

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as { id: number };

    mock.respondError(mock.connections[0], req.id, -32600, "Invalid agent name");

    await expect(registerPromise).rejects.toThrow("Invalid agent name");

    client.disconnect();
  });

  it("rejects when not connected", async () => {
    const client = new BrokerClient(mock.connectOpts);
    // Don't connect
    await expect(client.pollInbox()).rejects.toThrow("Not connected to broker");
  });
});

describe("BrokerClient — request timeout", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await mock.close();
  });

  it("times out when server does not respond", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    vi.useFakeTimers();

    const registerPromise = client.register("Bot", "🤖");

    // Advance past the timeout without responding
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS + 100);

    await expect(registerPromise).rejects.toThrow("Request timed out: register");

    vi.useRealTimers();
    client.disconnect();
  });
});

describe("BrokerClient — reconnect on disconnect", () => {
  it("calls onDisconnect handler when server drops", async () => {
    const mock = await createMockServer();

    const client = new BrokerClient(mock.connectOpts);
    const disconnected = new Promise<void>((resolve) => {
      client.onDisconnect(() => resolve());
    });

    await client.connect();
    expect(client.isConnected()).toBe(true);

    // Close the server and all connections to force client disconnect
    await mock.close();

    await disconnected;
    expect(client.isConnected()).toBe(false);

    client.disconnect(); // stop reconnect attempts
  });

  it("rejects pending requests when connection drops", async () => {
    const mock = await createMockServer();

    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const pollPromise = client.pollInbox();

    // Wait for request to be sent
    await waitFor(() => mock.received.length > 0);

    // Drop the connection without responding
    for (const conn of mock.connections) conn.destroy();

    await expect(pollPromise).rejects.toThrow("Socket closed");

    client.disconnect();
    await mock.close();
  });
});

describe("BrokerClient — multiple concurrent requests", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("matches responses to correct requests via id", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    // Fire two requests concurrently
    const p1 = client.pollInbox();
    const p2 = client.listAgents();

    await waitFor(() => mock.received.length >= 2);

    const req1 = JSON.parse(mock.received[0]) as { id: number; method: string };
    const req2 = JSON.parse(mock.received[1]) as { id: number; method: string };

    // Respond in reverse order
    mock.respondTo(mock.connections[0], req2.id, [
      {
        id: "a1",
        name: "Bot",
        emoji: "🤖",
        pid: 1000,
        connectedAt: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        lastHeartbeat: "2026-01-01T00:00:00Z",
      },
    ]);
    mock.respondTo(mock.connections[0], req1.id, [
      {
        inboxId: 1,
        message: {
          id: 1,
          threadId: "t1",
          source: "slack",
          direction: "inbound",
          sender: "U1",
          body: "hi",
          metadata: null,
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
    ]);

    const [inbox, agents] = await Promise.all([p1, p2]);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].message.body).toBe("hi");
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("Bot");

    client.disconnect();
  });
});

describe("BrokerClient — exponential backoff", () => {
  it("computeReconnectDelay doubles each attempt up to max", () => {
    // With random=0.5, jitter multiplier is 1.0 (no jitter), so delay = base
    expect(computeReconnectDelay(0, 0.5)).toBe(1000);
    expect(computeReconnectDelay(1, 0.5)).toBe(2000);
    expect(computeReconnectDelay(2, 0.5)).toBe(4000);
    expect(computeReconnectDelay(3, 0.5)).toBe(8000);
    expect(computeReconnectDelay(4, 0.5)).toBe(16000);
    // Capped at MAX
    expect(computeReconnectDelay(5, 0.5)).toBe(MAX_RECONNECT_DELAY_MS);
    expect(computeReconnectDelay(10, 0.5)).toBe(MAX_RECONNECT_DELAY_MS);
  });

  it("computeReconnectDelay applies jitter of ±25%", () => {
    // random=0 → multiplier=0.75, random=1 → multiplier=1.25
    const minDelay = computeReconnectDelay(0, 0); // 1000 * 0.75 = 750
    const maxDelay = computeReconnectDelay(0, 1); // 1000 * 1.25 = 1250
    expect(minDelay).toBe(750);
    expect(maxDelay).toBe(1250);
  });

  it("computeReconnectDelay caps jitter at MAX", () => {
    // Even with max jitter, should not exceed MAX * 1.25
    const maxWithJitter = computeReconnectDelay(20, 1);
    expect(maxWithJitter).toBeLessThanOrEqual(MAX_RECONNECT_DELAY_MS * 1.25);
    expect(maxWithJitter).toBeGreaterThanOrEqual(MAX_RECONNECT_DELAY_MS * 0.75);
  });

  it("reconnectAttempt starts at 0 and increments after disconnect", async () => {
    const mock = await createMockServer();
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();
    expect(client.getReconnectAttempt()).toBe(0);

    // Close server entirely so reconnects fail
    // scheduleReconnect increments the counter synchronously before the timer
    await mock.close();

    await waitFor(() => client.getReconnectAttempt() > 0);
    expect(client.getReconnectAttempt()).toBeGreaterThanOrEqual(1);

    client.disconnect();
  });
});

describe("BrokerClient — onReconnect callback", () => {
  it("onReconnect does not fire from manual connect()", async () => {
    const mock = await createMockServer();
    const client = new BrokerClient(mock.connectOpts);
    let reconnectFired = false;

    client.onReconnect(() => {
      reconnectFired = true;
    });

    await client.connect();
    expect(client.isConnected()).toBe(true);

    // Manual disconnect + reconnect (not via scheduleReconnect)
    client.disconnect();
    expect(client.isConnected()).toBe(false);

    await client.connect();
    expect(client.isConnected()).toBe(true);

    // onReconnect is only called from scheduleReconnect's internal .then()
    expect(reconnectFired).toBe(false);

    client.disconnect();
    await mock.close();
  });

  it("reconnectOnce clears broken connected state and reschedules when re-register fails", async () => {
    const client = new BrokerClient({ host: "127.0.0.1", port: 1 });
    const failedSocket = { destroy: vi.fn() } as unknown as net.Socket;
    const scheduleReconnect = vi.fn();

    (
      client as unknown as { registrationSnapshot: { name: string; emoji: string } }
    ).registrationSnapshot = {
      name: "RetryBot",
      emoji: "🔁",
    };
    (
      client as unknown as {
        connectSocket: () => Promise<void>;
        socket: net.Socket | null;
        connected: boolean;
      }
    ).connectSocket = vi.fn(async () => {
      (client as unknown as { socket: net.Socket | null }).socket = failedSocket;
      (client as unknown as { connected: boolean }).connected = true;
    });
    (client as unknown as { performRegister: () => Promise<unknown> }).performRegister = vi.fn(
      async () => {
        throw new Error("register failed");
      },
    );
    (client as unknown as { scheduleReconnect: () => void }).scheduleReconnect = scheduleReconnect;

    await (client as unknown as { reconnectOnce: () => Promise<void> }).reconnectOnce();

    expect(failedSocket.destroy).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(false);
    expect((client as unknown as { socket: net.Socket | null }).socket).toBeNull();
    expect(scheduleReconnect).toHaveBeenCalledTimes(1);
  });

  it("scheduleReconnect fires onDisconnect then onReconnect after server restart", async () => {
    const mock = await createMockServer();
    const port = mock.port;
    const client = new BrokerClient(mock.connectOpts);
    let disconnectFired = false;
    let reconnectFired = false;

    client.onDisconnect(() => {
      disconnectFired = true;
    });
    client.onReconnect(() => {
      reconnectFired = true;
    });

    await client.connect();
    expect(client.isConnected()).toBe(true);

    // Close the server completely (this reliably triggers client close event)
    await mock.close();

    // Wait for disconnect to be detected
    await waitFor(() => disconnectFired);
    expect(disconnectFired).toBe(true);
    expect(client.isConnected()).toBe(false);

    // Restart a new server on the same port so the auto-reconnect succeeds
    await new Promise<void>((resolve, reject) => {
      const server2 = net.createServer();
      server2.on("error", reject);
      server2.listen(port, "127.0.0.1", () => resolve());
      // Store for cleanup
      (client as unknown as { _testServer2: net.Server })._testServer2 = server2;
    });

    // Wait for auto-reconnect to succeed
    await waitFor(() => reconnectFired, 10000);
    expect(reconnectFired).toBe(true);
    expect(client.isConnected()).toBe(true);
    expect(client.getReconnectAttempt()).toBe(0); // reset after success

    client.disconnect();
    const server2 = (client as unknown as { _testServer2: net.Server })._testServer2;
    await new Promise<void>((res) => server2.close(() => res()));
  }, 20000);

  it("keeps retrying until it can reconnect and re-register with stable identity", async () => {
    let mock = await createMockServer();
    const port = mock.port;
    const client = new BrokerClient(mock.connectOpts);
    let disconnectFired = false;
    let reconnectFired = false;

    client.onDisconnect(() => {
      disconnectFired = true;
    });
    client.onReconnect(() => {
      reconnectFired = true;
    });

    await client.connect();
    const registerPromise = client.register(
      "RetryBot",
      "🔁",
      { cwd: "/repo", branch: "main" },
      "host:session:/tmp/retry",
    );

    await waitFor(() => mock.received.length > 0);
    const registerReq = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { stableId?: string };
    };
    expect(registerReq.method).toBe("register");
    mock.respondTo(mock.connections[0], registerReq.id, {
      agentId: "retry-agent",
      name: "RetryBot",
      emoji: "🔁",
    });
    await registerPromise;

    await mock.close();
    await waitFor(() => disconnectFired, 2000);
    await waitFor(() => client.getReconnectAttempt() >= 2, 5000);

    mock = await createMockServer(port);
    await waitFor(() => mock.received.length > 0, 5000);

    const reRegisterReq = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { name: string; emoji: string; stableId?: string };
    };
    expect(reRegisterReq.method).toBe("register");
    expect(reRegisterReq.params.name).toBe("RetryBot");
    expect(reRegisterReq.params.emoji).toBe("🔁");
    expect(reRegisterReq.params.stableId).toBe("host:session:/tmp/retry");
    expect(reconnectFired).toBe(false);

    mock.respondTo(mock.connections[0], reRegisterReq.id, {
      agentId: "retry-agent",
      name: "RetryBot",
      emoji: "🔁",
    });

    await waitFor(() => reconnectFired, 5000);
    expect(reconnectFired).toBe(true);
    expect(client.isConnected()).toBe(true);
    expect(client.getReconnectAttempt()).toBe(0);
    expect(client.getRegisteredIdentity()).toEqual({
      agentId: "retry-agent",
      name: "RetryBot",
      emoji: "🔁",
    });

    client.disconnect();
    await mock.close();
  }, 20000);

  it("re-requests broker-assigned identity after reconnect when the original name was blank", async () => {
    let mock = await createMockServer();
    const port = mock.port;
    const client = new BrokerClient(mock.connectOpts);
    let disconnectFired = false;
    let reconnectFired = false;

    client.onDisconnect(() => {
      disconnectFired = true;
    });
    client.onReconnect(() => {
      reconnectFired = true;
    });

    await client.connect();
    const registerPromise = client.register(
      "",
      "",
      { cwd: "/repo", branch: "main" },
      "host:session:/tmp/broker-assigned",
    );

    await waitFor(() => mock.received.length > 0);
    const registerReq = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { name: string; emoji: string; stableId?: string };
    };
    expect(registerReq.method).toBe("register");
    expect(registerReq.params.name).toBe("");
    expect(registerReq.params.emoji).toBe("");
    mock.respondTo(mock.connections[0], registerReq.id, {
      agentId: "broker-assigned-agent",
      name: "Broker Bird",
      emoji: "🦩",
    });
    await registerPromise;

    await mock.close();
    await waitFor(() => disconnectFired, 2000);
    await waitFor(() => client.getReconnectAttempt() >= 2, 5000);

    mock = await createMockServer(port);
    await waitFor(() => mock.received.length > 0, 5000);

    const reRegisterReq = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { name: string; emoji: string; stableId?: string };
    };
    expect(reRegisterReq.method).toBe("register");
    expect(reRegisterReq.params.name).toBe("");
    expect(reRegisterReq.params.emoji).toBe("");
    expect(reRegisterReq.params.stableId).toBe("host:session:/tmp/broker-assigned");
    expect(reconnectFired).toBe(false);

    mock.respondTo(mock.connections[0], reRegisterReq.id, {
      agentId: "broker-assigned-agent",
      name: "Broker Bird",
      emoji: "🦩",
    });

    await waitFor(() => reconnectFired, 5000);
    expect(reconnectFired).toBe(true);
    expect(client.isConnected()).toBe(true);
    expect(client.getReconnectAttempt()).toBe(0);
    expect(client.getRegisteredIdentity()).toEqual({
      agentId: "broker-assigned-agent",
      name: "Broker Bird",
      emoji: "🦩",
    });

    client.disconnect();
    await mock.close();
  }, 20000);

  it("stops reconnecting and surfaces a terminal error when an explicit name collides on reconnect", async () => {
    let mock = await createMockServer();
    const port = mock.port;
    const client = new BrokerClient(mock.connectOpts);
    let disconnectFired = false;
    let reconnectFired = false;
    let reconnectFailed: Error | null = null;

    client.onDisconnect(() => {
      disconnectFired = true;
    });
    client.onReconnect(() => {
      reconnectFired = true;
    });
    client.onReconnectFailed((err) => {
      reconnectFailed = err;
    });

    await client.connect();
    const registerPromise = client.register(
      "Reserved Crane",
      "🦩",
      { cwd: "/repo", branch: "main" },
      "host:session:/tmp/reserved-crane",
    );

    await waitFor(() => mock.received.length > 0);
    const registerReq = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { name: string; emoji: string; stableId?: string };
    };
    expect(registerReq.method).toBe("register");
    expect(registerReq.params.name).toBe("Reserved Crane");
    expect(registerReq.params.emoji).toBe("🦩");
    mock.respondTo(mock.connections[0], registerReq.id, {
      agentId: "reserved-crane-agent",
      name: "Reserved Crane",
      emoji: "🦩",
    });
    await registerPromise;

    await mock.close();
    await waitFor(() => disconnectFired, 2000);
    await waitFor(() => client.getReconnectAttempt() >= 2, 5000);

    mock = await createMockServer(port);
    await waitFor(() => mock.received.length > 0, 5000);

    const reRegisterReq = JSON.parse(mock.received[0]) as {
      id: number;
      method: string;
      params: { name: string; emoji: string; stableId?: string };
    };
    expect(reRegisterReq.method).toBe("register");
    expect(reRegisterReq.params.name).toBe("Reserved Crane");
    expect(reRegisterReq.params.emoji).toBe("🦩");
    expect(reRegisterReq.params.stableId).toBe("host:session:/tmp/reserved-crane");

    mock.respondError(
      mock.connections[0],
      reRegisterReq.id,
      RPC_AGENT_NAME_CONFLICT,
      'Agent name "Reserved Crane" is already reserved. Retry with a different name or leave the name empty so the broker can assign one.',
    );

    await waitFor(() => reconnectFailed !== null, 5000);
    if (!reconnectFailed) {
      throw new Error("Expected reconnect failure to surface");
    }
    const surfacedReconnectFailure = reconnectFailed as Error;
    expect(surfacedReconnectFailure.message).toContain(
      'Agent name "Reserved Crane" is already reserved.',
    );
    expect(reconnectFired).toBe(false);
    expect(client.isConnected()).toBe(false);
    expect(client.getReconnectAttempt()).toBe(0);
    expect(client.getRegisteredIdentity()).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, INITIAL_RECONNECT_DELAY_MS + 250));
    expect(mock.received).toHaveLength(1);

    client.disconnect();
    await mock.close();
  }, 20000);
});

describe("BrokerClient — newline-delimited framing", () => {
  let mock: MockServer;

  beforeEach(async () => {
    mock = await createMockServer();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("handles response split across multiple chunks", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const pollPromise = client.pollInbox();

    await waitFor(() => mock.received.length > 0);
    const req = JSON.parse(mock.received[0]) as { id: number };

    // Send the response in two chunks (split mid-JSON)
    const fullResponse =
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: [],
      }) + "\n";

    const mid = Math.floor(fullResponse.length / 2);
    const conn = mock.connections[0];
    conn.write(fullResponse.slice(0, mid));

    // Small delay, then send the rest
    await new Promise((r) => setTimeout(r, 20));
    conn.write(fullResponse.slice(mid));

    const result = await pollPromise;
    expect(result).toEqual([]);

    client.disconnect();
  });

  it("handles multiple responses in a single chunk", async () => {
    const client = new BrokerClient(mock.connectOpts);
    await client.connect();

    const p1 = client.pollInbox();
    const p2 = client.listAgents();

    await waitFor(() => mock.received.length >= 2);

    const req1 = JSON.parse(mock.received[0]) as { id: number };
    const req2 = JSON.parse(mock.received[1]) as { id: number };

    // Send both responses in a single write
    const resp1 = JSON.stringify({ jsonrpc: "2.0", id: req1.id, result: [] });
    const resp2 = JSON.stringify({ jsonrpc: "2.0", id: req2.id, result: [] });
    mock.connections[0].write(resp1 + "\n" + resp2 + "\n");

    const [inbox, agents] = await Promise.all([p1, p2]);
    expect(inbox).toEqual([]);
    expect(agents).toEqual([]);

    client.disconnect();
  });
});
