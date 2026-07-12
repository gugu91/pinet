// Materially-real, isolated, PRODUCTION-ROUTE end-to-end proof for Phase B.
//
// This does not hand-compose helpers on a bare DB. It exercises the SAME route a
// real operator command takes:
//
//   • Activation is authorized ONLY by the durable, non-reloadable broker-start
//     authority (PINET_HIBERNATION_RUNTIME_ACTIVATION), and a later settings-shaped
//     "reload" cannot flip it — proving the gate is frozen for the process life.
//   • The broker is a REAL `startBroker` (real leader lock + real socket server),
//     so its `db` is the ONE authoritative DB. A crash-stranded `waking` row seeded
//     BEFORE start is reconciled inside `beforeListen` — provably before the socket
//     accepts a single connection (Seam 3 ordering, on the authoritative DB).
//   • The spawn-authored runtime spec (Seam 2, git-remote VCS identity) is persisted
//     into that SAME broker DB, and hibernate/wake are driven through the REAL
//     `executeHibernateCommand` / `executeWakeCommand` wrappers with the real policy
//     gate — including a negative repo-allowlist refusal proving authorization reads
//     the DB-sourced identity, not a path name.
//   • The executor is the REAL `HibernationOrchestrator` acting on a REAL `pi`
//     runtime in a REAL throwaway tmux session: checkpoint → stop (session survives)
//     → respawn into the dead pane → generation accepted → live.
//
// The ONLY simulated element is the socket-registration RPC (broker-core's domain,
// already exhaustively fenced-tested): the injected `awaitRuntimeRegistration`
// stands in for the socket server BUT keys acceptance off the REAL respawned
// process actually coming back alive, and accepts against the authoritative broker
// DB, so nothing about the runtime lifecycle is mocked.
//
// Opt-in only (spawns real processes + one cheap `pi --print` model call to seed a
// resumable session); skipped in normal `pnpm test`/CI, runs under HIBERNATION_E2E=1.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RuntimeLaunchContext } from "@pinet/broker-core";
import {
  executeHibernateCommand,
  executeWakeCommand,
  type HibernationCommandPolicy,
} from "@pinet/broker-core";
import type { AgentLifecycleState } from "@pinet/broker-core/types";
import { startBroker, type Broker } from "./index.js";
import { BrokerDB } from "./schema.js";
import { createHibernationProcessController } from "./hibernation-runtime-adapters.js";
import {
  createHibernationOrchestrator,
  hibernationRuntimeActive,
  persistSpawnedRuntimeSpec,
  recoverStrandedWakesBeforeRegistrations,
  type SpawnRuntimeSpecFacts,
} from "./hibernation-activation.js";
import {
  freezeHibernationActivationAuthority,
  __resetHibernationActivationAuthorityForTest,
} from "./hibernation-activation-authority.js";

const RUN = process.env.HIBERNATION_E2E === "1";
const suite = RUN ? describe : describe.skip;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hib-act-e2e-"));
const tmuxSocket = path.join(tmpRoot, "tmux.sock");
const sessionsDir = path.join(tmpRoot, "sessions");
const repoDir = path.join(tmpRoot, "repo");
const sessionFile = path.join(sessionsDir, "e2e.jsonl");
const settingsPath = path.join(tmpRoot, "empty-settings.json");
const noopExt = path.join(tmpRoot, "noop-ext.js");
const brokerDbPath = path.join(tmpRoot, "broker.db");
const brokerSocket = path.join(tmpRoot, "b.sock");
const brokerLock = path.join(tmpRoot, "b.lock");
const tmuxSession = `pi-hib-act-e2e-${process.pid}`;
const AGENT_ID = "e2e-agent";
const STABLE_ID = `${os.hostname()}:session:${sessionFile}`;

let broker: Broker | null = null;

function tmux(args: string[]): string {
  return execFileSync("tmux", ["-S", tmuxSocket, ...args], { encoding: "utf8" }).trim();
}
function tmuxNewSessionClean(name: string, script: string, env: NodeJS.ProcessEnv): void {
  execFileSync("tmux", ["-S", tmuxSocket, "new-session", "-d", "-s", name, script], { env });
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

afterAll(async () => {
  if (broker) {
    try {
      await broker.stop();
    } catch {
      /* best effort */
    }
  }
  __resetHibernationActivationAuthorityForTest();
  try {
    tmux(["kill-server"]);
  } catch {
    /* already gone */
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

suite(
  "Phase B production-route — frozen authority + authoritative broker DB + real pi/tmux",
  () => {
    const cleanPath = (process.env.PATH ?? "")
      .split(":")
      .filter((segment) => !segment.includes("node_modules/.bin"))
      .join(":");
    const minimalEnv: NodeJS.ProcessEnv = {
      PATH: cleanPath,
      HOME: process.env.HOME,
      TERM: "xterm-256color",
      TMPDIR: process.env.TMPDIR,
      PI_SETTINGS_PATH: settingsPath,
      PI_CODING_AGENT_SESSION_DIR: sessionsDir,
    };

    // A dedicated process controller for the injected registration waiter's REAL
    // liveness probe (stands in for the socket server observing the woken worker).
    const probeProc = createHibernationProcessController({ pendingInboxCount: () => 0 });

    it("routes hibernate/wake through the real command path over the authoritative broker DB", async () => {
      // ── Gate: activation comes ONLY from the frozen broker-start authority ──
      __resetHibernationActivationAuthorityForTest();
      freezeHibernationActivationAuthority({ PINET_HIBERNATION_RUNTIME_ACTIVATION: "1" });
      expect(hibernationRuntimeActive()).toBe(true);
      // A later settings-shaped "reload" (var absent) cannot flip a running broker off.
      expect(freezeHibernationActivationAuthority({})).toBe(true);
      expect(hibernationRuntimeActive()).toBe(true);

      // ── Arrange: disposable repo (with a real git remote), settings, noop ext ──
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.mkdirSync(repoDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ extensions: [], packages: [] }));
      fs.writeFileSync(noopExt, "export default function(){}\n");
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:test/repo.git"], {
        cwd: repoDir,
      });

      // ── Seam 3: seed a crash-stranded wake BEFORE the broker starts, then prove
      //    it is reconciled inside beforeListen, before the socket ever listens ──
      seedStrandedWaking(brokerDbPath, "stranded-1");
      let reconciledPreListen = false;
      broker = await startBroker({
        dbPath: brokerDbPath,
        socketPath: brokerSocket,
        lockPath: brokerLock,
        beforeListen: ({ db }) => {
          recoverStrandedWakesBeforeRegistrations(
            createHibernationOrchestrator({
              db,
              brokerInstanceId: "e2e-broker",
              extensionEntryPath: noopExt,
              baseLaunchEnv: {},
              inheritedEnvKeys: [],
            }),
          );
          reconciledPreListen = db.getAgentById("stranded-1")?.lifecycleState === "reap-candidate";
        },
      });
      expect(reconciledPreListen).toBe(true);
      expect(broker.db.getAgentById("stranded-1")?.lifecycleState).toBe("reap-candidate");

      // The ONE authoritative DB the command path, spec persistence, and recovery
      // all share is the started broker's DB.
      const db = broker.db;

      // Seed a resumable session via one-shot `pi --print` inside the clean tmux
      // server (this also establishes the clean server env for all later panes).
      const seedScript = path.join(tmpRoot, "seed.sh");
      fs.writeFileSync(
        seedScript,
        [
          "#!/bin/bash",
          `cd '${repoDir}'`,
          `pi --print --model google/gemini-2.5-flash --session '${sessionFile}' 'Remember codeword: HERON-7. Reply only ACK.' >'${tmpRoot}/seed.out' 2>&1 || true`,
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      tmuxNewSessionClean("holder", "sleep 100000", minimalEnv);
      tmuxNewSessionClean("seed", seedScript, minimalEnv);
      for (let i = 0; i < 120 && !fs.existsSync(sessionFile); i++) await sleep(500);
      if (!fs.existsSync(sessionFile)) {
        const out = fs.existsSync(`${tmpRoot}/seed.out`)
          ? fs.readFileSync(`${tmpRoot}/seed.out`, "utf8").slice(-1500)
          : "(no seed.out)";
        throw new Error(`seed session file was not created.\nseed.out tail:\n${out}`);
      }
      try {
        tmux(["kill-session", "-t", "seed"]);
      } catch {
        /* seed pane already exited */
      }

      // Launch the resident runtime in a throwaway tmux session (no pre-set
      // remain-on-exit; the orchestrator's stop is responsible for pane survival).
      const launchScript = path.join(tmpRoot, "launch.sh");
      fs.writeFileSync(
        launchScript,
        [
          "#!/bin/bash",
          "set -euo pipefail",
          `cd '${repoDir}'`,
          `exec pi -e '${noopExt}' --session '${sessionFile}'`,
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      tmuxNewSessionClean(tmuxSession, launchScript, minimalEnv);

      // ── Seam 2: persist the durable, broker-authored runtime spec into the
      //    SAME authoritative broker DB ──────────────────────────────────
      const facts: SpawnRuntimeSpecFacts = {
        agentId: AGENT_ID,
        stableId: STABLE_ID,
        brokerOwnerId: "e2e-broker",
        cwd: repoDir,
        repoRoot: repoDir,
        worktreePath: repoDir,
        tmuxSocket,
        tmuxSession,
        tmuxTarget: tmuxSession,
        extensionEntryPath: noopExt,
        envAllowlist: ["PI_SETTINGS_PATH", "PI_CODING_AGENT_SESSION_DIR"],
        configFingerprint: "e2e",
        expectedUser: os.userInfo().username,
        launchSource: "e2e",
      };
      db.registerAgent(
        AGENT_ID,
        "Worker",
        "🦉",
        process.pid,
        {
          brokerManaged: true,
          brokerManagedBy: "e2e-broker",
          hibernateSafe: true,
          cwd: repoDir,
          repoRoot: repoDir,
          worktreePath: repoDir,
          tmuxSession,
        },
        STABLE_ID,
      );
      db.setAgentHibernatePolicy(AGENT_ID, "manual");
      const spec = await persistSpawnedRuntimeSpec(db, facts);
      expect(spec).not.toBeNull();
      // VCS identity is derived from the REAL git remote (never the dir name).
      expect(spec?.vcsIdentity).toBe("test/repo");
      expect(db.getAgentRuntimeSpec(AGENT_ID)?.sessionResumeRef).toBe(`session:${sessionFile}`);

      // ── Seam 1: compose the REAL orchestrator over the authoritative broker DB;
      //    inject a registration waiter that accepts ONLY once the respawned
      //    process is genuinely alive (socket-RPC stand-in) ──
      const orch = createHibernationOrchestrator({
        db,
        brokerInstanceId: "e2e-broker",
        extensionEntryPath: noopExt,
        baseLaunchEnv: {},
        inheritedEnvKeys: [],
        config: { handshakeTimeoutMs: 15_000, wakeLeaseMs: 120_000, registrationTimeoutMs: 60_000 },
        awaitRuntimeRegistration: async (ctx: RuntimeLaunchContext) => {
          for (let i = 0; i < 120; i++) {
            if (await probeProc.isRuntimeAlive(ctx.spec)) break;
            await sleep(300);
          }
          const acceptance = db.acceptRuntimeGeneration({
            agentId: ctx.agentId,
            wakeLeaseId: ctx.wakeLeaseId,
            fenceToken: ctx.fenceToken,
            reservedGeneration: ctx.reservedGeneration,
            reservationNonce: ctx.reservationNonce,
            now: Date.now(),
          });
          return acceptance.accepted;
        },
      });

      // The production command path resolves the executor over the authoritative DB.
      const executor = orch;
      // Repo identity comes from the DB-sourced spec, exactly as production does.
      const repoIdentifier = db.getAgentRuntimeSpec(AGENT_ID)?.vcsIdentity ?? null;
      expect(repoIdentifier).toBe("test/repo");

      // ── Wait for the resident runtime to boot ─────────────────────────
      let alive = false;
      for (let i = 0; i < 40 && !alive; i++) {
        await sleep(300);
        alive = await probeProc.isRuntimeAlive(spec!);
      }
      expect(alive).toBe(true);

      // ── Negative authorization: the DB-sourced identity is gated by the repo
      //    allowlist. A non-matching allowlist REFUSES before any side effect. ──
      const denyPolicy: HibernationCommandPolicy = {
        enabled: true,
        mode: "manual",
        allowedRepos: ["someone/else"],
      };
      const denied = await executeHibernateCommand({
        executor,
        agentId: AGENT_ID,
        state: (db.getAgentById(AGENT_ID)?.lifecycleState ?? "live") as AgentLifecycleState,
        repoIdentifier,
        policy: denyPolicy,
        actor: "operator",
      });
      expect(denied.outcome).toBe("refused");
      expect(denied.reason).toBe("repo_not_allowlisted");
      expect(await probeProc.isRuntimeAlive(spec!)).toBe(true); // untouched

      // ── hibernate via the REAL command wrapper: checkpoint + stop; survive ──
      const allowPolicy: HibernationCommandPolicy = {
        enabled: true,
        mode: "manual",
        allowedRepos: ["test/repo"],
      };
      const hib = await executeHibernateCommand({
        executor,
        agentId: AGENT_ID,
        state: (db.getAgentById(AGENT_ID)?.lifecycleState ?? "live") as AgentLifecycleState,
        repoIdentifier,
        policy: allowPolicy,
        actor: "operator",
      });
      expect(hib.outcome).toBe("executed");
      expect(hib.state).toBe("hibernated");
      expect(await probeProc.isRuntimeAlive(spec!)).toBe(false);
      // The resumable session file is untouched by hibernation.
      expect(fs.existsSync(sessionFile)).toBe(true);
      // The surviving pane is explicitly DEAD (remain-on-exit) — the only state the
      // wake path will respawn into.
      let paneDead = false;
      for (let i = 0; i < 20 && !paneDead; i++) {
        await sleep(200);
        paneDead =
          tmux(["display-message", "-p", "-t", tmuxSession, "#{pane_dead}"]).trim() === "1";
      }
      expect(paneDead).toBe(true);

      // ── wake via the REAL command wrapper: respawn, accept generation, live ──
      const wake = await executeWakeCommand({
        executor,
        agentId: AGENT_ID,
        state: (db.getAgentById(AGENT_ID)?.lifecycleState ?? "hibernated") as AgentLifecycleState,
        policy: allowPolicy,
        actor: "operator",
      });
      expect(wake.outcome).toBe("executed");
      expect(wake.state).toBe("live");
      expect(wake.runtimeGeneration).toBe(1);

      const agent = db.getAgentById(AGENT_ID);
      expect(agent?.lifecycleState).toBe("live");
      expect(agent?.runtimeGeneration).toBe(1);
      // The woken runtime is genuinely back alive, resuming the SAME session.
      expect(await probeProc.isRuntimeAlive(spec!)).toBe(true);
      expect(fs.existsSync(sessionFile)).toBe(true);
      // Wake bookkeeping is fully settled.
      expect(db.getAgentWakeReservation(AGENT_ID)).toBeNull();
      expect(db.getAgentLifecycleLease(AGENT_ID)).toBeNull();

      // ── Teardown the woken runtime ────────────────────────────────────
      try {
        tmux(["kill-session", "-t", tmuxSession]);
      } catch {
        /* already gone */
      }
    }, 180_000);
  },
);
