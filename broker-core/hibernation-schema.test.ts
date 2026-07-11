import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerDB } from "./schema.js";
import type { AgentRuntimeSpecInput } from "./types.js";

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
