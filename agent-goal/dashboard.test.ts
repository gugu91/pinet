import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  displayGoalText,
  formatGoalDashboard,
  formatGoalList,
  formatGoalStatus,
  formatOrphanGoalNotice,
  goalStatusEmoji,
} from "./dashboard.js";
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

  it.each(["界".repeat(40), "😀".repeat(40)])(
    "truncates Unicode text without exceeding terminal width",
    (value) => {
      const displayed = displayGoalText(value, 12);
      expect(visibleWidth(displayed)).toBeLessThanOrEqual(12);
      const sourceCharacter = Array.from(value)[0];
      expect(
        Array.from(displayed).every(
          (character) => character === sourceCharacter || character === ".",
        ),
      ).toBe(true);
    },
  );

  it("lists unfinished goals with a resume hint for other sessions", () => {
    const other: AgentGoal = {
      ...goal,
      id: "goal-2",
      scopeId: "session-2",
      name: "Orphaned",
      status: "blocked",
      lastSettledAt: "2026-01-01T00:20:00.000Z",
    };
    expect(formatGoalList([goal, other], "session-1")).toEqual([
      "🎯 active · Ship goal UX · 3 turns · last 2026-01-01T00:10:00.000Z · this session",
      "⛔ blocked · Orphaned · 3 turns · last 2026-01-01T00:20:00.000Z · pi --session session-2",
    ]);
    expect(formatGoalList([], "session-1")).toEqual(["No unfinished goals in any session."]);
  });

  it("notices unfinished goals only in other sessions", () => {
    expect(formatOrphanGoalNotice([goal], "session-1")).toBeUndefined();
    expect(formatOrphanGoalNotice([goal, { ...goal, scopeId: "session-2" }], "session-1")).toBe(
      "1 unfinished goal in other sessions; /goal list shows how to resume them",
    );
    expect(
      formatOrphanGoalNotice(
        [
          { ...goal, scopeId: "s2" },
          { ...goal, scopeId: "s3" },
        ],
        "session-1",
      ),
    ).toBe("2 unfinished goals in other sessions; /goal list shows how to resume them");
  });
});
