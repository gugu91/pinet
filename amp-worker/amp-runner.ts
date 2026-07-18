/**
 * Owns Amp CLI child processes for the worker.
 *
 * Verified Amp CLI contract (see plans/amp-worker-architecture.md):
 * - `amp threads new` creates an empty thread and prints its ID to stdout.
 * - `amp threads continue <thread> -x --stream-json -m <mode>` resumes a
 *   thread, reads the user message from stdin, streams JSON events on stdout,
 *   and exits when the turn ends.
 * - Modes: low | medium | high | ultra (`-m/--mode`).
 * - Amp has no external cancel API; the only sound interrupt is signalling a
 *   locally owned child process (SIGTERM, escalating to SIGKILL if the child
 *   ignores it).
 *
 * The message is delivered via stdin instead of an argv value so message
 * bodies never appear in the process table and cannot be confused with flags.
 *
 * Termination semantics: an operator/control interrupt reports the run as
 * "interrupted"; an execution-timeout kill reports it as "error" (the work was
 * not asked to stop — it overran its budget).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { AmpStreamParser } from "./amp-stream.js";

export const AMP_MODES = ["low", "medium", "high", "ultra"] as const;

export type AmpMode = (typeof AMP_MODES)[number];

export function parseAmpMode(value: string): AmpMode {
  const normalized = value.trim().toLowerCase();
  if ((AMP_MODES as readonly string[]).includes(normalized)) {
    return normalized as AmpMode;
  }
  throw new Error(`Invalid Amp mode "${value}". Valid modes: ${AMP_MODES.join(", ")}.`);
}

export interface AmpExecutionResult {
  status: "ok" | "error" | "interrupted";
  /** Final agent message from the stream `result` event, when present. */
  resultText: string | null;
  /** Amp thread ID reported by the stream (`session_id`), when present. */
  ampThreadId: string | null;
  exitCode: number | null;
  signal: string | null;
  /** Bounded tail of stderr for diagnostics. Never contains the prompt. */
  stderrTail: string;
}

export interface AmpRunnerOptions {
  /** Amp CLI executable, default "amp". */
  ampCommand?: string;
  /** Working directory Amp runs in (repo/worktree the worker serves). */
  cwd: string;
  /** Agent mode passed via `-m`. */
  mode: AmpMode;
  /** Extra environment merged over process.env (test seam). */
  env?: NodeJS.ProcessEnv;
  /** Per-execution timeout; the child is killed when exceeded. */
  executionTimeoutMs?: number;
  /** Timeout for fast setup commands like `amp threads new`. */
  setupTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL escalation. */
  killGraceMs?: number;
}

const DEFAULT_EXECUTION_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SETUP_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5000;
const STDERR_TAIL_LIMIT = 2000;
const THREAD_ID_PATTERN = /T-[0-9a-f-]{8,}/i;

type TerminationReason = "control" | "timeout";

export class AmpRunner {
  private readonly ampCommand: string;
  private readonly cwd: string;
  private readonly mode: AmpMode;
  private readonly env: NodeJS.ProcessEnv;
  private readonly executionTimeoutMs: number;
  private readonly setupTimeoutMs: number;
  private readonly killGraceMs: number;
  private currentChild: ChildProcess | null = null;
  private terminationReason: TerminationReason | null = null;
  private killEscalation: NodeJS.Timeout | null = null;

  constructor(options: AmpRunnerOptions) {
    this.ampCommand = options.ampCommand ?? "amp";
    this.cwd = options.cwd;
    this.mode = options.mode;
    this.env = options.env ?? process.env;
    this.executionTimeoutMs = options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.setupTimeoutMs = options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  isBusy(): boolean {
    return this.currentChild !== null;
  }

  /**
   * SIGTERM the currently owned Amp child process, if any, escalating to
   * SIGKILL after a grace period. Only locally owned processes are ever
   * signalled; there is no remote Amp cancellation API.
   */
  interrupt(): boolean {
    return this.terminate(this.currentChild, "control");
  }

  /**
   * All termination state is scoped to a specific child so a stale event or
   * timer from a settled run can never signal or release a newer child.
   */
  private terminate(child: ChildProcess | null, reason: TerminationReason): boolean {
    if (!child || this.currentChild !== child) return false;
    if (this.terminationReason !== null) {
      // A termination is already in progress; do not downgrade a control
      // interrupt to a timeout or vice versa, and keep the escalation timer.
      return true;
    }
    let signalled = false;
    try {
      signalled = child.kill("SIGTERM");
    } catch {
      signalled = false;
    }
    if (!signalled) return false;
    this.terminationReason = reason;
    this.killEscalation = setTimeout(() => {
      if (this.currentChild !== child) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* the child settled between the check and the kill */
      }
    }, this.killGraceMs);
    this.killEscalation.unref?.();
    return true;
  }

  /**
   * Release ownership when a child settles. No-ops unless the settling child
   * is still the owned one, so a late `close` after an `error`-path release
   * (or after a newer run started) cannot clear the newer child's state.
   */
  private releaseChild(child: ChildProcess): TerminationReason | null {
    if (this.currentChild !== child) return null;
    const reason = this.terminationReason;
    this.currentChild = null;
    this.terminationReason = null;
    if (this.killEscalation) {
      clearTimeout(this.killEscalation);
      this.killEscalation = null;
    }
    return reason;
  }

  /**
   * `amp threads new` — create an empty Amp thread and return its ID. The
   * child is owned like any other run so exit/interrupt controls can stop a
   * hung creation, and it is bounded by the setup timeout.
   */
  async createThread(): Promise<string> {
    if (this.currentChild) {
      throw new Error("AmpRunner is busy: one Amp execution at a time per worker.");
    }
    const { stdout, stderrTail, exitCode, terminationReason } = await this.runOwnedToCompletion(
      ["threads", "new"],
      this.setupTimeoutMs,
    );
    if (terminationReason) {
      throw new Error(
        terminationReason === "control"
          ? `"${this.ampCommand} threads new" was interrupted.`
          : `"${this.ampCommand} threads new" timed out after ${this.setupTimeoutMs}ms.`,
      );
    }
    if (exitCode !== 0) {
      throw new Error(
        `"${this.ampCommand} threads new" exited with code ${exitCode}${stderrTail ? `: ${stderrTail}` : ""}`,
      );
    }
    const match = THREAD_ID_PATTERN.exec(stdout);
    if (!match) {
      throw new Error(`"${this.ampCommand} threads new" did not print a thread ID.`);
    }
    return match[0];
  }

  /**
   * `amp threads continue <id> -x --stream-json -m <mode>` with the message on
   * stdin. Resolves with a bounded result; never rejects for Amp-side failures
   * so callers can persist a durable outcome instead of looping.
   */
  async continueThread(ampThreadId: string, message: string): Promise<AmpExecutionResult> {
    if (this.currentChild) {
      throw new Error("AmpRunner is busy: one Amp execution at a time per worker.");
    }

    const parser = new AmpStreamParser();
    const args = ["threads", "continue", ampThreadId, "-x", "--stream-json", "-m", this.mode];

    return await new Promise<AmpExecutionResult>((resolve, reject) => {
      let stderrTail = "";
      let settled = false;

      let child: ChildProcess;
      try {
        child = spawn(this.ampCommand, args, {
          cwd: this.cwd,
          env: this.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.currentChild = child;

      const timeout = setTimeout(() => {
        this.terminate(child, "timeout");
      }, this.executionTimeoutMs);
      timeout.unref?.();

      const settle = (result: AmpExecutionResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.releaseChild(child);
        reject(err);
      };

      child.stdout?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string) => {
        parser.push(chunk);
      });
      child.stderr?.setEncoding("utf-8");
      child.stderr?.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });

      child.on("error", (err) => {
        fail(new Error(`Failed to run "${this.ampCommand}": ${err.message}`));
      });

      child.on("close", (exitCode, signal) => {
        const terminationReason = this.releaseChild(child);
        parser.end();
        const outcome = parser.outcome;
        const isError = outcome.result?.isError === true || (exitCode !== null && exitCode !== 0);
        const timedOut = terminationReason === "timeout";
        settle({
          status:
            terminationReason === "control" ? "interrupted" : timedOut || isError ? "error" : "ok",
          resultText: outcome.result?.resultText ?? null,
          ampThreadId: outcome.result?.ampThreadId ?? ampThreadId,
          exitCode,
          signal,
          stderrTail: timedOut
            ? `Amp execution exceeded the ${this.executionTimeoutMs}ms timeout and was killed.${stderrTail ? ` ${stderrTail.trim()}` : ""}`
            : stderrTail.trim(),
        });
      });

      child.stdin?.on("error", () => {
        /* the close handler settles; a broken stdin pipe surfaces as exit status */
      });
      child.stdin?.end(message, "utf-8");
    });
  }

  private runOwnedToCompletion(
    args: string[],
    timeoutMs: number,
  ): Promise<{
    stdout: string;
    stderrTail: string;
    exitCode: number | null;
    terminationReason: TerminationReason | null;
  }> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.ampCommand, args, {
          cwd: this.cwd,
          env: this.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.currentChild = child;
      const timeout = setTimeout(() => {
        this.terminate(child, "timeout");
      }, timeoutMs);
      timeout.unref?.();

      let stdout = "";
      let stderrTail = "";
      child.stdout?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf-8");
      child.stderr?.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        this.releaseChild(child);
        reject(new Error(`Failed to run "${this.ampCommand}": ${err.message}`));
      });
      child.on("close", (exitCode) => {
        clearTimeout(timeout);
        const terminationReason = this.releaseChild(child);
        resolve({
          stdout: stdout.trim(),
          stderrTail: stderrTail.trim(),
          exitCode,
          terminationReason,
        });
      });
      child.stdin?.end();
    });
  }
}
