import { spawn } from "node:child_process";

export interface ClaudeRunOptions {
  claudeBin: string;
  cwd: string;
  prompt: string;
  resumeSessionId?: string | null;
  model?: string | null;
  timeoutMs: number;
  /** Abort kills the running task (used for mesh interrupt commands). */
  signal?: AbortSignal;
}

export interface ClaudeRunResult {
  ok: boolean;
  text: string;
  sessionId: string | null;
  isError: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stderrTail: string;
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  is_error?: boolean;
}

const KILL_GRACE_MS = 10000;
const OUTPUT_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Parse `claude -p --output-format json` stdout: a single JSON object, but be
 * tolerant of stray non-JSON lines by scanning from the last line backwards
 * for an object with type === "result".
 */
export function parseClaudeJsonOutput(
  stdout: string,
): { text: string; sessionId: string | null; isError: boolean } | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));

  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: ClaudeJsonResult;
    try {
      parsed = JSON.parse(lines[i]) as ClaudeJsonResult;
    } catch {
      continue;
    }
    if (parsed.type === "result") {
      return {
        text: typeof parsed.result === "string" ? parsed.result : "",
        sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
        isError: parsed.is_error === true || parsed.subtype !== "success",
      };
    }
  }
  return null;
}

export function buildClaudeArgs(options: {
  resumeSessionId?: string | null;
  model?: string | null;
}): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    ...(options.resumeSessionId ? ["--resume", options.resumeSessionId] : []),
    ...(options.model ? ["--model", options.model] : []),
  ];
}

/** Run one headless Claude Code task; prompt is passed via stdin. */
export function runClaudeTask(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const child = spawn(options.claudeBin, buildClaudeArgs(options), {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const killChild = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, KILL_GRACE_MS).unref?.();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killChild();
    }, options.timeoutMs);
    timeout.unref?.();

    const onAbort = () => killChild();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP_BYTES) stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP_BYTES) stderr += chunk.toString("utf-8");
    });

    const settle = (exitCode: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);

      const parsed = parseClaudeJsonOutput(stdout);
      const stderrTail = stderr.slice(-2000);
      if (spawnError) {
        resolve({
          ok: false,
          text: `Failed to launch Claude Code: ${spawnError.message}`,
          sessionId: null,
          isError: true,
          exitCode: null,
          timedOut,
          stderrTail,
        });
        return;
      }
      if (!parsed) {
        resolve({
          ok: false,
          text: timedOut
            ? `Task timed out after ${Math.round(options.timeoutMs / 60000)} minutes.`
            : `Claude Code exited (code ${exitCode ?? "unknown"}) without a parseable result.`,
          sessionId: null,
          isError: true,
          exitCode,
          timedOut,
          stderrTail,
        });
        return;
      }
      resolve({
        ok: !parsed.isError && exitCode === 0,
        text: parsed.text,
        sessionId: parsed.sessionId,
        isError: parsed.isError,
        exitCode,
        timedOut,
        stderrTail,
      });
    };

    child.on("error", (err) => settle(null, err));
    child.on("close", (code) => settle(code));

    child.stdin.write(options.prompt, "utf-8");
    child.stdin.end();
  });
}
