import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultLockPath,
  getProcessStartTime,
  inspectBrokerLock,
  LeaderLock,
  readBrokerLockOwner,
} from "./leader.js";

// ─── Helpers ─────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "leader-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── defaultLockPath ─────────────────────────────────────

describe("defaultLockPath", () => {
  it("returns ~/.pi/pinet-broker.lock", () => {
    expect(defaultLockPath()).toBe(path.join(os.homedir(), ".pi", "pinet-broker.lock"));
  });
});

// ─── LeaderLock ──────────────────────────────────────────

describe("LeaderLock", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("uses the default lock path when none is provided", () => {
    const lock = new LeaderLock();
    expect(lock.getLockPath()).toBe(defaultLockPath());
  });

  it("uses a custom lock path when provided", () => {
    const custom = path.join(dir, "custom.lock");
    const lock = new LeaderLock(custom);
    expect(lock.getLockPath()).toBe(custom);
  });

  it("starts as non-leader", () => {
    const lock = new LeaderLock(path.join(dir, "lock"));
    expect(lock.isLeader()).toBe(false);
  });

  it("acquires the lock on first call", () => {
    const lockPath = path.join(dir, "lock");
    const lock = new LeaderLock(lockPath);
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isLeader()).toBe(true);
    lock.release();
  });

  it("tryAcquire is idempotent — second call still returns true", () => {
    const lock = new LeaderLock(path.join(dir, "lock"));
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });

  it("writes the current PID as the first line of the lock file", () => {
    const lockPath = path.join(dir, "lock");
    const lock = new LeaderLock(lockPath);
    lock.tryAcquire();

    const [pidLine] = fs.readFileSync(lockPath, "utf-8").split("\n");
    expect(pidLine).toBe(String(process.pid));
    // Legacy readers parse the whole trimmed content with parseInt — the
    // structured metadata must not change the PID they see.
    expect(parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10)).toBe(process.pid);

    lock.release();
  });

  it("writes structured owner metadata alongside the PID", () => {
    const lockPath = path.join(dir, "lock");
    const lock = new LeaderLock(lockPath);
    lock.tryAcquire();

    const owner = readBrokerLockOwner(lockPath);
    expect(owner).not.toBeNull();
    expect(owner?.pid).toBe(process.pid);
    expect(owner?.legacy).toBe(false);
    expect(owner?.instanceId).toBe(lock.getInstanceId());
    expect(owner?.createdAt).toBeTruthy();

    lock.release();
    expect(lock.getInstanceId()).toBeNull();
  });

  it("release removes the lock file", () => {
    const lockPath = path.join(dir, "lock");
    const lock = new LeaderLock(lockPath);
    lock.tryAcquire();

    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(lock.isLeader()).toBe(false);
  });

  it("release is safe when not acquired", () => {
    const lock = new LeaderLock(path.join(dir, "lock"));
    // Should not throw
    lock.release();
    expect(lock.isLeader()).toBe(false);
  });

  it("second lock fails while the first one holds", () => {
    const lockPath = path.join(dir, "lock");
    const lock1 = new LeaderLock(lockPath);
    const lock2 = new LeaderLock(lockPath);

    expect(lock1.tryAcquire()).toBe(true);
    expect(lock2.tryAcquire()).toBe(false);
    expect(lock2.isLeader()).toBe(false);

    lock1.release();
  });

  it("second lock succeeds after the first releases", () => {
    const lockPath = path.join(dir, "lock");
    const lock1 = new LeaderLock(lockPath);
    const lock2 = new LeaderLock(lockPath);

    lock1.tryAcquire();
    lock1.release();

    expect(lock2.tryAcquire()).toBe(true);
    expect(lock2.isLeader()).toBe(true);

    lock2.release();
  });

  it("reclaims a stale lock from a dead PID", () => {
    const lockPath = path.join(dir, "lock");

    // Write a PID that almost certainly does not exist
    fs.writeFileSync(lockPath, "2147483647", "utf-8");

    const lock = new LeaderLock(lockPath);
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isLeader()).toBe(true);

    lock.release();
  });

  it("creates parent directories if they do not exist", () => {
    const nested = path.join(dir, "a", "b", "lock");
    const lock = new LeaderLock(nested);
    expect(lock.tryAcquire()).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
    lock.release();
  });

  it("reclaims a lock whose PID was reused by an unrelated process", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(
      lockPath,
      `${process.pid}\n${JSON.stringify({
        version: 2,
        processStartTime: "boot-A",
        instanceId: "inst-1",
        hostname: "host",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf-8",
    );

    const lock = new LeaderLock(lockPath, {
      getProcessStartTime: () => "boot-B",
    });
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });

  it("does not reclaim a live lock when the start time is unknown", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(
      lockPath,
      `${process.pid}\n${JSON.stringify({
        version: 2,
        processStartTime: "boot-A",
        instanceId: "inst-1",
        hostname: "host",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf-8",
    );

    // Unknown current start time must never count as evidence of staleness.
    const lock = new LeaderLock(lockPath, {
      getProcessStartTime: () => null,
    });
    expect(lock.tryAcquire()).toBe(false);
  });

  it("reclaims an unreadable lock file", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "not-a-pid\n", "utf-8");

    const lock = new LeaderLock(lockPath);
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });

  it("release does not remove the file if another PID overwrote it", () => {
    const lockPath = path.join(dir, "lock");
    const lock = new LeaderLock(lockPath);
    lock.tryAcquire();

    // Simulate another process overwriting the lock file
    fs.writeFileSync(lockPath, "999999999", "utf-8");

    lock.release();

    // File should still exist because the PID didn't match
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf-8").trim()).toBe("999999999");
  });

  it("release does not remove a successor lock acquired by the same process", () => {
    const lockPath = path.join(dir, "lock");
    const stale = new LeaderLock(lockPath);
    expect(stale.tryAcquire()).toBe(true);

    // A later broker instance in the same process legitimately re-acquires
    // (e.g. after the first instance's runtime was torn down out of band).
    fs.unlinkSync(lockPath);
    const successor = new LeaderLock(lockPath);
    expect(successor.tryAcquire()).toBe(true);

    // The stale handle must not delete the successor's lock: same PID, but a
    // different acquisition instance.
    stale.release();
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readBrokerLockOwner(lockPath)?.instanceId).toBe(successor.getInstanceId());

    successor.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("backs off when the reclaim mutex is held by a live reclaimer", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "2147483647", "utf-8"); // stale dead-PID lock

    // A live holder with a matching start identity — and, separately, a
    // legacy bare-PID mutex — must both be treated as an active reclaimer.
    const start = getProcessStartTime(process.pid) ?? "";
    for (const content of [`${process.pid}\n${start}\n`, `${process.pid}\n`]) {
      fs.writeFileSync(`${lockPath}.reclaim`, content, "utf-8");
      const lock = new LeaderLock(lockPath);
      expect(lock.tryAcquire()).toBe(false);
      expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(true);
      fs.unlinkSync(`${lockPath}.reclaim`);
    }
  });

  it("reclaims a mutex abandoned by a crashed reclaimer whose PID was reused", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "2147483647", "utf-8"); // stale dead-PID lock

    // The mutex records a live PID but a different start identity: the
    // recording process is gone and its PID was reused, so the abandoned
    // mutex must not strand reclamation forever.
    fs.writeFileSync(`${lockPath}.reclaim`, `${process.pid}\nboot-old\n`, "utf-8");
    const lock = new LeaderLock(lockPath, { getProcessStartTime: () => "boot-new" });
    expect(lock.tryAcquire()).toBe(true);
    expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false);
    lock.release();
  });

  it("does not destroy a fresh lock that appears between inspection and reclaim", () => {
    const lockPath = path.join(dir, "lock");
    // Start from a stale dead-PID lock…
    fs.writeFileSync(lockPath, "2147483647", "utf-8");

    // …but have the liveness probe simulate a concurrent fresh acquisition
    // by swapping in another owner's structured lock mid-inspection.
    const freshContent = `999999998\n${JSON.stringify({
      version: 2,
      processStartTime: "boot-F",
      instanceId: "inst-fresh",
      hostname: "host",
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`;
    const lock = new LeaderLock(lockPath, {
      isProcessRunning: (pid) => {
        if (pid === 2147483647) {
          fs.writeFileSync(lockPath, freshContent, "utf-8");
          return false;
        }
        return true;
      },
    });

    // Acquisition must back off rather than reclaim the changed lock.
    expect(lock.tryAcquire()).toBe(false);
    expect(readBrokerLockOwner(lockPath)?.instanceId).toBe("inst-fresh");
  });
});

// ─── Simultaneous acquisition (multi-process) ───────────

describe("LeaderLock simultaneous acquisition", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  function writeContenderScript(): string {
    const lockPath = path.join(dir, "lock");
    const gatePath = path.join(dir, "gate");
    const donePath = path.join(dir, "done");
    // Node 22.18+/24 strip types natively, so children can import the .ts
    // module directly with plain `node`. A winner must stay alive (holding
    // the lock) until every contender has decided — otherwise a slower
    // contender would correctly reclaim the already-dead winner's lock and
    // the round would measure dead-owner recovery, not mutual exclusion.
    const leaderModuleUrl = new URL("../../broker-core/leader.ts", import.meta.url).href;
    // Like the Vitest aliases: resolve workspace subpath imports to source, not unbuilt dist.
    const transportCoreUrl = new URL("../../transport-core/", import.meta.url).href;
    const childScript = path.join(dir, "contender.mjs");
    fs.writeFileSync(
      childScript,
      [
        `import * as fs from "node:fs";`,
        `import { registerHooks } from "node:module";`,
        `const prefix = "@pinet/transport-core/";`,
        `registerHooks({ resolve: (specifier, context, next) => next(specifier.startsWith(prefix) ? ${JSON.stringify(transportCoreUrl)} + specifier.slice(prefix.length) + ".ts" : specifier, context) });`,
        `const { LeaderLock } = await import(${JSON.stringify(leaderModuleUrl)});`,
        `const resultPath = process.argv[2];`,
        // If the test worker is killed, nobody opens the gate or writes done:
        // exit once reparented instead of spinning forever.
        `const parentPid = process.ppid;`,
        `const spin = (file) => { while (!fs.existsSync(file)) { if (process.ppid !== parentPid) process.exit(1); } };`,
        `fs.writeFileSync(resultPath + ".ready", "ready");`,
        `spin(${JSON.stringify(gatePath)});`,
        `const lock = new LeaderLock(${JSON.stringify(lockPath)});`,
        `const acquired = lock.tryAcquire();`,
        `fs.writeFileSync(resultPath, JSON.stringify({ acquired }));`,
        `if (acquired) spin(${JSON.stringify(donePath)});`,
        `process.exit(0);`,
      ].join("\n"),
      "utf-8",
    );
    return childScript;
  }

  async function raceContenders(options: { children: number; staleLock: boolean }): Promise<{
    winners: number;
    losers: number;
  }> {
    if (options.staleLock) {
      fs.writeFileSync(path.join(dir, "lock"), "2147483647", "utf-8");
    }
    const childScript = writeContenderScript();

    const resultPaths = Array.from({ length: options.children }, (_, i) =>
      path.join(dir, `result-${i}.json`),
    );
    const children = resultPaths.map((resultPath) =>
      spawn(process.execPath, ["--no-warnings", childScript, resultPath], { stdio: "ignore" }),
    );
    // Attach exit promises immediately — losers exit long before the round
    // ends, and a listener attached after the event has fired never resolves.
    const exits = children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.on("error", reject);
          child.on("exit", () => resolve());
        }),
    );
    try {
      // Readiness barrier: wait until every child has reached the spin gate,
      // then open it so all contenders attempt acquisition together. A fixed
      // sleep would let slow children start after the gate opened, quietly
      // weakening the race into a sequential acquisition test.
      const readyDeadline = Date.now() + 15_000;
      while (resultPaths.some((p) => !fs.existsSync(`${p}.ready`))) {
        if (Date.now() > readyDeadline)
          throw new Error("contenders did not all reach the gate in time");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      fs.writeFileSync(path.join(dir, "gate"), "go", "utf-8");

      // Wait until every contender has recorded its outcome, then let
      // winners exit.
      const deadline = Date.now() + 20_000;
      while (resultPaths.some((p) => !fs.existsSync(p))) {
        if (Date.now() > deadline) throw new Error("contenders did not all report in time");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      fs.writeFileSync(path.join(dir, "done"), "done", "utf-8");
      await Promise.all(exits);
    } finally {
      // Never leak spinning children on a failed round.
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await Promise.allSettled(exits);
    }

    const outcomes = resultPaths.map(
      (p) => JSON.parse(fs.readFileSync(p, "utf-8")) as { acquired: boolean },
    );
    const winners = outcomes.filter((o) => o.acquired).length;
    const losers = outcomes.filter((o) => !o.acquired).length;
    expect(winners + losers).toBe(options.children);
    return { winners, losers };
  }

  it("elects exactly one leader among simultaneous contenders", async () => {
    const { winners } = await raceContenders({ children: 8, staleLock: false });
    expect(winners).toBe(1);
  }, 30_000);

  it("elects exactly one leader when contenders race over a stale lock", async () => {
    const { winners } = await raceContenders({ children: 8, staleLock: true });
    expect(winners).toBe(1);
  }, 30_000);

  it("contenders exit when the test worker dies before opening the gate", async () => {
    const resultPath = path.join(dir, "result.json");
    // Stand in for the test worker: spawn a contender, then get SIGKILLed.
    const worker = spawn(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, ["--no-warnings", ${JSON.stringify(writeContenderScript())}, ${JSON.stringify(resultPath)}], { stdio: "ignore" }); console.log(c.pid);`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const contenderPid = await new Promise<number>((resolve) =>
      worker.stdout.once("data", (data: Buffer) => resolve(Number(data.toString()))),
    );
    const alive = () => {
      try {
        process.kill(contenderPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      while (!fs.existsSync(`${resultPath}.ready`)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      worker.kill("SIGKILL");
      const deadline = Date.now() + 5_000;
      while (alive() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(alive()).toBe(false);
    } finally {
      if (alive()) process.kill(contenderPid, "SIGKILL");
    }
  }, 30_000);
});

// ─── readBrokerLockOwner ─────────────────────────────────

describe("readBrokerLockOwner", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("returns null when the lock file does not exist", () => {
    expect(readBrokerLockOwner(path.join(dir, "missing"))).toBeNull();
  });

  it("parses a legacy plain-PID lock", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "12345", "utf-8");

    const owner = readBrokerLockOwner(lockPath);
    expect(owner).toEqual({
      pid: 12345,
      processStartTime: null,
      instanceId: null,
      hostname: null,
      createdAt: null,
      legacy: true,
    });
  });

  it("parses a structured lock", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(
      lockPath,
      `12345\n${JSON.stringify({
        version: 2,
        processStartTime: "boot-A",
        instanceId: "inst-1",
        hostname: "host",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf-8",
    );

    const owner = readBrokerLockOwner(lockPath);
    expect(owner).toEqual({
      pid: 12345,
      processStartTime: "boot-A",
      instanceId: "inst-1",
      hostname: "host",
      createdAt: "2026-01-01T00:00:00.000Z",
      legacy: false,
    });
  });

  it("treats a PID followed by corrupt metadata as a legacy lock", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "12345\nnot-json", "utf-8");

    const owner = readBrokerLockOwner(lockPath);
    expect(owner?.pid).toBe(12345);
    expect(owner?.legacy).toBe(true);
  });

  it("returns null for unparsable content", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "garbage", "utf-8");
    expect(readBrokerLockOwner(lockPath)).toBeNull();
  });
});

// ─── inspectBrokerLock ───────────────────────────────────

describe("inspectBrokerLock", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  function writeStructuredLock(lockPath: string, pid: number, processStartTime: string): void {
    fs.writeFileSync(
      lockPath,
      `${pid}\n${JSON.stringify({
        version: 2,
        processStartTime,
        instanceId: "inst-1",
        hostname: "host",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf-8",
    );
  }

  it("reports none when the lock file does not exist", () => {
    expect(inspectBrokerLock(path.join(dir, "missing"))).toEqual({ state: "none", owner: null });
  });

  it("reports unreadable for unparsable content", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "garbage", "utf-8");
    expect(inspectBrokerLock(lockPath)).toEqual({ state: "unreadable", owner: null });
  });

  it("reports stale-dead when the recorded PID is not running", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "2147483647", "utf-8");

    const inspection = inspectBrokerLock(lockPath);
    expect(inspection.state).toBe("stale-dead");
    if (inspection.state === "stale-dead") {
      expect(inspection.owner.pid).toBe(2147483647);
    }
  });

  it("reports alive for a live legacy lock", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, String(process.pid), "utf-8");

    const inspection = inspectBrokerLock(lockPath);
    expect(inspection.state).toBe("alive");
  });

  it("reports stale-pid-reused when start times differ", () => {
    const lockPath = path.join(dir, "lock");
    writeStructuredLock(lockPath, process.pid, "boot-A");

    const inspection = inspectBrokerLock(lockPath, {
      getProcessStartTime: () => "boot-B",
    });
    expect(inspection.state).toBe("stale-pid-reused");
    if (inspection.state === "stale-pid-reused") {
      expect(inspection.owner.pid).toBe(process.pid);
      expect(inspection.currentStartTime).toBe("boot-B");
    }
  });

  it("reports alive when start times match", () => {
    const lockPath = path.join(dir, "lock");
    writeStructuredLock(lockPath, process.pid, "boot-A");

    const inspection = inspectBrokerLock(lockPath, {
      getProcessStartTime: () => "boot-A",
    });
    expect(inspection.state).toBe("alive");
  });
});

// ─── getProcessStartTime ─────────────────────────────────

describe("getProcessStartTime", () => {
  it("returns a stable non-empty value for the current process", () => {
    const first = getProcessStartTime(process.pid);
    const second = getProcessStartTime(process.pid);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("returns null for an invalid pid", () => {
    expect(getProcessStartTime(-1)).toBeNull();
    expect(getProcessStartTime(0)).toBeNull();
  });
});
