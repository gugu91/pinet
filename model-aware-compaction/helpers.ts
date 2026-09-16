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
