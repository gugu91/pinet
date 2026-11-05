import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrokerClient } from "./client.js";
import { startBroker, type Broker } from "./index.js";
import type { MessageAdapter } from "./types.js";

describe("broker adapter lifecycle", () => {
  let broker: Broker | null = null;
  let client: BrokerClient | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    await client?.close();
    await broker?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("replaces runtime adapters without disconnecting workers or removing the socket", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-adapter-reload-"));
    const socketPath = path.join(dir, "pinet.sock");
    broker = await startBroker({
      dbPath: path.join(dir, "pinet.db"),
      socketPath,
      lockPath: path.join(dir, "pinet.lock"),
    });

    const disconnect = vi.fn(async () => {});
    const adapter: MessageAdapter = {
      name: "test",
      connect: vi.fn(async () => {}),
      disconnect,
      onInbound: vi.fn(),
      send: vi.fn(async () => {}),
    };
    broker.addAdapter(adapter);

    client = new BrokerClient({ path: socketPath });
    const statuses: string[] = [];
    await client.connect({ onStatus: (status) => statuses.push(status.kind) });
    await client.register("worker", "🧪");

    await broker.removeAdapters([adapter]);

    expect(disconnect).toHaveBeenCalledOnce();
    expect(statuses).toEqual(["connecting", "ready"]);
    expect(client.isConnected()).toBe(true);
    expect(fs.existsSync(socketPath)).toBe(true);
    await expect(client.listAgents()).resolves.toEqual([
      expect.objectContaining({ name: "worker", disconnectedAt: null }),
    ]);
  });

  it("surfaces adapter disconnect failures after removing them from broker routing", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-adapter-failure-"));
    broker = await startBroker({
      dbPath: path.join(dir, "pinet.db"),
      socketPath: path.join(dir, "pinet.sock"),
      lockPath: path.join(dir, "pinet.lock"),
    });
    const adapter: MessageAdapter = {
      name: "failing-test",
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {
        throw new Error("disconnect failed");
      }),
      onInbound: vi.fn(),
      send: vi.fn(async () => {}),
    };
    broker.addAdapter(adapter);

    await expect(broker.removeAdapters([adapter])).rejects.toThrow(
      "Failed to disconnect broker adapters",
    );

    expect(broker.adapters).toEqual([]);
  });
});
