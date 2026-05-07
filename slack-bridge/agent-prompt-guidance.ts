import {
  buildAgentPersonalityGuidelines,
  buildBrokerProtocolGuardrailsPrompt,
  buildPinetPrimerPromptGuidelines,
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

export interface BeforeAgentStartEvent {
  systemPrompt: string;
}

export interface AgentPromptGuidanceDeps {
  getIdentityGuidelines: () => string[];
  getAgentName: () => string;
  getAgentEmoji: () => string;
  getActiveSkinTheme: () => string | null;
  getAgentPersonality: () => string | null;
  getBrokerRole: () => "broker" | "follower" | null;
  getBrokerPromptSetting?: () => string | undefined;
  loadBrokerPrompt?: () => Promise<BrokerPromptLoadResult>;
  reportBrokerPromptWarning?: (warning: string) => void;
  reportBrokerPromptDiagnostic?: (diagnostic: string) => void;
}

export interface AgentPromptGuidance {
  beforeAgentStart: (event: BeforeAgentStartEvent) => Promise<{ systemPrompt: string }>;
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

    const brokerRole = deps.getBrokerRole();
    if (brokerRole) {
      guidelines.push(...buildPinetPrimerPromptGuidelines());
    }

    if (brokerRole === "broker") {
      const brokerPrompt = await (
        deps.loadBrokerPrompt ??
        (() =>
          loadBrokerPrompt({
            configuredPrompt: deps.getBrokerPromptSetting?.(),
          }))
      )();
      for (const warning of brokerPrompt.warnings) {
        (deps.reportBrokerPromptWarning ?? console.warn)(`[slack-bridge] ${warning.message}`);
      }
      (deps.reportBrokerPromptDiagnostic ?? console.info)(
        `[slack-bridge] ${brokerPrompt.diagnostic}`,
      );
      guidelines.push(
        renderBrokerPromptContent(brokerPrompt.content, {
          agentEmoji: deps.getAgentEmoji(),
          agentName,
        }),
      );
      guidelines.push(buildBrokerProtocolGuardrailsPrompt());
      guidelines.push(buildBrokerToolGuardrailsPrompt());
    } else if (brokerRole === "follower") {
      guidelines.push(...buildWorkerPromptGuidelines());
    }

    return guidelines;
  }

  async function beforeAgentStart(event: BeforeAgentStartEvent): Promise<{ systemPrompt: string }> {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + (await buildPromptGuidelines()).join("\n"),
    };
  }

  return {
    beforeAgentStart,
  };
}
