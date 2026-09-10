import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentGoal,
  GoalContinuationClaim,
  GoalPendingEvaluation,
  GoalTerminalCandidateRecord,
  GoalWakeScheduler,
} from "./domain.js";
import { GoalRuntime } from "./runtime.js";
import { SqliteGoalStorage } from "./sqlite-storage.js";

const tempDirectories: string[] = [];

const goal: AgentGoal = {
  id: "goal-1",
  scopeId: "session-1",
  objective: "ship",
  status: "active",
  budget: { maxIterations: 10, maxTokens: 50_000 },
  usage: { iterations: 2, tokens: 1_200 },
  lastEvaluation: {
    id: "evaluation-1",
    outcome: "continue",
    reason: "tests remain",
    at: "2026-01-01T00:01:00.000Z",
  },
  version: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
};

const pending: GoalPendingEvaluation = {
  scopeId: "session-1",
  goalId: "goal-1",
  goalVersion: 3,
  evaluationId: "evaluation-2",
  iterationsDelta: 1,
  progress: {
    latestOutput: "work",
    tokenDelta: 200,
    terminalCandidate: { outcome: "complete", reason: "all checks pass" },
  },
  attempt: 1,
  availableAt: "2026-01-01T00:02:00.000Z",
  lastError: "offline",
  createdAt: "2026-01-01T00:01:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
};

const candidate: GoalTerminalCandidateRecord = {
  scopeId: "session-1",
  goalId: "goal-1",
  goalVersion: 3,
  candidateId: "candidate-1",
  outcome: "complete",
  reason: "all checks pass",
  createdAt: "2026-01-01T00:01:00.000Z",
};

const claim: GoalContinuationClaim = {
  scopeId: "session-1",
  goalId: "goal-1",
  goalVersion: 3,
  claimId: "claim-1",
  state: "deferred",
  reason: "busy",
  attempt: 1,
  availableAt: "2026-01-01T00:02:00.000Z",
  expiresAt: "2026-01-01T00:07:00.000Z",
  createdAt: "2026-01-01T00:01:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteGoalStorage", () => {
  it("persists goals and continuation claims across storage instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-"));
    tempDirectories.push(directory);
    const path = join(directory, "nested", "goals.sqlite");

    const first = new SqliteGoalStorage(path);
    const persistedGoal = {
      ...goal,
      name: "Ship goal UX",
      snoozedUntil: "2026-01-01T01:00:00.000Z",
    };
    await first.create(persistedGoal);
    expect(
      await first.addCheckpoint({
        id: "checkpoint-1",
        scopeId: goal.scopeId,
        goalId: goal.id,
        summary: "Storage works",
        evidence: "round-trip verified",
        nextStep: "continue",
        createdAt: "2026-01-01T00:02:00.000Z",
      }),
    ).toBe(true);
    expect(await first.putPendingEvaluation(pending)).toBe(true);
    expect(await first.putTerminalCandidate(candidate)).toBe(true);
    expect(await first.createContinuationClaim(claim)).toBe(true);
    first.close();
    const second = new SqliteGoalStorage(path);

    expect(await second.get("session-1")).toEqual(persistedGoal);
    expect(await second.listCheckpoints("session-1")).toEqual([
      expect.objectContaining({ summary: "Storage works", evidence: "round-trip verified" }),
    ]);
    expect(await second.getPendingEvaluation("session-1")).toEqual(pending);
    expect(await second.getTerminalCandidate("session-1")).toEqual(candidate);
    expect(await second.getContinuationClaim("session-1")).toEqual(claim);
    expect(await second.deleteContinuationClaim("session-1", claim.claimId)).toBe(true);
    expect(
      await second.createContinuationClaim({
        ...claim,
        claimId: "stale-claim",
        goalVersion: 2,
      }),
    ).toBe(false);
    second.close();
  });

  it("updates a budget and dependent goal versions in one transaction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-budget-"));
    tempDirectories.push(directory);
    const storage = new SqliteGoalStorage(join(directory, "goals.sqlite"));
    await storage.create(goal);
    expect(await storage.putPendingEvaluation(pending)).toBe(true);
    expect(await storage.putTerminalCandidate(candidate)).toBe(true);
    expect(await storage.createContinuationClaim(claim)).toBe(true);

    const updated = {
      ...goal,
      budget: { maxIterations: 20, maxTokens: 75_000 },
      version: 4,
      updatedAt: "2026-01-01T00:02:00.000Z",
    };
    expect(await storage.updateBudget(updated, 3)).toBe(true);

    expect(await storage.get("session-1")).toEqual(updated);
    expect(await storage.getPendingEvaluation("session-1")).toMatchObject({ goalVersion: 4 });
    expect(await storage.getTerminalCandidate("session-1")).toMatchObject({ goalVersion: 4 });
    expect(await storage.getContinuationClaim("session-1")).toMatchObject({ goalVersion: 4 });

    expect(
      await storage.appendPendingEvaluation({
        ...pending,
        evaluationId: "evaluation-late",
        iterationsDelta: 2,
      }),
    ).toBe(true);
    expect(await storage.getPendingEvaluation("session-1")).toMatchObject({
      goalVersion: 4,
      evaluationId: "evaluation-late",
      iterationsDelta: 3,
    });
    expect(
      await storage.replaceContinuationClaim({ ...claim, state: "started" }, claim.claimId),
    ).toBe(true);
    expect(await storage.getContinuationClaim("session-1")).toMatchObject({
      goalVersion: 4,
      state: "started",
    });
    expect(await storage.updateBudget({ ...updated, version: 5 }, 3)).toBe(false);
    storage.close();
  });

  it("recovers a persisted snooze after restart without duplicate continuation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-snooze-restart-"));
    tempDirectories.push(directory);
    const path = join(directory, "goals.sqlite");
    let now = new Date("2026-01-01T00:00:00.000Z");
    const firstScheduler: GoalWakeScheduler = {
      schedule: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
    };
    const firstRuntime = new GoalRuntime(
      new SqliteGoalStorage(path),
      { evaluate: vi.fn() },
      { continueIfIdle: vi.fn().mockResolvedValue({ status: "started" }) },
      () => now,
      { wakeScheduler: firstScheduler },
    );
    await firstRuntime.create("session-1", "ship");
    await firstRuntime.snooze("session-1", 60_000);
    expect(await firstRuntime.get("session-1")).toMatchObject({
      snoozedUntil: "2026-01-01T00:01:00.000Z",
    });
    firstRuntime.close();

    const wakes: Array<() => void> = [];
    const restartScheduler: GoalWakeScheduler = {
      schedule: vi.fn((_scopeId, _wakeAt, callback) => wakes.push(callback)),
      cancel: vi.fn(),
      close: vi.fn(),
    };
    const continuation = { continueIfIdle: vi.fn().mockResolvedValue({ status: "started" }) };
    const restarted = new GoalRuntime(
      new SqliteGoalStorage(path),
      { evaluate: vi.fn() },
      continuation,
      () => now,
      { wakeScheduler: restartScheduler },
    );

    await restarted.recover("session-1");
    expect(restartScheduler.schedule).toHaveBeenCalledWith(
      "session-1",
      "2026-01-01T00:01:00.000Z",
      expect.any(Function),
    );
    expect(continuation.continueIfIdle).not.toHaveBeenCalled();
    now = new Date("2026-01-01T00:01:00.000Z");
    wakes[0]?.();
    wakes[0]?.();
    await vi.waitFor(() => expect(continuation.continueIfIdle).toHaveBeenCalledTimes(1));
    expect(await restarted.get("session-1")).toMatchObject({ snoozedUntil: undefined });
    await restarted.recover("session-1");
    expect(continuation.continueIfIdle).toHaveBeenCalledTimes(1);
    restarted.close();
  });

  it("does not let a live goal lower its budget onto already-accounted usage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-live-budget-"));
    tempDirectories.push(directory);
    const storage = new SqliteGoalStorage(join(directory, "goals.sqlite"));
    await storage.create(goal);
    const runtime = new GoalRuntime(
      storage,
      { evaluate: vi.fn().mockResolvedValue({ outcome: "complete", reason: "verified" }) },
      { continueIfIdle: vi.fn().mockResolvedValue({ status: "started" }) },
      undefined,
      { defaultBudget: { maxIterations: 25, maxTokens: 100_000 } },
    );

    await expect(runtime.updateBudget("session-1", { maxIterations: 2 })).rejects.toThrow(
      "current turn",
    );
    await expect(runtime.updateBudget("session-1", { maxTokens: 1_200 })).rejects.toThrow(
      "capacity beyond",
    );
    await runtime.settle("session-1", { latestOutput: "in-flight work", tokenDelta: 100 });

    expect(await runtime.get("session-1")).toMatchObject({
      status: "complete",
      usage: { iterations: 3, tokens: 1_300 },
    });
    runtime.close();
  });

  it("atomically aggregates superseding pending settlements", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-"));
    tempDirectories.push(directory);
    const storage = new SqliteGoalStorage(join(directory, "goals.sqlite"));
    await storage.create(goal);

    expect(await storage.appendPendingEvaluation(pending)).toBe(true);
    expect(
      await storage.appendPendingEvaluation({
        ...pending,
        evaluationId: "evaluation-3",
        iterationsDelta: 1,
        progress: { latestOutput: "newer work", tokenDelta: 300 },
        attempt: 0,
        lastError: undefined,
      }),
    ).toBe(true);

    expect(await storage.getPendingEvaluation("session-1")).toMatchObject({
      evaluationId: "evaluation-3",
      iterationsDelta: 2,
      progress: {
        latestOutput: "newer work",
        tokenDelta: 500,
        terminalCandidate: { outcome: "complete", reason: "all checks pass" },
      },
      attempt: 0,
    });
    const evaluated = {
      ...goal,
      status: "complete" as const,
      usage: { iterations: 4, tokens: 1_700 },
      version: 4,
    };
    expect(await storage.commitEvaluation(evaluated, 3, "evaluation-2")).toBe(false);
    expect(await storage.commitEvaluation(evaluated, 3, "evaluation-3")).toBe(true);
    expect(await storage.get("session-1")).toEqual(evaluated);
    expect(await storage.getPendingEvaluation("session-1")).toBeUndefined();
    storage.close();
  });

  it("migrates goals created by the initial standalone schema", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-"));
    tempDirectories.push(directory);
    const path = join(directory, "goals.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE agent_goals (
        scope_id TEXT PRIMARY KEY NOT NULL,
        id TEXT UNIQUE NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'blocked', 'complete')),
        blocked_reason TEXT,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agent_goals VALUES
        ('session-1', 'goal-1', 'ship', 'active', NULL, 1,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const storage = new SqliteGoalStorage(path);
    const migrated = await storage.get("session-1");
    expect(migrated).toMatchObject({
      budget: { maxIterations: 25 },
      usage: { iterations: 0, tokens: 0 },
    });
    expect(
      await storage.replace(
        { ...migrated!, status: "budget_limited", version: migrated!.version + 1 },
        migrated!.version,
      ),
    ).toBe(true);
    storage.close();
  });

  it("uses versions and claim ids to reject stale mutations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-"));
    tempDirectories.push(directory);
    const storage = new SqliteGoalStorage(join(directory, "goals.sqlite"));
    await storage.create(goal);
    await storage.createContinuationClaim(claim);

    expect(await storage.replace({ ...goal, status: "paused", version: 4 }, 99)).toBe(false);
    expect(await storage.delete("session-1", 99)).toBe(false);
    expect(await storage.deleteContinuationClaim("session-1", "stale")).toBe(false);
    expect(await storage.replaceContinuationClaim({ ...claim, state: "started" }, "stale")).toBe(
      false,
    );
    expect(await storage.replaceContinuationClaim({ ...claim, state: "started" }, "claim-1")).toBe(
      true,
    );
    expect(await storage.replace({ ...goal, status: "paused", version: 4 }, 3)).toBe(true);
    expect(await storage.delete("session-1", 4)).toBe(true);
    expect(await storage.get("session-1")).toBeUndefined();
    storage.close();
  });
});
