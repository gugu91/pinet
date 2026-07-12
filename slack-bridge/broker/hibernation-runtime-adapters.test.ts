import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeSpec } from "@pinet/broker-core/types";
import type { RuntimeLaunchContext } from "@pinet/broker-core";
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
    vcsIdentity: "gugu91/extensions",
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
    ...overrides,
  };
}

interface RunnerState {
  panePid?: number | null;
  paneDead?: "0" | "1";
  rssKb?: number;
  hasSessionCode?: number;
  respawnCode?: number;
  remoteUrl?: string;
  gitCode?: number;
  // panePid AFTER a respawn (the new attempt's pid).
  panePidAfterRespawn?: number;
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
          return state.paneDead == null ? { stdout: "", stderr: "", code: 0 } : ok(state.paneDead);
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
  return { runner, calls };
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

describe("HibernationProcessController.requestCheckpoint", () => {
  it("is hibernateSafe when the runtime is alive and the session file exists", async () => {
    const { runner } = makeRunner({ panePid: 4242, paneDead: "0", rssKb: 100 });
    const ctrl = createHibernationProcessController({
      runner,
      fileExists: () => true,
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
      fileExists: () => true,
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
      fileExists: () => false,
      processAlive: () => true,
    });
    const outcome = await ctrl.requestCheckpoint(makeSpec());
    expect(outcome.hibernateSafe).toBe(false);
    expect(outcome.reason).toBe("session_unresumable");
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

  it("treats an already-gone pane as stopped", async () => {
    const { runner } = makeRunner({ panePid: null });
    const ctrl = createHibernationProcessController({ runner, processAlive: () => false });
    expect(await ctrl.stopRuntime(makeSpec())).toEqual({ stopped: true, rssBytes: null });
  });
});

describe("HibernationProcessController attempt-bound + liveness", () => {
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

  it("fails closed when a launched attempt has no captured pid", async () => {
    const { runner } = makeRunner({});
    const ctrl = createHibernationProcessController({ runner });
    expect(
      await ctrl.stopLaunchedAttempt({ reservationNonce: "n", tmuxTarget: "t", pid: null }),
    ).toEqual({ stopped: false });
    expect(
      await ctrl.isLaunchedAttemptAlive({ reservationNonce: "n", tmuxTarget: "t", pid: null }),
    ).toBe(true);
  });

  it("stops a launched attempt addressed by its captured pid", async () => {
    const { runner } = makeRunner({});
    const world = makeProcessWorld(new Set([999]), { dieOnTerm: true });
    const ctrl = createHibernationProcessController({ runner, ...world });
    expect(
      await ctrl.stopLaunchedAttempt({ reservationNonce: "n", tmuxTarget: "t", pid: 999 }),
    ).toEqual({ stopped: true });
  });
});

describe("HibernationTmuxController", () => {
  const respawnDeps = {
    extensionEntryPath: "/ext/index.js",
    baseLaunchEnv: { PINET_SOCKET_PATH: "/sock", PINET_BROKER_MANAGED: "1" },
    inheritedEnvKeys: ["PI_SETTINGS_PATH"],
    readEnv: (k: string) => (k === "PI_SETTINGS_PATH" ? "/cfg.json" : undefined),
  };
  const ctx: RuntimeLaunchContext = {
    agentId: "agent-1",
    stableId: "host:session:/tmp/s/agent-1.jsonl",
    wakeLeaseId: "lease-1",
    fenceToken: 5,
    reservedGeneration: 9,
    reservationNonce: "nonce-abcdef123456",
    correlationId: "corr-1",
    spec: makeSpec(),
  };

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

  it("respawns into the recorded pane and returns an attempt-bound handle", async () => {
    const { runner, calls } = makeRunner({
      panePid: 111,
      panePidAfterRespawn: 222,
      respawnCode: 0,
    });
    const writeFile = vi.fn();
    const ctrl = createHibernationTmuxController({ ...respawnDeps, runner, writeFile });
    const result = await ctrl.respawnRuntime(ctx);
    expect(result.launched).toBe(true);
    expect(result.handle).toEqual({
      reservationNonce: "nonce-abcdef123456",
      tmuxTarget: "pinet-repo-worker-abcd:0.0",
      pid: 222,
    });
    // Launcher script was written and resumes the exact session with the fence env.
    expect(writeFile).toHaveBeenCalledTimes(1);
    const script = writeFile.mock.calls[0][1] as string;
    expect(script).toContain("--session '/tmp/s/agent-1.jsonl'");
    expect(script).toContain("export PINET_WAKE_LEASE_ID='lease-1'");
    expect(script).toContain("export PINET_WAKE_RESERVATION_NONCE='nonce-abcdef123456'");
    expect(script).toContain("export PI_SETTINGS_PATH='/cfg.json'");
    // respawn-pane -k targeted the recorded pane.
    const respawn = calls.find((c) => c.args.includes("respawn-pane"));
    expect(respawn?.args).toEqual(
      expect.arrayContaining(["respawn-pane", "-k", "-t", "pinet-repo-worker-abcd:0.0"]),
    );
  });

  it("fails closed (no handle) when the spec is not resumable", async () => {
    const { runner } = makeRunner({ panePid: 111 });
    const writeFile = vi.fn();
    const ctrl = createHibernationTmuxController({ ...respawnDeps, runner, writeFile });
    const result = await ctrl.respawnRuntime({
      ...ctx,
      spec: makeSpec({ sessionResumeRef: "cwd:/repo/root" }),
    });
    expect(result).toEqual({ launched: false, handle: null });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("fails closed when respawn-pane errors", async () => {
    const { runner } = makeRunner({ panePid: 111, respawnCode: 1 });
    const ctrl = createHibernationTmuxController({ ...respawnDeps, runner, writeFile: vi.fn() });
    expect(await ctrl.respawnRuntime(ctx)).toEqual({ launched: false, handle: null });
  });
});

describe("resolveVcsIdentity", () => {
  it("derives owner/repo from the git origin remote", async () => {
    const { runner } = makeRunner({ remoteUrl: "git@github.com:gugu91/extensions.git\n" });
    expect(await resolveVcsIdentity("/repo/root", runner)).toBe("gugu91/extensions");
  });

  it("returns null when no origin remote is resolvable", async () => {
    const { runner } = makeRunner({ gitCode: 1 });
    expect(await resolveVcsIdentity("/repo/root", runner)).toBeNull();
  });
});
