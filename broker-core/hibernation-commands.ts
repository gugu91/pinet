import type { AgentLifecycleState } from "./types.js";

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

  const wantedBasename = repoIdentifier
    ? (repoIdentifier.split("/").filter(Boolean).pop() ?? repoIdentifier)
    : null;
  const repoAllowlisted =
    repoIdentifier != null &&
    wantedBasename != null &&
    policy.allowedRepos.some(
      (entry) =>
        entry === repoIdentifier ||
        (entry.split("/").filter(Boolean).pop() ?? entry) === wantedBasename,
    );
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
    case "waking":
      return { outcome: "proceed" };
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
  return {
    command,
    agentId: target,
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
    reason: result.reason,
    detail: result.ok
      ? "Agent runtime checkpointed and hibernated."
      : "Hibernation aborted; the runtime was left running.",
    durationMs: result.durationMs,
    retryable: result.ok ? undefined : true,
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
  return {
    command: "wake",
    agentId: input.agentId,
    outcome: result.ok ? "executed" : "refused",
    state: result.state,
    reason: result.reason,
    detail: result.ok
      ? "Agent runtime woken; queued messages will drain in order."
      : "Wake failed; agent left in a safe state.",
    runtimeGeneration: result.ok ? (result.runtimeGeneration ?? null) : null,
    attempts: result.attempts,
    durationMs: result.durationMs,
    retryable: result.ok ? undefined : true,
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
