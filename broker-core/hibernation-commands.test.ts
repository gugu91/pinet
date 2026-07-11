import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerDB } from "./schema.js";
import {
  HibernationOrchestrator,
  type HibernationCheckpointOutcome,
  type HibernationProcessController,
  type HibernationTmuxController,
  type RuntimeLaunchContext,
} from "./index.js";
import {
  evaluateHibernateCommandGate,
  evaluateWakeCommandGate,
  executeHibernateCommand,
  executeWakeCommand,
  formatHibernationCommandResult,
  unknownHibernationTarget,
  type HibernationCommandPolicy,
} from "./hibernation-commands.js";
import type { AgentRuntimeSpecInput } from "./types.js";

const ENABLED: HibernationCommandPolicy = {
  enabled: true,
  mode: "manual",
  // Bare-basename entry: intentionally admits agents whose repo basename is
  // "extensions" (slug-vs-basename semantics are exercised explicitly below).
  allowedRepos: ["extensions"],
};

// ─── Pure gate coverage ──────────────────────────────────────────────

describe("evaluateHibernateCommandGate", () => {
  it("refuses when hibernation is disabled (default-off)", () => {
    const gate = evaluateHibernateCommandGate({
      state: "idle",
      repoIdentifier: "extensions",
      policy: { ...ENABLED, enabled: false },
    });
    expect(gate).toMatchObject({ outcome: "refused", refusal: { reason: "hibernation_disabled" } });
  });

  it("refuses in observe-only mode", () => {
    const gate = evaluateHibernateCommandGate({
      state: "idle",
      repoIdentifier: "extensions",
      policy: { ...ENABLED, mode: "observe" },
    });
    expect(gate).toMatchObject({ outcome: "refused", refusal: { reason: "observe_only" } });
  });

  it("is an idempotent no-op when already hibernated", () => {
    const gate = evaluateHibernateCommandGate({
      state: "hibernated",
      repoIdentifier: "extensions",
      policy: ENABLED,
    });
    expect(gate).toMatchObject({ outcome: "noop", reason: "already_hibernating" });
  });

  it("refuses quarantined and terminated agents", () => {
    expect(
      evaluateHibernateCommandGate({
        state: "reap-candidate",
        repoIdentifier: "extensions",
        policy: ENABLED,
      }),
    ).toMatchObject({ outcome: "refused", refusal: { reason: "quarantined" } });
    expect(
      evaluateHibernateCommandGate({
        state: "terminated",
        repoIdentifier: "extensions",
        policy: ENABLED,
      }),
    ).toMatchObject({ outcome: "refused", refusal: { reason: "terminated" } });
  });

  it("refuses a repo outside the allowlist", () => {
    expect(
      evaluateHibernateCommandGate({
        state: "idle",
        repoIdentifier: "other-repo",
        policy: ENABLED,
      }),
    ).toMatchObject({ outcome: "refused", refusal: { reason: "repo_not_allowlisted" } });
  });

  it("bare-basename allowlist entry admits matching slug or basename", () => {
    const policy: HibernationCommandPolicy = { ...ENABLED, allowedRepos: ["extensions"] };
    expect(
      evaluateHibernateCommandGate({ state: "idle", repoIdentifier: "extensions", policy }),
    ).toMatchObject({ outcome: "proceed" });
    expect(
      evaluateHibernateCommandGate({ state: "idle", repoIdentifier: "gugu91/extensions", policy }),
    ).toMatchObject({ outcome: "proceed" });
  });

  it("slug allowlist entry requires an exact slug — no basename collapse", () => {
    const policy: HibernationCommandPolicy = { ...ENABLED, allowedRepos: ["gugu91/extensions"] };
    // Exact slug proceeds.
    expect(
      evaluateHibernateCommandGate({ state: "idle", repoIdentifier: "gugu91/extensions", policy }),
    ).toMatchObject({ outcome: "proceed" });
    // A different owner with the same basename must NOT be admitted.
    expect(
      evaluateHibernateCommandGate({ state: "idle", repoIdentifier: "evil/extensions", policy }),
    ).toMatchObject({ outcome: "refused", refusal: { reason: "repo_not_allowlisted" } });
    // A bare basename does not collapse into a slug entry either.
    expect(
      evaluateHibernateCommandGate({ state: "idle", repoIdentifier: "extensions", policy }),
    ).toMatchObject({ outcome: "refused", refusal: { reason: "repo_not_allowlisted" } });
  });

  it("rejects blank identifiers and blank allowlist entries (fail-closed)", () => {
    expect(
      evaluateHibernateCommandGate({ state: "idle", repoIdentifier: null, policy: ENABLED }),
    ).toMatchObject({ outcome: "refused", refusal: { reason: "repo_not_allowlisted" } });
    expect(
      evaluateHibernateCommandGate({
        state: "idle",
        repoIdentifier: "   ",
        policy: { ...ENABLED, allowedRepos: ["extensions"] },
      }),
    ).toMatchObject({ outcome: "refused", refusal: { reason: "repo_not_allowlisted" } });
    expect(
      evaluateHibernateCommandGate({
        state: "idle",
        repoIdentifier: "extensions",
        policy: { ...ENABLED, allowedRepos: ["", "  "] },
      }),
    ).toMatchObject({ outcome: "refused", refusal: { reason: "repo_not_allowlisted" } });
  });

  it("normalizes Windows backslash separators for slug/basename matching", () => {
    // Backslash identifier reduced to a slug still matches a "/" slug entry.
    expect(
      evaluateHibernateCommandGate({
        state: "idle",
        repoIdentifier: "gugu91\\extensions",
        policy: { ...ENABLED, allowedRepos: ["gugu91/extensions"] },
      }),
    ).toMatchObject({ outcome: "proceed" });
    // A backslash allowlist entry is normalized too.
    expect(
      evaluateHibernateCommandGate({
        state: "idle",
        repoIdentifier: "gugu91/extensions",
        policy: { ...ENABLED, allowedRepos: ["gugu91\\extensions"] },
      }),
    ).toMatchObject({ outcome: "proceed" });
    // A full Windows path's basename still admits a bare-basename entry.
    expect(
      evaluateHibernateCommandGate({
        state: "idle",
        repoIdentifier: "C:\\Users\\tm\\repo\\extensions",
        policy: { ...ENABLED, allowedRepos: ["extensions"] },
      }),
    ).toMatchObject({ outcome: "proceed" });
  });
});

describe("evaluateWakeCommandGate", () => {
  it("proceeds for a hibernated identity even when hibernation is disabled (drain guarantee)", () => {
    const gate = evaluateWakeCommandGate({
      state: "hibernated",
      policy: { ...ENABLED, enabled: false, mode: "observe" },
    });
    expect(gate).toMatchObject({ outcome: "proceed" });
  });

  it("is an idempotent no-op for an already-awake agent", () => {
    expect(evaluateWakeCommandGate({ state: "live", policy: ENABLED })).toMatchObject({
      outcome: "noop",
      reason: "already_awake",
    });
    expect(evaluateWakeCommandGate({ state: "idle", policy: ENABLED })).toMatchObject({
      outcome: "noop",
      reason: "already_awake",
    });
  });

  it("refuses quarantined, terminated, and mid-hibernation targets", () => {
    expect(evaluateWakeCommandGate({ state: "reap-candidate", policy: ENABLED })).toMatchObject({
      outcome: "refused",
      refusal: { reason: "quarantined" },
    });
    expect(evaluateWakeCommandGate({ state: "terminated", policy: ENABLED })).toMatchObject({
      outcome: "refused",
      refusal: { reason: "terminated" },
    });
    expect(evaluateWakeCommandGate({ state: "hibernating", policy: ENABLED })).toMatchObject({
      outcome: "refused",
      refusal: { reason: "hibernate_in_progress" },
    });
  });

  it("treats an already-waking target as a noop (in-flight wake), not a false proceed", () => {
    expect(evaluateWakeCommandGate({ state: "waking", policy: ENABLED })).toMatchObject({
      outcome: "noop",
      reason: "wake_in_progress",
    });
  });
});

describe("unknownHibernationTarget + formatter", () => {
  it("builds a sanitized unknown-target refusal", () => {
    const result = unknownHibernationTarget("wake", "@Ghost Whale");
    expect(result).toMatchObject({
      outcome: "refused",
      reason: "unknown_target",
      state: "unknown",
    });
  });

  it("control-strips and length-bounds the echoed unknown target", () => {
    const result = unknownHibernationTarget("hibernate", `evil\n${"a".repeat(200)}\u0000`);
    expect(result.agentId).not.toContain("\n");
    expect(result.agentId).not.toContain("\u0000");
    expect(result.agentId.length).toBeLessThanOrEqual(64);
    // Empty/whitespace-only target degrades to a safe placeholder.
    expect(unknownHibernationTarget("wake", "   ").agentId).toBe("(unnamed)");
  });

  it("redacts path-like tokens in the echoed unknown target", () => {
    const result = unknownHibernationTarget("hibernate", "/Users/tm/private/secret-worktree");
    expect(result.agentId).not.toContain("/Users");
    expect(result.agentId).toContain("<path>");
  });

  it("formats without leaking anything beyond machine reason/detail/state", () => {
    const text = formatHibernationCommandResult({
      command: "wake",
      agentId: "worker-1",
      outcome: "executed",
      state: "live",
      reason: "woken",
      detail: "Agent runtime woken; queued messages will drain in order.",
      runtimeGeneration: 3,
      attempts: 1,
    });
    expect(text).toContain("wake worker-1: executed");
    expect(text).toContain("runtime_generation=3");
    expect(text).not.toMatch(/\/(Users|repo|private|tmp)\b/);
    expect(text).not.toContain("argv");
  });
});

// ─── Executor coverage against the real orchestrator ─────────────────

const AGENT_METADATA = {
  brokerManaged: true,
  brokerManagedBy: "broker-1",
  hibernateSafe: true,
  cwd: "/repo/wt",
  repoRoot: "/repo",
  worktreePath: "/repo/wt",
  tmuxSession: "worker-1",
};

const tempDirs: string[] = [];
function freshDb(): BrokerDB {
  const dir = mkdtempSync(join(tmpdir(), "pinet-hib-cmd-"));
  tempDirs.push(dir);
  const db = new BrokerDB(join(dir, "broker.db"));
  db.initialize();
  return db;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

class FakeProcess implements HibernationProcessController {
  checkpoint: HibernationCheckpointOutcome = {
    hibernateSafe: true,
    reason: null,
    sessionResumeRef: "session:abcdef123456",
    pendingInboxCount: 0,
    rssBytes: 120_000_000,
  };
  alive = true;
  async requestCheckpoint(): Promise<HibernationCheckpointOutcome> {
    return this.checkpoint;
  }
  async stopRuntime(): Promise<{ stopped: boolean; rssBytes: number | null }> {
    this.alive = false;
    return { stopped: true, rssBytes: 0 };
  }
  async isRuntimeAlive(): Promise<boolean> {
    return this.alive;
  }
}

class FakeTmux implements HibernationTmuxController {
  attachable = true;
  async isSessionAttachable(): Promise<boolean> {
    return this.attachable;
  }
  async respawnRuntime(): Promise<{ launched: boolean }> {
    return { launched: true };
  }
}

function buildOrch(
  db: BrokerDB,
  proc: FakeProcess,
  tmux: FakeTmux,
  behavior: "accept" | "stale_fence" | "no_register" = "accept",
): HibernationOrchestrator {
  return new HibernationOrchestrator({
    db,
    process: proc,
    tmux,
    brokerInstanceId: "broker-1",
    config: { registrationTimeoutMs: 200, handshakeTimeoutMs: 200, maxWakeAttempts: 2 },
    awaitRuntimeRegistration: async (ctx: RuntimeLaunchContext) => {
      if (behavior === "no_register") return false;
      db.registerAgent(ctx.agentId, "Worker", "🦉", 5555, { ...AGENT_METADATA }, ctx.spec.stableId);
      const presented =
        behavior === "stale_fence" ? { ...ctx, fenceToken: ctx.fenceToken + 99 } : ctx;
      const acceptance = db.acceptRuntimeGeneration({
        agentId: presented.agentId,
        wakeLeaseId: presented.wakeLeaseId,
        fenceToken: presented.fenceToken,
        reservedGeneration: presented.reservedGeneration,
      });
      return acceptance.accepted;
    },
  });
}

function seedAgent(db: BrokerDB, id = "worker-1", stableId = "host:session:abcdef123456"): void {
  db.registerAgent(id, "Worker", "🦉", 4242, { ...AGENT_METADATA }, stableId);
  db.setAgentHibernatePolicy(id, "manual");
  db.upsertAgentRuntimeSpec(runtimeSpec(id, stableId));
}

describe("executeHibernateCommand — against the real orchestrator", () => {
  it("executes a full cold hibernate for an eligible free worker", async () => {
    const db = freshDb();
    const orch = buildOrch(db, new FakeProcess(), new FakeTmux());
    seedAgent(db);
    const result = await executeHibernateCommand({
      executor: orch,
      agentId: "worker-1",
      state: "idle",
      repoIdentifier: "extensions",
      policy: ENABLED,
    });
    expect(result).toMatchObject({
      outcome: "executed",
      state: "hibernated",
      reason: "hibernated",
    });
    expect(db.getAgentById("worker-1")?.lifecycleState).toBe("hibernated");
  });

  it("refuses (disabled) before touching the orchestrator", async () => {
    const db = freshDb();
    const proc = new FakeProcess();
    const orch = buildOrch(db, proc, new FakeTmux());
    seedAgent(db);
    const result = await executeHibernateCommand({
      executor: orch,
      agentId: "worker-1",
      state: "idle",
      repoIdentifier: "extensions",
      policy: { ...ENABLED, enabled: false },
    });
    expect(result).toMatchObject({ outcome: "refused", reason: "hibernation_disabled" });
    // Untouched: still live, no checkpoint attempted.
    expect(db.getAgentById("worker-1")?.lifecycleState).toBe("live");
    expect(proc.alive).toBe(true);
  });

  it("surfaces an unsafe-checkpoint refusal and leaves the runtime running", async () => {
    const db = freshDb();
    const proc = new FakeProcess();
    proc.checkpoint = { ...proc.checkpoint, hibernateSafe: false, reason: "active_port_lease" };
    const orch = buildOrch(db, proc, new FakeTmux());
    seedAgent(db);
    const result = await executeHibernateCommand({
      executor: orch,
      agentId: "worker-1",
      state: "idle",
      repoIdentifier: "extensions",
      policy: ENABLED,
    });
    expect(result.outcome).toBe("refused");
    expect(result.reason).toContain("checkpoint_unsafe:active_port_lease");
    expect(db.getAgentById("worker-1")?.lifecycleState).toBe("active");
    expect(proc.alive).toBe(true);
  });

  it("refuses a working agent via the orchestrator eligibility gate", async () => {
    const db = freshDb();
    const orch = buildOrch(db, new FakeProcess(), new FakeTmux());
    seedAgent(db);
    db.updateAgentStatus("worker-1", "working");
    const result = await executeHibernateCommand({
      executor: orch,
      agentId: "worker-1",
      state: "live",
      repoIdentifier: "extensions",
      policy: ENABLED,
    });
    expect(result).toMatchObject({ outcome: "refused", reason: "agent_working", retryable: true });
  });

  it("returns an unknown-target refusal without an agent", () => {
    expect(unknownHibernationTarget("hibernate", "@nope")).toMatchObject({
      outcome: "refused",
      reason: "unknown_target",
    });
  });
});

describe("executeWakeCommand — against the real orchestrator", () => {
  async function hibernate(db: BrokerDB, orch: HibernationOrchestrator): Promise<void> {
    orch.prepareHibernation("worker-1");
    const res = await orch.hibernate("worker-1");
    expect(res.ok).toBe(true);
    expect(db.getAgentById("worker-1")?.lifecycleState).toBe("hibernated");
  }

  it("wakes a hibernated identity, draining under a fresh runtime generation", async () => {
    const db = freshDb();
    const orch = buildOrch(db, new FakeProcess(), new FakeTmux());
    seedAgent(db);
    await hibernate(db, orch);
    const result = await executeWakeCommand({
      executor: orch,
      agentId: "worker-1",
      state: "hibernated",
      policy: ENABLED,
    });
    expect(result.outcome).toBe("executed");
    expect(result.state).toBe("live");
    expect(result.runtimeGeneration).toBeGreaterThanOrEqual(1);
  });

  it("is an idempotent no-op when the target is already awake", async () => {
    const db = freshDb();
    const orch = buildOrch(db, new FakeProcess(), new FakeTmux());
    seedAgent(db);
    const result = await executeWakeCommand({
      executor: orch,
      agentId: "worker-1",
      state: "live",
      policy: ENABLED,
    });
    expect(result).toMatchObject({ outcome: "noop", reason: "already_awake" });
  });

  it("surfaces a wake failure (stale fence) and quarantines fail-closed", async () => {
    const db = freshDb();
    const orch = buildOrch(db, new FakeProcess(), new FakeTmux(), "stale_fence");
    seedAgent(db);
    await hibernate(db, orch);
    const result = await executeWakeCommand({
      executor: orch,
      agentId: "worker-1",
      state: "hibernated",
      policy: ENABLED,
    });
    expect(result.outcome).toBe("refused");
    // Quarantine (reap-candidate) needs manual review, not a blind retry.
    expect(result.retryable).toBe(false);
    expect(result.detail).toContain("quarantined");
    expect(db.getAgentById("worker-1")?.lifecycleState).toBe("reap-candidate");
  });

  it("wakes even when hibernation is disabled (drain must not be stranded)", async () => {
    const db = freshDb();
    const orch = buildOrch(db, new FakeProcess(), new FakeTmux());
    seedAgent(db);
    await hibernate(db, orch);
    const result = await executeWakeCommand({
      executor: orch,
      agentId: "worker-1",
      state: "hibernated",
      policy: { enabled: false, mode: "observe", allowedRepos: [] },
    });
    expect(result.outcome).toBe("executed");
  });

  it("treats a concurrent in-flight wake as a benign no-op, not a retryable failure", async () => {
    const db = freshDb();
    const orch = buildOrch(db, new FakeProcess(), new FakeTmux());
    seedAgent(db);
    await hibernate(db, orch);
    // Another owner already holds the wake lease → this trigger loses the race.
    expect(
      db.acquireAgentLifecycleLease({
        agentId: "worker-1",
        operation: "wake",
        ownerBrokerInstanceId: "broker-2",
        leaseId: "other-wake",
        ttlMs: 90_000,
      }),
    ).not.toBeNull();

    const result = await executeWakeCommand({
      executor: orch,
      agentId: "worker-1",
      state: "hibernated",
      policy: ENABLED,
    });
    // Benign no-op: the in-flight wake will deliver queued work. Not a refused,
    // retryable failure — and the agent is left untouched (still hibernated).
    expect(result).toMatchObject({ outcome: "noop", reason: "wake_in_progress" });
    expect(result.retryable).toBeUndefined();
    expect(db.getAgentById("worker-1")?.lifecycleState).toBe("hibernated");
  });

  it("maps a non-wake lease contention to a distinct retryable refusal", async () => {
    const db = freshDb();
    const orch = buildOrch(db, new FakeProcess(), new FakeTmux());
    seedAgent(db);
    await hibernate(db, orch);
    // A lingering *hibernate* lease (not a wake) is held → nothing will drain the
    // inbox, so this must be a distinct retryable refusal, NOT a benign no-op.
    expect(
      db.acquireAgentLifecycleLease({
        agentId: "worker-1",
        operation: "hibernate",
        ownerBrokerInstanceId: "broker-2",
        leaseId: "hib-2",
        ttlMs: 90_000,
      }),
    ).not.toBeNull();

    const result = await executeWakeCommand({
      executor: orch,
      agentId: "worker-1",
      state: "hibernated",
      policy: ENABLED,
    });
    expect(result).toMatchObject({
      outcome: "refused",
      reason: "wake_lease_contended",
      retryable: true,
    });
    expect(db.getAgentById("worker-1")?.lifecycleState).toBe("hibernated");
  });
});
