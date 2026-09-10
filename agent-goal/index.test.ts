import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      expect(await storage.get("session-1")).toMatchObject({ status: "complete" });
    },
  );

  it("starts an operator-created goal when the idle session reports pending delivery", async () => {
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
    expect(await storage.getContinuationClaim("session-1")).toMatchObject({ state: "started" });

    await handlers.get("agent_start")?.({}, context);
    await handlers.get("agent_end")?.({ messages: [] }, context);
    await handlers.get("agent_settled")?.({}, context);

    expect(await storage.get("session-1")).toMatchObject({
      status: "complete",
      usage: { iterations: 1, tokens: 0 },
    });
    await handlers.get("session_shutdown")?.({}, context);
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

    expect(setStatus).toHaveBeenCalledWith("agent-goal", expect.stringMatching(/^🎯 \| ship \| /));
    expect(setWidget).toHaveBeenCalledWith("agent-goal", undefined);
    expect(custom).toHaveBeenCalledTimes(4);
    expect(await storage.get("session-1")).toMatchObject({
      status: "paused",
      budget: { maxIterations: 4, maxTokens: 1_000 },
    });
    expect(setStatus).toHaveBeenLastCalledWith(
      "agent-goal",
      expect.stringMatching(/^🎯 \| ship \| /),
    );
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
      expect(await storage.get("session-1")).toMatchObject({
        objective: "finish the approved task",
        status: outcome,
        name: "Finish task",
        budget: { maxIterations: 8 },
        usage: { iterations: 0, tokens: 0 },
      });
      expect(continuation.continueIfIdle).not.toHaveBeenCalled();
      expect(inspected.content[0]).toMatchObject({ type: "text" });
    },
  );
});
