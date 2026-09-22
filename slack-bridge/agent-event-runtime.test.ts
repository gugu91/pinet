import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentEventRuntime, type AgentEventRuntimeDeps } from "./agent-event-runtime.js";

function createDeps(overrides: Partial<AgentEventRuntimeDeps> = {}) {
  const deliverFollowUpMessage = vi.fn(() => true);
  const requireToolPolicy = vi.fn();
  const onCompletionAgentStart = vi.fn(async () => {});
  const onCompletionAgentEnd = vi.fn(async () => {});
  const onCompletionAgentSettled = vi.fn(async () => {});
  const hasQueuedInbox = vi.fn(() => false);
  const drainInboxFromSettle = vi.fn();
  const setDeliverTrackedSlackFollowUpMessage = vi.fn();

  const deps: AgentEventRuntimeDeps = {
    getBrokerRole: () => null,
    getGuardrails: () => ({}),
    requireToolPolicy,
    formatAction: (action) => `<${action}>`,
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    deliverFollowUpMessage,
    onCompletionAgentStart,
    onCompletionAgentEnd,
    onCompletionAgentSettled,
    hasQueuedInbox,
    drainInboxFromSettle,
    setDeliverTrackedSlackFollowUpMessage,
    ...overrides,
  };

  return {
    deps,
    deliverFollowUpMessage,
    requireToolPolicy,
    onCompletionAgentStart,
    onCompletionAgentEnd,
    onCompletionAgentSettled,
    hasQueuedInbox,
    drainInboxFromSettle,
    setDeliverTrackedSlackFollowUpMessage,
  };
}

function nextCheckPhase(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
  it("registers one composed handler for each agent lifecycle event", () => {
    const { deps } = createDeps();
    const runtime = createAgentEventRuntime(deps);
    const { pi, registrations } = createPi();

    runtime.register(pi);

    expect(registrations.map(({ eventName }) => eventName)).toEqual([
      "input",
      "before_agent_start",
      "agent_start",
      "turn_start",
      "message_start",
      "turn_end",
      "tool_call",
      "agent_end",
      "agent_settled",
    ]);
    expect(registrations.filter(({ eventName }) => eventName === "agent_start")).toHaveLength(1);
    expect(registrations.filter(({ eventName }) => eventName === "agent_end")).toHaveLength(1);
    expect(registrations.filter(({ eventName }) => eventName === "agent_settled")).toHaveLength(1);
  });

  it("clears visible status at settlement while idle publication stays lifecycle-fenced", async () => {
    const beginThreadStatus = vi.fn(async () => {});
    const clearThreadStatus = vi.fn(async () => {});
    const { deps, requireToolPolicy, onCompletionAgentEnd, onCompletionAgentSettled } = createDeps({
      getGuardrails: () => ({ requireConfirmation: ["read"] }),
      beginThreadStatus,
      clearThreadStatus,
    });
    const runtime = createAgentEventRuntime(deps);
    const { pi, registrations } = createPi();

    runtime.register(pi);
    const deliver = deps.setDeliverTrackedSlackFollowUpMessage as ReturnType<typeof vi.fn>;
    const deliverTrackedSlackFollowUpMessage = deliver.mock.calls[0]?.[0] as (options: {
      prompt: string;
      messages: Array<{ channel: string; threadTs: string }>;
    }) => boolean;
    deliverTrackedSlackFollowUpMessage({
      prompt: "retrying Slack prompt",
      messages: [{ channel: "C100", threadTs: "100.1" }],
    });

    const ctx = {
      isIdle: () => true,
      hasPendingMessages: () => false,
    };
    const dispatch = async (eventName: string, event: object = {}) => {
      const registration = registrations.find((candidate) => candidate.eventName === eventName);
      await registration?.handler(event, ctx);
    };

    await dispatch("input", { source: "extension", text: "retrying Slack prompt" });
    await dispatch("turn_start");
    await dispatch("message_start", {
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "retrying Slack prompt" }],
      },
    });
    await dispatch("tool_call", { toolName: "read", input: { path: "README.md" } });
    expect(requireToolPolicy).toHaveBeenCalledTimes(1);

    await dispatch("turn_end");
    await dispatch("tool_call", { toolName: "read", input: { path: "README.md" } });
    await dispatch("agent_end");

    expect(requireToolPolicy).toHaveBeenCalledTimes(1);
    expect(beginThreadStatus).toHaveBeenCalledWith("C100", "100.1", "is thinking…");
    expect(clearThreadStatus).not.toHaveBeenCalled();
    expect(onCompletionAgentEnd).toHaveBeenCalledTimes(1);
    expect(onCompletionAgentSettled).not.toHaveBeenCalled();

    await dispatch("agent_start", { type: "agent_start" });
    await dispatch("agent_end");
    expect(clearThreadStatus).not.toHaveBeenCalled();

    await dispatch("agent_settled", { type: "agent_settled" });
    expect(clearThreadStatus).toHaveBeenCalledOnce();
    await dispatch("before_agent_start", { type: "before_agent_start" });
    await nextCheckPhase();
    expect(onCompletionAgentSettled).not.toHaveBeenCalled();

    await dispatch("agent_start", { type: "agent_start" });
    await dispatch("agent_end");
    await dispatch("agent_settled", { type: "agent_settled" });
    await nextCheckPhase();

    expect(clearThreadStatus).toHaveBeenCalledWith("C100", "100.1");
    expect(onCompletionAgentSettled).toHaveBeenCalledTimes(1);
    expect(clearThreadStatus.mock.invocationCallOrder[0]).toBeLessThan(
      onCompletionAgentSettled.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("publishes only when Pi reports no active run or pending messages", async () => {
    const { deps, onCompletionAgentSettled } = createDeps();
    const runtime = createAgentEventRuntime(deps);
    const { pi, registrations } = createPi();
    runtime.register(pi);

    let idle = false;
    let pending = false;
    const ctx = {
      isIdle: () => idle,
      hasPendingMessages: () => pending,
    };
    const settled = registrations.find(({ eventName }) => eventName === "agent_settled")?.handler;

    await settled?.({ type: "agent_settled" }, ctx);
    await nextCheckPhase();
    expect(onCompletionAgentSettled).not.toHaveBeenCalled();

    idle = true;
    pending = true;
    await settled?.({ type: "agent_settled" }, ctx);
    await nextCheckPhase();
    expect(onCompletionAgentSettled).not.toHaveBeenCalled();

    pending = false;
    await settled?.({ type: "agent_settled" }, ctx);
    await nextCheckPhase();
    expect(onCompletionAgentSettled).toHaveBeenCalledOnce();
  });

  it.each(["interactive", "rpc", "extension"] as const)(
    "invalidates pending quiescence publication synchronously for %s input",
    async (source) => {
      const { deps, onCompletionAgentSettled } = createDeps();
      const runtime = createAgentEventRuntime(deps);
      const { pi, registrations } = createPi();
      runtime.register(pi);

      const ctx = { isIdle: () => true, hasPendingMessages: () => false };
      const settled = registrations.find(({ eventName }) => eventName === "agent_settled")?.handler;
      const input = registrations.find(({ eventName }) => eventName === "input")?.handler;
      await settled?.({ type: "agent_settled" }, ctx);

      const inputResult = input?.({ type: "input", source, text: "new prompt" }, ctx);
      await nextCheckPhase();

      expect(onCompletionAgentSettled).not.toHaveBeenCalled();
      await inputResult;
    },
  );

  it("drains queued Pinet inbox work before the settled handler returns and skips idle", async () => {
    const callOrder: string[] = [];
    const { deps, onCompletionAgentSettled } = createDeps({
      hasQueuedInbox: () => true,
      drainInboxFromSettle: () => {
        callOrder.push("drain");
      },
    });
    const runtime = createAgentEventRuntime(deps);
    const { pi, registrations } = createPi();
    runtime.register(pi);

    const settled = registrations.find(({ eventName }) => eventName === "agent_settled")?.handler;
    await settled?.(
      { type: "agent_settled" },
      { isIdle: () => true, hasPendingMessages: () => false },
    );
    callOrder.push("returned");
    await nextCheckPhase();

    expect(callOrder).toEqual(["drain", "returned"]);
    expect(onCompletionAgentSettled).not.toHaveBeenCalled();
  });

  it("disposes a pending quiescence publication during shutdown", async () => {
    const { deps, onCompletionAgentSettled } = createDeps();
    const runtime = createAgentEventRuntime(deps);
    const { pi, registrations } = createPi();
    runtime.register(pi);

    const settled = registrations.find(({ eventName }) => eventName === "agent_settled")?.handler;
    await settled?.(
      { type: "agent_settled" },
      { isIdle: () => true, hasPendingMessages: () => false },
    );
    runtime.dispose();
    await nextCheckPhase();

    expect(onCompletionAgentSettled).not.toHaveBeenCalled();
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

    const onTurnStart = registrations.find(({ eventName }) => eventName === "turn_start")
      ?.handler as (() => Promise<void>) | undefined;
    const onMessageStart = registrations.find(({ eventName }) => eventName === "message_start")
      ?.handler as
      | ((event: {
          type: "message_start";
          message: { role: string; content: Array<{ type: "text"; text: string }> };
        }) => Promise<void>)
      | undefined;
    const onToolCall = registrations.find(({ eventName }) => eventName === "tool_call")?.handler as
      | ((event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>)
      | undefined;

    await onTurnStart?.();
    await onMessageStart?.({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "guarded slack prompt" }],
      },
    });

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
