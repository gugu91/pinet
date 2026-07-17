import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerDB } from "./schema.js";
import type { AgentLifecycleState, AgentRuntimeSpecInput } from "./types.js";

function driveTo(db: BrokerDB, agentId: string, path: AgentLifecycleState[]): void {
  for (const toState of path) {
    const agent = db.getAgentById(agentId);
    db.transitionAgentLifecycle({
      agentId,
      expectedVersion: agent?.lifecycleVersion ?? 0,
      toState,
      reason: "test",
      actor: "broker",
      correlationId: "c",
    });
  }
}

function driveToHibernating(db: BrokerDB, agentId: string): void {
  driveTo(db, agentId, ["grace", "idle", "hibernating"]);
}

/** Drive a fresh agent all the way to a resting `hibernated` identity. */
function driveToHibernated(db: BrokerDB, agentId: string): void {
  driveTo(db, agentId, ["grace", "idle", "hibernating", "hibernated"]);
}

/**
 * Drive an already-hibernated agent to the pre-acceptance wake state: a held
 * unexpired wake lease, a `waking` CAS, and a reserved generation.
 */
function driveToWaking(
  db: BrokerDB,
  agentId: string,
  now: number,
): { leaseId: string; fenceToken: number; reservedGeneration: number; reservationNonce: string } {
  const lease = db.acquireAgentLifecycleLease({
    agentId,
    operation: "wake",
    ownerBrokerInstanceId: "broker-1",
    leaseId: "wake-1",
    ttlMs: 90_000,
    now,
  })!;
  const agent = db.getAgentById(agentId);
  db.transitionAgentLifecycle({
    agentId,
    expectedVersion: agent?.lifecycleVersion ?? 0,
    toState: "waking",
    reason: "wake",
    actor: "broker",
    correlationId: "c",
    fenceToken: lease.fenceToken,
  });
  const reservation = db.reserveWakeGeneration({
    agentId,
    wakeLeaseId: "wake-1",
    fenceToken: lease.fenceToken,
    correlationId: "c",
    now,
  });
  return {
    leaseId: "wake-1",
    fenceToken: lease.fenceToken,
    reservedGeneration: reservation.reservedGeneration,
    reservationNonce: reservation.reservationNonce,
  };
}

const tempDirs: string[] = [];
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pinet-hib-schema-"));
  tempDirs.push(dir);
  return join(dir, "broker.db");
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function spec(agentId: string): AgentRuntimeSpecInput {
  return {
    agentId,
    stableId: `host:session:${agentId}`,
    brokerOwnerId: "broker-1",
    cwd: "/repo/wt",
    repoRoot: "/repo",
    worktreePath: "/repo/wt",
    tmuxSocket: "/private/tmp/tmux-501/default",
    tmuxSession: agentId,
    tmuxTarget: `${agentId}:0.0`,
    executable: "/usr/local/bin/pi",
    argv: ["pi", "--model", "x"],
    envAllowlist: ["HOME", "PI_MESH_SOCKET"],
    sessionResumeRef: "session:xyz",
    configFingerprint: "cfg-1",
    expectedHost: "host-1",
    expectedUser: "tm",
    launchSource: "pinet-spawn",
    vcsIdentity: "gugu91/pinet",
  };
}

describe("runtime spec persistence", () => {
  it("round-trips argv/env arrays and preserves createdAt across updates", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("worker-1", "W", "🦉", 1, undefined, "host:session:worker-1");
    const first = db.upsertAgentRuntimeSpec(spec("worker-1"));
    expect(first.argv).toEqual(["pi", "--model", "x"]);
    expect(first.envAllowlist).toEqual(["HOME", "PI_MESH_SOCKET"]);

    const updated = db.upsertAgentRuntimeSpec({
      ...spec("worker-1"),
      configFingerprint: "cfg-2",
      argv: ["pi", "--resume"],
    });
    expect(updated.configFingerprint).toBe("cfg-2");
    expect(updated.argv).toEqual(["pi", "--resume"]);
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.updatedAt >= first.updatedAt).toBe(true);

    db.deleteAgentRuntimeSpec("worker-1");
    expect(db.getAgentRuntimeSpec("worker-1")).toBeNull();
    db.close();
  });

  it("never persists secret values, only an env allowlist of names", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("worker-1", "W", "🦉", 1, undefined, "host:session:worker-1");
    const saved = db.upsertAgentRuntimeSpec(spec("worker-1"));
    // The persisted allowlist is names only; no value-bearing fields exist.
    expect(saved.envAllowlist.every((name) => !name.includes("="))).toBe(true);
    db.close();
  });
});

describe("checkpoint receipts", () => {
  it("returns the latest receipt by runtime generation", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("worker-1", "W", "🦉", 1, undefined, "host:session:worker-1");
    db.recordAgentCheckpointReceipt({
      agentId: "worker-1",
      runtimeGeneration: 0,
      correlationId: "c0",
      hibernateSafe: true,
      reason: null,
      sessionResumeRef: "session:xyz",
      pendingInboxCount: 0,
      rssBytes: 100,
    });
    db.recordAgentCheckpointReceipt({
      agentId: "worker-1",
      runtimeGeneration: 2,
      correlationId: "c2",
      hibernateSafe: false,
      reason: "active_port",
      sessionResumeRef: null,
      pendingInboxCount: 1,
      rssBytes: null,
    });
    const latest = db.getLatestAgentCheckpointReceipt("worker-1");
    expect(latest).toMatchObject({
      runtimeGeneration: 2,
      hibernateSafe: false,
      reason: "active_port",
    });
    db.close();
  });
});

describe("lifecycle events + telemetry", () => {
  it("records metrics on transitions and audit-only refusals, newest first", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    const agent = db.registerAgent("worker-1", "W", "🦉", 1, undefined, "host:session:worker-1");
    db.transitionAgentLifecycle({
      agentId: agent.id,
      expectedVersion: 0,
      toState: "grace",
      reason: "free",
      actor: "broker",
      correlationId: "c1",
      durationMs: 12,
      rssBytesBefore: 999,
    });
    db.recordAgentLifecycleEvent({
      agentId: agent.id,
      fromState: "grace",
      toState: "grace",
      lifecycleVersion: 1,
      reason: "hibernate_refused",
      actor: "broker",
      correlationId: "c2",
      outcome: "hibernate_refused",
      errorCode: "policy_never",
    });
    const events = db.getRecentAgentLifecycleEvents(agent.id);
    expect(events[0]?.outcome).toBe("hibernate_refused");
    expect(events[0]?.errorCode).toBe("policy_never");
    const transition = events.find((e) => e.toState === "grace" && e.outcome === "accepted");
    expect(transition?.durationMs).toBe(12);
    expect(transition?.rssBytesBefore).toBe(999);
    db.close();
  });
});

describe("wake queue + reservations durability", () => {
  it("survives broker restart with hibernated ownership intact", () => {
    const path = dbPath();
    const first = new BrokerDB(path);
    first.initialize();
    first.registerAgent("worker-1", "W", "🦉", 1, undefined, "host:session:worker-1");
    first.upsertAgentRuntimeSpec(spec("worker-1"));
    // Drive to hibernated.
    for (const toState of ["grace", "idle", "hibernating", "hibernated"] as const) {
      const cur = first.getAgentById("worker-1");
      first.transitionAgentLifecycle({
        agentId: "worker-1",
        expectedVersion: cur?.lifecycleVersion ?? 0,
        toState,
        reason: "seed",
        actor: "broker",
        correlationId: "seed",
      });
    }
    first.enqueueWake({
      agentId: "worker-1",
      repoRoot: "/repo",
      triggerKind: "slack_thread",
      priority: 20,
      reason: "reply",
      correlationId: "wq1",
    });
    first.close();

    const restarted = new BrokerDB(path);
    restarted.initialize();
    expect(restarted.getAgentById("worker-1")?.lifecycleState).toBe("hibernated");
    expect(restarted.getAgentRuntimeSpec("worker-1")?.repoRoot).toBe("/repo");
    const queue = restarted.listWakeQueue("queued");
    expect(queue).toHaveLength(1);
    expect(queue[0]?.triggerKind).toBe("slack_thread");
    restarted.close();
  });

  it("enforces global and per-repo in-flight accounting", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("w1", "W1", "🦉", 1, undefined, "host:session:w1");
    db.registerAgent("w2", "W2", "🦉", 2, undefined, "host:session:w2");
    const e1 = db.enqueueWake({
      agentId: "w1",
      repoRoot: "/repo",
      triggerKind: "manual",
      reason: "m",
      correlationId: "q1",
    });
    db.enqueueWake({
      agentId: "w2",
      repoRoot: "/repo",
      triggerKind: "manual",
      reason: "m",
      correlationId: "q2",
    });
    expect(db.countInflightWakes()).toBe(0);
    db.markWakeDispatching(e1.id);
    expect(db.countInflightWakes()).toBe(1);
    expect(db.countInflightWakes("/repo")).toBe(1);
    expect(db.countInflightWakes("/other")).toBe(0);
    db.completeWakeQueueEntry(e1.id, "done");
    expect(db.countInflightWakes()).toBe(0);
    db.close();
  });
});

describe("unregisterAgent preserves durable hibernation identities", () => {
  it("keeps inbox + owned threads when a hibernating identity gracefully unregisters", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("worker-1", "W", "🦉", 1, undefined, "host:session:worker-1");
    db.upsertAgentRuntimeSpec(spec("worker-1"));
    expect(db.claimThread("thread-1", "worker-1")).toBe(true);
    db.insertMessage("thread-1", "a2a", "inbound", "worker-2", "queued work", ["worker-1"]);
    expect(db.getUnreadInboxCount("worker-1")).toBe(1);

    // The broker stops the worker during hibernation; its graceful shutdown
    // sends `unregister`. This must NOT tear down the durable identity.
    driveToHibernating(db, "worker-1");
    db.unregisterAgent("worker-1");

    expect(db.getUnreadInboxCount("worker-1")).toBe(1);
    expect(db.getThread("thread-1")?.ownerAgent).toBe("worker-1");
    const agent = db.getAgentById("worker-1");
    expect(agent?.lifecycleState).toBe("hibernating");
    expect(agent?.disconnectedAt).toBeTruthy();
    expect(db.getAgentRuntimeSpec("worker-1")).not.toBeNull();
    db.close();
  });

  it("keeps inbox + owned threads when a quarantined (reap-candidate) identity unregisters", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("worker-1", "W", "🦉", 1, undefined, "host:session:worker-1");
    db.upsertAgentRuntimeSpec(spec("worker-1"));
    expect(db.claimThread("thread-1", "worker-1")).toBe(true);
    db.insertMessage("thread-1", "a2a", "inbound", "worker-2", "queued work", ["worker-1"]);
    expect(db.getUnreadInboxCount("worker-1")).toBe(1);

    // A hibernate/wake fault quarantined the agent; its runtime is still exiting
    // and later sends a graceful `unregister`. That must NOT destroy the evidence
    // (inbox, ownership, runtime spec) an operator needs to review the quarantine.
    driveTo(db, "worker-1", ["grace", "idle", "hibernating", "reap-candidate"]);
    db.unregisterAgent("worker-1");

    expect(db.getUnreadInboxCount("worker-1")).toBe(1);
    expect(db.getThread("thread-1")?.ownerAgent).toBe("worker-1");
    const agent = db.getAgentById("worker-1");
    expect(agent?.lifecycleState).toBe("reap-candidate");
    expect(agent?.disconnectedAt).toBeTruthy();
    expect(db.getAgentRuntimeSpec("worker-1")).not.toBeNull();
    db.close();
  });

  it("still tears down an ordinary (non-hibernation) agent on unregister", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("worker-1", "W", "🦉", 1, undefined, "host:session:worker-1");
    expect(db.claimThread("thread-1", "worker-1")).toBe(true);
    db.insertMessage("thread-1", "a2a", "inbound", "worker-2", "queued work", ["worker-1"]);
    expect(db.getUnreadInboxCount("worker-1")).toBe(1);

    db.unregisterAgent("worker-1");

    expect(db.getUnreadInboxCount("worker-1")).toBe(0);
    expect(db.getThread("thread-1")?.ownerAgent).toBeNull();
    db.close();
  });
});

describe("maintenance preserves durable hibernation identities", () => {
  it("prune/purge/repair never dismantle a hibernated identity's inbox or ownership", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("worker-1", "W", "🦉", 1, undefined, "host:session:worker-1");
    db.upsertAgentRuntimeSpec(spec("worker-1"));
    expect(db.claimThread("thread-1", "worker-1")).toBe(true);
    db.insertMessage("thread-1", "a2a", "inbound", "worker-2", "queued work", ["worker-1"]);
    expect(db.getUnreadInboxCount("worker-1")).toBe(1);

    // Rest at hibernated, then a graceful worker shutdown soft-disconnects it.
    driveToHibernated(db, "worker-1");
    db.unregisterAgent("worker-1");

    // A full maintenance pass: everything is "stale" (staleAfterMs=0), the owner
    // is disconnected (repair), and the disconnect grace is elapsed (purge=0).
    db.pruneStaleAgents(0);
    const repaired = db.repairThreadOwnership();
    db.purgeDisconnectedAgents(0);

    // The durable identity, inbox, thread ownership, and runtime spec all survive
    // — exactly the state a later wake is supposed to drain.
    const agent = db.getAgentById("worker-1");
    expect(agent?.lifecycleState).toBe("hibernated");
    expect(db.getUnreadInboxCount("worker-1")).toBe(1);
    expect(db.getThread("thread-1")?.ownerAgent).toBe("worker-1");
    expect(db.getAgentRuntimeSpec("worker-1")).not.toBeNull();
    expect(repaired.releasedAgentIds).not.toContain("worker-1");
    db.close();
  });

  it("still prunes/repairs/purges an ordinary disconnected agent (targeted predicate)", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("worker-x", "X", "🦉", 1, undefined, "host:session:worker-x");
    expect(db.claimThread("thread-x", "worker-x")).toBe(true);
    // Ordinary disconnect with an already-elapsed resumable window.
    db.disconnectAgent("worker-x", 0);

    expect(db.repairThreadOwnership().releasedAgentIds).toContain("worker-x");
    expect(db.getThread("thread-x")?.ownerAgent).toBeNull();
    db.purgeDisconnectedAgents(0);
    expect(db.getAgentById("worker-x")).toBeNull();
    db.close();
  });
});

describe("renewAgentLifecycleLease", () => {
  it("extends a held, unexpired lease without bumping the fence", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("w", "W", "🦉", 1, undefined, "host:session:w");
    const lease = db.acquireAgentLifecycleLease({
      agentId: "w",
      operation: "wake",
      ownerBrokerInstanceId: "b1",
      leaseId: "L1",
      ttlMs: 1_000,
      now: 1_000_000,
    })!;
    const renewed = db.renewAgentLifecycleLease({
      agentId: "w",
      leaseId: "L1",
      fenceToken: lease.fenceToken,
      ttlMs: 5_000,
      now: 1_000_500,
    });
    expect(renewed).not.toBeNull();
    expect(renewed!.fenceToken).toBe(lease.fenceToken); // fence preserved
    expect(Date.parse(renewed!.expiresAt)).toBe(1_000_500 + 5_000);
    db.close();
  });

  it("refuses to renew a wrong-fence, released, or already-expired lease (fail closed)", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("w", "W", "🦉", 1, undefined, "host:session:w");
    const lease = db.acquireAgentLifecycleLease({
      agentId: "w",
      operation: "wake",
      ownerBrokerInstanceId: "b1",
      leaseId: "L1",
      ttlMs: 1_000,
      now: 1_000_000,
    })!;
    // Wrong fence.
    expect(
      db.renewAgentLifecycleLease({
        agentId: "w",
        leaseId: "L1",
        fenceToken: lease.fenceToken + 1,
        ttlMs: 5_000,
        now: 1_000_500,
      }),
    ).toBeNull();
    // Already expired (past the 1s TTL) — preserves the takeover guarantee.
    expect(
      db.renewAgentLifecycleLease({
        agentId: "w",
        leaseId: "L1",
        fenceToken: lease.fenceToken,
        ttlMs: 5_000,
        now: 1_002_000,
      }),
    ).toBeNull();
    // Released.
    db.releaseAgentLifecycleLease("w", lease.leaseId, lease.fenceToken);
    expect(
      db.renewAgentLifecycleLease({
        agentId: "w",
        leaseId: "L1",
        fenceToken: lease.fenceToken,
        ttlMs: 5_000,
        now: 1_000_500,
      }),
    ).toBeNull();
    db.close();
  });
});

describe("registerAgentWithGenerationAcceptance atomicity", () => {
  it("registers and accepts the generation atomically on success", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("worker-1", "W", "🦉", 1, undefined, "host:session:worker-1");
    db.upsertAgentRuntimeSpec(spec("worker-1"));
    driveToHibernated(db, "worker-1");
    const { leaseId, fenceToken, reservedGeneration, reservationNonce } = driveToWaking(
      db,
      "worker-1",
      1_000_000,
    );

    const revived = db.registerAgentWithGenerationAcceptance({
      registration: {
        id: "worker-1",
        name: "W",
        emoji: "🦉",
        pid: 999,
        metadata: { marker: "revived" },
        stableId: "host:session:worker-1",
      },
      accept: {
        agentId: "worker-1",
        wakeLeaseId: leaseId,
        fenceToken,
        reservedGeneration,
        reservationNonce,
        now: 1_000_000,
      },
    });
    expect(revived.acceptance.accepted).toBe(true);
    expect(revived.agent?.pid).toBe(999);
    expect(db.getAgentById("worker-1")?.runtimeGeneration).toBe(reservedGeneration);
    expect(db.getAgentWakeReservation("worker-1")).toBeNull(); // reservation consumed
    db.close();
  });

  it("rolls back the registration mutation when acceptance is rejected", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("worker-1", "W", "🦉", 1, { marker: "original" }, "host:session:worker-1");
    db.upsertAgentRuntimeSpec(spec("worker-1"));
    driveToHibernated(db, "worker-1");
    const { leaseId, fenceToken, reservedGeneration, reservationNonce } = driveToWaking(
      db,
      "worker-1",
      1_000_000,
    );

    // A bad fence must reject acceptance AND roll back the registration mutation
    // so the durable row is never left with a mutated pid/metadata.
    const revived = db.registerAgentWithGenerationAcceptance({
      registration: {
        id: "worker-1",
        name: "W",
        emoji: "🦉",
        pid: 999,
        metadata: { marker: "attacker" },
        stableId: "host:session:worker-1",
      },
      accept: {
        agentId: "worker-1",
        wakeLeaseId: leaseId,
        fenceToken: fenceToken + 1, // wrong fence
        reservedGeneration,
        reservationNonce,
        now: 1_000_000,
      },
    });
    expect(revived.agent).toBeNull();
    expect(revived.acceptance).toMatchObject({ accepted: false, reason: "fence_mismatch" });

    // Registration mutation rolled back: pid/metadata unchanged, generation not
    // advanced, still waking, and the reservation is intact for a real retry.
    const agent = db.getAgentById("worker-1");
    expect(agent?.pid).toBe(1);
    expect(agent?.metadata).toMatchObject({ marker: "original" });
    expect(agent?.runtimeGeneration).toBe(0);
    expect(agent?.lifecycleState).toBe("waking");
    expect(db.getAgentWakeReservation("worker-1")).not.toBeNull();
    db.close();
  });
});

describe("finalizeWakeAttempt (acceptance-boundary settle)", () => {
  it("reports accepted and leaves state intact when the generation was already accepted", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("worker-1", "W", "🦉", 1, undefined, "host:session:worker-1");
    db.upsertAgentRuntimeSpec(spec("worker-1"));
    driveToHibernated(db, "worker-1");
    const { leaseId, fenceToken, reservedGeneration, reservationNonce } = driveToWaking(
      db,
      "worker-1",
      1_000_000,
    );
    const acceptance = db.acceptRuntimeGeneration({
      agentId: "worker-1",
      wakeLeaseId: leaseId,
      fenceToken,
      reservedGeneration,
      reservationNonce,
      now: 1_000_000,
    });
    expect(acceptance.accepted).toBe(true);

    const settled = db.finalizeWakeAttempt({
      agentId: "worker-1",
      reservedGeneration,
      reservationNonce,
    });
    expect(settled.accepted).toBe(true);
    expect(db.getAgentById("worker-1")?.runtimeGeneration).toBe(reservedGeneration);
    db.close();
  });

  it("consumes only THIS attempt's reservation when not accepted, blocking a late acceptance", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("worker-1", "W", "🦉", 1, undefined, "host:session:worker-1");
    db.upsertAgentRuntimeSpec(spec("worker-1"));
    driveToHibernated(db, "worker-1");
    const { leaseId, fenceToken, reservedGeneration, reservationNonce } = driveToWaking(
      db,
      "worker-1",
      1_000_000,
    );

    const settled = db.finalizeWakeAttempt({
      agentId: "worker-1",
      reservedGeneration,
      reservationNonce,
    });
    expect(settled.accepted).toBe(false);
    expect(db.getAgentWakeReservation("worker-1")).toBeNull(); // reservation consumed

    // A late registration replay for this exact attempt can no longer be accepted.
    const late = db.acceptRuntimeGeneration({
      agentId: "worker-1",
      wakeLeaseId: leaseId,
      fenceToken,
      reservedGeneration,
      reservationNonce,
      now: 1_000_000,
    });
    expect(late).toMatchObject({ accepted: false, reason: "no_reservation" });
    db.close();
  });

  it("leaves a superseded newer attempt's reservation intact (different nonce)", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("worker-1", "W", "🦉", 1, undefined, "host:session:worker-1");
    db.upsertAgentRuntimeSpec(spec("worker-1"));
    driveToHibernated(db, "worker-1");
    const { reservedGeneration } = driveToWaking(db, "worker-1", 1_000_000);

    // Settling a STALE nonce must not consume the current reservation.
    const settled = db.finalizeWakeAttempt({
      agentId: "worker-1",
      reservedGeneration,
      reservationNonce: "stale-nonce-from-earlier-attempt",
    });
    expect(settled.accepted).toBe(false);
    expect(db.getAgentWakeReservation("worker-1")).not.toBeNull(); // current reservation intact
    db.close();
  });
});

describe("wake acceptance receipt", () => {
  it("writes a receipt on acceptance and clears it on the next wake reservation", () => {
    const db = new BrokerDB(dbPath());
    db.initialize();
    db.registerAgent("worker-1", "W", "🦉", 1, undefined, "host:session:worker-1");
    db.upsertAgentRuntimeSpec(spec("worker-1"));
    driveToHibernated(db, "worker-1");
    const r1 = driveToWaking(db, "worker-1", 1_000_000);

    const accepted = db.acceptRuntimeGeneration({
      agentId: "worker-1",
      wakeLeaseId: r1.leaseId,
      fenceToken: r1.fenceToken,
      reservedGeneration: r1.reservedGeneration,
      reservationNonce: r1.reservationNonce,
      now: 1_000_000,
    });
    expect(accepted.accepted).toBe(true);
    const receipt = db.getAgentWakeAcceptanceReceipt("worker-1");
    expect(receipt).toMatchObject({
      agentId: "worker-1",
      stableId: "host:session:worker-1",
      wakeLeaseId: r1.leaseId,
      fenceToken: r1.fenceToken,
      reservedGeneration: r1.reservedGeneration,
      reservationNonce: r1.reservationNonce,
    });

    // A NEW wake reservation supersedes the acceptance, clearing the receipt so a
    // stale fence can never rebind during a fresh wake window.
    db.reserveWakeGeneration({
      agentId: "worker-1",
      wakeLeaseId: r1.leaseId,
      fenceToken: r1.fenceToken,
      correlationId: "c2",
      now: 1_000_000,
    });
    expect(db.getAgentWakeAcceptanceReceipt("worker-1")).toBeNull();
    db.close();
  });
});
