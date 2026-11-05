import { describe, it, expect, vi } from "vitest";
import {
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
  it("aborts an in-flight Git process", async () => {
    const controller = new AbortController();
    const runner: ExecFileAsyncLike = vi.fn(
      async (_file, _args, { signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const probing = probeGitContext("/tmp/project", runner, controller.signal);
    controller.abort();

    await expect(probing).rejects.toMatchObject({ name: "AbortError" });
  });

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

describe("probeGitContext concurrency", () => {
  it("runs repo-root discovery alongside the dynamic probes", async () => {
    const pending = new Map<string, (stdout: string) => void>();
    const runner: ExecFileAsyncLike = vi.fn(
      (_file, args) =>
        new Promise<{ stdout: string }>((resolve) => {
          pending.set(args[0] ?? "", (stdout) => resolve({ stdout }));
        }),
    );

    const probing = probeGitContext("/repo/pkg", runner);
    await vi.waitFor(() =>
      expect([...pending.keys()].sort()).toEqual(["branch", "rev-parse", "status"]),
    );
    pending.get("rev-parse")!("/repo\n");
    pending.get("branch")!("main\n");
    pending.get("status")!("");

    await expect(probing).resolves.toMatchObject({
      repo: "repo",
      repoRoot: "/repo",
      branch: "main",
    });
  });
});

describe("probeGitDynamic", () => {
  it("runs the branch and dirty probes concurrently", async () => {
    const pending = new Map<string, (stdout: string) => void>();
    const runner: ExecFileAsyncLike = vi.fn(
      (_file, args) =>
        new Promise<{ stdout: string }>((resolve) => {
          pending.set(args[0] ?? "", (stdout) => resolve({ stdout }));
        }),
    );

    const probing = probeGitDynamic("/repo", runner);
    await vi.waitFor(() => expect([...pending.keys()].sort()).toEqual(["branch", "status"]));
    pending.get("status")!(" M file.ts\n");
    pending.get("branch")!("main\n");

    await expect(probing).resolves.toEqual({
      branch: "main",
      dirty: true,
      dirtyFileCount: 1,
      probeFailed: false,
    });
  });

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
