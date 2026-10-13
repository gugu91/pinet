import { describe, expect, it, vi } from "vitest";
import type { GoalEvaluation } from "./domain.js";
import { MemoryGoalStorage } from "./memory-storage.js";
import { GoalRuntime } from "./runtime.js";

describe("outage settlement deferral", () => {
  it("persists progress without calling the evaluator or sender until released", async () => {
    const storage = new MemoryGoalStorage();
    const evaluate = vi.fn().mockResolvedValue({ outcome: "continue", reason: "keep working" });
    const continueIfIdle = vi.fn().mockResolvedValue({ status: "started" });
    const runtime = new GoalRuntime(storage, { evaluate }, { continueIfIdle });
    await runtime.create("session", "ship");
    await runtime.settle(
      "session",
      { latestOutput: "network failed", tokenDelta: 3 },
      { deferEvaluation: true },
    );
    await runtime.recover("session");
    expect(evaluate).not.toHaveBeenCalled();
    expect(continueIfIdle).not.toHaveBeenCalled();
    expect(await storage.getPendingEvaluation("session")).toMatchObject({
      iterationsDelta: 1,
      progress: { tokenDelta: 3 },
    });
    runtime.releaseDeferredSettlement("session");
    await runtime.recover("session");
    await runtime.recover("session");
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(continueIfIdle).toHaveBeenCalledTimes(1);
    expect(await runtime.get("session")).toMatchObject({ usage: { iterations: 1, tokens: 3 } });
    runtime.close();
  });

  it("a new user turn absorbs cancelled outage progress and accounts it once", async () => {
    const evaluate = vi.fn().mockResolvedValue({ outcome: "complete", reason: "verified" });
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate },
      { continueIfIdle: vi.fn() },
    );
    await runtime.create("session", "ship");
    await runtime.settle(
      "session",
      { latestOutput: "network failed", tokenDelta: 3 },
      { deferEvaluation: true },
    );
    runtime.releaseDeferredSettlement("session");
    await runtime.settle("session", { latestOutput: "user resumed and finished", tokenDelta: 4 });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(await runtime.get("session")).toMatchObject({
      status: "complete",
      usage: { iterations: 2, tokens: 7 },
    });
    runtime.close();
  });

  it("ignores an in-flight evaluator when a newer outage settlement is deferred", async () => {
    let finish!: (evaluation: GoalEvaluation) => void;
    const evaluate = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<GoalEvaluation>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ outcome: "continue", reason: "keep working" });
    const continueIfIdle = vi.fn().mockResolvedValue({ status: "started" });
    const runtime = new GoalRuntime(new MemoryGoalStorage(), { evaluate }, { continueIfIdle });
    await runtime.create("session", "ship");
    const first = runtime.settle("session", { latestOutput: "first", tokenDelta: 3 });
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    await runtime.settle(
      "session",
      { latestOutput: "outage", tokenDelta: 4 },
      { deferEvaluation: true },
    );
    finish({ outcome: "complete", reason: "stale answer" });
    await first;
    expect(continueIfIdle).not.toHaveBeenCalled();
    expect(await runtime.get("session")).toMatchObject({
      status: "active",
      usage: { iterations: 0 },
    });
    runtime.releaseDeferredSettlement("session");
    await runtime.recover("session");
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(await runtime.get("session")).toMatchObject({
      status: "active",
      usage: { iterations: 2, tokens: 7 },
    });
    expect(continueIfIdle).toHaveBeenCalledTimes(1);
    runtime.close();
  });

  it("enforces a budget changed while waiting", async () => {
    const continueIfIdle = vi.fn();
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "keep working" }) },
      { continueIfIdle },
    );
    await runtime.create("session", "ship");
    await runtime.settle("session", { latestOutput: "outage" }, { deferEvaluation: true });
    await runtime.updateBudget("session", { maxIterations: 1 });
    runtime.releaseDeferredSettlement("session");
    await runtime.recover("session");
    expect(await runtime.get("session")).toMatchObject({
      status: "budget_limited",
      usage: { iterations: 1 },
    });
    expect(continueIfIdle).not.toHaveBeenCalled();
    runtime.close();
  });
});
