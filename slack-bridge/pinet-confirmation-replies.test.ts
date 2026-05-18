import { describe, expect, it } from "vitest";
import type { PinetReadResult } from "@gugu910/pi-pinet-core/pinet-read-formatting";
import { createThreadConfirmationPolicy } from "./thread-confirmations.js";
import { consumePinetReadConfirmationReplies } from "./pinet-confirmation-replies.js";

function makeReadResult(overrides: Partial<PinetReadResult> = {}): PinetReadResult {
  return {
    messages: [
      {
        inboxId: 2571,
        delivered: true,
        readAt: "2026-05-18T12:00:00.000Z",
        message: {
          id: 99,
          threadId: "1779126107.662159",
          source: "slack",
          direction: "inbound",
          sender: "U0AF5S3LQ5C",
          body: "yes",
          metadata: null,
          createdAt: "2026-05-18T12:00:00.000Z",
        },
      },
    ],
    unreadCountBefore: 1,
    unreadCountAfter: 0,
    unreadThreads: [],
    markedReadIds: [2571],
    ...overrides,
  };
}

describe("consumePinetReadConfirmationReplies", () => {
  it("lets a guarded Slack action proceed after its Slack approval is read via Pinet", () => {
    const action =
      "channel=C0AF7L69E5C | thread_ts=1779126107.662159 | ts=1779126146.246369 | thread=false";
    const policy = createThreadConfirmationPolicy({
      getGuardrails: () => ({ requireConfirmation: ["slack:delete"] }),
    });

    expect(policy.registerRequest("1779126107.662159", "slack:delete", action).status).toBe(
      "created",
    );

    const result = consumePinetReadConfirmationReplies(makeReadResult(), policy.consumeReply);

    expect(result.messages[0]?.message.body).toContain(
      "User approved security confirmation request",
    );
    expect(() =>
      policy.requireToolPolicy("slack:delete", "1779126107.662159", action),
    ).not.toThrow();
  });

  it("does not relax exact tool/action matching after a Pinet-routed approval", () => {
    const action = "channel=C0 | thread_ts=100.1 | ts=100.2 | thread=false";
    const policy = createThreadConfirmationPolicy({
      getGuardrails: () => ({ requireConfirmation: ["slack:delete", "slack:pin"] }),
    });

    policy.registerRequest("100.1", "slack:delete", action);
    consumePinetReadConfirmationReplies(
      makeReadResult({
        messages: [
          {
            inboxId: 1,
            delivered: true,
            readAt: "2026-05-18T12:00:00.000Z",
            message: {
              id: 1,
              threadId: "100.1",
              source: "slack",
              direction: "inbound",
              sender: "U0AF5S3LQ5C",
              body: "yes",
              metadata: null,
              createdAt: "2026-05-18T12:00:00.000Z",
            },
          },
        ],
        markedReadIds: [1],
      }),
      policy.consumeReply,
    );

    expect(() =>
      policy.requireToolPolicy(
        "slack:delete",
        "100.1",
        "channel=C0 | thread_ts=100.1 | ts=DIFFERENT | thread=false",
      ),
    ).toThrow('Tool "slack:delete" requires confirmation');
    expect(() => policy.requireToolPolicy("slack:pin", "100.1", action)).toThrow(
      'Tool "slack:pin" requires confirmation',
    );
  });

  it("ignores already-read or non-Slack messages", () => {
    const consumed: Array<[string, string]> = [];
    const result = consumePinetReadConfirmationReplies(
      makeReadResult({
        markedReadIds: [],
      }),
      (threadTs, text) => {
        consumed.push([threadTs, text]);
        return { approved: true };
      },
    );

    expect(consumed).toEqual([]);
    expect(result.messages[0]?.message.body).toBe("yes");
  });
});
