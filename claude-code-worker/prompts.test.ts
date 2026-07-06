import { describe, expect, it } from "vitest";
import type { InboxItem } from "./broker-client.js";
import { buildTaskPrompt, extractControlCommand, isAgentToAgentItem } from "./prompts.js";

function makeItem(overrides: {
  threadId?: string;
  body?: string;
  sender?: string;
  source?: string;
  metadata?: Record<string, unknown> | null;
}): InboxItem {
  return {
    inboxId: 1,
    message: {
      id: 1,
      threadId: overrides.threadId ?? "1234.5678",
      source: overrides.source ?? "slack",
      direction: "inbound",
      sender: overrides.sender ?? "U123",
      body: overrides.body ?? "hello",
      metadata: overrides.metadata ?? null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("isAgentToAgentItem", () => {
  it("detects a2a thread ids", () => {
    expect(isAgentToAgentItem(makeItem({ threadId: "a2a:sender:target" }))).toBe(true);
  });

  it("detects a2a metadata flag", () => {
    expect(isAgentToAgentItem(makeItem({ metadata: { a2a: true } }))).toBe(true);
  });

  it("detects scheduled wakeups", () => {
    expect(isAgentToAgentItem(makeItem({ metadata: { scheduledWakeup: true } }))).toBe(true);
  });

  it("treats slack threads as regular", () => {
    expect(isAgentToAgentItem(makeItem({}))).toBe(false);
  });
});

describe("extractControlCommand", () => {
  it("extracts metadata control commands on a2a threads", () => {
    const item = makeItem({
      threadId: "a2a:x:y",
      metadata: { a2a: true, kind: "pinet_control", command: "exit" },
    });
    expect(extractControlCommand(item)).toBe("exit");
  });

  it("extracts exact slash commands on a2a threads", () => {
    expect(extractControlCommand(makeItem({ threadId: "a2a:x:y", body: "/interrupt" }))).toBe(
      "interrupt",
    );
  });

  it("ignores control-looking text on regular threads", () => {
    expect(extractControlCommand(makeItem({ body: "/exit" }))).toBe(null);
  });

  it("ignores scheduled wakeups", () => {
    const item = makeItem({
      threadId: "a2a:x:y",
      body: "/exit",
      metadata: { scheduledWakeup: true },
    });
    expect(extractControlCommand(item)).toBe(null);
  });

  it("ignores plain a2a messages", () => {
    expect(extractControlCommand(makeItem({ threadId: "a2a:x:y", body: "review PR 5" }))).toBe(
      null,
    );
  });
});

describe("buildTaskPrompt", () => {
  const options = { agentName: "Test Crane", workdir: "/tmp/work", isResume: false };

  it("includes mesh preamble, sender, and body for fresh sessions", () => {
    const prompt = buildTaskPrompt(makeItem({ body: "do the thing", sender: "U777" }), options);
    expect(prompt).toContain("Test Crane");
    expect(prompt).toContain("/tmp/work");
    expect(prompt).toContain("U777");
    expect(prompt).toContain("do the thing");
    expect(prompt).toContain("Pinet mesh");
  });

  it("skips the preamble on resumed sessions", () => {
    const prompt = buildTaskPrompt(makeItem({ body: "follow-up" }), {
      ...options,
      isResume: true,
    });
    expect(prompt).toContain("follow-up");
    expect(prompt).not.toContain("Pinet mesh");
  });

  it("labels agent-to-agent messages with the sender agent", () => {
    const prompt = buildTaskPrompt(
      makeItem({ threadId: "a2a:a:b", sender: "The Broker Lion", body: "task" }),
      options,
    );
    expect(prompt).toContain('agent "The Broker Lion"');
  });

  it("labels scheduled wakeups", () => {
    const prompt = buildTaskPrompt(
      makeItem({ metadata: { scheduledWakeup: true }, body: "wake" }),
      options,
    );
    expect(prompt).toContain("Scheduled wake-up");
  });
});
