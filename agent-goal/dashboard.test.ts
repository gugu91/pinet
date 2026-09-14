import { describe, expect, it } from "vitest";
import { formatGoalDashboard, formatGoalStatus, goalStatusEmoji } from "./dashboard.js";
import type { AgentGoal, GoalCheckpoint } from "./domain.js";

const goal: AgentGoal = {
  id: "goal-1",
  scopeId: "session-1",
  name: "Ship goal UX",
  objective: "Ship the standalone goal loop",
  status: "active",
  budget: { maxIterations: 8, maxRuntimeMs: 3_600_000 },
  usage: { iterations: 3, tokens: 12_430 },
  version: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:10:00.000Z",
};

const checkpoints: GoalCheckpoint[] = [1, 2, 3, 4].map((number) => ({
  id: `checkpoint-${number}`,
  scopeId: goal.scopeId,
  goalId: goal.id,
  summary: `Progress ${number}`,
  createdAt: `2026-01-01T00:0${number}:00.000Z`,
}));

describe("goal dashboard", () => {
  it("formats the compact row and newest-three checkpoint detail", () => {
    expect(formatGoalStatus(goal, Date.parse("2026-01-01T00:15:00.000Z"))).toBe(
      "🎯 Ship goal UX 15m 0s",
    );
    const dashboard = formatGoalDashboard(goal, undefined, checkpoints);
    expect(dashboard).toContain("Limits: Turns 3/8 · Runtime 60m");
    expect(dashboard.filter((line) => line.startsWith("Checkpoint "))).toHaveLength(3);
    expect(dashboard).toContain("DONE: Progress 1");
    expect(dashboard).toContain("… and 1 more checkpoints");
    expect(dashboard.join("\n")).not.toContain("token");
  });

  it("labels checkpoint progress and remaining work", () => {
    const dashboard = formatGoalDashboard(goal, undefined, [
      {
        ...checkpoints[0]!,
        nextStep: "Open the pull request",
        evidence: "Tests passed",
        blocker: "Waiting for review",
      },
    ]);
    expect(dashboard).toContain("DONE: Progress 1");
    expect(dashboard).toContain("TODO: Open the pull request");
    expect(dashboard).toContain("EVIDENCE: Tests passed");
    expect(dashboard).toContain("BLOCKED: Waiting for review");
  });

  it.each([
    ["active", "🎯"],
    ["paused", "⏸️"],
    ["blocked", "⛔"],
    ["budget_limited", "⏱️"],
    ["complete", "✅"],
  ] as const)("shows %s status as %s", (status, emoji) => {
    expect(goalStatusEmoji({ ...goal, status })).toBe(emoji);
  });

  it("truncates the compact goal text", () => {
    const compact = formatGoalStatus({ ...goal, name: undefined, objective: "x".repeat(80) });
    expect(compact).toMatch(/^🎯 x{37}\.\.\. /);
    expect(compact).not.toContain("x".repeat(41));
  });
});
