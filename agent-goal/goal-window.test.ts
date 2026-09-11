import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentGoal, GoalCheckpoint } from "./domain.js";
import { GoalWindow, parseDuration } from "./goal-window.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const goal: AgentGoal = {
  id: "goal-1",
  scopeId: "session-1",
  name: "Ship goal UX",
  objective: "Ship a focused terminal-native goal window.",
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
  summary: `Checkpoint ${number}`,
  createdAt: `2026-01-01T00:0${number}:00.000Z`,
}));

describe("GoalWindow", () => {
  it("refreshes elapsed time once per second while an active goal is visible", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const window = new GoalWindow(goal, undefined, theme, vi.fn(), requestRender);

    vi.advanceTimersByTime(3_000);
    expect(requestRender).toHaveBeenCalledTimes(3);

    window.dispose();
    vi.advanceTimersByTime(1_000);
    expect(requestRender).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("opens directly in edit mode when requested", () => {
    const window = new GoalWindow(
      goal,
      undefined,
      theme,
      vi.fn(),
      vi.fn(),
      Date.now,
      undefined,
      [],
      "edit",
    );

    expect(window.render(60).join("\n")).toContain("Goal · edit");
    window.dispose();
  });

  it("wraps the editable objective across multiple lines", () => {
    const editableGoal = {
      ...goal,
      objective:
        "Preserve the complete user objective while showing enough context to review edits before saving.",
    };
    const window = new GoalWindow(
      editableGoal,
      undefined,
      theme,
      vi.fn(),
      vi.fn(),
      Date.now,
      undefined,
      [],
      "edit",
    );

    const lines = window.render(44);
    expect(lines).toHaveLength(10);
    expect(lines.join("\n")).toContain("enough context");
    expect(lines.join("\n")).toContain("before saving.");
    expect(lines.every((line) => visibleWidth(line) <= 44)).toBe(true);
    window.dispose();
  });

  it("renders the terminal-native details and newest checkpoint summary", () => {
    const lines = new GoalWindow(
      goal,
      undefined,
      theme,
      vi.fn(),
      vi.fn(),
      () => Date.parse("2026-01-01T00:15:00.000Z"),
      undefined,
      checkpoints,
    ).render(60);

    expect(lines.join("\n")).toContain("Ship goal UX");
    expect(lines.join("\n")).toContain("Elapsed 15m 0s");
    expect(lines.join("\n")).toContain("3/8 turns");
    expect(lines.join("\n")).toContain("tab/shift+tab select · enter open");
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
  });

  it("creates with editable name, objective, and optional limits", () => {
    const onAction = vi.fn();
    const window = new GoalWindow(undefined, undefined, theme, onAction);
    expect(window.render(44).join("\n")).toContain("No goal for this session");
    window.handleInput("n");
    window.handleInput("New goal");
    window.handleInput("\t");
    window.handleInput("Complete the work");
    window.handleInput("\t");
    window.handleInput("4");
    window.handleInput("\t");
    window.handleInput("2h");
    window.handleInput("\r");
    expect(onAction).toHaveBeenCalledWith({
      type: "create",
      name: "New goal",
      objective: "Complete the work",
      maxIterations: 4,
      maxRuntimeMs: 7_200_000,
    });
  });

  it("edits name and objective as one atomic action", () => {
    const onAction = vi.fn();
    const window = new GoalWindow(goal, undefined, theme, onAction);
    window.handleInput("e");
    for (let index = 0; index < (goal.name?.length ?? 0); index += 1) window.handleInput("\u007f");
    window.handleInput("New name");
    window.handleInput("\t");
    for (let index = 0; index < goal.objective.length; index += 1) window.handleInput("\u007f");
    window.handleInput("New objective");
    window.handleInput("\r");
    expect(onAction).toHaveBeenCalledWith({
      type: "edit",
      name: "New name",
      objective: "New objective",
    });
  });

  it("does not truncate a long stored name during an objective-only edit", () => {
    const onAction = vi.fn();
    const longName = "A".repeat(120);
    const window = new GoalWindow({ ...goal, name: longName }, undefined, theme, onAction);
    window.handleInput("e");
    window.handleInput("\t");
    window.handleInput(" with follow-up");
    window.handleInput("\r");
    expect(onAction).toHaveBeenCalledWith({
      type: "edit",
      objective: `${goal.objective} with follow-up`,
    });
    expect(onAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.any(String) }),
    );
  });

  it("renders persisted control text safely and preserves the objective during a name edit", () => {
    const onAction = vi.fn();
    const rawObjective = "First line\n\u001b[31mred\u001b[0m\u0007 tail";
    const persisted = { ...goal, name: "Old name", objective: rawObjective };
    const window = new GoalWindow(persisted, undefined, theme, onAction);
    window.handleInput("e");

    const rendered = window.render(60);
    expect(rendered.join("\n")).toContain("Objective First line red tail");
    expect(rendered).toHaveLength(7);
    expect(rendered.every((line) => !line.includes("\u001b") && !line.includes("\u0007"))).toBe(
      true,
    );

    for (let index = 0; index < persisted.name.length; index += 1) window.handleInput("\u007f");
    window.handleInput("New name");
    window.handleInput("\r");
    expect(onAction).toHaveBeenCalledWith({ type: "edit", name: "New name" });
    expect(onAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ objective: expect.any(String) }),
    );
  });

  it("expands and scrolls the complete checkpoint history with the keyboard", () => {
    const history = [1, 2, 3, 4, 5].map((number) => ({
      id: `checkpoint-${number}`,
      scopeId: goal.scopeId,
      goalId: goal.id,
      summary: `Checkpoint ${number}`,
      evidence: `Evidence ${number}`,
      nextStep: `Next ${number}`,
      createdAt: `2026-01-01T00:0${number}:00.000Z`,
    }));
    const window = new GoalWindow(
      goal,
      undefined,
      theme,
      vi.fn(),
      vi.fn(),
      Date.now,
      undefined,
      history,
    );

    window.handleInput("\u001b[Z");
    window.handleInput("\r");
    expect(window.render(70).join("\n")).toContain("Evidence 5");
    window.handleInput("\u001b");
    window.handleInput("\t");
    window.handleInput("\r");
    expect(window.render(70).join("\n")).toContain("Evidence 1");
    window.handleInput("\u001b");
    window.handleInput("\t");
    window.handleInput("\r");
    expect(window.render(70).join("\n")).toContain("Evidence 2");
    window.dispose();
  });

  it("uses Escape rather than q to close the details overlay", () => {
    const onAction = vi.fn();
    const window = new GoalWindow(goal, undefined, theme, onAction);

    window.handleInput("q");
    expect(onAction).not.toHaveBeenCalled();
    window.handleInput("\u001b");
    expect(onAction).toHaveBeenCalledWith("close");
  });

  it("expands and collapses even a single checkpoint", () => {
    const window = new GoalWindow(goal, undefined, theme, vi.fn(), vi.fn(), Date.now, undefined, [
      { ...checkpoints[0]!, evidence: "Tests passed", nextStep: "Review the diff" },
    ]);
    expect(window.render(70).join("\n")).toContain("tab/shift+tab select · enter open");
    expect(window.render(70).join("\n")).not.toContain("Tests passed");
    window.handleInput("\t");
    window.handleInput("\r");
    expect(window.render(70).join("\n")).toContain("Tests passed");
    expect(window.render(70).join("\n")).toContain("Review the diff");
    expect(window.render(70).join("\n")).toContain("esc back");
    window.handleInput("\u001b");
    expect(window.render(70).join("\n")).not.toContain("Tests passed");
    window.dispose();
  });

  it("scrolls long checkpoint details without losing evidence or blockers", () => {
    const window = new GoalWindow(goal, undefined, theme, vi.fn(), vi.fn(), Date.now, undefined, [
      {
        ...checkpoints[0]!,
        summary: "Long summary ".repeat(100),
        evidence: "Verified evidence",
        nextStep: "Next action",
        blocker: "External blocker",
      },
    ]);
    window.handleInput("\t");
    window.handleInput("\r");
    expect(window.render(50).join("\n")).not.toContain("External blocker");
    for (let index = 0; index < 100; index += 1) window.handleInput("\u001b[B");
    const bottom = window.render(50);
    expect(bottom.join("\n")).toContain("Verified evidence");
    expect(bottom.join("\n")).toContain("Next action");
    expect(bottom.join("\n")).toContain("External blocker");
    expect(bottom.every((line) => visibleWidth(line) <= 50)).toBe(true);
    for (let index = 0; index < 100; index += 1) window.handleInput("\u001b[A");
    expect(window.render(50).join("\n")).toContain("Summary:");
    window.dispose();
  });

  it("turns limits off explicitly", () => {
    const onAction = vi.fn();
    const window = new GoalWindow(goal, undefined, theme, onAction);
    window.handleInput("b");
    window.handleInput("o");
    expect(onAction).toHaveBeenCalledWith({ type: "budget", disabled: true });
  });

  it("accepts timed snooze and has no manual resume action", () => {
    const onAction = vi.fn();
    const window = new GoalWindow(goal, undefined, theme, onAction);
    window.handleInput("s");
    for (let index = 0; index < 3; index += 1) window.handleInput("\u007f");
    window.handleInput("2h");
    window.handleInput("\r");
    expect(onAction).toHaveBeenCalledWith({ type: "snooze", durationMs: 7_200_000 });
    expect(window.render(60).join("\n")).not.toContain("resume");
  });

  it("makes close available for budget-limited goals", () => {
    const onAction = vi.fn();
    const window = new GoalWindow(
      { ...goal, status: "budget_limited" },
      undefined,
      theme,
      onAction,
    );
    window.handleInput("x");
    window.handleInput("x");
    expect(onAction).toHaveBeenCalledWith("closeGoal");
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])("keeps every line within width %i", (width) => {
    expect(
      new GoalWindow(goal, undefined, theme, vi.fn())
        .render(width)
        .every((line) => visibleWidth(line) <= width),
    ).toBe(true);
  });
});

describe("parseDuration", () => {
  it("parses timed units and rejects indefinite values", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("forever")).toBeUndefined();
  });
});
