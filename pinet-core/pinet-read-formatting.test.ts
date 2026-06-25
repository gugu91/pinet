import { describe, expect, it } from "vitest";
import {
  buildCompactPinetReadDetails,
  formatPinetReadResultCompact,
  formatPinetReadResultFull,
  type PinetReadResult,
} from "./pinet-read-formatting.js";

function makeReadResult(body = "please inspect issue context"): PinetReadResult {
  return {
    messages: [
      {
        inboxId: 31,
        delivered: true,
        readAt: "2026-04-25T12:00:00.000Z",
        message: {
          id: 44,
          threadId: "a2a:broker:worker",
          source: "agent",
          direction: "inbound",
          sender: "broker",
          body,
          metadata: { a2a: true },
          createdAt: "2026-04-25T11:59:00.000Z",
        },
      },
    ],
    unreadCountBefore: 2,
    unreadCountAfter: 1,
    unreadThreads: [
      {
        threadId: "a2a:broker:worker",
        source: "agent",
        channel: "",
        unreadCount: 1,
        latestMessageId: 45,
        latestAt: "2026-04-25T12:01:00.000Z",
        highestMailClass: "steering",
        mailClassCounts: { steering: 1, fwup: 0, maintenance_context: 0 },
      },
    ],
    markedReadIds: [31],
  };
}

describe("Pinet read formatting", () => {
  it("keeps default read output compact with bounded thread previews", () => {
    expect(formatPinetReadResultCompact(makeReadResult(), { threadId: "a2a:broker:worker" })).toBe(
      "Pinet read: 1 unread message; unread 2→1; marked 1; 1 unread thread.\n- [steering] [agent/a2a:broker:worker #44] broker: please inspect issue context",
    );
  });

  it("includes the same per-message preview on inbox-wide compact reads (no thread_id)", () => {
    // Regression: previously compact mode only emitted previews when a
    // `thread_id` was supplied, which left inbox-wide `pinet action=read`
    // callers with only the counts header and pushed agents toward `full=true`.
    const compact = formatPinetReadResultCompact(makeReadResult(), {});
    expect(compact).toContain(
      "- [steering] [agent/a2a:broker:worker #44] broker: please inspect issue context",
    );
  });

  it("mentions full=true as a verbatim affordance, not as a directive, when previews truncate", () => {
    const compact = formatPinetReadResultCompact(makeReadResult("dense detail ".repeat(40)), {
      threadId: "a2a:broker:worker",
    });

    expect(compact).toContain("args.full=true args.unread_only=false returns verbatim bodies.");
    // Make sure the previous directive wording does not creep back in.
    expect(compact).not.toContain("Use args.full=true args.unread_only=false for exact bodies.");
  });

  it("preserves the full read text for explicit verbose output", () => {
    const full = formatPinetReadResultFull(makeReadResult(), { threadId: "a2a:broker:worker" });

    expect(full).toContain("Pinet read (unread) from thread a2a:broker:worker: 1 message.");
    expect(full).toContain("broker: please inspect issue context");
    expect(full).toContain("pointer=pinet action=read args.thread_id=a2a:broker:worker");
    expect(full).toContain("Marked read: 31.");
  });

  it("returns lean compact details without duplicating body previews", () => {
    const body = `please inspect ${"important context ".repeat(20)}and keep exact body`;
    const compactDetails = buildCompactPinetReadDetails(makeReadResult(body)) as {
      summary: string;
      messageCount: number;
      unreadBefore: number;
      unreadAfter: number;
      markedReadCount: number;
      exactBodies: string;
      messages: Array<{ id: number; threadId: string; preview?: string; message?: unknown }>;
    };

    expect(compactDetails.summary).toBe("1 msg; unread 2→1; marked 1; 1 unread thread");
    expect(compactDetails.messageCount).toBe(1);
    expect(compactDetails.unreadBefore).toBe(2);
    expect(compactDetails.unreadAfter).toBe(1);
    expect(compactDetails.markedReadCount).toBe(1);
    expect(compactDetails.exactBodies).toBe("args.full=true args.unread_only=false");
    expect(compactDetails.messages[0]).toMatchObject({
      id: 44,
      threadId: "a2a:broker:worker",
    });
    expect(compactDetails.messages[0]?.preview).toBeUndefined();
    expect(compactDetails.messages[0]?.message).toBeUndefined();
    expect(JSON.stringify(compactDetails)).not.toContain(body);
  });
});
