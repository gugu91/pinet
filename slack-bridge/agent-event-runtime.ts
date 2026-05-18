import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentCompletionRuntime } from "./agent-completion-runtime.js";
import type { AgentPromptGuidance } from "./agent-prompt-guidance.js";
import {
  createSlackToolPolicyRuntime,
  type SlackToolPolicyRuntime,
  type SlackToolPolicyRuntimeDeps,
} from "./slack-tool-policy-runtime.js";

export interface AgentEventRuntimeDeps extends SlackToolPolicyRuntimeDeps {
  beforeAgentStart: AgentPromptGuidance["beforeAgentStart"];
  onCompletionAgentEnd: AgentCompletionRuntime["onAgentEnd"];
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
    pi.on("input", slackToolPolicyRuntime.onInput);
    pi.on("turn_start", slackToolPolicyRuntime.onTurnStart);
    pi.on("turn_end", slackToolPolicyRuntime.onTurnEnd);
    pi.on("agent_end", slackToolPolicyRuntime.onAgentEnd);
    pi.on("tool_call", slackToolPolicyRuntime.onToolCall);
    pi.on("before_agent_start", deps.beforeAgentStart);
    pi.on("agent_end", deps.onCompletionAgentEnd);
  }

  return {
    register,
  };
}
