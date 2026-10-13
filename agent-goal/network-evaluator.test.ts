import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGoal } from "./domain.js";
import { PiGoalEvaluator } from "./pi-evaluator.js";

vi.mock("@earendil-works/pi-ai", () => ({ completeSimple: vi.fn() }));
const goal: AgentGoal = {
  id: "goal",
  scopeId: "session",
  objective: "ship",
  status: "active",
  budget: {},
  usage: { iterations: 0, tokens: 0 },
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(completeSimple).mockResolvedValue({
    stopReason: "stop",
    content: [{ type: "text", text: "CONTINUE: work remains" }],
  });
});

describe("network evaluation cancellation", () => {
  it("does not request credentials or provider work for an already-cancelled attempt", async () => {
    const getApiKeyAndHeaders = vi.fn().mockResolvedValue({ ok: true });
    const ctx = {
      model: { api: "test", provider: "test", id: "model" },
      modelRegistry: { getApiKeyAndHeaders },
    } as object as ExtensionContext;
    const evaluator = new PiGoalEvaluator(() => ctx);
    await expect(
      evaluator.evaluate(goal, { latestOutput: "outage" }, AbortSignal.abort()),
    ).rejects.toThrow("cancelled");
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after asynchronous credential acquisition", async () => {
    let finish!: (auth: { ok: true }) => void;
    const getApiKeyAndHeaders = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finish = resolve;
        }),
    );
    const ctx = {
      model: { api: "test", provider: "test", id: "model" },
      modelRegistry: { getApiKeyAndHeaders },
    } as object as ExtensionContext;
    const evaluator = new PiGoalEvaluator(() => ctx);
    const attempt = new AbortController();
    const evaluating = evaluator.evaluate(goal, { latestOutput: "outage" }, attempt.signal);
    attempt.abort();
    finish({ ok: true });
    await expect(evaluating).rejects.toThrow("cancelled");
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("passes the attempt signal to the provider request", async () => {
    const ctx = {
      model: { api: "test", provider: "test", id: "model" },
      modelRegistry: { getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true }) },
    } as object as ExtensionContext;
    const attempt = new AbortController();
    await expect(
      new PiGoalEvaluator(() => ctx).evaluate(goal, { latestOutput: "outage" }, attempt.signal),
    ).resolves.toEqual({ outcome: "continue", reason: "work remains" });
    expect(completeSimple).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ signal: attempt.signal }),
    );
  });
});
