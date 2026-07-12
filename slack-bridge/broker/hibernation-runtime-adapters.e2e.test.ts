// Isolated, disposable end-to-end proof for the live hibernation runtime
// adapters. Drives the REAL HibernationProcessController / HibernationTmuxController
// against a REAL `pi` runtime in a REAL (throwaway) tmux session — never the
// production broker, mesh, or any shared tmux socket.
//
// Opt-in only: it spawns real processes and makes one cheap `pi --print` model
// call to seed a resumable session, so it is skipped in normal `pnpm test`/CI and
// runs only under `HIBERNATION_E2E=1`.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentRuntimeSpec } from "@pinet/broker-core/types";
import type { RuntimeLaunchContext } from "@pinet/broker-core";
import {
  createHibernationProcessController,
  createHibernationTmuxController,
  resolveVcsIdentity,
} from "./hibernation-runtime-adapters.js";

const RUN = process.env.HIBERNATION_E2E === "1";
const suite = RUN ? describe : describe.skip;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hib-e2e-"));
const tmuxSocket = path.join(tmpRoot, "tmux.sock");
const sessionsDir = path.join(tmpRoot, "sessions");
const repoDir = path.join(tmpRoot, "repo");
const sessionFile = path.join(sessionsDir, "e2e.jsonl");
const settingsPath = path.join(tmpRoot, "empty-settings.json");
const noopExt = path.join(tmpRoot, "noop-ext.js");
const tmuxSession = `pi-hib-e2e-${process.pid}`;

function tmux(args: string[]): string {
  return execFileSync("tmux", ["-S", tmuxSocket, ...args], { encoding: "utf8" }).trim();
}

// Launch a pane-bearing session with the clean minimal env explicitly, so the
// pane never inherits the polluted harness env regardless of the tmux client.
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

suite("hibernation adapters — real disposable pi + tmux", () => {
  // Minimal, clean env (NOT the polluted harness env, which auto-loads global
  // extensions that fail against this worktree's pnpm store). Auth still resolves
  // from the default ~/.pi/agent via HOME; empty settings load no extensions.
  // Strip node_modules/.bin entries so `pi` resolves to the GLOBAL install, not
  // a vitest/pnpm-shimmed workspace pi that would load workspace deps
  // (pi-ai@0.74.0 without /compat) and crash on the user's global extensions.
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

  const spec: AgentRuntimeSpec = {
    agentId: "e2e-agent",
    stableId: `${os.hostname()}:session:${sessionFile}`,
    brokerOwnerId: "e2e-broker",
    cwd: repoDir,
    repoRoot: repoDir,
    worktreePath: repoDir,
    tmuxSocket,
    tmuxSession,
    tmuxTarget: tmuxSession,
    executable: "pi",
    argv: ["pi"],
    envAllowlist: ["PI_SETTINGS_PATH", "PI_CODING_AGENT_SESSION_DIR"],
    sessionResumeRef: `session:${sessionFile}`,
    configFingerprint: "e2e",
    expectedHost: os.hostname(),
    expectedUser: os.userInfo().username,
    launchSource: "e2e",
    vcsIdentity: "test/repo",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const proc = createHibernationProcessController({ pendingInboxCount: () => 0 });
  // The tmux server is started with minimalEnv, so every pane (resident + woken)
  // inherits clean PI_SETTINGS_PATH/session-dir; no per-launcher env export needed.
  const tmuxCtrl = createHibernationTmuxController({
    extensionEntryPath: noopExt,
    baseLaunchEnv: {},
    inheritedEnvKeys: [],
    launcherDir: tmpRoot,
  });

  it("checkpoints, stops (session survives), and wakes a real pi runtime", async () => {
    // ── Arrange: disposable repo + settings + noop extension ──────────
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ extensions: [], packages: [] }));
    fs.writeFileSync(noopExt, "export default function(){}\n");
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:test/repo.git"], {
      cwd: repoDir,
    });

    // Seed a resumable session via a one-shot `pi --print` run inside the clean
    // tmux server (this also establishes the server env for all later panes).
    // Running pi through tmux avoids a vitest-child env quirk that mis-resolves
    // global extensions; a resident `pi --session` does not write the .jsonl
    // until its first turn, so we need one real seeding turn.
    const seedScript = path.join(tmpRoot, "seed.sh");
    fs.writeFileSync(
      seedScript,
      [
        "#!/bin/bash",
        `cd '${repoDir}'`,
        `pi --print --model google/gemini-2.5-flash --session '${sessionFile}' 'Remember codeword: MOOSE-42. Reply only ACK.' >'${tmpRoot}/seed.out' 2>&1 || true`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    // A persistent holder session keeps the tmux server (and its clean global
    // env) alive across the seed/resident lifecycle so it never tears down and
    // restarts under a different environment.
    tmuxNewSessionClean("holder", "sleep 100000", minimalEnv);
    tmuxNewSessionClean("seed", seedScript, minimalEnv);
    for (let i = 0; i < 120 && !fs.existsSync(sessionFile); i++) await sleep(500);
    if (!fs.existsSync(sessionFile)) {
      const out = fs.existsSync(`${tmpRoot}/seed.out`)
        ? fs.readFileSync(`${tmpRoot}/seed.out`, "utf8").slice(-1500)
        : "(no seed.out)";
      throw new Error(`seed session file was not created.\nseed.out tail:\n${out}`);
    }
    expect(fs.statSync(sessionFile).size).toBeGreaterThan(0);
    try {
      tmux(["kill-session", "-t", "seed"]);
    } catch {
      /* seed pane already exited */
    }

    // Launch the resident runtime in a throwaway tmux session (remain-on-exit).
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
    tmux(["set-option", "-t", tmuxSession, "remain-on-exit", "on"]);

    // ── Wait for the runtime to boot ──────────────────────────────────
    let alive = false;
    for (let i = 0; i < 40 && !alive; i++) {
      await sleep(300);
      alive = await proc.isRuntimeAlive(spec);
    }
    expect(alive).toBe(true);

    // ── vcsIdentity derives from the git remote, not the dir name ─────
    expect(await resolveVcsIdentity(repoDir)).toBe("test/repo");

    // ── Checkpoint: safe (alive + session on disk), rss captured ──────
    const checkpoint = await proc.requestCheckpoint(spec);
    expect(checkpoint.hibernateSafe).toBe(true);
    expect(checkpoint.reason).toBeNull();
    expect(checkpoint.sessionResumeRef).toBe(`session:${sessionFile}`);
    expect(checkpoint.rssBytes ?? 0).toBeGreaterThan(0);

    // ── Hibernate: stop the runtime; tmux session must SURVIVE ────────
    const stop = await proc.stopRuntime(spec);
    expect(stop.stopped).toBe(true);
    expect(await proc.isRuntimeAlive(spec)).toBe(false);
    expect(await tmuxCtrl.isSessionAttachable(spec)).toBe(true);
    // The resumable session file is untouched by hibernation.
    expect(fs.existsSync(sessionFile)).toBe(true);

    // ── Wake: respawn pi --session into the surviving pane ────────────
    const ctx: RuntimeLaunchContext = {
      agentId: spec.agentId,
      stableId: spec.stableId,
      wakeLeaseId: "e2e-lease",
      fenceToken: 1,
      reservedGeneration: 2,
      reservationNonce: "e2ewake01",
      correlationId: "e2e-corr",
      spec,
    };
    const wake = await tmuxCtrl.respawnRuntime(ctx);
    expect(wake.launched).toBe(true);
    expect(wake.handle?.pid ?? 0).toBeGreaterThan(0);

    // The woken runtime comes back alive on a fresh pid, bound to the same session.
    let revived = false;
    for (let i = 0; i < 40 && !revived; i++) {
      await sleep(300);
      revived = await proc.isRuntimeAlive(spec);
    }
    expect(revived).toBe(true);
    expect(await proc.isLaunchedAttemptAlive(wake.handle!)).toBe(true);

    // Session file path is unchanged — the woken runtime resumes the SAME session
    // (same path ⇒ same stable id ⇒ same fenced identity).
    expect(fs.existsSync(sessionFile)).toBe(true);

    // ── Teardown the woken runtime ────────────────────────────────────
    await proc.stopLaunchedAttempt(wake.handle!);
  }, 90_000);
});
