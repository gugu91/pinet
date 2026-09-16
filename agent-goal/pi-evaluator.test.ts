import { describe, expect, it } from "vitest";
import { parseGoalEvaluation } from "./pi-evaluator.js";

describe("parseGoalEvaluation", () => {
  it.each([
    ["CONTINUE: tests remain", { outcome: "continue", reason: "tests remain" }],
    [
      "COMPLETE: tests and review passed",
      { outcome: "complete", reason: "tests and review passed" },
    ],
    [
      "BLOCKED: maintainer approval required",
      { outcome: "blocked", reason: "maintainer approval required" },
    ],
  ] as const)("parses %s", (response, expected) => {
    expect(parseGoalEvaluation(response)).toEqual(expected);
  });

  it("tolerates reasoning preamble and multi-line reasons", () => {
    expect(
      parseGoalEvaluation(
        "Let me check the evidence.\n\nCONTINUE: review is still open\nThe PR needs approval.",
      ),
    ).toEqual({ outcome: "continue", reason: "review is still open\nThe PR needs approval." });
    expect(parseGoalEvaluation("  complete: verified by tests  ")).toEqual({
      outcome: "complete",
      reason: "verified by tests",
    });
  });

  it("rejects malformed evaluator output", () => {
    expect(() => parseGoalEvaluation("probably done")).toThrow("invalid response");
    expect(() => parseGoalEvaluation("COMPLETE:")).toThrow("did not provide a reason");
    expect(() => parseGoalEvaluation("Not COMPLETE: inline verdicts are ignored")).toThrow(
      "invalid response",
    );
  });
});
