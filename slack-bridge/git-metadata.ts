import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ExecFileResult = { stdout?: string | Buffer };
const GIT_PROBE_TIMEOUT_MS = 2_000;

export type ExecFileAsyncLike = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    encoding: "utf-8";
    timeout: number;
    signal?: AbortSignal;
  },
) => Promise<ExecFileResult>;

export interface GitContext {
  cwd: string;
  repo: string;
  repoRoot?: string;
  branch?: string;
  dirty?: boolean;
  dirtyFileCount?: number;
}

export interface GitDynamicState {
  /** Current branch, omitted when detached/unknown/not in a repo. */
  branch?: string;
  /** Dirty flag, omitted when `git status` could not be read. */
  dirty?: boolean;
  /** Number of changed/untracked entries when dirty state is known. */
  dirtyFileCount?: number;
  /** True when any git probe failed; callers should treat omitted values as unknown. */
  probeFailed: boolean;
}

async function runGitCommand(
  args: string[],
  cwd: string,
  runner: ExecFileAsyncLike,
  signal?: AbortSignal,
): Promise<{ stdout: string | undefined; ok: boolean }> {
  signal?.throwIfAborted();
  try {
    const result = await runner("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: GIT_PROBE_TIMEOUT_MS,
      signal,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString();
    return { stdout, ok: true };
  } catch {
    signal?.throwIfAborted();
    return { stdout: undefined, ok: false };
  }
}

async function readGitTrimmed(
  args: string[],
  cwd: string,
  runner: ExecFileAsyncLike,
  signal?: AbortSignal,
): Promise<{ value: string | undefined; ok: boolean }> {
  const { stdout, ok } = await runGitCommand(args, cwd, runner, signal);
  const trimmed = stdout?.trim();
  return { value: trimmed ? trimmed : undefined, ok };
}

export async function probeGitBranch(
  cwd = process.cwd(),
  runner: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return (await readGitTrimmed(["branch", "--show-current"], cwd, runner, signal)).value;
}

async function probeGitDirty(
  cwd: string,
  runner: ExecFileAsyncLike,
  signal?: AbortSignal,
): Promise<{ dirty?: boolean; dirtyFileCount?: number; ok: boolean }> {
  const { stdout, ok } = await runGitCommand(
    ["status", "--porcelain", "--untracked-files=normal"],
    cwd,
    runner,
    signal,
  );
  if (!ok) {
    return { ok: false };
  }

  const dirtyFileCount = (stdout ?? "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0).length;
  return { dirty: dirtyFileCount > 0, dirtyFileCount, ok: true };
}

export async function probeGitDynamic(
  cwd = process.cwd(),
  runner: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike,
  signal?: AbortSignal,
): Promise<GitDynamicState> {
  const [branchProbe, dirtyProbe] = await Promise.all([
    readGitTrimmed(["branch", "--show-current"], cwd, runner, signal),
    probeGitDirty(cwd, runner, signal),
  ]);

  return {
    ...(branchProbe.value ? { branch: branchProbe.value } : {}),
    ...(typeof dirtyProbe.dirty === "boolean" ? { dirty: dirtyProbe.dirty } : {}),
    ...(typeof dirtyProbe.dirtyFileCount === "number"
      ? { dirtyFileCount: dirtyProbe.dirtyFileCount }
      : {}),
    probeFailed: !branchProbe.ok || !dirtyProbe.ok,
  };
}

export async function probeGitContext(
  cwd = process.cwd(),
  runner: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike,
  signal?: AbortSignal,
): Promise<GitContext> {
  const [{ value: repoRoot }, dynamic] = await Promise.all([
    readGitTrimmed(["rev-parse", "--show-toplevel"], cwd, runner, signal),
    probeGitDynamic(cwd, runner, signal),
  ]);
  const resolvedRepoRoot = repoRoot ?? cwd;

  return {
    cwd,
    repo: path.basename(resolvedRepoRoot),
    repoRoot,
    ...(dynamic.branch ? { branch: dynamic.branch } : {}),
    ...(typeof dynamic.dirty === "boolean" ? { dirty: dynamic.dirty } : {}),
    ...(typeof dynamic.dirtyFileCount === "number"
      ? { dirtyFileCount: dynamic.dirtyFileCount }
      : {}),
  };
}
