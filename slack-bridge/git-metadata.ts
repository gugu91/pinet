import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ExecFileResult = { stdout?: string | Buffer };
export type ExecFileAsyncLike = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: "utf-8" },
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
): Promise<{ stdout: string | undefined; ok: boolean }> {
  try {
    const result = await runner("git", args, { cwd, encoding: "utf-8" });
    const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString();
    return { stdout, ok: true };
  } catch {
    return { stdout: undefined, ok: false };
  }
}

async function readGitTrimmed(
  args: string[],
  cwd: string,
  runner: ExecFileAsyncLike,
): Promise<{ value: string | undefined; ok: boolean }> {
  const { stdout, ok } = await runGitCommand(args, cwd, runner);
  const trimmed = stdout?.trim();
  return { value: trimmed ? trimmed : undefined, ok };
}

export async function probeGitBranch(
  cwd = process.cwd(),
  runner: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike,
): Promise<string | undefined> {
  return (await readGitTrimmed(["branch", "--show-current"], cwd, runner)).value;
}

async function probeGitDirty(
  cwd: string,
  runner: ExecFileAsyncLike,
): Promise<{ dirty?: boolean; dirtyFileCount?: number; ok: boolean }> {
  const { stdout, ok } = await runGitCommand(
    ["status", "--porcelain", "--untracked-files=normal"],
    cwd,
    runner,
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
): Promise<GitDynamicState> {
  const branchProbe = await readGitTrimmed(["branch", "--show-current"], cwd, runner);
  const dirtyProbe = await probeGitDirty(cwd, runner);

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
): Promise<GitContext> {
  const repoRoot = (await readGitTrimmed(["rev-parse", "--show-toplevel"], cwd, runner)).value;
  const dynamic = await probeGitDynamic(cwd, runner);
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

export interface GitContextCache {
  get(): Promise<GitContext>;
  peek(): GitContext | null;
  clear(): void;
}

export function createGitContextCache(loader: () => Promise<GitContext>): GitContextCache {
  let cached: GitContext | null = null;
  let inflight: Promise<GitContext> | null = null;

  return {
    async get(): Promise<GitContext> {
      if (cached) return cached;
      if (inflight) return inflight;

      inflight = loader()
        .then((result) => {
          cached = result;
          return result;
        })
        .finally(() => {
          inflight = null;
        });

      return inflight;
    },

    peek(): GitContext | null {
      return cached;
    },

    clear(): void {
      cached = null;
      inflight = null;
    },
  };
}
