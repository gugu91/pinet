import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrokerDB } from "./schema.js";
import { BrokerSocketServer } from "./socket-server.js";
import { startBroker } from "./index.js";
import { inspectBrokerLock, readBrokerLockOwner } from "./leader.js";
import { probeBrokerSocket, replaceBrokerOwner } from "./lock-conflict.js";

// ─── Cross-process replace-lifecycle E2E (#953) ──────────
//
// A real broker child process acquires the real leader lock and serves
// `admin.shutdown` on a real socket, while this (parent) process drives the
// `/pinet start replace` composition against it: graceful shutdown RPC →
// wait for lock release → successor acquisition. Timeouts are generous and
// the assertion set deliberately small to stay CI-stable.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

type ChildMode = "graceful" | "holdout" | "socket-holdout";

/**
 * Child program: resolves the repo's `.ts` sources under plain `node` (the
 * sources use `.js` specifiers and `@pinet/*` workspace imports, and built
 * dist output may be absent or stale), then runs one broker child mode:
 *
 * - `graceful`       — real `startBroker`; `admin.shutdown` stops the broker.
 * - `holdout`        — real `startBroker`; accepts `admin.shutdown` but never
 *                      releases (the fenced-SIGTERM escalation target).
 * - `socket-holdout` — socket server only; keeps serving until gated, then
 *                      runs its own `stop()` after the parent has taken over
 *                      the socket path.
 */
const CHILD_SOURCE = `
import { registerHooks } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = process.argv[2];
const mode = process.argv[3];
const dir = process.argv[4];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const scoped = specifier.match(/^@pinet\\/([^/]+)(?:\\/(.+))?$/);
    if (scoped) {
      const target = path.join(repoRoot, scoped[1], (scoped[2] ?? "index") + ".ts");
      return { url: pathToFileURL(target).href, shortCircuit: true };
    }
    if (
      specifier.endsWith(".js") &&
      specifier.startsWith(".") &&
      context.parentURL?.startsWith("file:")
    ) {
      const tsPath = path.resolve(
        path.dirname(fileURLToPath(context.parentURL)),
        specifier.slice(0, -3) + ".ts",
      );
      if (fs.existsSync(tsPath)) {
        return { url: pathToFileURL(tsPath).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const broker = await import(
  pathToFileURL(path.join(repoRoot, "slack-bridge/broker/index.ts")).href
);

const socketPath = path.join(dir, "s.sock");
const readyPath = path.join(dir, "ready.json");
const gatePath = path.join(dir, "gate");
const resultPath = path.join(dir, "result.json");
const acceptedPath = path.join(dir, "accepted");

if (mode === "socket-holdout") {
  const db = new broker.BrokerDB(path.join(dir, "child.db"));
  db.initialize();
  const server = new broker.BrokerSocketServer(db, socketPath);
  await server.start();
  fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid, instanceId: null }));
  const poll = setInterval(() => {
    if (!fs.existsSync(gatePath)) return;
    clearInterval(poll);
    void server.stop().then(() => {
      db.close();
      fs.writeFileSync(resultPath, JSON.stringify({ stopped: true }));
      process.exit(0);
    });
  }, 50);
} else {
  const running = await broker.startBroker({
    lockPath: path.join(dir, "lock"),
    dbPath: path.join(dir, "child.db"),
    socketPath,
  });
  running.server.setAdminShutdownHandler(() => {
    fs.writeFileSync(acceptedPath, "accepted");
    if (mode !== "graceful") return; // holdout: accept but never release
    void running.stop().then(() => {
      fs.writeFileSync(resultPath, JSON.stringify({ stopped: true }));
      process.exit(0);
    });
  });
  fs.writeFileSync(
    readyPath,
    JSON.stringify({ pid: process.pid, instanceId: running.lock.getInstanceId() }),
  );
}
`;

interface SpawnedBrokerChild {
  child: ChildProcess;
  exited: Promise<void>;
}

describe("cross-process /pinet start replace lifecycle", () => {
  let dir: string;
  let spawned: SpawnedBrokerChild | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r953-"));
    spawned = null;
  });

  afterEach(async () => {
    if (spawned) {
      const { child, exited } = spawned;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited.catch(() => {});
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const lockPath = (): string => path.join(dir, "lock");
  const socketPath = (): string => path.join(dir, "s.sock");
  const childStderrPath = (): string => path.join(dir, "child-stderr.log");

  function spawnBrokerChild(mode: ChildMode): SpawnedBrokerChild {
    const script = path.join(dir, "broker-child.mjs");
    fs.writeFileSync(script, CHILD_SOURCE, "utf-8");
    const stderr = fs.openSync(childStderrPath(), "w");
    const child = spawn(
      process.execPath,
      ["--no-warnings", "--experimental-transform-types", script, REPO_ROOT, mode, dir],
      { stdio: ["ignore", "ignore", stderr] },
    );
    fs.closeSync(stderr);
    // Attach the exit promise immediately — a listener attached after the
    // event has fired never resolves.
    const exited = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", () => resolve());
    });
    spawned = { child, exited };
    return spawned;
  }

  async function waitForFile(filePath: string, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(filePath)) {
      if (Date.now() > deadline) {
        let childLog = "";
        try {
          childLog = fs.readFileSync(childStderrPath(), "utf-8");
        } catch {
          /* no log */
        }
        throw new Error(`Timed out waiting for ${what}.\nChild stderr:\n${childLog}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function waitForChildReady(): Promise<{ pid: number; instanceId: string | null }> {
    const readyPath = path.join(dir, "ready.json");
    await waitForFile(readyPath, "broker child readiness");
    return JSON.parse(fs.readFileSync(readyPath, "utf-8")) as {
      pid: number;
      instanceId: string | null;
    };
  }

  it("replaces a live broker gracefully and hands the lock to the successor exactly once", async () => {
    const { child, exited } = spawnBrokerChild("graceful");
    const ready = await waitForChildReady();

    // The child holds the real lock and serves the real socket.
    const before = readBrokerLockOwner(lockPath());
    expect(before?.pid).toBe(ready.pid);
    expect(before?.instanceId).toBe(ready.instanceId);
    expect(await probeBrokerSocket({ socketPath: socketPath() })).toBe("healthy");

    const result = await replaceBrokerOwner({
      lockPath: lockPath(),
      socketPath: socketPath(),
      shutdownRpcTimeoutMs: 10_000,
      gracefulWaitMs: 20_000,
      pollIntervalMs: 100,
    });
    expect(result.outcome).toBe("replaced-graceful");
    expect(result.owner?.pid).toBe(ready.pid);

    // The old owner released its own lock — nothing reclaimed it forcibly.
    expect(inspectBrokerLock(lockPath()).state).toBe("none");
    await waitForFile(path.join(dir, "result.json"), "broker child shutdown result");
    await exited;
    expect(child.exitCode).toBe(0);

    // Successor acquisition: the lock changes hands to this process and the
    // socket serves again.
    const successor = await startBroker({
      lockPath: lockPath(),
      dbPath: path.join(dir, "successor.db"),
      socketPath: socketPath(),
    });
    try {
      const after = readBrokerLockOwner(lockPath());
      expect(after?.pid).toBe(process.pid);
      expect(after?.instanceId).toBe(successor.lock.getInstanceId());
      expect(await probeBrokerSocket({ socketPath: socketPath() })).toBe("healthy");
    } finally {
      await successor.stop();
    }
  }, 45_000);

  it("escalates to fenced SIGTERM when the owner accepts the shutdown RPC but never releases", async () => {
    const { child, exited } = spawnBrokerChild("holdout");
    const ready = await waitForChildReady();
    expect(await probeBrokerSocket({ socketPath: socketPath() })).toBe("healthy");

    const result = await replaceBrokerOwner({
      lockPath: lockPath(),
      socketPath: socketPath(),
      shutdownRpcTimeoutMs: 10_000,
      gracefulWaitMs: 1_500,
      terminateWaitMs: 20_000,
      pollIntervalMs: 100,
    });
    expect(result.outcome).toBe("replaced-terminated");
    expect(result.owner?.pid).toBe(ready.pid);
    // The child accepted the RPC — this exercised the escalation, not a
    // broker that never got the request.
    expect(fs.existsSync(path.join(dir, "accepted"))).toBe(true);

    await exited;
    expect(child.signalCode).toBe("SIGTERM");

    // The stale lock the terminated owner left behind is reclaimed by a
    // normal successor start.
    const successor = await startBroker({
      lockPath: lockPath(),
      dbPath: path.join(dir, "successor.db"),
      socketPath: socketPath(),
    });
    try {
      expect(readBrokerLockOwner(lockPath())?.pid).toBe(process.pid);
      expect(await probeBrokerSocket({ socketPath: socketPath() })).toBe("healthy");
    } finally {
      await successor.stop();
    }
  }, 45_000);

  it("preserves the successor's live socket when the replaced owner shuts down late (#953)", async () => {
    const { exited } = spawnBrokerChild("socket-holdout");
    await waitForChildReady();
    expect(await probeBrokerSocket({ socketPath: socketPath() })).toBe("healthy");

    // Successor takeover of the socket path while the old owner still runs.
    const successorDb = new BrokerDB(path.join(dir, "successor.db"));
    successorDb.initialize();
    const successor = new BrokerSocketServer(successorDb, socketPath());
    await successor.start();
    try {
      // Gate open: the old owner now runs its own stop() in its own process.
      fs.writeFileSync(path.join(dir, "gate"), "go", "utf-8");
      await waitForFile(path.join(dir, "result.json"), "old owner shutdown result");
      await exited;

      // The non-owning shutdown must not have severed the live successor.
      expect(fs.existsSync(socketPath())).toBe(true);
      expect(await probeBrokerSocket({ socketPath: socketPath() })).toBe("healthy");
    } finally {
      await successor.stop();
      successorDb.close();
    }
    // The live owner's own shutdown still cleans up the socket file.
    expect(fs.existsSync(socketPath())).toBe(false);
  }, 45_000);
});
