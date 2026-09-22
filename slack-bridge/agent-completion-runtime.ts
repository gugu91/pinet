import type {
  AgentSettledEvent,
  AgentStartEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface AgentCompletionRuntimeDeps {
  clearFollowUpPending: () => void;
  signalAgentWorking: () => Promise<void>;
  signalAgentFree: (ctx: ExtensionContext) => Promise<unknown>;
  formatError: (error: unknown) => string;
}

export interface AgentCompletionRuntime {
  onAgentStart: (_event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>;
  onAgentEnd: (_event: unknown, ctx: ExtensionContext) => Promise<void>;
  onAgentSettled: (_event: AgentSettledEvent, ctx: ExtensionContext) => Promise<void>;
}

export function createAgentCompletionRuntime(
  deps: AgentCompletionRuntimeDeps,
): AgentCompletionRuntime {
  async function onAgentStart(_event: AgentStartEvent, ctx: ExtensionContext): Promise<void> {
    try {
      await deps.signalAgentWorking();
    } catch (err) {
      ctx.ui.notify(`Pinet working status sync failed: ${deps.formatError(err)}`, "warning");
    }
  }

  async function onAgentEnd(_event: unknown, _ctx: ExtensionContext): Promise<void> {
    deps.clearFollowUpPending();
  }

  async function onAgentSettled(_event: AgentSettledEvent, ctx: ExtensionContext): Promise<void> {
    try {
      await deps.signalAgentFree(ctx);
    } catch (err) {
      ctx.ui.notify(`Pinet auto-free failed: ${deps.formatError(err)}`, "warning");
    }
  }

  return {
    onAgentStart,
    onAgentEnd,
    onAgentSettled,
  };
}
