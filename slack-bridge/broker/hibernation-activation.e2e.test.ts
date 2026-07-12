// Materially-real, isolated, PRODUCTION-ROUTE end-to-end proof for Phase B — the
// real-process half. The deterministic, CI-run half lives in
// `hibernation-production-route.test.ts` (assertions 1–5: shared-router routing,
// authoritative subtree-DB topology vs a contradictory central decoy, pre-listen
// recovery ordering, frozen non-reloadable activation authority, and DB-sourced
// allowlist identity). This file adds the two assertions that REQUIRE real OS
// processes, and drives them through the exact same production integration glue a
// live operator command takes — NOT a hand-composed broker/orchestrator:
//
//   • the REAL `createSubtreeBrokerRuntime(deps).start(ctx)` (real leader lock +
//     real socket server + real self-agent registration + real pre-listen recovery),
//   • the REAL `runtime.getHibernationRuntimeControl()` authoritative control, and
//   • the REAL, SHARED `routeHibernationCommand` that `index.ts` delegates to.
//
//   (6) SUPERVISED-CHILD REFUSAL, end to end: a REAL `spawnWorker` launches a REAL
//       child `pi` that boots the REAL slack-bridge follower and registers itself
//       against the subtree broker as a supervised subtree child; `spawnWorker`
//       persists its durable runtime spec into the authoritative subtree DB. The
//       shared router then refuses it — `policy_never` at the default policy, and,
//       once the policy is deliberately elevated to isolate the guard,
//       `supervised_subtree_unsupported` — and the child stays alive and untouched.
//
//   (7) TOP-LEVEL HIBERNATE→WAKE, end to end: an eligible top-level broker-managed
//       worker (a REAL resumable `pi` in a REAL throwaway tmux session, spec
//       persisted into the SAME authoritative subtree DB) is hibernated and woken
//       THROUGH the shared router / real orchestrator: checkpoint → stop (pane
//       survives, explicitly DEAD) → respawn into the dead pane → generation
//       accepted → live, plus a negative repo-allowlist refusal proving
//       authorization reads the DB-sourced VCS identity, not a path name. A
//       crash-stranded `waking` row seeded before start is reconciled by the real
//       subtree pre-listen recovery.
//
// The ONLY simulated element is the socket-registration RPC (broker-core's domain,
// exhaustively fenced-tested): the injected `awaitRuntimeRegistration` stands in
// for the socket server BUT keys acceptance off the REAL respawned process being
// alive, accepting against the authoritative subtree DB, so nothing about the
// runtime lifecycle is mocked.
//
// Opt-in only (spawns real processes + one cheap `pi --print` model call to seed a
// resumable session); skipped in normal `pnpm test`/CI, runs under HIBERNATION_E2E=1.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuntimeLaunchContext } from "@pinet/broker-core";
import type { AgentLifecycleState } from "@pinet/broker-core/types";
import { BrokerDB } from "./schema.js";
import { createHibernationProcessController } from "./hibernation-runtime-adapters.js";
import {
  hibernationRuntimeActive,
  persistSpawnedRuntimeSpec,
  type SpawnRuntimeSpecFacts,
} from "./hibernation-activation.js";
import { __resetHibernationActivationAuthorityForTest } from "./hibernation-activation-authority.js";
import { routeHibernationCommand } from "./hibernation-command-router.js";
import { resolveHibernationSettings } from "../hibernation-config.js";
import {
  buildSubtreeBrokerPaths,
  createSubtreeBrokerRuntime,
  getExtensionEntryPath,
  SUBTREE_INHERITED_ENV_KEYS,
  type SubtreeBrokerRuntime,
  type SubtreeBrokerRuntimeDeps,
} from "../subtree-broker-runtime.js";
import type { SlackBridgeSettings, PinetControlCommand } from "../helpers.js";

const RUN = process.env.HIBERNATION_E2E === "1";
const suite = RUN ? describe : describe.skip;
const ctx = {} as ExtensionContext;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a spawned worker's REAL tmux pane PID + dead flag, via the SAME tmux socket
 *  the subtree broker launched it on (parsed from the spawn result's monitor
 *  command, e.g. `tmux -S '<socket>' attach -t '<session>'`). This is direct
 *  process evidence — DB lifecycle state alone is insufficient to prove the child
 *  was untouched/alive across a refusal. */
function readWorkerPane(
  monitorCommand: string,
  sessionName: string,
): { pid: string; dead: string } {
  const socketMatch = monitorCommand.match(/tmux\s+-S\s+'([^']+)'/);
  const socketArgs = socketMatch ? ["-S", socketMatch[1]] : [];
  const out = execFileSync(
    "tmux",
    [...socketArgs, "display-message", "-p", "-t", sessionName, "#{pane_pid} #{pane_dead}"],
    { encoding: "utf8" },
  ).trim();
  const [pid, dead] = out.split(/\s+/);
  return { pid, dead };
}

/** Minimal, fully-typed subtree deps: the inbox/steering callbacks never fire (no
 *  inbound traffic beyond the child's own registration in test 6). */
function makeDeps(stableId: string, settings: SlackBridgeSettings): SubtreeBrokerRuntimeDeps {
  return {
    cwd: os.tmpdir(),
    getSettings: () => settings,
    getAgentStableId: () => stableId,
    getCentralAgentId: () => null,
    getAgentIdentity: () => ({ name: "E2E", emoji: "🌳" }),
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

const ENV_KEYS = [
  "PINET_HIBERNATION_RUNTIME_ACTIVATION",
  "PI_CODING_AGENT_DIR",
  "PI_OFFLINE",
  "PI_SETTINGS_PATH",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
] as const;

suite(
  "Phase B production-route real pi/tmux — supervised-child refusal + top-level hibernate/wake",
  () => {
    let savedEnv: Record<string, string | undefined> = {};
    const disposers: Array<() => void | Promise<void>> = [];

    beforeEach(() => {
      savedEnv = {};
      for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
      __resetHibernationActivationAuthorityForTest();
    });

    afterEach(async () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose();
        } catch {
          /* best effort */
        }
      }
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      __resetHibernationActivationAuthorityForTest();
    });

    function trackRuntime(runtime: SubtreeBrokerRuntime, stableId: string): void {
      disposers.push(() => runtime.stop({ releaseIdentity: true, stopChildren: true }));
      disposers.push(() =>
        fs.rmSync(buildSubtreeBrokerPaths(stableId).rootDir, { recursive: true, force: true }),
      );
    }

    // ── Assertion 6 ──────────────────────────────────────────────────────────
    it("routes a REAL supervised spawnWorker child to supervised_subtree_unsupported and leaves it alive", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hib-e2e6-"));
      disposers.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
      // Isolated agent dir so the child pi does NOT auto-load the globally-installed
      // slack-bridge package (which would conflict with the `-e` worktree slack-bridge
      // and abort the child). Offline + fake Slack tokens so the child never touches a
      // real model or a real Slack workspace: it only needs to boot + register as a
      // broker-managed follower and stay alive.
      const agentDir = path.join(tmp, "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const settingsPath = path.join(agentDir, "settings.json");
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          lastChangelogVersion: "999.0.0",
          defaultProjectTrust: "trusted",
          extensions: [],
          packages: [],
        }),
      );
      const repoDir = path.join(tmp, "repo");
      fs.mkdirSync(repoDir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:test/repo.git"], {
        cwd: repoDir,
      });

      process.env.PINET_HIBERNATION_RUNTIME_ACTIVATION = "1";
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_OFFLINE = "1";
      process.env.PI_SETTINGS_PATH = settingsPath;
      process.env.SLACK_BOT_TOKEN = "xoxb-e2e-fake";
      process.env.SLACK_APP_TOKEN = "xapp-e2e-fake";
      __resetHibernationActivationAuthorityForTest();

      const stableId = `e2e6-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
      const settings: SlackBridgeSettings = {
        hibernation: { enabled: true, mode: "manual", allowedRepos: ["test/repo"] },
      };
      const runtime = createSubtreeBrokerRuntime(makeDeps(stableId, settings));
      trackRuntime(runtime, stableId);
      await runtime.start(ctx);
      expect(hibernationRuntimeActive()).toBe(true);

      // A REAL child pi boots, loads the REAL slack-bridge follower, and registers
      // itself against the subtree broker as a supervised subtree child.
      const result = await runtime.spawnWorker(ctx, {
        task: "E2E supervised-child: idle and wait.",
        repo: repoDir,
        waitForRegistrationMs: 90_000,
      });
      const control = runtime.getHibernationRuntimeControl();
      expect(control).not.toBeNull();
      const child = control!.db.getAgentById(result.agentId);
      expect(child).toBeTruthy();
      expect(child?.parentAgentId).toBe(`subbroker-${stableId}`);
      expect(child?.supervisionState).toBe("supervised");
      // spawnWorker persisted the child's durable spec into the authoritative subtree DB.
      expect(control!.db.getAgentRuntimeSpec(result.agentId)?.vcsIdentity).toBe("test/repo");

      // Capture the child's REAL tmux pane PID + liveness BEFORE any refusal, so we
      // can prove the PROCESS (not just the DB row) is untouched and alive after both.
      const paneBefore = readWorkerPane(result.monitorCommand, result.sessionName);
      expect(paneBefore.dead).toBe("0");
      expect(Number(paneBefore.pid)).toBeGreaterThan(0);
      const genBefore = control!.db.getAgentById(result.agentId)?.runtimeGeneration ?? null;

      const routeChild = (target: string) =>
        routeHibernationCommand({
          command: "hibernate",
          target,
          brokerRole: "broker",
          hib: resolveHibernationSettings(settings),
          getRuntimeControl: () => runtime.getHibernationRuntimeControl(),
          getFallbackDb: () => null,
          extensionEntryPath: getExtensionEntryPath(),
          inheritedEnvKeys: SUBTREE_INHERITED_ENV_KEYS,
        });

      // Default policy: a spawned child is non-hibernatable — refuse policy_never.
      const byDefault = await routeChild(result.agentId);
      expect(byDefault.outcome).toBe("refused");
      expect(byDefault.reason).toBe("policy_never");
      // The child PROCESS is untouched: same pane PID, still alive (pane_dead=0).
      const paneAfterDefault = readWorkerPane(result.monitorCommand, result.sessionName);
      expect(paneAfterDefault.pid).toBe(paneBefore.pid);
      expect(paneAfterDefault.dead).toBe("0");

      // Elevate the policy to ISOLATE the supervised guard: even a policy-permitted,
      // allowlisted supervised child is still refused, purely because it is supervised.
      control!.db.setAgentHibernatePolicy(result.agentId, "manual");
      const supervised = await routeChild(result.agentId);
      expect(supervised.outcome).toBe("refused");
      expect(supervised.reason).toBe("supervised_subtree_unsupported");
      // Still the SAME live pane PID after the second refusal — no stop/respawn happened.
      const paneAfterSupervised = readWorkerPane(result.monitorCommand, result.sessionName);
      expect(paneAfterSupervised.pid).toBe(paneBefore.pid);
      expect(paneAfterSupervised.dead).toBe("0");

      // And the DB row is likewise untouched: still live, still connected, generation
      // unchanged (no wake/respawn was performed).
      const after = control!.db.getAgentById(result.agentId);
      expect(after?.lifecycleState).toBe("live");
      expect(after?.disconnectedAt ?? null).toBeNull();
      expect(after?.runtimeGeneration ?? null).toBe(genBefore);
    }, 180_000);

    // ── Assertion 7 (+ pre-listen recovery + negative allowlist) ───────────────
    it("hibernates and wakes an eligible top-level worker through the shared router over the authoritative subtree DB", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hib-e2e7-"));
      disposers.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
      const tmuxSocket = path.join(tmp, "tmux.sock");
      const sessionsDir = path.join(tmp, "sessions");
      const repoDir = path.join(tmp, "repo");
      const sessionFile = path.join(sessionsDir, "e2e.jsonl");
      const settingsPath = path.join(tmp, "empty-settings.json");
      const noopExt = path.join(tmp, "noop-ext.js");
      const tmuxSession = `pi-hib-e2e7-${process.pid}`;
      const AGENT_ID = "e2e-top-worker";
      const STABLE_ID = `${os.hostname()}:session:${sessionFile}`;
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.mkdirSync(repoDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ extensions: [], packages: [] }));
      fs.writeFileSync(noopExt, "export default function(){}\n");
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:test/repo.git"], {
        cwd: repoDir,
      });

      const tmux = (args: string[]): string =>
        execFileSync("tmux", ["-S", tmuxSocket, ...args], { encoding: "utf8" }).trim();
      disposers.push(() => {
        try {
          tmux(["kill-server"]);
        } catch {
          /* already gone */
        }
      });

      // Activation ON only; NO agent-dir isolation / offline (the seed needs a real
      // model), and NO Slack tokens (so the resident/woken global slack-bridge no-ops).
      process.env.PINET_HIBERNATION_RUNTIME_ACTIVATION = "1";
      delete process.env.PI_CODING_AGENT_DIR;
      delete process.env.PI_OFFLINE;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_APP_TOKEN;
      process.env.PI_SETTINGS_PATH = settingsPath;
      __resetHibernationActivationAuthorityForTest();

      const minimalEnv: NodeJS.ProcessEnv = {
        PATH: (process.env.PATH ?? "")
          .split(":")
          .filter((segment) => !segment.includes("node_modules/.bin"))
          .join(":"),
        HOME: process.env.HOME,
        TERM: "xterm-256color",
        TMPDIR: process.env.TMPDIR,
        PI_SETTINGS_PATH: settingsPath,
        PI_CODING_AGENT_SESSION_DIR: sessionsDir,
      };
      const tmuxNewSessionClean = (name: string, script: string): void => {
        execFileSync("tmux", ["-S", tmuxSocket, "new-session", "-d", "-s", name, script], {
          env: minimalEnv,
        });
      };

      // Seam 3: seed a crash-stranded wake into the subtree DB path BEFORE start, then
      // prove the REAL subtree pre-listen recovery reconciled it. The SUBTREE broker's
      // stableId is sanitized into its unix socket path, which must stay under the
      // macOS ~104-char limit, so keep it short — distinct from the worker's
      // session-format STABLE_ID (which only feeds the runtime spec's resume ref).
      const stableId = `e2e7-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
      const paths = buildSubtreeBrokerPaths(stableId);
      fs.mkdirSync(paths.rootDir, { recursive: true });
      seedStrandedWaking(paths.dbPath, "stranded-1");

      const settings: SlackBridgeSettings = {
        hibernation: { enabled: true, mode: "manual", allowedRepos: ["test/repo"] },
      };
      const runtime = createSubtreeBrokerRuntime(makeDeps(stableId, settings));
      trackRuntime(runtime, stableId);
      await runtime.start(ctx);
      const control = runtime.getHibernationRuntimeControl();
      expect(control).not.toBeNull();
      const db = control!.db;
      expect(db.getAgentById("stranded-1")?.lifecycleState).toBe("reap-candidate");

      // A dedicated process controller for the injected registration waiter's REAL
      // liveness probe (stands in for the socket server observing the woken worker).
      const probeProc = createHibernationProcessController({ pendingInboxCount: () => 0 });

      // Seed a resumable session via one-shot `pi --print` inside the clean tmux server.
      const seedScript = path.join(tmp, "seed.sh");
      fs.writeFileSync(
        seedScript,
        [
          "#!/bin/bash",
          `cd '${repoDir}'`,
          `pi --print --model google/gemini-2.5-flash --session '${sessionFile}' 'Remember codeword: HERON-7. Reply only ACK.' >'${tmp}/seed.out' 2>&1 || true`,
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      tmuxNewSessionClean("holder", "sleep 100000");
      tmuxNewSessionClean("seed", seedScript);
      for (let i = 0; i < 120 && !fs.existsSync(sessionFile); i++) await sleep(500);
      if (!fs.existsSync(sessionFile)) {
        const out = fs.existsSync(`${tmp}/seed.out`)
          ? fs.readFileSync(`${tmp}/seed.out`, "utf8").slice(-1500)
          : "(none)";
        throw new Error(`seed session file was not created.\nseed.out tail:\n${out}`);
      }
      try {
        tmux(["kill-session", "-t", "seed"]);
      } catch {
        /* seed pane already exited */
      }

      // Launch the resident runtime (a real pi) in a throwaway tmux session.
      const launchScript = path.join(tmp, "launch.sh");
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
      tmuxNewSessionClean(tmuxSession, launchScript);

      // Register the eligible TOP-LEVEL broker-managed worker (no parentAgentId) and
      // persist its durable, broker-authored runtime spec into the SAME authoritative
      // subtree DB the shared router resolves against.
      db.registerAgent(
        AGENT_ID,
        "Worker",
        "🦉",
        process.pid,
        {
          brokerManaged: true,
          brokerManagedBy: control!.brokerInstanceId,
          hibernateSafe: true,
          cwd: repoDir,
          repoRoot: repoDir,
          worktreePath: repoDir,
          tmuxSession,
        },
        STABLE_ID,
      );
      db.setAgentHibernatePolicy(AGENT_ID, "manual");
      const facts: SpawnRuntimeSpecFacts = {
        agentId: AGENT_ID,
        stableId: STABLE_ID,
        brokerOwnerId: control!.brokerInstanceId,
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
      const spec = await persistSpawnedRuntimeSpec(db, facts);
      expect(spec).not.toBeNull();
      expect(spec?.vcsIdentity).toBe("test/repo");
      expect(db.getAgentRuntimeSpec(AGENT_ID)?.sessionResumeRef).toBe(`session:${sessionFile}`);

      // Wait for the resident runtime to boot.
      let alive = false;
      for (let i = 0; i < 40 && !alive; i++) {
        await sleep(300);
        alive = await probeProc.isRuntimeAlive(spec!);
      }
      expect(alive).toBe(true);

      // The injected socket-registration stand-in: accept the woken generation ONLY
      // once the REAL respawned process is alive, against the authoritative subtree DB.
      const awaitRuntimeRegistration = async (launch: RuntimeLaunchContext): Promise<boolean> => {
        for (let i = 0; i < 120; i++) {
          if (await probeProc.isRuntimeAlive(launch.spec)) break;
          await sleep(300);
        }
        return db.acceptRuntimeGeneration({
          agentId: launch.agentId,
          wakeLeaseId: launch.wakeLeaseId,
          fenceToken: launch.fenceToken,
          reservedGeneration: launch.reservedGeneration,
          reservationNonce: launch.reservationNonce,
          now: Date.now(),
        }).accepted;
      };
      const route = (command: "hibernate" | "wake", allowedRepos: string[]) =>
        routeHibernationCommand({
          command,
          target: AGENT_ID,
          brokerRole: "broker",
          hib: resolveHibernationSettings({
            hibernation: { enabled: true, mode: "manual", allowedRepos },
          } satisfies SlackBridgeSettings),
          getRuntimeControl: () => runtime.getHibernationRuntimeControl(),
          getFallbackDb: () => null,
          // The router respawns the woken worker with `pi -e <extensionEntryPath>`; the
          // resident/woken process here is the cheap noop ext (the process to
          // checkpoint/respawn), exactly as production passes its own entry path.
          extensionEntryPath: noopExt,
          inheritedEnvKeys: SUBTREE_INHERITED_ENV_KEYS,
          awaitRuntimeRegistration,
        });

      // Negative authorization: a non-matching allowlist REFUSES before any side
      // effect, keyed off the DB-sourced VCS identity (not the path name).
      const denied = await route("hibernate", ["someone/else"]);
      expect(denied.outcome).toBe("refused");
      expect(denied.reason).toBe("repo_not_allowlisted");
      expect(await probeProc.isRuntimeAlive(spec!)).toBe(true);

      // Hibernate through the shared router: checkpoint + stop; the pane survives DEAD.
      const hib = await route("hibernate", ["test/repo"]);
      expect(hib.outcome).toBe("executed");
      expect(hib.state).toBe("hibernated");
      expect(await probeProc.isRuntimeAlive(spec!)).toBe(false);
      expect(fs.existsSync(sessionFile)).toBe(true);
      let paneDead = false;
      for (let i = 0; i < 20 && !paneDead; i++) {
        await sleep(200);
        paneDead =
          tmux(["display-message", "-p", "-t", tmuxSession, "#{pane_dead}"]).trim() === "1";
      }
      expect(paneDead).toBe(true);

      // Wake through the shared router: respawn into the dead pane, accept generation, live.
      const wake = await route("wake", ["test/repo"]);
      expect(wake.outcome).toBe("executed");
      expect(wake.state).toBe("live");
      expect(wake.runtimeGeneration).toBe(1);
      const agent = db.getAgentById(AGENT_ID);
      expect(agent?.lifecycleState).toBe("live");
      expect(agent?.runtimeGeneration).toBe(1);
      expect(await probeProc.isRuntimeAlive(spec!)).toBe(true);
      expect(fs.existsSync(sessionFile)).toBe(true);
      expect(db.getAgentWakeReservation(AGENT_ID)).toBeNull();
      expect(db.getAgentLifecycleLease(AGENT_ID)).toBeNull();
    }, 240_000);
  },
);
