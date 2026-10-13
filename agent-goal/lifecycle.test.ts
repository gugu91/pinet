import { describe, expect, it, vi } from "vitest";
import { MemoryGoalStorage } from "./memory-storage.js";
import { BLOCKED_RECHECK_INTERVAL_MS, GoalRuntime } from "./runtime.js";

describe("Done and blocked rechecks", () => {
  it("retains Done and permits replacement while rejecting replacement of active goals", async () => {
    const storage = new MemoryGoalStorage();
    const runtime = new GoalRuntime(
      storage,
      { evaluate: vi.fn().mockResolvedValue({ outcome: "complete", reason: "verified" }) },
      { continueIfIdle: vi.fn() },
    );
    const original = await runtime.create("session", "ship");
    await storage.upsertLink({
      scopeId: "session",
      url: "https://example.com/pr",
      title: "Deliverable",
      goalId: original.id,
      updatedAt: new Date().toISOString(),
    });
    await runtime.addCheckpoint("session", { summary: "Implemented" });
    await runtime.settle("session", { latestOutput: "done" });
    expect(await runtime.get("session")).toMatchObject({ status: "complete", id: original.id });
    const next = await runtime.create("session", "next");
    expect(next.id).not.toBe(original.id);
    expect(next.status).toBe("active");
    expect(await storage.listLinks("session")).toEqual([
      expect.objectContaining({ goalId: original.id, title: "Deliverable" }),
    ]);
    expect(await runtime.listCheckpoints("session")).toEqual([]);
    await expect(runtime.create("session", "replace active")).rejects.toThrow("already has a goal");
    runtime.close();
  });

  it("waits fifteen minutes, including after restart, before prompting a blocked retry", async () => {
    let now = Date.parse("2026-10-12T00:00:00Z");
    const storage = new MemoryGoalStorage();
    const schedule = vi.fn();
    const scheduler = { schedule, cancel: vi.fn(), close: vi.fn() };
    const continueIfIdle = vi.fn().mockResolvedValue({ status: "started" });
    const evaluator = {
      evaluate: vi.fn().mockResolvedValue({ outcome: "blocked", reason: "Need access" }),
    };
    const runtime = new GoalRuntime(storage, evaluator, { continueIfIdle }, () => new Date(now), {
      wakeScheduler: scheduler,
    });
    await runtime.create("session", "ship");
    await runtime.settle("session", { latestOutput: "access missing" });
    expect(schedule).toHaveBeenLastCalledWith(
      "session",
      new Date(now + BLOCKED_RECHECK_INTERVAL_MS).toISOString(),
      expect.any(Function),
    );
    await runtime.recover("session");
    expect(continueIfIdle).not.toHaveBeenCalled();
    runtime.close(false);
    const restarted = new GoalRuntime(storage, evaluator, { continueIfIdle }, () => new Date(now), {
      wakeScheduler: scheduler,
    });
    await restarted.recover("session");
    expect(continueIfIdle).not.toHaveBeenCalled();
    now += BLOCKED_RECHECK_INTERVAL_MS;
    await restarted.recover("session");
    expect(continueIfIdle).toHaveBeenCalledTimes(1);
    expect(continueIfIdle.mock.calls[0][1].reason).toContain("owning Slack thread");
    expect(continueIfIdle.mock.calls[0][1].reason).toContain("Need access");
    expect(await restarted.get("session")).toMatchObject({ status: "active" });
    await restarted.acknowledgeContinuation("session");
    await restarted.settle("session", { latestOutput: "still need access" });
    await restarted.recover("session");
    expect(continueIfIdle).toHaveBeenCalledTimes(1);
    now += BLOCKED_RECHECK_INTERVAL_MS;
    await restarted.recover("session");
    expect(continueIfIdle).toHaveBeenCalledTimes(2);
    restarted.close();
  });

  it("does not recheck after clearing or exhausting the turn budget", async () => {
    let now = Date.parse("2026-10-12T00:00:00Z");
    const continueIfIdle = vi.fn().mockResolvedValue({ status: "started" });
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn().mockResolvedValue({ outcome: "blocked", reason: "waiting" }) },
      { continueIfIdle },
      () => new Date(now),
      { wakeScheduler: { schedule: vi.fn(), cancel: vi.fn(), close: vi.fn() } },
    );
    await runtime.create("cleared", "ship");
    await runtime.settle("cleared", { latestOutput: "waiting" });
    await runtime.clear("cleared");
    await runtime.create("limited", "ship", { maxIterations: 1 });
    await runtime.settle("limited", { latestOutput: "waiting" });
    now += BLOCKED_RECHECK_INTERVAL_MS;
    await runtime.recover("cleared");
    await runtime.recover("limited");
    expect(continueIfIdle).not.toHaveBeenCalled();
    expect(await runtime.get("limited")).toMatchObject({ status: "budget_limited" });
    runtime.close();
  });
});
