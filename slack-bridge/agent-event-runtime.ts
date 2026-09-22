import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  drainQueuedInboxIfIdle: (ctx: ExtensionContext) => boolean;
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

  function register(pi: Pick<ExtensionAPI, "on">): void {
    pi.on("agent_start", deps.onCompletionAgentStart);
    pi.on("turn_start", slackToolPolicyRuntime.onTurnStart);
    pi.on("message_start", slackToolPolicyRuntime.onMessageStart);
    pi.on("turn_end", slackToolPolicyRuntime.onTurnEnd);
    pi.on("tool_call", slackToolPolicyRuntime.onToolCall);
    pi.on("agent_end", async (event, ctx) => {
      await slackToolPolicyRuntime.onAgentEnd();
      await deps.onCompletionAgentEnd(event, ctx);
    });
    pi.on("agent_settled", async (event, ctx) => {
      await slackToolPolicyRuntime.onAgentSettled();
      if (deps.hasQueuedInbox() && deps.drainQueuedInboxIfIdle(ctx)) return;
      await deps.onCompletionAgentSettled(event, ctx);
    });
  }

  return { register };
}
