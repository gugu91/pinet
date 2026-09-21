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
  const threads = new Map<string, { channelId: string }>();
  const clearThreadStatus = vi.fn(async () => {});
  const clearFollowUpPending = vi.fn();
  const signalAgentFree = vi.fn(async () => ({ queuedInboxCount: 0, drainedQueuedInbox: false }));

  const deps: AgentCompletionRuntimeDeps = {
    getThreads: () => threads,
    clearThreadStatus,
    clearFollowUpPending,
    signalAgentFree,
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides,
  };

  return {
    deps,
    threads,
    clearThreadStatus,
    clearFollowUpPending,
    signalAgentFree,
  };
}

describe("createAgentCompletionRuntime", () => {
  it("cleans up each run at agent_end and frees the agent only at agent_settled", async () => {
    const { deps, threads, clearThreadStatus, clearFollowUpPending, signalAgentFree } =
      createDeps();
    const runtime = createAgentCompletionRuntime(deps);
    const { ctx, notify } = createContext();

    threads.set("100.1", { channelId: "D100" });
    threads.set("200.2", { channelId: "D200" });
    runtime.trackThinkingThread("100.1");
    runtime.trackThinkingThread("missing.3");
    runtime.trackThinkingThread("200.2");

    await runtime.onAgentEnd({}, ctx);

    expect(clearThreadStatus).not.toHaveBeenCalled();
    expect(clearFollowUpPending).toHaveBeenCalledTimes(1);
    expect(signalAgentFree).not.toHaveBeenCalled();

    await runtime.onAgentSettled({ type: "agent_settled" }, ctx);

    expect(clearThreadStatus).toHaveBeenNthCalledWith(1, "D100", "100.1");
    expect(clearThreadStatus).toHaveBeenNthCalledWith(2, "D200", "200.2");
    expect(signalAgentFree).toHaveBeenCalledWith(ctx);
    expect(clearFollowUpPending.mock.invocationCallOrder[0]).toBeLessThan(
      signalAgentFree.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(notify).not.toHaveBeenCalled();

    await runtime.onAgentEnd({}, ctx);
    expect(clearThreadStatus).toHaveBeenCalledTimes(2);
  });

  it("does not expose Slack completion or Pinet free when Pi retries before settlement", async () => {
    const { deps, threads, clearThreadStatus, signalAgentFree } = createDeps();
    const runtime = createAgentCompletionRuntime(deps);
    const { ctx } = createContext();

    threads.set("100.1", { channelId: "D100" });
    runtime.trackThinkingThread("100.1");

    await runtime.onAgentEnd({}, ctx);
    await runtime.onAgentEnd({}, ctx);

    expect(clearThreadStatus).not.toHaveBeenCalled();
    expect(signalAgentFree).not.toHaveBeenCalled();

    await runtime.onAgentSettled({ type: "agent_settled" }, ctx);
    expect(clearThreadStatus).toHaveBeenCalledWith("D100", "100.1");
    expect(signalAgentFree).toHaveBeenCalledTimes(1);
  });

  it("warns when settled auto-free fails after clearing tracked cleanup state", async () => {
    const error = new Error("status sync failed once");
    const signalAgentFree = vi.fn(async () => {
      throw error;
    });
    const { deps, threads, clearThreadStatus, clearFollowUpPending } = createDeps({
      signalAgentFree,
    });
    const runtime = createAgentCompletionRuntime(deps);
    const { ctx, notify } = createContext();

    threads.set("100.1", { channelId: "D100" });
    runtime.trackThinkingThread("100.1");

    await runtime.onAgentEnd({}, ctx);
    await runtime.onAgentSettled({ type: "agent_settled" }, ctx);

    expect(clearThreadStatus).toHaveBeenCalledWith("D100", "100.1");
    expect(clearFollowUpPending).toHaveBeenCalledTimes(1);
    expect(signalAgentFree).toHaveBeenCalledWith(ctx);
    expect(notify).toHaveBeenCalledWith(
      "Pinet auto-free failed: status sync failed once",
      "warning",
    );

    await runtime.onAgentEnd({}, ctx);
    expect(clearThreadStatus).toHaveBeenCalledTimes(1);
  });
});
