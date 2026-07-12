// Deterministic, CI-run PRODUCTION-ROUTE integration test for Phase B.
//
// This drives the SAME integration glue a live operator command takes, using the
// real production functions — no hand-reconstructed broker/registration/executor:
//
//   • the REAL `createSubtreeBrokerRuntime(deps).start(ctx)` (real leader lock +
//     real socket server + real self-agent registration + real pre-listen recovery),
//   • the REAL `runtime.getHibernationRuntimeControl()` authoritative-control accessor,
//   • the REAL, SHARED `routeHibernationCommand` — the exact function `index.ts`
//     `runHibernationCommand` delegates to — so a regression in DB-topology
//     resolution, executor composition, or the frozen-authority gate fails BOTH the
//     live extension and this test.
//
// It proves the four seams that must never silently regress, WITHOUT launching a
// process (so it is deterministic and CI-safe): the executed real-pi/tmux
// hibernate→wake lifecycle and the real `spawnWorker` child live in the opt-in
// `hibernation-activation.e2e.test.ts`.
//
//   (A) A crash-stranded `waking` row seeded into the subtree broker's authoritative
//       DB BEFORE start is reconciled inside `beforeListen` — proving durable
//       recovery runs before the socket accepts registrations, through the REAL
//       subtree start path (not a hand-wired `startBroker`).
//   (B) With a POPULATED, CONTRADICTORY central-DB decoy present, the router resolves
//       the target AND its authz spec identity from the authoritative SUBTREE control
//       DB only. If it read the central decoy, the outcomes below would differ.
//   (C) The repo allowlist is authorized from the DB-sourced spec identity, refusing
//       BEFORE any side effect; an allowlisted identity reaches the real executor.
//   (D) Activation is the durable, non-reloadable, frozen broker-start authority: a
//       later settings reload changes operational policy but a broker frozen OFF at
//       start can NEVER be elevated, and a broker frozen ON stays authoritative — and
//       the freeze happens via the REAL start path, with NO freeze-call surrogate.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentLifecycleState } from "@pinet/broker-core/types";
import {
  buildSubtreeBrokerPaths,
  createSubtreeBrokerRuntime,
  getExtensionEntryPath,
  SUBTREE_INHERITED_ENV_KEYS,
  type SubtreeBrokerRuntime,
  type SubtreeBrokerRuntimeDeps,
} from "../subtree-broker-runtime.js";
import { routeHibernationCommand } from "./hibernation-command-router.js";
import { hibernationRuntimeActive } from "./hibernation-activation.js";
import { __resetHibernationActivationAuthorityForTest } from "./hibernation-activation-authority.js";
import { buildRuntimeSpecInput } from "./hibernation-runtime-helpers.js";
import { BrokerDB } from "./schema.js";
import type { SlackBridgeSettings, PinetControlCommand } from "../helpers.js";
import { resolveHibernationSettings } from "../hibernation-config.js";

const ACTIVATION_ENV = "PINET_HIBERNATION_RUNTIME_ACTIVATION";
const ctx = {} as ExtensionContext;

// Per-test disposable resources, torn down in afterEach.
let runtimes: SubtreeBrokerRuntime[] = [];
let centralDbs: BrokerDB[] = [];
let subtreeRoots: string[] = [];
let tmpDirs: string[] = [];
let savedActivation: string | undefined;

// The subtree broker's stableId is sanitized into its on-disk root dir, and the
// unix socket path underneath it must stay under the macOS ~104-char limit, so keep
// it short. (Worker-agent stableIds, which need `host:session:<path>` format for
// their runtime specs, are separate and unaffected by the socket path length.)
function brokerStableId(tag: string): string {
  return `det-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeCentralDb(): BrokerDB {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hib-central-"));
  tmpDirs.push(dir);
  const db = new BrokerDB(path.join(dir, "central.db"));
  db.initialize();
  centralDbs.push(db);
  return db;
}

/** Minimal, fully-typed deps: none of the message/inbox callbacks fire in this test
 *  (no inbound messages), but the deps object must satisfy the real interface. */
function makeDeps(stableId: string, settings: SlackBridgeSettings): SubtreeBrokerRuntimeDeps {
  return {
    cwd: os.tmpdir(),
    getSettings: () => settings,
    getAgentStableId: () => stableId,
    getCentralAgentId: () => null,
    getAgentIdentity: () => ({ name: "Det", emoji: "🌳" }),
    getAgentMetadata: async () => ({}),
    getMeshRoleFromMetadata: (_metadata, fallback) => fallback ?? "worker",
    pushInboxMessages: () => {},
    updateBadge: () => {},
    maybeDrainInboxIfIdle: () => false,
    deliverSteeringMessage: () => false,
    requestRemoteControl: (command: PinetControlCommand) => ({
      currentCommand: null,
      queuedCommand: null,
      accepted: false,
      shouldStartNow: false,
      status: "covered",
      scheduledCommand: command,
      ackDisposition: "immediate",
    }),
    runRemoteControl: () => {},
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
  };
}

/** Start a real subtree broker after freezing the process activation authority via
 *  the REAL start path (env is set/unset by the caller; NO freeze-call surrogate). */
async function startRealSubtree(
  stableId: string,
  settings: SlackBridgeSettings,
): Promise<SubtreeBrokerRuntime> {
  const runtime = createSubtreeBrokerRuntime(makeDeps(stableId, settings));
  subtreeRoots.push(buildSubtreeBrokerPaths(stableId).rootDir);
  await runtime.start(ctx);
  runtimes.push(runtime);
  return runtime;
}

/** Seed a real crash-stranded `waking` row into a broker DB before it starts. */
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
    db.transitionAgentLifecycle({
      agentId,
      expectedVersion: db.getAgentById(agentId)?.lifecycleVersion ?? 0,
      toState,
      reason: "seed",
      actor: "broker",
      correlationId: "seed",
    });
  }
  db.close();
}

/** Register a broker-managed, hibernate-safe TOP-LEVEL worker (no parentAgentId, so
 *  it is NOT a supervised subtree child) with a DB-sourced runtime spec whose VCS
 *  identity is exactly `vcsIdentity`. Held `working` so the executor's real prepare
 *  gate refuses deterministically (no process launch) once the allowlist passes. */
function registerWorkerWithSpec(
  db: BrokerDB,
  input: { agentId: string; stableId: string; vcsIdentity: string; brokerOwnerId: string },
): void {
  db.registerAgent(
    input.agentId,
    "Worker",
    "🦉",
    4243,
    {
      brokerManaged: true,
      brokerManagedBy: input.brokerOwnerId,
      hibernateSafe: true,
      cwd: os.tmpdir(),
      repoRoot: os.tmpdir(),
      worktreePath: os.tmpdir(),
      tmuxSession: "det-session",
    },
    input.stableId,
  );
  db.setAgentHibernatePolicy(input.agentId, "manual");
  db.updateAgentStatus(input.agentId, "working");
  const spec = buildRuntimeSpecInput({
    agentId: input.agentId,
    stableId: input.stableId,
    brokerOwnerId: input.brokerOwnerId,
    cwd: os.tmpdir(),
    repoRoot: os.tmpdir(),
    worktreePath: os.tmpdir(),
    tmuxSocket: "/tmp/det-tmux.sock",
    tmuxSession: "det-session",
    tmuxTarget: "det-session",
    extensionEntryPath: getExtensionEntryPath(),
    envAllowlist: ["PI_SETTINGS_PATH"],
    configFingerprint: "det",
    expectedUser: os.userInfo().username,
    launchSource: "det",
    vcsIdentity: input.vcsIdentity,
  });
  if (!spec) throw new Error("failed to build runtime spec");
  db.upsertAgentRuntimeSpec(spec);
}

function settingsWith(
  hibernation: NonNullable<SlackBridgeSettings["hibernation"]>,
): SlackBridgeSettings {
  return { hibernation };
}

/** Route a hibernate through the EXACT shared production router index.ts delegates to. */
function routeHibernate(
  runtime: SubtreeBrokerRuntime,
  centralDb: BrokerDB,
  settings: SlackBridgeSettings,
  target: string,
) {
  return routeHibernationCommand({
    command: "hibernate",
    target,
    brokerRole: "broker",
    hib: resolveHibernationSettings(settings),
    getRuntimeControl: () => runtime.getHibernationRuntimeControl(),
    getFallbackDb: () => centralDb,
    extensionEntryPath: getExtensionEntryPath(),
    inheritedEnvKeys: SUBTREE_INHERITED_ENV_KEYS,
  });
}

beforeEach(() => {
  savedActivation = process.env[ACTIVATION_ENV];
  runtimes = [];
  centralDbs = [];
  subtreeRoots = [];
  tmpDirs = [];
  __resetHibernationActivationAuthorityForTest();
});

afterEach(async () => {
  for (const runtime of runtimes) {
    try {
      await runtime.stop({ releaseIdentity: true });
    } catch {
      /* best effort */
    }
  }
  for (const db of centralDbs) {
    try {
      db.close();
    } catch {
      /* best effort */
    }
  }
  for (const root of subtreeRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  if (savedActivation === undefined) delete process.env[ACTIVATION_ENV];
  else process.env[ACTIVATION_ENV] = savedActivation;
  __resetHibernationActivationAuthorityForTest();
});

describe("Phase B production-route (deterministic) — real subtree start + shared router", () => {
  it("recovers a stranded wake before listen and routes target+spec from the authoritative subtree DB despite a contradictory central decoy", async () => {
    // Activation ON via the REAL start freeze (env set BEFORE start; no surrogate).
    process.env[ACTIVATION_ENV] = "1";
    const stableId = brokerStableId("on");

    // (A) Seed a crash-stranded wake into THIS subtree broker's authoritative DB
    //     path BEFORE it starts, then prove real start reconciles it pre-listen.
    const paths = buildSubtreeBrokerPaths(stableId);
    fs.mkdirSync(paths.rootDir, { recursive: true });
    seedStrandedWaking(paths.dbPath, "stranded-1");

    const runtime = await startRealSubtree(
      stableId,
      settingsWith({ enabled: true, mode: "manual" }),
    );
    expect(hibernationRuntimeActive()).toBe(true);

    const control = runtime.getHibernationRuntimeControl();
    expect(control).not.toBeNull();
    const subtreeDb = control!.db;
    // Recovery ran inside beforeListen, on the authoritative subtree DB.
    expect(subtreeDb.getAgentById("stranded-1")?.lifecycleState).toBe("reap-candidate");

    // (B) Contradictory decoy: SAME agent id in a separate central fallback DB, but
    //     its spec identity is a DIFFERENT, deliberately-allowlisted repo. If the
    //     router read the central decoy, the outcomes below would flip.
    const centralDb = makeCentralDb();
    registerWorkerWithSpec(centralDb, {
      agentId: "worker-x",
      stableId: `${os.hostname()}:session:/tmp/central-x.jsonl`,
      vcsIdentity: "central/repo",
      brokerOwnerId: "central-broker",
    });

    // Authoritative subtree worker: same id, spec identity "sub/repo".
    registerWorkerWithSpec(subtreeDb, {
      agentId: "worker-x",
      stableId: `${os.hostname()}:session:/tmp/sub-x.jsonl`,
      vcsIdentity: "sub/repo",
      brokerOwnerId: control!.brokerInstanceId,
    });

    const subBefore = subtreeDb.getAgentById("worker-x")?.lifecycleState;
    const centralBefore = centralDb.getAgentById("worker-x")?.lifecycleState;

    // (C) Allowlist the CENTRAL decoy's identity only. The router reads the SUBTREE
    //     spec ("sub/repo"), which is NOT allowlisted → refuse BEFORE side effects.
    //     If it read the central decoy ("central/repo"), it would NOT refuse here.
    const denied = await routeHibernate(
      runtime,
      centralDb,
      settingsWith({ enabled: true, mode: "manual", allowedRepos: ["central/repo"] }),
      "worker-x",
    );
    expect(denied.outcome).toBe("refused");
    expect(denied.reason).toBe("repo_not_allowlisted");

    // Allowlist the SUBTREE identity: the gate now passes on the DB-sourced subtree
    // spec and reaches the REAL executor's prepare gate, which refuses `agent_working`
    // (no process launch). If it read the central decoy, "sub/repo" would be
    // un-allowlisted → `repo_not_allowlisted`, not `agent_working`.
    const reached = await routeHibernate(
      runtime,
      centralDb,
      settingsWith({ enabled: true, mode: "manual", allowedRepos: ["sub/repo"] }),
      "worker-x",
    );
    expect(reached.outcome).toBe("refused");
    expect(reached.reason).toBe("agent_working");

    // (B) No lifecycle mutation landed on EITHER DB (refusals are before side effects),
    //     and the central decoy was never read/mutated.
    expect(subtreeDb.getAgentById("worker-x")?.lifecycleState).toBe(subBefore);
    expect(centralDb.getAgentById("worker-x")?.lifecycleState).toBe(centralBefore);
  }, 30_000);

  it("keeps a broker frozen OFF at start un-elevatable by a later settings reload (real start freeze, no surrogate)", async () => {
    // Activation OFF via the REAL start freeze (env cleared BEFORE start).
    delete process.env[ACTIVATION_ENV];
    const stableId = brokerStableId("off");
    const settings = settingsWith({ enabled: false, mode: "observe" });
    const runtime = await startRealSubtree(stableId, settings);
    // The real start path performed the freeze reading the (absent) env: OFF.
    expect(hibernationRuntimeActive()).toBe(false);

    // The central fallback DB (used because authority is OFF) holds an allowlist-
    // matching worker + spec, so the only thing that can refuse the command is the
    // frozen-OFF `activation_pending` executor — never a policy gap.
    const centralDb = makeCentralDb();
    registerWorkerWithSpec(centralDb, {
      agentId: "worker-off",
      stableId: `${os.hostname()}:session:/tmp/off.jsonl`,
      vcsIdentity: "off/repo",
      brokerOwnerId: "central-broker",
    });

    // "Reload": mutate the live settings to the most permissive policy possible.
    settings.hibernation = { enabled: true, mode: "manual", allowedRepos: ["off/repo"] };

    const result = await routeHibernate(runtime, centralDb, settings, "worker-off");
    // Policy would allow it, target+spec resolve, allowlist passes — yet the executor
    // is still the `activation_pending` stub: a reload cannot elevate frozen-OFF.
    expect(result.outcome).toBe("refused");
    expect(result.reason).toBe("activation_pending");
    // And the direct authority read is still OFF after the reload.
    expect(hibernationRuntimeActive()).toBe(false);
  }, 30_000);

  it("keeps a broker frozen ON authoritative while a settings reload changes only operational policy", async () => {
    process.env[ACTIVATION_ENV] = "1";
    const stableId = brokerStableId("onpolicy");
    const settings = settingsWith({ enabled: true, mode: "manual", allowedRepos: ["sub/repo"] });
    const runtime = await startRealSubtree(stableId, settings);
    expect(hibernationRuntimeActive()).toBe(true);

    const control = runtime.getHibernationRuntimeControl();
    expect(control).not.toBeNull();
    registerWorkerWithSpec(control!.db, {
      agentId: "worker-on",
      stableId: `${os.hostname()}:session:/tmp/on.jsonl`,
      vcsIdentity: "sub/repo",
      brokerOwnerId: control!.brokerInstanceId,
    });

    const centralDb = makeCentralDb();

    // "Reload" flips operational policy OFF (enabled=false). Authority stays ON, so
    // routing still resolves the target from the SUBTREE control DB: the refusal is
    // `hibernation_disabled` (policy), NOT `unknown` (which a central-DB regression
    // would produce, since the central fallback has no such agent).
    settings.hibernation = { enabled: false, mode: "manual", allowedRepos: ["sub/repo"] };
    const result = await routeHibernate(runtime, centralDb, settings, "worker-on");
    expect(result.outcome).toBe("refused");
    expect(result.reason).toBe("hibernation_disabled");
    expect(hibernationRuntimeActive()).toBe(true);
  }, 30_000);
});
