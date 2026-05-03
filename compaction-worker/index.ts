import {
  compact as generateCompaction,
  type CompactionResult,
  type CompactionSettings,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config.js";
import {
  decideRuntimeAction,
  extractFileListDetails,
  findLatestCompactionId,
  parseModelSelector,
  resolveEffectivePolicy,
  validatePreparedRecord,
  type EffectivePolicy,
  type ModelLike,
  type PreparedCompactionRecord,
  type SessionIdentity,
  type UsageLike,
} from "./helpers.js";
import { buildPreparationFromBranch } from "./retention.js";

const STATUS_ID = "compaction-worker";
const CUSTOM_INSTRUCTIONS =
  "Create a precise coding-session compaction summary. Preserve exact file paths, commands, failing tests, decisions, blockers, and next steps. Do not continue the conversation.";

interface AuthResult {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  error?: string;
}

type SummaryModel = unknown;

interface CompatibleModelRegistry {
  find(provider: string, id: string): SummaryModel | undefined;
  getApiKeyAndHeaders(model: SummaryModel): Promise<AuthResult>;
}

interface CompatibleSessionManager {
  getEntries(): SessionEntry[];
  getBranch(): SessionEntry[];
  getLeafId(): string | undefined;
  getSessionId?: () => string | undefined;
  getSessionFile(): string | undefined;
}

interface CompatibleContext extends ExtensionContext {
  model?: ModelLike;
  modelRegistry: CompatibleModelRegistry;
  sessionManager: CompatibleSessionManager;
  getContextUsage(): UsageLike | undefined;
  compact(options?: {
    customInstructions?: string;
    onComplete?: (result: CompactionResult) => void;
    onError?: (error: Error) => void;
  }): void;
}

interface WorkerRuntime {
  prepared?: PreparedCompactionRecord;
  inFlight?: "prepare" | "compact" | "session_before_compact";
  lastCompactAtMs?: number;
  activeAbort?: AbortController;
  lastStatus?: string;
}

interface ResolvedSummaryModel {
  selector: string;
  model: SummaryModel;
  apiKey?: string;
  headers?: Record<string, string>;
}

function asContext(ctx: ExtensionContext): CompatibleContext {
  return ctx as CompatibleContext;
}

function sessionIdentity(ctx: CompatibleContext): SessionIdentity {
  return {
    sessionId: ctx.sessionManager.getSessionId?.(),
    sessionFile: ctx.sessionManager.getSessionFile?.(),
    cwd: ctx.cwd,
  };
}

function compactionSettings(policy: EffectivePolicy): CompactionSettings {
  return {
    enabled: true,
    reserveTokens: policy.reserveTokens,
    keepRecentTokens: policy.keepRecentTokens,
  };
}

function notify(
  ctx: CompatibleContext,
  policy: EffectivePolicy,
  message: string,
  level: string = "info",
): void {
  if (policy.quiet || !ctx.hasUI) return;
  ctx.ui.notify(message, level);
}

function statusLine(policy: EffectivePolicy, runtime: WorkerRuntime): string {
  if (!policy.enabled) return "compaction-worker: off";
  const bits = [
    `compaction-worker: ${runtime.inFlight ?? runtime.prepared?.status ?? "idle"}`,
    policy.matchedProfile ? `profile=${policy.matchedProfile}` : undefined,
    `model=${policy.modelKey}`,
    policy.prepareAtTokens ? `prepare=${policy.prepareAtTokens.toLocaleString()}t` : undefined,
    policy.triggerAtTokens ? `trigger=${policy.triggerAtTokens.toLocaleString()}t` : undefined,
  ].filter((bit): bit is string => bit !== undefined);
  return bits.join(" ");
}

function updateStatus(
  ctx: CompatibleContext,
  policy: EffectivePolicy,
  runtime: WorkerRuntime,
): void {
  if (!ctx.hasUI || !policy.showStatus) return;
  const next = statusLine(policy, runtime);
  if (next === runtime.lastStatus) return;
  runtime.lastStatus = next;
  ctx.ui.setStatus(STATUS_ID, next);
}

async function resolveSummaryModel(
  ctx: CompatibleContext,
  policy: EffectivePolicy,
): Promise<ResolvedSummaryModel | undefined> {
  const failures: string[] = [];
  for (const selector of policy.summaryModels) {
    const parsed = parseModelSelector(selector);
    if (!parsed) {
      failures.push(`${selector}: expected provider/model`);
      continue;
    }
    const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
    if (!model) {
      failures.push(`${selector}: model not found`);
      continue;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      failures.push(`${selector}: ${auth.error ?? "auth failed"}`);
      continue;
    }
    return { selector, model, apiKey: auth.apiKey, headers: auth.headers };
  }
  notify(
    ctx,
    policy,
    `Compaction worker could not resolve a summary model (${failures.join("; ")}). Falling back to Pi default compaction.`,
    "warning",
  );
  return undefined;
}

function isExternalCustomInstructions(customInstructions: string | undefined): boolean {
  const trimmed = customInstructions?.trim();
  return !!trimmed && trimmed !== CUSTOM_INSTRUCTIONS;
}

function buildCustomInstructions(customInstructions: string | undefined): string {
  const trimmed = customInstructions?.trim();
  if (!trimmed || trimmed === CUSTOM_INSTRUCTIONS) return CUSTOM_INSTRUCTIONS;
  return `${CUSTOM_INSTRUCTIONS}\n\nAdditional compaction instructions from the caller:\n${trimmed}`;
}

async function runCompactionSummary(
  preparation: SessionBeforeCompactEvent["preparation"],
  ctx: CompatibleContext,
  policy: EffectivePolicy,
  signal: AbortSignal,
  customInstructions?: string,
): Promise<{ result: CompactionResult; summaryModel: string } | undefined> {
  const resolved = await resolveSummaryModel(ctx, policy);
  if (!resolved) return undefined;
  const result = await generateCompaction(
    preparation,
    resolved.model,
    resolved.apiKey ?? "",
    resolved.headers,
    buildCustomInstructions(customInstructions),
    signal,
  );
  if (!result.summary.trim()) throw new Error("summary model returned an empty compaction summary");
  return { result, summaryModel: resolved.selector };
}

function prepareWithPolicy(
  branchEntries: SessionEntry[],
  fallback: SessionBeforeCompactEvent["preparation"] | undefined,
  policy: EffectivePolicy,
): SessionBeforeCompactEvent["preparation"] | undefined {
  return (
    buildPreparationFromBranch(branchEntries, compactionSettings(policy), fallback?.tokensBefore) ??
    fallback
  );
}

function startPrepareJob(
  ctx: CompatibleContext,
  policy: EffectivePolicy,
  runtime: WorkerRuntime,
): void {
  const branchEntries = ctx.sessionManager.getBranch();
  const identity = sessionIdentity(ctx);
  const fallbackLeafId = branchEntries[branchEntries.length - 1]?.id;
  const leafId =
    ctx.sessionManager.getLeafId() ??
    (typeof fallbackLeafId === "string" ? fallbackLeafId : undefined);
  const previousCompactionId = findLatestCompactionId(branchEntries);
  const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const abort = new AbortController();
  runtime.activeAbort?.abort();
  runtime.activeAbort = abort;
  runtime.inFlight = "prepare";
  runtime.prepared = {
    schemaVersion: 1,
    status: "pending",
    jobId,
    ...identity,
    modelKey: policy.modelKey,
    matchedProfile: policy.matchedProfile,
    policyHash: policy.policyHash,
    createdAt: new Date().toISOString(),
    leafIdCovered: leafId,
    previousCompactionId,
  };
  updateStatus(ctx, policy, runtime);

  void (async () => {
    try {
      const preparation = prepareWithPolicy(branchEntries, undefined, policy);
      if (!preparation) throw new Error("session branch is not ready for compaction");
      const generated = await runCompactionSummary(preparation, ctx, policy, abort.signal);
      if (!generated) throw new Error("no summary model was available");
      if (runtime.prepared?.jobId !== jobId) return;
      runtime.prepared = {
        ...runtime.prepared,
        status: "ready",
        completedAt: new Date().toISOString(),
        firstKeptEntryId: generated.result.firstKeptEntryId,
        summary: generated.result.summary,
        tokensBeforeAtPrepare: generated.result.tokensBefore,
        summaryModel: generated.summaryModel,
        details: generated.result.details,
      };
      notify(ctx, policy, "Compaction worker prepared a summary for the next threshold.");
    } catch (error) {
      if (abort.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      if (runtime.prepared?.jobId === jobId) {
        runtime.prepared = {
          ...runtime.prepared,
          status: "failed",
          completedAt: new Date().toISOString(),
          failure: message,
        };
      }
      notify(ctx, policy, `Compaction worker prepare failed: ${message}`, "warning");
    } finally {
      if (runtime.prepared?.jobId === jobId) {
        runtime.inFlight = undefined;
        updateStatus(ctx, policy, runtime);
      }
    }
  })();
}

function triggerCompaction(
  ctx: CompatibleContext,
  policy: EffectivePolicy,
  runtime: WorkerRuntime,
  reason: string,
): void {
  runtime.inFlight = "compact";
  updateStatus(ctx, policy, runtime);
  notify(ctx, policy, `Compaction worker triggering compaction (${reason}).`);
  ctx.compact({
    customInstructions: CUSTOM_INSTRUCTIONS,
    onComplete: () => {
      runtime.inFlight = undefined;
      runtime.lastCompactAtMs = Date.now();
      runtime.prepared = undefined;
      updateStatus(ctx, policy, runtime);
    },
    onError: (error) => {
      runtime.inFlight = undefined;
      notify(ctx, policy, `Compaction worker trigger failed: ${error.message}`, "error");
      updateStatus(ctx, policy, runtime);
    },
  });
}

function buildDetails(
  policy: EffectivePolicy,
  mode: "prepared" | "live",
  summaryModel: string | undefined,
  details: unknown,
): Record<string, unknown> {
  const fileLists = extractFileListDetails(details);
  return {
    kind: "compaction-worker",
    mode,
    modelKey: policy.modelKey,
    matchedProfile: policy.matchedProfile,
    policyHash: policy.policyHash,
    prepareAtTokens: policy.prepareAtTokens,
    triggerAtTokens: policy.triggerAtTokens,
    keepRecentTokens: policy.keepRecentTokens,
    reserveTokens: policy.reserveTokens,
    summaryModel,
    generatedAt: new Date().toISOString(),
    readFiles: fileLists.readFiles,
    modifiedFiles: fileLists.modifiedFiles,
    details,
  };
}

export default function compactionWorkerExtension(pi: ExtensionAPI) {
  const runtime: WorkerRuntime = {};

  function loadPolicy(ctx: CompatibleContext): EffectivePolicy {
    return resolveEffectivePolicy(loadConfig({ cwd: ctx.cwd }), ctx.model, ctx.getContextUsage());
  }

  pi.registerCommand("compaction-worker-status", {
    description: "Show compaction worker policy and prepared-summary status",
    handler: async (_args, rawCtx) => {
      const ctx = asContext(rawCtx);
      const policy = loadPolicy(ctx);
      const lines = [
        "Compaction worker",
        `enabled: ${policy.enabled ? "yes" : "no"}`,
        `source: ${policy.sourcePath ?? "defaults"}`,
        `model: ${policy.modelKey}`,
        `profile: ${policy.matchedProfile ?? "default"}`,
        `prepareAt: ${policy.prepareAtTokens?.toLocaleString() ?? "not configured"}`,
        `triggerAt: ${policy.triggerAtTokens?.toLocaleString() ?? "not available"}`,
        `keepRecentTokens: ${policy.keepRecentTokens.toLocaleString()}`,
        `summaryModels: ${policy.summaryModels.join(", ")}`,
        `state: ${runtime.inFlight ?? runtime.prepared?.status ?? "idle"}`,
        runtime.prepared?.firstKeptEntryId
          ? `prepared.firstKeptEntryId: ${runtime.prepared.firstKeptEntryId}`
          : undefined,
        runtime.prepared?.failure ? `prepared.failure: ${runtime.prepared.failure}` : undefined,
      ].filter((line): line is string => line !== undefined);
      ctx.ui.notify(lines.join("\n"));
    },
  });

  pi.on("agent_end", async (_event, rawCtx) => {
    const ctx = asContext(rawCtx);
    const policy = loadPolicy(ctx);
    updateStatus(ctx, policy, runtime);

    const decision = decideRuntimeAction({
      usage: ctx.getContextUsage(),
      policy,
      prepared: runtime.prepared,
      inFlight: runtime.inFlight !== undefined,
      nowMs: Date.now(),
      lastCompactAtMs: runtime.lastCompactAtMs,
    });

    if (decision.action === "prepare") {
      startPrepareJob(ctx, policy, runtime);
      return;
    }
    if (decision.action === "compact") {
      triggerCompaction(ctx, policy, runtime, decision.reason);
    }
  });

  pi.on("session_before_compact", async (event, rawCtx) => {
    const ctx = asContext(rawCtx);
    const policy = loadPolicy(ctx);
    if (!policy.enabled) return undefined;

    runtime.inFlight = "session_before_compact";
    updateStatus(ctx, policy, runtime);

    const validation = validatePreparedRecord(runtime.prepared, {
      identity: sessionIdentity(ctx),
      policy,
      branchEntries: event.branchEntries,
      nowMs: Date.now(),
    });

    const hasExternalInstructions = isExternalCustomInstructions(event.customInstructions);

    if (
      !hasExternalInstructions &&
      validation.ok &&
      runtime.prepared?.summary &&
      runtime.prepared.firstKeptEntryId
    ) {
      const prepared = runtime.prepared;
      prepared.status = "used";
      return {
        compaction: {
          summary: prepared.summary,
          firstKeptEntryId: prepared.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: buildDetails(policy, "prepared", prepared.summaryModel, prepared.details),
        },
      };
    }

    if (hasExternalInstructions && runtime.prepared?.status === "ready") {
      notify(
        ctx,
        policy,
        "Prepared compaction summary bypassed because this compaction supplied custom instructions; generating a live summary.",
        "info",
      );
    } else if (!validation.ok && runtime.prepared?.status === "ready") {
      runtime.prepared.status = "stale";
      runtime.prepared.invalidationReason = validation.reason;
      notify(
        ctx,
        policy,
        `Prepared compaction summary is stale (${validation.reason}); generating a live summary.`,
        "warning",
      );
    }

    try {
      const preparation = prepareWithPolicy(event.branchEntries, event.preparation, policy);
      if (!preparation) return undefined;
      const generated = await runCompactionSummary(
        preparation,
        ctx,
        policy,
        event.signal,
        event.customInstructions,
      );
      if (!generated) return undefined;
      return {
        compaction: {
          summary: generated.result.summary,
          firstKeptEntryId: generated.result.firstKeptEntryId,
          tokensBefore: generated.result.tokensBefore,
          details: buildDetails(policy, "live", generated.summaryModel, generated.result.details),
        },
      };
    } catch (error) {
      if (!event.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        notify(
          ctx,
          policy,
          `Compaction worker live summary failed: ${message}. Falling back to Pi default compaction.`,
          "error",
        );
      }
      return undefined;
    }
  });

  pi.on("session_compact", async (_event, rawCtx) => {
    const ctx = asContext(rawCtx);
    const policy = loadPolicy(ctx);
    runtime.inFlight = undefined;
    runtime.lastCompactAtMs = Date.now();
    runtime.prepared = undefined;
    updateStatus(ctx, policy, runtime);
  });

  pi.on("session_start", async (_event, rawCtx) => {
    const ctx = asContext(rawCtx);
    runtime.activeAbort?.abort();
    runtime.activeAbort = undefined;
    runtime.inFlight = undefined;
    runtime.prepared = undefined;
    updateStatus(ctx, loadPolicy(ctx), runtime);
  });

  pi.on("session_tree", async (_event, rawCtx) => {
    const ctx = asContext(rawCtx);
    runtime.activeAbort?.abort();
    runtime.activeAbort = undefined;
    runtime.inFlight = undefined;
    runtime.prepared = undefined;
    updateStatus(ctx, loadPolicy(ctx), runtime);
  });

  pi.on("session_shutdown", async (_event, rawCtx) => {
    const ctx = asContext(rawCtx);
    runtime.activeAbort?.abort();
    runtime.activeAbort = undefined;
    runtime.inFlight = undefined;
    runtime.prepared = undefined;
    ctx.ui.setStatus(STATUS_ID, undefined);
  });
}
