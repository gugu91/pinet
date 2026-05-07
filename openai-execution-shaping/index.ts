import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import {
  buildAutoContinueMessage,
  buildExecutionShapingPrompt,
  classifyContinuationNeed,
  isTargetModel,
  type AssistantMessageLike,
} from "./helpers.js";

const STATUS_CUSTOM_TYPE = "openai-execution-shaping.status";
const CONTINUE_CUSTOM_TYPE = "openai-execution-shaping.continue";

interface ModelLike {
  provider?: string;
  id?: string;
}

interface AgentMessageLike extends AssistantMessageLike {
  role?: string;
}

interface AgentEndEventLike {
  messages: AgentMessageLike[];
}

interface CompatibleExtensionContext extends ExtensionContext {
  model?: ModelLike;
  hasPendingMessages?: () => boolean;
  hasUI?: boolean;
}

interface CompatibleExtensionAPI extends ExtensionAPI {
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: Record<string, unknown>;
    },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

function countToolResults(event: AgentEndEventLike): number {
  return event.messages.filter((message) => message.role === "toolResult").length;
}

function findLastAssistantMessage(event: AgentEndEventLike): AssistantMessageLike | undefined {
  return [...event.messages].reverse().find((message) => message.role === "assistant");
}

export default function openAIExecutionShapingExtension(pi: ExtensionAPI) {
  const extensionApi = pi as CompatibleExtensionAPI;
  let continuationCount = 0;

  function loadRuntimeConfig(cwd: string) {
    return loadConfig({ cwd });
  }

  pi.registerCommand("openai-execution-shaping-status", {
    description: "Show experimental OpenAI execution-shaping status",
    handler: async (_args, ctx) => {
      const extensionCtx = ctx as CompatibleExtensionContext;
      const config = loadRuntimeConfig(ctx.cwd);
      const targeted = isTargetModel(extensionCtx.model, config);
      const modelLabel = extensionCtx.model
        ? `${extensionCtx.model.provider}/${extensionCtx.model.id}`
        : "none";
      const source = config.sourcePath ?? "defaults (disabled)";
      const lines = [
        "**OpenAI execution shaping (experimental)**",
        "",
        `- enabled: ${config.enabled ? "yes" : "no"}`,
        `- current model: ${modelLabel}`,
        `- targeted now: ${targeted ? "yes" : "no"}`,
        `- providers: ${config.providers.join(", ")}`,
        `- modelRegex: \`${config.modelRegexSource}\``,
        `- prompt overlay: ${config.promptOverlayEnabled ? "on" : "off"}`,
        `- auto-continue: ${config.autoContinueEnabled ? `on (max ${config.maxAutoContinueTurns})` : "off"}`,
        `- source: ${source}`,
        `- current continuation count: ${continuationCount}`,
      ];

      extensionApi.sendMessage(
        {
          customType: STATUS_CUSTOM_TYPE,
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.on("session_start", async () => {
    continuationCount = 0;
  });

  pi.on("input", async (event) => {
    if (event.source !== "extension") {
      continuationCount = 0;
    }
    return { action: "continue" } as const;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const extensionCtx = ctx as CompatibleExtensionContext;
    const config = loadRuntimeConfig(ctx.cwd);
    if (!config.promptOverlayEnabled || !isTargetModel(extensionCtx.model, config)) {
      return undefined;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildExecutionShapingPrompt()}`,
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    const extensionCtx = ctx as CompatibleExtensionContext;
    const config = loadRuntimeConfig(ctx.cwd);
    if (
      !config.enabled ||
      !config.autoContinueEnabled ||
      !isTargetModel(extensionCtx.model, config)
    ) {
      return;
    }

    if (extensionCtx.hasPendingMessages?.()) {
      return;
    }

    const agentEndEvent = event as AgentEndEventLike;
    const decision = classifyContinuationNeed({
      message: findLastAssistantMessage(agentEndEvent),
      toolResultCount: countToolResults(agentEndEvent),
      usedAutoContinueTurns: continuationCount,
      maxAutoContinueTurns: config.maxAutoContinueTurns,
    });

    if (!decision.shouldContinue) {
      return;
    }

    continuationCount += 1;

    if (config.debug && extensionCtx.hasUI) {
      extensionCtx.ui.notify(
        `OpenAI execution shaping follow-up ${continuationCount}/${config.maxAutoContinueTurns}: ${decision.reason}`,
        "info",
      );
    }

    extensionApi.sendMessage(
      {
        customType: CONTINUE_CUSTOM_TYPE,
        content: buildAutoContinueMessage(),
        display: false,
        details: {
          reason: decision.reason,
          attempt: continuationCount,
        },
      },
      { triggerTurn: true },
    );
  });
}
