import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlGoalEventSink } from "./event-log.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("JsonlGoalEventSink", () => {
  it("appends timestamped events, creating the parent directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-events-"));
    directories.push(directory);
    const path = join(directory, "nested", "events.jsonl");
    const sink = new JsonlGoalEventSink(path, () => new Date("2026-01-01T00:00:00.000Z"));

    sink.record({ type: "goal.error", operation: "evaluate", error: "offline" });
    sink.record({
      type: "goal.retry_exhausted",
      scopeId: "s1",
      goalId: "g1",
      operation: "evaluator",
      attempt: 4,
      error: "offline",
    });

    expect(
      readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        at: "2026-01-01T00:00:00.000Z",
        type: "goal.error",
        operation: "evaluate",
        error: "offline",
      },
      {
        at: "2026-01-01T00:00:00.000Z",
        type: "goal.retry_exhausted",
        scopeId: "s1",
        goalId: "g1",
        operation: "evaluator",
        attempt: 4,
        error: "offline",
      },
    ]);
  });
});
