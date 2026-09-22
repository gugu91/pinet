import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentCompletionRuntime } from "./agent-completion-runtime.js";
import {
  createSlackToolPolicyRuntime,
  type SlackToolPolicyRuntime,
  type SlackToolPolicyRuntimeDeps,
} from "./slack-tool-policy-runtime.js";

export interface AgentEventRuntimeDeps extends SlackToolPolicyRuntimeDeps {
  onCompletionAgentStart: AgentCompletionRuntime["onAgentStart"];
  onCompletionAgentEnd: AgentCompletionRuntime["onAgentEnd"];
  onCompletionAgentSettled: AgentCompletionRuntime["onAgentSettled"];
  hasQueuedInbox: () => boolean;
  drainInboxFromSettle: () => void;
  setDeliverTrackedSlackFollowUpMessage: (
    deliver: SlackToolPolicyRuntime["deliverTrackedSlackFollowUpMessage"],
  ) => void;
}

export interface AgentEventRuntime {
  register: (pi: Pick<ExtensionAPI, "on">) => void;
  dispose: () => void;
}

export function createAgentEventRuntime(deps: AgentEventRuntimeDeps): AgentEventRuntime {
  const slackToolPolicyRuntime = createSlackToolPolicyRuntime({
    getBrokerRole: deps.getBrokerRole,
    getGuardrails: deps.getGuardrails,
    requireToolPolicy: deps.requireToolPolicy,
    formatAction: deps.formatAction,
    formatError: deps.formatError,
    deliverFollowUpMessage: deps.deliverFollowUpMessage,
    beginThreadStatus: deps.beginThreadStatus,
    updateThreadStatus: deps.updateThreadStatus,
    clearThreadStatus: deps.clearThreadStatus,
  });

  deps.setDeliverTrackedSlackFollowUpMessage(
    slackToolPolicyRuntime.deliverTrackedSlackFollowUpMessage,
  );

  let lifecycleGeneration = 0;
  let pendingSettlement: ReturnType<typeof setImmediate> | null = null;
  let disposed = false;

  function invalidatePendingSettlement(): void {
    lifecycleGeneration += 1;
    if (pendingSettlement) {
      clearImmediate(pendingSettlement);
      pendingSettlement = null;
    }
  }

  function register(pi: Pick<ExtensionAPI, "on">): void {
    pi.on("input", () => {
      // Pi 0.87 has no prompt-enqueued hook before its sequential input handlers.
      // Once input reaches Pinet, invalidate synchronously: before-start handlers
      // can then block in any registration order without exposing stale idle state.
      invalidatePendingSettlement();
    });
    pi.on("before_agent_start", () => {
      invalidatePendingSettlement();
    });
    pi.on("agent_start", async (event, ctx) => {
      invalidatePendingSettlement();
      await deps.onCompletionAgentStart(event, ctx);
    });
    pi.on("turn_start", slackToolPolicyRuntime.onTurnStart);
    pi.on("message_start", slackToolPolicyRuntime.onMessageStart);
    pi.on("turn_end", slackToolPolicyRuntime.onTurnEnd);
    pi.on("tool_call", slackToolPolicyRuntime.onToolCall);
    pi.on("agent_end", async (event, ctx) => {
      await slackToolPolicyRuntime.onAgentEnd();
      await deps.onCompletionAgentEnd(event, ctx);
    });
    pi.on("agent_settled", async (event, ctx) => {
      if (disposed) return;
      await slackToolPolicyRuntime.onAgentSettled();
      if (disposed) return;
      if (pendingSettlement) {
        clearImmediate(pendingSettlement);
        pendingSettlement = null;
      }
      if (deps.hasQueuedInbox()) {
        deps.drainInboxFromSettle();
        return;
      }
      const settledGeneration = lifecycleGeneration;
      // Unknown deferred prompts are not publicly observable in Pi 0.87. Keep
      // idle advisory and generation-fenced after the settled dispatch.
      pendingSettlement = setImmediate(() => {
        pendingSettlement = null;
        if (
          disposed ||
          lifecycleGeneration !== settledGeneration ||
          ctx.isIdle?.() === false ||
          ctx.hasPendingMessages?.() === true
        ) {
          return;
        }
        void deps.onCompletionAgentSettled(event, ctx);
      });
    });
  }

  function dispose(): void {
    disposed = true;
    invalidatePendingSettlement();
  }

  return {
    register,
    dispose,
  };
}
