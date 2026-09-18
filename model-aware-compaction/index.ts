import {
  convertToLlm,
  ModelSelectorComponent,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRuntime,
  type RegistryModel,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai/compat";
import { loadConfig } from "./config.js";
import {
  chainForModel,
  compactionInputError,
  compactionModelChoices,
  decideCompaction,
  describeThinking,
  effectiveThinkingLevel,
  modelKey,
  parseCompactionSelector,
  resolveCompactionModelArgument,
  type ModelIdentity,
} from "./helpers.js";
import {
  mergePriorModelAwareFiles,
  runSelectedModelCompaction,
  thinkingComplete,
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
    getError(): string | undefined;
    refresh: ModelRuntime["refresh"];
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

type AttemptOutcome =
  | { kind: "compaction"; result: Awaited<ReturnType<typeof runSelectedModelCompaction>> }
  /** Fixable only by editing configuration; never advances the chain. */
  | { kind: "invalid"; reason: string }
  /** This entry cannot serve the request; the next entry may. */
  | { kind: "failed"; reason: string }
  | { kind: "cancelled" };

/**
 * Run one chain entry. Cancellation is never a reason to advance, and a selector
 * that does not parse is a configuration error, so a typo cannot shift traffic to
 * the next entry. Everything else — unavailable model, missing credentials, a
 * context window too small for the history, provider/limit errors, capped or
 * empty output — hands over to the next entry.
 */
// agent-standards-ignore prefer-inline-single-use-helper: one entry's outcome is a
// distinct seam from the chain policy that consumes it; inlining would bury the
// advance/never-advance rules inside an 80-line loop body.
async function attemptSelectedCompaction(input: {
  ctx: CompatibleContext;
  selectorText: string;
  preparation: ReturnType<typeof mergePriorModelAwareFiles>;
  history: string;
  turnPrefix: string;
  customInstructions?: string;
  signal: AbortSignal;
  debug: boolean;
}): Promise<AttemptOutcome> {
  const { ctx, selectorText, preparation, signal } = input;
  const selector = parseCompactionSelector(selectorText, (provider, modelId) =>
    Boolean(ctx.modelRegistry.find(provider, modelId)),
  );
  if (!selector)
    return { kind: "invalid", reason: `invalid compactionModel selector "${selectorText}"` };
  const model = ctx.modelRegistry.find(selector.provider, selector.modelId);
  if (!model)
    return {
      kind: "failed",
      reason: `compaction model "${selector.provider}/${selector.modelId}" is unavailable`,
    };

  const cap = model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
  const budgetError = compactionInputError({
    serializedHistory: input.history,
    serializedTurnPrefix: input.turnPrefix,
    previousSummary: preparation.previousSummary,
    customInstructions: input.customInstructions,
    contextWindow: model.contextWindow,
    outputReserve: Math.min(Math.floor(preparation.settings.reserveTokens * 0.8), cap),
    prefixOutputReserve: Math.min(Math.floor(preparation.settings.reserveTokens * 0.5), cap),
  });
  if (budgetError) return { kind: "failed", reason: budgetError };

  try {
    // A selector level rides Pi's simple-stream path; otherwise the registry keeps
    // provider-default thinking and existing configurations are unchanged.
    let complete: RegistryComplete = ctx.modelRegistry.complete.bind(ctx.modelRegistry);
    const level = effectiveThinkingLevel(model, selector.thinkingOverride);
    if (level) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return { kind: "failed", reason: `credentials unavailable: ${auth.error}` };
      complete = thinkingComplete(auth, level);
    }
    if (signal.aborted) return { kind: "cancelled" };
    if (input.debug && ctx.hasUI) ctx.ui.notify(`Compacting with ${selectorText}`, "info");
    const result = await runSelectedModelCompaction({
      preparation,
      model,
      complete,
      signal,
      customInstructions: input.customInstructions,
      selector: selectorText,
    });
    if (signal.aborted) return { kind: "cancelled" };
    return { kind: "compaction", result };
  } catch (error) {
    if (signal.aborted) return { kind: "cancelled" };
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

export default function modelAwareCompaction(pi: ExtensionAPI) {
  const api = pi as CompatibleAPI;
  let inFlight = false;
  let summarizationInFlight = false;
  let triggeredModelKey: string | null = null;
  let runtimeSelector: string | undefined;
  let sessionDisabled = false;

  const rearm = () => {
    triggeredModelKey = null;
  };

  pi.on("session_start", () => {
    rearm();
    runtimeSelector = undefined;
    sessionDisabled = false;
  });
  pi.on("model_select", () => {
    rearm();
  });

  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, rawCtx) => {
    const ctx = rawCtx as CompatibleContext;
    if (sessionDisabled) return;
    const config = loadConfig(ctx.cwd);
    // A session override is exactly one model; otherwise the configured chain is tried in order.
    const chain = runtimeSelector
      ? [runtimeSelector]
      : chainForModel(config.rules, modelKey(ctx.model), config.compactionModels);
    if (chain.length === 0) return;

    const failClosed = (message: string) => {
      console.error(`${LOG_PREFIX} ${message}`);
      if (ctx.hasUI && !event.signal.aborted)
        ctx.ui.notify(`Compaction cancelled: ${message}`, "error");
      return { cancel: true as const };
    };

    if (event.signal.aborted) return { cancel: true };
    if (summarizationInFlight)
      return failClosed("another selected-model compaction is already in progress");

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

      const failures: string[] = [];
      for (const selectorText of chain) {
        if (event.signal.aborted) return { cancel: true };
        const attempt = await attemptSelectedCompaction({
          ctx,
          selectorText,
          preparation,
          history,
          turnPrefix,
          customInstructions,
          signal: event.signal,
          debug: config.debug,
        });
        if (attempt.kind === "cancelled") return { cancel: true };
        if (attempt.kind === "invalid") return failClosed(attempt.reason);
        if (attempt.kind === "compaction") {
          if (failures.length > 0) {
            const report = `fell back to ${selectorText} after ${failures.join("; ")}`;
            console.error(`${LOG_PREFIX} ${report}`);
            if (config.debug && ctx.hasUI) ctx.ui.notify(`Compaction ${report}`, "info");
          }
          return { compaction: attempt.result };
        }
        failures.push(`${selectorText}: ${attempt.reason}`);
      }
      return failClosed(
        chain.length === 1 ? failures[0] : `every compaction model failed (${failures.join("; ")})`,
      );
    } finally {
      summarizationInFlight = false;
    }
  });

  // agent_end may still be followed by Pi's automatic compaction and retry.
  // Wait until the full operation settles so proactive compaction cannot race it.
  pi.on("agent_settled", (_event, rawCtx) => {
    if (sessionDisabled) return;
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
      const configuredChain = chainForModel(
        config.rules,
        modelKey(ctx.model),
        config.compactionModels,
      );
      // The picker shows the chain as configured; a pick replaces the whole chain.
      const configuredSelector =
        configuredChain.length > 0 ? configuredChain.join(" -> ") : undefined;
      const choices = compactionModelChoices({
        scopedModels: ctx.scopedModels ?? [],
        availableModels: ctx.modelRegistry.getAvailable(),
        configuredSelector,
        activeSelector: runtimeSelector ?? configuredSelector,
      });

      const argument = typeof args === "string" ? args.trim() : "";
      if (argument) {
        const available = ctx.modelRegistry
          .getAvailable()
          .map((model) => `${model.provider}/${model.id}`);
        const resolved = resolveCompactionModelArgument(argument, choices, available);
        if ("error" in resolved) {
          if (ctx.hasUI) ctx.ui.notify(resolved.error, "error");
          else console.error(`${LOG_PREFIX} ${resolved.error}`);
          return;
        }
        runtimeSelector = resolved.selector;
      } else if (!ctx.hasUI) {
        return;
      } else if (ctx.mode !== "tui") {
        // ui.custom is terminal-only; RPC hosts resolve it to undefined.
        const choice = await ctx.ui.select(
          "Compaction model (session only)",
          choices.map((entry) => entry.label),
        );
        if (!choice) return;
        runtimeSelector = choices.find((entry) => entry.label === choice)?.selector;
      } else {
        // Host Pi's own /model picker (scoped shortlist, fuzzy search, Tab to
        // widen to all authenticated models). It reads the catalog through the
        // four registry methods below; a per-invocation adapter is fine because
        // refreshModelCatalogs drops its WeakMap entry when the refresh settles.
        // Esc keeps the current selection; `default` clears a session override.
        const registry = ctx.modelRegistry;
        const runtime: ModelRuntime = {
          getAvailableSnapshot: () => registry.getAvailable(),
          getModel: (provider, modelId) => registry.find(provider, modelId),
          getError: () => registry.getError(),
          refresh: (options) => registry.refresh(options),
        };
        const active = parseCompactionSelector(
          runtimeSelector ?? configuredChain[0] ?? "",
          (provider, modelId) => registry.find(provider, modelId) !== undefined,
        );
        const current = active ? registry.find(active.provider, active.modelId) : undefined;
        const picked = await ctx.ui.custom<RegistryModel | undefined>(
          (tui, _theme, _keybindings, done) =>
            new ModelSelectorComponent(
              tui,
              current,
              runtime,
              ctx.scopedModels ?? [],
              (model) => done(model),
              () => done(undefined),
            ),
        );
        if (!picked) return;
        runtimeSelector = `${picked.provider}/${picked.id}`;
      }

      const message = runtimeSelector
        ? `Compaction model: ${runtimeSelector} (session override, replaces the configured chain)`
        : configuredSelector
          ? `Compaction model chain: ${configuredSelector}`
          : "Using Pi's default compaction model";
      if (ctx.hasUI) ctx.ui.notify(message, "info");
      else console.error(`${LOG_PREFIX} ${message}`);
    },
  });

  // Session-only switch. Off means Pi behaves as if this extension were not loaded:
  // no proactive triggering and no compaction-model routing. Persistent off is
  // `enabled: false` plus no compactionModel in settings.
  for (const [name, disabled] of [
    ["model-aware-compaction-off", true],
    ["model-aware-compaction-on", false],
  ] as const) {
    pi.registerCommand(name, {
      description: disabled
        ? "Disable model-aware compaction for this session (proactive triggers and model routing)"
        : "Re-enable model-aware compaction for this session",
      handler: async (_args, rawCtx) => {
        const ctx = rawCtx as CompatibleContext;
        sessionDisabled = disabled;
        const message = disabled
          ? "Model-aware compaction disabled for this session; Pi's stock compaction applies"
          : "Model-aware compaction re-enabled for this session";
        if (ctx.hasUI) ctx.ui.notify(message, "info");
        else console.error(`${LOG_PREFIX} ${message}`);
      },
    });
  }

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
      const chain = runtimeSelector
        ? [runtimeSelector]
        : chainForModel(config.rules, key, config.compactionModels);
      const entries = await Promise.all(
        chain.map(async (selector) => {
          const parsed = parseCompactionSelector(selector, (provider, modelId) =>
            Boolean(ctx.modelRegistry.find(provider, modelId)),
          );
          const model = parsed
            ? ctx.modelRegistry.find(parsed.provider, parsed.modelId)
            : undefined;
          const auth = model ? await ctx.modelRegistry.getApiKeyAndHeaders(model) : null;
          const readiness = !parsed
            ? "invalid selector"
            : !model
              ? "unavailable"
              : !auth?.ok
                ? `credentials unavailable: ${auth?.error}`
                : usage?.tokens != null && usage.tokens >= model.contextWindow
                  ? `ready, but window ${model.contextWindow} is below current context`
                  : "ready";
          return `  - ${selector}: ${readiness}; thinking: ${describeThinking(model, parsed?.thinkingOverride)}`;
        }),
      );
      const lines = [
        "**Model-aware compaction**",
        "",
        `- session: ${sessionDisabled ? "disabled (/model-aware-compaction-on to re-enable)" : "active"}`,
        `- proactive enabled: ${config.enabled ? "yes" : "no"}`,
        `- current model: ${key ?? "unknown"}`,
        chain.length === 0
          ? "- compaction model: Pi default"
          : `- compaction model chain${runtimeSelector ? " (session override)" : ""}:`,
        ...entries,
        `- current tokens: ${usage?.tokens ?? "unknown"}`,
        `- matched limit: ${decision.limit ?? "none"}`,
        `- state: ${sessionDisabled ? "disabled" : inFlight ? "compacting" : decision.reason}`,
        `- config: ${config.sourcePath ?? "defaults (disabled)"}`,
        "- rules:",
        ...config.rules.map(
          (rule) =>
            `  - ${rule.model}: ${rule.activeContextTokens}${rule.compactionModels ? ` -> ${rule.compactionModels.join(" -> ")}` : ""}`,
        ),
      ];
      api.sendMessage(
        { customType: "model-aware-compaction.status", content: lines.join("\n"), display: true },
        { triggerTurn: false },
      );
    },
  });
}
