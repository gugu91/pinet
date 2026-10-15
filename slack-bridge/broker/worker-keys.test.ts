import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrokerClient } from "./client.js";
import { BrokerDB } from "./schema.js";
import { BrokerSocketServer } from "./socket-server.js";

const MESH_SECRET = "test-mesh-secret";

describe("worker keys over the broker socket", () => {
  let root: string;
  let socketPath: string;
  let db: BrokerDB;
  let server: BrokerSocketServer;
  let admin: BrokerClient;
  const clients: BrokerClient[] = [];
  const slackCalls: object[] = [];

  const workerClient = (workerKey: string) => {
    const client = new BrokerClient({ path: socketPath, workerKey, reconnectDelayMs: () => 10 });
    clients.push(client);
    return client;
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-worker-keys-"));
    socketPath = path.join(root, "broker.sock");
    db = new BrokerDB(path.join(root, "broker.db"));
    db.initialize();
    server = new BrokerSocketServer(db, socketPath, { meshSecret: MESH_SECRET });
    server.setOutboundMessageAdapters([
      {
        name: "slack",
        send: vi.fn(),
        invokeCapability: async ({ params }) => {
          slackCalls.push(params);
          return { result: { ok: true } };
        },
      },
    ]);
    await server.start();
    admin = new BrokerClient({ path: socketPath, meshSecret: MESH_SECRET });
    clients.push(admin);
    await admin.connect();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    slackCalls.length = 0;
    await server.stop();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("logs a worker in as its assigned identity and keeps broker-owned metadata", async () => {
    const issued = await admin.issueWorkerKey({ hostId: "studio", workerId: "w1" });
    expect(issued.stableId).toBe("studio:worker:w1");
    const worker = workerClient(issued.key);
    await worker.connect();
    expect(worker.workerStableId).toBe("studio:worker:w1");

    await expect(worker.register("", "", {}, "studio:worker:w2")).rejects.toThrow(
      'registers as "studio:worker:w1"',
    );
    const forged = {
      role: "broker",
      brokerManaged: true,
      brokerManagedBy: "broker-self",
      capabilities: { role: "broker", repos: ["pinet"] },
    };
    const { agentId } = await worker.register("", "", forged, "studio:worker:w1");
    await worker.heartbeat({ ...forged, pinetBrokerManaged: { brokerManaged: true } });

    const agent = db.getAgentById(agentId)!;
    expect(agent.pid).toBe(0);
    expect(agent.metadata).toEqual({
      role: "worker",
      capabilities: { role: "worker", repos: ["pinet"] },
      pinetWorker: { hostId: "studio", workerId: "w1" },
    });
  });

  it("limits worker connections to collaboration, not broker administration or broker files", async () => {
    const worker = workerClient(
      (await admin.issueWorkerKey({ hostId: "studio", workerId: "w1" })).key,
    );
    await worker.connect();
    await worker.register("", "", {}, "studio:worker:w1");

    await expect(worker.issueWorkerKey({ hostId: "studio", workerId: "w2" })).rejects.toThrow(
      "not available to worker-key connections",
    );
    await expect(worker.searchAgentSessions({})).rejects.toThrow(
      "not available to worker-key connections",
    );
    await expect(
      worker.sendMessage({
        threadId: "1712345678.000100",
        body: "here",
        files: [{ path: "/etc/hosts" }],
      }),
    ).rejects.toThrow("cannot attach files by path");
    await expect(worker.invokeAdapterCapability("slack", "files.download")).rejects.toThrow(
      "not available to worker-key connections",
    );

    await worker.slackProxy("auth.test", {});
    expect(slackCalls).toEqual([{ method: "auth.test", params: {} }]);
    const lease = await worker.acquirePortLease({
      purpose: "dev server",
      ttlMs: 60_000,
      host: "127.0.0.1",
      port: 4321,
    });
    expect(lease.host).toBe("studio");
  });

  it("closes live connections on revoke and rotation, and the old key cannot rejoin", async () => {
    const first = await admin.issueWorkerKey({ hostId: "studio", workerId: "w1" });
    const worker = workerClient(first.key);
    const reconnectFailed = vi.fn();
    worker.onReconnectFailed(reconnectFailed);
    await worker.connect();
    await worker.register("", "", {}, "studio:worker:w1");
    expect(await admin.listWorkerKeys()).toMatchObject([{ hostId: "studio", connected: true }]);

    const second = await admin.issueWorkerKey({ hostId: "studio", workerId: "w1" });
    await vi.waitFor(() => expect(reconnectFailed).toHaveBeenCalledOnce());
    expect(worker.isConnected()).toBe(false);
    await expect(workerClient(first.key).connect()).rejects.toThrow("Invalid or revoked");

    const rotated = workerClient(second.key);
    await rotated.connect();
    await rotated.register("", "", {}, "studio:worker:w1");
    expect(await admin.revokeWorkerKey({ hostId: "studio", workerId: "w1" })).toMatchObject({
      revoked: true,
    });
    await vi.waitFor(() => expect(rotated.isConnected()).toBe(false));
    await expect(workerClient(second.key).connect()).rejects.toThrow("Invalid or revoked");
    expect(await admin.listWorkerKeys()).toHaveLength(2);
  });

  it("refuses to run with live worker keys and no mesh secret", async () => {
    await admin.issueWorkerKey({ hostId: "studio", workerId: "w1" });
    const open = new BrokerSocketServer(db, path.join(root, "open.sock"));
    await expect(open.start()).rejects.toThrow("live worker keys but no mesh secret");
  });

  it("rejects malformed identities", async () => {
    await expect(admin.issueWorkerKey({ hostId: "a:b", workerId: "w1" })).rejects.toThrow(
      "hostId and workerId must be",
    );
  });
});
