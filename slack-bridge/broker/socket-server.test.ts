import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrokerDB } from "./schema.js";
import { BrokerSocketServer } from "./socket-server.js";
import { probeBrokerSocket } from "./lock-conflict.js";

// ─── Helpers ─────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sock-srv-"));
}

// ─── Unix socket file lifecycle (#953) ───────────────────
//
// stop() must unlink the socket path only while it still holds the socket
// this server bound. A successor broker binds a fresh socket at the same
// path during takeover; a late shutdown of the previous owner must never
// sever it.

describe("BrokerSocketServer unix socket file lifecycle", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stop() removes the socket file it bound", async () => {
    const db = new BrokerDB(path.join(dir, "a.db"));
    db.initialize();
    const sockPath = path.join(dir, "s.sock");
    const server = new BrokerSocketServer(db, sockPath);
    await server.start();
    expect(fs.existsSync(sockPath)).toBe(true);

    await server.stop();
    db.close();
    expect(fs.existsSync(sockPath)).toBe(false);
  });

  it("stop() preserves a successor's socket bound at the same path", async () => {
    const sockPath = path.join(dir, "s.sock");
    const previousDb = new BrokerDB(path.join(dir, "a.db"));
    previousDb.initialize();
    const previous = new BrokerSocketServer(previousDb, sockPath);
    await previous.start();

    // Successor takeover: start() replaces the stale-looking file with a
    // fresh socket bound by the successor.
    const successorDb = new BrokerDB(path.join(dir, "b.db"));
    successorDb.initialize();
    const successor = new BrokerSocketServer(successorDb, sockPath);
    await successor.start();

    try {
      // The previous owner's shutdown must not unlink the successor's socket.
      await previous.stop();
      previousDb.close();
      expect(fs.existsSync(sockPath)).toBe(true);
      expect(await probeBrokerSocket({ socketPath: sockPath })).toBe("healthy");
    } finally {
      await successor.stop();
      successorDb.close();
    }

    // The live owner's own shutdown still cleans up.
    expect(fs.existsSync(sockPath)).toBe(false);
  });
});
