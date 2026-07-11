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
 * Short, stable, non-reversible FNV-1a digest. Lets operators correlate an
 * opaque identity (session ref, unresolved command target) across reads without
 * exposing the underlying payload — which may be a filesystem path or secret.
 */
export function fingerprintToken(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Redact a durable runtime spec into an operator-safe view: presence flags,
 * counts, and opaque references only. Raw argv, environment values, filesystem
 * paths, and private socket paths are never surfaced. This is the sanctioned
 * redaction-by-construction boundary for any operator/status/inspect surface.
 */
export function redactRuntimeSpec(spec: AgentRuntimeSpec): RedactedAgentRuntimeSpec {
  const rawRef = spec.sessionResumeRef;
  const separatorIndex = rawRef.indexOf(":");
  const kindHint = separatorIndex > 0 ? rawRef.slice(0, separatorIndex) : "";
  const knownKinds: AgentSessionKind[] = ["session", "leaf", "cwd", "broker"];
  const kind: AgentSessionKind = knownKinds.includes(kindHint as AgentSessionKind)
    ? (kindHint as AgentSessionKind)
    : "unknown";
  // The session ref payload is NEVER surfaced verbatim: for `cwd`/`leaf` kinds
  // (and unrecognized producers) it can be a filesystem path or otherwise
  // sensitive. Instead emit `<kind>:#<fingerprint>` — a stable, short,
  // non-reversible FNV-1a digest that lets operators correlate identity across
  // reads without exposing the payload — and flag whether it looked path-like.
  const payload = separatorIndex > 0 ? rawRef.slice(separatorIndex + 1) : rawRef;
  const hasPath = /[\\/]/.test(payload) || payload.startsWith("~");
  const ref = `${kind}:#${fingerprintToken(rawRef)}`;
  // Repo is reported as a path-free basename so operators can group agents
  // without exposing the worktree/repo-root filesystem path. Split on BOTH
  // separators so a Windows repo root (e.g. `C:\\Users\\alice\\secret-repo`) is
  // never emitted verbatim as its own "basename".
  const repoSegments = spec.repoRoot.split(/[\\/]/).filter(Boolean);
  const repo = repoSegments.length > 0 ? repoSegments[repoSegments.length - 1] : null;

  return {
    agentId: spec.agentId,
    session: {
      kind,
      ref,
      host: spec.expectedHost,
      hasPath,
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
 * Bound and control-strip a free-form reason string for operator-safe display.
 * Reasons can originate from operator input (hibernate/wake commands) and flow
 * durably into lifecycle rows; this is the redaction-by-construction boundary
 * that keeps such strings single-line, control-char free, and length-bounded
 * before they reach any operator/status/JSON surface. Returns null for
 * empty/whitespace-only input.
 */
export function sanitizeOperatorReason(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = Array.from(value)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f ? " " : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  // Two composed passes: first strip secret-bearing shapes (env assignments and
  // CLI flag values) that are not paths, then redact path-like tokens. Ordering
  // matters — a flag's value that is itself a path is caught by the first pass.
  const redacted = redactPathLikeTokens(redactSecretAssignments(cleaned));
  return redacted.length > 120 ? `${redacted.slice(0, 117)}\u2026` : redacted;
}

// Common prose that uses a single "/" and must NOT be treated as a path. Bare
// two-token connectives only; anything path-shaped (multi-segment, file-like,
// absolute, or relative-prefixed) is still redacted by `redactPathLikeTokens`.
const PROSE_SLASH_TOKENS = new Set([
  "and/or",
  "or/and",
  "he/she",
  "she/he",
  "w/",
  "w/o",
  "n/a",
  "i/o",
  "km/h",
  "tcp/ip",
  "24/7",
]);

/**
 * Redact secret-bearing NON-path shapes from an operator free-form string:
 * environment/CLI assignments (`TOKEN=deadbeef` → `TOKEN=<redacted>`) and CLI
 * flag values (`--api-key secret` / `--api-key=secret` → `--api-key <redacted>`).
 * The env var name / flag name is kept (it is not itself the secret) so the
 * reason stays actionable, while the value can never reach an operator surface.
 */
// agent-standards-ignore prefer-inline-single-use-helper: distinct stateful
// secret-redaction pass (flag/value tracking across tokens); composed with the
// path-redaction pass in sanitizeOperatorReason and kept separate for clarity.
function redactSecretAssignments(value: string): string {
  let redactNextValue = false;
  return value
    .split(/(\s+)/)
    .map((token) => {
      if (token.length === 0 || /\s/.test(token)) return token;
      // A value expected immediately after a bare flag (`--flag value`).
      if (redactNextValue) {
        redactNextValue = false;
        if (!/^-/.test(token)) return "<redacted>";
      }
      // Flags: `-f`, `--flag`, and the assignment forms `-f=v` / `--flag=v`.
      if (/^--?[A-Za-z]/.test(token)) {
        const eq = token.indexOf("=");
        if (eq >= 0) return `${token.slice(0, eq)}=<redacted>`;
        redactNextValue = true; // the following token is this flag's value
        return token;
      }
      // Env/CLI assignment: `KEY=value` → keep the (non-secret) key only.
      const assign = /^([A-Za-z_][A-Za-z0-9_.-]*)=.+$/.exec(token);
      if (assign) return `${assign[1]}=<redacted>`;
      return token;
    })
    .join("");
}

/**
 * Replace filesystem-path-like tokens with `<path>` so operator-authored
 * free-form strings (reasons, echoed targets) can never surface private
 * absolute paths, unix socket paths, or repo-relative paths in operator/JSON
 * output. Conservative but fail-closed on ambiguous relative paths: any
 * single-separator token that is not a known prose connective (see
 * `PROSE_SLASH_TOKENS`) is redacted, so `accounts/acme` is caught while
 * "and/or" survives. This is a redaction-by-construction boundary, not a
 * security parser.
 */
export function redactPathLikeTokens(value: string): string {
  return value
    .split(/(\s+)/)
    .map((token) => {
      if (token.length === 0 || /\s/.test(token)) return token;
      const slashCount = (token.match(/[/\\]/g) ?? []).length;
      // Strip trailing sentence punctuation before the prose-allowlist check so
      // "and/or," is still recognized as prose.
      const bare = token.replace(/[.,;:!?)\]]+$/, "").toLowerCase();
      const isProse = slashCount === 1 && PROSE_SLASH_TOKENS.has(bare);
      const pathLike =
        !isProse &&
        (/^[~/]/.test(token) || // /abs or ~/home
          /^\.\.?[/\\]/.test(token) || // ./rel or ../rel
          /^[A-Za-z]:[\\/]/.test(token) || // C:\ or C:/ (Windows)
          slashCount >= 1); // any relative/absolute separator (fail-closed)
      return pathLike ? "<path>" : token;
    })
    .join("");
}

/**
 * Redaction-by-construction for RUNTIME-authored checkpoint reasons. A checkpoint
 * reason is authored by the worker runtime, so — unlike the trusted-operator
 * reason path (which only redacts obvious path-like tokens) — it must NOT be able
 * to smuggle argv, env assignments (`TOKEN=secret`), CLI flags (`--api-key x`),
 * extensionless relative paths (`accounts/acme`), or other free prose onto any
 * operator/telemetry/JSON surface. We therefore allowlist by *shape*: only a
 * short single-token machine code (`active_port_lease`, `checkpoint_timeout`, …)
 * is passed through; anything containing whitespace, separators, or exotic
 * characters collapses to the static `unspecified` code. Diagnostic prose belongs
 * in the worker's own logs, not the broker's operator surface.
 */
export function sanitizeCheckpointReasonCode(value: string | null | undefined): string {
  if (value == null) return "unspecified";
  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(trimmed) ? trimmed.toLowerCase() : "unspecified";
}

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
        reason: sanitizeOperatorReason(event.errorCode ?? event.reason) ?? "unknown",
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
    hibernateReason: sanitizeOperatorReason(input.agent.hibernateReason),
    lastWakeReason: sanitizeOperatorReason(input.agent.lastWakeReason),
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
      reason: queuedEntry ? sanitizeOperatorReason(queuedEntry.reason) : null,
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
