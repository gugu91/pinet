import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLegalLifecycleTransition,
  evaluateHibernateEligibility,
  isLegalLifecycleTransition,
} from "./lifecycle.js";
import { BrokerDB } from "./schema.js";
import type { AgentInfo } from "./types.js";

function eligibleAgent(): AgentInfo {
  return {
    id: "worker-1",
    stableId: "stable",
    name: "Worker",
    emoji: "🦉",
    pid: 1,
    connectedAt: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-01-01T00:00:00.000Z",
    lastHeartbeat: "2026-01-01T00:00:00.000Z",
    status: "idle",
    hibernatePolicy: "manual",
    metadata: {
      brokerManaged: true,
      brokerManagedBy: "broker-1",
      hibernateSafe: true,
      cwd: "/repo/worktree",
      repoRoot: "/repo",
      worktreePath: "/repo/worktree",
      tmuxSession: "worker-1",
    },
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent hibernation lifecycle", () => {
  it("permits only explicit state-machine edges", () => {
    expect(isLegalLifecycleTransition("idle", "hibernating")).toBe(true);
    expect(isLegalLifecycleTransition("hibernated", "waking")).toBe(true);
    expect(isLegalLifecycleTransition("hibernated", "terminated")).toBe(false);
    expect(() => assertLegalLifecycleTransition("active", "hibernated")).toThrow(/Illegal/);
  });

  it("persists fenced CAS transitions and rejects simultaneous lease owners", () => {
    const dir = mkdtempSync(join(tmpdir(), "pinet-lifecycle-"));
    tempDirs.push(dir);
    const db = new BrokerDB(join(dir, "broker.db"));
    db.initialize();
    const agent = db.registerAgent(
      "worker-1",
      "Worker",
      "🦉",
      1,
      eligibleAgent().metadata ?? undefined,
      "stable",
    );
    const idle = db.transitionAgentLifecycle({
      agentId: agent.id,
      expectedVersion: 0,
      toState: "grace",
      reason: "free",
      actor: "broker",
      correlationId: "corr-1",
    });
    expect(idle.lifecycleVersion).toBe(1);
    expect(() =>
      db.transitionAgentLifecycle({
        agentId: agent.id,
        expectedVersion: 0,
        toState: "idle",
        reason: "stale",
        actor: "broker",
        correlationId: "corr-2",
      }),
    ).toThrow(/CAS conflict/);
    const lease = db.acquireAgentLifecycleLease({
      agentId: agent.id,
      operation: "wake",
      ownerBrokerInstanceId: "broker-a",
      leaseId: "lease-a",
      ttlMs: 90_000,
      now: 1_000,
    });
    expect(lease?.fenceToken).toBe(1);
    expect(
      db.acquireAgentLifecycleLease({
        agentId: agent.id,
        operation: "wake",
        ownerBrokerInstanceId: "broker-b",
        leaseId: "lease-b",
        ttlMs: 90_000,
        now: 2_000,
      }),
    ).toBeNull();
    expect(db.releaseAgentLifecycleLease(agent.id, "lease-a", 0)).toBe(false);
    expect(db.releaseAgentLifecycleLease(agent.id, "lease-a", 1)).toBe(true);
    db.close();
  });

  it("fails closed unless durable broker-managed safety evidence is complete", () => {
    expect(evaluateHibernateEligibility(eligibleAgent())).toEqual({
      eligible: true,
      reason: "eligible",
    });
    const unsafe = eligibleAgent();
    unsafe.metadata = { ...unsafe.metadata, hibernateSafe: false };
    expect(evaluateHibernateEligibility(unsafe)).toEqual({
      eligible: false,
      reason: "unsafe_or_unconfirmed",
    });
    const leaf = eligibleAgent();
    leaf.parentAgentId = "parent";
    expect(evaluateHibernateEligibility(leaf)).toEqual({
      eligible: false,
      reason: "supervised_subtree_unsupported",
    });
  });
});
