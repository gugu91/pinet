import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { decideCompaction, modelKey, type ModelIdentity } from "./helpers.js";

interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}
interface CompatibleContext extends ExtensionContext {
  model?: ModelIdentity;
  getContextUsage?: () => ContextUsage | undefined;
  compact?: (options?: {
    customInstructions?: string;
    onComplete?: () => void;
    onError?: (error: Error) => void;
  }) => void;
}
interface CompatibleAPI extends ExtensionAPI {
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean },
  ): void;
}

const LOG_PREFIX = "[model-aware-compaction]";

export default function modelAwareCompaction(pi: ExtensionAPI) {
  const api = pi as CompatibleAPI;
  let inFlight = false;
  let triggeredModelKey: string | null = null;

  const rearm = () => {
    triggeredModelKey = null;
  };

  pi.on("session_start", rearm);
  pi.on("model_select", rearm);

  // ctx.compact() aborts an active agent operation. Wait for the complete
  // model/tool loop to settle so compaction cannot discard pending tool work.
  pi.on("agent_end", (_event, rawCtx) => {
    const ctx = rawCtx as CompatibleContext;
    const config = loadConfig(ctx.cwd);
    const usage = ctx.getContextUsage?.();
    const decision = decideCompaction({
      enabled: config.enabled,
      model: ctx.model,
      tokens: usage?.tokens,
      rules: config.rules,
      inFlight,
      triggeredModelKey,
    });

    if (decision.reason === "below-limit" && triggeredModelKey === decision.modelKey) {
      triggeredModelKey = null;
    }
    if (!decision.shouldCompact || !ctx.compact || !decision.modelKey || decision.limit === null)
      return;

    inFlight = true;
    triggeredModelKey = decision.modelKey;
    const details = `model=${decision.modelKey} tokens=${usage?.tokens ?? "unknown"} limit=${decision.limit}`;
    if (config.debug) {
      console.error(`${LOG_PREFIX} triggered ${details}`);
      if (ctx.hasUI) ctx.ui.notify(`Model-aware compaction started (${details})`, "info");
    }

    ctx.compact({
      customInstructions: config.customInstructions,
      onComplete: () => {
        inFlight = false;
        if (config.debug) {
          console.error(`${LOG_PREFIX} completed ${details}`);
          if (ctx.hasUI) ctx.ui.notify(`Model-aware compaction completed (${details})`, "info");
        }
      },
      onError: (error) => {
        inFlight = false;
        triggeredModelKey = null;
        console.error(`${LOG_PREFIX} failed ${details}: ${error.message}`);
        if (config.debug && ctx.hasUI)
          ctx.ui.notify(`Model-aware compaction failed: ${error.message}`, "error");
      },
    });
  });

  pi.registerCommand("model-aware-compaction-status", {
    description: "Show model-aware proactive compaction status",
    handler: async (_args, rawCtx) => {
      const ctx = rawCtx as CompatibleContext;
      const config = loadConfig(ctx.cwd);
      const key = modelKey(ctx.model);
      const usage = ctx.getContextUsage?.();
      const decision = decideCompaction({
        enabled: config.enabled,
        model: ctx.model,
        tokens: usage?.tokens,
        rules: config.rules,
        inFlight,
        triggeredModelKey,
      });
      const lines = [
        "**Model-aware compaction**",
        "",
        `- enabled: ${config.enabled ? "yes" : "no"}`,
        `- current model: ${key ?? "unknown"}`,
        `- current tokens: ${usage?.tokens ?? "unknown"}`,
        `- matched limit: ${decision.limit ?? "none"}`,
        `- state: ${inFlight ? "compacting" : decision.reason}`,
        `- config: ${config.sourcePath ?? "defaults (disabled)"}`,
        "- rules:",
        ...config.rules.map((rule) => `  - ${rule.model}: ${rule.activeContextTokens}`),
      ];
      api.sendMessage(
        { customType: "model-aware-compaction.status", content: lines.join("\n"), display: true },
        { triggerTurn: false },
      );
    },
  });
}
