import {
  compact,
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import {
  compactionInputError,
  decideCompaction,
  modelKey,
  parseCompactionSelector,
  selectorForModel,
  thinkingLevelError,
  type ModelIdentity,
  type ThinkingLevel,
} from "./helpers.js";

interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}
interface CompatibleContext extends ExtensionContext {
  modelRegistry: {
    find(
      provider: string,
      modelId: string,
    ):
      | {
          provider: string;
          id: string;
          reasoning?: boolean;
          thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
          contextWindow: number;
          maxTokens: number;
        }
      | undefined;
    getAvailable(): Array<{
      provider: string;
      id: string;
      reasoning?: boolean;
      thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
      contextWindow: number;
      maxTokens: number;
    }>;
    getApiKeyAndHeaders(model: { provider: string; id: string }): Promise<{
      ok: boolean;
      apiKey?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      error?: string;
    }>;
  };
  model?: ModelIdentity;
  scopedModels?: ReadonlyArray<{
    model: {
      provider: string;
      id: string;
      name?: string;
      reasoning?: boolean;
      thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
    };
    thinkingLevel?: ThinkingLevel;
  }>;
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
const STATUS_ID = "model-aware-compaction";

export default function modelAwareCompaction(pi: ExtensionAPI) {
  const api = pi as CompatibleAPI;
  let inFlight = false;
  let summarizationInFlight = false;
  let triggeredModelKey: string | null = null;
  let runtimeSelector: string | undefined;

  const rearm = () => {
    triggeredModelKey = null;
  };

  pi.on("session_start", (_event, rawCtx) => {
    rearm();
    runtimeSelector = undefined;
    const ctx = rawCtx as CompatibleContext;
    const config = loadConfig(ctx.cwd);
    const selector = selectorForModel(config.rules, modelKey(ctx.model), config.compactionModel);
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, selector ? `compact: ${selector}` : undefined);
  });
  pi.on("model_select", (_event, rawCtx) => {
    rearm();
    const ctx = rawCtx as CompatibleContext;
    const config = loadConfig(ctx.cwd);
    const selector =
      runtimeSelector ??
      selectorForModel(config.rules, modelKey(ctx.model), config.compactionModel);
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, selector ? `compact: ${selector}` : undefined);
  });

  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, rawCtx) => {
    const ctx = rawCtx as CompatibleContext;
    const config = loadConfig(ctx.cwd);
    const selectorText =
      runtimeSelector ??
      selectorForModel(config.rules, modelKey(ctx.model), config.compactionModel);
    if (!selectorText) return;

    const failClosed = (message: string) => {
      if (config.debug) console.error(`${LOG_PREFIX} ${message}`);
      if (ctx.hasUI && !event.signal.aborted)
        ctx.ui.notify(`Compaction cancelled: ${message}`, "error");
      return { cancel: true as const };
    };

    if (event.signal.aborted) return { cancel: true };
    if (summarizationInFlight)
      return failClosed("another selected-model compaction is already in progress");

    const selector = parseCompactionSelector(selectorText);
    if (!selector) return failClosed(`invalid compactionModel selector "${selectorText}"`);
    const model = ctx.modelRegistry.find(selector.provider, selector.modelId);
    if (!model)
      return failClosed(
        `compaction model "${selector.provider}/${selector.modelId}" is unavailable`,
      );
    const thinkingError = thinkingLevelError(model, selector.thinkingLevel);
    if (thinkingError)
      return failClosed(`${selector.provider}/${selector.modelId}: ${thinkingError}`);

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (event.signal.aborted) return { cancel: true };
    if (!auth.ok)
      return failClosed(
        `credentials unavailable for ${selector.provider}/${selector.modelId}: ${auth.error}`,
      );

    const customInstructions =
      [event.customInstructions, config.customInstructions]
        .filter(
          (value, index, values): value is string =>
            Boolean(value) && values.indexOf(value) === index,
        )
        .join("\n\n") || undefined;
    const preparation = event.preparation;
    const history = serializeConversation(convertToLlm(preparation.messagesToSummarize));
    const turnPrefix = serializeConversation(convertToLlm(preparation.turnPrefixMessages));
    const outputReserve = Math.min(
      Math.floor(preparation.settings.reserveTokens * 0.8),
      model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
    );
    const budgetError = compactionInputError({
      serializedHistory: history,
      serializedTurnPrefix: turnPrefix,
      previousSummary: preparation.previousSummary,
      customInstructions,
      contextWindow: model.contextWindow,
      outputReserve,
    });
    if (budgetError) return failClosed(budgetError);

    summarizationInFlight = true;
    if (config.debug && ctx.hasUI) {
      ctx.ui.notify(`Compacting with ${selectorText}`, "info");
    }
    try {
      const result = await compact(
        preparation,
        model,
        auth.apiKey,
        auth.headers,
        customInstructions,
        event.signal,
        selector.thinkingLevel,
        undefined,
        auth.env,
      );
      if (event.signal.aborted) return { cancel: true };
      if (!result.summary.trim())
        return failClosed(`compaction model "${selectorText}" returned an empty summary`);
      return { compaction: result };
    } catch (error) {
      if (event.signal.aborted) return { cancel: true };
      const message = error instanceof Error ? error.message : String(error);
      return failClosed(`selected model "${selectorText}" failed: ${message}`);
    } finally {
      summarizationInFlight = false;
    }
  });

  // agent_end may still be followed by Pi's automatic compaction and retry.
  // Wait until the full operation settles so proactive compaction cannot race it.
  pi.on("agent_settled", (_event, rawCtx) => {
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

    if (ctx.sessionManager.getBranch().at(-1)?.type === "compaction") {
      triggeredModelKey = decision.modelKey;
      return;
    }

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
        if (error.message === "Already compacted") return;

        triggeredModelKey = null;
        console.error(`${LOG_PREFIX} failed ${details}: ${error.message}`);
        if (config.debug && ctx.hasUI)
          ctx.ui.notify(`Model-aware compaction failed: ${error.message}`, "error");
      },
    });
  });

  pi.registerCommand("model-aware-compaction-model", {
    description: "Choose a compaction model for this session",
    handler: async (_args, rawCtx) => {
      const ctx = rawCtx as CompatibleContext;
      if (!ctx.hasUI) return;
      const models =
        ctx.scopedModels && ctx.scopedModels.length > 0
          ? ctx.scopedModels
          : ctx.modelRegistry.getAvailable().map((model) => ({ model }));
      const labels = models.map((entry) => {
        const thinkingLevel = "thinkingLevel" in entry ? entry.thinkingLevel : undefined;
        return `${entry.model.provider}/${entry.model.id}${thinkingLevel ? `:${thinkingLevel}` : ""}`;
      });
      const choice = await ctx.ui.select("Compaction model (session only)", [
        "Use configured selector",
        ...labels,
      ]);
      if (!choice) return;
      runtimeSelector = choice === "Use configured selector" ? undefined : choice;
      const config = loadConfig(ctx.cwd);
      const selected =
        runtimeSelector ??
        selectorForModel(config.rules, modelKey(ctx.model), config.compactionModel);
      ctx.ui.setStatus(STATUS_ID, selected ? `compact: ${selected}` : undefined);
      ctx.ui.notify(
        selected ? `Compaction model: ${selected}` : "Using Pi's default compaction model",
        "info",
      );
    },
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
      const configuredSelector = selectorForModel(config.rules, key, config.compactionModel);
      const selector = runtimeSelector ?? configuredSelector;
      const parsed = selector ? parseCompactionSelector(selector) : null;
      const resolved = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
      const lines = [
        "**Model-aware compaction**",
        "",
        `- proactive enabled: ${config.enabled ? "yes" : "no"}`,
        `- current model: ${key ?? "unknown"}`,
        `- compaction model: ${selector ?? "Pi default"}${runtimeSelector ? " (session override)" : ""}`,
        `- compaction model status: ${!selector ? "not configured" : resolved ? "resolved" : "invalid or unavailable"}`,
        `- current tokens: ${usage?.tokens ?? "unknown"}`,
        `- matched limit: ${decision.limit ?? "none"}`,
        `- state: ${inFlight ? "compacting" : decision.reason}`,
        `- config: ${config.sourcePath ?? "defaults (disabled)"}`,
        "- rules:",
        ...config.rules.map(
          (rule) =>
            `  - ${rule.model}: ${rule.activeContextTokens}${rule.compactionModel ? ` -> ${rule.compactionModel}` : ""}`,
        ),
      ];
      api.sendMessage(
        { customType: "model-aware-compaction.status", content: lines.join("\n"), display: true },
        { triggerTurn: false },
      );
    },
  });
}
