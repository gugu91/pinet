export interface ModelIdentity {
  provider?: string;
  id?: string;
}

export interface CompactionRule {
  model: string;
  activeContextTokens: number;
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

export function limitForModel(rules: CompactionRule[], key: string): number | null {
  return rules.find((rule) => matchesModel(rule.model, key))?.activeContextTokens ?? null;
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
