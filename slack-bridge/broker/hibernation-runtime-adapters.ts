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
//     NEVER destroyed here; the pane transitions to `pane_dead=1`.
//   • Wake = respawn a launcher into the recorded pane ONLY when that exact pane
//     is present and explicitly dead, exporting the single-use wake fence and
//     resuming the exact session via `pi --session <path>`. The woken Pi
//     re-registers under the SAME stable id and presents the fence for atomic
//     generation acceptance.
//
// PID-reuse / signal safety (independent-review P1): a numeric pid is NEVER
// signalled on its own. Every TERM/KILL/liveness action is bound to a process
// GENERATION — the tuple (pane-authoritative `pane_pid`, `pane_dead=0`, and the
// OS process START TOKEN from `ps -o lstart=`) — and is re-verified immediately
// before each signal. If the pane no longer hosts that exact live generation
// (the process exited, the pane died, or the pid was reused by an unrelated
// same-user process with a different start token) the action is abandoned as
// "already gone" rather than risking a kill of an unrelated process. Wake-attempt
// generations are carried in an injected {@link AttemptGenerationRegistry} so the
// attempt-scoped stop/liveness probes bind to the EXACT process a wake launched.
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

/** The minimal tmux pane address the pane probes/signals operate against. */
interface PaneAddress {
  tmuxSocket: string;
  tmuxTarget: string;
}

/**
 * A verified OS process generation: the pane's foreground pid PLUS its process
 * start token. The start token pins the exact process instance so a reused pid
 * (same number, different process) is never mistaken for — or signalled as — the
 * original runtime.
 */
interface ProcessGeneration {
  pid: number;
  startToken: string;
}

/**
 * The attempt-bound generation a single wake launched. Carries the pane address
 * so the attempt-scoped stop/liveness probes read the exact pane the attempt
 * respawned into (the `RuntimeAttemptHandle` public shape intentionally exposes
 * only the nonce/target/pid; the generation binding lives here).
 */
export interface AttemptGeneration extends ProcessGeneration, PaneAddress {}

/**
 * Records the generation each wake attempt launched, keyed by reservation nonce,
 * so `stopLaunchedAttempt` / `isLaunchedAttemptAlive` prove the EXACT process
 * that attempt spawned is gone/alive. Shared (injected) between the tmux
 * controller (which records at respawn) and the process controller (which reads
 * at cleanup). A miss fails closed (unprovable ⇒ not-stopped / still-alive).
 */
export interface AttemptGenerationRegistry {
  record(reservationNonce: string, generation: AttemptGeneration): void;
  get(reservationNonce: string): AttemptGeneration | undefined;
  clear(reservationNonce: string): void;
}

export function createAttemptGenerationRegistry(): AttemptGenerationRegistry {
  const map = new Map<string, AttemptGeneration>();
  return {
    record: (nonce, generation) => void map.set(nonce, generation),
    get: (nonce) => map.get(nonce),
    clear: (nonce) => void map.delete(nonce),
  };
}

function tmuxSocketArgs(socket: string): string[] {
  return socket ? ["-S", socket] : [];
}

export interface RuntimeAdapterDeps {
  runner?: CommandRunner;
  /** Byte size of a session file, or null when absent (non-empty ⇒ resumable). */
  sessionByteSize?: (filePath: string) => number | null;
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
  /** Shared attempt-generation registry (created if omitted). */
  attemptRegistry?: AttemptGenerationRegistry;
}

interface ResolvedProcessDeps {
  runner: CommandRunner;
  sessionByteSize: (filePath: string) => number | null;
  processAlive: (pid: number) => boolean;
  sendSignal: (pid: number, signal: NodeJS.Signals) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pendingInboxCount: (agentId: string) => number;
  stopGraceMs: number;
  pollMs: number;
  attemptRegistry: AttemptGenerationRegistry;
}

// agent-standards-ignore prefer-inline-single-use-helper: centralizes default
// resolution for the ResolvedProcessDeps bundle shared by the controller and the
// module-level generation-termination helper.
function resolveProcessDeps(deps: RuntimeAdapterDeps): ResolvedProcessDeps {
  return {
    runner: deps.runner ?? createExecFileRunner(),
    sessionByteSize:
      deps.sessionByteSize ??
      ((p) => {
        try {
          return fs.statSync(p).size;
        } catch {
          return null;
        }
      }),
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
    attemptRegistry: deps.attemptRegistry ?? createAttemptGenerationRegistry(),
  };
}

async function paneField(
  runner: CommandRunner,
  addr: PaneAddress,
  field: string,
): Promise<string | null> {
  const result = await runner.run("tmux", [
    ...tmuxSocketArgs(addr.tmuxSocket),
    "display-message",
    "-p",
    "-t",
    addr.tmuxTarget,
    `#{${field}}`,
  ]);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

async function panePid(runner: CommandRunner, addr: PaneAddress): Promise<number | null> {
  const raw = await paneField(runner, addr, "pane_pid");
  const pid = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function rssBytesOf(runner: CommandRunner, pid: number): Promise<number | null> {
  const result = await runner.run("ps", ["-o", "rss=", "-p", String(pid)]);
  if (result.code !== 0) return null;
  return parseRssBytesFromPs(result.stdout);
}

/**
 * The OS process start token (`ps -o lstart=`), normalized to a single-spaced
 * opaque string. Two processes sharing a pid but not a start token are DIFFERENT
 * process instances, so this pins the generation against pid reuse. Returns null
 * when the pid is gone (no ps row).
 */
async function processStartToken(runner: CommandRunner, pid: number): Promise<string | null> {
  const result = await runner.run("ps", ["-o", "lstart=", "-p", String(pid)]);
  if (result.code !== 0) return null;
  const token = result.stdout.trim().replace(/\s+/g, " ");
  return token.length > 0 ? token : null;
}

/**
 * Read the pane's current process generation: its foreground pid, whether the
 * pane is dead (only an explicit `pane_dead=0` is live; null/"1" ⇒ dead/gone),
 * and the pid's start token. `startToken` is null when the pane has no live pid.
 */
async function readPaneGeneration(
  runner: CommandRunner,
  addr: PaneAddress,
): Promise<{ pid: number | null; dead: boolean; startToken: string | null }> {
  const pid = await panePid(runner, addr);
  const deadRaw = await paneField(runner, addr, "pane_dead");
  const dead = deadRaw !== "0";
  const startToken = pid != null ? await processStartToken(runner, pid) : null;
  return { pid, dead, startToken };
}

/**
 * True only if the pane provably still hosts the EXACT expected live generation:
 * the pane's foreground pid equals the expected pid, the pane is not dead, the
 * pid is a live process, and its current start token matches the expected one
 * (defeating pid reuse). Any drift ⇒ false (the expected process is gone / not
 * ours), so a signal is never sent to a reused or replaced pid.
 */
async function paneHostsGeneration(
  runner: CommandRunner,
  addr: PaneAddress,
  expected: ProcessGeneration,
  processAlive: (pid: number) => boolean,
): Promise<boolean> {
  const current = await readPaneGeneration(runner, addr);
  return (
    current.pid === expected.pid &&
    !current.dead &&
    current.startToken != null &&
    current.startToken === expected.startToken &&
    processAlive(expected.pid)
  );
}

/**
 * TERM then bounded KILL a process addressed by its pane + generation. The pane
 * is re-verified to still host the exact expected live generation immediately
 * before EVERY signal; the moment it no longer does (exit, pane death, or pid
 * reuse with a different start token) the process is treated as confirmed gone
 * and no further signal is sent. Shared by pre-hibernation stop and failed-wake
 * attempt cleanup. Resolves whether the generation is confirmed gone.
 */
async function terminateGeneration(
  addr: PaneAddress,
  expected: ProcessGeneration,
  deps: ResolvedProcessDeps,
): Promise<boolean> {
  const stillOurs = () => paneHostsGeneration(deps.runner, addr, expected, deps.processAlive);
  if (!(await stillOurs())) return true;
  try {
    deps.sendSignal(expected.pid, "SIGTERM");
  } catch {
    // Raced to exit between the verification and the signal.
    return !(await stillOurs());
  }
  const deadline = deps.now() + deps.stopGraceMs;
  while (deps.now() < deadline) {
    await deps.sleep(deps.pollMs);
    if (!(await stillOurs())) return true;
  }
  if (!(await stillOurs())) return true;
  try {
    deps.sendSignal(expected.pid, "SIGKILL");
  } catch {
    // Raced to exit during escalation.
  }
  await deps.sleep(deps.pollMs);
  return !(await stillOurs());
}

export function createHibernationProcessController(
  deps: RuntimeAdapterDeps = {},
): HibernationProcessController {
  const d = resolveProcessDeps(deps);

  async function runtimeAlive(
    spec: AgentRuntimeSpec,
  ): Promise<{ alive: boolean; generation: ProcessGeneration | null }> {
    const addr: PaneAddress = { tmuxSocket: spec.tmuxSocket, tmuxTarget: spec.tmuxTarget };
    const current = await readPaneGeneration(d.runner, addr);
    const alive =
      current.pid != null &&
      !current.dead &&
      current.startToken != null &&
      d.processAlive(current.pid);
    return {
      alive,
      generation:
        alive && current.pid != null && current.startToken != null
          ? { pid: current.pid, startToken: current.startToken }
          : null,
    };
  }

  return {
    async requestCheckpoint(spec: AgentRuntimeSpec): Promise<HibernationCheckpointOutcome> {
      // Contract (narrowed, evidence-backed): a `hibernateSafe` result asserts
      // the RESUMABILITY PRECONDITION — the recorded pane still hosts a live
      // process generation (pane-authoritative pid, `pane_dead=0`, live pid with
      // a readable start token) AND the session `.jsonl` exists and is NON-EMPTY
      // on disk. It does NOT perform a cooperative in-flight flush/ack handshake
      // with Pi (which would require Pi-side support and is future work); the
      // orchestrator additionally refuses to hibernate while any inbox work is
      // pending/arriving, so a mid-turn runtime is not silently discarded.
      const { alive, generation } = await runtimeAlive(spec);
      const rssBytes = generation != null ? await rssBytesOf(d.runner, generation.pid) : null;
      const pendingInboxCount = d.pendingInboxCount(spec.agentId);
      const base = { sessionResumeRef: spec.sessionResumeRef, pendingInboxCount, rssBytes };
      if (!alive) {
        return { hibernateSafe: false, reason: "runtime_not_alive", ...base };
      }
      const resumePath = resumePathFromSessionRef(spec.sessionResumeRef);
      const sessionBytes = resumePath != null ? d.sessionByteSize(resumePath) : null;
      if (sessionBytes == null) {
        return { hibernateSafe: false, reason: "session_unresumable", ...base };
      }
      if (sessionBytes <= 0) {
        return { hibernateSafe: false, reason: "session_empty", ...base };
      }
      return { hibernateSafe: true, reason: null, ...base };
    },

    async stopRuntime(
      spec: AgentRuntimeSpec,
    ): Promise<{ stopped: boolean; rssBytes: number | null }> {
      const addr: PaneAddress = { tmuxSocket: spec.tmuxSocket, tmuxTarget: spec.tmuxTarget };
      // Capture the live generation to stop BEFORE any mutation; if the pane is
      // already dead / has no live generation there is nothing to stop.
      const current = await readPaneGeneration(d.runner, addr);
      if (current.pid == null || current.dead || current.startToken == null) {
        return { stopped: true, rssBytes: null };
      }
      if (!d.processAlive(current.pid)) return { stopped: true, rssBytes: null };
      const generation: ProcessGeneration = { pid: current.pid, startToken: current.startToken };
      const rssBytes = await rssBytesOf(d.runner, generation.pid);
      // Ensure the pane survives the Pi exit BEFORE stopping it, so hibernation
      // requires no change to the worker spawn path. With remain-on-exit on,
      // killing the pane's foreground Pi leaves the tmux session intact and
      // operator-attachable, and a wake can respawn into the (now dead) pane.
      await d.runner.run("tmux", [
        ...tmuxSocketArgs(spec.tmuxSocket),
        "set-option",
        "-t",
        spec.tmuxSession,
        "remain-on-exit",
        "on",
      ]);
      const stopped = await terminateGeneration(addr, generation, d);
      return { stopped, rssBytes };
    },

    async isRuntimeAlive(spec: AgentRuntimeSpec): Promise<boolean> {
      return (await runtimeAlive(spec)).alive;
    },

    async stopLaunchedAttempt(handle: RuntimeAttemptHandle): Promise<{ stopped: boolean }> {
      // Bind to the generation THIS attempt recorded at respawn. A miss (no
      // recorded generation ⇒ pid/start token were never captured) is unprovable,
      // so fail closed rather than risk relaunching over a live runtime.
      const generation = d.attemptRegistry.get(handle.reservationNonce);
      if (!generation) return { stopped: false };
      const addr: PaneAddress = {
        tmuxSocket: generation.tmuxSocket,
        tmuxTarget: generation.tmuxTarget,
      };
      const stopped = await terminateGeneration(addr, generation, d);
      if (stopped) d.attemptRegistry.clear(handle.reservationNonce);
      return { stopped };
    },

    async isLaunchedAttemptAlive(handle: RuntimeAttemptHandle): Promise<boolean> {
      // Unprovable (no recorded generation) ⇒ treat as still alive so cleanup
      // never assumes a phantom exit.
      const generation = d.attemptRegistry.get(handle.reservationNonce);
      if (!generation) return true;
      const addr: PaneAddress = {
        tmuxSocket: generation.tmuxSocket,
        tmuxTarget: generation.tmuxTarget,
      };
      return paneHostsGeneration(d.runner, addr, generation, d.processAlive);
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
  /** Private, owner-only directory launchers are materialized in (lazily made). */
  launcherDir?: string;
  writeFile?: (filePath: string, content: string, mode: number) => void;
  unlink?: (filePath: string) => void;
  readEnv?: (key: string) => string | undefined;
  /** Shared attempt-generation registry (created if omitted). */
  attemptRegistry?: AttemptGenerationRegistry;
  /** Injectable liveness for the captured pid's start token verification. */
  processAlive?: (pid: number) => boolean;
}

export function createHibernationTmuxController(
  deps: RuntimeRespawnDeps,
): HibernationTmuxController {
  const runner = deps.runner ?? createExecFileRunner();
  const writeFile =
    deps.writeFile ?? ((filePath, content, mode) => fs.writeFileSync(filePath, content, { mode }));
  const unlink =
    deps.unlink ??
    ((filePath) => {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best effort: already gone (e.g. the launcher self-deleted).
      }
    });
  const readEnv = deps.readEnv ?? ((key) => process.env[key]);
  const attemptRegistry = deps.attemptRegistry ?? createAttemptGenerationRegistry();
  const buildNickname =
    deps.buildNickname ??
    ((ctx) => `Woken ${ctx.spec.launchSource || "worker"} ${ctx.reservationNonce.slice(0, 8)}`);

  // Private, owner-only launcher dir (0700), created lazily so constructing the
  // controller has no filesystem side effect and tests can inject an explicit dir.
  let launcherDir = deps.launcherDir;
  const resolveLauncherDir = (): string => {
    if (launcherDir) return launcherDir;
    launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-wake-"));
    return launcherDir;
  };

  return {
    async isSessionAttachable(spec: AgentRuntimeSpec): Promise<boolean> {
      const result = await runner.run("tmux", [
        ...tmuxSocketArgs(spec.tmuxSocket),
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

      const addr: PaneAddress = { tmuxSocket: spec.tmuxSocket, tmuxTarget: spec.tmuxTarget };
      // Destructive-wake guard (independent-review P1): only respawn when the
      // EXACT recorded pane is present AND explicitly dead. A missing pane cannot
      // be woken; a LIVE pane must never be clobbered (drift / manual recovery /
      // ambiguous state), so we neither force-kill it with `respawn-pane -k` nor
      // proceed. `respawn-pane` (no `-k`) additionally refuses a non-dead pane at
      // the tmux layer, giving defence in depth.
      const sessionPresent =
        (
          await runner.run("tmux", [
            ...tmuxSocketArgs(spec.tmuxSocket),
            "has-session",
            "-t",
            spec.tmuxSession,
          ])
        ).code === 0;
      if (!sessionPresent) return { launched: false, handle: null };
      const deadRaw = await paneField(runner, addr, "pane_dead");
      if (deadRaw !== "1") return { launched: false, handle: null };

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

      const launcherPath = path.join(resolveLauncherDir(), `pinet-wake-${ctx.reservationNonce}.sh`);
      let launched = false;
      try {
        writeFile(launcherPath, script, 0o700);
        // No `-k`: only a dead pane is respawned (guarded above); a live pane is
        // never force-killed.
        const result = await runner.run("tmux", [
          ...tmuxSocketArgs(spec.tmuxSocket),
          "respawn-pane",
          "-t",
          spec.tmuxTarget,
          launcherPath,
        ]);
        if (result.code !== 0) return { launched: false, handle: null };
        launched = true;

        // Bind the launched attempt to its exact process generation so retry
        // cleanup can prove THIS process (not a reused pid) is gone.
        const pid = await panePid(runner, addr);
        const startToken = pid != null ? await processStartToken(runner, pid) : null;
        if (pid != null && startToken != null) {
          attemptRegistry.record(ctx.reservationNonce, {
            pid,
            startToken,
            tmuxSocket: spec.tmuxSocket,
            tmuxTarget: spec.tmuxTarget,
          });
        }
        return {
          launched: true,
          handle: { reservationNonce: ctx.reservationNonce, tmuxTarget: spec.tmuxTarget, pid },
        };
      } finally {
        // Guaranteed cleanup of the secret-bearing launcher: on the happy path
        // the script self-deletes (`rm -f "$0"` before exec), so unlinking here
        // could race the pane shell's open — only remove the orphan on the
        // FAILURE path (where the launcher never exec'd).
        if (!launched) unlink(launcherPath);
      }
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
