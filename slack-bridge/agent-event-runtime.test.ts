import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentEventRuntime, type AgentEventRuntimeDeps } from "./agent-event-runtime.js";

function createDeps(overrides: Partial<AgentEventRuntimeDeps> = {}) {
  const deliverFollowUpMessage = vi.fn(() => true);
  const requireToolPolicy = vi.fn();
  const beforeAgentStart = vi.fn(async (event: { systemPrompt: string }) => ({
    systemPrompt: event.systemPrompt + "\nextra guidance",
  }));
  const onCompletionAgentEnd = vi.fn(async () => {});
  const setDeliverTrackedSlackFollowUpMessage = vi.fn();

  const deps: AgentEventRuntimeDeps = {
    getBrokerRole: () => null,
    getGuardrails: () => ({}),
    requireToolPolicy,
    formatAction: (action) => `<${action}>`,
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    deliverFollowUpMessage,
    beforeAgentStart,
    onCompletionAgentEnd,
    setDeliverTrackedSlackFollowUpMessage,
    ...overrides,
  };

  return {
    deps,
    deliverFollowUpMessage,
    requireToolPolicy,
    beforeAgentStart,
    onCompletionAgentEnd,
    setDeliverTrackedSlackFollowUpMessage,
  };
}

function createPi() {
  const registrations: Array<{ eventName: string; handler: (...args: unknown[]) => unknown }> = [];
  const pi = {
    on: vi.fn((eventName: string, handler: (...args: unknown[]) => unknown) => {
      registrations.push({ eventName, handler });
    }),
  } as Pick<ExtensionAPI, "on">;

  return { pi, registrations };
}

describe("createAgentEventRuntime", () => {
  it("registers the pinned agent event wiring in order and preserves agent_end ordering", () => {
    const { deps, beforeAgentStart, onCompletionAgentEnd } = createDeps();
    const runtime = createAgentEventRuntime(deps);
    const { pi, registrations } = createPi();

    runtime.register(pi);

    expect(registrations.map(({ eventName }) => eventName)).toEqual([
      "input",
      "turn_start",
      "turn_end",
      "agent_end",
      "tool_call",
      "before_agent_start",
      "agent_end",
    ]);

    const agentEndHandlers = registrations.filter(({ eventName }) => eventName === "agent_end");
    expect(agentEndHandlers).toHaveLength(2);
    expect(agentEndHandlers[0]?.handler).not.toBe(onCompletionAgentEnd);
    expect(agentEndHandlers[1]?.handler).toBe(onCompletionAgentEnd);
    expect(registrations[5]?.handler).toBe(beforeAgentStart);
  });

  it("hands off tracked Slack follow-up delivery from the created tool-policy runtime", async () => {
    const {
      deps,
      deliverFollowUpMessage,
      requireToolPolicy,
      setDeliverTrackedSlackFollowUpMessage,
    } = createDeps({
      getGuardrails: () => ({ requireConfirmation: ["read"] }),
    });
    const runtime = createAgentEventRuntime(deps);
    const { pi, registrations } = createPi();

    runtime.register(pi);

    expect(setDeliverTrackedSlackFollowUpMessage).toHaveBeenCalledTimes(1);
    const deliverTrackedSlackFollowUpMessage = setDeliverTrackedSlackFollowUpMessage.mock
      .calls[0]?.[0] as
      | ((options: { prompt: string; messages: Array<{ threadTs?: string }> }) => boolean)
      | undefined;
    expect(deliverTrackedSlackFollowUpMessage).toBeTypeOf("function");

    expect(
      deliverTrackedSlackFollowUpMessage?.({
        prompt: "guarded slack prompt",
        messages: [{ threadTs: "100.1" }],
      }),
    ).toBe(true);
    expect(deliverFollowUpMessage).toHaveBeenCalledWith("guarded slack prompt");

    const onInput = registrations.find(({ eventName }) => eventName === "input")?.handler as
      | ((event: { source?: string; text: string }) => Promise<void>)
      | undefined;
    const onTurnStart = registrations.find(({ eventName }) => eventName === "turn_start")
      ?.handler as (() => Promise<void>) | undefined;
    const onToolCall = registrations.find(({ eventName }) => eventName === "tool_call")?.handler as
      | ((event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>)
      | undefined;

    await onInput?.({ source: "extension", text: "guarded slack prompt" });
    await onTurnStart?.();

    await expect(
      onToolCall?.({
        toolName: "read",
        input: { path: "plans/454.md" },
      }),
    ).resolves.toBeUndefined();
    expect(requireToolPolicy).toHaveBeenCalledWith(
      "read",
      "100.1",
      "path=plans/454.md | offset= | limit=",
    );
  });
});
