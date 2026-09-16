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
  thinkingLevel: ThinkingLevel;
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

export function parseCompactionSelector(value: string): CompactionSelector | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;

  const provider = trimmed.slice(0, slash).trim();
  let modelId = trimmed.slice(slash + 1).trim();
  let thinkingLevel: ThinkingLevel = "off";
  const colon = modelId.lastIndexOf(":");
  if (colon > 0) {
    const suffix = modelId.slice(colon + 1).toLowerCase() as ThinkingLevel;
    if (THINKING_LEVELS.has(suffix)) {
      thinkingLevel = suffix;
      modelId = modelId.slice(0, colon).trim();
    }
  }
  return provider && modelId ? { provider, modelId, thinkingLevel } : null;
}

export function thinkingLevelError(
  model: { reasoning?: boolean; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> },
  level: ThinkingLevel,
): string | null {
  if (level === "off")
    return model.thinkingLevelMap?.off === null ? 'thinking level "off" is unsupported' : null;
  if (!model.reasoning) return `thinking level "${level}" requires a reasoning model`;
  if (model.thinkingLevelMap?.[level] === null) return `thinking level "${level}" is unsupported`;
  if ((level === "xhigh" || level === "max") && model.thinkingLevelMap?.[level] === undefined) {
    return `thinking level "${level}" is unsupported`;
  }
  return null;
}

export function compactionInputError(input: {
  serializedHistory: string;
  serializedTurnPrefix: string;
  previousSummary?: string;
  customInstructions?: string;
  contextWindow: number;
  outputReserve: number;
}): string | null {
  // Includes conservative room for Pi's system prompt, structured summary prompt,
  // conversation tags, and provider serialization around each request.
  const fixedPromptReserve = 2_048;
  const sharedChars =
    (input.previousSummary?.length ?? 0) + (input.customInstructions?.length ?? 0);
  const requestTokens = (serialized: string, includeShared: boolean) =>
    serialized
      ? Math.ceil((serialized.length + (includeShared ? sharedChars : 0)) / 4) + fixedPromptReserve
      : 0;
  const historyTokens = requestTokens(input.serializedHistory, true);
  const prefixTokens = requestTokens(input.serializedTurnPrefix, false);
  const largestInput = Math.max(historyTokens, prefixTokens);
  return largestInput + input.outputReserve > input.contextWindow
    ? `summarization input (${largestInput} estimated tokens) plus output reserve (${input.outputReserve}) exceeds selected model context window (${input.contextWindow})`
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
