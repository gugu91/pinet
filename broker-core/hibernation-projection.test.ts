import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerDB } from "./schema.js";
import {
  collectAgentLifecycleStatuses,
  isHibernationRelevantAgent,
} from "./hibernation-projection.js";
import { formatAgentLifecycleTag } from "./hibernation-status.js";
import type { AgentRuntimeSpecInput } from "./types.js";

const tempDirs: string[] = [];
function freshDb(): BrokerDB {
  const dir = mkdtempSync(join(tmpdir(), "pinet-hib-proj-"));
  tempDirs.push(dir);
  const db = new BrokerDB(join(dir, "broker.db"));
  db.initialize();
  return db;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const METADATA = {
  brokerManaged: true,
  brokerManagedBy: "broker-1",
  hibernateSafe: true,
  cwd: "/repo/wt",
  repoRoot: "/Users/secret/projects/extensions",
  worktreePath: "/repo/wt",
  tmuxSession: "worker-1",
};

function runtimeSpec(agentId: string, stableId: string): AgentRuntimeSpecInput {
  return {
    agentId,
    stableId,
    brokerOwnerId: "broker-1",
    cwd: "/repo/wt",
    repoRoot: "/Users/secret/projects/extensions",
    worktreePath: "/repo/wt",
    tmuxSocket: "/private/tmp/tmux-501/default",
    tmuxSession: "worker-1",
    tmuxTarget: "worker-1:0.0",
    executable: "/usr/local/bin/pi",
    argv: ["pi", "--model", "openai-codex/gpt-5.6-sol", "--secret-token", "SHOULD-NOT-LEAK"],
    envAllowlist: ["PI_MESH_SOCKET", "HOME"],
    sessionResumeRef: "session:abcdef123456",
    configFingerprint: "cfg-v1",
    expectedHost: "host-1",
    expectedUser: "tm",
    launchSource: "pinet-spawn",
    vcsIdentity: "gugu91/pinet",
  };
}

function seedHibernated(db: BrokerDB, id: string): void {
  const stableId = `host:session:${id}`;
  db.registerAgent(id, "Worker", "🦉", 4242, { ...METADATA }, stableId);
  db.setAgentHibernatePolicy(id, "manual");
  db.upsertAgentRuntimeSpec(runtimeSpec(id, stableId));
  const step = (
    expectedVersion: number,
    toState: "grace" | "idle" | "hibernating" | "hibernated",
  ) =>
    db.transitionAgentLifecycle({
      agentId: id,
      expectedVersion,
      toState,
      reason: "t",
      actor: "test",
      correlationId: `c-${id}-${toState}`,
    });
  step(0, "grace");
  step(1, "idle");
  step(2, "hibernating");
  db.recordAgentCheckpointReceipt({
    agentId: id,
    correlationId: "c1",
    reason: "manual",
    runtimeGeneration: 1,
    hibernateSafe: true,
    sessionResumeRef: "session:abcdef123456",
    pendingInboxCount: 0,
    rssBytes: 120_000_000,
  });
  step(3, "hibernated");
}

describe("collectAgentLifecycleStatuses", () => {
  it("projects only hibernation-relevant agents by default and redacts the runtime spec", () => {
    const db = freshDb();
    // A plain live agent should be excluded by default.
    db.registerAgent("live-1", "Live", "🐝", 1, { ...METADATA }, "host:session:live");
    seedHibernated(db, "worker-1");

    const statuses = collectAgentLifecycleStatuses(db);
    expect(statuses.map((s) => s.agentId)).toEqual(["worker-1"]);

    const status = statuses[0];
    expect(status.state).toBe("hibernated");
    expect(status.checkpoint.present).toBe(true);
    expect(status.runtimeSpec).not.toBeNull();
    // Redaction-by-construction: no argv/env/path leakage anywhere in the projection.
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("SHOULD-NOT-LEAK");
    expect(serialized).not.toContain("/Users/secret");
    expect(serialized).not.toContain("--model");
    // Repo is surfaced path-free (basename only).
    expect(status.runtimeSpec?.repo).toBe("extensions");
    expect(status.runtimeSpec?.session.hasPath).toBe(false);
  });

  it("includes bounded wake capacity counters when ceilings are provided", () => {
    const db = freshDb();
    seedHibernated(db, "worker-1");
    const [status] = collectAgentLifecycleStatuses(db, {
      maxConcurrentWakes: 2,
      maxConcurrentWakesPerRepo: 1,
    });
    expect(status.capacity).not.toBeNull();
    expect(status.capacity?.global.max).toBe(2);
    expect(status.capacity?.repo.max).toBe(1);
  });

  it("restricts to a requested agent id set", () => {
    const db = freshDb();
    seedHibernated(db, "worker-1");
    seedHibernated(db, "worker-2");
    const statuses = collectAgentLifecycleStatuses(db, { agentIds: ["worker-2"] });
    expect(statuses.map((s) => s.agentId)).toEqual(["worker-2"]);
  });

  it("surfaces a scannable, sanitized lifecycle tag", () => {
    const db = freshDb();
    seedHibernated(db, "worker-1");
    const [status] = collectAgentLifecycleStatuses(db);
    const tag = formatAgentLifecycleTag(status);
    expect(tag).toContain("hibernated");
    expect(tag).toContain("gen");
    expect(tag).toContain("ckpt");
    expect(tag).not.toContain("SHOULD-NOT-LEAK");
    expect(tag).not.toContain("/Users/secret");
  });

  it("classifies hibernation relevance by lifecycle state", () => {
    expect(isHibernationRelevantAgent({ lifecycleState: "hibernated" })).toBe(true);
    expect(isHibernationRelevantAgent({ lifecycleState: "reap-candidate" })).toBe(true);
    expect(isHibernationRelevantAgent({ lifecycleState: "live" })).toBe(false);
    expect(isHibernationRelevantAgent({ lifecycleState: undefined })).toBe(false);
  });
});
