import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrokerDB } from "./schema.js";
import {
  HibernationOrchestrator,
  type HibernationCheckpointOutcome,
  type HibernationProcessController,
  type HibernationTmuxController,
  type RuntimeLaunchContext,
  wakeTriggerPriority,
} from "./index.js";
import type { AgentRuntimeSpecInput } from "./types.js";

const tempDirs: string[] = [];
function freshDb(): BrokerDB {
  const dir = mkdtempSync(join(tmpdir(), "pinet-hib-orch-"));
  tempDirs.push(dir);
  const db = new BrokerDB(join(dir, "broker.db"));
  db.initialize();
  return db;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const AGENT_METADATA = {
  brokerManaged: true,
  brokerManagedBy: "broker-1",
  hibernateSafe: true,
  cwd: "/repo/wt",
  repoRoot: "/repo",
  worktreePath: "/repo/wt",
  tmuxSession: "worker-1",
};

function runtimeSpec(agentId: string, stableId: string): AgentRuntimeSpecInput {
  return {
    agentId,
    stableId,
    brokerOwnerId: "broker-1",
    cwd: "/repo/wt",
    repoRoot: "/repo",
    worktreePath: "/repo/wt",
    tmuxSocket: "/private/tmp/tmux-501/default",
    tmuxSession: "worker-1",
    tmuxTarget: "worker-1:0.0",
    executable: "/usr/local/bin/pi",
    argv: ["pi", "--model", "openai-codex/gpt-5.6-sol"],
    envAllowlist: ["PI_MESH_SOCKET", "HOME"],
    sessionResumeRef: "session:abcdef123456",
    configFingerprint: "cfg-v1",
    expectedHost: "host-1",
    expectedUser: "tm",
    launchSource: "pinet-spawn",
  };
}

/** Register an eligible broker-managed root worker with a durable runtime spec. */
function seedAgent(db: BrokerDB, id = "worker-1", stableId = "host:session:abcdef123456"): void {
  db.registerAgent(id, "Worker", "🦉", 4242, { ...AGENT_METADATA }, stableId);
  db.setAgentHibernatePolicy(id, "manual");
  db.upsertAgentRuntimeSpec(runtimeSpec(id, stableId));
}

class FakeProcess implements HibernationProcessController {
  checkpoint: HibernationCheckpointOutcome = {
    hibernateSafe: true,
    reason: null,
    sessionResumeRef: "session:abcdef123456",
    pendingInboxCount: 0,
    rssBytes: 120_000_000,
  };
  alive = true;
  stopResult = { stopped: true, rssBytes: 0 as number | null };
  checkpointDelayMs = 0;
  checkpointCalls = 0;
  stopCalls = 0;

  async requestCheckpoint(): Promise<HibernationCheckpointOutcome> {
    this.checkpointCalls += 1;
    if (this.checkpointDelayMs > 0) await new Promise((r) => setTimeout(r, this.checkpointDelayMs));
    return this.checkpoint;
  }
  async stopRuntime(): Promise<{ stopped: boolean; rssBytes: number | null }> {
    this.stopCalls += 1;
    if (this.stopResult.stopped) this.alive = false;
    return this.stopResult;
  }
  async isRuntimeAlive(): Promise<boolean> {
    return this.alive;
  }
}

class FakeTmux implements HibernationTmuxController {
  attachable = true;
  launched = true;
  respawnCalls: RuntimeLaunchContext[] = [];
  /** Called synchronously inside respawnRuntime to simulate the woken runtime. */
  onRespawn: ((ctx: RuntimeLaunchContext) => void) | null = null;

  async isSessionAttachable(): Promise<boolean> {
    return this.attachable;
  }
  async respawnRuntime(ctx: RuntimeLaunchContext): Promise<{ launched: boolean }> {
    this.respawnCalls.push(ctx);
    this.onRespawn?.(ctx);
    return { launched: this.launched };
  }
}

interface Harness {
  db: BrokerDB;
  proc: FakeProcess;
  tmux: FakeTmux;
  orch: HibernationOrchestrator;
  clock: { ms: number };
}

/**
 * Build an orchestrator whose default registration waiter simulates the woken
 * runtime re-registering and presenting the reservation fence to the broker.
 */
function harness(
  overrides: {
    registerBehavior?:
      | "accept"
      | "stale_fence"
      | "stale_generation"
      | "stale_nonce"
      | "no_register";
  } = {},
): Harness {
  const db = freshDb();
  const proc = new FakeProcess();
  const tmux = new FakeTmux();
  const clock = { ms: 1_000_000 };
  const behavior = overrides.registerBehavior ?? "accept";
  const orch = new HibernationOrchestrator({
    db,
    process: proc,
    tmux,
    brokerInstanceId: "broker-1",
    now: () => clock.ms,
    config: { registrationTimeoutMs: 200, handshakeTimeoutMs: 200, maxWakeAttempts: 2 },
    awaitRuntimeRegistration: async (ctx: RuntimeLaunchContext) => {
      if (behavior === "no_register") return false;
      // Simulate the runtime reconnecting under the same stable id.
      db.registerAgent(ctx.agentId, "Worker", "🦉", 5555, { ...AGENT_METADATA }, ctx.spec.stableId);
      const presented =
        behavior === "stale_fence"
          ? { ...ctx, fenceToken: ctx.fenceToken + 99 }
          : behavior === "stale_generation"
            ? { ...ctx, reservedGeneration: ctx.reservedGeneration + 5 }
            : behavior === "stale_nonce"
              ? { ...ctx, reservationNonce: "stale-nonce-from-earlier-attempt" }
              : ctx;
      const acceptance = db.acceptRuntimeGeneration({
        agentId: presented.agentId,
        wakeLeaseId: presented.wakeLeaseId,
        fenceToken: presented.fenceToken,
        reservedGeneration: presented.reservedGeneration,
        reservationNonce: presented.reservationNonce,
        now: clock.ms,
      });
      return acceptance.accepted;
    },
  });
  return { db, proc, tmux, orch, clock };
}

async function hibernateFrom(h: Harness, id = "worker-1"): Promise<void> {
  const prep = h.orch.prepareHibernation(id);
  expect(prep.ready).toBe(true);
  const result = await h.orch.hibernate(id);
  expect(result.ok).toBe(true);
  expect(result.state).toBe("hibernated");
}

describe("HibernationOrchestrator — hibernate", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    seedAgent(h.db);
  });

  it("prepares an eligible free worker through grace to idle", () => {
    const prep = h.orch.prepareHibernation("worker-1");
    expect(prep).toMatchObject({ ready: true, state: "idle" });
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("idle");
  });

  it("cold-hibernates: checkpoint receipt, PID gone, tmux attachable, hibernated", async () => {
    await hibernateFrom(h);
    const agent = h.db.getAgentById("worker-1");
    expect(agent?.lifecycleState).toBe("hibernated");
    expect(agent?.hibernatedAt).toBeTruthy();
    expect(h.proc.alive).toBe(false);
    const receipt = h.db.getLatestAgentCheckpointReceipt("worker-1");
    expect(receipt).toMatchObject({ hibernateSafe: true, runtimeGeneration: 0 });
    // Lease released.
    expect(h.db.getAgentLifecycleLease("worker-1")).toBeNull();
    const events = h.db.getRecentAgentLifecycleEvents("worker-1");
    const hibernatedEvent = events.find((e) => e.toState === "hibernated");
    expect(hibernatedEvent?.outcome).toBe("accepted");
    expect(hibernatedEvent?.rssBytesBefore).toBe(120_000_000);
  });

  it("refuses when policy is never (fails closed)", async () => {
    h.db.setAgentHibernatePolicy("worker-1", "never");
    const prep = h.orch.prepareHibernation("worker-1");
    expect(prep).toMatchObject({ ready: false, reason: "policy_never" });
    const result = await h.orch.hibernate("worker-1");
    expect(result).toMatchObject({ ok: false, reason: "policy_never" });
  });

  it("aborts to active when a message arrives during checkpoint", async () => {
    h.orch.prepareHibernation("worker-1");
    h.proc.checkpoint = { ...h.proc.checkpoint, pendingInboxCount: 1 };
    const result = await h.orch.hibernate("worker-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("work_arrived_during_checkpoint");
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("active");
    expect(h.proc.stopCalls).toBe(0); // never exited the runtime
  });

  it("aborts to active when the follower reports unsafe", async () => {
    h.orch.prepareHibernation("worker-1");
    h.proc.checkpoint = { ...h.proc.checkpoint, hibernateSafe: false, reason: "active_port_lease" };
    const result = await h.orch.hibernate("worker-1");
    expect(result.reason).toContain("checkpoint_unsafe:active_port_lease");
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("active");
    expect(h.proc.stopCalls).toBe(0);
  });

  it("collapses an arbitrary runtime-authored checkpoint reason to a safe code (by construction)", async () => {
    h.orch.prepareHibernation("worker-1");
    // A worker-authored checkpoint reason could embed a private path, an env
    // assignment, or a CLI flag. It must NEVER reach an operator/telemetry
    // surface — it is allowlisted by shape down to a static `unspecified` code.
    h.proc.checkpoint = {
      ...h.proc.checkpoint,
      hibernateSafe: false,
      reason: "held /Users/tm/secret/creds.json open TOKEN=deadbeef --api-key x",
    };
    const result = await h.orch.hibernate("worker-1");
    expect(result.reason).toBe("checkpoint_unsafe:unspecified");
    expect(result.reason).not.toContain("/Users/tm/secret");
    expect(result.reason).not.toContain("deadbeef");
    // The recorded lifecycle event AND the durable checkpoint receipt are safe.
    const events = h.db.getRecentAgentLifecycleEvents("worker-1");
    const abort = events.find((e) => e.toState === "active");
    expect(abort?.reason).toBe("checkpoint_unsafe:unspecified");
    expect(h.db.getLatestAgentCheckpointReceipt("worker-1")?.reason).toBe("unspecified");
    // A well-formed machine code, by contrast, is preserved verbatim.
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("active");
  });

  it("quarantines to reap-candidate when the runtime survives stop (PID anomaly)", async () => {
    h.orch.prepareHibernation("worker-1");
    h.proc.stopResult = { stopped: false, rssBytes: null };
    const result = await h.orch.hibernate("worker-1");
    expect(result).toMatchObject({ ok: false, reason: "runtime_survived_stop" });
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("reap-candidate");
    expect(h.db.getAgentLifecycleLease("worker-1")).toBeNull();
  });

  it("quarantines to reap-candidate when the tmux session vanished", async () => {
    h.orch.prepareHibernation("worker-1");
    h.tmux.attachable = false;
    const result = await h.orch.hibernate("worker-1");
    expect(result).toMatchObject({ ok: false, reason: "tmux_session_missing" });
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("reap-candidate");
  });

  it("fails closed when the runtime spec is missing", async () => {
    h.orch.prepareHibernation("worker-1");
    h.db.deleteAgentRuntimeSpec("worker-1");
    const result = await h.orch.hibernate("worker-1");
    expect(result).toMatchObject({ ok: false, reason: "missing_runtime_spec" });
  });

  it("refuses a second hibernate while a lease is held (single-winner)", async () => {
    h.orch.prepareHibernation("worker-1");
    // Acquire a competing hibernate lease to simulate another broker/thread.
    const other = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "hibernate",
      ownerBrokerInstanceId: "broker-2",
      leaseId: "lease-other",
      ttlMs: 60_000,
      now: h.clock.ms,
    });
    expect(other).not.toBeNull();
    const result = await h.orch.hibernate("worker-1");
    expect(result).toMatchObject({ ok: false, reason: "lease_contended" });
  });

  it("times out the checkpoint handshake and stays safe", async () => {
    h.orch.prepareHibernation("worker-1");
    h.proc.checkpointDelayMs = 1_000; // exceeds handshakeTimeoutMs (200)
    const result = await h.orch.hibernate("worker-1");
    expect(result.reason).toContain("checkpoint_unsafe:checkpoint_timeout");
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("active");
    expect(h.proc.stopCalls).toBe(0);
  });
});

describe("HibernationOrchestrator — wake", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
  });

  it("cold-wakes a single accepted generation and returns to live", async () => {
    const result = await h.orch.wake("worker-1", { trigger: "manual" });
    expect(result.ok).toBe(true);
    expect(result.state).toBe("live");
    expect(result.runtimeGeneration).toBe(1);
    const agent = h.db.getAgentById("worker-1");
    expect(agent?.lifecycleState).toBe("live");
    expect(agent?.runtimeGeneration).toBe(1);
    expect(h.db.getAgentWakeReservation("worker-1")).toBeNull();
    expect(h.db.getAgentLifecycleLease("worker-1")).toBeNull();
  });

  it("delivers messages queued during hibernation once, in order, after wake", async () => {
    // Two direct messages arrive while hibernated → durable inbox rows.
    h.db.queueMessage("worker-1", {
      threadId: "a2a:x",
      source: "a2a",
      userId: "peer",
      channel: "a2a:x",
      text: "first",
      timestamp: "1700000000.000001",
      metadata: {},
    });
    h.db.queueMessage("worker-1", {
      threadId: "a2a:x",
      source: "a2a",
      userId: "peer",
      channel: "a2a:x",
      text: "second",
      timestamp: "1700000000.000002",
      metadata: {},
    });
    expect(h.db.getUnreadInboxCount("worker-1")).toBe(2);

    await h.orch.wake("worker-1", { trigger: "direct_a2a" });

    const inbox = h.db.getInbox("worker-1");
    expect(inbox.map((m) => m.message.body)).toEqual(["first", "second"]);
    // Deliver once; a second drain returns nothing (exactly-once per row).
    h.db.markDelivered(
      inbox.map((m) => m.entry.id),
      "worker-1",
    );
    expect(h.db.getInbox("worker-1")).toHaveLength(0);
  });

  it("rejects a stale-fence registration (only one accepted generation)", async () => {
    const staleHarness = harness({ registerBehavior: "stale_fence" });
    seedAgent(staleHarness.db);
    await hibernateFrom(staleHarness);
    const result = await staleHarness.orch.wake("worker-1", { trigger: "manual" });
    expect(result.ok).toBe(false);
    expect(result.state).toBe("reap-candidate");
    // runtime_generation never advanced past the hibernated value.
    expect(staleHarness.db.getAgentById("worker-1")?.runtimeGeneration).toBe(0);
  });

  it("rejects a stale-generation registration", async () => {
    const staleHarness = harness({ registerBehavior: "stale_generation" });
    seedAgent(staleHarness.db);
    await hibernateFrom(staleHarness);
    const result = await staleHarness.orch.wake("worker-1", { trigger: "manual" });
    expect(result.ok).toBe(false);
    expect(staleHarness.db.getAgentById("worker-1")?.runtimeGeneration).toBe(0);
  });

  it("retries then quarantines when the runtime never registers", async () => {
    const noReg = harness({ registerBehavior: "no_register" });
    seedAgent(noReg.db);
    await hibernateFrom(noReg);
    const result = await noReg.orch.wake("worker-1", { trigger: "manual" });
    expect(result.ok).toBe(false);
    expect(result.state).toBe("reap-candidate");
    expect(noReg.tmux.respawnCalls.length).toBe(2); // maxWakeAttempts
    expect(noReg.db.getAgentWakeReservation("worker-1")).toBeNull();
  });

  it("refuses a concurrent wake — one lease wins", async () => {
    // Hold a competing wake lease.
    const held = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "wake",
      ownerBrokerInstanceId: "broker-2",
      leaseId: "wake-other",
      ttlMs: 60_000,
      now: h.clock.ms,
    });
    expect(held).not.toBeNull();
    const result = await h.orch.wake("worker-1", { trigger: "manual" });
    expect(result).toMatchObject({ ok: false, reason: "wake_in_progress" });
  });

  it("refuses waking an agent that is not hibernated", async () => {
    await h.orch.wake("worker-1", { trigger: "manual" }); // now live
    const again = await h.orch.wake("worker-1", { trigger: "manual" });
    expect(again.ok).toBe(false);
    expect(again.reason).toContain("not_hibernated");
  });

  it("fences out a superseded earlier attempt's runtime (stale nonce) and quarantines", async () => {
    // A runtime that registers with a stale per-attempt nonce (as a slow runtime
    // from a timed-out earlier attempt would) is rejected even though its lease,
    // fence, and generation still match the current reservation. Every attempt
    // presents the stale nonce, so all fail and the wake quarantines.
    const staleNonce = harness({ registerBehavior: "stale_nonce" });
    seedAgent(staleNonce.db);
    await hibernateFrom(staleNonce);
    const result = await staleNonce.orch.wake("worker-1", { trigger: "manual" });
    expect(result.ok).toBe(false);
    expect(result.state).toBe("reap-candidate");
    // Never accepted → generation never advanced past the hibernated value.
    expect(staleNonce.db.getAgentById("worker-1")?.runtimeGeneration).toBe(0);
  });
});

describe("acceptRuntimeGeneration fencing", () => {
  /**
   * Drive an already-hibernated agent to the real pre-acceptance wake state: a
   * held unexpired `wake` lease, a `waking` lifecycle CAS, and a reserved
   * generation — exactly what the socket server presents at registration.
   */
  const DRIVEN_NONCE = "nonce-attempt-1";
  function driveToWaking(
    h: Harness,
    opts: { ttlMs?: number } = {},
  ): { leaseId: string; fenceToken: number; reservationNonce: string } {
    const agent = h.db.getAgentById("worker-1");
    const lease = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "wake",
      ownerBrokerInstanceId: "broker-1",
      leaseId: "wake-1",
      ttlMs: opts.ttlMs ?? 90_000,
      now: h.clock.ms,
    });
    expect(lease).not.toBeNull();
    h.db.transitionAgentLifecycle({
      agentId: "worker-1",
      expectedVersion: agent!.lifecycleVersion ?? 0,
      toState: "waking",
      reason: "wake",
      actor: "broker",
      correlationId: "corr",
      fenceToken: lease!.fenceToken,
    });
    const reservation = h.db.reserveWakeGeneration({
      agentId: "worker-1",
      wakeLeaseId: "wake-1",
      fenceToken: lease!.fenceToken,
      correlationId: "corr",
      reservationNonce: DRIVEN_NONCE,
      now: h.clock.ms,
    });
    expect(reservation.reservedGeneration).toBe(1);
    expect(reservation.reservationNonce).toBe(DRIVEN_NONCE);
    return { leaseId: "wake-1", fenceToken: lease!.fenceToken, reservationNonce: DRIVEN_NONCE };
  }

  it("accepts exactly one matching generation and rejects duplicates/stale", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    const { fenceToken, reservationNonce } = driveToWaking(h);

    // Stale fence rejected.
    expect(
      h.db.acceptRuntimeGeneration({
        agentId: "worker-1",
        wakeLeaseId: "wake-1",
        fenceToken: fenceToken + 1,
        reservedGeneration: 1,
        reservationNonce,
        now: h.clock.ms,
      }),
    ).toMatchObject({ accepted: false, reason: "fence_mismatch" });

    // A stale nonce (a superseded earlier wake attempt's runtime) is rejected
    // even though its lease/fence/generation all match.
    expect(
      h.db.acceptRuntimeGeneration({
        agentId: "worker-1",
        wakeLeaseId: "wake-1",
        fenceToken,
        reservedGeneration: 1,
        reservationNonce: "stale-earlier-attempt-nonce",
        now: h.clock.ms,
      }),
    ).toMatchObject({ accepted: false, reason: "nonce_mismatch" });

    // Correct acceptance.
    expect(
      h.db.acceptRuntimeGeneration({
        agentId: "worker-1",
        wakeLeaseId: "wake-1",
        fenceToken,
        reservedGeneration: 1,
        reservationNonce,
        now: h.clock.ms,
      }),
    ).toMatchObject({ accepted: true, runtimeGeneration: 1 });

    // Duplicate registration after acceptance is rejected (reservation consumed).
    expect(
      h.db.acceptRuntimeGeneration({
        agentId: "worker-1",
        wakeLeaseId: "wake-1",
        fenceToken,
        reservedGeneration: 1,
        reservationNonce,
        now: h.clock.ms,
      }),
    ).toMatchObject({ accepted: false, reason: "no_reservation" });
  });

  it("rejects acceptance under an expired wake lease (strict lease binding)", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    const { fenceToken, reservationNonce } = driveToWaking(h, { ttlMs: 90_000 });

    // Present the otherwise-matching reservation after the lease has expired.
    expect(
      h.db.acceptRuntimeGeneration({
        agentId: "worker-1",
        wakeLeaseId: "wake-1",
        fenceToken,
        reservedGeneration: 1,
        reservationNonce,
        now: h.clock.ms + 90_001,
      }),
    ).toMatchObject({ accepted: false, reason: "lease_expired" });

    // The generation must NOT have advanced.
    expect(h.db.getAgentById("worker-1")?.runtimeGeneration).toBe(0);
  });

  it("rejects acceptance when the agent is no longer waking", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    // Held wake lease + reservation, but the CAS to `waking` never happened
    // (agent still hibernated) — a late/duplicate registration must fail closed.
    const lease = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "wake",
      ownerBrokerInstanceId: "broker-1",
      leaseId: "wake-1",
      ttlMs: 90_000,
      now: h.clock.ms,
    });
    const reservation = h.db.reserveWakeGeneration({
      agentId: "worker-1",
      wakeLeaseId: "wake-1",
      fenceToken: lease!.fenceToken,
      correlationId: "corr",
      now: h.clock.ms,
    });
    expect(
      h.db.acceptRuntimeGeneration({
        agentId: "worker-1",
        wakeLeaseId: "wake-1",
        fenceToken: lease!.fenceToken,
        reservedGeneration: reservation.reservedGeneration,
        reservationNonce: reservation.reservationNonce,
        now: h.clock.ms,
      }),
    ).toMatchObject({ accepted: false, reason: "not_waking" });
    expect(h.db.getAgentById("worker-1")?.runtimeGeneration).toBe(0);
  });

  it("requires a held wake lease to reserve a generation", () => {
    const h = harness();
    seedAgent(h.db);
    expect(() =>
      h.db.reserveWakeGeneration({
        agentId: "worker-1",
        wakeLeaseId: "nonexistent",
        fenceToken: 1,
        correlationId: "c",
        now: h.clock.ms,
      }),
    ).toThrow(/matching held wake lease/);
  });

  it("checkRuntimeGenerationAcceptable validates without mutating (accept happens post-register)", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    const { fenceToken, reservationNonce } = driveToWaking(h);

    // A bad fence is rejected with no mutation.
    expect(
      h.db.checkRuntimeGenerationAcceptable({
        agentId: "worker-1",
        wakeLeaseId: "wake-1",
        fenceToken: fenceToken + 1,
        reservedGeneration: 1,
        reservationNonce,
        now: h.clock.ms,
      }),
    ).toMatchObject({ accepted: false, reason: "fence_mismatch" });

    // A valid preflight reports acceptable but does NOT advance the generation
    // or consume the reservation — the socket layer only accepts after the agent
    // registration has committed.
    expect(
      h.db.checkRuntimeGenerationAcceptable({
        agentId: "worker-1",
        wakeLeaseId: "wake-1",
        fenceToken,
        reservedGeneration: 1,
        reservationNonce,
        now: h.clock.ms,
      }),
    ).toMatchObject({ accepted: true, runtimeGeneration: 1 });
    expect(h.db.getAgentById("worker-1")?.runtimeGeneration).toBe(0);
    expect(h.db.getAgentWakeReservation("worker-1")).not.toBeNull();

    // The real acceptance then advances exactly once and consumes the reservation.
    expect(
      h.db.acceptRuntimeGeneration({
        agentId: "worker-1",
        wakeLeaseId: "wake-1",
        fenceToken,
        reservedGeneration: 1,
        reservationNonce,
        now: h.clock.ms,
      }),
    ).toMatchObject({ accepted: true, runtimeGeneration: 1 });
    expect(h.db.getAgentById("worker-1")?.runtimeGeneration).toBe(1);
    expect(h.db.getAgentWakeReservation("worker-1")).toBeNull();
  });

  it("rejects a fenced lifecycle transition from a superseded lease holder", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    const agent = h.db.getAgentById("worker-1")!;

    // Broker A acquires the wake lease (fence 1) and moves the agent to waking.
    const leaseA = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "wake",
      ownerBrokerInstanceId: "broker-A",
      leaseId: "wake-A",
      ttlMs: 1_000,
      now: h.clock.ms,
    })!;
    h.db.transitionAgentLifecycle({
      agentId: "worker-1",
      expectedVersion: agent.lifecycleVersion ?? 0,
      toState: "waking",
      reason: "wake",
      actor: "broker-A",
      correlationId: "cA",
      fenceToken: leaseA.fenceToken,
    });
    const wakingVersion = h.db.getAgentById("worker-1")!.lifecycleVersion ?? 0;

    // Lease A expires and Broker B re-acquires at a higher monotonic fence. The
    // lifecycle version is unchanged by the re-acquisition.
    const leaseB = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "wake",
      ownerBrokerInstanceId: "broker-B",
      leaseId: "wake-B",
      ttlMs: 90_000,
      now: h.clock.ms + 5_000,
    })!;
    expect(leaseB.fenceToken).toBeGreaterThan(leaseA.fenceToken);

    // Broker A (stale) still has the matching version but a superseded fence →
    // the fenced waking->live transition must be rejected, not admitted on the
    // version CAS alone.
    expect(() =>
      h.db.transitionAgentLifecycle({
        agentId: "worker-1",
        expectedVersion: wakingVersion,
        toState: "live",
        reason: "wake_complete",
        actor: "broker-A",
        correlationId: "cA2",
        fenceToken: leaseA.fenceToken,
      }),
    ).toThrow(/fence rejected/i);
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("waking");

    // The current lease holder (Broker B) may drive the transition.
    h.db.transitionAgentLifecycle({
      agentId: "worker-1",
      expectedVersion: wakingVersion,
      toState: "live",
      reason: "wake_complete",
      actor: "broker-B",
      correlationId: "cB",
      fenceToken: leaseB.fenceToken,
    });
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("live");
  });

  it("rejects a fenced transition when the held lease has expired", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    const agent = h.db.getAgentById("worker-1")!;
    // The fence token still matches (no re-acquisition), but the lease is expired.
    // Binding lease identity + `now` rejects it — a fence token alone is not
    // sufficient authority for a stale-but-unsuperseded lease.
    const lease = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "wake",
      ownerBrokerInstanceId: "broker-A",
      leaseId: "wake-A",
      ttlMs: 1_000,
      now: h.clock.ms,
    })!;
    expect(() =>
      h.db.transitionAgentLifecycle({
        agentId: "worker-1",
        expectedVersion: agent.lifecycleVersion ?? 0,
        toState: "waking",
        reason: "wake",
        actor: "broker-A",
        correlationId: "c-exp",
        fenceToken: lease.fenceToken,
        leaseId: lease.leaseId,
        expectedOperation: "wake",
        now: h.clock.ms + 5_000, // past the 1s TTL
      }),
    ).toThrow(/expired/i);
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("hibernated");
  });

  it("rejects a fenced transition when the held lease is for a different operation", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    const agent = h.db.getAgentById("worker-1")!;
    // A *hibernate* lease is held; a *wake* transition that binds its expected
    // operation must be rejected even though the fence token matches.
    const lease = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "hibernate",
      ownerBrokerInstanceId: "broker-A",
      leaseId: "hib-A",
      ttlMs: 90_000,
      now: h.clock.ms,
    })!;
    expect(() =>
      h.db.transitionAgentLifecycle({
        agentId: "worker-1",
        expectedVersion: agent.lifecycleVersion ?? 0,
        toState: "waking",
        reason: "wake",
        actor: "broker-A",
        correlationId: "c-op",
        fenceToken: lease.fenceToken,
        leaseId: lease.leaseId,
        expectedOperation: "wake",
        now: h.clock.ms,
      }),
    ).toThrow(/does not authorize/i);
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("hibernated");
  });
});

describe("fail-closed fault handling (adapter/DB rejections)", () => {
  it("aborts to active when the checkpoint handshake throws (runtime still alive)", async () => {
    const h = harness();
    seedAgent(h.db);
    h.orch.prepareHibernation("worker-1");
    h.proc.requestCheckpoint = async () => {
      throw new Error("adapter boom /Users/secret/leak");
    };
    const result = await h.orch.hibernate("worker-1");
    expect(result).toMatchObject({ ok: false, reason: "hibernate_fault", state: "active" });
    // Static fault reason — no raw error/path leaks.
    expect(result.reason).not.toContain("/Users/secret");
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("active");
    expect(h.proc.alive).toBe(true);
    expect(h.db.getAgentLifecycleLease("worker-1")).toBeNull();
  });

  it("aborts a pre-teardown hibernate to active even if the hibernate lease expires mid-checkpoint (no strand)", async () => {
    const db = freshDb();
    seedAgent(db);
    const proc = new FakeProcess();
    const tmux = new FakeTmux();
    const clock = { ms: 1_000_000 };
    // The checkpoint reports unsafe, but only after the hibernate lease TTL has
    // elapsed. The rollback-to-active must still fire (unfenced administrative
    // CAS) rather than throw the fenced transition and strand `hibernating`.
    proc.requestCheckpoint = async () => {
      clock.ms += 5_000; // past the 1s hibernate lease TTL
      return {
        hibernateSafe: false,
        reason: "active_port_lease",
        sessionResumeRef: null,
        pendingInboxCount: 0,
        rssBytes: null,
      };
    };
    const orch = new HibernationOrchestrator({
      db,
      process: proc,
      tmux,
      brokerInstanceId: "broker-1",
      now: () => clock.ms,
      config: { hibernateLeaseMs: 1_000, handshakeTimeoutMs: 200, maxWakeAttempts: 1 },
    });
    orch.prepareHibernation("worker-1");

    const result = await orch.hibernate("worker-1");
    expect(result).toMatchObject({
      ok: false,
      reason: "checkpoint_unsafe:active_port_lease",
      state: "active",
    });
    expect(db.getAgentById("worker-1")?.lifecycleState).toBe("active"); // not stranded
    expect(proc.stopCalls).toBe(0); // teardown never began
    expect(db.getAgentLifecycleLease("worker-1")).toBeNull(); // released in finally
  });

  it("quarantines when teardown has begun and an adapter throws (liveness unknown)", async () => {
    const h = harness();
    seedAgent(h.db);
    h.orch.prepareHibernation("worker-1");
    h.proc.stopRuntime = async () => {
      throw new Error("stop boom");
    };
    const result = await h.orch.hibernate("worker-1");
    expect(result).toMatchObject({ ok: false, reason: "hibernate_fault", state: "reap-candidate" });
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("reap-candidate");
    expect(h.db.getAgentLifecycleLease("worker-1")).toBeNull();
  });

  it("quarantines a wake when respawn throws, never stranding `waking`", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    h.tmux.respawnRuntime = async () => {
      throw new Error("respawn boom");
    };
    const result = await h.orch.wake("worker-1");
    expect(result).toMatchObject({ ok: false, reason: "wake_fault", state: "reap-candidate" });
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("reap-candidate");
    expect(h.db.getAgentWakeReservation("worker-1")).toBeNull();
    expect(h.db.getAgentLifecycleLease("worker-1")).toBeNull();
  });

  it("never strands a dispatching wake-queue row when a wake fails", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    h.tmux.respawnRuntime = async () => {
      throw new Error("respawn boom");
    };
    h.orch.enqueueWakeTrigger({ agentId: "worker-1", triggerKind: "direct_a2a", reason: "dm" });
    const results = await h.orch.dispatchWakeQueue();
    expect(results.some((r) => !r.ok)).toBe(true);
    expect(h.db.listWakeQueue("queued")).toHaveLength(0);
    expect(h.db.listWakeQueue("dispatching")).toHaveLength(0);
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("reap-candidate");
  });

  it("requeues (never consumes) a wake trigger when a non-wake lease transiently holds the agent", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    // A lingering *hibernate* lease is held by another owner (e.g. around a
    // crash). No in-flight wake exists, so the queued trigger must survive.
    const held = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "hibernate",
      ownerBrokerInstanceId: "broker-other",
      leaseId: "hib-other",
      ttlMs: 90_000,
      now: h.clock.ms,
    });
    expect(held).not.toBeNull();
    h.orch.enqueueWakeTrigger({ agentId: "worker-1", triggerKind: "manual", reason: "manual" });

    const results = await h.orch.dispatchWakeQueue();
    // Distinct retryable contention (not a benign "in progress" no-op): the row
    // is requeued and the agent is deferred so the lease cannot spin the pass.
    expect(results.some((r) => !r.ok && r.reason === "wake_lease_contended")).toBe(true);
    expect(h.db.listWakeQueue("queued")).toHaveLength(1);
    expect(h.db.listWakeQueue("dispatching")).toHaveLength(0);
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("hibernated");
  });
});

describe("wake lease renewal (long waits) + fail-closed lease loss", () => {
  it("renews per attempt so a wake whose cumulative waits exceed one lease TTL still completes", async () => {
    const db = freshDb();
    seedAgent(db);
    const proc = new FakeProcess();
    const tmux = new FakeTmux();
    const clock = { ms: 1_000_000 };
    let calls = 0;
    const orch = new HibernationOrchestrator({
      db,
      process: proc,
      tmux,
      brokerInstanceId: "broker-1",
      now: () => clock.ms,
      config: {
        registrationTimeoutMs: 200,
        handshakeTimeoutMs: 200,
        maxWakeAttempts: 3,
        wakeLeaseMs: 90_000,
      },
      // Each attempt "waits" 60s. The first two fail; the third registers and
      // accepts. Cumulative 180s > the 90s lease TTL, so this only completes if
      // the lease is renewed per attempt.
      awaitRuntimeRegistration: async (ctx: RuntimeLaunchContext) => {
        calls += 1;
        clock.ms += 60_000;
        if (calls < 3) return false;
        db.registerAgent(
          ctx.agentId,
          "Worker",
          "🦉",
          5555,
          { ...AGENT_METADATA },
          ctx.spec.stableId,
        );
        return db.acceptRuntimeGeneration({
          agentId: ctx.agentId,
          wakeLeaseId: ctx.wakeLeaseId,
          fenceToken: ctx.fenceToken,
          reservedGeneration: ctx.reservedGeneration,
          reservationNonce: ctx.reservationNonce,
          now: clock.ms,
        }).accepted;
      },
    });
    // Drive to hibernated using a throwaway orchestrator's hibernate path.
    await hibernateFrom({ db, proc, tmux, orch, clock });

    const result = await orch.wake("worker-1");
    expect(result).toMatchObject({ ok: true, state: "live", attempts: 3 });
    expect(clock.ms - 1_000_000).toBeGreaterThan(90_000); // proves waits outran one TTL
    expect(db.getAgentLifecycleLease("worker-1")).toBeNull(); // released in finally
  });

  it("fails closed (quarantines) rather than relaunch when a launched runtime cannot be confirmed stopped", async () => {
    // A runtime launched but never accepted has ambiguous liveness. If the
    // broker cannot confirm it is stopped, relaunching would risk two runtimes
    // for one identity — so the wake must quarantine instead of retrying.
    const db = freshDb();
    seedAgent(db);
    const proc = new FakeProcess();
    const tmux = new FakeTmux(); // launched:true, but registration never accepts
    const clock = { ms: 1_000_000 };
    const orch = new HibernationOrchestrator({
      db,
      process: proc,
      tmux,
      brokerInstanceId: "broker-1",
      now: () => clock.ms,
      config: { registrationTimeoutMs: 200, handshakeTimeoutMs: 200, maxWakeAttempts: 3 },
      awaitRuntimeRegistration: async () => false, // launched, never registers
    });
    // Hibernate with a healthy stop first, then make the *wake-time* stop
    // unconfirmable so the retry path must fail closed.
    await hibernateFrom({ db, proc, tmux, orch, clock });
    proc.stopResult = { stopped: false, rssBytes: null }; // stop cannot confirm
    proc.alive = true; // still alive after the stop attempt
    proc.stopCalls = 0;

    const result = await orch.wake("worker-1", { trigger: "manual" });
    expect(result).toMatchObject({ ok: false, state: "reap-candidate" });
    expect(result.reason).toBe("wake_ambiguous_launch");
    // Quarantined on the FIRST ambiguous attempt — did not relaunch on top of a
    // possibly-live runtime.
    expect(tmux.respawnCalls.length).toBe(1);
    expect(proc.stopCalls).toBe(1);
    expect(db.getAgentLifecycleLease("worker-1")).toBeNull(); // released in finally
  });

  it("promotes an accepted runtime to live even if the lease expires AFTER acceptance (no false quarantine)", async () => {
    const db = freshDb();
    seedAgent(db);
    const proc = new FakeProcess();
    const tmux = new FakeTmux();
    const clock = { ms: 1_000_000 };
    const orch = new HibernationOrchestrator({
      db,
      process: proc,
      tmux,
      brokerInstanceId: "broker-1",
      now: () => clock.ms,
      config: {
        registrationTimeoutMs: 200,
        handshakeTimeoutMs: 200,
        maxWakeAttempts: 1,
        wakeLeaseMs: 1_000,
      },
      awaitRuntimeRegistration: async (ctx: RuntimeLaunchContext) => {
        db.registerAgent(
          ctx.agentId,
          "Worker",
          "🦉",
          5555,
          { ...AGENT_METADATA },
          ctx.spec.stableId,
        );
        const accepted = db.acceptRuntimeGeneration({
          agentId: ctx.agentId,
          wakeLeaseId: ctx.wakeLeaseId,
          fenceToken: ctx.fenceToken,
          reservedGeneration: ctx.reservedGeneration,
          reservationNonce: ctx.reservationNonce,
          now: clock.ms,
        }).accepted;
        // Generation is accepted; then the final promotion is delayed past the
        // 1s lease TTL. A fenced promotion would throw here and quarantine an
        // already-live runtime — the administrative promotion must not.
        clock.ms += 5_000;
        return accepted;
      },
    });
    await hibernateFrom({ db, proc, tmux, orch, clock });

    const result = await orch.wake("worker-1");
    expect(result).toMatchObject({ ok: true, state: "live", attempts: 1 });
    expect(db.getAgentById("worker-1")?.lifecycleState).toBe("live");
    expect(db.getAgentLifecycleLease("worker-1")).toBeNull();
  });

  it("quarantines fail-closed (never strands `waking`) when the lease is lost mid-wake", async () => {
    const db = freshDb();
    seedAgent(db);
    const proc = new FakeProcess();
    const tmux = new FakeTmux();
    const clock = { ms: 1_000_000 };
    const orch = new HibernationOrchestrator({
      db,
      process: proc,
      tmux,
      brokerInstanceId: "broker-1",
      now: () => clock.ms,
      config: {
        registrationTimeoutMs: 200,
        handshakeTimeoutMs: 200,
        maxWakeAttempts: 2,
        wakeLeaseMs: 90_000,
      },
      // Attempt 1 "waits" past the full lease TTL without registering, so the
      // per-attempt renewal at attempt 2 fails (ownership lost). This must
      // quarantine, not strand the agent in `waking` and not double-drive it.
      awaitRuntimeRegistration: async () => {
        clock.ms += 90_001;
        return false;
      },
    });
    await hibernateFrom({ db, proc, tmux, orch, clock });

    const result = await orch.wake("worker-1");
    expect(result).toMatchObject({ ok: false, reason: "wake_lease_lost", state: "reap-candidate" });
    expect(db.getAgentById("worker-1")?.lifecycleState).toBe("reap-candidate");
    expect(db.getAgentWakeReservation("worker-1")).toBeNull();
    expect(db.getAgentLifecycleLease("worker-1")).toBeNull();
  });
});

describe("recoverStrandedWakes (crash between acceptance and live)", () => {
  it("completes a waking agent whose generation was already accepted", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    const agent = h.db.getAgentById("worker-1")!;
    const lease = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "wake",
      ownerBrokerInstanceId: "broker-1",
      leaseId: "wake-1",
      ttlMs: 90_000,
      now: h.clock.ms,
    })!;
    h.db.transitionAgentLifecycle({
      agentId: "worker-1",
      expectedVersion: agent.lifecycleVersion ?? 0,
      toState: "waking",
      reason: "wake",
      actor: "broker",
      correlationId: "c",
      fenceToken: lease.fenceToken,
    });
    const reservation = h.db.reserveWakeGeneration({
      agentId: "worker-1",
      wakeLeaseId: "wake-1",
      fenceToken: lease.fenceToken,
      correlationId: "c",
      now: h.clock.ms,
    });
    // Generation accepted, but the final waking->live transition is "lost".
    expect(
      h.db.acceptRuntimeGeneration({
        agentId: "worker-1",
        wakeLeaseId: "wake-1",
        fenceToken: lease.fenceToken,
        reservedGeneration: reservation.reservedGeneration,
        reservationNonce: reservation.reservationNonce,
        now: h.clock.ms,
      }).accepted,
    ).toBe(true);
    h.db.releaseAgentLifecycleLease("worker-1", lease.leaseId, lease.fenceToken);

    const recovered = h.orch.recoverStrandedWakes({ now: h.clock.ms });
    expect(recovered).toEqual([{ agentId: "worker-1", action: "completed" }]);
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("live");
  });

  it("quarantines a waking agent with no accepted generation", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    const agent = h.db.getAgentById("worker-1")!;
    const lease = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "wake",
      ownerBrokerInstanceId: "broker-1",
      leaseId: "wake-1",
      ttlMs: 90_000,
      now: h.clock.ms,
    })!;
    h.db.transitionAgentLifecycle({
      agentId: "worker-1",
      expectedVersion: agent.lifecycleVersion ?? 0,
      toState: "waking",
      reason: "wake",
      actor: "broker",
      correlationId: "c",
      fenceToken: lease.fenceToken,
    });
    h.db.reserveWakeGeneration({
      agentId: "worker-1",
      wakeLeaseId: "wake-1",
      fenceToken: lease.fenceToken,
      correlationId: "c",
      now: h.clock.ms,
    });
    h.db.releaseAgentLifecycleLease("worker-1", lease.leaseId, lease.fenceToken);

    const recovered = h.orch.recoverStrandedWakes({ now: h.clock.ms });
    expect(recovered).toEqual([{ agentId: "worker-1", action: "quarantined" }]);
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("reap-candidate");
    expect(h.db.getAgentWakeReservation("worker-1")).toBeNull();
  });

  it("skips a waking agent whose wake lease is still held", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    const agent = h.db.getAgentById("worker-1")!;
    const lease = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "wake",
      ownerBrokerInstanceId: "broker-1",
      leaseId: "wake-1",
      ttlMs: 90_000,
      now: h.clock.ms,
    })!;
    h.db.transitionAgentLifecycle({
      agentId: "worker-1",
      expectedVersion: agent.lifecycleVersion ?? 0,
      toState: "waking",
      reason: "wake",
      actor: "broker",
      correlationId: "c",
      fenceToken: lease.fenceToken,
    });
    // Lease still held and unexpired → an owner is actively waking; skip.
    const recovered = h.orch.recoverStrandedWakes({ now: h.clock.ms });
    expect(recovered).toHaveLength(0);
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("waking");
  });

  it("quarantines a stranded hibernating agent (crash mid-hibernate)", () => {
    const h = harness();
    seedAgent(h.db);
    const prep = h.orch.prepareHibernation("worker-1");
    expect(prep.ready).toBe(true);
    const agent = h.db.getAgentById("worker-1")!;
    const lease = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "hibernate",
      ownerBrokerInstanceId: "broker-1",
      leaseId: "hib-1",
      ttlMs: 90_000,
      now: h.clock.ms,
    })!;
    h.db.transitionAgentLifecycle({
      agentId: "worker-1",
      expectedVersion: agent.lifecycleVersion ?? 0,
      toState: "hibernating",
      reason: "hibernate",
      actor: "broker",
      correlationId: "c",
      fenceToken: lease.fenceToken,
    });
    // Crash: the hibernate never reached the durable `hibernated` state and the
    // lease is gone.
    h.db.releaseAgentLifecycleLease("worker-1", lease.leaseId, lease.fenceToken);
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("hibernating");

    const recovered = h.orch.recoverStrandedWakes({ now: h.clock.ms });
    expect(recovered).toEqual([{ agentId: "worker-1", action: "quarantined" }]);
    // Fail closed: uncertain runtime liveness → reap-candidate, not a silent
    // completion that could double-launch on the next wake.
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("reap-candidate");
  });

  it("requeues a wake-queue row orphaned in dispatching by a crash", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    h.orch.enqueueWakeTrigger({ agentId: "worker-1", triggerKind: "manual", reason: "manual" });
    const queuedRow = h.db.listWakeQueue("queued")[0];
    expect(queuedRow).toBeDefined();
    // Simulate a crash mid-dispatch: the row is claimed to `dispatching` and the
    // owning dispatch loop then dies, stranding it (and blocking the unique
    // active-agent index) until reclaimed.
    expect(h.db.markWakeDispatching(queuedRow.id)).not.toBeNull();
    expect(h.db.listWakeQueue("dispatching")).toHaveLength(1);

    const recovered = h.orch.recoverStrandedWakes({ now: h.clock.ms });
    expect(recovered).toEqual([{ agentId: "worker-1", action: "requeued" }]);
    expect(h.db.listWakeQueue("dispatching")).toHaveLength(0);
    expect(h.db.listWakeQueue("queued")).toHaveLength(1);
  });

  it("reconciles an accepted waking row whose UNEXPIRED lease belongs to a crashed prior broker", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    const agent = h.db.getAgentById("worker-1")!;
    // A PRIOR broker instance drove the wake and its runtime accepted the
    // generation — then that broker crashed. The lease is still UNEXPIRED but
    // orphaned (owned by the dead instance). This is the ordinary quick-restart
    // case: without owner-awareness, reconciliation would skip it forever.
    const lease = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "wake",
      ownerBrokerInstanceId: "broker-prior",
      leaseId: "wake-prior",
      ttlMs: 90_000,
      now: h.clock.ms,
    })!;
    h.db.transitionAgentLifecycle({
      agentId: "worker-1",
      expectedVersion: agent.lifecycleVersion ?? 0,
      toState: "waking",
      reason: "wake",
      actor: "broker",
      correlationId: "c",
      fenceToken: lease.fenceToken,
    });
    const reservation = h.db.reserveWakeGeneration({
      agentId: "worker-1",
      wakeLeaseId: "wake-prior",
      fenceToken: lease.fenceToken,
      correlationId: "c",
      now: h.clock.ms,
    });
    expect(
      h.db.acceptRuntimeGeneration({
        agentId: "worker-1",
        wakeLeaseId: "wake-prior",
        fenceToken: lease.fenceToken,
        reservedGeneration: reservation.reservedGeneration,
        reservationNonce: reservation.reservationNonce,
        now: h.clock.ms,
      }).accepted,
    ).toBe(true);
    // The prior broker's lease is intentionally NOT released and NOT expired.
    expect(h.db.getAgentLifecycleLease("worker-1")).not.toBeNull();

    // Fresh broker ("broker-1") reconciliation must NOT skip the orphan just
    // because its lease is unexpired — the prior owner is gone.
    const recovered = h.orch.recoverStrandedWakes({ now: h.clock.ms });
    expect(recovered).toEqual([{ agentId: "worker-1", action: "completed" }]);
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("live");
    expect(h.db.getAgentLifecycleLease("worker-1")).toBeNull();
  });

  it("reconciles a hibernating row whose UNEXPIRED lease belongs to a crashed prior broker", () => {
    const h = harness();
    seedAgent(h.db);
    const prep = h.orch.prepareHibernation("worker-1");
    expect(prep.ready).toBe(true);
    const agent = h.db.getAgentById("worker-1")!;
    const lease = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "hibernate",
      ownerBrokerInstanceId: "broker-prior",
      leaseId: "hib-prior",
      ttlMs: 90_000,
      now: h.clock.ms,
    })!;
    h.db.transitionAgentLifecycle({
      agentId: "worker-1",
      expectedVersion: agent.lifecycleVersion ?? 0,
      toState: "hibernating",
      reason: "hibernate",
      actor: "broker",
      correlationId: "c",
      fenceToken: lease.fenceToken,
    });
    // Prior broker crashed mid-hibernate; its lease is unexpired but orphaned.
    expect(h.db.getAgentLifecycleLease("worker-1")).not.toBeNull();

    const recovered = h.orch.recoverStrandedWakes({ now: h.clock.ms });
    expect(recovered).toEqual([{ agentId: "worker-1", action: "quarantined" }]);
    expect(h.db.getAgentById("worker-1")?.lifecycleState).toBe("reap-candidate");
    expect(h.db.getAgentLifecycleLease("worker-1")).toBeNull();
  });
});

describe("wake queue", () => {
  it("is idempotent per agent and keeps the strongest priority", () => {
    const h = harness();
    seedAgent(h.db);
    h.orch.enqueueWakeTrigger({
      agentId: "worker-1",
      triggerKind: "lane_assignment",
      reason: "lane",
    });
    h.orch.enqueueWakeTrigger({ agentId: "worker-1", triggerKind: "direct_a2a", reason: "dm" });
    const queued = h.db.listWakeQueue("queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.priority).toBe(wakeTriggerPriority("direct_a2a"));
  });

  it("dispatches in priority then oldest order and respects concurrency", async () => {
    const h = harness();
    // Two hibernated agents in different repos.
    seedAgent(h.db, "worker-1", "host:session:aaaaaaaaaaaa");
    seedAgent(h.db, "worker-2", "host:session:bbbbbbbbbbbb");
    // worker-2 in a different repo so per-repo limit does not serialize them.
    h.db.upsertAgentRuntimeSpec({
      ...runtimeSpec("worker-2", "host:session:bbbbbbbbbbbb"),
      repoRoot: "/repo2",
      worktreePath: "/repo2/wt",
    });
    await hibernateFrom(h, "worker-1");
    await hibernateFrom(h, "worker-2");

    h.orch.enqueueWakeTrigger({
      agentId: "worker-1",
      triggerKind: "lane_assignment",
      reason: "lane",
    });
    h.orch.enqueueWakeTrigger({ agentId: "worker-2", triggerKind: "direct_a2a", reason: "dm" });

    const results = await h.orch.dispatchWakeQueue();
    // Both dispatched (global limit 2, different repos), direct_a2a first.
    expect(results.map((r) => r.agentId)).toEqual(["worker-2", "worker-1"]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(h.db.listWakeQueue("queued")).toHaveLength(0);
  });

  it("does not crash the drain pass if the sole queue-finalization write fails (row stays reclaimable)", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    // A live wake lease is held by another owner, so dispatch's wake() returns a
    // benign `wake_in_progress`. In that branch `completeWakeQueueEntry(id,"done")`
    // is the SOLE finalizer of the queue row (the success path's
    // `completeWakeForAgent` never runs), so a failing write here is the real
    // strand risk.
    const held = h.db.acquireAgentLifecycleLease({
      agentId: "worker-1",
      operation: "wake",
      ownerBrokerInstanceId: "broker-other",
      leaseId: "wake-other",
      ttlMs: 90_000,
      now: h.clock.ms,
    });
    expect(held).not.toBeNull();
    h.orch.enqueueWakeTrigger({ agentId: "worker-1", triggerKind: "manual", reason: "manual" });

    const original = h.db.completeWakeQueueEntry.bind(h.db);
    let threw = false;
    h.db.completeWakeQueueEntry = ((_id: number, _status: "done" | "cancelled") => {
      threw = true;
      throw new Error("transient sqlite write failure");
    }) as typeof h.db.completeWakeQueueEntry;

    // The pass must not throw despite the failed finalization write.
    const results = await h.orch.dispatchWakeQueue();
    expect(threw).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]?.reason).toBe("wake_in_progress");
    // The row is left `dispatching` (its only finalizer failed) and is reclaimed
    // by `recoverStrandedWakes` on the next reconciliation pass — never lost.
    h.db.completeWakeQueueEntry = original;
    expect(h.db.listWakeQueue("dispatching")).toHaveLength(1);
    const recovered = h.orch.recoverStrandedWakes({ now: h.clock.ms });
    expect(recovered).toContainEqual({ agentId: "worker-1", action: "requeued" });
  });

  it("does not crash the drain pass when wake() throws AND the cancel-finalizer also fails", async () => {
    // The worst case: wake() itself throws (it is designed not to, but a bug or
    // adapter fault could), and the throw-path's `completeWakeQueueEntry(id,
    // "cancelled")` ALSO fails. The pass must still not throw; the row stays
    // reclaimable via reconciliation rather than stranding every other row.
    const db = freshDb();
    seedAgent(db);
    const proc = new FakeProcess();
    const tmux = new FakeTmux();
    const clock = { ms: 1_000_000 };
    const orch = new HibernationOrchestrator({
      db,
      process: proc,
      tmux,
      brokerInstanceId: "broker-1",
      now: () => clock.ms,
      config: { registrationTimeoutMs: 200, handshakeTimeoutMs: 200, maxWakeAttempts: 1 },
    });
    await hibernateFrom({ db, proc, tmux, orch, clock });
    orch.enqueueWakeTrigger({ agentId: "worker-1", triggerKind: "manual", reason: "manual" });

    // Force wake() to throw for this row.
    const realWake = orch.wake.bind(orch);
    orch.wake = (async () => {
      throw new Error("unexpected wake fault");
    }) as typeof orch.wake;
    // And force the throw-path cancel finalizer to also fail.
    let cancelAttempted = false;
    const originalComplete = db.completeWakeQueueEntry.bind(db);
    db.completeWakeQueueEntry = ((_id: number, _status: "done" | "cancelled") => {
      cancelAttempted = true;
      throw new Error("transient sqlite write failure");
    }) as typeof db.completeWakeQueueEntry;

    const results = await orch.dispatchWakeQueue();
    expect(cancelAttempted).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]?.reason).toBe("wake_fault");

    // Restore and confirm the row is reclaimable (still `dispatching`).
    db.completeWakeQueueEntry = originalComplete;
    orch.wake = realWake;
    expect(db.listWakeQueue("dispatching")).toHaveLength(1);
    const recovered = orch.recoverStrandedWakes({ now: clock.ms });
    expect(recovered).toContainEqual({ agentId: "worker-1", action: "requeued" });
  });
});
