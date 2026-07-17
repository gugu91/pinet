import { describe, expect, it } from "vitest";
import type { InboxItem } from "./broker-client.js";
import { formatPendingMessages, summarizeForWaiter, toPendingMessage } from "./follower-bridge.js";

function makeItem(overrides: Partial<InboxItem["message"]> = {}, inboxId = 1): InboxItem {
  return {
    inboxId,
    message: {
      id: 100,
      threadId: "slack:C123:456",
      source: "slack",
      direction: "inbound",
      sender: "The Broker Lion",
      body: "Please check the deploy",
      metadata: null,
      createdAt: "2026-07-06T10:00:00.000Z",
      ...overrides,
    },
  };
}

describe("toPendingMessage", () => {
  it("maps a regular thread item", () => {
    const pending = toPendingMessage(makeItem());
    expect(pending).toMatchObject({
      inboxId: 1,
      threadId: "slack:C123:456",
      sender: "The Broker Lion",
      a2a: false,
    });
  });

  it("flags a2a threads", () => {
    const pending = toPendingMessage(makeItem({ threadId: "a2a:one:two" }));
    expect(pending.a2a).toBe(true);
  });

  it("flags a2a metadata", () => {
    const pending = toPendingMessage(makeItem({ metadata: { a2a: true } }));
    expect(pending.a2a).toBe(true);
  });
});

describe("formatPendingMessages", () => {
  it("reports emptiness", () => {
    expect(formatPendingMessages([])).toBe("No pending mesh messages.");
  });

  it("numbers messages and includes threadId, sender, and body", () => {
    const text = formatPendingMessages([
      toPendingMessage(makeItem()),
      toPendingMessage(makeItem({ threadId: "a2a:x:y", body: "ping" }, 2)),
    ]);
    expect(text).toContain("2 pending mesh message(s)");
    expect(text).toContain("[1] thread (source: slack)");
    expect(text).toContain("threadId: slack:C123:456");
    expect(text).toContain("Please check the deploy");
    expect(text).toContain("[2] agent-to-agent");
    expect(text).toContain("pinet_send");
  });

  it("marks empty bodies", () => {
    const text = formatPendingMessages([toPendingMessage(makeItem({ body: "  " }))]);
    expect(text).toContain("(empty message)");
  });

  it("prefers senderDisplay over the raw sender id", () => {
    const pending = toPendingMessage(makeItem({ sender: "a932d3ca-uuid", threadId: "a2a:x:y" }));
    pending.senderDisplay = "The Broker Lion";
    expect(formatPendingMessages([pending])).toContain('from "The Broker Lion"');
    expect(summarizeForWaiter([pending])[0].startsWith("The Broker Lion:")).toBe(true);
  });
});

describe("summarizeForWaiter", () => {
  it("collapses whitespace and truncates long bodies", () => {
    const long = "x".repeat(300);
    const [summary] = summarizeForWaiter([toPendingMessage(makeItem({ body: `a\n\nb  ${long}` }))]);
    expect(summary.startsWith("The Broker Lion: a b ")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual("The Broker Lion: ".length + 120);
    expect(summary.endsWith("...")).toBe(true);
  });
});
