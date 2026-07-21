import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerDB } from "./schema.js";
import { BrokerSocketServer } from "./socket-server.js";
import { BrokerClient } from "./client.js";

const FIXTURES_DIR = fileURLToPath(new URL("../../broker-core/test-fixtures", import.meta.url));
const TLS_KEY = fs.readFileSync(path.join(FIXTURES_DIR, "tls-test-key.pem"), "utf-8");
const TLS_CERT = fs.readFileSync(path.join(FIXTURES_DIR, "tls-test-cert.pem"), "utf-8");
// SHA-256 fingerprint of tls-test-cert.pem (see test-fixtures/README.md).
const TLS_CERT_FINGERPRINT =
  "51:D7:CC:A7:E8:82:DA:DE:77:8D:1B:D7:14:22:00:AD:C9:3E:3B:7B:13:31:B0:2C:DA:AF:CD:3A:7A:D8:25:E0";
const WRONG_FINGERPRINT = "0".repeat(64);
const MESH_SECRET = "tls-transport-test-secret";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "broker-tls-"));
}

describe("broker TLS transport", () => {
  let dir: string;
  let db: BrokerDB;
  let server: BrokerSocketServer | null;
  let clients: BrokerClient[];

  beforeEach(() => {
    dir = tmpDir();
    db = new BrokerDB(path.join(dir, "test.db"));
    db.initialize();
    db.setAllowedUsers(null);
    server = null;
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) {
      client.disconnect();
    }
    await server?.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function startTlsServer(): Promise<{ host: string; port: number }> {
    server = new BrokerSocketServer(
      db,
      {
        type: "tls",
        host: "127.0.0.1",
        port: 0,
        tls: { key: TLS_KEY, cert: TLS_CERT },
      },
      { meshSecret: MESH_SECRET },
    );
    await server.start();
    const info = server.getConnectInfo();
    if (info.type !== "tls") throw new Error("Expected TLS connect info");
    return { host: info.host, port: info.port };
  }

  function trackClient(client: BrokerClient): BrokerClient {
    clients.push(client);
    return client;
  }

  it("registers and round-trips over TLS with a pinned certificate", async () => {
    const { host, port } = await startTlsServer();
    const client = trackClient(
      new BrokerClient({
        host,
        port,
        tls: { pinnedCertSha256: TLS_CERT_FINGERPRINT },
        meshSecret: MESH_SECRET,
      }),
    );

    await client.connect();
    const registration = await client.register("tls-worker", "🔐");
    expect(registration.agentId).toBeTruthy();

    const agents = await client.listAgents();
    expect(agents.map((agent) => agent.name)).toContain("tls-worker");
  });

  it("registers over TLS using the certificate as a CA trust anchor", async () => {
    const { port } = await startTlsServer();
    const client = trackClient(
      new BrokerClient({
        host: "127.0.0.1",
        port,
        tls: { ca: TLS_CERT },
        meshSecret: MESH_SECRET,
      }),
    );

    await client.connect();
    const registration = await client.register("tls-ca-worker", "🔐");
    expect(registration.name).toBe("tls-ca-worker");
  });

  it("rejects a connection whose certificate does not match the pin", async () => {
    const { host, port } = await startTlsServer();
    const client = trackClient(
      new BrokerClient({
        host,
        port,
        tls: { pinnedCertSha256: WRONG_FINGERPRINT },
        meshSecret: MESH_SECRET,
      }),
    );

    await expect(client.connect()).rejects.toThrow(/pinned SHA-256/);
  });

  it("rejects a plaintext client dialing the TLS endpoint", async () => {
    const { host, port } = await startTlsServer();
    // Plaintext loopback TCP is allowed client-side, but the TLS server kills
    // the connection during the failed handshake, so auth never completes.
    const client = trackClient(new BrokerClient({ host, port, meshSecret: MESH_SECRET }));

    await expect(client.connect()).rejects.toThrow();
  });

  it("refuses to construct a client TLS target without a trust anchor", () => {
    expect(() => new BrokerClient({ host: "192.0.2.10", port: 9999, tls: {} })).toThrow(
      /trust anchor/,
    );
  });

  it("still refuses plaintext TCP to non-loopback hosts", () => {
    expect(() => new BrokerClient({ host: "192.0.2.10", port: 9999 })).toThrow(/loopback/);
  });

  it("allows constructing a client for a non-loopback TLS endpoint", () => {
    expect(
      () =>
        new BrokerClient({
          host: "192.0.2.10",
          port: 9999,
          tls: { pinnedCertSha256: TLS_CERT_FINGERPRINT },
        }),
    ).not.toThrow();
  });

  it("refuses a non-loopback TLS bind without mesh auth", () => {
    expect(
      () =>
        new BrokerSocketServer(db, {
          type: "tls",
          host: "0.0.0.0",
          port: 0,
          tls: { key: TLS_KEY, cert: TLS_CERT },
        }),
    ).toThrow(/mesh authentication/);
  });

  it("refuses a TLS bind without key or cert", () => {
    expect(
      () =>
        new BrokerSocketServer(
          db,
          { type: "tls", host: "127.0.0.1", port: 0, tls: { key: "", cert: TLS_CERT } },
          { meshSecret: MESH_SECRET },
        ),
    ).toThrow(/private key and a certificate/);
  });

  it("reconnects and re-registers over TLS after the server restarts", async () => {
    const { host, port } = await startTlsServer();
    const client = trackClient(
      new BrokerClient({
        host,
        port,
        tls: { pinnedCertSha256: TLS_CERT_FINGERPRINT },
        meshSecret: MESH_SECRET,
        reconnectDelayMs: () => 25,
      }),
    );

    await client.connect();
    await client.register("tls-reconnect-worker", "🔁", undefined, "stable-tls-reconnect");

    let reconnected = false;
    client.onReconnect(() => {
      reconnected = true;
    });

    await server!.stop();
    server = new BrokerSocketServer(
      db,
      { type: "tls", host, port, tls: { key: TLS_KEY, cert: TLS_CERT } },
      { meshSecret: MESH_SECRET },
    );
    await server.start();

    const deadline = Date.now() + 5000;
    while (!reconnected) {
      if (Date.now() > deadline) throw new Error("timed out waiting for TLS reconnect");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(client.isConnected()).toBe(true);
    const agents = await client.listAgents();
    expect(agents.map((agent) => agent.name)).toContain("tls-reconnect-worker");
  });
});
