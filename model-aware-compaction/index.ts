import {
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai/compat";
import { loadConfig } from "./config.js";
import {
  compactionInputError,
  compactionModelChoices,
  decideCompaction,
  modelKey,
  parseCompactionSelector,
  resolveCompactionModelArgument,
  selectorForModel,
  type ModelIdentity,
  type ThinkingLevel,
} from "./helpers.js";
import {
  mergePriorModelAwareFiles,
  runSelectedModelCompaction,
  type RegistryComplete,
} from "./selected-compaction.js";

interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}
interface CompatibleContext extends ExtensionContext {
  modelRegistry: {
    find(provider: string, modelId: string): Model<Api> | undefined;
    getAvailable(): Model<Api>[];
    getApiKeyAndHeaders(model: Model<Api>): Promise<
      | {
          ok: true;
          apiKey?: string;
          headers?: ProviderHeaders;
          baseUrl?: string;
          env?: Record<string, string>;
        }
      | { ok: false; error: string }
    >;
    complete: RegistryComplete;
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

export default function modelAwareCompaction(pi: ExtensionAPI) {
  const api = pi as CompatibleAPI;
  let inFlight = false;
  let summarizationInFlight = false;
  let triggeredModelKey: string | null = null;
  let runtimeSelector: string | undefined;

  const rearm = () => {
    triggeredModelKey = null;
  };

  pi.on("session_start", () => {
    rearm();
    runtimeSelector = undefined;
  });
  pi.on("model_select", () => {
    rearm();
  });

  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, rawCtx) => {
    const ctx = rawCtx as CompatibleContext;
    const config = loadConfig(ctx.cwd);
    const selectorText =
      runtimeSelector ??
      selectorForModel(config.rules, modelKey(ctx.model), config.compactionModel);
    if (!selectorText) return;

    const failClosed = (message: string) => {
      console.error(`${LOG_PREFIX} ${message}`);
      if (ctx.hasUI && !event.signal.aborted)
        ctx.ui.notify(`Compaction cancelled: ${message}`, "error");
      return { cancel: true as const };
    };

    if (event.signal.aborted) return { cancel: true };
    if (summarizationInFlight)
      return failClosed("another selected-model compaction is already in progress");

    const selector = parseCompactionSelector(selectorText, (provider, modelId) =>
      Boolean(ctx.modelRegistry.find(provider, modelId)),
    );
    if (!selector) return failClosed(`invalid compactionModel selector "${selectorText}"`);
    const model = ctx.modelRegistry.find(selector.provider, selector.modelId);
    if (!model)
      return failClosed(
        `compaction model "${selector.provider}/${selector.modelId}" is unavailable`,
      );
    if (selector.thinkingOverride)
      return failClosed(
        `thinking override ":${selector.thinkingOverride}" is unsupported; configure provider/model only and the provider default will be used`,
      );

    // Acquire ownership before the registry begins asynchronous provider/auth work.
    summarizationInFlight = true;
    try {
      const customInstructions =
        [event.customInstructions, config.customInstructions]
          .filter(
            (value, index, values): value is string =>
              Boolean(value) && values.indexOf(value) === index,
          )
          .join("\n\n") || undefined;
      const preparation = mergePriorModelAwareFiles(event.preparation, event.branchEntries);
      const history = serializeConversation(convertToLlm(preparation.messagesToSummarize));
      const turnPrefix = serializeConversation(convertToLlm(preparation.turnPrefixMessages));
      const outputReserve = Math.min(
        Math.floor(preparation.settings.reserveTokens * 0.8),
        model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
      );
      const prefixOutputReserve = Math.min(
        Math.floor(preparation.settings.reserveTokens * 0.5),
        model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
      );
      const budgetError = compactionInputError({
        serializedHistory: history,
        serializedTurnPrefix: turnPrefix,
        previousSummary: preparation.previousSummary,
        customInstructions,
        contextWindow: model.contextWindow,
        outputReserve,
        prefixOutputReserve,
      });
      if (budgetError) return failClosed(budgetError);

      if (config.debug && ctx.hasUI) {
        ctx.ui.notify(`Compacting with ${selectorText}`, "info");
      }
      const result = await runSelectedModelCompaction({
        preparation,
        model,
        complete: ctx.modelRegistry.complete.bind(ctx.modelRegistry),
        signal: event.signal,
        customInstructions,
      });
      if (event.signal.aborted) return { cancel: true };
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
    description: "Choose a compaction model for this session (optional provider/model argument)",
    handler: async (args, rawCtx) => {
      const ctx = rawCtx as CompatibleContext;
      const config = loadConfig(ctx.cwd);
      const configuredSelector = selectorForModel(
        config.rules,
        modelKey(ctx.model),
        config.compactionModel,
      );
      const choices = compactionModelChoices({
        scopedModels: ctx.scopedModels ?? [],
        availableModels: ctx.modelRegistry.getAvailable(),
        configuredSelector,
        activeSelector: runtimeSelector ?? configuredSelector,
      });

      const argument = typeof args === "string" ? args.trim() : "";
      if (argument) {
        const resolved = resolveCompactionModelArgument(argument, choices);
        if ("error" in resolved) {
          if (ctx.hasUI) ctx.ui.notify(resolved.error, "error");
          else console.error(`${LOG_PREFIX} ${resolved.error}`);
          return;
        }
        runtimeSelector = resolved.selector;
      } else {
        if (!ctx.hasUI) return;
        const choice = await ctx.ui.select(
          "Compaction model (session only)",
          choices.map((entry) => entry.label),
        );
        if (!choice) return;
        runtimeSelector = choices.find((entry) => entry.label === choice)?.selector;
      }

      const selected = runtimeSelector ?? configuredSelector;
      const message = selected
        ? `Compaction model: ${selected}`
        : "Using Pi's default compaction model";
      if (ctx.hasUI) ctx.ui.notify(message, "info");
      else console.error(`${LOG_PREFIX} ${message}`);
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
      const parsed = selector
        ? parseCompactionSelector(selector, (provider, modelId) =>
            Boolean(ctx.modelRegistry.find(provider, modelId)),
          )
        : null;
      const resolved = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
      const selectorError = parsed?.thinkingOverride
        ? `thinking override ":${parsed.thinkingOverride}" is unsupported`
        : null;
      const auth =
        resolved && !selectorError ? await ctx.modelRegistry.getApiKeyAndHeaders(resolved) : null;
      const readiness = !selector
        ? "not configured"
        : !parsed || !resolved
          ? "invalid or unavailable"
          : selectorError
            ? selectorError
            : auth?.ok
              ? "ready"
              : `credentials unavailable: ${auth?.error}`;
      const lines = [
        "**Model-aware compaction**",
        "",
        `- proactive enabled: ${config.enabled ? "yes" : "no"}`,
        `- current model: ${key ?? "unknown"}`,
        `- compaction model: ${selector ?? "Pi default"}${runtimeSelector ? " (session override)" : ""}`,
        `- thinking: provider default (overrides unsupported)`,
        `- compaction model status: ${readiness}`,
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
