// Focused proof for the Phase B live-runtime activation composition. Exercises
// the three seam functions against REAL dependencies — a real BrokerDB and a real
// throwaway git repo — never mocks-only, so the git-remote VCS identity, durable
// spec persistence, gate semantics, and stranded-wake reconciliation are all
// proven end to end at the composition layer. The materially real hibernate→wake
// through a live pi/tmux runtime is proven in `hibernation-activation.e2e.test.ts`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HibernationOrchestrator } from "@pinet/broker-core";
import type { AgentLifecycleState } from "@pinet/broker-core/types";
import { BrokerDB } from "./schema.js";
import {
  createHibernationOrchestrator,
  hibernationRuntimeActive,
  persistSpawnedRuntimeSpec,
  recoverStrandedWakesBeforeRegistrations,
  type SpawnRuntimeSpecFacts,
} from "./hibernation-activation.js";

const tempDirs: string[] = [];
function freshDb(): BrokerDB {
  const dir = mkdtempSync(join(tmpdir(), "pinet-hib-activation-"));
  tempDirs.push(dir);
  const db = new BrokerDB(join(dir, "broker.db"));
  db.initialize();
  return db;
}

/** A real git repo, optionally with an `origin` remote, for VCS identity derivation. */
function freshRepo(origin?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pinet-hib-repo-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function orchestrator(db: BrokerDB): HibernationOrchestrator {
  return createHibernationOrchestrator({
    db,
    brokerInstanceId: "broker-1",
    extensionEntryPath: "/opt/ext/index.js",
    baseLaunchEnv: {},
    inheritedEnvKeys: [],
  });
}

function specFacts(
  repoRoot: string,
  overrides: Partial<SpawnRuntimeSpecFacts> = {},
): SpawnRuntimeSpecFacts {
  return {
    agentId: "worker-1",
    stableId: `host-a:session:${join(repoRoot, "session.jsonl")}`,
    brokerOwnerId: "broker-1",
    cwd: repoRoot,
    repoRoot,
    worktreePath: repoRoot,
    tmuxSocket: "/private/tmp/tmux-501/default",
    tmuxSession: "worker-1",
    tmuxTarget: "worker-1:0.0",
    extensionEntryPath: "/opt/ext/index.js",
    envAllowlist: ["PI_SETTINGS_PATH", "PINET_MESH_SECRET"],
    configFingerprint: "cfg-1",
    expectedUser: "tm",
    launchSource: "subtree-broker-tmux",
    ...overrides,
  };
}

describe("hibernationRuntimeActive — default-off gate", () => {
  it("is false unless BOTH enabled and activateRuntimeAdapters are set", () => {
    expect(hibernationRuntimeActive({ enabled: false, activateRuntimeAdapters: false })).toBe(
      false,
    );
    expect(hibernationRuntimeActive({ enabled: true, activateRuntimeAdapters: false })).toBe(false);
    expect(hibernationRuntimeActive({ enabled: false, activateRuntimeAdapters: true })).toBe(false);
    expect(hibernationRuntimeActive({ enabled: true, activateRuntimeAdapters: true })).toBe(true);
  });
});

describe("createHibernationOrchestrator — composition", () => {
  it("composes a real orchestrator that satisfies the command-executor contract", () => {
    const db = freshDb();
    const orch = orchestrator(db);
    expect(orch).toBeInstanceOf(HibernationOrchestrator);
    // Structurally satisfies HibernateCommandExecutor & WakeCommandExecutor plus
    // the startup recovery entrypoint, so it drops into the executor slot.
    expect(typeof orch.prepareHibernation).toBe("function");
    expect(typeof orch.hibernate).toBe("function");
    expect(typeof orch.wake).toBe("function");
    expect(typeof orch.recoverStrandedWakes).toBe("function");
  });
});

describe("persistSpawnedRuntimeSpec — Seam 2 (durable spec + git-remote VCS identity)", () => {
  it("derives owner/repo from the real git remote and persists a readable spec", async () => {
    const db = freshDb();
    const repo = freshRepo("git@github.com:gugu91/extensions.git");
    db.registerAgent(
      "worker-1",
      "Worker",
      "🦉",
      4242,
      { brokerManaged: true },
      specFacts(repo).stableId,
    );

    const persisted = await persistSpawnedRuntimeSpec(db, specFacts(repo));
    expect(persisted).not.toBeNull();
    expect(persisted?.vcsIdentity).toBe("gugu91/extensions");

    const readBack = db.getAgentRuntimeSpec("worker-1");
    expect(readBack).not.toBeNull();
    // Authorization identity is the git-remote-derived owner/repo, NOT any dir name.
    expect(readBack?.vcsIdentity).toBe("gugu91/extensions");
    // Session resume ref + expected host are derived from the session stable id.
    expect(readBack?.sessionResumeRef).toBe(`session:${join(repo, "session.jsonl")}`);
    expect(readBack?.expectedHost).toBe("host-a");
    // Tmux locators + env allowlist NAMES (never values) round-trip.
    expect(readBack?.tmuxSocket).toBe("/private/tmp/tmux-501/default");
    expect(readBack?.tmuxTarget).toBe("worker-1:0.0");
    expect(readBack?.envAllowlist).toEqual(["PI_SETTINGS_PATH", "PINET_MESH_SECRET"]);
    expect(readBack?.argv).toEqual([
      "-e",
      "/opt/ext/index.js",
      "--session",
      join(repo, "session.jsonl"),
    ]);
  });

  it("fails closed to vcsIdentity=null when the repo has no resolvable remote", async () => {
    const db = freshDb();
    const repo = freshRepo(); // no origin
    db.registerAgent(
      "worker-1",
      "Worker",
      "🦉",
      4242,
      { brokerManaged: true },
      specFacts(repo).stableId,
    );

    const persisted = await persistSpawnedRuntimeSpec(db, specFacts(repo));
    expect(persisted).not.toBeNull();
    // Null identity is a fail-closed marker: the repo allowlist gate refuses it later.
    expect(persisted?.vcsIdentity).toBeNull();
    expect(db.getAgentRuntimeSpec("worker-1")?.vcsIdentity).toBeNull();
  });

  it("persists NOTHING when a durable locator is missing (empty tmux socket)", async () => {
    const db = freshDb();
    const repo = freshRepo("git@github.com:gugu91/extensions.git");
    db.registerAgent(
      "worker-1",
      "Worker",
      "🦉",
      4242,
      { brokerManaged: true },
      specFacts(repo).stableId,
    );

    const persisted = await persistSpawnedRuntimeSpec(db, specFacts(repo, { tmuxSocket: "" }));
    expect(persisted).toBeNull();
    expect(db.getAgentRuntimeSpec("worker-1")).toBeNull();
  });

  it("persists NOTHING for a non-session stable id (no resumable session)", async () => {
    const db = freshDb();
    const repo = freshRepo("git@github.com:gugu91/extensions.git");
    // `cwd`-kind stable id exposes a path but carries no resumable Pi session.
    const facts = specFacts(repo, { stableId: `host-a:cwd:${repo}` });
    db.registerAgent("worker-1", "Worker", "🦉", 4242, { brokerManaged: true }, facts.stableId);

    expect(await persistSpawnedRuntimeSpec(db, facts)).toBeNull();
    expect(db.getAgentRuntimeSpec("worker-1")).toBeNull();
  });
});

describe("recoverStrandedWakesBeforeRegistrations — Seam 3 (startup reconciliation)", () => {
  it("delegates to the orchestrator recovery and no-ops on a clean DB", () => {
    const db = freshDb();
    expect(recoverStrandedWakesBeforeRegistrations(orchestrator(db))).toEqual([]);
  });

  it("quarantines a real crash-stranded `waking` row to reap-candidate", () => {
    const db = freshDb();
    db.registerAgent(
      "worker-1",
      "Worker",
      "🦉",
      4242,
      { brokerManaged: true },
      "host-a:session:/tmp/s.jsonl",
    );

    // Walk the legal lifecycle into a stranded `waking` with NO held lease and no
    // accepted generation — exactly the shape a broker crash mid-wake leaves.
    const chain: AgentLifecycleState[] = ["grace", "idle", "hibernating", "hibernated", "waking"];
    for (const toState of chain) {
      const version = db.getAgentById("worker-1")?.lifecycleVersion ?? 0;
      db.transitionAgentLifecycle({
        agentId: "worker-1",
        expectedVersion: version,
        toState,
        reason: "seed",
        actor: "broker",
        correlationId: "seed",
      });
    }
    expect(db.getAgentById("worker-1")?.lifecycleState).toBe("waking");

    const recovered = recoverStrandedWakesBeforeRegistrations(orchestrator(db));
    expect(recovered).toEqual([{ agentId: "worker-1", action: "quarantined" }]);
    // Fail-closed: an uncertain runtime is never completed to `live`; it is parked
    // for manual review rather than risking a double launch.
    expect(db.getAgentById("worker-1")?.lifecycleState).toBe("reap-candidate");
  });
});
