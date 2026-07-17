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
  buildContextUpdate: () => Promise<string>;
}

const RUNTIME_GUIDANCE_UPDATE_PREFIX =
  "PINET RUNTIME GUIDANCE UPDATE: This is trusted extension context. Use the newest such update as the current identity and runtime workflow state.";

export function createAgentPromptGuidance(deps: AgentPromptGuidanceDeps): AgentPromptGuidance {
  const stableSystemGuidelines = [
    ...buildReactionPromptGuidelines(),
    buildBrokerProtocolGuardrailsPrompt(),
    buildBrokerToolGuardrailsPrompt(),
  ];

  async function buildMutableGuidelines(): Promise<string[]> {
    const agentName = deps.getAgentName();
    const role = deps.getBrokerRole();
    const guidelines = [
      `PINET RUNTIME STATE: ${role ?? "off"}.`,
      ...deps.getIdentityGuidelines(),
      ...buildAgentPersonalityGuidelines(agentName),
    ];

    const skinGuideline = buildPinetSkinPromptGuideline(
      deps.getActiveSkinTheme(),
      deps.getAgentPersonality(),
    );
    if (skinGuideline) {
      guidelines.push(skinGuideline);
    }

    if (role === "broker") {
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
    } else if (role === "follower") {
      guidelines.push(...buildWorkerPromptGuidelines());
    } else {
      guidelines.push(
        "This session is not currently a Pinet broker or follower. Do not apply earlier broker- or follower-specific workflow guidance unless a newer runtime guidance update activates that role.",
      );
    }

    return guidelines;
  }

  async function beforeAgentStart(event: BeforeAgentStartEvent): Promise<{ systemPrompt: string }> {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + stableSystemGuidelines.join("\n"),
    };
  }

  async function buildContextUpdate(): Promise<string> {
    return `${RUNTIME_GUIDANCE_UPDATE_PREFIX}\n\n${(await buildMutableGuidelines()).join("\n")}`;
  }

  return {
    beforeAgentStart,
    buildContextUpdate,
  };
}
