import { describe, it, expect, vi } from "vitest";
import {
  createGitContextCache,
  probeGitBranch,
  probeGitContext,
  probeGitDynamic,
  type ExecFileAsyncLike,
} from "./git-metadata.js";

describe("probeGitBranch", () => {
  it("returns the live branch when git succeeds", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async () => ({ stdout: "main\n" }));

    await expect(probeGitBranch("/Users/alice/src/extensions", runner)).resolves.toBe("main");
  });

  it("returns undefined when branch lookup fails", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async () => {
      throw new Error("not a git repo");
    });

    await expect(probeGitBranch("/tmp/scratch", runner)).resolves.toBeUndefined();
  });
});

describe("probeGitContext", () => {
  it("returns repo, repoRoot, branch, and dirty signal when git commands succeed", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async (_file, args) => {
      if (args[0] === "rev-parse") {
        return { stdout: "/Users/alice/src/extensions\n" };
      }
      if (args[0] === "branch") {
        return { stdout: "main\n" };
      }
      if (args[0] === "status") {
        return { stdout: "" };
      }
      throw new Error("unexpected command");
    });

    await expect(
      probeGitContext("/Users/alice/src/extensions/slack-bridge", runner),
    ).resolves.toEqual({
      cwd: "/Users/alice/src/extensions/slack-bridge",
      repo: "extensions",
      repoRoot: "/Users/alice/src/extensions",
      branch: "main",
      dirty: false,
      dirtyFileCount: 0,
    });
  });

  it("falls back to cwd basename when not in a git repo", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async () => {
      throw new Error("not a git repo");
    });

    await expect(probeGitContext("/tmp/scratch", runner)).resolves.toEqual({
      cwd: "/tmp/scratch",
      repo: "scratch",
      repoRoot: undefined,
    });
  });

  it("treats blank git output as undefined", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async (_file, args) => {
      if (args[0] === "rev-parse") {
        return { stdout: "\n" };
      }
      if (args[0] === "branch") {
        return { stdout: "   \n" };
      }
      if (args[0] === "status") {
        return { stdout: "" };
      }
      throw new Error("unexpected command");
    });

    await expect(probeGitContext("/tmp/scratch", runner)).resolves.toEqual({
      cwd: "/tmp/scratch",
      repo: "scratch",
      repoRoot: undefined,
      dirty: false,
      dirtyFileCount: 0,
    });
  });
});

describe("probeGitDynamic", () => {
  it("returns live branch and clean dirty state when git succeeds", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async (_file, args) => {
      if (args[0] === "branch") {
        return { stdout: "feat/runtime-metadata\n" };
      }
      if (args[0] === "status") {
        return { stdout: "" };
      }
      throw new Error("unexpected command");
    });

    await expect(probeGitDynamic("/Users/alice/repo", runner)).resolves.toEqual({
      branch: "feat/runtime-metadata",
      dirty: false,
      dirtyFileCount: 0,
      probeFailed: false,
    });
  });

  it("flags dirty trees and counts entries", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async (_file, args) => {
      if (args[0] === "branch") {
        return { stdout: "main\n" };
      }
      if (args[0] === "status") {
        return { stdout: " M a.ts\n?? b.ts\n" };
      }
      throw new Error("unexpected command");
    });

    await expect(probeGitDynamic("/Users/alice/repo", runner)).resolves.toEqual({
      branch: "main",
      dirty: true,
      dirtyFileCount: 2,
      probeFailed: false,
    });
  });

  it("does not report clean when status fails", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async (_file, args) => {
      if (args[0] === "branch") {
        return { stdout: "main\n" };
      }
      throw new Error("status unavailable");
    });

    await expect(probeGitDynamic("/Users/alice/repo", runner)).resolves.toEqual({
      branch: "main",
      probeFailed: true,
    });
  });

  it("omits branch on detached HEAD instead of inventing one", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async (_file, args) => {
      if (args[0] === "branch") {
        return { stdout: "\n" };
      }
      if (args[0] === "status") {
        return { stdout: " M a.ts\n" };
      }
      throw new Error("unexpected command");
    });

    await expect(probeGitDynamic("/Users/alice/repo", runner)).resolves.toEqual({
      dirty: true,
      dirtyFileCount: 1,
      probeFailed: false,
    });
  });
});

describe("createGitContextCache", () => {
  it("caches the loaded result", async () => {
    const loader = vi.fn(async () => ({
      cwd: "/tmp/project",
      repo: "project",
      repoRoot: "/tmp/project",
      branch: "main",
    }));

    const cache = createGitContextCache(loader);

    await expect(cache.get()).resolves.toMatchObject({ repo: "project" });
    await expect(cache.get()).resolves.toMatchObject({ repo: "project" });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.peek()).toMatchObject({ repo: "project" });
  });

  it("shares a single in-flight request", async () => {
    let resolveLoader!: (value: { cwd: string; repo: string }) => void;
    const promise = new Promise<{ cwd: string; repo: string }>((resolve) => {
      resolveLoader = resolve;
    });
    const loader = vi.fn(() => promise);

    const cache = createGitContextCache(loader);
    const a = cache.get();
    const b = cache.get();

    expect(loader).toHaveBeenCalledTimes(1);
    resolveLoader({ cwd: "/tmp/project", repo: "project" });

    await expect(a).resolves.toMatchObject({ repo: "project" });
    await expect(b).resolves.toMatchObject({ repo: "project" });
  });

  it("clear resets the cache", async () => {
    const loader = vi.fn(async () => ({ cwd: "/tmp/a", repo: "a" }));
    loader.mockResolvedValueOnce({ cwd: "/tmp/a", repo: "a" });
    loader.mockResolvedValueOnce({ cwd: "/tmp/b", repo: "b" });

    const cache = createGitContextCache(loader);
    await cache.get();
    cache.clear();
    await expect(cache.get()).resolves.toMatchObject({ repo: "b" });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
