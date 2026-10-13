import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalEvaluation, GoalStorage } from "./domain.js";
import { MemoryGoalStorage } from "./memory-storage.js";
import { SqliteGoalStorage } from "./sqlite-storage.js";
import { GoalRuntime, type GoalRuntimeOptions } from "./runtime.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.each(["memory", "sqlite"])("network cancellation boundaries (%s)", (backend) => {
  let storage: GoalStorage;
  let directory: string;
  let now: number;
  const runtimes: GoalRuntime[] = [];
  const evaluate = vi.fn<() => Promise<GoalEvaluation>>();
  const continueIfIdle = vi.fn().mockResolvedValue({ status: "started" });
  const schedule = vi.fn();
  const makeRuntime = (options: GoalRuntimeOptions = {}): GoalRuntime => {
    const runtime = new GoalRuntime(
      storage,
      { evaluate },
      { continueIfIdle },
      () => new Date(now),
      {
        wakeScheduler: { schedule, cancel: vi.fn(), close: vi.fn() },
        ...options,
      },
    );
    runtimes.push(runtime);
    return runtime;
  };
  beforeEach(() => {
    vi.clearAllMocks();
    now = Date.parse("2026-10-12T00:00:00Z");
    directory = mkdtempSync(join(tmpdir(), "goal-network-races-"));
    storage =
      backend === "memory"
        ? new MemoryGoalStorage()
        : new SqliteGoalStorage(join(directory, "goals.sqlite"));
    evaluate.mockReset().mockResolvedValue({ outcome: "continue", reason: "keep working" });
  });
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.close(false);
    storage.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("pause accounts outage usage atomically without evaluation and resume remains runnable", async () => {
    const runtime = makeRuntime();
    await runtime.create("session", "ship");
    await runtime.settle(
      "session",
      { latestOutput: "outage", tokenDelta: 3 },
      { deferEvaluation: true },
    );
    runtime.holdDeferredSettlement("session");
    await runtime.setStatus("session", "paused");
    expect(evaluate).not.toHaveBeenCalled();
    expect(await runtime.get("session")).toMatchObject({
      status: "paused",
      usage: { iterations: 1, tokens: 3 },
    });
    expect(await storage.getPendingEvaluation("session")).toBeUndefined();
    await runtime.setStatus("session", "active");
    await runtime.start("session");
    expect(continueIfIdle).toHaveBeenCalledTimes(1);
    evaluate.mockResolvedValueOnce({ outcome: "complete", reason: "verified" });
    await runtime.settle("session", { latestOutput: "done", tokenDelta: 4 });
    expect(await runtime.get("session")).toMatchObject({
      status: "complete",
      usage: { iterations: 2, tokens: 7 },
    });
  });

  it("accounted outage usage prevents a resumed goal exceeding its turn limit", async () => {
    const runtime = makeRuntime();
    await runtime.create("session", "ship", { maxIterations: 1 });
    await runtime.settle(
      "session",
      { latestOutput: "outage", tokenDelta: 3 },
      { deferEvaluation: true },
    );
    runtime.holdDeferredSettlement("session");
    await runtime.setStatus("session", "paused");
    await runtime.setStatus("session", "active");
    await runtime.start("session");
    expect(continueIfIdle).not.toHaveBeenCalled();
    expect(await runtime.get("session")).toMatchObject({
      status: "budget_limited",
      usage: { iterations: 1, tokens: 3 },
    });
  });

  it("snooze expiry releases a cancelled outage hold and accounts progress", async () => {
    const runtime = makeRuntime();
    await runtime.create("session", "ship");
    await runtime.settle(
      "session",
      { latestOutput: "outage", tokenDelta: 3 },
      { deferEvaluation: true },
    );
    runtime.holdDeferredSettlement("session");
    await runtime.snooze("session", 30_000);
    const wake = schedule.mock.calls.at(-1)?.[2] as () => void;
    now += 30_000;
    wake();
    await vi.waitFor(() => expect(continueIfIdle).toHaveBeenCalledTimes(1));
    expect(await runtime.get("session")).toMatchObject({ usage: { iterations: 1, tokens: 3 } });
  });

  it("cancelled retry cannot run another evaluation even after the hold is released", async () => {
    const retry = deferred<void>();
    const delay = vi.fn(() => retry.promise);
    evaluate
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ outcome: "complete", reason: "stale retry" });
    const runtime = makeRuntime({ delay });
    const goal = await runtime.create("session", "ship");
    await runtime.settle(
      "session",
      { latestOutput: "outage", tokenDelta: 3 },
      { deferEvaluation: true },
    );
    const recovering = runtime.resumeDeferredSettlement("session", goal);
    await vi.waitFor(() => expect(delay).toHaveBeenCalledTimes(1));
    runtime.holdDeferredSettlement("session");
    runtime.releaseDeferredSettlement("session");
    retry.resolve();
    await recovering;
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(await runtime.get("session")).toMatchObject({
      status: "active",
      usage: { iterations: 0 },
    });
  });

  it("cancelling at the claimed event prevents dispatch after the await", async () => {
    const observed = deferred<void>();
    const release = deferred<void>();
    const runtime = makeRuntime({
      eventSink: {
        record: async (event) => {
          if (event.type === "goal.continuation_claimed") {
            observed.resolve();
            await release.promise;
          }
        },
      },
    });
    const goal = await runtime.create("session", "ship");
    await runtime.settle(
      "session",
      { latestOutput: "outage", tokenDelta: 3 },
      { deferEvaluation: true },
    );
    const recovering = runtime.resumeDeferredSettlement("session", goal);
    await observed.promise;
    runtime.holdDeferredSettlement("session");
    runtime.releaseDeferredSettlement("session");
    release.resolve();
    await recovering;
    expect(continueIfIdle).not.toHaveBeenCalled();
  });

  it("an asynchronous storage commit checks cancellation at the atomic mutation", async () => {
    const observed = deferred<void>();
    const release = deferred<void>();
    evaluate.mockResolvedValue({ outcome: "complete", reason: "stale result" });
    const runtime = makeRuntime();
    const goal = await runtime.create("session", "ship");
    await runtime.settle(
      "session",
      { latestOutput: "outage", tokenDelta: 3 },
      { deferEvaluation: true },
    );
    const commit = storage.commitEvaluation.bind(storage);
    vi.spyOn(storage, "commitEvaluation").mockImplementationOnce(async (...args) => {
      observed.resolve();
      await release.promise;
      return commit(...args);
    });
    const recovering = runtime.resumeDeferredSettlement("session", goal);
    await observed.promise;
    runtime.holdDeferredSettlement("session");
    runtime.releaseDeferredSettlement("session");
    release.resolve();
    await recovering;
    expect(await runtime.get("session")).toMatchObject({
      status: "active",
      usage: { iterations: 0 },
    });
    expect(await storage.getPendingEvaluation("session")).toMatchObject({
      iterationsDelta: 1,
      progress: { tokenDelta: 3 },
    });
  });

  it("a new normal settlement drains after a cancelled network evaluator exits", async () => {
    const evaluation = deferred<GoalEvaluation>();
    evaluate
      .mockImplementationOnce(() => evaluation.promise)
      .mockResolvedValue({ outcome: "complete", reason: "user finished" });
    const runtime = makeRuntime();
    const goal = await runtime.create("session", "ship");
    await runtime.settle(
      "session",
      { latestOutput: "outage", tokenDelta: 3 },
      { deferEvaluation: true },
    );
    const recovering = runtime.resumeDeferredSettlement("session", goal);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    runtime.holdDeferredSettlement("session");
    await runtime.settle("session", { latestOutput: "user finished", tokenDelta: 4 });
    evaluation.resolve({ outcome: "complete", reason: "stale network answer" });
    await recovering;
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(await runtime.get("session")).toMatchObject({
      status: "complete",
      usage: { iterations: 2, tokens: 7 },
    });
  });
});
