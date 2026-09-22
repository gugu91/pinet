import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentCompletionRuntime,
  type AgentCompletionRuntimeDeps,
} from "./agent-completion-runtime.js";

function createContext() {
  const notify = vi.fn();
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    isIdle: () => true,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
      },
      notify,
      setStatus: vi.fn(),
    },
    sessionManager: {
      getEntries: () => [],
      getHeader: () => null,
      getLeafId: () => "leaf-123",
      getSessionFile: () => "/tmp/agent-completion-runtime.json",
    },
  } as unknown as ExtensionContext;

  return { ctx, notify };
}

function createDeps(overrides: Partial<AgentCompletionRuntimeDeps> = {}) {
  const clearFollowUpPending = vi.fn();
  const signalAgentWorking = vi.fn(async () => {});
  const signalAgentFree = vi.fn(async () => ({ queuedInboxCount: 0, drainedQueuedInbox: false }));

  const deps: AgentCompletionRuntimeDeps = {
    clearFollowUpPending,
    signalAgentWorking,
    signalAgentFree,
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides,
  };

  return {
    deps,
    clearFollowUpPending,
    signalAgentWorking,
    signalAgentFree,
  };
}

describe("createAgentCompletionRuntime", () => {
  it("marks every run working, cleans per-run state, and frees only on settlement", async () => {
    const { deps, clearFollowUpPending, signalAgentWorking, signalAgentFree } = createDeps();
    const runtime = createAgentCompletionRuntime(deps);
    const { ctx, notify } = createContext();

    await runtime.onAgentStart({ type: "agent_start" }, ctx);
    await runtime.onAgentEnd({ type: "agent_end", messages: [] }, ctx);
    await runtime.onAgentStart({ type: "agent_start" }, ctx);
    await runtime.onAgentEnd({ type: "agent_end", messages: [] }, ctx);

    expect(signalAgentWorking).toHaveBeenCalledTimes(2);
    expect(clearFollowUpPending).toHaveBeenCalledTimes(2);
    expect(signalAgentFree).not.toHaveBeenCalled();

    await runtime.onAgentSettled({ type: "agent_settled" }, ctx);

    expect(signalAgentFree).toHaveBeenCalledWith(ctx);
    expect(notify).not.toHaveBeenCalled();
  });

  it("warns when working status sync fails without blocking the run", async () => {
    const signalAgentWorking = vi.fn(async () => {
      throw new Error("broker unavailable");
    });
    const { deps } = createDeps({ signalAgentWorking });
    const runtime = createAgentCompletionRuntime(deps);
    const { ctx, notify } = createContext();

    await runtime.onAgentStart({ type: "agent_start" }, ctx);

    expect(notify).toHaveBeenCalledWith(
      "Pinet working status sync failed: broker unavailable",
      "warning",
    );
  });

  it("warns when settled auto-free fails after per-run cleanup", async () => {
    const signalAgentFree = vi.fn(async () => {
      throw new Error("status sync failed once");
    });
    const { deps, clearFollowUpPending } = createDeps({ signalAgentFree });
    const runtime = createAgentCompletionRuntime(deps);
    const { ctx, notify } = createContext();

    await runtime.onAgentEnd({ type: "agent_end", messages: [] }, ctx);
    await runtime.onAgentSettled({ type: "agent_settled" }, ctx);

    expect(clearFollowUpPending).toHaveBeenCalledTimes(1);
    expect(signalAgentFree).toHaveBeenCalledWith(ctx);
    expect(notify).toHaveBeenCalledWith(
      "Pinet auto-free failed: status sync failed once",
      "warning",
    );
  });
});
