import {
  buildAgentPersonalityGuidelines,
  buildBrokerProtocolGuardrailsPrompt,
  buildPinetSkinPromptGuideline,
  buildWorkerPromptGuidelines,
} from "./helpers.js";
import { buildBrokerToolGuardrailsPrompt } from "./guardrails.js";
import {
  loadBrokerPrompt,
  renderBrokerPromptContent,
  type BrokerPromptLoadResult,
} from "./broker-prompt-loader.js";
import { buildReactionPromptGuidelines } from "./reaction-triggers.js";
import { reportDiagnostic } from "@pinet/transport-core/diagnostics";

export interface AgentPromptGuidanceDeps {
  getIdentityGuidelines: () => string[];
  getAgentName: () => string;
  getAgentEmoji: () => string;
  getActiveSkinTheme: () => string | null;
  getAgentPersonality: () => string | null;
  getBrokerRole: () => "broker" | "follower" | null;
  getBrokerPromptSetting?: () => string | undefined;
  loadBrokerPrompt?: () => Promise<BrokerPromptLoadResult>;
}

export interface AgentPromptGuidance {
  buildPromptGuidelines: () => Promise<string[]>;
}

export function createAgentPromptGuidance(deps: AgentPromptGuidanceDeps): AgentPromptGuidance {
  async function buildPromptGuidelines(): Promise<string[]> {
    const agentName = deps.getAgentName();
    const guidelines = [
      ...deps.getIdentityGuidelines(),
      ...buildAgentPersonalityGuidelines(agentName),
      ...buildReactionPromptGuidelines(),
    ];

    const skinGuideline = buildPinetSkinPromptGuideline(
      deps.getActiveSkinTheme(),
      deps.getAgentPersonality(),
    );
    if (skinGuideline) {
      guidelines.push(skinGuideline);
    }

    if (deps.getBrokerRole() === "broker") {
      const brokerPrompt = await (
        deps.loadBrokerPrompt ??
        (() =>
          loadBrokerPrompt({
            configuredPrompt: deps.getBrokerPromptSetting?.(),
          }))
      )();
      for (const warning of brokerPrompt.warnings) {
        reportDiagnostic("warning", `[slack-bridge] ${warning.message}`);
      }
      reportDiagnostic("info", `[slack-bridge] ${brokerPrompt.diagnostic}`);
      guidelines.push(
        renderBrokerPromptContent(brokerPrompt.content, {
          agentEmoji: deps.getAgentEmoji(),
          agentName,
        }),
      );
      guidelines.push(buildBrokerProtocolGuardrailsPrompt());
      guidelines.push(buildBrokerToolGuardrailsPrompt());
    } else if (deps.getBrokerRole() === "follower") {
      guidelines.push(...buildWorkerPromptGuidelines());
    }

    return guidelines;
  }

  return {
    buildPromptGuidelines,
  };
}
