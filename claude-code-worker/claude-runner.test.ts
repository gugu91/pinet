import { describe, expect, it } from "vitest";
import { buildClaudeArgs, parseClaudeJsonOutput } from "./claude-runner.js";

describe("parseClaudeJsonOutput", () => {
  it("parses a successful result object", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "4",
      session_id: "abc-123",
      is_error: false,
    });
    expect(parseClaudeJsonOutput(stdout)).toEqual({
      text: "4",
      sessionId: "abc-123",
      isError: false,
    });
  });

  it("scans past trailing non-JSON noise", () => {
    const stdout = [
      "some warning line",
      JSON.stringify({ type: "result", subtype: "success", result: "ok", session_id: "s1" }),
      "",
    ].join("\n");
    expect(parseClaudeJsonOutput(stdout)?.text).toBe("ok");
  });

  it("flags error subtypes", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      result: "partial",
      session_id: "s2",
    });
    expect(parseClaudeJsonOutput(stdout)?.isError).toBe(true);
  });

  it("returns null when no result object exists", () => {
    expect(parseClaudeJsonOutput("plain text output")).toBe(null);
    expect(parseClaudeJsonOutput("")).toBe(null);
  });
});

describe("buildClaudeArgs", () => {
  it("always runs headless with permissions bypassed and json output", () => {
    expect(buildClaudeArgs({})).toEqual([
      "-p",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ]);
  });

  it("adds resume and model when provided", () => {
    const args = buildClaudeArgs({ resumeSessionId: "sess-1", model: "opus" });
    expect(args).toContain("--resume");
    expect(args).toContain("sess-1");
    expect(args).toContain("--model");
    expect(args).toContain("opus");
  });
});
