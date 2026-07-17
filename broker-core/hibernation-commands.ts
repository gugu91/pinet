import { fingerprintToken, sanitizeOperatorReason } from "./hibernation-status.js";
import type { AgentLifecycleState } from "./types.js";

/**
 * Reduce an executor/adapter-produced reason to an operator-safe string.
 *
 * Executor results (e.g. an aborted checkpoint) may fold runtime-authored text
 * into their `reason`, which can carry a filesystem/socket path. Machine reason
 * codes pass through unchanged; anything path-like is redacted. Falls back to a
 * static code so the result always carries a non-empty reason.
 */
function safeResultReason(reason: string): string {
  return sanitizeOperatorReason(reason) ?? "unspecified";
}

/**
 * Broker-managed hibernate/wake operator commands.
 *
 * These are the safe, default-off command primitives behind `pinet hibernate`
 * and `pinet wake`. They add config-policy, repo-allowlist, and coarse
 * lifecycle gating on top of the authoritative checkpoint/fence/eligibility
 * enforcement in {@link HibernationOrchestrator}. Every result is sanitized:
 * machine `reason` + static human `detail` only, never prompts, message bodies,
 * argv, env values, or filesystem/socket paths.
 */

export interface HibernationCommandPolicy {
  /** Master switch. Defaults false; false still permits waking hibernated rows. */
  enabled: boolean;
  mode: "observe" | "manual" | "auto";
  /** Positive allowlist of repo identifiers (slug or basename). Empty = none. */
  allowedRepos: string[];
}

export interface HibernationCommandRefusal {
  reason: string;
  detail: string;
  retryable: boolean;
}

/** Coarse command gate outcome, before any orchestrator execution. */
export type HibernationCommandGate =
  | { outcome: "proceed" }
  | { outcome: "noop"; reason: string; detail: string }
  | { outcome: "refused"; refusal: HibernationCommandRefusal };

export interface HibernationCommandResult {
  command: "hibernate" | "wake";
  agentId: string;
  /** executed = state changed; noop = already in target state; refused = gated. */
  outcome: "executed" | "noop" | "refused";
  state: AgentLifecycleState | string;
  reason: string;
  detail: string;
  runtimeGeneration?: number | null;
  attempts?: number;
  durationMs?: number;
  retryable?: boolean;
}

function refusal(reason: string, detail: string, retryable: boolean): HibernationCommandGate {
  return { outcome: "refused", refusal: { reason, detail, retryable } };
}

export interface HibernateCommandGateInput {
  state: AgentLifecycleState;
  repoIdentifier: string | null;
  policy: HibernationCommandPolicy;
}

/**
 * Coarse policy/lifecycle gate for a hibernate command. Deep eligibility
 * (policy=never, working, pending inbox, broker-managed metadata) is enforced
 * authoritatively by the orchestrator's prepare/hibernate path.
 */
export function evaluateHibernateCommandGate(
  input: HibernateCommandGateInput,
): HibernationCommandGate {
  const { state, repoIdentifier, policy } = input;
  if (!policy.enabled) {
    return refusal(
      "hibernation_disabled",
      "Hibernation is disabled (enabled=false). Waking already-hibernated identities is still permitted.",
      false,
    );
  }
  if (policy.mode === "observe") {
    return refusal(
      "observe_only",
      "Hibernation is in observe-only mode; no state changes are performed.",
      false,
    );
  }

  switch (state) {
    case "hibernated":
    case "hibernating":
      return {
        outcome: "noop",
        reason: "already_hibernating",
        detail: "Agent is already hibernated or hibernating.",
      };
    case "waking":
      return refusal("wake_in_progress", "Agent is currently waking; retry once it settles.", true);
    case "reap-candidate":
      return refusal(
        "quarantined",
        "Agent is quarantined as a reap-candidate and needs manual review, not hibernation.",
        false,
      );
    case "terminated":
      return refusal("terminated", "Agent is terminated and cannot be hibernated.", false);
    default:
      break;
  }

  // Fail-closed allowlist with EXACT identity matching and NO basename collapse
  // (C2): an allowlist entry must equal the broker-derived repo identifier
  // exactly. A bare "pinet" entry therefore never admits a *different* root
  // that merely shares a basename (e.g. "gugu91/pinet" or "evil/pinet"),
  // and an "owner/repo" slug entry never admits a different owner. Blank
  // identifiers/entries never match. Windows backslash separators are normalized
  // to "/" on both sides so matching is OS-agnostic, and trailing slashes are
  // stripped so "owner/repo/" and "owner/repo" compare equal.
  const repo = (repoIdentifier ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const repoAllowlisted =
    repo.length > 0 &&
    policy.allowedRepos.some((raw) => {
      const entry = raw.trim().replace(/\\/g, "/").replace(/\/+$/, "");
      if (entry.length === 0) return false;
      return entry === repo;
    });
  if (!repoAllowlisted) {
    return refusal(
      "repo_not_allowlisted",
      "Agent's repository is not in the hibernation allowlist.",
      false,
    );
  }

  return { outcome: "proceed" };
}

export interface WakeCommandGateInput {
  state: AgentLifecycleState;
  policy: HibernationCommandPolicy;
}

/**
 * Coarse gate for a wake command. Waking a durable hibernation identity is a
 * drain/recovery operation and is permitted even when `enabled=false`, per the
 * safety model (disabling hibernation must never strand hibernated identities).
 */
export function evaluateWakeCommandGate(input: WakeCommandGateInput): HibernationCommandGate {
  switch (input.state) {
    case "hibernated":
      return { outcome: "proceed" };
    case "waking":
      // A wake is already in flight; there is nothing more for this command to
      // do. Surfacing this as a noop (rather than proceeding to an executor
      // that would refuse) keeps the operator signal accurate.
      return {
        outcome: "noop",
        reason: "wake_in_progress",
        detail: "Agent is already waking; the in-flight wake will deliver queued messages.",
      };
    case "live":
    case "active":
    case "grace":
    case "idle":
      return {
        outcome: "noop",
        reason: "already_awake",
        detail: "Agent already has a live runtime; nothing to wake.",
      };
    case "hibernating":
      return refusal(
        "hibernate_in_progress",
        "Agent is mid-hibernation; retry once it reaches a hibernated state.",
        true,
      );
    case "reap-candidate":
      return refusal(
        "quarantined",
        "Agent is quarantined as a reap-candidate and needs manual review, not a wake.",
        false,
      );
    case "terminated":
      return refusal("terminated", "Agent is terminated and cannot be woken.", false);
    default:
      return refusal("unknown_state", "Agent lifecycle state is not wakeable.", false);
  }
}

export interface HibernateCommandExecutor {
  prepareHibernation(
    agentId: string,
    opts?: { reason?: string; actor?: string; correlationId?: string },
  ): { ready: boolean; state: string; reason: string };
  hibernate(
    agentId: string,
    opts?: { reason?: string; actor?: string; correlationId?: string },
  ): Promise<{
    ok: boolean;
    state: string;
    reason: string;
    durationMs?: number;
  }>;
}

export interface WakeCommandExecutor {
  wake(
    agentId: string,
    opts?: { reason?: string; actor?: string; correlationId?: string },
  ): Promise<{
    ok: boolean;
    state: string;
    reason: string;
    runtimeGeneration?: number;
    attempts?: number;
    durationMs?: number;
  }>;
}

/** Build a sanitized "unknown target" refusal for a command whose target didn't resolve. */
export function unknownHibernationTarget(
  command: "hibernate" | "wake",
  target: string,
): HibernationCommandResult {
  // The target is arbitrary, unresolved operator input (it may be a paste, a
  // path, or carry secret material). Never echo it — not even redacted. Emit a
  // stable non-reversible fingerprint so an operator can still correlate repeated
  // failures of the *same* input without any content reaching an operator surface.
  const controlStripped = Array.from(target)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f ? " " : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const safeTarget =
    controlStripped.length > 0 ? `target:#${fingerprintToken(controlStripped)}` : "(unnamed)";
  return {
    command,
    agentId: safeTarget,
    outcome: "refused",
    state: "unknown",
    reason: "unknown_target",
    detail: "No broker-managed agent matched the requested target.",
    retryable: false,
  };
}

export interface ExecuteHibernateCommandInput extends HibernateCommandGateInput {
  executor: HibernateCommandExecutor;
  agentId: string;
  actor?: string;
  reason?: string;
  correlationId?: string;
}

export async function executeHibernateCommand(
  input: ExecuteHibernateCommandInput,
): Promise<HibernationCommandResult> {
  const gate = evaluateHibernateCommandGate(input);
  if (gate.outcome === "refused") {
    return {
      command: "hibernate",
      agentId: input.agentId,
      outcome: "refused",
      state: input.state,
      reason: gate.refusal.reason,
      detail: gate.refusal.detail,
      retryable: gate.refusal.retryable,
    };
  }
  if (gate.outcome === "noop") {
    return {
      command: "hibernate",
      agentId: input.agentId,
      outcome: "noop",
      state: input.state,
      reason: gate.reason,
      detail: gate.detail,
    };
  }

  const opts = { actor: input.actor, reason: input.reason, correlationId: input.correlationId };
  const prep = input.executor.prepareHibernation(input.agentId, opts);
  if (!prep.ready) {
    return {
      command: "hibernate",
      agentId: input.agentId,
      outcome: "refused",
      state: prep.state,
      reason: prep.reason,
      detail: "Agent is not eligible for hibernation right now.",
      retryable: prep.reason === "agent_working" || prep.reason === "pending_inbox",
    };
  }

  const result = await input.executor.hibernate(input.agentId, opts);
  return {
    command: "hibernate",
    agentId: input.agentId,
    outcome: result.ok ? "executed" : "refused",
    state: result.state,
    reason: safeResultReason(result.reason),
    detail: result.ok
      ? "Agent runtime checkpointed and hibernated."
      : result.state === "reap-candidate"
        ? "Hibernation could not complete cleanly; agent quarantined as reap-candidate for manual review."
        : "Hibernation aborted; the runtime was left running.",
    durationMs: result.durationMs,
    // Quarantine needs manual review, not a blind retry; an abort-to-active is
    // safe to retry once the transient condition clears.
    retryable: result.ok ? undefined : result.state !== "reap-candidate",
  };
}

export interface ExecuteWakeCommandInput extends WakeCommandGateInput {
  executor: WakeCommandExecutor;
  agentId: string;
  actor?: string;
  reason?: string;
  correlationId?: string;
}

export async function executeWakeCommand(
  input: ExecuteWakeCommandInput,
): Promise<HibernationCommandResult> {
  const gate = evaluateWakeCommandGate(input);
  if (gate.outcome === "refused") {
    return {
      command: "wake",
      agentId: input.agentId,
      outcome: "refused",
      state: input.state,
      reason: gate.refusal.reason,
      detail: gate.refusal.detail,
      retryable: gate.refusal.retryable,
    };
  }
  if (gate.outcome === "noop") {
    return {
      command: "wake",
      agentId: input.agentId,
      outcome: "noop",
      state: input.state,
      reason: gate.reason,
      detail: gate.detail,
    };
  }

  const result = await input.executor.wake(input.agentId, {
    actor: input.actor,
    reason: input.reason,
    correlationId: input.correlationId,
  });
  if (!result.ok && result.reason === "wake_in_progress") {
    // Another lease owner is already waking this agent. That is the single
    // winner and it will deliver queued work — this is a benign no-op, not a
    // retryable failure (mirrors an already-`waking` target at the gate).
    return {
      command: "wake",
      agentId: input.agentId,
      outcome: "noop",
      state: result.state,
      reason: result.reason,
      detail:
        "A wake is already in progress for this agent; the in-flight wake will deliver queued work.",
    };
  }
  if (!result.ok && result.reason === "wake_lease_contended") {
    // A non-wake lifecycle lease (e.g. a lingering hibernate around a crash) is
    // transiently holding the agent. Unlike an in-flight wake, nothing will
    // drain the inbox, so this is a distinct *retryable* refusal — the queued
    // trigger is preserved (requeued) rather than consumed as a no-op.
    return {
      command: "wake",
      agentId: input.agentId,
      outcome: "refused",
      state: result.state,
      reason: result.reason,
      detail:
        "A non-wake lifecycle operation is transiently holding this agent; no wake is in flight. The trigger was requeued — retry shortly.",
      retryable: true,
    };
  }
  // Classify the failure by REASON, not just state. Some non-quarantined
  // failures are terminal: a bare retry cannot change the outcome because the
  // target is not a wakeable hibernated identity, or its durable launch manifest
  // is gone. Marking those retryable would send an operator into a futile retry
  // loop instead of the corrective action (investigate / re-spawn the worker).
  const quarantined = result.state === "reap-candidate";
  const notHibernated = result.reason.startsWith("not_hibernated");
  const terminalReason =
    quarantined ||
    notHibernated ||
    result.reason === "unknown_agent" ||
    result.reason === "missing_runtime_spec";
  const failDetail = quarantined
    ? "Wake failed and the agent was quarantined as reap-candidate for manual review."
    : result.reason === "missing_runtime_spec"
      ? "Wake failed: no durable runtime manifest exists for this identity, so it cannot be relaunched. Re-spawn the worker instead of retrying."
      : result.reason === "unknown_agent"
        ? "No such agent is known to the broker; there is nothing to wake."
        : notHibernated
          ? `Agent is not in a wakeable hibernated state (${result.state}); nothing to wake.`
          : "Wake failed; agent left in a safe state — a retry may succeed.";
  return {
    command: "wake",
    agentId: input.agentId,
    outcome: result.ok ? "executed" : "refused",
    state: result.state,
    reason: safeResultReason(result.reason),
    detail: result.ok ? "Agent runtime woken; queued messages will drain in order." : failDetail,
    runtimeGeneration: result.ok ? (result.runtimeGeneration ?? null) : null,
    attempts: result.attempts,
    durationMs: result.durationMs,
    // Quarantine and terminal-reason failures need operator action, not a retry;
    // only genuinely transient safe-state failures are retryable.
    retryable: result.ok ? undefined : !terminalReason,
  };
}

/** Render a sanitized, compact operator line for a command result. */
export function formatHibernationCommandResult(result: HibernationCommandResult): string {
  const marker =
    result.outcome === "executed" ? "\u2713" : result.outcome === "noop" ? "\u2014" : "\u2717";
  const parts = [
    `${marker} ${result.command} ${result.agentId}: ${result.outcome} (${result.reason})`,
  ];
  parts.push(`  ${result.detail}`);
  parts.push(`  state=${result.state}`);
  if (result.runtimeGeneration != null)
    parts.push(`  runtime_generation=${result.runtimeGeneration}`);
  if (result.attempts != null) parts.push(`  attempts=${result.attempts}`);
  return parts.join("\n");
}
