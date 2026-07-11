import * as crypto from "node:crypto";
import type { BrokerDB } from "./schema.js";
import { evaluateHibernateEligibility } from "./lifecycle.js";
import { sanitizeCheckpointReasonCode, sanitizeOperatorReason } from "./hibernation-status.js";
import type {
  AgentInfo,
  AgentLifecycleLease,
  AgentLifecycleTransitionInput,
  AgentRuntimeSpec,
  RuntimeGenerationAcceptance,
  WakeTriggerKind,
} from "./types.js";

// ─── Adapter contracts (fake in tests, real at runtime) ─────────────

/**
 * Result of asking a follower to cooperatively checkpoint before exit. When
 * `hibernateSafe` is false the orchestrator aborts hibernation and keeps the
 * runtime alive rather than exiting an unsafe process.
 */
export interface HibernationCheckpointOutcome {
  hibernateSafe: boolean;
  reason: string | null;
  sessionResumeRef: string | null;
  pendingInboxCount: number;
  rssBytes: number | null;
}

/** Everything a launch adapter needs to bring back exactly the fenced runtime. */
export interface RuntimeLaunchContext {
  agentId: string;
  stableId: string;
  wakeLeaseId: string;
  fenceToken: number;
  reservedGeneration: number;
  /** Per-attempt nonce the launched runtime must echo back on registration. */
  reservationNonce: string;
  correlationId: string;
  spec: AgentRuntimeSpec;
}

/**
 * Opaque, attempt-bound identity for a runtime a single wake attempt launched.
 * Returned by {@link HibernationTmuxController.respawnRuntime} and required by
 * the attempt-scoped stop/liveness checks so that retry cleanup proves the
 * EXACT process THIS attempt spawned is gone — never the pre-hibernation runtime
 * (whose recorded PID generation is already dead) nor a different attempt.
 */
export interface RuntimeAttemptHandle {
  /** The reservation nonce of the launching attempt (binds the handle to it). */
  readonly reservationNonce: string;
  /** The tmux pane the attempt launched into (a real adapter locates the PID). */
  readonly tmuxTarget: string;
  /** OS pid of the launched runtime, if the adapter captured it. */
  readonly pid: number | null;
}

/** Controls the dormant Pi runtime process (never tmux itself). */
export interface HibernationProcessController {
  /** Ask the follower to flush a checkpoint and confirm hibernate safety. */
  requestCheckpoint(spec: AgentRuntimeSpec): Promise<HibernationCheckpointOutcome>;
  /** Gracefully stop the live Pi runtime (TERM then bounded KILL) before hibernation. */
  stopRuntime(spec: AgentRuntimeSpec): Promise<{ stopped: boolean; rssBytes: number | null }>;
  /** True while the recorded Pi PID/process generation is still alive. */
  isRuntimeAlive(spec: AgentRuntimeSpec): Promise<boolean>;
  /**
   * Stop the runtime a SPECIFIC wake attempt launched, addressed by its
   * attempt-bound handle (not the durable spec). Used by retry cleanup to prove
   * the exact failed-attempt process is gone before relaunching.
   */
  stopLaunchedAttempt(handle: RuntimeAttemptHandle): Promise<{ stopped: boolean }>;
  /** True while the runtime a SPECIFIC wake attempt launched is still alive. */
  isLaunchedAttemptAlive(handle: RuntimeAttemptHandle): Promise<boolean>;
}

/** Reads/writes the attachable tmux shell that outlives the Pi runtime. */
export interface HibernationTmuxController {
  /** True if the recorded tmux session/pane still exists (operator-attachable). */
  isSessionAttachable(spec: AgentRuntimeSpec): Promise<boolean>;
  /**
   * Launch exactly one replacement runtime into the recorded pane. The launched
   * runtime is expected to register presenting the reservation fence. Resolves
   * once the launch command has been issued (registration is confirmed
   * separately via {@link BrokerDB.acceptRuntimeGeneration}). On a successful
   * launch it returns an attempt-bound {@link RuntimeAttemptHandle} so retry
   * cleanup can prove THIS attempt's runtime is stopped before relaunching; a
   * launch that yields no handle is treated as unprovable (fail closed).
   */
  respawnRuntime(
    ctx: RuntimeLaunchContext,
  ): Promise<{ launched: boolean; handle: RuntimeAttemptHandle | null }>;
}

export interface HibernationOrchestratorConfig {
  /** Max time to wait for the cooperative checkpoint handshake. */
  handshakeTimeoutMs: number;
  /** Lease TTL for a wake operation. */
  wakeLeaseMs: number;
  /** Lease TTL for a hibernate operation. */
  hibernateLeaseMs: number;
  /** Time to wait for a launched runtime to register + accept its generation. */
  registrationTimeoutMs: number;
  /** Max wake attempts before quarantining as reap-candidate. */
  maxWakeAttempts: number;
  /** Global concurrent in-flight wakes. */
  maxConcurrentWakes: number;
  /** Per-repo concurrent in-flight wakes. */
  maxConcurrentWakesPerRepo: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: HibernationOrchestratorConfig = {
  handshakeTimeoutMs: 30_000,
  wakeLeaseMs: 90_000,
  hibernateLeaseMs: 120_000,
  registrationTimeoutMs: 60_000,
  maxWakeAttempts: 3,
  maxConcurrentWakes: 2,
  maxConcurrentWakesPerRepo: 1,
};

export interface HibernationOrchestratorDeps {
  db: BrokerDB;
  process: HibernationProcessController;
  tmux: HibernationTmuxController;
  brokerInstanceId: string;
  config?: Partial<HibernationOrchestratorConfig>;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Injectable id generator. Defaults to crypto.randomUUID. */
  newId?: () => string;
  /**
   * Confirm the launched runtime registered and its generation was accepted.
   * Resolves true once accepted, false on timeout. Injected so tests can drive
   * registration deterministically; the runtime wires this to the socket server.
   */
  awaitRuntimeRegistration?: (ctx: RuntimeLaunchContext) => Promise<boolean>;
}

// ─── Result types ───────────────────────────────────────────────────

export interface HibernateResult {
  ok: boolean;
  agentId: string;
  correlationId: string;
  state: string;
  reason: string;
  rssBytesBefore?: number | null;
  rssBytesAfter?: number | null;
  durationMs?: number;
}

export interface WakeResult {
  ok: boolean;
  agentId: string;
  correlationId: string;
  state: string;
  reason: string;
  runtimeGeneration?: number;
  attempts?: number;
  durationMs?: number;
}

/** Outcome of reconciling one agent/queue-row stranded by a broker crash. */
export interface StrandedWakeRecovery {
  /** Agent id, or (for `requeued`) the orphaned dispatch row's agent id. */
  agentId: string;
  /**
   * - `completed`   — a stranded `waking` whose generation was already accepted; only the
   *   final live transition was lost, so it was finished to `live`.
   * - `quarantined` — a stranded `waking` or `hibernating` with an uncertain runtime; moved
   *   to `reap-candidate` for manual review rather than risk a double launch.
   * - `requeued`    — a `dispatching` wake-queue row orphaned mid-dispatch by a crash;
   *   returned to `queued` so a fresh dispatch pass can pick it up.
   */
  action: "completed" | "quarantined" | "requeued";
}

const HIBERNATABLE_PRIORITY: Record<WakeTriggerKind, number> = {
  direct_a2a: 10,
  slack_thread: 20,
  scheduled: 30,
  lane_assignment: 40,
  manual: 15,
};

export function wakeTriggerPriority(kind: WakeTriggerKind): number {
  return HIBERNATABLE_PRIORITY[kind];
}

// agent-standards-ignore prefer-inline-single-use-helper: bounded fail-closed
// timeout is a real async control-flow seam; inlining the race + timer cleanup
// into hibernate() would obscure the checkpoint-safety path.
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Broker-managed hibernation lifecycle orchestrator.
 *
 * Composes the durable primitives in {@link BrokerDB} (fenced leases, CAS
 * lifecycle transitions, runtime specs, checkpoint receipts, generation
 * reservations, wake queue, telemetry events) with injected process/tmux
 * adapters. Every path fails closed: on any anomaly it releases its lease and
 * quarantines the agent as `reap-candidate` with an actionable reason rather
 * than guessing, rerouting affinity work, or killing a PID on PID alone.
 */
export class HibernationOrchestrator {
  private readonly db: BrokerDB;
  private readonly process: HibernationProcessController;
  private readonly tmux: HibernationTmuxController;
  private readonly brokerInstanceId: string;
  private readonly config: HibernationOrchestratorConfig;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly awaitRuntimeRegistration: (ctx: RuntimeLaunchContext) => Promise<boolean>;

  constructor(deps: HibernationOrchestratorDeps) {
    this.db = deps.db;
    this.process = deps.process;
    this.tmux = deps.tmux;
    this.brokerInstanceId = deps.brokerInstanceId;
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...(deps.config ?? {}) };
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.awaitRuntimeRegistration =
      deps.awaitRuntimeRegistration ?? ((ctx) => this.defaultAwaitRegistration(ctx));
  }

  // ─── Prepare (advance an eligible free agent toward `idle`) ─────

  /**
   * Advance an eligible, free, broker-managed agent through `grace` to `idle`
   * so it becomes hibernation-ready. Idempotent and fenced by CAS. Used by both
   * the manual `pinet hibernate` path and the auto scheduler. Never forces a
   * working/unsafe/ineligible agent forward.
   */
  prepareHibernation(
    agentId: string,
    opts: { reason?: string; actor?: string; correlationId?: string } = {},
  ): { ready: boolean; state: string; reason: string } {
    const reason = sanitizeOperatorReason(opts.reason) ?? "prepare_hibernation";
    const actor = opts.actor ?? "broker";
    const correlationId = opts.correlationId ?? this.newId();
    let agent = this.db.getAgentById(agentId);
    if (!agent) return { ready: false, state: "live", reason: "unknown_agent" };

    const eligibility = evaluateHibernateEligibility(agent);
    if (!eligibility.eligible) {
      this.recordRefusal(agentId, "prepare_refused", eligibility.reason, actor, correlationId);
      return { ready: false, state: agent.lifecycleState ?? "live", reason: eligibility.reason };
    }

    // Legal path toward idle: live/active -> grace -> idle. Anything already at
    // idle is ready; hibernating/hibernated/waking/terminated is not preparable.
    const steps: Array<"grace" | "idle"> = [];
    switch (agent.lifecycleState) {
      case "idle":
        return { ready: true, state: "idle", reason: "already_idle" };
      case "live":
      case "active":
        steps.push("grace", "idle");
        break;
      case "grace":
        steps.push("idle");
        break;
      default:
        return {
          ready: false,
          state: agent.lifecycleState ?? "live",
          reason: `not_preparable:${agent.lifecycleState}`,
        };
    }

    for (const toState of steps) {
      agent = this.db.transitionAgentLifecycle({
        agentId,
        expectedVersion: agent.lifecycleVersion ?? 0,
        toState,
        reason,
        actor,
        correlationId,
      });
    }
    return { ready: true, state: agent.lifecycleState ?? "idle", reason: "ready" };
  }

  // ─── Hibernate ──────────────────────────────────────────────────

  async hibernate(
    agentId: string,
    opts: { reason?: string; actor?: string; trigger?: string; correlationId?: string } = {},
  ): Promise<HibernateResult> {
    const correlationId = opts.correlationId ?? this.newId();
    const actor = opts.actor ?? "broker";
    // Operator-authored reason: bound + path-redact at the orchestrator boundary
    // so it is safe regardless of caller, before it can be persisted into any
    // lifecycle row / event.
    const reason = sanitizeOperatorReason(opts.reason) ?? "manual";
    const startedAt = this.now();

    const agent = this.db.getAgentById(agentId);
    if (!agent) return this.refuseHibernate(agentId, correlationId, "live", "unknown_agent", actor);

    const eligibility = evaluateHibernateEligibility(agent);
    if (!eligibility.eligible) {
      return this.refuseHibernate(
        agentId,
        correlationId,
        agent.lifecycleState ?? "live",
        eligibility.reason,
        actor,
      );
    }
    if (agent.lifecycleState !== "idle") {
      return this.refuseHibernate(
        agentId,
        correlationId,
        agent.lifecycleState ?? "live",
        `not_idle:${agent.lifecycleState}`,
        actor,
      );
    }
    const spec = this.db.getAgentRuntimeSpec(agentId);
    if (!spec) {
      return this.refuseHibernate(agentId, correlationId, "idle", "missing_runtime_spec", actor);
    }

    const lease = this.db.acquireAgentLifecycleLease({
      agentId,
      operation: "hibernate",
      ownerBrokerInstanceId: this.brokerInstanceId,
      leaseId: this.newId(),
      ttlMs: this.config.hibernateLeaseMs,
      now: this.now(),
    });
    if (!lease) {
      return this.refuseHibernate(agentId, correlationId, "idle", "lease_contended", actor);
    }

    // Fail-closed fault tracking: an unexpected adapter/DB rejection must never
    // leave the agent stranded in `hibernating`. `enteredHibernating` records
    // that we own the CAS transition; `teardownStarted` records that the
    // process stop was attempted (so the runtime's liveness is now unknown).
    let versionCursor = agent.lifecycleVersion ?? 0;
    let enteredHibernating = false;
    let teardownStarted = false;
    try {
      // idle -> hibernating (fenced CAS)
      const hibernating = this.transitionFenced(lease, {
        agentId,
        expectedVersion: versionCursor,
        toState: "hibernating",
        reason,
        actor,
        correlationId,
        triggerSource: opts.trigger,
      });
      versionCursor = hibernating.lifecycleVersion ?? versionCursor + 1;
      enteredHibernating = true;

      // Cooperative checkpoint handshake (fail closed on timeout).
      const checkpoint = await withTimeout(
        this.process.requestCheckpoint(spec),
        this.config.handshakeTimeoutMs,
        () => ({
          hibernateSafe: false,
          reason: "checkpoint_timeout",
          sessionResumeRef: null,
          pendingInboxCount: 0,
          rssBytes: null,
        }),
      );
      this.db.recordAgentCheckpointReceipt({
        agentId,
        runtimeGeneration: agent.runtimeGeneration ?? 0,
        correlationId,
        hibernateSafe: checkpoint.hibernateSafe,
        // Persist only an allowlisted machine code, never the runtime's raw
        // reason prose — the receipt is durable and read on recovery.
        reason: sanitizeCheckpointReasonCode(checkpoint.reason),
        sessionResumeRef: checkpoint.sessionResumeRef,
        pendingInboxCount: checkpoint.pendingInboxCount,
        rssBytes: checkpoint.rssBytes,
      });

      // New work or an unsafe runtime must abort hibernation back to a safe
      // live/active state — never exit the process.
      const freshInbox = this.db.getUnreadInboxCount(agentId);
      if (!checkpoint.hibernateSafe || freshInbox > 0 || checkpoint.pendingInboxCount > 0) {
        // `checkpoint.reason` is runtime-authored; collapse it to an allowlisted
        // machine code so no argv/env/path prose leaks through the abort surface.
        const abortReason = !checkpoint.hibernateSafe
          ? `checkpoint_unsafe:${sanitizeCheckpointReasonCode(checkpoint.reason)}`
          : "work_arrived_during_checkpoint";
        // Rollback-to-active before teardown is a fail-closed SAFETY transition:
        // use an unfenced administrative CAS so a hibernate lease that expired
        // during a slow checkpoint handshake cannot leave the row stranded in
        // `hibernating`. The version CAS still blocks clobbering a concurrent
        // legitimate writer.
        const active = this.transitionAdministrative({
          agentId,
          expectedVersion: versionCursor,
          toState: "active",
          reason: abortReason,
          actor,
          correlationId,
        });
        return {
          ok: false,
          agentId,
          correlationId,
          state: active.lifecycleState ?? "active",
          reason: abortReason,
        };
      }

      // Graceful teardown. Past this point the runtime has been asked to stop,
      // so any subsequent fault leaves its liveness unknown → quarantine.
      teardownStarted = true;
      const stop = await this.process.stopRuntime(spec);
      const stillAlive = await this.process.isRuntimeAlive(spec);
      if (!stop.stopped || stillAlive) {
        return this.quarantine(
          agentId,
          versionCursor,
          correlationId,
          actor,
          "runtime_survived_stop",
          lease,
        );
      }

      const attachable = await this.tmux.isSessionAttachable(spec);
      if (!attachable) {
        return this.quarantine(
          agentId,
          versionCursor,
          correlationId,
          actor,
          "tmux_session_missing",
          lease,
        );
      }

      // hibernating -> hibernated.
      const durationMs = this.now() - startedAt;
      const hibernated = this.transitionFenced(lease, {
        agentId,
        expectedVersion: versionCursor,
        toState: "hibernated",
        reason,
        actor,
        correlationId,
        durationMs,
        rssBytesBefore: checkpoint.rssBytes,
        rssBytesAfter: stop.rssBytes,
      });
      return {
        ok: true,
        agentId,
        correlationId,
        state: hibernated.lifecycleState ?? "hibernated",
        reason: "hibernated",
        rssBytesBefore: checkpoint.rssBytes,
        rssBytesAfter: stop.rssBytes,
        durationMs,
      };
    } catch {
      // Redaction-by-construction: never surface the raw error (it can carry
      // paths). Use a static fault code and fail closed based on how far we got.
      const faultReason = "hibernate_fault";
      if (!enteredHibernating) {
        // State was never changed by us; surface a refusal without forcing a
        // transition that might not be valid from the current state.
        this.recordRefusal(agentId, "hibernate_refused", faultReason, actor, correlationId);
        return {
          ok: false,
          agentId,
          correlationId,
          state: this.db.getAgentById(agentId)?.lifecycleState ?? "idle",
          reason: faultReason,
        };
      }
      try {
        if (!teardownStarted) {
          // The runtime was never asked to stop, so it is still alive: abort
          // back to active rather than quarantine. Unfenced administrative CAS
          // so an expired hibernate lease cannot strand the row in `hibernating`.
          const active = this.transitionAdministrative({
            agentId,
            expectedVersion: versionCursor,
            toState: "active",
            reason: faultReason,
            actor,
            correlationId,
          });
          return {
            ok: false,
            agentId,
            correlationId,
            state: active.lifecycleState ?? "active",
            reason: faultReason,
          };
        }
        // Teardown began; runtime liveness is unknown → quarantine for review.
        return this.quarantine(agentId, versionCursor, correlationId, actor, faultReason, lease);
      } catch {
        // Even the recovery transition failed (e.g. version raced). Report a
        // safe failure; the lease still releases in `finally`.
        return {
          ok: false,
          agentId,
          correlationId,
          state: this.db.getAgentById(agentId)?.lifecycleState ?? "hibernating",
          reason: faultReason,
        };
      }
    } finally {
      this.db.releaseAgentLifecycleLease(agentId, lease.leaseId, lease.fenceToken);
    }
  }

  // ─── Wake ───────────────────────────────────────────────────────

  /**
   * Cold-wake a hibernated agent as a single accepted runtime generation, then
   * transition to `live` so the durable inbox drains in order. Concurrent
   * triggers contend on the fenced wake lease; only one wins.
   */
  async wake(
    agentId: string,
    opts: {
      reason?: string;
      actor?: string;
      trigger?: WakeTriggerKind;
      correlationId?: string;
    } = {},
  ): Promise<WakeResult> {
    const correlationId = opts.correlationId ?? this.newId();
    const actor = opts.actor ?? "broker";
    // Bound + path-redact the operator-authored reason before it can be
    // persisted into any lifecycle row / event.
    const reason = sanitizeOperatorReason(opts.reason) ?? "manual";
    const startedAt = this.now();
    // Cross-cutting fault state, read by the outer catch:
    //  - `acceptedGeneration`: the socket layer atomically accepted our generation,
    //    so the runtime is live+connected. Acceptance is IRREVERSIBLE — a later
    //    fault must NEVER quarantine it; leave `waking` for `recoverStrandedWakes`.
    //  - `inFlightHandle`/`inFlightLaunched`: a launched-but-unaccepted attempt that
    //    may still be running. Any escape must prove-stop it (via its attempt-bound
    //    handle) or fail closed as `wake_ambiguous_launch` rather than leak it.
    let acceptedGeneration = false;
    let inFlightLaunched = false;
    let inFlightHandle: RuntimeAttemptHandle | null = null;

    const agent = this.db.getAgentById(agentId);
    if (!agent) return this.refuseWake(agentId, correlationId, "live", "unknown_agent", actor);
    if (agent.lifecycleState !== "hibernated") {
      return this.refuseWake(
        agentId,
        correlationId,
        agent.lifecycleState ?? "live",
        `not_hibernated:${agent.lifecycleState}`,
        actor,
      );
    }
    const spec = this.db.getAgentRuntimeSpec(agentId);
    if (!spec) {
      return this.refuseWake(agentId, correlationId, "hibernated", "missing_runtime_spec", actor);
    }

    const lease = this.db.acquireAgentLifecycleLease({
      agentId,
      operation: "wake",
      ownerBrokerInstanceId: this.brokerInstanceId,
      leaseId: this.newId(),
      ttlMs: this.config.wakeLeaseMs,
      now: this.now(),
    });
    if (!lease) {
      // The fenced lifecycle lease is held by someone else. Only a *live wake*
      // lease actually drains the inbox, so we must distinguish:
      //   - a matching unexpired wake lease → a real in-flight wake is the single
      //     winner and this trigger is satisfied by it (benign no-op);
      //   - any other held lease (e.g. a lingering/expired hibernate lease around
      //     a crash) → no wake is in flight, so this trigger must NOT be dropped.
      //     Report distinct, retryable contention so the dispatcher requeues it.
      const held = this.db.getAgentLifecycleLease(agentId);
      const wakeInFlight =
        held !== null && held.operation === "wake" && Date.parse(held.expiresAt) > this.now();
      const contentionReason = wakeInFlight ? "wake_in_progress" : "wake_lease_contended";
      return this.refuseWake(agentId, correlationId, "hibernated", contentionReason, actor);
    }

    let versionCursor = agent.lifecycleVersion ?? 0;
    try {
      // hibernated -> waking (fenced CAS).
      const waking = this.transitionFenced(lease, {
        agentId,
        expectedVersion: versionCursor,
        toState: "waking",
        reason,
        actor,
        correlationId,
        triggerSource: opts.trigger,
      });
      versionCursor = waking.lifecycleVersion ?? versionCursor + 1;

      const maxAttempts = Math.max(1, this.config.maxWakeAttempts);
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        // Keep the lease valid across this attempt's launch + registration waits
        // so a legitimately long wake (whose cumulative waits can outrun a single
        // lease TTL) still completes its fenced `live` transition instead of
        // being quarantined on expiry. Renewal preserves the fence, so revival
        // fencing is unchanged. A null result means ownership was lost to another
        // broker → fail closed (quarantine) rather than double-drive the wake.
        const renewed = this.db.renewAgentLifecycleLease({
          agentId,
          leaseId: lease.leaseId,
          fenceToken: lease.fenceToken,
          ttlMs: this.config.wakeLeaseMs,
          now: this.now(),
        });
        if (!renewed) {
          return this.quarantineWake(
            agentId,
            versionCursor,
            correlationId,
            actor,
            "wake_lease_lost",
            lease,
            attempt - 1,
          );
        }
        const reservation = this.db.reserveWakeGeneration({
          agentId,
          wakeLeaseId: lease.leaseId,
          fenceToken: lease.fenceToken,
          correlationId,
          now: this.now(),
        });
        const launchCtx: RuntimeLaunchContext = {
          agentId,
          stableId: spec.stableId,
          wakeLeaseId: lease.leaseId,
          fenceToken: lease.fenceToken,
          reservedGeneration: reservation.reservedGeneration,
          reservationNonce: reservation.reservationNonce,
          correlationId,
          spec,
        };

        // Launch the replacement runtime. A throw MID-LAUNCH leaves an unknown
        // process with no handle to address, so its liveness is unprovable → fail
        // closed (never fall through to the generic fault path, which would leak it).
        inFlightLaunched = true;
        inFlightHandle = null;
        let launch: { launched: boolean; handle: RuntimeAttemptHandle | null };
        try {
          launch = await this.tmux.respawnRuntime(launchCtx);
        } catch {
          return this.quarantineWake(
            agentId,
            versionCursor,
            correlationId,
            actor,
            "wake_ambiguous_launch",
            lease,
            attempt,
          );
        }
        inFlightLaunched = launch.launched;
        inFlightHandle = launch.handle;

        // Wait for the woken runtime to re-register and present its fence. The
        // socket layer accepts the generation ATOMICALLY on a valid registration,
        // so acceptance can happen even if the wait — or the acceptance read —
        // throws afterward. Catch and re-confirm from the durable row rather than
        // assuming failure (which would prove-stop an already-accepted runtime).
        let registered = false;
        let accepted = false;
        try {
          registered = launch.launched ? await this.awaitRuntimeRegistration(launchCtx) : false;
          if (registered) {
            accepted =
              this.db.getAgentById(agentId)?.runtimeGeneration === reservation.reservedGeneration;
          }
        } catch {
          accepted = this.isGenerationAccepted(agentId, reservation.reservedGeneration);
        }

        if (accepted) {
          // The socket layer already bound this runtime to our exact
          // lease/fence/reservation and atomically advanced+consumed the
          // generation, so from here acceptance is IRREVERSIBLE: the runtime is
          // live and connected and must NEVER be quarantined. The `waking -> live`
          // promotion is pure bookkeeping — drive it with an unfenced
          // administrative CAS (a lease that expired *after* acceptance must not
          // throw a fenced transition and quarantine an already-live runtime) and
          // GUARD it so that any post-acceptance DB fault (transition, inbox
          // count, wake completion) leaves the identity in `waking` for
          // `recoverStrandedWakes` to finish to `live`, rather than quarantining.
          acceptedGeneration = true;
          inFlightLaunched = false; // the attempt IS the live runtime; never stop it
          inFlightHandle = null;
          const durationMs = this.now() - startedAt;
          try {
            const live = this.transitionAdministrative({
              agentId,
              expectedVersion: versionCursor,
              toState: "live",
              reason,
              actor,
              correlationId,
              durationMs,
              queueDepth: this.db.getUnreadInboxCount(agentId),
            });
            this.db.completeWakeForAgent(agentId);
            return {
              ok: true,
              agentId,
              correlationId,
              state: live.lifecycleState ?? "live",
              reason: "woken",
              runtimeGeneration: reservation.reservedGeneration,
              attempts: attempt,
              durationMs,
            };
          } catch {
            // Post-acceptance bookkeeping faulted. The worker is awake; leave
            // `waking` for recovery to finalize. Report success on the material
            // outcome with a recovery-pending hint (never quarantine).
            return {
              ok: true,
              agentId,
              correlationId,
              state: this.db.getAgentById(agentId)?.lifecycleState ?? "waking",
              reason: "woken_recovery_pending",
              runtimeGeneration: reservation.reservedGeneration,
              attempts: attempt,
            };
          }
        }

        // Failed attempt. If a runtime was actually launched but not accepted,
        // its liveness is now ambiguous — it may just be slow to register. We
        // must never leave a possibly-live runtime behind (whether we are about
        // to relaunch on top of it OR about to quarantine and hand the durable
        // row to a spec-addressed reaper that cannot see this PID), so on ANY
        // launched-but-unaccepted attempt we best-effort stop it and only proceed
        // if we can PROVE it is gone; otherwise fail closed (`wake_ambiguous_launch`)
        // rather than risk two runtimes for one identity. Running on the final
        // attempt too closes the same leak symmetrically. (The per-attempt nonce
        // independently fences a superseded runtime out of a later reservation,
        // but a leaked *process* is still a safety issue.)
        //
        // The stop/liveness proof is addressed by the attempt-bound handle from
        // THIS launch (`launch.handle`), not the durable spec. Using the spec
        // would target the pre-hibernation runtime's recorded PID generation —
        // which is already dead — and so would always "confirm stopped" while the
        // newly launched attempt kept running. A launch that produced no handle,
        // or a stop/liveness probe that throws, is unprovable and must fail closed
        // (`proveAttemptStopped` swallows throws and returns false).
        if (launch.launched && !(await this.proveAttemptStopped(launch.handle))) {
          return this.quarantineWake(
            agentId,
            versionCursor,
            correlationId,
            actor,
            "wake_ambiguous_launch",
            lease,
            attempt,
          );
        }
        inFlightLaunched = false; // this attempt is confirmed gone (or nothing launched)
        inFlightHandle = null;
        // The prior attempt's runtime is confirmed gone (or nothing launched).
        // Do NOT clear the reservation here: re-reserving on the next attempt
        // mints a fresh nonce that overwrites this row (fencing the prior
        // runtime), and quarantine/acceptance clears it on the terminal paths.
        this.db.recordAgentLifecycleEvent({
          agentId,
          fromState: "waking",
          toState: "waking",
          lifecycleVersion: versionCursor,
          reason,
          actor,
          correlationId,
          outcome: attempt < maxAttempts ? "wake_retry" : "wake_exhausted",
          errorCode: registered ? "generation_not_accepted" : "launch_or_registration_timeout",
          fenceToken: lease.fenceToken,
        });
      }

      // All attempts exhausted → quarantine.
      return this.quarantineWake(
        agentId,
        versionCursor,
        correlationId,
        actor,
        "wake_attempts_exhausted",
        lease,
        maxAttempts,
      );
    } catch {
      // Fail-closed on an unexpected adapter/DB fault that escaped the per-attempt
      // handling. Two invariants override the generic quarantine:
      //
      //  1. If our generation was already ACCEPTED, the runtime is live and
      //     socket-bound. Acceptance is irreversible: never quarantine it — leave
      //     `waking` for `recoverStrandedWakes` to promote to `live`.
      if (acceptedGeneration) {
        return {
          ok: true,
          agentId,
          correlationId,
          state: this.db.getAgentById(agentId)?.lifecycleState ?? "waking",
          reason: "woken_recovery_pending",
        };
      }
      //  2. A launched-but-unaccepted attempt may still be running. Prove-stop it
      //     via its attempt-bound handle; if it cannot be confirmed gone (or there
      //     is no handle), fail closed as `wake_ambiguous_launch` rather than leak
      //     a runtime. Otherwise it is a plain fault. Static reasons only; never
      //     surface raw errors.
      const faultReason =
        inFlightLaunched && !(await this.proveAttemptStopped(inFlightHandle))
          ? "wake_ambiguous_launch"
          : "wake_fault";
      try {
        return this.quarantineWake(
          agentId,
          versionCursor,
          correlationId,
          actor,
          faultReason,
          lease,
          0,
        );
      } catch {
        return {
          ok: false,
          agentId,
          correlationId,
          state: this.db.getAgentById(agentId)?.lifecycleState ?? "waking",
          reason: faultReason,
        };
      }
    } finally {
      this.db.releaseAgentLifecycleLease(agentId, lease.leaseId, lease.fenceToken);
    }
  }

  /**
   * Best-effort proof that a launched wake ATTEMPT's runtime is gone, addressed
   * by its attempt-bound handle (never the durable spec). Fail-closed: a missing
   * handle, an unconfirmed stop, a still-alive probe, OR any adapter throw all
   * count as "not proven gone", so the caller quarantines (`wake_ambiguous_launch`)
   * rather than relaunch on / strand a possibly-live runtime.
   */
  private async proveAttemptStopped(handle: RuntimeAttemptHandle | null): Promise<boolean> {
    if (!handle) return false;
    try {
      const stop = await this.process.stopLaunchedAttempt(handle);
      if (!stop.stopped) return false;
      return !(await this.process.isLaunchedAttemptAlive(handle));
    } catch {
      return false;
    }
  }

  /**
   * Confirm — best-effort, throw-swallowing — whether the durable row already
   * reflects our accepted generation. Used when the acceptance READ faults after
   * the socket may have atomically accepted the generation, so an accepted
   * runtime is not misread as a failed attempt. A read fault ⇒ unconfirmable ⇒ false.
   */
  private isGenerationAccepted(agentId: string, reservedGeneration: number): boolean {
    try {
      return this.db.getAgentById(agentId)?.runtimeGeneration === reservedGeneration;
    } catch {
      return false;
    }
  }

  /**
   * Attempt to accept a launched runtime's generation on registration. Called
   * by the socket server (or the injected registration waiter). Idempotent and
   * fenced: only the reservation's exact lease/fence/generation is accepted.
   */
  acceptRuntimeRegistration(input: {
    agentId: string;
    wakeLeaseId: string;
    fenceToken: number;
    reservedGeneration: number;
    reservationNonce: string;
  }): RuntimeGenerationAcceptance {
    const acceptance = this.db.acceptRuntimeGeneration({ ...input, now: this.now() });
    if (!acceptance.accepted) {
      const agent = this.db.getAgentById(input.agentId);
      this.db.recordAgentLifecycleEvent({
        agentId: input.agentId,
        fromState: agent?.lifecycleState ?? "waking",
        toState: agent?.lifecycleState ?? "waking",
        lifecycleVersion: agent?.lifecycleVersion ?? 0,
        reason: "runtime_registration",
        actor: "broker",
        correlationId: input.wakeLeaseId,
        outcome: "generation_rejected",
        errorCode: acceptance.reason,
        fenceToken: input.fenceToken,
      });
    }
    return acceptance;
  }

  /**
   * Reconcile lifecycle + wake-queue state left inconsistent by a broker crash.
   * Intended to run once on broker startup (and is safe to re-run). DB-only and
   * idempotent. Three classes of strand are repaired:
   *
   * 1. Agents in `waking` (crash between generation acceptance and the final
   *    `waking -> live` transition):
   *    - If a runtime already accepted its generation (reservation consumed and
   *      runtime_generation advanced past the checkpoint's generation) only the
   *      final live transition was lost → complete to `live` so the inbox drains.
   *    - Otherwise the wake outcome is uncertain (a runtime may or may not have
   *      launched) → fail closed to `reap-candidate` for manual review.
   * 2. Agents in `hibernating` (crash mid-hibernate, before reaching the durable
   *    `hibernated` state): the runtime may or may not have been torn down, so
   *    completing to `hibernated` risks a double launch on the next wake → fail
   *    closed to `reap-candidate` for manual review.
   * 3. Wake-queue rows left in `dispatching` (crash mid-dispatch): the owning
   *    dispatch loop is gone, so return them to `queued` (they also block the
   *    unique active-agent index until reclaimed) so a fresh pass re-dispatches.
   *
   * Only a lease held by THIS live broker instance causes a skip (we are still
   * actively driving that operation). A lease owned by a *different* instance is
   * orphaned from a prior, now-dead broker — a crash normally leaves precisely
   * such an unexpired-but-orphaned lease — so it is reconciled immediately rather
   * than waiting out its TTL (during which the row would otherwise be stranded).
   */
  recoverStrandedWakes(opts: { now?: number } = {}): StrandedWakeRecovery[] {
    const now = opts.now ?? this.now();
    const recovered: StrandedWakeRecovery[] = [];
    for (const agent of this.db.getAllAgents()) {
      const strandedState = agent.lifecycleState;
      if (strandedState !== "waking" && strandedState !== "hibernating") continue;
      const lease = this.db.getAgentLifecycleLease(agent.id);
      const heldByThisBroker =
        lease !== null &&
        Date.parse(lease.expiresAt) > now &&
        lease.ownerBrokerInstanceId === this.brokerInstanceId;
      if (heldByThisBroker) continue;

      const version = agent.lifecycleVersion ?? 0;
      const correlationId = this.newId();

      // A stranded `hibernating` agent never reached the durable `hibernated`
      // state; its runtime liveness is unknown, so fail closed rather than risk
      // a double launch by completing the hibernate.
      if (strandedState === "hibernating") {
        try {
          this.db.cancelWake(agent.id);
          this.db.clearAgentWakeReservation(agent.id);
          this.db.transitionAgentLifecycle({
            agentId: agent.id,
            expectedVersion: version,
            toState: "reap-candidate",
            reason: "hibernate_recovery_stranded",
            actor: "broker",
            correlationId,
          });
          if (lease) this.db.releaseAgentLifecycleLease(agent.id, lease.leaseId, lease.fenceToken);
          recovered.push({ agentId: agent.id, action: "quarantined" });
        } catch {
          // Raced with a live owner or a concurrent recovery pass; leave it be.
        }
        continue;
      }

      const reservation = this.db.getAgentWakeReservation(agent.id);
      const checkpointGeneration =
        this.db.getLatestAgentCheckpointReceipt(agent.id)?.runtimeGeneration ?? null;
      const currentGeneration = agent.runtimeGeneration ?? 0;
      const generationAccepted =
        reservation === null &&
        checkpointGeneration !== null &&
        currentGeneration > checkpointGeneration;

      try {
        if (generationAccepted) {
          this.db.transitionAgentLifecycle({
            agentId: agent.id,
            expectedVersion: version,
            toState: "live",
            reason: "wake_recovery_complete",
            actor: "broker",
            correlationId,
          });
          this.db.completeWakeForAgent(agent.id);
          if (lease) this.db.releaseAgentLifecycleLease(agent.id, lease.leaseId, lease.fenceToken);
          recovered.push({ agentId: agent.id, action: "completed" });
        } else {
          this.db.clearAgentWakeReservation(agent.id);
          this.db.cancelWake(agent.id);
          this.db.transitionAgentLifecycle({
            agentId: agent.id,
            expectedVersion: version,
            toState: "reap-candidate",
            reason: "wake_recovery_stranded",
            actor: "broker",
            correlationId,
          });
          if (lease) this.db.releaseAgentLifecycleLease(agent.id, lease.leaseId, lease.fenceToken);
          recovered.push({ agentId: agent.id, action: "quarantined" });
        }
      } catch {
        // Raced with a live owner or a concurrent recovery pass; leave it be.
      }
    }

    // Reclaim wake-queue rows orphaned mid-dispatch by the crash. On a fresh
    // startup nothing is actively dispatching, so any `dispatching` row is
    // stale; return it to `queued` for a fresh dispatch pass.
    for (const row of this.db.listWakeQueue("dispatching")) {
      const requeued = this.db.requeueWake(row.id);
      if (requeued) recovered.push({ agentId: row.agentId, action: "requeued" });
    }
    return recovered;
  }

  // ─── Wake queue dispatch ────────────────────────────────────────

  /**
   * Enqueue a wake trigger for a hibernated agent. Idempotent per agent and
   * priority-ordered (targeted work first). Never fans out to broadcast.
   */
  enqueueWakeTrigger(input: {
    agentId: string;
    triggerKind: WakeTriggerKind;
    reason: string;
    triggerMessageId?: number | null;
    correlationId?: string;
  }): void {
    const spec = this.db.getAgentRuntimeSpec(input.agentId);
    this.db.enqueueWake({
      agentId: input.agentId,
      repoRoot: spec?.repoRoot ?? null,
      triggerKind: input.triggerKind,
      triggerMessageId: input.triggerMessageId ?? null,
      priority: wakeTriggerPriority(input.triggerKind),
      reason: input.reason,
      correlationId: input.correlationId ?? this.newId(),
    });
  }

  /**
   * Dispatch queued wakes respecting global and per-repo concurrency limits,
   * in priority then oldest-first order. Returns the results of wakes started
   * this pass. Safe to call repeatedly (e.g. on a timer or after each trigger).
   */
  async dispatchWakeQueue(): Promise<WakeResult[]> {
    const results: WakeResult[] = [];
    // Agents whose wake could not start this pass because a *non-wake* lease is
    // transiently held. Their rows are requeued (not consumed); skip them for the
    // remainder of this pass so a lingering lease cannot spin the loop.
    const deferred = new Set<string>();
    for (;;) {
      const globalInflight = this.db.countInflightWakes();
      if (globalInflight >= this.config.maxConcurrentWakes) break;
      const next = this.selectNextDispatchableWake(deferred);
      if (!next) break;
      const claimed = this.db.markWakeDispatching(next.id);
      if (!claimed) continue;
      let result: WakeResult;
      try {
        result = await this.wake(claimed.agentId, {
          trigger: claimed.triggerKind,
          reason: claimed.reason,
          correlationId: claimed.correlationId,
        });
      } catch {
        // wake() is designed to fail closed without throwing, but a dispatching
        // queue row must never strand the drain pass. Guard the finalization
        // write ITSELF: if cancelling the row also throws (transient DB fault),
        // leave the row `dispatching` — it carries no held lease and is requeued
        // by `recoverStrandedWakes` on the next reconciliation pass — rather than
        // letting the exception crash the loop and strand every other queued row.
        let lifecycleState = "waking";
        try {
          this.db.completeWakeQueueEntry(claimed.id, "cancelled");
          lifecycleState = this.db.getAgentById(claimed.agentId)?.lifecycleState ?? "waking";
        } catch {
          // Finalization write failed; the row stays reclaimable via reconciliation.
        }
        results.push({
          ok: false,
          agentId: claimed.agentId,
          correlationId: claimed.correlationId,
          state: lifecycleState,
          reason: "wake_fault",
        });
        continue;
      }
      try {
        if (!result.ok && result.reason === "wake_in_progress") {
          // A live wake lease owner is already draining this agent; consume the row.
          this.db.completeWakeQueueEntry(claimed.id, "done");
        } else if (!result.ok && result.reason === "wake_lease_contended") {
          // A non-wake lifecycle lease is transiently holding the agent; no wake is
          // in flight, so the trigger must survive. Requeue and defer this agent so
          // the same lease cannot re-select it and spin this pass.
          this.db.requeueWake(claimed.id);
          deferred.add(claimed.agentId);
        } else {
          this.db.completeWakeQueueEntry(claimed.id, result.ok ? "done" : "cancelled");
        }
      } catch {
        // A transient finalization-write failure must not crash the drain pass or
        // strand the other queued agents. The wake itself already resolved durably
        // above; the row simply stays `dispatching` and is reclaimed by
        // `recoverStrandedWakes` (which requeues every `dispatching` row) on the
        // next startup/reconciliation pass. Fail-closed: never lose the trigger.
      }
      results.push(result);
    }
    return results;
  }

  private selectNextDispatchableWake(deferred?: ReadonlySet<string>) {
    const queued = this.db.listWakeQueue("queued");
    for (const entry of queued) {
      if (deferred?.has(entry.agentId)) continue;
      const repoInflight = this.db.countInflightWakes(entry.repoRoot ?? null);
      if (repoInflight >= this.config.maxConcurrentWakesPerRepo) continue;
      return entry;
    }
    return null;
  }

  // ─── Internal helpers ───────────────────────────────────────────

  private async defaultAwaitRegistration(ctx: RuntimeLaunchContext): Promise<boolean> {
    const deadline = this.now() + this.config.registrationTimeoutMs;
    for (;;) {
      const agent = this.db.getAgentById(ctx.agentId);
      if (agent?.runtimeGeneration === ctx.reservedGeneration) return true;
      if (this.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private refuseHibernate(
    agentId: string,
    correlationId: string,
    state: string,
    reason: string,
    actor: string,
  ): HibernateResult {
    this.recordRefusal(agentId, "hibernate_refused", reason, actor, correlationId);
    return { ok: false, agentId, correlationId, state, reason };
  }

  private refuseWake(
    agentId: string,
    correlationId: string,
    state: string,
    reason: string,
    actor: string,
  ): WakeResult {
    this.recordRefusal(agentId, "wake_refused", reason, actor, correlationId);
    return { ok: false, agentId, correlationId, state, reason };
  }

  private recordRefusal(
    agentId: string,
    outcome: string,
    reason: string,
    actor: string,
    correlationId: string,
  ): void {
    const agent = this.db.getAgentById(agentId);
    this.db.recordAgentLifecycleEvent({
      agentId,
      fromState: agent?.lifecycleState ?? "live",
      toState: agent?.lifecycleState ?? "live",
      lifecycleVersion: agent?.lifecycleVersion ?? 0,
      reason,
      actor,
      correlationId,
      outcome,
    });
  }

  /**
   * Drive a fenced lifecycle transition bound to the *live* held lease. Passing
   * the full lease identity (fence + id + operation + current time) lets the DB
   * reject an expired, superseded, or wrong-operation lease rather than trusting
   * the fence token alone. `now` is read fresh per call so a lease that expires
   * mid-operation cannot authorize a later transition.
   */
  private transitionFenced(
    lease: AgentLifecycleLease,
    input: Omit<
      AgentLifecycleTransitionInput,
      "fenceToken" | "leaseId" | "expectedOperation" | "now"
    >,
  ): AgentInfo {
    return this.db.transitionAgentLifecycle({
      ...input,
      fenceToken: lease.fenceToken,
      leaseId: lease.leaseId,
      expectedOperation: lease.operation,
      now: this.now(),
    });
  }

  /**
   * Fail-closed *safety* transition to a quarantine/abort state. Unlike a
   * forward-progress transition this is deliberately UNFENCED: it must be able
   * to fire even when our own lease has expired mid-operation (e.g. a wake whose
   * cumulative adapter waits outran the lease TTL), otherwise the agent would be
   * stranded in `waking`/`hibernating`. Safety is preserved by the version CAS
   * inside `transitionAgentLifecycle`: if another broker legitimately advanced
   * the agent (bumping the version) our recovery CAS fails and we do not clobber
   * it; if nobody else touched it, we move it to the safe state.
   */
  private transitionAdministrative(
    input: Omit<
      AgentLifecycleTransitionInput,
      "fenceToken" | "leaseId" | "expectedOperation" | "now"
    >,
  ): AgentInfo {
    return this.db.transitionAgentLifecycle(input);
  }

  private quarantine(
    agentId: string,
    expectedVersion: number,
    correlationId: string,
    actor: string,
    reason: string,
    _lease: AgentLifecycleLease,
  ): HibernateResult {
    const current = this.transitionAdministrative({
      agentId,
      expectedVersion,
      toState: "reap-candidate",
      reason,
      actor,
      correlationId,
    });
    return {
      ok: false,
      agentId,
      correlationId,
      state: current.lifecycleState ?? "reap-candidate",
      reason,
    };
  }

  private quarantineWake(
    agentId: string,
    expectedVersion: number,
    correlationId: string,
    actor: string,
    reason: string,
    _lease: AgentLifecycleLease,
    attempts: number,
  ): WakeResult {
    this.db.clearAgentWakeReservation(agentId);
    const current = this.transitionAdministrative({
      agentId,
      expectedVersion,
      toState: "reap-candidate",
      reason,
      actor,
      correlationId,
    });
    return {
      ok: false,
      agentId,
      correlationId,
      state: current.lifecycleState ?? "reap-candidate",
      reason,
      attempts,
    };
  }
}

/** Convenience: derive whether an agent is a durable hibernation identity. */
export function isDurableHibernationState(agent: AgentInfo): boolean {
  const state = agent.lifecycleState;
  return state === "hibernating" || state === "hibernated" || state === "waking";
}
