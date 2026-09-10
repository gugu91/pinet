import { describe, expect, it } from "vitest";
import { formatGoalDashboard, formatGoalStatus } from "./dashboard.js";
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
      "🎯 | Ship goal UX | 15m 0s",
    );
    const dashboard = formatGoalDashboard(goal, undefined, checkpoints);
    expect(dashboard).toContain("Limits: Turns 3/8 · Runtime 60m");
    expect(dashboard.filter((line) => line.startsWith("Checkpoint "))).toHaveLength(3);
    expect(dashboard).toContain("… and 1 more checkpoints");
    expect(dashboard.join("\n")).not.toContain("token");
  });
});
