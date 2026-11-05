import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface AgentCompletionThreadState {
  channelId: string;
}

export interface AgentCompletionRuntimeDeps {
  getThreads: () => Map<string, AgentCompletionThreadState>;
  clearThreadStatus: (channelId: string, threadTs: string) => Promise<void>;
  clearFollowUpPending: () => void;
  signalAgentFree: (ctx: ExtensionContext) => Promise<unknown>;
  formatError: (error: unknown) => string;
}

export interface AgentCompletionRuntime {
  trackThinkingThread: (threadTs: string) => void;
  onAgentEnd: (_event: unknown, ctx: ExtensionContext) => Promise<void>;
}

export function createAgentCompletionRuntime(
  deps: AgentCompletionRuntimeDeps,
): AgentCompletionRuntime {
  const thinking = new Set<string>();

  function trackThinkingThread(threadTs: string): void {
    thinking.add(threadTs);
  }

  async function onAgentEnd(_event: unknown, ctx: ExtensionContext): Promise<void> {
    const threads = deps.getThreads();
    const finished = [...thinking];
    await Promise.all(
      finished.flatMap((threadTs) => {
        const thread = threads.get(threadTs);
        return thread ? [deps.clearThreadStatus(thread.channelId, threadTs)] : [];
      }),
    );
    for (const threadTs of finished) thinking.delete(threadTs);
    deps.clearFollowUpPending();

    try {
      await deps.signalAgentFree(ctx);
    } catch (err) {
      ctx.ui.notify(`Pinet auto-free failed: ${deps.formatError(err)}`, "warning");
    }
  }

  return {
    trackThinkingThread,
    onAgentEnd,
  };
}
