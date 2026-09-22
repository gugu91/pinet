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
  setDeliverTrackedSlackFollowUpMessage: (
    deliver: SlackToolPolicyRuntime["deliverTrackedSlackFollowUpMessage"],
  ) => void;
}

export interface AgentEventRuntime {
  register: (pi: Pick<ExtensionAPI, "on">) => void;
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

  function register(pi: Pick<ExtensionAPI, "on">): void {
    pi.on("input", slackToolPolicyRuntime.onInput);
    pi.on("agent_start", async (event, ctx) => {
      lifecycleGeneration += 1;
      if (pendingSettlement) {
        clearImmediate(pendingSettlement);
        pendingSettlement = null;
      }
      await deps.onCompletionAgentStart(event, ctx);
    });
    pi.on("turn_start", slackToolPolicyRuntime.onTurnStart);
    pi.on("turn_end", slackToolPolicyRuntime.onTurnEnd);
    pi.on("tool_call", slackToolPolicyRuntime.onToolCall);
    pi.on("agent_end", async (event, ctx) => {
      await slackToolPolicyRuntime.onAgentEnd();
      await deps.onCompletionAgentEnd(event, ctx);
    });
    pi.on("agent_settled", (event, ctx) => {
      if (pendingSettlement) {
        clearImmediate(pendingSettlement);
      }
      const settledGeneration = lifecycleGeneration;
      // Pi 0.87 starts actions queued by later settled handlers before the next
      // check phase. Their agent_start cancels this publication first.
      pendingSettlement = setImmediate(() => {
        pendingSettlement = null;
        if (lifecycleGeneration !== settledGeneration) return;
        void (async () => {
          await slackToolPolicyRuntime.onAgentSettled();
          if (lifecycleGeneration !== settledGeneration) return;
          await deps.onCompletionAgentSettled(event, ctx);
        })();
      });
    });
  }

  return {
    register,
  };
}
