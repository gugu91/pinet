import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGoal } from "./domain.js";
import type { GoalProgressMessage } from "./progress.js";
import { registerAgentGoal, type GoalWindowAction } from "./index.js";
import { MemoryGoalStorage } from "./memory-storage.js";

type GoalEventHandler = (
  event: { messages?: GoalProgressMessage[] },
  context: ExtensionContext,
) => Promise<void> | void;
type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type GoalWindowFactory = (
  tui: { requestRender(): void },
  theme: Theme,
  keybindings: object,
  done: (value: GoalWindowAction) => void,
) => Component;

afterEach(() => vi.useRealTimers());

describe("registerAgentGoal", () => {
  it("keeps lifecycle tags visible after Pi converts custom messages for the model", async () => {
    const { convertToLlm } = (await import("@earendil-works/pi-coding-agent")) as object as {
      convertToLlm(
        messages: Array<{
          role: "custom";
          customType: string;
          content: string;
          display: boolean;
          timestamp: number;
        }>,
      ): Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    };
    for (const kind of ["started", "updated", "continuation"] as const) {
      const content = `[agent-goal.${kind}]\nObjective (user data): ship`;
      const converted = convertToLlm([
        {
          role: "custom",
          customType: `agent-goal.${kind}`,
          content,
          display: true,
          timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
        },
      ]);

      expect(converted).toEqual([
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ type: "text", text: content })],
        }),
      ]);
    }
  });

  it("clears the durable goal through clear_goal only when one exists", async () => {
    const tools = new Map<string, ToolDefinition>();
    const pi = {
      on: vi.fn(),
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      registerCommand: vi.fn(),
      sendMessage: vi.fn(),
    } as object as ExtensionAPI;
    const storage = new MemoryGoalStorage();
    await storage.create({
      id: "goal-1",
      scopeId: "session-1",
      objective: "finished objective",
      status: "blocked",
      blockedReason: "waiting",
      budget: {},
      usage: { iterations: 1, tokens: 0 },
      version: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
    await storage.addCheckpoint({
      id: "checkpoint-1",
      scopeId: "session-1",
      goalId: "goal-1",
      summary: "Preserved elsewhere",
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    const setWidget = vi.fn();
    const context = {
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session-1" },
      ui: { setStatus: vi.fn(), setWidget, notify: vi.fn() },
    } as object as ExtensionContext;
    registerAgentGoal(pi, {
      storage,
      evaluator: { evaluate: vi.fn() },
      continuation: { continueIfIdle: vi.fn() },
    });
    const clearGoal = tools.get("clear_goal");
    if (!clearGoal?.execute) throw new Error("clear_goal was not registered");
    expect(clearGoal).toMatchObject({
      description: expect.stringContaining("user asks"),
      promptGuidelines: expect.arrayContaining([expect.stringContaining("explicit user request")]),
    });

    const cleared = await clearGoal.execute(
      "call-1",
      {},
      new AbortController().signal,
      undefined,
      context,
    );
    const missing = await clearGoal.execute(
      "call-2",
      {},
      new AbortController().signal,
      undefined,
      context,
    );

    expect(cleared).toMatchObject({
      content: [{ type: "text", text: "Cleared the durable goal for this session." }],
      details: { cleared: true },
    });
    expect(missing).toMatchObject({
      content: [{ type: "text", text: "This session has no goal to clear." }],
      details: { cleared: false },
      isError: true,
    });
    expect(await storage.get("session-1")).toBeUndefined();
    expect(await storage.listCheckpoints("session-1")).toEqual([]);
    expect(context.ui.setStatus).toHaveBeenLastCalledWith("agent-goal", undefined);
    expect(setWidget).toHaveBeenLastCalledWith("agent-goal", undefined);
  });

  it("refreshes the passive elapsed status once per second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const handlers = new Map<string, GoalEventHandler>();
    const pi = {
      on(name: string, handler: GoalEventHandler) {
        handlers.set(name, handler);
      },
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendMessage: vi.fn(),
    } as object as ExtensionAPI;
    const storage = new MemoryGoalStorage();
    await storage.create({
      id: "goal-1",
      scopeId: "session-1",
      name: "Live timer",
      objective: "show elapsed time live",
      status: "active",
      budget: {},
      usage: { iterations: 0, tokens: 0 },
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const setStatus = vi.fn();
    const context = {
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session-1" },
      ui: { setStatus, setWidget: vi.fn(), notify: vi.fn() },
    } as object as ExtensionContext;
    registerAgentGoal(pi, {
      storage,
      continuation: { continueIfIdle: vi.fn().mockResolvedValue({ status: "started" }) },
    });

    await handlers.get("session_start")?.({}, context);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(setStatus).toHaveBeenLastCalledWith("agent-goal", "🎯 Live timer 2s");

    const readGoal = storage.get.bind(storage);
    let resolveDelayedRead!: (goal: AgentGoal | undefined) => void;
    const get = vi
      .spyOn(storage, "get")
      .mockImplementationOnce(() => new Promise((resolve) => (resolveDelayedRead = resolve)))
      .mockImplementation(readGoal);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(get).toHaveBeenCalledOnce();
    resolveDelayedRead(await readGoal("session-1"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(get).toHaveBeenCalledTimes(2);

    const callsBeforeShutdown = setStatus.mock.calls.length;
    await handlers.get("session_shutdown")?.({}, context);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(setStatus).toHaveBeenCalledTimes(callsBeforeShutdown);
  });

  it("clears a goal completed while recovering a pending evaluation", async () => {
    const handlers = new Map<string, GoalEventHandler>();
    const pi = {
      on(name: string, handler: GoalEventHandler) {
        handlers.set(name, handler);
      },
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendMessage: vi.fn(),
    } as object as ExtensionAPI;
    const storage = new MemoryGoalStorage();
    await storage.create({
      id: "goal-1",
      scopeId: "session-1",
      name: "Recover completion",
      objective: "finish after restart",
      status: "active",
      budget: {},
      usage: { iterations: 0, tokens: 0 },
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await storage.putPendingEvaluation({
      scopeId: "session-1",
      goalId: "goal-1",
      goalVersion: 1,
      evaluationId: "evaluation-1",
      iterationsDelta: 1,
      progress: { latestOutput: "done", tokenDelta: 10 },
      attempt: 0,
      availableAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const context = {
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session-1" },
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    } as object as ExtensionContext;
    registerAgentGoal(pi, {
      storage,
      evaluator: { evaluate: vi.fn().mockResolvedValue({ outcome: "complete", reason: "done" }) },
      continuation: { continueIfIdle: vi.fn().mockResolvedValue({ status: "started" }) },
    });

    await handlers.get("session_start")?.({}, context);

    expect(await storage.get("session-1")).toBeUndefined();
  });

  it.each([true, false])(
    "evaluates a settled run when a terminal hint is %s",
    async (withTerminalHint) => {
      const handlers = new Map<string, GoalEventHandler>();
      const tools = new Map<string, ToolDefinition>();
      const pi = {
        on(name: string, handler: GoalEventHandler) {
          handlers.set(name, handler);
        },
        registerTool(tool: ToolDefinition) {
          tools.set(tool.name, tool);
        },
        registerCommand: vi.fn(),
        sendMessage: vi.fn(),
      } as object as ExtensionAPI;
      const context = {
        hasUI: true,
        isIdle: () => true,
        hasPendingMessages: () => false,
        sessionManager: { getSessionId: () => "session-1" },
        ui: {
          setStatus: vi.fn(),
          setWidget: vi.fn(),
          notify: vi.fn(),
        },
      } as object as ExtensionContext;
      const storage = new MemoryGoalStorage();
      await storage.create({
        id: "goal-1",
        scopeId: "session-1",
        objective: "ship",
        status: "active",
        budget: { maxIterations: 5 },
        usage: { iterations: 0, tokens: 0 },
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const evaluator = {
        evaluate: vi.fn().mockResolvedValue({ outcome: "complete", reason: "verified" }),
      };
      registerAgentGoal(pi, {
        storage,
        evaluator,
        continuation: { continueIfIdle: vi.fn().mockResolvedValue({ status: "started" }) },
      });
      const updateGoalTool = tools.get("update_goal");
      if (!updateGoalTool?.execute) throw new Error("update_goal was not registered");

      await handlers.get("agent_start")?.({}, context);
      if (withTerminalHint) {
        await updateGoalTool.execute(
          "call-1",
          { status: "complete", reason: "all acceptance checks pass" },
          new AbortController().signal,
          undefined,
          context,
        );
      }
      await handlers.get("agent_end")?.({ messages: [] }, context);
      await handlers.get("agent_settled")?.({}, context);

      expect(evaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ id: "goal-1", usage: { iterations: 1, tokens: 0 } }),
        withTerminalHint
          ? expect.objectContaining({
              terminalCandidate: {
                outcome: "complete",
                reason: "all acceptance checks pass",
              },
            })
          : expect.objectContaining({ terminalCandidate: undefined }),
      );
      expect(await storage.get("session-1")).toBeUndefined();
    },
  );

  it("discusses a goal idea without creating or starting a goal", async () => {
    const handlers = new Map<string, GoalEventHandler>();
    const commands = new Map<string, RegisteredCommand>();
    const sendMessage = vi.fn();
    const pi = {
      on(name: string, handler: GoalEventHandler) {
        handlers.set(name, handler);
      },
      registerTool: vi.fn(),
      registerCommand(name: string, command: RegisteredCommand) {
        commands.set(name, command);
      },
      sendMessage,
    } as object as ExtensionAPI;
    const context = {
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => true,
      sessionManager: { getSessionId: () => "session-1" },
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
    } as object as ExtensionCommandContext;
    const storage = new MemoryGoalStorage();
    registerAgentGoal(pi, {
      storage,
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({ outcome: "complete", reason: "verified" }),
      },
    });
    const command = commands.get("goal");
    if (!command) throw new Error("goal command was not registered");

    await command.handler("verify operator goal start", context);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: "agent-goal.idea",
        content:
          "Discuss scope, constraints, done criteria, evidence, and limits; call create_goal after user confirmation.\nGoal idea (user data): verify operator goal start",
        display: true,
      },
      { triggerTurn: true },
    );
    expect(await storage.get("session-1")).toBeUndefined();
    expect(await storage.getContinuationClaim("session-1")).toBeUndefined();

    await handlers.get("agent_start")?.({}, context);
    await handlers.get("agent_end")?.({ messages: [] }, context);
    await handlers.get("agent_settled")?.({}, context);

    expect(await storage.get("session-1")).toBeUndefined();
    await handlers.get("session_shutdown")?.({}, context);
  });

  it.each([false, true])("demo leaves goal state unchanged (existing: %s)", async (existing) => {
    const commands = new Map<string, RegisteredCommand>();
    const sendMessage = vi.fn();
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      sendMessage,
      registerCommand(name: string, command: RegisteredCommand) {
        commands.set(name, command);
      },
    } as object as ExtensionAPI;
    const storage = new MemoryGoalStorage();
    if (existing)
      await storage.create({
        id: "goal-1",
        scopeId: "session-1",
        objective: "Preserve my work",
        status: "active",
        budget: {},
        usage: { iterations: 0, tokens: 0 },
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    const before = await storage.get("session-1");
    const evaluate = vi.fn();
    const continueIfIdle = vi.fn();
    registerAgentGoal(pi, { storage, evaluator: { evaluate }, continuation: { continueIfIdle } });
    const notify = vi.fn();
    const context = {
      hasUI: true,
      ui: { notify },
      sessionManager: { getSessionId: () => "session-1" },
    } as object as ExtensionCommandContext;
    await commands.get("goal")!.handler("demo", context);
    if (existing) {
      expect(sendMessage).not.toHaveBeenCalled();
      expect(notify).toHaveBeenLastCalledWith(
        expect.stringContaining("current goal is unchanged"),
        "error",
      );
      await commands.get("goal")!.handler("a new goal idea", context);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(notify).toHaveBeenLastCalledWith(
        expect.stringContaining("already has a goal"),
        "error",
      );
    } else
      expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
        {
          customType: "agent-goal.demo",
          content:
            "Walk me through goals: agree a tiny example, create it, record a checkpoint, inspect /goal, then verify completion. Ask before changing any goal; preserve existing work.",
          display: true,
        },
        { triggerTurn: true },
      );
    expect(await storage.get("session-1")).toEqual(before);
    expect(await storage.getContinuationClaim("session-1")).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
    expect(continueIfIdle).not.toHaveBeenCalled();
  });

  it("automatically retries a continuation deferred while the session is busy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const handlers = new Map<string, GoalEventHandler>();
    const tools = new Map<string, ToolDefinition>();
    const sendMessage = vi.fn();
    const pi = {
      on(name: string, handler: GoalEventHandler) {
        handlers.set(name, handler);
      },
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      registerCommand: vi.fn(),
      sendMessage,
    } as object as ExtensionAPI;
    let idle = false;
    const context = {
      hasUI: true,
      isIdle: () => idle,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session-1" },
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
    } as object as ExtensionContext;
    const storage = new MemoryGoalStorage();
    await storage.create({
      id: "goal-1",
      scopeId: "session-1",
      objective: "ship",
      status: "active",
      budget: { maxIterations: 5 },
      usage: { iterations: 0, tokens: 0 },
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    registerAgentGoal(pi, {
      storage,
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "more work remains" }),
      },
    });

    await handlers.get("agent_start")?.({}, context);
    await handlers.get("agent_end")?.({ messages: [] }, context);
    await handlers.get("agent_settled")?.({}, context);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await storage.getContinuationClaim("session-1")).toMatchObject({ state: "deferred" });

    idle = true;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: "agent-goal.continuation",
        content:
          "[agent-goal.continuation]\nObjective (user data): ship\nGuidance: more work remains",
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
    expect(await storage.getContinuationClaim("session-1")).toMatchObject({ state: "started" });
    await handlers.get("session_shutdown")?.({}, context);
  });

  it("opens a goal overlay in TUI mode and preserves the textual fallback", async () => {
    const commands = new Map<string, RegisteredCommand>();
    const sendMessage = vi.fn();
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand(name: string, command: RegisteredCommand) {
        commands.set(name, command);
      },
      sendMessage,
    } as object as ExtensionAPI;
    const custom = vi.fn(async (factory: GoalWindowFactory) => {
      factory(
        { requestRender: vi.fn() },
        { fg: (_color, text) => text, bold: (text) => text } as Theme,
        {},
        vi.fn(),
      );
    });
    const context = {
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session-1" },
      ui: {
        custom,
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
    } as object as ExtensionCommandContext;
    registerAgentGoal(pi, { storage: new MemoryGoalStorage() });
    const command = commands.get("goal");
    if (!command) throw new Error("goal command was not registered");

    await command.handler("", context);

    expect(custom).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        overlay: true,
        overlayOptions: expect.objectContaining({ anchor: "center" }),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();

    custom.mockImplementation(async () => undefined);
    await command.handler("", context);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "This session has no goal." }),
      { triggerTurn: false },
    );
  });

  it("lets the operator and agent update the same bounded goal budget", async () => {
    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, RegisteredCommand>();
    const pi = {
      on: vi.fn(),
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, command: RegisteredCommand) {
        commands.set(name, command);
      },
      sendMessage: vi.fn(),
    } as object as ExtensionAPI;
    const storage = new MemoryGoalStorage();
    await storage.create({
      id: "goal-1",
      scopeId: "session-1",
      objective: "ship",
      status: "active",
      budget: { maxIterations: 5, maxTokens: 10_000 },
      usage: { iterations: 1, tokens: 500 },
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const notify = vi.fn();
    const context = {
      hasUI: true,
      sessionManager: { getSessionId: () => "session-1" },
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify },
    } as object as ExtensionCommandContext;
    registerAgentGoal(pi, {
      storage,
      defaultBudget: { maxIterations: 20, maxTokens: 100_000 },
    });
    const tool = tools.get("update_goal_budget");
    const command = commands.get("goal");
    if (!tool?.execute || !command) throw new Error("goal budget controls were not registered");

    await tool.execute(
      "call-1",
      { maxTurns: 12, maxRuntimeMs: 7_200_000 },
      new AbortController().signal,
      undefined,
      context,
    );
    await command.handler("update budget turns 8", context);

    expect(await storage.get("session-1")).toMatchObject({
      budget: { maxIterations: 8, maxTokens: 10_000, maxRuntimeMs: 7_200_000 },
      usage: { iterations: 1, tokens: 500 },
      version: 3,
    });
    expect(notify).toHaveBeenCalledWith("Goal command applied: update budget turns 8", "info");
  });

  it("opens the edit form and marks the next turn as an updated goal", async () => {
    const commands = new Map<string, RegisteredCommand>();
    const sendMessage = vi.fn();
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand(name: string, command: RegisteredCommand) {
        commands.set(name, command);
      },
      sendMessage,
    } as object as ExtensionAPI;
    const storage = new MemoryGoalStorage();
    await storage.create({
      id: "goal-1",
      scopeId: "session-1",
      name: "Editable goal",
      objective: "old objective",
      status: "active",
      budget: {},
      usage: { iterations: 0, tokens: 0 },
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    let windowCount = 0;
    const custom = vi.fn(async (factory: GoalWindowFactory) => {
      let action: GoalWindowAction = "close";
      const component = factory(
        { requestRender: vi.fn() },
        { fg: (_color, text) => text, bold: (text) => text } as Theme,
        {},
        (nextAction) => (action = nextAction),
      ) as Component & { handleInput(data: string): void; dispose?: () => void };
      if (windowCount === 0) {
        expect(component.render(66).join("\n")).toContain("Goal · edit");
        component.handleInput("\t");
        for (let index = 0; index < "old objective".length; index += 1)
          component.handleInput("\u007f");
        component.handleInput("updated objective");
        component.handleInput("\r");
      }
      windowCount += 1;
      component.dispose?.();
      return action;
    });
    const context = {
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session-1" },
      ui: { custom, setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    } as object as ExtensionCommandContext;
    registerAgentGoal(pi, { storage });
    const command = commands.get("goal");
    if (!command) throw new Error("goal command was not registered");

    await command.handler("update", context);

    expect(custom).toHaveBeenCalledTimes(2);
    expect(await storage.get("session-1")).toMatchObject({
      name: "Editable goal",
      objective: "updated objective",
      status: "active",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: "agent-goal.updated",
        content: "[agent-goal.updated]\nObjective (user data): updated objective",
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });

  it("applies the documented update, limit, snooze, clear, and close commands", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const commands = new Map<string, RegisteredCommand>();
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand(name: string, command: RegisteredCommand) {
        commands.set(name, command);
      },
      sendMessage: vi.fn(),
    } as object as ExtensionAPI;
    const storage = new MemoryGoalStorage();
    await storage.create({
      id: "goal-1",
      scopeId: "session-1",
      name: "Old name",
      objective: "old objective",
      status: "active",
      budget: { maxIterations: 5, maxTokens: 10_000 },
      usage: { iterations: 1, tokens: 500 },
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const notify = vi.fn();
    const context = {
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session-1" },
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify },
    } as object as ExtensionCommandContext;
    registerAgentGoal(pi, { storage });
    const command = commands.get("goal");
    if (!command) throw new Error("goal command was not registered");

    await command.handler("update name New name", context);
    expect(await storage.get("session-1")).toMatchObject({
      name: "New name",
      objective: "old objective",
      usage: { iterations: 1, tokens: 500 },
    });
    await command.handler("update objective new objective", context);
    expect(await storage.get("session-1")).toMatchObject({
      name: "New name",
      objective: "new objective",
    });
    await command.handler("update budget runtime 2h", context);
    expect(await storage.get("session-1")).toMatchObject({
      budget: { maxIterations: 5, maxTokens: 10_000, maxRuntimeMs: 7_200_000 },
    });
    await command.handler("update budget off", context);
    expect((await storage.get("session-1"))?.budget).toEqual({});
    await command.handler("snooze 30m", context);
    expect(await storage.get("session-1")).toMatchObject({
      status: "active",
      snoozedUntil: "2026-01-01T00:30:00.000Z",
    });
    await command.handler("update shorthand objective", context);
    expect(await storage.get("session-1")).toMatchObject({
      name: "New name",
      objective: "shorthand objective",
    });
    await command.handler("update budget turns", context);
    expect(await storage.get("session-1")).toMatchObject({ objective: "shorthand objective" });
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("complete update"), "error");
    await command.handler("clear", context);
    expect(await storage.get("session-1")).toBeUndefined();

    await storage.create({
      id: "goal-2",
      scopeId: "session-1",
      name: "Close me",
      objective: "verify the close alias",
      status: "active",
      budget: {},
      usage: { iterations: 0, tokens: 0 },
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await command.handler("close", context);
    expect(await storage.get("session-1")).toBeUndefined();
  });

  it("keeps passive UI compact and applies modal actions before refreshing", async () => {
    const handlers = new Map<string, GoalEventHandler>();
    const commands = new Map<string, RegisteredCommand>();
    const pi = {
      on(name: string, handler: GoalEventHandler) {
        handlers.set(name, handler);
      },
      registerTool: vi.fn(),
      registerCommand(name: string, command: RegisteredCommand) {
        commands.set(name, command);
      },
      sendMessage: vi.fn(),
    } as object as ExtensionAPI;
    const storage = new MemoryGoalStorage();
    await storage.create({
      id: "goal-1",
      scopeId: "session-1",
      objective: "ship",
      status: "active",
      budget: { maxIterations: 5 },
      usage: { iterations: 1, tokens: 10 },
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const actions: GoalWindowAction[] = [
      { type: "budget", maxIterations: 1, maxTokens: 10 },
      { type: "budget", maxIterations: 4, maxTokens: 1_000 },
      "pause",
      "close",
    ];
    let customCall = 0;
    const custom = vi.fn(async (factory: GoalWindowFactory) => {
      const component = factory(
        { requestRender: vi.fn() },
        { fg: (_color, text) => text, bold: (text) => text } as Theme,
        {},
        vi.fn(),
      );
      customCall += 1;
      if (customCall === 2) {
        expect(component.render(66).join("\n")).toContain("current turn");
      }
      return actions.shift();
    });
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    const context = {
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session-1" },
      ui: { custom, setStatus, setWidget, notify: vi.fn() },
    } as object as ExtensionCommandContext;
    registerAgentGoal(pi, { storage });
    const command = commands.get("goal");
    if (!command) throw new Error("goal command was not registered");

    await handlers.get("session_start")?.({}, context);
    await command.handler("", context);

    expect(setStatus).toHaveBeenCalledWith("agent-goal", expect.stringMatching(/^🎯 ship /));
    expect(setWidget).toHaveBeenCalledWith("agent-goal", undefined);
    expect(custom).toHaveBeenCalledTimes(4);
    expect(await storage.get("session-1")).toMatchObject({
      status: "paused",
      budget: { maxIterations: 4, maxTokens: 1_000 },
    });
    expect(setStatus).toHaveBeenLastCalledWith("agent-goal", expect.stringMatching(/^🎯 ship /));
  });

  it("marks the first continuation after create_goal as a new goal", async () => {
    const handlers = new Map<string, GoalEventHandler>();
    const tools = new Map<string, ToolDefinition>();
    const sendMessage = vi.fn();
    const pi = {
      on(name: string, handler: GoalEventHandler) {
        handlers.set(name, handler);
      },
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      registerCommand: vi.fn(),
      sendMessage,
    } as object as ExtensionAPI;
    const context = {
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session-1" },
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    } as object as ExtensionContext;
    registerAgentGoal(pi, {
      storage: new MemoryGoalStorage(),
      evaluator: { evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "begin" }) },
    });
    const createGoal = tools.get("create_goal");
    if (!createGoal?.execute) throw new Error("create_goal was not registered");

    await handlers.get("agent_start")?.({}, context);
    await createGoal.execute(
      "call-1",
      { objective: "ship the explicit lifecycle" },
      new AbortController().signal,
      undefined,
      context,
    );
    await handlers.get("agent_end")?.({ messages: [] }, context);
    await handlers.get("agent_settled")?.({}, context);

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      {
        customType: "agent-goal.started",
        content: "[agent-goal.started]\nObjective (user data): ship the explicit lifecycle",
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
    await handlers.get("session_shutdown")?.({}, context);
  });

  it.each(["complete", "blocked"] as const)(
    "automatically evaluates a worker-created goal as %s without charging its creating run",
    async (outcome) => {
      const handlers = new Map<string, GoalEventHandler>();
      const tools = new Map<string, ToolDefinition>();
      const pi = {
        on(name: string, handler: GoalEventHandler) {
          handlers.set(name, handler);
        },
        registerTool(tool: ToolDefinition) {
          tools.set(tool.name, tool);
        },
        registerCommand: vi.fn(),
        sendMessage: vi.fn(),
      } as object as ExtensionAPI;
      const context = {
        hasUI: true,
        isIdle: () => true,
        hasPendingMessages: () => false,
        sessionManager: { getSessionId: () => "session-1" },
        ui: {
          setStatus: vi.fn(),
          setWidget: vi.fn(),
          notify: vi.fn(),
        },
      } as object as ExtensionContext;
      const storage = new MemoryGoalStorage();
      const continuation = { continueIfIdle: vi.fn().mockResolvedValue({ status: "started" }) };
      const evaluator = {
        evaluate: vi.fn().mockResolvedValue({ outcome, reason: "independently verified" }),
      };
      registerAgentGoal(pi, {
        storage,
        evaluator,
        continuation,
        defaultBudget: { maxIterations: 8 },
      });
      const createGoalTool = tools.get("create_goal");
      const getGoalTool = tools.get("get_goal");
      if (!createGoalTool?.execute || !getGoalTool?.execute) {
        throw new Error("goal tools were not registered");
      }

      await handlers.get("agent_start")?.({}, context);
      await createGoalTool.execute(
        "call-1",
        { name: "Finish task", objective: "finish the approved task" },
        new AbortController().signal,
        undefined,
        context,
      );
      await handlers.get("agent_end")?.({ messages: [] }, context);
      await handlers.get("agent_settled")?.({}, context);
      const inspected = await getGoalTool.execute(
        "call-2",
        {},
        new AbortController().signal,
        undefined,
        context,
      );

      expect(evaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ usage: { iterations: 0, tokens: 0 } }),
        expect.objectContaining({ terminalCandidate: undefined, tokenDelta: 0 }),
      );
      if (outcome === "complete") expect(await storage.get("session-1")).toBeUndefined();
      else
        expect(await storage.get("session-1")).toMatchObject({
          objective: "finish the approved task",
          status: "blocked",
          name: "Finish task",
          budget: { maxIterations: 8 },
          usage: { iterations: 0, tokens: 0 },
        });
      expect(continuation.continueIfIdle).not.toHaveBeenCalled();
      expect(inspected.content[0]).toMatchObject({ type: "text" });
    },
  );
});
