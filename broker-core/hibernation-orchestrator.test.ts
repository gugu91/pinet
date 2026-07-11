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
    registerBehavior?: "accept" | "stale_fence" | "stale_generation" | "no_register";
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
            : ctx;
      const acceptance = db.acceptRuntimeGeneration({
        agentId: presented.agentId,
        wakeLeaseId: presented.wakeLeaseId,
        fenceToken: presented.fenceToken,
        reservedGeneration: presented.reservedGeneration,
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
});

describe("acceptRuntimeGeneration fencing", () => {
  /**
   * Drive an already-hibernated agent to the real pre-acceptance wake state: a
   * held unexpired `wake` lease, a `waking` lifecycle CAS, and a reserved
   * generation — exactly what the socket server presents at registration.
   */
  function driveToWaking(
    h: Harness,
    opts: { ttlMs?: number } = {},
  ): { leaseId: string; fenceToken: number } {
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
      now: h.clock.ms,
    });
    expect(reservation.reservedGeneration).toBe(1);
    return { leaseId: "wake-1", fenceToken: lease!.fenceToken };
  }

  it("accepts exactly one matching generation and rejects duplicates/stale", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    const { fenceToken } = driveToWaking(h);

    // Stale fence rejected.
    expect(
      h.db.acceptRuntimeGeneration({
        agentId: "worker-1",
        wakeLeaseId: "wake-1",
        fenceToken: fenceToken + 1,
        reservedGeneration: 1,
        now: h.clock.ms,
      }),
    ).toMatchObject({ accepted: false, reason: "fence_mismatch" });

    // Correct acceptance.
    expect(
      h.db.acceptRuntimeGeneration({
        agentId: "worker-1",
        wakeLeaseId: "wake-1",
        fenceToken,
        reservedGeneration: 1,
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
        now: h.clock.ms,
      }),
    ).toMatchObject({ accepted: false, reason: "no_reservation" });
  });

  it("rejects acceptance under an expired wake lease (strict lease binding)", async () => {
    const h = harness();
    seedAgent(h.db);
    await hibernateFrom(h);
    const { fenceToken } = driveToWaking(h, { ttlMs: 90_000 });

    // Present the otherwise-matching reservation after the lease has expired.
    expect(
      h.db.acceptRuntimeGeneration({
        agentId: "worker-1",
        wakeLeaseId: "wake-1",
        fenceToken,
        reservedGeneration: 1,
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
});
