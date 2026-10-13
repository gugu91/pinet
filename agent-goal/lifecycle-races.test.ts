import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGoal, GoalEvaluation, GoalStorage } from "./domain.js";
import { MemoryGoalStorage } from "./memory-storage.js";
import { SqliteGoalStorage } from "./sqlite-storage.js";
import { BLOCKED_RECHECK_INTERVAL_MS, GoalRuntime } from "./runtime.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.each(["memory", "sqlite"])("blocked recovery races (%s)", (backend) => {
  let directory: string;
  let storage: GoalStorage;
  let now: number;
  const runtimes: GoalRuntime[] = [];
  const evaluate = vi.fn<() => Promise<GoalEvaluation>>();
  const continueIfIdle = vi.fn().mockResolvedValue({ status: "started" });
  const schedule = vi.fn();
  const scheduler = { schedule, cancel: vi.fn(), close: vi.fn() };

  const makeRuntime = (): GoalRuntime => {
    const runtime = new GoalRuntime(
      storage,
      { evaluate },
      { continueIfIdle },
      () => new Date(now),
      {
        wakeScheduler: scheduler,
      },
    );
    runtimes.push(runtime);
    return runtime;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    now = Date.parse("2026-10-12T00:00:00Z");
    directory = mkdtempSync(join(tmpdir(), "goal-blocked-races-"));
    storage =
      backend === "memory"
        ? new MemoryGoalStorage()
        : new SqliteGoalStorage(join(directory, "goals.sqlite"));
    evaluate.mockResolvedValue({ outcome: "blocked", reason: "Need access" });
  });

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.close(false);
    storage.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("honors an in-flight snooze at actual timer wake and after restart", async () => {
    const evaluation = deferred<GoalEvaluation>();
    evaluate.mockImplementationOnce(() => evaluation.promise);
    const runtime = makeRuntime();
    await runtime.create("session", "ship");
    const settling = runtime.settle("session", { latestOutput: "waiting" });
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    const snoozed = await runtime.snooze("session", 60 * 60_000);
    evaluation.resolve({ outcome: "blocked", reason: "Need access" });
    await settling;
    expect(schedule).toHaveBeenLastCalledWith(
      "session",
      snoozed.snoozedUntil,
      expect.any(Function),
    );
    now += BLOCKED_RECHECK_INTERVAL_MS;
    const wake = schedule.mock.calls.at(-1)?.[2] as () => void;
    const calls = schedule.mock.calls.length;
    wake();
    await vi.waitFor(() => expect(schedule.mock.calls.length).toBeGreaterThan(calls));
    expect(continueIfIdle).not.toHaveBeenCalled();
    expect((await runtime.get("session"))?.snoozedUntil).toBe(snoozed.snoozedUntil);
    runtime.close(false);
    const restarted = makeRuntime();
    await restarted.recover("session");
    expect(schedule).toHaveBeenLastCalledWith(
      "session",
      snoozed.snoozedUntil,
      expect.any(Function),
    );
    now = Date.parse(snoozed.snoozedUntil!);
    await restarted.recover("session");
    expect(continueIfIdle).toHaveBeenCalledTimes(1);
    expect(await restarted.get("session")).toMatchObject({
      status: "active",
      snoozedUntil: undefined,
    });
  });

  it.each(["budget", "replacement"])(
    "rechecks identity, limits and deadline after a concurrent %s change",
    async (change) => {
      const runtime = makeRuntime();
      await runtime.create("session", "ship");
      await runtime.settle("session", { latestOutput: "waiting" });
      now += BLOCKED_RECHECK_INTERVAL_MS;
      const observed = deferred<void>();
      const release = deferred<void>();
      const get = storage.get.bind(storage);
      vi.spyOn(storage, "get").mockImplementationOnce(async (scope) => {
        const snapshot = await get(scope);
        observed.resolve();
        await release.promise;
        return snapshot;
      });
      const recovering = runtime.recover("session");
      await observed.promise;
      let replacement: AgentGoal | undefined;
      if (change === "budget") {
        await runtime.updateBudget("session", { maxIterations: 1 });
      } else {
        await runtime.clear("session");
        replacement = await runtime.create("session", "new goal");
        await runtime.settle("session", { latestOutput: "new blocker" });
      }
      release.resolve();
      await recovering;
      expect(continueIfIdle).not.toHaveBeenCalled();
      if (replacement) {
        expect(await runtime.get("session")).toMatchObject({
          id: replacement.id,
          status: "blocked",
        });
        expect(schedule).toHaveBeenLastCalledWith(
          "session",
          new Date(now + BLOCKED_RECHECK_INTERVAL_MS).toISOString(),
          expect.any(Function),
        );
      } else {
        expect(await runtime.get("session")).toMatchObject({ status: "budget_limited" });
      }
    },
  );

  it("does not delete a live claim installed after another owner reactivates the goal", async () => {
    const first = makeRuntime();
    const second = makeRuntime();
    await first.create("session", "ship");
    await first.settle("session", { latestOutput: "waiting" });
    now += BLOCKED_RECHECK_INTERVAL_MS;
    const replace = storage.replace.bind(storage);
    vi.spyOn(storage, "replace").mockImplementationOnce(async (goal, version) => {
      const committed = await replace(goal, version);
      expect(committed).toBe(true);
      await second.recover("session");
      return committed;
    });
    await first.recover("session");
    expect(continueIfIdle).toHaveBeenCalledTimes(1);
    const claim = await storage.getContinuationClaim("session");
    expect(claim).toMatchObject({
      state: "started",
      claimId: continueIfIdle.mock.calls[0][1].claimId,
    });
  });
});
