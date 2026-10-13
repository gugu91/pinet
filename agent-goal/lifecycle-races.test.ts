import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGoal, GoalEvaluation, GoalStorage } from "./domain.js";
import { MemoryGoalStorage } from "./memory-storage.js";
import { SqliteGoalStorage } from "./sqlite-storage.js";
import { BLOCKED_RECHECK_INTERVAL_MS, GoalRuntime, type GoalRuntimeOptions } from "./runtime.js";

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

  const makeRuntime = (options: GoalRuntimeOptions = {}): GoalRuntime => {
    const runtime = new GoalRuntime(
      storage,
      { evaluate },
      { continueIfIdle },
      () => new Date(now),
      {
        wakeScheduler: scheduler,
        ...options,
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

  it.each(["live", "expired"])(
    "fences dispatch while the creator of a %s claim is stalled",
    async (lease) => {
      const observed = deferred<void>();
      const release = deferred<void>();
      const first = makeRuntime({
        claimTtlMs: 1_000,
        eventSink: {
          record: async (event) => {
            if (event.type === "goal.continuation_claimed") {
              observed.resolve();
              await release.promise;
            }
          },
        },
      });
      const second = makeRuntime({ claimTtlMs: 1_000 });
      await first.create("session", "ship");
      await first.settle("session", { latestOutput: "waiting" });
      now += BLOCKED_RECHECK_INTERVAL_MS;
      const recovering = first.recover("session");
      await observed.promise;
      const original = await storage.getContinuationClaim("session");
      if (lease === "expired") now += 1_000;
      await second.recover("session");
      expect(continueIfIdle).toHaveBeenCalledTimes(lease === "live" ? 0 : 1);
      if (lease === "expired")
        expect((await storage.getContinuationClaim("session"))?.claimId).not.toBe(
          original?.claimId,
        );
      release.resolve();
      await recovering;
      expect(continueIfIdle).toHaveBeenCalledTimes(1);
    },
  );

  it("reschedules a benign version change after blocked reactivation", async () => {
    const observed = deferred<void>();
    const release = deferred<void>();
    const runtime = makeRuntime({
      eventSink: {
        record: async (event) => {
          if (event.type === "goal.status_changed" && event.previousStatus === "blocked") {
            observed.resolve();
            await release.promise;
          }
        },
      },
    });
    await runtime.create("session", "ship");
    await runtime.settle("session", { latestOutput: "waiting" });
    now += BLOCKED_RECHECK_INTERVAL_MS;
    schedule.mockClear();
    const recovering = runtime.recover("session");
    await observed.promise;
    await runtime.updateBudget("session", { maxIterations: 3 });
    release.resolve();
    await recovering;
    expect(schedule).toHaveBeenCalledWith(
      "session",
      new Date(now).toISOString(),
      expect.any(Function),
    );
    const wake = schedule.mock.calls.at(-1)?.[2] as () => void;
    wake();
    await vi.waitFor(() => expect(continueIfIdle).toHaveBeenCalledTimes(1));
  });

  it("shutdown stops an undispatched claimed continuation while preserving storage", async () => {
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
    await runtime.create("session", "ship");
    await runtime.settle("session", { latestOutput: "waiting" });
    now += BLOCKED_RECHECK_INTERVAL_MS;
    const recovering = runtime.recover("session");
    await observed.promise;
    runtime.close(false);
    release.resolve();
    await recovering;
    expect(continueIfIdle).not.toHaveBeenCalled();
    expect(await storage.getContinuationClaim("session")).toMatchObject({ state: "claimed" });
  });

  it("preserves a live rebound lease when recovery holds an older goal snapshot", async () => {
    const created = deferred<void>();
    const dispatch = deferred<void>();
    const first = makeRuntime({
      eventSink: {
        record: async (event) => {
          if (event.type === "goal.continuation_claimed") {
            created.resolve();
            await dispatch.promise;
          }
        },
      },
    });
    const second = makeRuntime();
    await first.create("session", "ship");
    await first.settle("session", { latestOutput: "waiting" });
    now += BLOCKED_RECHECK_INTERVAL_MS;
    const creator = first.recover("session");
    await created.promise;
    const observed = deferred<void>();
    const resume = deferred<void>();
    const get = storage.get.bind(storage);
    vi.spyOn(storage, "get").mockImplementationOnce(async (scope) => {
      const snapshot = await get(scope);
      observed.resolve();
      await resume.promise;
      return snapshot;
    });
    const recovery = second.recover("session");
    await observed.promise;
    const updated = await first.updateBudget("session", { maxIterations: 3 });
    dispatch.resolve();
    await creator;
    expect(continueIfIdle).toHaveBeenCalledTimes(1);
    expect(continueIfIdle.mock.calls[0][1].idempotencyKey).toBe(`${updated.id}:${updated.version}`);
    const live = await storage.getContinuationClaim("session");
    expect(live).toMatchObject({ state: "started", goalVersion: updated.version });
    resume.resolve();
    await recovery;
    expect(await storage.getContinuationClaim("session")).toEqual(live);
    const wake = schedule.mock.calls.at(-1)?.[2] as () => void;
    wake();
    await vi.waitFor(() =>
      expect(schedule).toHaveBeenLastCalledWith("session", live?.expiresAt, expect.any(Function)),
    );
    expect(continueIfIdle).toHaveBeenCalledTimes(1);
  });

  it("reschedules when budget expansion defeats the budget-limited CAS", async () => {
    const runtime = makeRuntime();
    await runtime.create("session", "ship", { maxIterations: 1 });
    await runtime.settle("session", { latestOutput: "waiting" });
    now += BLOCKED_RECHECK_INTERVAL_MS;
    schedule.mockClear();
    const replace = storage.replace.bind(storage);
    vi.spyOn(storage, "replace").mockImplementationOnce(async (goal, version) => {
      await runtime.updateBudget("session", { maxIterations: 2 });
      return replace(goal, version);
    });
    await runtime.recover("session");
    expect(schedule).toHaveBeenLastCalledWith(
      "session",
      new Date(now + BLOCKED_RECHECK_INTERVAL_MS).toISOString(),
      expect.any(Function),
    );
    now += BLOCKED_RECHECK_INTERVAL_MS;
    await runtime.recover("session");
    expect(continueIfIdle).toHaveBeenCalledTimes(1);
  });
});
