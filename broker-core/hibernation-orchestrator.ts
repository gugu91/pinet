import * as crypto from "node:crypto";
import type { BrokerDB } from "./schema.js";
import { evaluateHibernateEligibility } from "./lifecycle.js";
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
  correlationId: string;
  spec: AgentRuntimeSpec;
}

/** Controls the dormant Pi runtime process (never tmux itself). */
export interface HibernationProcessController {
  /** Ask the follower to flush a checkpoint and confirm hibernate safety. */
  requestCheckpoint(spec: AgentRuntimeSpec): Promise<HibernationCheckpointOutcome>;
  /** Gracefully stop the Pi runtime (TERM then bounded KILL). */
  stopRuntime(spec: AgentRuntimeSpec): Promise<{ stopped: boolean; rssBytes: number | null }>;
  /** True while the recorded Pi PID/process generation is still alive. */
  isRuntimeAlive(spec: AgentRuntimeSpec): Promise<boolean>;
}

/** Reads/writes the attachable tmux shell that outlives the Pi runtime. */
export interface HibernationTmuxController {
  /** True if the recorded tmux session/pane still exists (operator-attachable). */
  isSessionAttachable(spec: AgentRuntimeSpec): Promise<boolean>;
  /**
   * Launch exactly one replacement runtime into the recorded pane. The launched
   * runtime is expected to register presenting the reservation fence. Resolves
   * once the launch command has been issued (registration is confirmed
   * separately via {@link BrokerDB.acceptRuntimeGeneration}).
   */
  respawnRuntime(ctx: RuntimeLaunchContext): Promise<{ launched: boolean }>;
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
    const reason = opts.reason ?? "prepare_hibernation";
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
    const reason = opts.reason ?? "manual";
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
        reason: checkpoint.reason,
        sessionResumeRef: checkpoint.sessionResumeRef,
        pendingInboxCount: checkpoint.pendingInboxCount,
        rssBytes: checkpoint.rssBytes,
      });

      // New work or an unsafe runtime must abort hibernation back to a safe
      // live/active state — never exit the process.
      const freshInbox = this.db.getUnreadInboxCount(agentId);
      if (!checkpoint.hibernateSafe || freshInbox > 0 || checkpoint.pendingInboxCount > 0) {
        const abortReason = !checkpoint.hibernateSafe
          ? `checkpoint_unsafe:${checkpoint.reason ?? "unconfirmed"}`
          : "work_arrived_during_checkpoint";
        const active = this.transitionFenced(lease, {
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
          // back to active rather than quarantine.
          const active = this.transitionFenced(lease, {
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
    const reason = opts.reason ?? "manual";
    const startedAt = this.now();

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
          correlationId,
          spec,
        };

        const launch = await this.tmux.respawnRuntime(launchCtx);
        const registered = launch.launched ? await this.awaitRuntimeRegistration(launchCtx) : false;
        const refreshed = this.db.getAgentById(agentId);
        const accepted =
          registered && refreshed?.runtimeGeneration === reservation.reservedGeneration;

        if (accepted) {
          const durationMs = this.now() - startedAt;
          const live = this.transitionFenced(lease, {
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
        }

        // Failed attempt: clear this reservation so a stale runtime cannot later
        // claim it, and record the retry.
        this.db.clearAgentWakeReservation(agentId);
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
      // Fail-closed: an unexpected adapter/DB fault (e.g. respawn/registration
      // rejection) must not strand the agent in `waking`. Any partially
      // launched runtime's liveness is unknown → clear the reservation and
      // quarantine for manual review. Static reason; never surface raw errors.
      try {
        return this.quarantineWake(
          agentId,
          versionCursor,
          correlationId,
          actor,
          "wake_fault",
          lease,
          0,
        );
      } catch {
        return {
          ok: false,
          agentId,
          correlationId,
          state: this.db.getAgentById(agentId)?.lifecycleState ?? "waking",
          reason: "wake_fault",
        };
      }
    } finally {
      this.db.releaseAgentLifecycleLease(agentId, lease.leaseId, lease.fenceToken);
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
   * Agents whose lifecycle lease is still held (unexpired) are skipped: another
   * broker/thread may still be driving them.
   */
  recoverStrandedWakes(opts: { now?: number } = {}): StrandedWakeRecovery[] {
    const now = opts.now ?? this.now();
    const recovered: StrandedWakeRecovery[] = [];
    for (const agent of this.db.getAllAgents()) {
      const strandedState = agent.lifecycleState;
      if (strandedState !== "waking" && strandedState !== "hibernating") continue;
      const lease = this.db.getAgentLifecycleLease(agent.id);
      const leaseHeld = lease !== null && Date.parse(lease.expiresAt) > now;
      if (leaseHeld) continue;

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
        // queue row must never be stranded: cancel it and continue draining.
        this.db.completeWakeQueueEntry(claimed.id, "cancelled");
        results.push({
          ok: false,
          agentId: claimed.agentId,
          correlationId: claimed.correlationId,
          state: this.db.getAgentById(claimed.agentId)?.lifecycleState ?? "waking",
          reason: "wake_fault",
        });
        continue;
      }
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

  private quarantine(
    agentId: string,
    expectedVersion: number,
    correlationId: string,
    actor: string,
    reason: string,
    lease: AgentLifecycleLease,
  ): HibernateResult {
    const current = this.transitionFenced(lease, {
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
    lease: AgentLifecycleLease,
    attempts: number,
  ): WakeResult {
    this.db.clearAgentWakeReservation(agentId);
    const current = this.transitionFenced(lease, {
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
