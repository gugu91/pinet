import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeSpec } from "@pinet/broker-core/types";
import type { RuntimeAttemptHandle, RuntimeLaunchContext } from "@pinet/broker-core";
import {
  createHibernationProcessController,
  createHibernationTmuxController,
  resolveVcsIdentity,
  type CommandResult,
  type CommandRunner,
} from "./hibernation-runtime-adapters.js";

function makeSpec(overrides: Partial<AgentRuntimeSpec> = {}): AgentRuntimeSpec {
  return {
    agentId: "agent-1",
    stableId: "host:session:/tmp/s/agent-1.jsonl",
    brokerOwnerId: "broker-1",
    cwd: "/repo/root",
    repoRoot: "/repo/root",
    worktreePath: "/repo/root",
    tmuxSocket: "/tmp/tmux.sock",
    tmuxSession: "pinet-repo-worker-abcd",
    tmuxTarget: "pinet-repo-worker-abcd:0.0",
    executable: "pi",
    argv: ["pi"],
    envAllowlist: ["PINET_SOCKET_PATH"],
    sessionResumeRef: "session:/tmp/s/agent-1.jsonl",
    configFingerprint: "fp",
    expectedHost: "host",
    expectedUser: "user",
    launchSource: "subtree-broker-tmux",
    vcsIdentity: "gugu91/pinet",
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
    ...overrides,
  };
}

interface RunnerState {
  panePid?: number | null;
  paneDead?: "0" | "1";
  rssKb?: number;
  /** Process start time from `ps -o lstart=`; null ⇒ pid gone. Read live. */
  startToken?: string | null;
  hasSessionCode?: number;
  respawnCode?: number;
  remoteUrl?: string;
  gitCode?: number;
  // pane state AFTER a respawn (the new attempt's pid/liveness).
  panePidAfterRespawn?: number;
  paneDeadAfterRespawn?: "0" | "1";
}

function makeRunner(state: RunnerState) {
  const calls: Array<{ file: string; args: string[] }> = [];
  let respawned = false;
  const runner: CommandRunner = {
    async run(file, args): Promise<CommandResult> {
      calls.push({ file, args });
      const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", code: 0 });
      if (file === "tmux") {
        const field = args.find((a) => a.startsWith("#{"));
        if (args.includes("display-message") && field === "#{pane_pid}") {
          const pid = respawned ? (state.panePidAfterRespawn ?? state.panePid) : state.panePid;
          return pid == null ? { stdout: "", stderr: "", code: 0 } : ok(String(pid));
        }
        if (args.includes("display-message") && field === "#{pane_dead}") {
          const dead = respawned ? (state.paneDeadAfterRespawn ?? state.paneDead) : state.paneDead;
          return dead == null ? { stdout: "", stderr: "", code: 0 } : ok(dead);
        }
        if (args.includes("has-session")) {
          return { stdout: "", stderr: "", code: state.hasSessionCode ?? 0 };
        }
        if (args.includes("respawn-pane")) {
          respawned = true;
          return { stdout: "", stderr: "", code: state.respawnCode ?? 0 };
        }
      }
      if (file === "ps") {
        if (args.includes("lstart=")) {
          const token =
            state.startToken === undefined ? "Sun Jul 12 13:30:21 2026" : state.startToken;
          return token == null ? { stdout: "", stderr: "", code: 1 } : ok(`${token}\n`);
        }
        return state.rssKb == null ? { stdout: "", stderr: "", code: 1 } : ok(`${state.rssKb}\n`);
      }
      if (file === "git") {
        return state.gitCode
          ? { stdout: "", stderr: "", code: state.gitCode }
          : ok(state.remoteUrl ?? "");
      }
      return { stdout: "", stderr: "", code: 127 };
    },
  };
  return { runner, calls, state };
}

/** Fake clock + liveness registry so terminate loops are deterministic. */
function makeProcessWorld(alive: Set<number>, opts: { dieOnTerm?: boolean } = {}) {
  let clock = 0;
  const signals: Array<{ pid: number; signal: string }> = [];
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    processAlive: (pid: number) => alive.has(pid),
    sendSignal: (pid: number, signal: NodeJS.Signals) => {
      signals.push({ pid, signal });
      if (signal === "SIGKILL") alive.delete(pid);
      if (signal === "SIGTERM" && opts.dieOnTerm) alive.delete(pid);
    },
    signals,
  };
}

const respawnDeps = {
  extensionEntryPath: "/ext/index.js",
  baseLaunchEnv: { PINET_SOCKET_PATH: "/sock", PINET_BROKER_MANAGED: "1" },
  inheritedEnvKeys: ["PI_SETTINGS_PATH"],
  launcherDir: "/tmp/fake-wake",
  readEnv: (k: string) => (k === "PI_SETTINGS_PATH" ? "/cfg.json" : undefined),
};

function makeLaunchCtx(overrides: Partial<RuntimeLaunchContext> = {}): RuntimeLaunchContext {
  return {
    agentId: "agent-1",
    stableId: "host:session:/tmp/s/agent-1.jsonl",
    wakeLeaseId: "lease-1",
    fenceToken: 5,
    reservedGeneration: 9,
    reservationNonce: "nonce-abcdef123456",
    correlationId: "corr-1",
    spec: makeSpec(),
    ...overrides,
  };
}

describe("HibernationProcessController.requestCheckpoint", () => {
  it("is hibernateSafe when a live generation exists and the session is non-empty", async () => {
    const { runner } = makeRunner({ panePid: 4242, paneDead: "0", rssKb: 100 });
    const ctrl = createHibernationProcessController({
      runner,
      sessionByteSize: () => 2048,
      processAlive: () => true,
      pendingInboxCount: () => 3,
    });
    const outcome = await ctrl.requestCheckpoint(makeSpec());
    expect(outcome).toEqual({
      hibernateSafe: true,
      reason: null,
      sessionResumeRef: "session:/tmp/s/agent-1.jsonl",
      pendingInboxCount: 3,
      rssBytes: 100 * 1024,
    });
  });

  it("refuses when the recorded runtime pid is gone (pane dead)", async () => {
    const { runner } = makeRunner({ panePid: 4242, paneDead: "1", rssKb: 100 });
    const ctrl = createHibernationProcessController({
      runner,
      sessionByteSize: () => 2048,
      processAlive: () => true,
    });
    const outcome = await ctrl.requestCheckpoint(makeSpec());
    expect(outcome.hibernateSafe).toBe(false);
    expect(outcome.reason).toBe("runtime_not_alive");
  });

  it("refuses when the session file is not resumable on disk", async () => {
    const { runner } = makeRunner({ panePid: 4242, paneDead: "0", rssKb: 100 });
    const ctrl = createHibernationProcessController({
      runner,
      sessionByteSize: () => null,
      processAlive: () => true,
    });
    const outcome = await ctrl.requestCheckpoint(makeSpec());
    expect(outcome.hibernateSafe).toBe(false);
    expect(outcome.reason).toBe("session_unresumable");
  });

  it("refuses when the session file exists but is empty (no durable state)", async () => {
    const { runner } = makeRunner({ panePid: 4242, paneDead: "0", rssKb: 100 });
    const ctrl = createHibernationProcessController({
      runner,
      sessionByteSize: () => 0,
      processAlive: () => true,
    });
    const outcome = await ctrl.requestCheckpoint(makeSpec());
    expect(outcome.hibernateSafe).toBe(false);
    expect(outcome.reason).toBe("session_empty");
  });

  it("refuses when the live pid has no readable generation token", async () => {
    const { runner } = makeRunner({ panePid: 4242, paneDead: "0", rssKb: 100, startToken: null });
    const ctrl = createHibernationProcessController({
      runner,
      sessionByteSize: () => 2048,
      processAlive: () => true,
    });
    const outcome = await ctrl.requestCheckpoint(makeSpec());
    expect(outcome.hibernateSafe).toBe(false);
    expect(outcome.reason).toBe("runtime_not_alive");
  });
});

describe("HibernationProcessController.stopRuntime", () => {
  it("stops on graceful SIGTERM and never destroys the tmux session", async () => {
    const { runner, calls } = makeRunner({ panePid: 4242, paneDead: "0", rssKb: 100 });
    const world = makeProcessWorld(new Set([4242]), { dieOnTerm: true });
    const ctrl = createHibernationProcessController({ runner, ...world });
    const result = await ctrl.stopRuntime(makeSpec());
    expect(result).toEqual({ stopped: true, rssBytes: 100 * 1024 });
    expect(world.signals.map((s) => s.signal)).toEqual(["SIGTERM"]);
    // No tmux kill-session / kill-pane was ever issued.
    const tmuxVerbs = calls.filter((c) => c.file === "tmux").flatMap((c) => c.args);
    expect(tmuxVerbs).not.toContain("kill-session");
    expect(tmuxVerbs).not.toContain("kill-pane");
  });

  it("ensures remain-on-exit on the session before killing Pi (no spawn-path change needed)", async () => {
    const { runner, calls } = makeRunner({ panePid: 4242, paneDead: "0", rssKb: 100 });
    const world = makeProcessWorld(new Set([4242]), { dieOnTerm: true });
    const ctrl = createHibernationProcessController({ runner, ...world });
    await ctrl.stopRuntime(makeSpec());
    const setOption = calls.find(
      (c) =>
        c.file === "tmux" && c.args.includes("set-option") && c.args.includes("remain-on-exit"),
    );
    expect(setOption).toBeDefined();
    expect(setOption?.args).toContain("on");
    // It targets the recorded tmux session, never a destructive verb.
    expect(setOption?.args).toContain(makeSpec().tmuxSession);
    expect(setOption?.args).not.toContain("kill-session");
  });

  it("escalates to SIGKILL when the runtime ignores SIGTERM", async () => {
    const { runner } = makeRunner({ panePid: 4242, paneDead: "0", rssKb: 100 });
    const world = makeProcessWorld(new Set([4242]), { dieOnTerm: false });
    const ctrl = createHibernationProcessController({
      runner,
      ...world,
      stopGraceMs: 500,
      pollMs: 100,
    });
    const result = await ctrl.stopRuntime(makeSpec());
    expect(result.stopped).toBe(true);
    expect(world.signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("treats an already-dead pane as stopped without signalling", async () => {
    const { runner } = makeRunner({ panePid: 4242, paneDead: "1" });
    const world = makeProcessWorld(new Set([4242]), { dieOnTerm: true });
    const ctrl = createHibernationProcessController({ runner, ...world });
    expect(await ctrl.stopRuntime(makeSpec())).toEqual({ stopped: true, rssBytes: null });
    expect(world.signals).toEqual([]);
  });

  it("treats an already-gone pane as stopped", async () => {
    const { runner } = makeRunner({ panePid: null });
    const ctrl = createHibernationProcessController({ runner, processAlive: () => false });
    expect(await ctrl.stopRuntime(makeSpec())).toEqual({ stopped: true, rssBytes: null });
  });
});

describe("HibernationProcessController generation-bound liveness + cleanup", () => {
  it("isRuntimeAlive reflects pane liveness", async () => {
    const aliveRunner = makeRunner({ panePid: 7, paneDead: "0" });
    const deadRunner = makeRunner({ panePid: 7, paneDead: "1" });
    expect(
      await createHibernationProcessController({
        runner: aliveRunner.runner,
        processAlive: () => true,
      }).isRuntimeAlive(makeSpec()),
    ).toBe(true);
    expect(
      await createHibernationProcessController({
        runner: deadRunner.runner,
        processAlive: () => true,
      }).isRuntimeAlive(makeSpec()),
    ).toBe(false);
  });

  it("fails closed when the handle carries no generation (foreign/degraded handle)", async () => {
    const { runner } = makeRunner({});
    const ctrl = createHibernationProcessController({ runner });
    const bare: RuntimeAttemptHandle = { reservationNonce: "n", tmuxTarget: "t", pid: 999 };
    expect(await ctrl.stopLaunchedAttempt(bare)).toEqual({ stopped: false });
    expect(await ctrl.isLaunchedAttemptAlive(bare)).toBe(true);
  });

  it("default/public composition: an independently-built process controller can clean a tmux-launched attempt (no shared registry)", async () => {
    // The regression for the composition trap: the two controllers are built
    // INDEPENDENTLY exactly as the live wiring composes them — there is no shared
    // registry to omit, because the launch generation travels inside the handle.
    const { runner } = makeRunner({
      panePid: 111,
      panePidAfterRespawn: 222,
      paneDead: "1",
      paneDeadAfterRespawn: "0",
      respawnCode: 0,
    });
    const world = makeProcessWorld(new Set([222]), { dieOnTerm: true });
    const tmux = createHibernationTmuxController({ ...respawnDeps, runner, writeFile: vi.fn() });
    const proc = createHibernationProcessController({ runner, ...world });
    const launch = await tmux.respawnRuntime(makeLaunchCtx());
    expect(launch.launched).toBe(true);
    expect(launch.handle?.pid).toBe(222);
    // The launched process is alive before cleanup, then provably stopped — even
    // though `proc` and `tmux` never shared any registry object.
    expect(await proc.isLaunchedAttemptAlive(launch.handle!)).toBe(true);
    expect(await proc.stopLaunchedAttempt(launch.handle!)).toEqual({ stopped: true });
    expect(world.signals.map((s) => s.signal)).toEqual(["SIGTERM"]);
  });

  it("never signals a cross-second reused pid: refuses cleanup when the start-time token drifted", async () => {
    const runnerBox = makeRunner({
      panePid: 111,
      panePidAfterRespawn: 222,
      paneDead: "1",
      paneDeadAfterRespawn: "0",
      startToken: "Sun Jul 12 13:30:21 2026",
      respawnCode: 0,
    });
    const world = makeProcessWorld(new Set([222]), { dieOnTerm: true });
    const tmux = createHibernationTmuxController({
      ...respawnDeps,
      runner: runnerBox.runner,
      writeFile: vi.fn(),
    });
    const proc = createHibernationProcessController({ runner: runnerBox.runner, ...world });
    const launch = await tmux.respawnRuntime(makeLaunchCtx());
    expect(launch.handle?.pid).toBe(222);
    // Pid 222 exits and is REUSED by an unrelated same-user process that started
    // at a different (later) time, so the start-time generation token drifts.
    runnerBox.state.startToken = "Sun Jul 12 13:41:07 2026";
    const stop = await proc.stopLaunchedAttempt(launch.handle!);
    expect(stop).toEqual({ stopped: true });
    // Crucially, NO signal was ever delivered to the reused pid.
    expect(world.signals).toEqual([]);
  });
});

describe("HibernationTmuxController", () => {
  it("isSessionAttachable maps has-session exit code", async () => {
    const attach = makeRunner({ hasSessionCode: 0 });
    const gone = makeRunner({ hasSessionCode: 1 });
    expect(
      await createHibernationTmuxController({
        ...respawnDeps,
        runner: attach.runner,
      }).isSessionAttachable(makeSpec()),
    ).toBe(true);
    expect(
      await createHibernationTmuxController({
        ...respawnDeps,
        runner: gone.runner,
      }).isSessionAttachable(makeSpec()),
    ).toBe(false);
  });

  it("respawns a DEAD pane (no -k) and returns an attempt-bound handle", async () => {
    const { runner, calls } = makeRunner({
      panePid: 111,
      paneDead: "1",
      panePidAfterRespawn: 222,
      paneDeadAfterRespawn: "0",
      respawnCode: 0,
    });
    const writeFile = vi.fn();
    const unlink = vi.fn();
    const ctrl = createHibernationTmuxController({ ...respawnDeps, runner, writeFile, unlink });
    const result = await ctrl.respawnRuntime(makeLaunchCtx());
    expect(result.launched).toBe(true);
    expect(result.handle).toMatchObject({
      reservationNonce: "nonce-abcdef123456",
      tmuxTarget: "pinet-repo-worker-abcd:0.0",
      pid: 222,
    });
    // Launcher script resumes the exact session, exports the fence, and self-deletes.
    expect(writeFile).toHaveBeenCalledTimes(1);
    const script = writeFile.mock.calls[0][1] as string;
    expect(script).toContain("--session '/tmp/s/agent-1.jsonl'");
    expect(script).toContain("export PINET_WAKE_LEASE_ID='lease-1'");
    expect(script).toContain("export PINET_WAKE_RESERVATION_NONCE='nonce-abcdef123456'");
    expect(script).toContain("export PI_SETTINGS_PATH='/cfg.json'");
    expect(script).toContain('rm -f -- "$0"');
    // respawn-pane targeted the recorded pane WITHOUT the destructive -k flag.
    const respawn = calls.find((c) => c.args.includes("respawn-pane"));
    expect(respawn?.args).toEqual(
      expect.arrayContaining(["respawn-pane", "-t", "pinet-repo-worker-abcd:0.0"]),
    );
    expect(respawn?.args).not.toContain("-k");
    // Success path: the script self-deletes, so the broker does not unlink.
    expect(unlink).not.toHaveBeenCalled();
  });

  it("refuses to clobber a LIVE pane (destructive-wake guard)", async () => {
    const { runner, calls } = makeRunner({ panePid: 111, paneDead: "0" });
    const writeFile = vi.fn();
    const ctrl = createHibernationTmuxController({ ...respawnDeps, runner, writeFile });
    const result = await ctrl.respawnRuntime(makeLaunchCtx());
    expect(result).toEqual({ launched: false, handle: null });
    expect(writeFile).not.toHaveBeenCalled();
    // No respawn-pane was ever attempted against the live pane.
    expect(calls.find((c) => c.args.includes("respawn-pane"))).toBeUndefined();
  });

  it("refuses when the recorded tmux session is gone", async () => {
    const { runner } = makeRunner({ panePid: 111, paneDead: "1", hasSessionCode: 1 });
    const ctrl = createHibernationTmuxController({ ...respawnDeps, runner, writeFile: vi.fn() });
    expect(await ctrl.respawnRuntime(makeLaunchCtx())).toEqual({ launched: false, handle: null });
  });

  it("fails closed (no handle) when the spec is not resumable", async () => {
    const { runner } = makeRunner({ panePid: 111, paneDead: "1" });
    const writeFile = vi.fn();
    const ctrl = createHibernationTmuxController({ ...respawnDeps, runner, writeFile });
    const result = await ctrl.respawnRuntime(
      makeLaunchCtx({ spec: makeSpec({ sessionResumeRef: "cwd:/repo/root" }) }),
    );
    expect(result).toEqual({ launched: false, handle: null });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("fails closed and unlinks the orphan launcher when respawn-pane errors", async () => {
    const { runner } = makeRunner({ panePid: 111, paneDead: "1", respawnCode: 1 });
    const writeFile = vi.fn();
    const unlink = vi.fn();
    const ctrl = createHibernationTmuxController({ ...respawnDeps, runner, writeFile, unlink });
    expect(await ctrl.respawnRuntime(makeLaunchCtx())).toEqual({ launched: false, handle: null });
    // Failure path: the launcher never exec'd, so the broker removes the secret-bearing orphan.
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink.mock.calls[0][0]).toContain("pinet-wake-nonce-abcdef123456.sh");
  });
});

describe("resolveVcsIdentity", () => {
  it("derives owner/repo from the git origin remote", async () => {
    const { runner } = makeRunner({ remoteUrl: "git@github.com:gugu91/pinet.git\n" });
    expect(await resolveVcsIdentity("/repo/root", runner)).toBe("gugu91/pinet");
  });

  it("returns null when no origin remote is resolvable", async () => {
    const { runner } = makeRunner({ gitCode: 1 });
    expect(await resolveVcsIdentity("/repo/root", runner)).toBeNull();
  });
});
