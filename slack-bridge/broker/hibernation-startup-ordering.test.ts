// Proves the Phase B, Seam 3 startup ordering invariant against a REAL broker:
// crash-stranded wake recovery runs (and completes) BEFORE the broker socket
// begins accepting connections, so no incoming registration can race an
// unreconciled `waking`/`hibernating` row. Uses the real `startBroker`
// `beforeListen` hook wired to the real recovery composition — not a mock — and
// a real socket-connect probe to pin the ordering. Fast + deterministic (no
// pi/tmux), so it runs in normal CI.

import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentLifecycleState } from "@pinet/broker-core/types";
import { startBroker, type Broker } from "./index.js";
import { BrokerDB } from "./schema.js";
import {
  createHibernationOrchestrator,
  recoverStrandedWakesBeforeRegistrations,
} from "./hibernation-activation.js";

const dirs: string[] = [];
let broker: Broker | null = null;

afterEach(async () => {
  if (broker) {
    await broker.stop();
    broker = null;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Resolves true only if a client can actually connect to the unix socket. */
function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    const finish = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}

/** Seed a real crash-stranded `waking` row (no held lease, no accepted generation). */
function seedStrandedWaking(dbPath: string, agentId: string): void {
  const db = new BrokerDB(dbPath);
  db.initialize();
  db.registerAgent(
    agentId,
    "Stranded",
    "🦉",
    4242,
    { brokerManaged: true },
    `h:session:/tmp/s.jsonl`,
  );
  const chain: AgentLifecycleState[] = ["grace", "idle", "hibernating", "hibernated", "waking"];
  for (const toState of chain) {
    const version = db.getAgentById(agentId)?.lifecycleVersion ?? 0;
    db.transitionAgentLifecycle({
      agentId,
      expectedVersion: version,
      toState,
      reason: "seed",
      actor: "broker",
      correlationId: "seed",
    });
  }
  db.close();
}

describe("Phase B, Seam 3 — stranded-wake recovery completes before the socket listens", () => {
  it("reconciles a stranded row in beforeListen while the socket is still closed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pinet-hib-order-"));
    dirs.push(dir);
    const dbPath = join(dir, "b.db");
    const socketPath = join(dir, "b.sock");
    const lockPath = join(dir, "b.lock");

    // A real crash-stranded `waking` row exists in the DB the broker will open.
    seedStrandedWaking(dbPath, "stranded-1");

    let connectableDuringBeforeListen: boolean | null = null;
    let reconciledDuringBeforeListen = false;

    broker = await startBroker({
      dbPath,
      socketPath,
      lockPath,
      beforeListen: async ({ db }) => {
        // The socket must NOT be accepting connections yet…
        connectableDuringBeforeListen = await canConnect(socketPath);
        // …and the REAL recovery composition reconciles the stranded row here.
        recoverStrandedWakesBeforeRegistrations(
          createHibernationOrchestrator({
            db,
            brokerInstanceId: "startup-broker",
            extensionEntryPath: "/opt/ext/index.js",
            baseLaunchEnv: {},
            inheritedEnvKeys: [],
          }),
        );
        reconciledDuringBeforeListen =
          db.getAgentById("stranded-1")?.lifecycleState === "reap-candidate";
      },
    });

    // The socket was provably closed while recovery ran…
    expect(connectableDuringBeforeListen).toBe(false);
    // …recovery finished (fail-closed quarantine) before listen…
    expect(reconciledDuringBeforeListen).toBe(true);
    // …and only AFTER startBroker resolves is the socket accepting connections.
    expect(await canConnect(socketPath)).toBe(true);
    // The reconciliation is durable on the broker's authoritative DB.
    expect(broker.db.getAgentById("stranded-1")?.lifecycleState).toBe("reap-candidate");
  });

  it("tears the broker down (no half-open listener) if beforeListen throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pinet-hib-order-"));
    dirs.push(dir);
    const socketPath = join(dir, "b.sock");

    await expect(
      startBroker({
        dbPath: join(dir, "b.db"),
        socketPath,
        lockPath: join(dir, "b.lock"),
        beforeListen: () => {
          throw new Error("recovery boom");
        },
      }),
    ).rejects.toThrow("recovery boom");

    // The socket never opened, and the lock was released so a retry can start.
    expect(await canConnect(socketPath)).toBe(false);
    const retry = await startBroker({
      dbPath: join(dir, "b.db"),
      socketPath,
      lockPath: join(dir, "b.lock"),
    });
    broker = retry;
    expect(await canConnect(socketPath)).toBe(true);
  });
});
