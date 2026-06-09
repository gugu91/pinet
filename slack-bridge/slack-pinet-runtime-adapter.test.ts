import { describe, expect, it } from "vitest";
import {
  isAuthorizedReactionThread,
  shouldRouteKnownSlackThread,
} from "./slack-pinet-runtime-adapter.js";

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

describe("Slack Pinet runtime adapter reaction authorization", () => {
  function brokerWithThread(
    thread: {
      source: string;
      channel: string;
      ownerAgent: string | null;
      metadata: Record<string, unknown> | null;
    } | null,
  ): Parameters<typeof isAuthorizedReactionThread>[0] {
    return {
      db: {
        getThread: () => thread,
      },
    } as unknown as Parameters<typeof isAuthorizedReactionThread>[0];
  }

  it("rejects reactions for missing/uninvoked Slack threads", () => {
    expect(isAuthorizedReactionThread(brokerWithThread(null), "111.222")).toBe(false);
    expect(
      isAuthorizedReactionThread(
        brokerWithThread({
          source: "slack",
          channel: "C123",
          ownerAgent: null,
          metadata: null,
        }),
        "111.222",
      ),
    ).toBe(false);
  });

  it("allows reactions only for owned or Slack-context-authorized threads", () => {
    expect(
      isAuthorizedReactionThread(
        brokerWithThread({
          source: "slack",
          channel: "C123",
          ownerAgent: "agent-1",
          metadata: null,
        }),
        "111.222",
      ),
    ).toBe(true);

    expect(
      isAuthorizedReactionThread(
        brokerWithThread({
          source: "slack",
          channel: "D123",
          ownerAgent: null,
          metadata: {
            slackThreadContext: {
              channelId: "D123",
              scope: {
                workspace: { provider: "slack", source: "compatibility" },
                instance: { source: "compatibility" },
              },
            },
          },
        }),
        "111.222",
      ),
    ).toBe(true);
  });
});
