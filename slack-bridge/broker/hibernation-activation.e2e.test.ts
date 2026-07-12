// Materially-real, isolated end-to-end proof for the Phase B WIRED COMPOSITION.
//
// Unlike the adapter E2E (which drives the controllers directly), this drives the
// REAL `HibernationOrchestrator` produced by `createHibernationOrchestrator`,
// consuming a REAL durable runtime spec produced by `persistSpawnedRuntimeSpec`
// (Seam 2), reconciling against a REAL BrokerDB, and acting on a REAL `pi`
// runtime in a REAL throwaway tmux session — never the production broker, mesh,
// or a shared tmux socket. It proves the whole seam chain end to end:
//
//   spawn spec (git-remote VCS identity) → orchestrator checkpoint → stop
//   (session survives) → respawn into the dead pane → generation accepted → live.
//
// The ONLY simulated element is the socket-registration RPC (broker-core's domain,
// already exhaustively fenced-tested): the injected `awaitRuntimeRegistration`
// stands in for the socket server BUT keys acceptance off the REAL respawned
// process actually coming back alive, so nothing about the runtime lifecycle is
// mocked.
//
// Opt-in only (spawns real processes + one cheap `pi --print` model call to seed a
// resumable session); skipped in normal `pnpm test`/CI, runs under HIBERNATION_E2E=1.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RuntimeLaunchContext } from "@pinet/broker-core";
import { BrokerDB } from "./schema.js";
import { createHibernationProcessController } from "./hibernation-runtime-adapters.js";
import {
  createHibernationOrchestrator,
  persistSpawnedRuntimeSpec,
  type SpawnRuntimeSpecFacts,
} from "./hibernation-activation.js";

const RUN = process.env.HIBERNATION_E2E === "1";
const suite = RUN ? describe : describe.skip;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hib-act-e2e-"));
const tmuxSocket = path.join(tmpRoot, "tmux.sock");
const sessionsDir = path.join(tmpRoot, "sessions");
const repoDir = path.join(tmpRoot, "repo");
const sessionFile = path.join(sessionsDir, "e2e.jsonl");
const settingsPath = path.join(tmpRoot, "empty-settings.json");
const noopExt = path.join(tmpRoot, "noop-ext.js");
const dbPath = path.join(tmpRoot, "broker.db");
const tmuxSession = `pi-hib-act-e2e-${process.pid}`;
const AGENT_ID = "e2e-agent";
const STABLE_ID = `${os.hostname()}:session:${sessionFile}`;

function tmux(args: string[]): string {
  return execFileSync("tmux", ["-S", tmuxSocket, ...args], { encoding: "utf8" }).trim();
}
function tmuxNewSessionClean(name: string, script: string, env: NodeJS.ProcessEnv): void {
  execFileSync("tmux", ["-S", tmuxSocket, "new-session", "-d", "-s", name, script], { env });
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterAll(() => {
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

suite("Phase B wired composition — real orchestrator + spec + disposable pi/tmux", () => {
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

  it("drives checkpoint → stop → respawn → accept → live through the real composition", async () => {
    // ── Arrange: disposable repo (with a real git remote), settings, noop ext ──
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ extensions: [], packages: [] }));
    fs.writeFileSync(noopExt, "export default function(){}\n");
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:test/repo.git"], {
      cwd: repoDir,
    });

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

    // ── Seam 2: persist the durable, broker-authored runtime spec ─────
    const db = new BrokerDB(dbPath);
    db.initialize();
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

    // ── Seam 1: compose the REAL orchestrator; inject a registration waiter
    //    that accepts ONLY once the respawned process is genuinely alive ──
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
        // Stand in for the socket server accepting the woken worker's fenced
        // generation — but only after the REAL process is confirmed alive.
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

    // ── Wait for the resident runtime to boot ─────────────────────────
    let alive = false;
    for (let i = 0; i < 40 && !alive; i++) {
      await sleep(300);
      alive = await probeProc.isRuntimeAlive(spec!);
    }
    expect(alive).toBe(true);

    // ── prepareHibernation walks the eligible free worker to idle ─────
    const prep = orch.prepareHibernation(AGENT_ID);
    expect(prep).toMatchObject({ ready: true, state: "idle" });

    // ── hibernate: REAL checkpoint + stop; tmux session must SURVIVE ──
    const hibResult = await orch.hibernate(AGENT_ID);
    expect(hibResult.ok).toBe(true);
    expect(hibResult.state).toBe("hibernated");
    expect(await probeProc.isRuntimeAlive(spec!)).toBe(false);
    // The resumable session file is untouched by hibernation.
    expect(fs.existsSync(sessionFile)).toBe(true);
    // The surviving pane is explicitly DEAD (remain-on-exit) — the only state the
    // wake path will respawn into.
    let paneDead = false;
    for (let i = 0; i < 20 && !paneDead; i++) {
      await sleep(200);
      paneDead = tmux(["display-message", "-p", "-t", tmuxSession, "#{pane_dead}"]).trim() === "1";
    }
    expect(paneDead).toBe(true);

    // ── wake: respawn pi --session, accept the generation, return to live ──
    const wakeResult = await orch.wake(AGENT_ID, { trigger: "manual" });
    expect(wakeResult.ok).toBe(true);
    expect(wakeResult.state).toBe("live");
    expect(wakeResult.runtimeGeneration).toBe(1);

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
  }, 120_000);
});
