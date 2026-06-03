import { describe, expect, it } from "vitest";
import { shouldRouteKnownSlackThread } from "./slack-pinet-runtime-adapter.js";

describe("Slack Pinet runtime adapter known thread routing", () => {
  it("does not route legacy DM assistant threads without persisted context after cache loss", () => {
    expect(
      shouldRouteKnownSlackThread({
        source: "slack",
        channel: "D123",
        metadata: null,
      }),
    ).toBe(false);
  });

  it("routes DM assistant threads once Slack context is persisted", () => {
    expect(
      shouldRouteKnownSlackThread({
        source: "slack",
        channel: "D123",
        metadata: {
          slackThreadContext: {
            channelId: "C_TEAM",
            scope: {
              workspace: {
                provider: "slack",
                source: "compatibility",
                compatibilityKey: "default",
                channelId: "C_TEAM",
              },
              instance: { source: "compatibility", compatibilityKey: "default" },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("continues routing non-DM Slack threads without extra context", () => {
    expect(
      shouldRouteKnownSlackThread({
        source: "slack",
        channel: "C123",
        metadata: null,
      }),
    ).toBe(true);
  });
});
