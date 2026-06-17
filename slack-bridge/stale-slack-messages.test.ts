import { describe, expect, it } from "vitest";
import {
  isStaleSlackMessage,
  parseSlackTimestampMs,
  STALE_SLACK_MESSAGE_MAX_AGE_MS,
} from "./stale-slack-messages.js";

describe("stale Slack message filtering", () => {
  const baseTimestampMs = Date.parse("2026-06-17T12:00:00.000Z");
  const baseTimestamp = String(baseTimestampMs / 1000);

  it("parses Slack second timestamps with millisecond precision", () => {
    expect(parseSlackTimestampMs("1781697298.359899")).toBe(1_781_697_298_359);
  });

  it("does not mark Slack messages at the 15 minute boundary as stale", () => {
    expect(
      isStaleSlackMessage(
        { source: "slack", timestamp: baseTimestamp },
        { nowMs: baseTimestampMs + STALE_SLACK_MESSAGE_MAX_AGE_MS },
      ),
    ).toBe(false);
  });

  it("marks Slack messages older than 15 minutes as stale", () => {
    expect(
      isStaleSlackMessage(
        { source: "slack", timestamp: baseTimestamp },
        { nowMs: baseTimestampMs + STALE_SLACK_MESSAGE_MAX_AGE_MS + 1 },
      ),
    ).toBe(true);
  });

  it("does not drop non-Slack messages", () => {
    expect(
      isStaleSlackMessage(
        { source: "agent", timestamp: baseTimestamp },
        { nowMs: baseTimestampMs + STALE_SLACK_MESSAGE_MAX_AGE_MS + 60_000 },
      ),
    ).toBe(false);
  });

  it("keeps malformed Slack timestamps deliverable instead of dropping ambiguous mail", () => {
    expect(
      isStaleSlackMessage(
        { source: "slack", timestamp: "not-a-slack-ts" },
        { nowMs: baseTimestampMs + STALE_SLACK_MESSAGE_MAX_AGE_MS + 60_000 },
      ),
    ).toBe(false);
  });

  it("keeps implausibly small Slack test timestamps deliverable", () => {
    expect(
      isStaleSlackMessage(
        { source: "slack", timestamp: "123.456" },
        { nowMs: baseTimestampMs + STALE_SLACK_MESSAGE_MAX_AGE_MS + 60_000 },
      ),
    ).toBe(false);
  });
});
