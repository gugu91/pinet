import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { WorkerMembership, workerStableId } from "./membership.js";
import { BrokerDB } from "./schema.js";
import { BrokerSocketServer } from "./socket-server.js";
import { BrokerClient } from "./client.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("worker membership", () => {
  it("stores hashes, authenticates and revokes individual credentials without revoking siblings", () => {
    const db = new DatabaseSync(":memory:");
    cleanups.push(() => db.close());
    const membership = new WorkerMembership(db);
    const a = membership.issue("host", "a"),
      b = membership.issue("host", "b");
    expect(membership.authenticate(a.credentialId, a.credentialSecret)?.workerId).toBe("a");
    expect(membership.authenticate(a.credentialId, "wrong")).toBeNull();
    expect(JSON.stringify(db.prepare("SELECT * FROM worker_credentials").all())).not.toContain(
      a.credentialSecret,
    );
    membership.revoke(a.credentialId);
    expect(membership.authenticate(a.credentialId, a.credentialSecret)).toBeNull();
    expect(membership.authenticate(b.credentialId, b.credentialSecret)?.workerId).toBe("b");
    membership.revokeHost("host");
    expect(membership.authenticate(b.credentialId, b.credentialSecret)).toBeNull();
  });

  it("separates runtime connection leases from worker identity", () => {
    const db = new DatabaseSync(":memory:");
    cleanups.push(() => db.close());
    const membership = new WorkerMembership(db),
      credential = membership.issue("h", "w");
    membership.connect(credential, "a", "first", 10_000, "shell", "runtime-one");
    membership.connect(credential, "a", "second", 10_000, "rex", "runtime-two");
    membership.disconnect("first");
    const row = db.prepare("SELECT * FROM worker_connections").get();
    expect(row).toMatchObject({
      stable_id: workerStableId(credential),
      runtime_kind: "rex",
      runtime_handle: "runtime-two",
      disconnected_at: null,
    });
    membership.disconnect("second");
    expect(
      db.prepare("SELECT disconnected_at FROM worker_connections").get()?.disconnected_at,
    ).toBeTypeOf("string");
  });

  it("authenticates real sockets, binds identity, rejects admin elevation, expires and revokes live sessions", async () => {
    const db = new BrokerDB(":memory:");
    db.initialize();
    cleanups.push(() => db.close());
    const server = new BrokerSocketServer(
      db,
      { type: "tcp", host: "127.0.0.1", port: 0 },
      { meshSecret: "legacy", workerSessionMs: 200 },
    );
    await server.start();
    cleanups.push(() => server.stop());
    const endpoint = server.getConnectInfo();
    if (endpoint.type !== "tcp") throw new Error("TCP expected");
    const credential = db.membership.issue("host", "worker");
    const client = new BrokerClient({ host: endpoint.host, port: endpoint.port, ...credential });
    cleanups.push(() => client.disconnect());
    await client.connect();
    await expect(client.register("bad", "", {}, "another-id")).rejects.toThrow(
      "different stable identity",
    );
    const identity = await client.register(
      "worker",
      "",
      { role: "broker", brokerManaged: true },
      workerStableId(credential),
    );
    expect(db.getAgentById(identity.agentId)?.metadata).toMatchObject({
      role: "worker",
      brokerManaged: false,
    });
    await expect(client.searchAgentSessions()).rejects.toThrow("requires a broker agent");
    db.membership.revoke(credential.credentialId);
    await expect(client.listAgents()).rejects.toThrow("expired or revoked");
    client.disconnect();
    const revoked = new BrokerClient({ host: endpoint.host, port: endpoint.port, ...credential });
    cleanups.push(() => revoked.disconnect());
    await expect(revoked.connect()).rejects.toThrow("revoked");
    const fresh = db.membership.issue("host", "fresh");
    const expiring = new BrokerClient({ host: endpoint.host, port: endpoint.port, ...fresh });
    cleanups.push(() => expiring.disconnect());
    await expiring.connect();
    await expiring.register("fresh", "", {}, workerStableId(fresh));
    await new Promise((resolve) => setTimeout(resolve, 220));
    await expect(expiring.listAgents()).rejects.toThrow("expired or revoked");
  });
});
