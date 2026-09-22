import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentEventRuntime, type AgentEventRuntimeDeps } from "./agent-event-runtime.js";

function createDeps(overrides: Partial<AgentEventRuntimeDeps> = {}) {
  const requireToolPolicy = vi.fn();
  const onCompletionAgentStart = vi.fn(async () => {});
  const onCompletionAgentEnd = vi.fn(async () => {});
  const onCompletionAgentSettled = vi.fn(async () => {});
  const drainQueuedInboxIfIdle = vi.fn(() => true);
  const setDeliverTrackedSlackFollowUpMessage = vi.fn();
  const deps: AgentEventRuntimeDeps = {
    getBrokerRole: () => null,
    getGuardrails: () => ({}),
    requireToolPolicy,
    formatAction: (action) => `<${action}>`,
    formatError: String,
    deliverFollowUpMessage: vi.fn(() => true),
    onCompletionAgentStart,
    onCompletionAgentEnd,
    onCompletionAgentSettled,
    hasQueuedInbox: () => false,
    drainQueuedInboxIfIdle,
    setDeliverTrackedSlackFollowUpMessage,
    ...overrides,
  };
  return {
    deps,
    requireToolPolicy,
    onCompletionAgentStart,
    onCompletionAgentEnd,
    onCompletionAgentSettled,
    drainQueuedInboxIfIdle,
    setDeliverTrackedSlackFollowUpMessage,
  };
}

function createPi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    on: vi.fn((eventName: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(eventName, handler);
    }),
  } as Pick<ExtensionAPI, "on">;
  return { pi, handlers };
}

describe("createAgentEventRuntime", () => {
  it("composes the Pi lifecycle around Slack policy and terminal settlement", async () => {
    const beginThreadStatus = vi.fn(async () => {});
    const clearThreadStatus = vi.fn(async () => {});
    const {
      deps,
      requireToolPolicy,
      onCompletionAgentStart,
      onCompletionAgentEnd,
      onCompletionAgentSettled,
      setDeliverTrackedSlackFollowUpMessage,
    } = createDeps({
      getGuardrails: () => ({ requireConfirmation: ["read"] }),
      beginThreadStatus,
      clearThreadStatus,
    });
    const { pi, handlers } = createPi();
    createAgentEventRuntime(deps).register(pi);

    expect([...handlers.keys()]).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "turn_end",
      "tool_call",
      "agent_end",
      "agent_settled",
    ]);

    const deliver = setDeliverTrackedSlackFollowUpMessage.mock.calls[0]?.[0] as (options: {
      prompt: string;
      messages: Array<{ channel: string; threadTs: string }>;
    }) => boolean;
    expect(
      deliver({
        prompt: "guarded Slack prompt",
        messages: [{ channel: "C100", threadTs: "100.1" }],
      }),
    ).toBe(true);

    const ctx = {};
    await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
    await handlers.get("turn_start")?.({}, ctx);
    await handlers.get("message_start")?.(
      {
        message: {
          role: "user",
          content: [{ type: "text", text: "guarded Slack prompt" }],
        },
      },
      ctx,
    );
    await handlers.get("tool_call")?.({ toolName: "read", input: { path: "README.md" } }, ctx);
    await handlers.get("turn_end")?.({}, ctx);
    await handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

    expect(onCompletionAgentStart).toHaveBeenCalledOnce();
    expect(requireToolPolicy).toHaveBeenCalledWith(
      "read",
      "100.1",
      "path=README.md | offset= | limit=",
    );
    expect(beginThreadStatus).toHaveBeenCalledWith("C100", "100.1", "is thinking…");
    expect(onCompletionAgentEnd).toHaveBeenCalledOnce();
    expect(clearThreadStatus).toHaveBeenCalledWith("C100", "100.1");
    expect(onCompletionAgentSettled).toHaveBeenCalledOnce();
  });

  it("hands queued inbox work to Pi instead of publishing idle at settlement", async () => {
    const { deps, drainQueuedInboxIfIdle, onCompletionAgentSettled } = createDeps({
      hasQueuedInbox: () => true,
    });
    const { pi, handlers } = createPi();
    createAgentEventRuntime(deps).register(pi);

    await handlers.get("agent_settled")?.({ type: "agent_settled" }, {});

    expect(drainQueuedInboxIfIdle).toHaveBeenCalledOnce();
    expect(onCompletionAgentSettled).not.toHaveBeenCalled();
  });
});
