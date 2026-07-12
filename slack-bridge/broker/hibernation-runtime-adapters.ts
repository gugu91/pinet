// Real hibernation runtime adapters: the live `HibernationProcessController` and
// `HibernationTmuxController` the broker injects into `HibernationOrchestrator`.
//
// Design (proven feasible on disposable tmux/pi workers):
//   • A broker-managed worker runs `pi` as the foreground process of a tmux pane
//     whose session was launched with `remain-on-exit on`. The pane's `pane_pid`
//     IS the Pi runtime pid; its session `.jsonl` path is recorded in the runtime
//     spec's `sessionResumeRef` (`session:<path>`).
//   • Hibernate = stop the Pi pid (TERM then bounded KILL). Because the pane has
//     `remain-on-exit on`, the tmux session survives (operator-attachable) and is
//     NEVER destroyed here.
//   • Wake = `tmux respawn-pane -k` running a launcher that exports the single-use
//     wake fence and resumes the exact session via `pi --session <path>`. The
//     woken Pi re-registers under the SAME stable id (same session path) and
//     presents the fence for atomic generation acceptance.
//
// All process/tmux/ps/git interaction is funnelled through an injectable
// `CommandRunner` + signal/liveness hooks so the security- and correctness-
// critical control flow is unit-testable without spawning real processes.

import { execFile, type ExecFileException } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  HibernationCheckpointOutcome,
  HibernationProcessController,
  HibernationTmuxController,
  RuntimeAttemptHandle,
  RuntimeLaunchContext,
} from "@pinet/broker-core";
import type { AgentRuntimeSpec } from "@pinet/broker-core/types";
import {
  buildResumeLauncherScript,
  buildWakeFenceEnv,
  deriveVcsIdentity,
  parseRssBytesFromPs,
  resumePathFromSessionRef,
} from "./hibernation-runtime-helpers.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Minimal command executor abstraction (fake in tests, execFile at runtime). */
export interface CommandRunner {
  run(file: string, args: string[]): Promise<CommandResult>;
}

/** Real `CommandRunner` over `child_process.execFile` that never throws on a
 * non-zero exit — it resolves the captured exit code so callers branch on it. */
export function createExecFileRunner(): CommandRunner {
  return {
    run(file, args) {
      return new Promise<CommandResult>((resolve) => {
        execFile(
          file,
          args,
          { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
          (error: ExecFileException | null, stdout, stderr) => {
            const rawCode = error?.code;
            const code = typeof rawCode === "number" ? rawCode : error ? 1 : 0;
            resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
          },
        );
      });
    },
  };
}

function tmuxSocketArgs(spec: AgentRuntimeSpec): string[] {
  return spec.tmuxSocket ? ["-S", spec.tmuxSocket] : [];
}

export interface RuntimeAdapterDeps {
  runner?: CommandRunner;
  fileExists?: (filePath: string) => boolean;
  processAlive?: (pid: number) => boolean;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Pending inbox count projection for the checkpoint outcome. */
  pendingInboxCount?: (agentId: string) => number;
  /** Grace window for TERM before escalating to KILL. */
  stopGraceMs?: number;
  /** Poll interval while awaiting process exit. */
  pollMs?: number;
}

interface ResolvedProcessDeps {
  runner: CommandRunner;
  fileExists: (filePath: string) => boolean;
  processAlive: (pid: number) => boolean;
  sendSignal: (pid: number, signal: NodeJS.Signals) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pendingInboxCount: (agentId: string) => number;
  stopGraceMs: number;
  pollMs: number;
}

// agent-standards-ignore prefer-inline-single-use-helper: centralizes default
// resolution for the ResolvedProcessDeps bundle shared by the controller and the
// module-level terminatePid escalation helper.
function resolveProcessDeps(deps: RuntimeAdapterDeps): ResolvedProcessDeps {
  return {
    runner: deps.runner ?? createExecFileRunner(),
    fileExists: deps.fileExists ?? ((p) => fs.existsSync(p)),
    processAlive:
      deps.processAlive ??
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          // EPERM means the process exists but we may not signal it — still "alive".
          return (error as NodeJS.ErrnoException).code === "EPERM";
        }
      }),
    sendSignal: deps.sendSignal ?? ((pid, signal) => process.kill(pid, signal)),
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    pendingInboxCount: deps.pendingInboxCount ?? (() => 0),
    stopGraceMs: deps.stopGraceMs ?? 5_000,
    pollMs: deps.pollMs ?? 100,
  };
}

async function paneField(
  runner: CommandRunner,
  spec: AgentRuntimeSpec,
  field: string,
): Promise<string | null> {
  const result = await runner.run("tmux", [
    ...tmuxSocketArgs(spec),
    "display-message",
    "-p",
    "-t",
    spec.tmuxTarget,
    `#{${field}}`,
  ]);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

async function panePid(runner: CommandRunner, spec: AgentRuntimeSpec): Promise<number | null> {
  const raw = await paneField(runner, spec, "pane_pid");
  const pid = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function rssBytesOf(runner: CommandRunner, pid: number): Promise<number | null> {
  const result = await runner.run("ps", ["-o", "rss=", "-p", String(pid)]);
  if (result.code !== 0) return null;
  return parseRssBytesFromPs(result.stdout);
}

/** TERM then bounded KILL a pid; resolves whether it is confirmed gone. Shared by
 * pre-hibernation stop and failed-wake-attempt cleanup. */
async function terminatePid(pid: number, deps: ResolvedProcessDeps): Promise<boolean> {
  if (!deps.processAlive(pid)) return true;
  try {
    deps.sendSignal(pid, "SIGTERM");
  } catch {
    // Already gone between the liveness check and the signal.
    return !deps.processAlive(pid);
  }
  const deadline = deps.now() + deps.stopGraceMs;
  while (deps.now() < deadline) {
    await deps.sleep(deps.pollMs);
    if (!deps.processAlive(pid)) return true;
  }
  try {
    deps.sendSignal(pid, "SIGKILL");
  } catch {
    // Raced to exit during escalation.
  }
  await deps.sleep(deps.pollMs);
  return !deps.processAlive(pid);
}

export function createHibernationProcessController(
  deps: RuntimeAdapterDeps = {},
): HibernationProcessController {
  const d = resolveProcessDeps(deps);

  async function runtimeAlive(
    spec: AgentRuntimeSpec,
  ): Promise<{ alive: boolean; pid: number | null }> {
    const pid = await panePid(d.runner, spec);
    const deadRaw = await paneField(d.runner, spec, "pane_dead");
    // A dead/gone pane reads null or "1"; only an explicit "0" is a live runtime.
    const alive = pid != null && deadRaw === "0" && d.processAlive(pid);
    return { alive, pid };
  }

  return {
    async requestCheckpoint(spec: AgentRuntimeSpec): Promise<HibernationCheckpointOutcome> {
      const { alive, pid } = await runtimeAlive(spec);
      const rssBytes = pid != null ? await rssBytesOf(d.runner, pid) : null;
      const pendingInboxCount = d.pendingInboxCount(spec.agentId);
      const resumePath = resumePathFromSessionRef(spec.sessionResumeRef);
      const sessionOnDisk = resumePath != null && d.fileExists(resumePath);
      if (!alive) {
        return {
          hibernateSafe: false,
          reason: "runtime_not_alive",
          sessionResumeRef: spec.sessionResumeRef,
          pendingInboxCount,
          rssBytes,
        };
      }
      if (!sessionOnDisk) {
        return {
          hibernateSafe: false,
          reason: "session_unresumable",
          sessionResumeRef: spec.sessionResumeRef,
          pendingInboxCount,
          rssBytes,
        };
      }
      return {
        hibernateSafe: true,
        reason: null,
        sessionResumeRef: spec.sessionResumeRef,
        pendingInboxCount,
        rssBytes,
      };
    },

    async stopRuntime(
      spec: AgentRuntimeSpec,
    ): Promise<{ stopped: boolean; rssBytes: number | null }> {
      const pid = await panePid(d.runner, spec);
      if (pid == null) return { stopped: true, rssBytes: null };
      const rssBytes = await rssBytesOf(d.runner, pid);
      // Ensure the pane survives the Pi exit BEFORE stopping it, so hibernation
      // requires no change to the worker spawn path. With remain-on-exit on,
      // killing the pane's foreground Pi leaves the tmux session intact and
      // operator-attachable, and a wake can respawn into it. Best-effort: the
      // orchestrator independently verifies survival via isSessionAttachable.
      await d.runner.run("tmux", [
        ...tmuxSocketArgs(spec),
        "set-option",
        "-t",
        spec.tmuxSession,
        "remain-on-exit",
        "on",
      ]);
      const stopped = await terminatePid(pid, d);
      return { stopped, rssBytes };
    },

    async isRuntimeAlive(spec: AgentRuntimeSpec): Promise<boolean> {
      return (await runtimeAlive(spec)).alive;
    },

    async stopLaunchedAttempt(handle: RuntimeAttemptHandle): Promise<{ stopped: boolean }> {
      // No captured pid ⇒ we cannot PROVE this exact attempt's process is gone,
      // so fail closed rather than risk relaunching over a live runtime.
      if (handle.pid == null) return { stopped: false };
      return { stopped: await terminatePid(handle.pid, d) };
    },

    async isLaunchedAttemptAlive(handle: RuntimeAttemptHandle): Promise<boolean> {
      // Unprovable ⇒ treat as still alive so cleanup never assumes a phantom exit.
      if (handle.pid == null) return true;
      return d.processAlive(handle.pid);
    },
  };
}

export interface RuntimeRespawnDeps {
  runner?: CommandRunner;
  /** slack-bridge extension entry the woken runtime loads (`pi -e <path>`). */
  extensionEntryPath: string;
  /** Base PINET_* env re-establishing the mesh connection for the woken worker. */
  baseLaunchEnv: Record<string, string>;
  /** Broker env keys re-exported into the woken runtime when present. */
  inheritedEnvKeys: string[];
  buildNickname?: (ctx: RuntimeLaunchContext) => string;
  launcherDir?: string;
  writeFile?: (filePath: string, content: string, mode: number) => void;
  readEnv?: (key: string) => string | undefined;
}

export function createHibernationTmuxController(
  deps: RuntimeRespawnDeps,
): HibernationTmuxController {
  const runner = deps.runner ?? createExecFileRunner();
  const launcherDir = deps.launcherDir ?? os.tmpdir();
  const writeFile =
    deps.writeFile ?? ((filePath, content, mode) => fs.writeFileSync(filePath, content, { mode }));
  const readEnv = deps.readEnv ?? ((key) => process.env[key]);
  const buildNickname =
    deps.buildNickname ??
    ((ctx) => `Woken ${ctx.spec.launchSource || "worker"} ${ctx.reservationNonce.slice(0, 8)}`);

  return {
    async isSessionAttachable(spec: AgentRuntimeSpec): Promise<boolean> {
      const result = await runner.run("tmux", [
        ...tmuxSocketArgs(spec),
        "has-session",
        "-t",
        spec.tmuxSession,
      ]);
      return result.code === 0;
    },

    async respawnRuntime(
      ctx: RuntimeLaunchContext,
    ): Promise<{ launched: boolean; handle: RuntimeAttemptHandle | null }> {
      const spec = ctx.spec;
      const resumePath = resumePathFromSessionRef(spec.sessionResumeRef);
      // Unresumable spec ⇒ no session to bring back; fail closed (no handle).
      if (!resumePath) return { launched: false, handle: null };

      const inheritedEnv: Record<string, string | undefined> = {};
      for (const key of deps.inheritedEnvKeys) inheritedEnv[key] = readEnv(key);

      const pinetEnv: Record<string, string> = {
        ...deps.baseLaunchEnv,
        ...buildWakeFenceEnv({
          wakeLeaseId: ctx.wakeLeaseId,
          fenceToken: ctx.fenceToken,
          reservedGeneration: ctx.reservedGeneration,
          reservationNonce: ctx.reservationNonce,
          correlationId: ctx.correlationId,
        }),
      };

      const script = buildResumeLauncherScript({
        repoPath: spec.cwd || spec.repoRoot,
        sessionPath: resumePath,
        extensionEntryPath: deps.extensionEntryPath,
        inheritedEnv,
        pinetEnv,
        nickname: buildNickname(ctx),
      });

      const launcherPath = path.join(launcherDir, `pinet-wake-${ctx.reservationNonce}.sh`);
      try {
        writeFile(launcherPath, script, 0o700);
      } catch {
        return { launched: false, handle: null };
      }

      const result = await runner.run("tmux", [
        ...tmuxSocketArgs(spec),
        "respawn-pane",
        "-k",
        "-t",
        spec.tmuxTarget,
        launcherPath,
      ]);
      if (result.code !== 0) return { launched: false, handle: null };

      const pid = await panePid(runner, spec);
      return {
        launched: true,
        handle: { reservationNonce: ctx.reservationNonce, tmuxTarget: spec.tmuxTarget, pid },
      };
    },
  };
}

/**
 * Resolve the canonical git-remote-derived `owner/repo` VCS identity for a repo
 * root at spawn time. This is the ONLY identity the repo allowlist authorizes
 * against — derived from the runtime's actual `origin` remote, never from the
 * filesystem directory name. Returns null when no remote is resolvable (the
 * fail-closed authorization gate then refuses).
 */
export async function resolveVcsIdentity(
  repoRoot: string,
  runner: CommandRunner = createExecFileRunner(),
): Promise<string | null> {
  const result = await runner.run("git", ["-C", repoRoot, "remote", "get-url", "origin"]);
  if (result.code !== 0) return null;
  return deriveVcsIdentity(result.stdout.trim());
}
