import {
  buildHistoryPrompt,
  buildTurnPrefixPrompt,
  SUMMARIZATION_SYSTEM_PROMPT,
} from "./prompts.js";

export interface ModelIdentity {
  provider?: string;
  id?: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface CompactionRule {
  model: string;
  activeContextTokens: number;
  compactionModel?: string;
}

export interface CompactionSelector {
  provider: string;
  modelId: string;
  thinkingOverride?: ThinkingLevel;
}

export interface CompactionDecision {
  modelKey: string | null;
  limit: number | null;
  shouldCompact: boolean;
  reason:
    | "disabled"
    | "unknown-model"
    | "no-rule"
    | "usage-unavailable"
    | "below-limit"
    | "already-triggered"
    | "in-flight"
    | "over-limit";
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function modelKey(model: ModelIdentity | undefined): string | null {
  const provider = model?.provider?.trim().toLowerCase();
  const id = model?.id?.trim().toLowerCase();
  if (!provider || !id) return null;
  const normalizedId = id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id;
  return `${provider}/${normalizedId}`;
}

export function matchesModel(pattern: string, key: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) return false;
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(key);
}

export function ruleForModel(rules: CompactionRule[], key: string): CompactionRule | undefined {
  return rules.find((rule) => matchesModel(rule.model, key));
}

export function limitForModel(rules: CompactionRule[], key: string): number | null {
  return ruleForModel(rules, key)?.activeContextTokens ?? null;
}

export function selectorForModel(
  rules: CompactionRule[],
  key: string | null,
  globalSelector?: string,
): string | undefined {
  return (key ? ruleForModel(rules, key)?.compactionModel : undefined) ?? globalSelector;
}

export const USE_CONFIGURED_SELECTOR = "Use configured selector";

/**
 * Build the session picker entries from the same shortlist `/model` offers.
 *
 * `scopedModels` is Pi's resolved `--models` / `enabledModels` scope. When the
 * session is scoped we stay inside it, so the compaction picker can never widen
 * the model surface past what `/model` itself would show. An unscoped session
 * has no shortlist, so every authenticated model is offered, exactly like
 * `/model`.
 */
export function compactionModelChoices(input: {
  scopedModels: ReadonlyArray<{ model: ModelIdentity; thinkingLevel?: ThinkingLevel }>;
  availableModels: ReadonlyArray<ModelIdentity>;
  configuredSelector?: string;
  activeSelector?: string;
}): { label: string; selector: string | undefined }[] {
  const shortlist =
    input.scopedModels.length > 0
      ? input.scopedModels
      : input.availableModels.map((model) => ({ model, thinkingLevel: undefined }));

  const configuredLabel = input.configuredSelector
    ? `${USE_CONFIGURED_SELECTOR} (${input.configuredSelector})`
    : `${USE_CONFIGURED_SELECTOR} (Pi default)`;

  return [
    { label: configuredLabel, selector: undefined },
    ...shortlist.map((entry) => {
      const selector = `${entry.model.provider}/${entry.model.id}`;
      const notes = [
        entry.thinkingLevel ? `thinking: ${entry.thinkingLevel}` : undefined,
        selector === input.activeSelector ? "current" : undefined,
      ].filter((note) => note !== undefined);
      return { label: notes.length > 0 ? `${selector} (${notes.join(", ")})` : selector, selector };
    }),
  ];
}

/**
 * Resolve a `/model-aware-compaction-model <argument>` value against the same
 * shortlist. `default` restores the configured selector.
 */
export function resolveCompactionModelArgument(
  argument: string,
  choices: ReadonlyArray<{ selector: string | undefined }>,
  availableSelectors: ReadonlyArray<string> = [],
): { selector: string | undefined } | { error: string } {
  const trimmed = argument.trim();
  if (trimmed === "default" || trimmed === "reset") return { selector: undefined };

  const selectors = choices
    .map((choice) => choice.selector)
    .filter((selector) => selector !== undefined);
  if (selectors.includes(trimmed)) return { selector: trimmed };
  // An exact provider/model id outside the shortlist is legal, matching the
  // picker's Tab-to-all scope. Bare ids never widen past the shortlist.
  if (availableSelectors.includes(trimmed)) return { selector: trimmed };

  const matches = selectors.filter((selector) => selector.split("/")[1] === trimmed);
  if (matches.length === 1) return { selector: matches[0] };
  if (matches.length > 1)
    return { error: `"${trimmed}" matches ${matches.join(", ")}; use the full provider/model id` };
  return {
    error: `"${trimmed}" is not an authenticated provider/model id or a shortlist model; run /model-aware-compaction-model without an argument to pick one`,
  };
}

export function parseCompactionSelector(
  value: string,
  exactModelExists: (provider: string, modelId: string) => boolean = () => false,
): CompactionSelector | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;

  const provider = trimmed.slice(0, slash).trim();
  let modelId = trimmed.slice(slash + 1).trim();
  if (!provider || !modelId) return null;
  if (exactModelExists(provider, modelId)) return { provider, modelId };

  let thinkingOverride: ThinkingLevel | undefined;
  const colon = modelId.lastIndexOf(":");
  if (colon > 0) {
    const suffix = modelId.slice(colon + 1).toLowerCase() as ThinkingLevel;
    if (THINKING_LEVELS.has(suffix)) {
      thinkingOverride = suffix;
      modelId = modelId.slice(0, colon).trim();
    }
  }
  return modelId ? { provider, modelId, thinkingOverride } : null;
}

export function compactionInputError(input: {
  serializedHistory: string;
  serializedTurnPrefix: string;
  previousSummary?: string;
  customInstructions?: string;
  contextWindow: number;
  outputReserve: number;
  prefixOutputReserve?: number;
}): string | null {
  // Pi does not expose tokenizer accounting for standalone summary requests. Count the exact
  // 0.85.1 system/user prompts and retain conservative room for provider message serialization.
  const providerSerializationReserve = 512;
  const requestTokens = (promptText: string) =>
    Math.ceil((SUMMARIZATION_SYSTEM_PROMPT.length + promptText.length) / 4) +
    providerSerializationReserve;
  const requests: Array<{ inputTokens: number; outputReserve: number }> = [];
  const hasHistoryRequest =
    !input.serializedTurnPrefix || Boolean(input.serializedHistory || input.previousSummary);
  if (hasHistoryRequest) {
    requests.push({
      inputTokens: requestTokens(
        buildHistoryPrompt(
          input.serializedHistory,
          input.customInstructions,
          input.previousSummary,
        ),
      ),
      outputReserve: input.outputReserve,
    });
  }
  if (input.serializedTurnPrefix) {
    requests.push({
      inputTokens: requestTokens(buildTurnPrefixPrompt(input.serializedTurnPrefix)),
      outputReserve: input.prefixOutputReserve ?? input.outputReserve,
    });
  }
  const oversized = requests.find(
    (request) => request.inputTokens + request.outputReserve > input.contextWindow,
  );
  return oversized
    ? `summarization input (${oversized.inputTokens} estimated tokens) plus output reserve (${oversized.outputReserve}) exceeds selected model context window (${input.contextWindow})`
    : null;
}

export function decideCompaction(input: {
  enabled: boolean;
  model: ModelIdentity | undefined;
  tokens: number | null | undefined;
  rules: CompactionRule[];
  inFlight: boolean;
  triggeredModelKey: string | null;
}): CompactionDecision {
  const key = modelKey(input.model);
  if (!input.enabled)
    return { modelKey: key, limit: null, shouldCompact: false, reason: "disabled" };
  if (!key) return { modelKey: null, limit: null, shouldCompact: false, reason: "unknown-model" };
  const limit = limitForModel(input.rules, key);
  if (limit === null)
    return { modelKey: key, limit: null, shouldCompact: false, reason: "no-rule" };
  if (input.tokens === null || input.tokens === undefined || !Number.isFinite(input.tokens)) {
    return { modelKey: key, limit, shouldCompact: false, reason: "usage-unavailable" };
  }
  if (input.tokens <= limit)
    return { modelKey: key, limit, shouldCompact: false, reason: "below-limit" };
  if (input.inFlight) return { modelKey: key, limit, shouldCompact: false, reason: "in-flight" };
  if (input.triggeredModelKey === key)
    return { modelKey: key, limit, shouldCompact: false, reason: "already-triggered" };
  return { modelKey: key, limit, shouldCompact: true, reason: "over-limit" };
}
