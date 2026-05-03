export const SETTINGS_KEY = "compaction-worker";
export const CONFIG_ENV = "PI_COMPACTION_WORKER_SETTINGS";

const DEFAULT_SUMMARY_MODELS = ["google/gemini-2.5-flash"] as const;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_PREPARED_AGE_MS = 30 * 60_000;
const DEFAULT_BUILTIN_SKIP_MARGIN_PERCENT = 0;

export interface ModelLike {
  provider?: string;
  id?: string;
  contextWindow?: number;
}

export interface UsageLike {
  tokens: number;
  contextWindow?: number;
}

export interface ThresholdConfig {
  tokens?: number;
  percent?: number;
}

export interface RawCompactionWorkerRule {
  match?: string | string[];
  prepareAtTokens?: number;
  prepareAtPercent?: number;
  triggerAtTokens?: number;
  triggerAtPercent?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  summaryModels?: string[];
  summaryMaxTokens?: number;
  cooldownMs?: number;
  maxPreparedAgeMs?: number;
  builtinReserveTokens?: number;
  builtinSkipMarginPercent?: number;
}

export interface RawCompactionWorkerConfig extends RawCompactionWorkerRule {
  enabled?: boolean;
  quiet?: boolean;
  showStatus?: boolean;
  profiles?: Record<string, RawCompactionWorkerRule>;
}

export interface ResolvedBaseConfig {
  enabled: boolean;
  quiet: boolean;
  showStatus: boolean;
  defaultRule: ResolvedRule;
  rawDefault: RawCompactionWorkerRule;
  profiles: Record<string, ResolvedProfile>;
  sourcePath: string | null;
}

export interface ResolvedProfile {
  name: string;
  matches: string[];
  raw: RawCompactionWorkerRule;
}

export interface ResolvedRule {
  prepareAt?: ThresholdConfig;
  triggerAt?: ThresholdConfig;
  reserveTokens: number;
  keepRecentTokens: number;
  summaryModels: string[];
  summaryMaxTokens?: number;
  cooldownMs: number;
  maxPreparedAgeMs: number;
  builtinReserveTokens: number;
  builtinSkipMarginPercent: number;
}

export interface EffectivePolicy extends ResolvedRule {
  enabled: boolean;
  quiet: boolean;
  showStatus: boolean;
  modelKey: string;
  matchedProfile?: string;
  prepareAtTokens?: number;
  triggerAtTokens?: number;
  policyHash: string;
  sourcePath: string | null;
}

export type PreparedStatus = "pending" | "ready" | "failed" | "stale" | "used";

export interface PreparedCompactionRecord {
  schemaVersion: 1;
  status: PreparedStatus;
  jobId: string;
  sessionId?: string;
  sessionFile?: string;
  cwd: string;
  modelKey: string;
  matchedProfile?: string;
  policyHash: string;
  createdAt: string;
  completedAt?: string;
  firstKeptEntryId?: string;
  leafIdCovered?: string;
  previousCompactionId?: string;
  summary?: string;
  tokensBeforeAtPrepare?: number;
  summaryModel?: string;
  details?: unknown;
  failure?: string;
  invalidationReason?: string;
}

export interface SessionIdentity {
  sessionId?: string;
  sessionFile?: string;
  cwd: string;
}

export interface EntryLike {
  id?: string;
  type?: string;
}

export interface FileListDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface RuntimeDecisionInput {
  usage: UsageLike | undefined;
  policy: EffectivePolicy;
  prepared: PreparedCompactionRecord | undefined;
  inFlight: boolean;
  nowMs: number;
  lastCompactAtMs?: number;
}

export type RuntimeDecision =
  | { action: "none"; reason: string }
  | { action: "prepare"; reason: string }
  | { action: "compact"; reason: string; usePrepared: boolean };

export function modelKey(model: ModelLike | undefined): string {
  const provider = model?.provider?.trim();
  const id = model?.id?.trim();
  if (!provider || !id) return "unknown";
  return `${provider}/${id}`;
}

export function parseModelSelector(selector: string): { provider: string; id: string } | undefined {
  const trimmed = selector.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return {
    provider: trimmed.slice(0, slash),
    id: trimmed.slice(slash + 1),
  };
}

export function resolveBaseConfig(
  raw: RawCompactionWorkerConfig | null | undefined,
  sourcePath: string | null = null,
): ResolvedBaseConfig {
  return {
    enabled: raw?.enabled === true,
    quiet: raw?.quiet === true,
    showStatus: raw?.showStatus !== false,
    defaultRule: resolveRule(raw),
    rawDefault: raw ?? {},
    profiles: resolveProfiles(raw?.profiles),
    sourcePath,
  };
}

export function resolveEffectivePolicy(
  base: ResolvedBaseConfig,
  model: ModelLike | undefined,
  usage?: UsageLike,
): EffectivePolicy {
  const key = modelKey(model);
  const matched = findMatchingProfile(base.profiles, key);
  const merged = matched
    ? resolveRule(mergeRawRules(base.rawDefault, matched.raw))
    : base.defaultRule;
  const contextWindow = usage?.contextWindow ?? model?.contextWindow;
  const prepareAtTokens = resolveThreshold(merged.prepareAt, contextWindow);
  const explicitTrigger = resolveThreshold(merged.triggerAt, contextWindow);
  const triggerAtTokens =
    explicitTrigger ?? resolveReserveThreshold(contextWindow, merged.reserveTokens);
  const effective: EffectivePolicy = {
    ...merged,
    enabled: base.enabled,
    quiet: base.quiet,
    showStatus: base.showStatus,
    modelKey: key,
    matchedProfile: matched?.name,
    prepareAtTokens,
    triggerAtTokens,
    policyHash: hashPolicy({
      key,
      matchedProfile: matched?.name,
      rule: merged,
      prepareAtTokens,
      triggerAtTokens,
    }),
    sourcePath: base.sourcePath,
  };
  return effective;
}

export function decideRuntimeAction(input: RuntimeDecisionInput): RuntimeDecision {
  const { usage, policy, prepared, inFlight, nowMs, lastCompactAtMs } = input;
  if (!policy.enabled) return { action: "none", reason: "disabled" };
  if (!usage || !Number.isFinite(usage.tokens))
    return { action: "none", reason: "usage-unavailable" };
  if (inFlight) return { action: "none", reason: "in-flight" };
  if (lastCompactAtMs !== undefined && nowMs - lastCompactAtMs < policy.cooldownMs) {
    return { action: "none", reason: "cooldown" };
  }

  const currentTokens = usage.tokens;
  const ready = prepared?.status === "ready" && !!prepared.summary;
  if (policy.triggerAtTokens !== undefined && currentTokens >= policy.triggerAtTokens) {
    if (isNearBuiltinThreshold(usage, policy)) {
      return { action: "none", reason: "near-built-in-threshold" };
    }
    return {
      action: "compact",
      reason: ready ? "trigger-threshold-ready" : "trigger-threshold-live",
      usePrepared: ready,
    };
  }

  if (policy.prepareAtTokens !== undefined && currentTokens >= policy.prepareAtTokens) {
    if (
      !prepared ||
      prepared.status === "failed" ||
      prepared.status === "stale" ||
      prepared.status === "used"
    ) {
      return { action: "prepare", reason: "prepare-threshold" };
    }
    return { action: "none", reason: `prepared-${prepared.status}` };
  }

  return { action: "none", reason: "below-threshold" };
}

export function validatePreparedRecord(
  record: PreparedCompactionRecord | undefined,
  options: {
    identity: SessionIdentity;
    policy: EffectivePolicy;
    branchEntries: EntryLike[];
    nowMs: number;
  },
): { ok: true } | { ok: false; reason: string } {
  if (!record) return { ok: false, reason: "missing" };
  if (record.status !== "ready") return { ok: false, reason: `not-ready:${record.status}` };
  if (!record.summary?.trim()) return { ok: false, reason: "empty-summary" };
  if (!record.firstKeptEntryId) return { ok: false, reason: "missing-first-kept" };
  if (!record.leafIdCovered) return { ok: false, reason: "missing-covered-leaf" };
  if (record.cwd !== options.identity.cwd) return { ok: false, reason: "cwd-mismatch" };
  if (
    record.sessionId &&
    options.identity.sessionId &&
    record.sessionId !== options.identity.sessionId
  ) {
    return { ok: false, reason: "session-id-mismatch" };
  }
  if (
    record.sessionFile &&
    options.identity.sessionFile &&
    record.sessionFile !== options.identity.sessionFile
  ) {
    return { ok: false, reason: "session-file-mismatch" };
  }
  if (record.modelKey !== options.policy.modelKey) return { ok: false, reason: "model-mismatch" };
  if (record.policyHash !== options.policy.policyHash)
    return { ok: false, reason: "policy-mismatch" };
  const createdAtMs = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAtMs)) return { ok: false, reason: "invalid-created-at" };
  if (options.nowMs - createdAtMs > options.policy.maxPreparedAgeMs)
    return { ok: false, reason: "expired" };

  const firstKeptIndex = options.branchEntries.findIndex(
    (entry) => entry.id === record.firstKeptEntryId,
  );
  if (firstKeptIndex < 0) return { ok: false, reason: "first-kept-not-on-branch" };
  const coveredIndex = options.branchEntries.findIndex(
    (entry) => entry.id === record.leafIdCovered,
  );
  if (coveredIndex < 0) return { ok: false, reason: "covered-leaf-not-ancestor" };
  if (firstKeptIndex > coveredIndex) return { ok: false, reason: "invalid-coverage-order" };

  const latestCompaction = findLatestCompactionId(options.branchEntries);
  if ((latestCompaction ?? undefined) !== (record.previousCompactionId ?? undefined)) {
    return { ok: false, reason: "compaction-boundary-changed" };
  }

  return { ok: true };
}

export function findLatestCompactionId(entries: EntryLike[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "compaction" && entry.id) return entry.id;
  }
  return undefined;
}

export function extractFileListDetails(details: unknown): FileListDetails {
  const direct = extractFileListDetailsFromRecord(toRecord(details));
  if (direct.readFiles.length > 0 || direct.modifiedFiles.length > 0) return direct;
  const nested = toRecord(details)?.details;
  return extractFileListDetailsFromRecord(toRecord(nested));
}

function resolveProfiles(
  rawProfiles: Record<string, RawCompactionWorkerRule> | undefined,
): Record<string, ResolvedProfile> {
  const result: Record<string, ResolvedProfile> = {};
  if (!rawProfiles) return result;
  for (const [name, raw] of Object.entries(rawProfiles)) {
    const matches = normalizeMatches(raw.match);
    if (matches.length === 0) continue;
    result[name] = {
      name,
      matches,
      raw,
    };
  }
  return result;
}

function resolveRule(raw: RawCompactionWorkerRule | null | undefined): ResolvedRule {
  return {
    prepareAt: resolveThresholdConfig(raw?.prepareAtTokens, raw?.prepareAtPercent),
    triggerAt: resolveThresholdConfig(raw?.triggerAtTokens, raw?.triggerAtPercent),
    reserveTokens: normalizePositiveInt(raw?.reserveTokens, DEFAULT_RESERVE_TOKENS),
    keepRecentTokens: normalizePositiveInt(raw?.keepRecentTokens, DEFAULT_KEEP_RECENT_TOKENS),
    summaryModels: normalizeStringArray(raw?.summaryModels, [...DEFAULT_SUMMARY_MODELS]),
    summaryMaxTokens: normalizeOptionalPositiveInt(raw?.summaryMaxTokens),
    cooldownMs: normalizePositiveInt(raw?.cooldownMs, DEFAULT_COOLDOWN_MS),
    maxPreparedAgeMs: normalizePositiveInt(raw?.maxPreparedAgeMs, DEFAULT_MAX_PREPARED_AGE_MS),
    builtinReserveTokens: normalizePositiveInt(raw?.builtinReserveTokens, DEFAULT_RESERVE_TOKENS),
    builtinSkipMarginPercent: normalizeSkipPercent(
      raw?.builtinSkipMarginPercent,
      DEFAULT_BUILTIN_SKIP_MARGIN_PERCENT,
    ),
  };
}

function mergeRawRules(
  base: RawCompactionWorkerRule,
  override: RawCompactionWorkerRule,
): RawCompactionWorkerRule {
  return {
    ...base,
    ...override,
    match: override.match,
  };
}

function findMatchingProfile(
  profiles: Record<string, ResolvedProfile>,
  key: string,
): ResolvedProfile | undefined {
  const normalized = key.toLowerCase();
  let best: { profile: ResolvedProfile; rank: ProfileMatchRank } | undefined;

  Object.values(profiles).forEach((profile, profileIndex) => {
    profile.matches.forEach((pattern, patternIndex) => {
      if (!globMatch(pattern, normalized)) return;
      const rank = profileMatchRank(pattern, profileIndex, patternIndex);
      if (!best || compareProfileMatchRank(rank, best.rank) > 0) {
        best = { profile, rank };
      }
    });
  });

  return best?.profile;
}

interface ProfileMatchRank {
  exact: boolean;
  literalLength: number;
  wildcardCount: number;
  profileIndex: number;
  patternIndex: number;
}

function profileMatchRank(
  pattern: string,
  profileIndex: number,
  patternIndex: number,
): ProfileMatchRank {
  const wildcardCount = [...pattern].filter((char) => char === "*" || char === "?").length;
  return {
    exact: wildcardCount === 0,
    literalLength: pattern.replaceAll("*", "").replaceAll("?", "").length,
    wildcardCount,
    profileIndex,
    patternIndex,
  };
}

function compareProfileMatchRank(left: ProfileMatchRank, right: ProfileMatchRank): number {
  if (left.exact !== right.exact) return left.exact ? 1 : -1;
  if (left.literalLength !== right.literalLength) return left.literalLength - right.literalLength;
  if (left.wildcardCount !== right.wildcardCount) return right.wildcardCount - left.wildcardCount;
  if (left.profileIndex !== right.profileIndex) return right.profileIndex - left.profileIndex;
  return right.patternIndex - left.patternIndex;
}

function normalizeMatches(match: string | string[] | undefined): string[] {
  const values = Array.isArray(match) ? match : match ? [match] : [];
  return values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0);
}

function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function resolveThresholdConfig(
  tokens: number | undefined,
  percent: number | undefined,
): ThresholdConfig | undefined {
  const normalizedTokens = normalizeOptionalPositiveInt(tokens);
  if (normalizedTokens !== undefined) return { tokens: normalizedTokens };
  const normalizedPercent = normalizeOptionalPercent(percent);
  if (normalizedPercent !== undefined) return { percent: normalizedPercent };
  return undefined;
}

function resolveThreshold(
  threshold: ThresholdConfig | undefined,
  contextWindow: number | undefined,
): number | undefined {
  if (!threshold) return undefined;
  if (threshold.tokens !== undefined) return threshold.tokens;
  if (threshold.percent === undefined) return undefined;
  const window = normalizeOptionalPositiveInt(contextWindow);
  if (window === undefined) return undefined;
  return Math.floor((window * threshold.percent) / 100);
}

function resolveReserveThreshold(
  contextWindow: number | undefined,
  reserveTokens: number,
): number | undefined {
  const window = normalizeOptionalPositiveInt(contextWindow);
  if (window === undefined) return undefined;
  return Math.max(0, window - reserveTokens);
}

function isNearBuiltinThreshold(usage: UsageLike, policy: EffectivePolicy): boolean {
  const contextWindow = normalizeOptionalPositiveInt(usage.contextWindow);
  if (contextWindow === undefined) return false;
  const builtinThreshold = Math.max(0, contextWindow - policy.builtinReserveTokens);
  const marginTokens = Math.floor((contextWindow * policy.builtinSkipMarginPercent) / 100);
  return usage.tokens >= builtinThreshold - marginTokens;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  const normalized = normalizeOptionalPositiveInt(value);
  return normalized ?? fallback;
}

function normalizeOptionalPositiveInt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function normalizeOptionalPercent(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 100)
    return undefined;
  return value;
}

function normalizeSkipPercent(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 100)
    return fallback;
  return value;
}

function normalizeStringArray(value: string[] | undefined, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const normalized = value.map((item) => item.trim()).filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : fallback;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractFileListDetailsFromRecord(
  record: Record<string, unknown> | undefined,
): FileListDetails {
  return {
    readFiles: normalizeStringList(record?.readFiles),
    modifiedFiles: normalizeStringList(record?.modifiedFiles),
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}

function hashPolicy(value: unknown): string {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
