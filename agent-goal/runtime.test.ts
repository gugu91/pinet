import { describe, expect, it, vi } from "vitest";
import type {
  AgentGoal,
  GoalContinuation,
  GoalDeleteResult,
  GoalEvaluator,
  GoalEvent,
  GoalWakeScheduler,
} from "./domain.js";
import { MemoryGoalStorage } from "./memory-storage.js";
import { GoalRuntime } from "./runtime.js";

const startedContinuation = (): GoalContinuation => ({
  continueIfIdle: vi.fn().mockResolvedValue({ status: "started" }),
});

describe("GoalRuntime", () => {
  it("creates one bounded active goal per scope", async () => {
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      startedContinuation(),
      () => new Date("2026-01-01T00:00:00.000Z"),
      { defaultBudget: { maxIterations: 8, maxTokens: 50_000 } },
    );

    const goal = await runtime.create("session-1", "  ship the feature  ");

    expect(goal).toMatchObject({
      scopeId: "session-1",
      objective: "ship the feature",
      status: "active",
      budget: { maxIterations: 8, maxTokens: 50_000 },
      usage: { iterations: 0, tokens: 0 },
      version: 1,
    });
    await expect(runtime.create("session-1", "another goal")).rejects.toThrow("already has a goal");
    await expect(
      runtime.create("invalid-token-budget", "ship", {
        maxIterations: 1,
        maxTokens: Number.NaN,
      }),
    ).rejects.toThrow("maxTokens");
    await expect(
      runtime.create("invalid-runtime-budget", "ship", {
        maxIterations: 1,
        maxRuntimeMs: -1,
      }),
    ).rejects.toThrow("maxRuntimeMs");
  });

  it.each(["active", "blocked", "complete"] as const)(
    "clears %s goals when explicitly requested",
    async (status) => {
      const storage = new MemoryGoalStorage();
      await storage.create({
        id: "goal-1",
        scopeId: "session-1",
        objective: "ship",
        status,
        ...(status === "blocked" ? { blockedReason: "waiting" } : {}),
        budget: {},
        usage: { iterations: 1, tokens: 0 },
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const runtime = new GoalRuntime(storage, { evaluate: vi.fn() }, startedContinuation());

      expect(await runtime.clear("session-1")).toBe(true);
      expect(await runtime.get("session-1")).toBeUndefined();
    },
  );

  it("reports a concurrent goal update as a clear conflict instead of absence", async () => {
    class AdvancingStorage extends MemoryGoalStorage {
      override async delete(
        scopeId: string,
        expectedGoalId: string,
        expectedVersion: number,
      ): Promise<GoalDeleteResult> {
        const current = await this.get(scopeId);
        if (!current) return "missing";
        await this.replace(
          {
            ...current,
            name: "concurrently updated",
            version: current.version + 1,
            updatedAt: "2026-01-01T00:01:00.000Z",
          },
          current.version,
        );
        return super.delete(scopeId, expectedGoalId, expectedVersion);
      }
    }
    const storage = new AdvancingStorage();
    const runtime = new GoalRuntime(storage, { evaluate: vi.fn() }, startedContinuation());
    const goal = await runtime.create("session-1", "ship");

    await expect(runtime.clear("session-1")).rejects.toThrow(
      "Goal changed while it was being cleared; retry the command",
    );
    expect(await runtime.get("session-1")).toMatchObject({
      id: goal.id,
      name: "concurrently updated",
      version: 2,
    });
  });

  it("does not clear a replacement goal with the original version", async () => {
    class ReplacingStorage extends MemoryGoalStorage {
      override async delete(
        scopeId: string,
        expectedGoalId: string,
        expectedVersion: number,
      ): Promise<GoalDeleteResult> {
        const current = await this.get(scopeId);
        if (!current) return "missing";
        await super.delete(scopeId, current.id, current.version);
        await this.create({
          ...current,
          id: "replacement-goal",
          objective: "deploy separately",
          version: expectedVersion,
        });
        return super.delete(scopeId, expectedGoalId, expectedVersion);
      }
    }
    const storage = new ReplacingStorage();
    const runtime = new GoalRuntime(storage, { evaluate: vi.fn() }, startedContinuation());
    await runtime.create("session-1", "ship");

    await expect(runtime.clear("session-1")).rejects.toThrow(
      "Goal changed while it was being cleared; retry the command",
    );
    expect(await runtime.get("session-1")).toMatchObject({
      id: "replacement-goal",
      objective: "deploy separately",
      version: 1,
    });
  });

  it("updates turn and token budgets atomically within configured ceilings", async () => {
    const events: GoalEvent[] = [];
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      startedContinuation(),
      () => new Date("2026-01-01T00:00:00.000Z"),
      {
        defaultBudget: { maxIterations: 20, maxTokens: 100_000 },
        eventSink: { record: (event) => void events.push(event) },
      },
    );
    await runtime.create("session-1", "ship", { maxIterations: 5, maxTokens: 10_000 });

    const increased = await runtime.updateBudget("session-1", {
      maxIterations: 12,
      maxTokens: 50_000,
    });
    const decreased = await runtime.updateBudget("session-1", {
      maxIterations: 8,
      maxTokens: 30_000,
    });

    expect(increased).toMatchObject({
      budget: { maxIterations: 12, maxTokens: 50_000 },
      version: 2,
    });
    expect(decreased).toMatchObject({
      budget: { maxIterations: 8, maxTokens: 30_000 },
      version: 3,
    });
    expect(events.filter(({ type }) => type === "goal.budget_changed")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "goal.budget_changed",
      previousBudget: { maxIterations: 12, maxTokens: 50_000 },
    });
  });

  it("enforces configured ceilings, accounted usage, and optimistic versions", async () => {
    const storage = new MemoryGoalStorage();
    const runtime = new GoalRuntime(
      storage,
      { evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "more work" }) },
      startedContinuation(),
      undefined,
      { defaultBudget: { maxIterations: 10, maxTokens: 1_000 } },
    );
    await runtime.create("session-1", "ship");
    await runtime.settle("session-1", { latestOutput: "work", tokenDelta: 100 });

    await expect(runtime.updateBudget("session-1", { maxIterations: 11 })).rejects.toThrow(
      "configured limit",
    );
    await expect(runtime.updateBudget("session-1", { maxTokens: 1_001 })).rejects.toThrow(
      "configured limit",
    );
    await expect(runtime.updateBudget("session-1", { maxIterations: 0 })).rejects.toThrow(
      "positive integer",
    );
    await expect(runtime.updateBudget("session-1", { maxIterations: 0.5 })).rejects.toThrow(
      "positive integer",
    );
    await expect(runtime.updateBudget("session-1", { maxIterations: 1 })).rejects.toThrow(
      "current turn",
    );
    await expect(runtime.updateBudget("session-1", { maxTokens: 100 })).rejects.toThrow(
      "capacity beyond",
    );
    await expect(runtime.updateBudget("session-1", { maxTokens: 99 })).rejects.toThrow(
      "capacity beyond",
    );
    await expect(runtime.updateBudget("session-1", {})).rejects.toThrow("requires");

    await runtime.settle("session-1", { latestOutput: "next work", tokenDelta: 200 });
    expect(await runtime.get("session-1")).toMatchObject({
      status: "active",
      usage: { iterations: 2, tokens: 300 },
    });

    vi.spyOn(storage, "updateBudget").mockResolvedValueOnce(false);
    await expect(runtime.updateBudget("session-1", { maxIterations: 9 })).rejects.toThrow(
      "changed while its budget",
    );
  });

  it("reactivates an exhausted goal when a larger budget restores capacity", async () => {
    const continuation = startedContinuation();
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "more work" }) },
      continuation,
      undefined,
      { defaultBudget: { maxIterations: 5, maxTokens: 10_000 } },
    );
    await runtime.create("session-1", "ship", { maxIterations: 1, maxTokens: 100 });
    await runtime.settle("session-1", { latestOutput: "first pass", tokenDelta: 100 });
    expect(await runtime.get("session-1")).toMatchObject({ status: "budget_limited" });

    const updated = await runtime.updateBudget("session-1", {
      maxIterations: 2,
      maxTokens: 200,
    });

    expect(updated).toMatchObject({
      status: "active",
      budget: { maxIterations: 2, maxTokens: 200 },
      usage: { iterations: 1, tokens: 100 },
      blockedReason: undefined,
    });
    expect(continuation.continueIfIdle).toHaveBeenCalledOnce();
  });

  it("binds a settlement to the latest budget version when the update wins first", async () => {
    const storage = new MemoryGoalStorage();
    const append = storage.appendPendingEvaluation.bind(storage);
    let appendStarted: (() => void) | undefined;
    let releaseAppend: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      appendStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    vi.spyOn(storage, "appendPendingEvaluation").mockImplementationOnce(async (pending) => {
      appendStarted?.();
      await release;
      return append(pending);
    });
    const runtime = new GoalRuntime(
      storage,
      { evaluate: vi.fn().mockResolvedValue({ outcome: "complete", reason: "verified" }) },
      startedContinuation(),
      undefined,
      { defaultBudget: { maxIterations: 10, maxTokens: 10_000 } },
    );
    await runtime.create("session-1", "ship", { maxIterations: 5, maxTokens: 1_000 });

    const settlement = runtime.settle("session-1", {
      latestOutput: "settled work",
      tokenDelta: 250,
      terminalCandidate: { outcome: "complete", reason: "checks passed" },
    });
    await started;
    await runtime.updateBudget("session-1", { maxIterations: 8, maxTokens: 2_000 });
    releaseAppend?.();
    await settlement;

    expect(await runtime.get("session-1")).toMatchObject({
      status: "complete",
      budget: { maxIterations: 8, maxTokens: 2_000 },
      usage: { iterations: 1, tokens: 250 },
    });
  });

  it("preserves in-flight settlement accounting across a concurrent budget update", async () => {
    let evaluationStarted: (() => void) | undefined;
    let resolveEvaluation: ((value: { outcome: "continue"; reason: string }) => void) | undefined;
    const started = new Promise<void>((resolve) => {
      evaluationStarted = resolve;
    });
    const evaluator: GoalEvaluator = {
      evaluate: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveEvaluation = resolve;
              evaluationStarted?.();
            }),
        )
        .mockResolvedValue({ outcome: "continue", reason: "current budget evaluated" }),
    };
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      evaluator,
      startedContinuation(),
      undefined,
      { defaultBudget: { maxIterations: 10, maxTokens: 10_000 } },
    );
    await runtime.create("session-1", "ship", { maxIterations: 5, maxTokens: 1_000 });

    const settlement = runtime.settle("session-1", {
      latestOutput: "concurrent work",
      tokenDelta: 250,
    });
    await started;
    await runtime.updateBudget("session-1", { maxIterations: 8, maxTokens: 2_000 });
    resolveEvaluation?.({ outcome: "continue", reason: "stale budget evaluated" });
    await settlement;

    expect(await runtime.get("session-1")).toMatchObject({
      budget: { maxIterations: 8, maxTokens: 2_000 },
      usage: { iterations: 1, tokens: 250 },
    });
    expect(evaluator.evaluate).toHaveBeenCalledTimes(2);
  });

  it("rebinds an in-flight continuation retry after a concurrent budget update", async () => {
    let continuationStarted: (() => void) | undefined;
    let resolveContinuation:
      | ((value: { status: "unavailable"; reason: string; retryAfterMs: number }) => void)
      | undefined;
    const started = new Promise<void>((resolve) => {
      continuationStarted = resolve;
    });
    const continuation: GoalContinuation = {
      continueIfIdle: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveContinuation = resolve;
              continuationStarted?.();
            }),
        )
        .mockResolvedValue({ status: "started" }),
    };
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "more work" }) },
      continuation,
      undefined,
      {
        defaultBudget: { maxIterations: 10, maxTokens: 10_000 },
        retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      },
    );
    await runtime.create("session-1", "ship", { maxIterations: 5, maxTokens: 1_000 });

    const settlement = runtime.settle("session-1", {
      latestOutput: "first pass",
      tokenDelta: 100,
    });
    await started;
    await runtime.updateBudget("session-1", { maxIterations: 8, maxTokens: 2_000 });
    resolveContinuation?.({ status: "unavailable", reason: "offline", retryAfterMs: 0 });
    await settlement;

    const goal = await runtime.get("session-1");
    expect(goal).toMatchObject({ status: "active", version: 3 });
    expect(await runtime.getContinuationClaim("session-1")).toMatchObject({
      goalVersion: goal?.version,
      state: "started",
    });
    expect(continuation.continueIfIdle).toHaveBeenCalledTimes(2);
  });

  it("evaluates ordinary settled progress and continues when work remains", async () => {
    const continuation = startedContinuation();
    const evaluator = {
      evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "tests remain" }),
    };
    const events: GoalEvent[] = [];
    const runtime = new GoalRuntime(new MemoryGoalStorage(), evaluator, continuation, undefined, {
      eventSink: { record: (event) => void events.push(event) },
    });
    await runtime.create("session-1", "ship");

    await runtime.settle("session-1", { latestOutput: "implementation done", tokenDelta: 120 });

    expect(continuation.continueIfIdle).toHaveBeenCalledOnce();
    expect(await runtime.get("session-1")).toMatchObject({
      status: "active",
      usage: { iterations: 1, tokens: 120 },
      lastEvaluation: { outcome: "continue", reason: "tests remain" },
      version: 2,
    });
    expect(evaluator.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { iterations: 1, tokens: 120 } }),
      expect.objectContaining({ latestOutput: "implementation done", tokenDelta: 120 }),
    );
    expect(events.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["goal.evaluated", "goal.auto_continued"]),
    );
    expect(await runtime.getContinuationClaim("session-1")).toMatchObject({ state: "started" });
    await runtime.recover("session-1");
    expect(continuation.continueIfIdle).toHaveBeenCalledOnce();
  });

  it("continues when independent evaluation rejects a terminal claim", async () => {
    const evaluator = {
      evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "tests are missing" }),
    } satisfies GoalEvaluator;
    const continuation = startedContinuation();
    const runtime = new GoalRuntime(new MemoryGoalStorage(), evaluator, continuation);
    await runtime.create("session-1", "ship");

    await runtime.settle("session-1", {
      latestOutput: "I think this is done",
      terminalCandidate: { outcome: "complete", reason: "implementation exists" },
    });

    expect(evaluator.evaluate).toHaveBeenCalledOnce();
    expect(await runtime.get("session-1")).toMatchObject({ status: "active" });
    expect(continuation.continueIfIdle).toHaveBeenCalledOnce();
  });

  it("evaluates every settlement regardless of the legacy checkpoint interval", async () => {
    const evaluator = {
      evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "checkpoint passed" }),
    } satisfies GoalEvaluator;
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      evaluator,
      startedContinuation(),
      undefined,
      { evaluationInterval: 2 },
    );
    await runtime.create("session-1", "ship");

    await runtime.settle("session-1", { latestOutput: "turn one" });
    await runtime.acknowledgeContinuation("session-1");
    await runtime.settle("session-1", { latestOutput: "turn two" });

    expect(evaluator.evaluate).toHaveBeenCalledTimes(2);
  });

  it.each(["complete", "blocked"] as const)(
    "persists a %s evaluation without continuing",
    async (outcome) => {
      const continuation = startedContinuation();
      const runtime = new GoalRuntime(
        new MemoryGoalStorage(),
        { evaluate: vi.fn().mockResolvedValue({ outcome, reason: "evaluation reason" }) },
        continuation,
      );
      await runtime.create("session-1", "ship");

      await runtime.settle("session-1", {
        latestOutput: "done",
        terminalCandidate: { outcome, reason: "worker evidence" },
      });

      expect(await runtime.get("session-1")).toMatchObject({
        status: outcome,
        version: 2,
        ...(outcome === "blocked" ? { blockedReason: "evaluation reason" } : {}),
      });
      expect(continuation.continueIfIdle).not.toHaveBeenCalled();
    },
  );

  it("evaluates the final allowed iteration but prevents another continuation", async () => {
    const evaluator = {
      evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "more work" }),
    } satisfies GoalEvaluator;
    const continuation = startedContinuation();
    const runtime = new GoalRuntime(new MemoryGoalStorage(), evaluator, continuation, undefined, {
      defaultBudget: { maxIterations: 1 },
    });
    await runtime.create("session-1", "ship");

    await runtime.settle("session-1", { latestOutput: "first turn" });

    expect(await runtime.get("session-1")).toMatchObject({
      status: "budget_limited",
      usage: { iterations: 1 },
    });
    expect(evaluator.evaluate).toHaveBeenCalledOnce();
    expect(continuation.continueIfIdle).not.toHaveBeenCalled();
  });

  it("re-evaluates the latest progress instead of applying an older result", async () => {
    let evaluationStarted: (() => void) | undefined;
    let resolveEvaluation: ((value: { outcome: "continue"; reason: string }) => void) | undefined;
    const started = new Promise<void>((resolve) => {
      evaluationStarted = resolve;
    });
    const evaluator: GoalEvaluator = {
      evaluate: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveEvaluation = resolve;
              evaluationStarted?.();
            }),
        )
        .mockResolvedValueOnce({ outcome: "complete", reason: "latest turn completed the goal" }),
    };
    const continuation = startedContinuation();
    const runtime = new GoalRuntime(new MemoryGoalStorage(), evaluator, continuation);
    await runtime.create("session-1", "ship");

    const first = runtime.settle("session-1", {
      latestOutput: "first turn",
      tokenDelta: 10,
      terminalCandidate: { outcome: "complete", reason: "first claim" },
    });
    await started;
    await runtime.settle("session-1", {
      latestOutput: "latest completed turn",
      tokenDelta: 20,
      terminalCandidate: { outcome: "complete", reason: "latest claim" },
    });
    resolveEvaluation?.({ outcome: "continue", reason: "stale result" });
    await first;

    expect(evaluator.evaluate).toHaveBeenCalledTimes(2);
    expect(continuation.continueIfIdle).not.toHaveBeenCalled();
    expect(await runtime.get("session-1")).toMatchObject({
      status: "complete",
      usage: { iterations: 2, tokens: 30 },
    });
  });

  it("does not let stale evaluator exhaustion block newer pending work", async () => {
    let signalCommitStarted: (() => void) | undefined;
    let releaseCommit: (() => void) | undefined;
    const commitStarted = new Promise<void>((resolve) => {
      signalCommitStarted = resolve;
    });
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    class PausingStorage extends MemoryGoalStorage {
      private pauseNextCommit = true;

      override async commitEvaluation(
        goal: AgentGoal,
        expectedGoalVersion: number,
        expectedEvaluationId: string,
      ): Promise<boolean> {
        if (this.pauseNextCommit) {
          this.pauseNextCommit = false;
          signalCommitStarted?.();
          await commitRelease;
        }
        return super.commitEvaluation(goal, expectedGoalVersion, expectedEvaluationId);
      }
    }
    const evaluator: GoalEvaluator = {
      evaluate: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({ outcome: "complete", reason: "newer turn verified" }),
    };
    const runtime = new GoalRuntime(
      new PausingStorage(),
      evaluator,
      startedContinuation(),
      undefined,
      { retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } },
    );
    await runtime.create("session-1", "ship");

    const first = runtime.settle("session-1", {
      latestOutput: "first claim",
      tokenDelta: 10,
      terminalCandidate: { outcome: "complete", reason: "first claim" },
    });
    await commitStarted;
    await runtime.settle("session-1", {
      latestOutput: "newer verified work",
      tokenDelta: 20,
      terminalCandidate: { outcome: "complete", reason: "newer claim" },
    });
    releaseCommit?.();
    await first;

    expect(evaluator.evaluate).toHaveBeenCalledTimes(2);
    expect(await runtime.get("session-1")).toMatchObject({
      status: "complete",
      usage: { iterations: 2, tokens: 30 },
    });
  });

  it("persists a terminal candidate until settled evaluation consumes it", async () => {
    const storage = new MemoryGoalStorage();
    const first = new GoalRuntime(storage, { evaluate: vi.fn() }, startedContinuation());
    await first.create("session-1", "ship");
    await first.requestTerminalCandidate("session-1", {
      outcome: "complete",
      reason: "all acceptance checks pass",
    });
    const evaluator = {
      evaluate: vi.fn().mockResolvedValue({ outcome: "complete", reason: "verified" }),
    } satisfies GoalEvaluator;
    const recovered = new GoalRuntime(storage, evaluator, startedContinuation());

    await recovered.settle("session-1", { latestOutput: "verified output" });

    expect(evaluator.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({
        terminalCandidate: {
          outcome: "complete",
          reason: "all acceptance checks pass",
        },
      }),
    );
    expect(await storage.getTerminalCandidate("session-1")).toBeUndefined();
    expect(await recovered.get("session-1")).toMatchObject({ status: "complete" });
  });

  it("recovers a durable pending evaluation before continuing", async () => {
    const storage = new MemoryGoalStorage();
    const first = new GoalRuntime(storage, { evaluate: vi.fn() }, startedContinuation());
    const goal = await first.create("session-1", "ship");
    await storage.putPendingEvaluation({
      scopeId: goal.scopeId,
      goalId: goal.id,
      goalVersion: goal.version,
      evaluationId: "evaluation-1",
      iterationsDelta: 1,
      progress: {
        latestOutput: "completed",
        tokenDelta: 50,
        terminalCandidate: { outcome: "complete", reason: "verified locally" },
      },
      attempt: 1,
      availableAt: goal.createdAt,
      lastError: "temporary failure",
      createdAt: goal.createdAt,
      updatedAt: goal.createdAt,
    });
    const continuation = startedContinuation();
    const recovered = new GoalRuntime(
      storage,
      { evaluate: vi.fn().mockResolvedValue({ outcome: "complete", reason: "verified" }) },
      continuation,
    );

    await recovered.recover("session-1");

    expect(await recovered.get("session-1")).toMatchObject({
      status: "complete",
      usage: { iterations: 1, tokens: 50 },
      lastEvaluation: { id: "evaluation-1", outcome: "complete" },
    });
    expect(continuation.continueIfIdle).not.toHaveBeenCalled();
    expect(await storage.getPendingEvaluation("session-1")).toBeUndefined();
  });

  it("retries evaluator failures and blocks after bounded exhaustion", async () => {
    const events: GoalEvent[] = [];
    const evaluator = { evaluate: vi.fn().mockRejectedValue(new Error("offline")) };
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      evaluator,
      startedContinuation(),
      undefined,
      {
        retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        delay: vi.fn().mockResolvedValue(undefined),
        eventSink: { record: (event) => void events.push(event) },
      },
    );
    await runtime.create("session-1", "ship");

    await runtime.settle("session-1", {
      latestOutput: "work",
      terminalCandidate: { outcome: "complete", reason: "claimed done" },
    });

    expect(evaluator.evaluate).toHaveBeenCalledTimes(2);
    expect(await runtime.get("session-1")).toMatchObject({
      status: "blocked",
      blockedReason: "evaluator failed after 2 attempts: offline",
    });
    expect(events.some(({ type }) => type === "goal.retry_exhausted")).toBe(true);
  });

  it("retries continuation failures and blocks after bounded exhaustion", async () => {
    const continuation: GoalContinuation = {
      continueIfIdle: vi.fn().mockResolvedValue({ status: "unavailable", reason: "offline" }),
    };
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      continuation,
      undefined,
      {
        retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        delay: vi.fn().mockResolvedValue(undefined),
      },
    );
    await runtime.create("session-1", "ship");

    await runtime.start("session-1");

    expect(continuation.continueIfIdle).toHaveBeenCalledTimes(2);
    expect(await runtime.get("session-1")).toMatchObject({
      status: "blocked",
      blockedReason: "continuation failed after 2 attempts: offline",
    });
    expect(await runtime.getContinuationClaim("session-1")).toBeUndefined();
  });

  it("removes a stale claim before continuing a newer active goal version", async () => {
    const storage = new MemoryGoalStorage();
    const continuation = startedContinuation();
    const runtime = new GoalRuntime(storage, { evaluate: vi.fn() }, continuation);
    const goal = await runtime.create("session-1", "ship");
    expect(
      await storage.createContinuationClaim({
        scopeId: goal.scopeId,
        goalId: goal.id,
        goalVersion: goal.version,
        claimId: "stale-claim",
        state: "started",
        kind: "continuation",
        reason: "old version",
        attempt: 1,
        availableAt: goal.createdAt,
        expiresAt: "2099-01-01T00:00:00.000Z",
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
      }),
    ).toBe(true);
    expect(
      await storage.replace(
        { ...goal, version: 2, updatedAt: "2026-01-01T00:01:00.000Z" },
        goal.version,
      ),
    ).toBe(true);

    await runtime.start("session-1");

    expect(continuation.continueIfIdle).toHaveBeenCalledOnce();
    expect(await runtime.getContinuationClaim("session-1")).toMatchObject({
      goalVersion: 2,
      state: "started",
    });
  });

  it("does not let stale continuation retry exhaustion block a newer goal version", async () => {
    const continuation: GoalContinuation = {
      continueIfIdle: vi.fn().mockResolvedValue({ status: "unavailable", reason: "offline" }),
    };
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      continuation,
      undefined,
      {
        retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        delay: async () => {
          await runtime.setStatus("session-1", "paused");
        },
      },
    );
    await runtime.create("session-1", "ship");

    await runtime.start("session-1");

    expect(await runtime.get("session-1")).toMatchObject({ status: "paused", version: 2 });
    expect(continuation.continueIfIdle).toHaveBeenCalledOnce();
  });

  it("automatically wakes a busy continuation when its deferral is due", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    let wake: (() => void) | undefined;
    const wakeScheduler: GoalWakeScheduler = {
      schedule: vi.fn((_scopeId, _wakeAt, callback) => {
        wake = callback;
      }),
      cancel: vi.fn(),
      close: vi.fn(),
    };
    const continuation: GoalContinuation = {
      continueIfIdle: vi
        .fn()
        .mockResolvedValueOnce({ status: "busy", reason: "user turn", retryAfterMs: 100 })
        .mockResolvedValueOnce({ status: "started" }),
    };
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      continuation,
      () => now,
      { wakeScheduler },
    );
    await runtime.create("session-1", "ship");

    await runtime.start("session-1");
    expect(await runtime.getContinuationClaim("session-1")).toMatchObject({ state: "deferred" });
    expect(wakeScheduler.schedule).toHaveBeenCalledWith(
      "session-1",
      "2026-01-01T00:00:00.100Z",
      expect.any(Function),
    );

    now = new Date("2026-01-01T00:00:00.101Z");
    wake?.();
    await vi.waitFor(() => expect(continuation.continueIfIdle).toHaveBeenCalledTimes(2));
    expect(await runtime.getContinuationClaim("session-1")).toMatchObject({
      state: "started",
      attempt: 1,
    });
  });

  it("does not exhaust continuation retries while the goal session stays busy", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    let wake: (() => void) | undefined;
    const wakeScheduler: GoalWakeScheduler = {
      schedule: vi.fn((_scopeId, _wakeAt, callback) => {
        wake = callback;
      }),
      cancel: vi.fn(),
      close: vi.fn(),
    };
    const continuation: GoalContinuation = {
      continueIfIdle: vi.fn().mockResolvedValue({
        status: "busy",
        reason: "settlement callback still owns the session",
        retryAfterMs: 100,
      }),
    };
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      continuation,
      () => now,
      {
        retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        wakeScheduler,
      },
    );
    await runtime.create("session-1", "ship");
    await runtime.start("session-1");

    for (let index = 0; index < 4; index += 1) {
      now = new Date(now.getTime() + 101);
      wake?.();
      await vi.waitFor(() => expect(continuation.continueIfIdle).toHaveBeenCalledTimes(index + 2));
    }

    expect(await runtime.get("session-1")).toMatchObject({ status: "active" });
    expect(await runtime.getContinuationClaim("session-1")).toMatchObject({
      state: "deferred",
      attempt: 0,
    });
  });

  it("does not schedule a wake after shutdown races an in-flight continuation", async () => {
    let signalContinuationStarted: (() => void) | undefined;
    let resolveContinuation:
      | ((result: { status: "busy"; reason: string; retryAfterMs: number }) => void)
      | undefined;
    const continuationStarted = new Promise<void>((resolve) => {
      signalContinuationStarted = resolve;
    });
    const wakeScheduler: GoalWakeScheduler = {
      schedule: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
    };
    const continuation: GoalContinuation = {
      continueIfIdle: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveContinuation = resolve;
            signalContinuationStarted?.();
          }),
      ),
    };
    const storage = new MemoryGoalStorage();
    const runtime = new GoalRuntime(storage, { evaluate: vi.fn() }, continuation, undefined, {
      wakeScheduler,
    });
    await runtime.create("session-1", "ship");

    const start = runtime.start("session-1");
    await continuationStarted;
    runtime.close(false);
    resolveContinuation?.({ status: "busy", reason: "user turn", retryAfterMs: 100 });
    await start;

    expect(wakeScheduler.close).toHaveBeenCalledOnce();
    expect(wakeScheduler.schedule).not.toHaveBeenCalled();
  });

  it("recovers started intent after restart before the first turn is claimed", async () => {
    const storage = new MemoryGoalStorage();
    const first = new GoalRuntime(storage, { evaluate: vi.fn() }, startedContinuation());
    await first.create("session-1", "ship");
    first.close(false);
    const continuation = startedContinuation();
    const restarted = new GoalRuntime(storage, { evaluate: vi.fn() }, continuation);

    await restarted.recover("session-1");

    expect(continuation.continueIfIdle).toHaveBeenCalledWith(
      expect.objectContaining({ nextContinuationKind: "started" }),
      expect.objectContaining({ kind: "started" }),
    );
    restarted.close(false);
  });

  it("keeps updated intent while a concurrent evaluation advances the goal version", async () => {
    const storage = new MemoryGoalStorage();
    let releaseFirst!: (value: { outcome: "continue"; reason: string }) => void;
    const firstEvaluation = new Promise<{ outcome: "continue"; reason: string }>((resolve) => {
      releaseFirst = resolve;
    });
    const evaluator: GoalEvaluator = {
      evaluate: vi
        .fn()
        .mockReturnValueOnce(firstEvaluation)
        .mockResolvedValueOnce({ outcome: "continue", reason: "updated work remains" }),
    };
    const continuation: GoalContinuation = {
      continueIfIdle: vi.fn().mockResolvedValue({
        status: "busy",
        reason: "current turn is settling",
        retryAfterMs: 60_000,
      }),
    };
    const runtime = new GoalRuntime(storage, evaluator, continuation);
    await runtime.create("session-1", "old objective");
    const settling = runtime.settle("session-1", { latestOutput: "old work" });
    await vi.waitFor(() => expect(evaluator.evaluate).toHaveBeenCalledOnce());

    await runtime.updateDetails("session-1", { objective: "new objective" });
    releaseFirst({ outcome: "continue", reason: "stale result" });
    await settling;

    expect(continuation.continueIfIdle).toHaveBeenCalledTimes(1);
    expect(continuation.continueIfIdle).toHaveBeenCalledWith(
      expect.objectContaining({ objective: "new objective" }),
      expect.objectContaining({ kind: "updated" }),
    );
    expect(await storage.getContinuationClaim("session-1")).toMatchObject({
      goalVersion: 3,
      state: "deferred",
      kind: "updated",
    });
    expect(await runtime.get("session-1")).toMatchObject({ nextContinuationKind: "updated" });
    runtime.close(false);
  });

  it("preserves updated intent while paused and consumes it only after that turn starts", async () => {
    const storage = new MemoryGoalStorage();
    const continuation = startedContinuation();
    const runtime = new GoalRuntime(storage, { evaluate: vi.fn() }, continuation);
    await runtime.create("session-1", "old objective");
    await runtime.setStatus("session-1", "paused");

    await runtime.updateDetails("session-1", { objective: "new objective" });
    expect(continuation.continueIfIdle).not.toHaveBeenCalled();
    expect(await runtime.get("session-1")).toMatchObject({
      status: "paused",
      nextContinuationKind: "updated",
    });

    await runtime.setStatus("session-1", "active");
    await runtime.start("session-1", "Resume the goal from current state.");
    expect(continuation.continueIfIdle).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ kind: "updated" }),
    );
    await runtime.acknowledgeContinuation("session-1");
    expect((await runtime.get("session-1"))?.nextContinuationKind).toBeUndefined();
    expect(await storage.getContinuationClaim("session-1")).toBeUndefined();
  });

  it("preserves updated intent through snooze and emits it when the goal wakes", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    let wake: (() => void) | undefined;
    const wakeScheduler: GoalWakeScheduler = {
      schedule: vi.fn((_scopeId, _wakeAt, callback) => {
        wake = callback;
      }),
      cancel: vi.fn(),
      close: vi.fn(),
    };
    const continuation = startedContinuation();
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      continuation,
      () => now,
      { wakeScheduler },
    );
    await runtime.create("session-1", "old objective");
    await runtime.snooze("session-1", 60_000);
    await runtime.updateDetails("session-1", { objective: "new objective" });
    expect(continuation.continueIfIdle).not.toHaveBeenCalled();

    now = new Date("2026-01-01T00:01:00.000Z");
    wake?.();
    await vi.waitFor(() => expect(continuation.continueIfIdle).toHaveBeenCalledOnce());
    expect(continuation.continueIfIdle).toHaveBeenCalledWith(
      expect.objectContaining({ objective: "new objective" }),
      expect.objectContaining({ kind: "updated" }),
    );
  });

  it("persists editable details and fences an evaluation using the old objective", async () => {
    const storage = new MemoryGoalStorage();
    let releaseFirst: ((value: { outcome: "continue"; reason: string }) => void) | undefined;
    const firstEvaluation = new Promise<{ outcome: "continue"; reason: string }>((resolve) => {
      releaseFirst = resolve;
    });
    const evaluator: GoalEvaluator = {
      evaluate: vi
        .fn()
        .mockReturnValueOnce(firstEvaluation)
        .mockResolvedValueOnce({ outcome: "complete", reason: "new objective verified" }),
    };
    const runtime = new GoalRuntime(storage, evaluator, startedContinuation());
    await runtime.create("session-1", "old objective", {}, "Old name");

    const settling = runtime.settle("session-1", { latestOutput: "work" });
    await vi.waitFor(() => expect(evaluator.evaluate).toHaveBeenCalledTimes(1));
    const editing = runtime.updateDetails("session-1", {
      name: "New name",
      objective: "new objective",
    });
    releaseFirst?.({ outcome: "continue", reason: "stale result" });
    await vi.waitFor(() => expect(evaluator.evaluate).toHaveBeenCalledTimes(2));
    await Promise.all([settling, editing]);

    expect(evaluator.evaluate).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "New name", objective: "new objective" }),
      expect.any(Object),
    );
    expect(await runtime.get("session-1")).toMatchObject({
      name: "New name",
      objective: "new objective",
      status: "complete",
      usage: { iterations: 1, tokens: 0 },
    });
  });

  it("does not complete an edited goal from a stale completion result", async () => {
    const storage = new MemoryGoalStorage();
    let releaseFirst!: (value: { outcome: "complete"; reason: string }) => void;
    const firstEvaluation = new Promise<{ outcome: "complete"; reason: string }>((resolve) => {
      releaseFirst = resolve;
    });
    const evaluator: GoalEvaluator = {
      evaluate: vi
        .fn()
        .mockReturnValueOnce(firstEvaluation)
        .mockResolvedValueOnce({ outcome: "continue", reason: "updated objective needs work" }),
    };
    const runtime = new GoalRuntime(storage, evaluator, startedContinuation());
    await runtime.create("session-1", "old objective");
    const settling = runtime.settle("session-1", { latestOutput: "old work done" });
    await vi.waitFor(() => expect(evaluator.evaluate).toHaveBeenCalledOnce());
    const editing = runtime.updateDetails("session-1", { objective: "new unfinished objective" });
    await vi.waitFor(async () =>
      expect((await storage.get("session-1"))?.objective).toBe("new unfinished objective"),
    );
    releaseFirst({ outcome: "complete", reason: "old objective done" });
    await Promise.all([settling, editing]);
    expect(evaluator.evaluate).toHaveBeenCalledTimes(2);
    expect(await runtime.get("session-1")).toMatchObject({
      objective: "new unfinished objective",
      status: "active",
      lastEvaluation: { outcome: "continue" },
    });
    runtime.close(false);
  });

  it("records newest-first durable checkpoints", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      startedContinuation(),
      () => now,
    );
    await runtime.create("session-1", "ship");
    await runtime.addCheckpoint("session-1", {
      summary: "First",
      evidence: "test A passes",
      nextStep: "run test B",
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await runtime.addCheckpoint("session-1", { summary: "Second", blocker: "waiting on CI" });
    expect((await runtime.listCheckpoints("session-1")).map(({ summary }) => summary)).toEqual([
      "Second",
      "First",
    ]);
  });

  it("automatically expires timed snooze exactly once", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const wakes: Array<() => void> = [];
    const wakeScheduler: GoalWakeScheduler = {
      schedule: vi.fn((_scopeId, _wakeAt, callback) => wakes.push(callback)),
      cancel: vi.fn(),
      close: vi.fn(),
    };
    const continuation = startedContinuation();
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      continuation,
      () => now,
      { wakeScheduler },
    );
    await runtime.create("session-1", "ship");
    const snoozed = await runtime.snooze("session-1", 60_000);
    expect(snoozed.snoozedUntil).toBe("2026-01-01T00:01:00.000Z");
    now = new Date("2026-01-01T00:01:00.000Z");
    wakes[0]?.();
    wakes[0]?.();
    await vi.waitFor(() => expect(continuation.continueIfIdle).toHaveBeenCalledTimes(1));
    expect(await runtime.get("session-1")).toMatchObject({ snoozedUntil: undefined });
  });

  it("closes a budget-limited goal and supports opt-in limits", async () => {
    const storage = new MemoryGoalStorage();
    const runtime = new GoalRuntime(storage, { evaluate: vi.fn() }, startedContinuation());
    const unlimited = await runtime.create("session-1", "ship");
    expect(unlimited.budget).toEqual({});
    const limited = await runtime.updateBudget("session-1", { maxIterations: 2 });
    await storage.replace(
      { ...limited, status: "budget_limited", version: limited.version + 1 },
      limited.version,
    );
    expect(limited.usage).toEqual(unlimited.usage);
    expect(await runtime.closeGoal("session-1")).toMatchObject({ status: "complete" });
  });

  it("enforces status transitions and clears continuation claims", async () => {
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      startedContinuation(),
    );
    await runtime.create("session-1", "ship");
    await runtime.start("session-1");

    await expect(runtime.setStatus("session-1", "active")).rejects.toThrow(
      "Cannot change a active goal to active",
    );
    await runtime.setStatus("session-1", "complete");
    expect(await runtime.getContinuationClaim("session-1")).toBeUndefined();
    await expect(runtime.setStatus("session-1", "active")).rejects.toThrow(
      "Cannot change a complete goal to active",
    );
  });
});
