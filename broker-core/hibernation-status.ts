import type {
  AgentCheckpointReceipt,
  AgentHibernatePolicy,
  AgentInfo,
  AgentLifecycleEvent,
  AgentLifecycleState,
  AgentRuntimeSpec,
  AgentSessionKind,
  AgentWakeQueueEntry,
  RedactedAgentRuntimeSpec,
  WakeTriggerKind,
} from "./types.js";

/**
 * Redact a durable runtime spec into an operator-safe view: presence flags,
 * counts, and opaque references only. Raw argv, environment values, filesystem
 * paths, and private socket paths are never surfaced. This is the sanctioned
 * redaction-by-construction boundary for any operator/status/inspect surface.
 */
export function redactRuntimeSpec(spec: AgentRuntimeSpec): RedactedAgentRuntimeSpec {
  const separatorIndex = spec.sessionResumeRef.indexOf(":");
  const kindHint = separatorIndex > 0 ? spec.sessionResumeRef.slice(0, separatorIndex) : "";
  const knownKinds: AgentSessionKind[] = ["session", "leaf", "cwd", "broker"];
  const kind: AgentSessionKind = knownKinds.includes(kindHint as AgentSessionKind)
    ? (kindHint as AgentSessionKind)
    : "unknown";
  // Repo is reported as a path-free basename so operators can group agents
  // without exposing the worktree/repo-root filesystem path.
  const repoSegments = spec.repoRoot.split("/").filter(Boolean);
  const repo = repoSegments.length > 0 ? repoSegments[repoSegments.length - 1] : null;

  return {
    agentId: spec.agentId,
    session: {
      kind,
      ref: spec.sessionResumeRef,
      host: spec.expectedHost,
      hasPath: false,
    },
    repo,
    hasWorktree: Boolean(spec.worktreePath),
    hasTmuxSession: Boolean(spec.tmuxSession),
    configFingerprint: spec.configFingerprint,
    expectedHost: spec.expectedHost,
    launchSource: spec.launchSource,
    envAllowlistCount: spec.envAllowlist.length,
    updatedAt: spec.updatedAt,
  };
}

export interface AgentLifecycleStatusCapacityInput {
  maxConcurrentWakes: number;
  inflightWakes: number;
  maxConcurrentWakesPerRepo: number;
  inflightWakesForRepo: number;
}

export interface AgentLifecycleStatusInput {
  agent: Pick<
    AgentInfo,
    | "id"
    | "lifecycleState"
    | "lifecycleVersion"
    | "runtimeGeneration"
    | "hibernatePolicy"
    | "hibernatedAt"
    | "graceUntil"
    | "idleEligibleAt"
    | "hibernateReason"
    | "lastWakeReason"
  >;
  /** Epoch ms used for age math. Defaults to Date.now(). */
  now?: number;
  latestCheckpoint?: AgentCheckpointReceipt | null;
  runtimeSpec?: AgentRuntimeSpec | null;
  /**
   * Wake queue ordered exactly as the dispatcher consumes it (priority then
   * oldest). Used to compute this agent's 1-based queue position.
   */
  orderedWakeQueue?: AgentWakeQueueEntry[];
  capacity?: AgentLifecycleStatusCapacityInput;
  /** Recent lifecycle events (any order); used to surface refusal/quarantine cause. */
  recentEvents?: AgentLifecycleEvent[];
}

export interface AgentLifecycleStatus {
  agentId: string;
  state: AgentLifecycleState;
  lifecycleVersion: number;
  runtimeGeneration: number | null;
  hibernatePolicy: AgentHibernatePolicy | null;
  hibernatedAt: string | null;
  hibernateReason: string | null;
  lastWakeReason: string | null;
  graceUntil: string | null;
  idleEligibleAt: string | null;
  quarantined: boolean;
  checkpoint: {
    present: boolean;
    hibernateSafe: boolean | null;
    ageMs: number | null;
    pendingInboxCount: number | null;
    runtimeGeneration: number | null;
  };
  /** Presence + redacted summary of the durable runtime spec; never raw argv/env. */
  runtimeSpec: RedactedAgentRuntimeSpec | null;
  wake: {
    queued: boolean;
    position: number | null;
    triggerKind: WakeTriggerKind | null;
    reason: string | null;
    attempt: number | null;
  };
  capacity: {
    global: { inflight: number; max: number; atCapacity: boolean };
    repo: { inflight: number; max: number; atCapacity: boolean };
  } | null;
  /** Most recent non-accepted lifecycle outcome (refusal/stale fence/abort). */
  refusal: { reason: string; outcome: string; at: string } | null;
}

const DURABLE_HIBERNATION_STATES = new Set<AgentLifecycleState>(["hibernated", "waking"]);

/**
 * Compose an operator-safe, actionable per-agent lifecycle status from already
 * sanitized inputs. Pure: it performs no IO and never emits raw argv, env
 * values, or filesystem/socket paths.
 */
export function buildAgentLifecycleStatus(input: AgentLifecycleStatusInput): AgentLifecycleStatus {
  const now = input.now ?? Date.now();
  const state = input.agent.lifecycleState ?? "live";

  const checkpoint = input.latestCheckpoint;
  const checkpointCreatedMs = checkpoint ? Date.parse(checkpoint.createdAt) : Number.NaN;
  const checkpointAgeMs =
    checkpoint && Number.isFinite(checkpointCreatedMs)
      ? Math.max(now - checkpointCreatedMs, 0)
      : null;

  let queuePosition: number | null = null;
  let queuedEntry: AgentWakeQueueEntry | null = null;
  const orderedQueue = input.orderedWakeQueue ?? [];
  for (let index = 0; index < orderedQueue.length; index += 1) {
    const entry = orderedQueue[index];
    if (entry.agentId === input.agent.id && entry.status === "queued") {
      queuePosition = index + 1;
      queuedEntry = entry;
      break;
    }
  }

  let refusal: AgentLifecycleStatus["refusal"] = null;
  for (const event of input.recentEvents ?? []) {
    if (event.agentId !== input.agent.id || event.outcome === "accepted") continue;
    if (refusal === null || event.createdAt > refusal.at) {
      refusal = {
        reason: event.errorCode ?? event.reason,
        outcome: event.outcome,
        at: event.createdAt,
      };
    }
  }

  const capacity = input.capacity
    ? {
        global: {
          inflight: input.capacity.inflightWakes,
          max: input.capacity.maxConcurrentWakes,
          atCapacity: input.capacity.inflightWakes >= input.capacity.maxConcurrentWakes,
        },
        repo: {
          inflight: input.capacity.inflightWakesForRepo,
          max: input.capacity.maxConcurrentWakesPerRepo,
          atCapacity:
            input.capacity.inflightWakesForRepo >= input.capacity.maxConcurrentWakesPerRepo,
        },
      }
    : null;

  return {
    agentId: input.agent.id,
    state,
    lifecycleVersion: input.agent.lifecycleVersion ?? 0,
    runtimeGeneration: input.agent.runtimeGeneration ?? null,
    hibernatePolicy: input.agent.hibernatePolicy ?? null,
    hibernatedAt: input.agent.hibernatedAt ?? null,
    hibernateReason: input.agent.hibernateReason ?? null,
    lastWakeReason: input.agent.lastWakeReason ?? null,
    graceUntil: input.agent.graceUntil ?? null,
    idleEligibleAt: input.agent.idleEligibleAt ?? null,
    quarantined: state === "reap-candidate",
    checkpoint: {
      present: Boolean(checkpoint),
      hibernateSafe: checkpoint ? checkpoint.hibernateSafe : null,
      ageMs: checkpointAgeMs,
      pendingInboxCount: checkpoint ? checkpoint.pendingInboxCount : null,
      runtimeGeneration: checkpoint ? checkpoint.runtimeGeneration : null,
    },
    runtimeSpec: input.runtimeSpec ? redactRuntimeSpec(input.runtimeSpec) : null,
    wake: {
      queued: queuedEntry !== null,
      position: queuePosition,
      triggerKind: queuedEntry ? queuedEntry.triggerKind : null,
      reason: queuedEntry ? queuedEntry.reason : null,
      attempt: queuedEntry ? queuedEntry.attempt : null,
    },
    capacity,
    refusal,
  };
}

/**
 * Render a single scannable, operator-safe lifecycle tag for inline use in the
 * `agents`/`sessions` compact read paths. Sanitized: state, generation, queue
 * position, checkpoint age/safety, and refusal/quarantine reason code only.
 */
export function formatAgentLifecycleTag(status: AgentLifecycleStatus): string {
  const parts: string[] = [status.state];
  if (status.runtimeGeneration !== null) parts.push(`gen${status.runtimeGeneration}`);
  if (status.wake.queued && status.wake.position !== null) parts.push(`q#${status.wake.position}`);
  if (status.checkpoint.present) {
    const age =
      status.checkpoint.ageMs === null ? "?" : `${Math.round(status.checkpoint.ageMs / 1000)}s`;
    parts.push(`ckpt ${age}${status.checkpoint.hibernateSafe === false ? " unsafe" : ""}`);
  }
  if (status.quarantined) {
    parts.push(`\u26a0${status.refusal ? ` ${status.refusal.reason}` : ""}`);
  } else if (status.refusal) {
    parts.push(`refused:${status.refusal.reason}`);
  }
  return parts.join(" \u00b7 ");
}

/**
 * Render a compact, operator-safe status block. Contains only sanitized
 * lifecycle facts — never prompts, message bodies, tokens, argv, env values, or
 * filesystem paths.
 */
export function formatAgentLifecycleStatus(status: AgentLifecycleStatus): string {
  const lines: string[] = [];
  const generation = status.runtimeGeneration === null ? "-" : String(status.runtimeGeneration);
  lines.push(
    `${status.agentId}: ${status.state} (v${status.lifecycleVersion}, gen ${generation}, policy ${status.hibernatePolicy ?? "-"})`,
  );

  if (status.quarantined) {
    lines.push(
      `  \u26a0 quarantined as reap-candidate${status.hibernateReason ? ` — ${status.hibernateReason}` : ""}`,
    );
  }

  if (status.checkpoint.present) {
    const ageSeconds =
      status.checkpoint.ageMs === null ? "?" : Math.round(status.checkpoint.ageMs / 1000);
    const safe = status.checkpoint.hibernateSafe === false ? "unsafe" : "safe";
    lines.push(
      `  checkpoint: ${safe}, age=${ageSeconds}s, pending_inbox=${status.checkpoint.pendingInboxCount ?? 0}, gen=${status.checkpoint.runtimeGeneration ?? "-"}`,
    );
  } else if (DURABLE_HIBERNATION_STATES.has(status.state)) {
    lines.push("  checkpoint: none recorded");
  }

  if (status.runtimeSpec) {
    const spec = status.runtimeSpec;
    lines.push(
      `  runtime spec: present (repo=${spec.repo ?? "-"}, worktree=${spec.hasWorktree ? "yes" : "no"}, tmux=${spec.hasTmuxSession ? "yes" : "no"}, env_allow=${spec.envAllowlistCount}, fingerprint=${spec.configFingerprint})`,
    );
  } else if (DURABLE_HIBERNATION_STATES.has(status.state)) {
    lines.push("  runtime spec: MISSING");
  }

  if (status.wake.queued) {
    const position = status.wake.position === null ? "?" : String(status.wake.position);
    lines.push(
      `  wake queued: position ${position}, trigger=${status.wake.triggerKind ?? "-"}, reason=${status.wake.reason ?? "-"}, attempt=${status.wake.attempt ?? 0}`,
    );
  }

  if (status.capacity) {
    const { global, repo } = status.capacity;
    const globalMark = global.atCapacity ? " (at capacity)" : "";
    const repoMark = repo.atCapacity ? " (at capacity)" : "";
    lines.push(
      `  wake capacity: global ${global.inflight}/${global.max}${globalMark}, repo ${repo.inflight}/${repo.max}${repoMark}`,
    );
  }

  if (status.refusal) {
    lines.push(
      `  last refusal: ${status.refusal.reason} (${status.refusal.outcome}) at ${status.refusal.at}`,
    );
  }

  if (status.lastWakeReason) {
    lines.push(`  last wake reason: ${status.lastWakeReason}`);
  }

  return lines.join("\n");
}
