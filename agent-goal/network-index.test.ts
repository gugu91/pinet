import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentGoal } from "./index.js";
import { MemoryGoalStorage } from "./memory-storage.js";
import { GoalNetworkRecovery, type GoalNetworkRecoveryRequest } from "./network-recovery.js";
import type { GoalProgressMessage } from "./progress.js";

vi.mock("@earendil-works/pi-ai", () => ({ completeSimple: vi.fn() }));

interface TestEvent {
  messages?: GoalProgressMessage[];
  aborted?: boolean;
  source?: "interactive" | "rpc" | "extension";
}
type Handler = (event: TestEvent, ctx: ExtensionContext) => void | Promise<void>;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

async function fixture(builtInEvaluator = false) {
  const handlers = new Map<string, Handler>();
  let request: GoalNetworkRecoveryRequest | undefined;
  const start = vi.spyOn(GoalNetworkRecovery.prototype, "start").mockImplementation((value) => {
    request = value;
    return true;
  });
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
  } as object as ExtensionAPI;
  const storage = new MemoryGoalStorage();
  const evaluate = vi.fn().mockResolvedValue({ outcome: "continue", reason: "keep working" });
  const continueIfIdle = vi.fn().mockResolvedValue({ status: "started" });
  let terminalInput: (() => undefined) | undefined;
  const data = {
    cwd: "/tmp",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    model: { api: "test", provider: "test", id: "model", baseUrl: "https://endpoint.example/v1" },
    modelRegistry: { getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true }) },
    sessionManager: { getSessionId: () => "session" },
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      onTerminalInput: (handler: () => undefined) => {
        terminalInput = handler;
        return vi.fn();
      },
    },
  };
  const ctx = data as object as ExtensionContext;
  registerAgentGoal(pi, {
    storage,
    ...(builtInEvaluator ? {} : { evaluator: { evaluate } }),
    continuation: { continueIfIdle },
  });
  const emit = async (name: string, event: TestEvent = {}): Promise<void> => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Missing ${name}`);
    await handler(event, ctx);
  };
  cleanups.push(() => {
    void emit("session_shutdown");
  });
  await emit("session_start");
  await storage.create({
    id: "goal",
    scopeId: "session",
    objective: "ship",
    status: "active",
    budget: {},
    usage: { iterations: 0, tokens: 0 },
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const outage = async (aborted = false): Promise<void> => {
    await emit("agent_start");
    await emit("agent_end", {
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "fetch failed",
          usage: { totalTokens: 3 },
        },
      ],
    });
    await emit("agent_settled", { aborted });
  };
  const recovery = (): GoalNetworkRecoveryRequest => {
    if (!request) throw new Error("Expected network recovery request");
    return request;
  };
  return {
    data,
    storage,
    emit,
    outage,
    recovery,
    start,
    evaluate,
    continueIfIdle,
    type: () => terminalInput?.(),
  };
}

describe("goal outage integration", () => {
  it("a second model recovery remains waiting behind a cancelled credential lookup", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "CONTINUE: keep working" }],
    });
    const f = await fixture(true);
    let finishAuth!: (auth: { ok: true }) => void;
    const auth = f.data.modelRegistry.getApiKeyAndHeaders;
    auth.mockImplementationOnce(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finishAuth = resolve;
        }),
    );
    await f.outage();
    const recoveringA = f.recovery().resume();
    await vi.waitFor(() => expect(auth).toHaveBeenCalledTimes(1));
    f.data.model.id = "model-B";
    await f.emit("model_select");
    await f.outage();
    const requestB = f.recovery();
    expect(await requestB.canResume()).toBe(true);
    expect(await requestB.resume()).toBe("busy");
    expect(
      f.data.ui.setStatus.mock.calls.filter(([name]) => name === "agent-goal-network").at(-1),
    ).toEqual(["agent-goal-network", "🌐 Waiting for model endpoint"]);
    finishAuth({ ok: true });
    expect(await recoveringA).toBe("cancelled");
    expect(await requestB.canResume()).toBe(true);
    expect(await requestB.resume()).toBe("resumed");
    expect(auth).toHaveBeenCalledTimes(2);
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(f.continueIfIdle).toHaveBeenCalledTimes(1);
    expect(await f.storage.get("session")).toMatchObject({ usage: { iterations: 2, tokens: 6 } });
    expect(await f.storage.getPendingEvaluation("session")).toBeUndefined();
    requestB.stopped("resumed");
    expect(
      f.data.ui.setStatus.mock.calls.filter(([name]) => name === "agent-goal-network").at(-1),
    ).toEqual(["agent-goal-network", undefined]);
  });

  it("arms only at final native settlement and resumes through one normal claim", async () => {
    const f = await fixture();
    await f.emit("agent_start");
    await f.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "ECONNRESET" }],
    });
    expect(f.start).not.toHaveBeenCalled();
    await f.emit("agent_settled");
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(f.continueIfIdle).not.toHaveBeenCalled();
    expect(f.recovery().target).toEqual({ hostname: "endpoint.example", port: 443 });
    expect(await f.recovery().canResume()).toBe(true);
    await f.recovery().resume();
    await f.recovery().resume();
    expect(f.evaluate).toHaveBeenCalledTimes(1);
    expect(f.continueIfIdle).toHaveBeenCalledTimes(1);
  });

  it("never arms for an aborted final boundary", async () => {
    const f = await fixture();
    await f.outage(true);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(f.continueIfIdle).not.toHaveBeenCalled();
  });

  it.each([
    "typing",
    "input",
    "shutdown",
    "model",
    "model_select",
    "session_before_switch",
    "session_before_fork",
    "session_before_tree",
    "clear",
    "snooze",
    "limits",
    "pause",
  ])("cancels or rejects recovery after %s", async (action) => {
    const f = await fixture();
    await f.outage();
    const request = f.recovery();
    if (action === "typing") f.type();
    else if (action === "input") await f.emit("input", { source: "interactive" });
    else if (action === "shutdown") await f.emit("session_shutdown");
    else if (action === "model") f.data.model.baseUrl = "https://other.example/v1";
    else if (action === "model_select" || action.startsWith("session_before_"))
      await f.emit(action);
    else {
      const goal = await f.storage.get("session");
      if (!goal) throw new Error("Expected goal");
      if (action === "clear") await f.storage.delete("session", goal.id, goal.version);
      else
        await f.storage.updateBudget(
          {
            ...goal,
            version: goal.version + 1,
            ...(action === "snooze"
              ? { snoozedUntil: new Date(Date.now() + 60_000).toISOString() }
              : {}),
            ...(action === "limits" ? { budget: { maxIterations: 1 } } : {}),
            ...(action === "pause" ? { status: "paused" as const } : {}),
          },
          goal.version,
        );
    }
    expect(await request.canResume()).toBe(false);
    await request.resume();
    request.stopped("cancelled");
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(f.continueIfIdle).not.toHaveBeenCalled();
  });

  it("session reactivation authorizes new recovery without reviving the cancelled callback", async () => {
    const f = await fixture();
    await f.outage();
    const old = f.recovery();
    f.type();
    await f.emit("session_start");
    expect(f.evaluate).toHaveBeenCalledTimes(1);
    expect(f.continueIfIdle).toHaveBeenCalledTimes(1);
    expect(await old.canResume()).toBe(false);
    await old.resume();
    expect(f.continueIfIdle).toHaveBeenCalledTimes(1);
  });

  it("typing during recovery evaluation prevents its stale result from continuing", async () => {
    const f = await fixture();
    await f.outage();
    let finish!: (evaluation: { outcome: "complete"; reason: string }) => void;
    f.evaluate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const resuming = f.recovery().resume();
    await vi.waitFor(() => expect(f.evaluate).toHaveBeenCalledTimes(1));
    f.type();
    finish({ outcome: "complete", reason: "stale result" });
    await resuming;
    expect(f.continueIfIdle).not.toHaveBeenCalled();
    expect(await f.storage.get("session")).toMatchObject({
      status: "active",
      usage: { iterations: 0 },
    });
    expect(await f.storage.getPendingEvaluation("session")).toMatchObject({ iterationsDelta: 1 });
  });

  it("does not arm without a configured HTTP model endpoint", async () => {
    const f = await fixture();
    f.data.model.baseUrl = "file:///tmp/model";
    await f.outage();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("does not arm for a paused goal", async () => {
    const f = await fixture();
    const goal = await f.storage.get("session");
    if (!goal) throw new Error("Expected goal");
    await f.storage.replace({ ...goal, status: "paused", version: 2 }, 1);
    await f.outage();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.evaluate).not.toHaveBeenCalled();
  });
});
