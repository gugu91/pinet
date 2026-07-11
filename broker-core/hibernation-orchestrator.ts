import * as crypto from "node:crypto";
import type { BrokerDB } from "./schema.js";
import { evaluateHibernateEligibility } from "./lifecycle.js";
import type {
  AgentInfo,
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

    try {
      // idle -> hibernating (fenced CAS)
      let current = this.db.transitionAgentLifecycle({
        agentId,
        expectedVersion: agent.lifecycleVersion ?? 0,
        toState: "hibernating",
        reason,
        actor,
        correlationId,
        triggerSource: opts.trigger,
        fenceToken: lease.fenceToken,
      });

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
        current = this.db.transitionAgentLifecycle({
          agentId,
          expectedVersion: current.lifecycleVersion ?? 0,
          toState: "active",
          reason: abortReason,
          actor,
          correlationId,
          fenceToken: lease.fenceToken,
        });
        return {
          ok: false,
          agentId,
          correlationId,
          state: current.lifecycleState ?? "active",
          reason: abortReason,
        };
      }

      // Graceful teardown.
      const stop = await this.process.stopRuntime(spec);
      const stillAlive = await this.process.isRuntimeAlive(spec);
      if (!stop.stopped || stillAlive) {
        return this.quarantine(
          agentId,
          current.lifecycleVersion ?? 0,
          correlationId,
          actor,
          "runtime_survived_stop",
          lease.fenceToken,
        );
      }

      const attachable = await this.tmux.isSessionAttachable(spec);
      if (!attachable) {
        return this.quarantine(
          agentId,
          current.lifecycleVersion ?? 0,
          correlationId,
          actor,
          "tmux_session_missing",
          lease.fenceToken,
        );
      }

      // hibernating -> hibernated.
      const durationMs = this.now() - startedAt;
      current = this.db.transitionAgentLifecycle({
        agentId,
        expectedVersion: current.lifecycleVersion ?? 0,
        toState: "hibernated",
        reason,
        actor,
        correlationId,
        fenceToken: lease.fenceToken,
        durationMs,
        rssBytesBefore: checkpoint.rssBytes,
        rssBytesAfter: stop.rssBytes,
      });
      return {
        ok: true,
        agentId,
        correlationId,
        state: current.lifecycleState ?? "hibernated",
        reason: "hibernated",
        rssBytesBefore: checkpoint.rssBytes,
        rssBytesAfter: stop.rssBytes,
        durationMs,
      };
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
      // Another broker/thread is already waking this agent. That is the single
      // winner; this trigger is satisfied by the in-flight wake.
      return this.refuseWake(agentId, correlationId, "hibernated", "wake_in_progress", actor);
    }

    let versionCursor = agent.lifecycleVersion ?? 0;
    try {
      // hibernated -> waking (fenced CAS).
      const waking = this.db.transitionAgentLifecycle({
        agentId,
        expectedVersion: versionCursor,
        toState: "waking",
        reason,
        actor,
        correlationId,
        triggerSource: opts.trigger,
        fenceToken: lease.fenceToken,
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
          const live = this.db.transitionAgentLifecycle({
            agentId,
            expectedVersion: versionCursor,
            toState: "live",
            reason,
            actor,
            correlationId,
            fenceToken: lease.fenceToken,
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
        lease.fenceToken,
        maxAttempts,
      );
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
    const acceptance = this.db.acceptRuntimeGeneration(input);
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
    for (;;) {
      const globalInflight = this.db.countInflightWakes();
      if (globalInflight >= this.config.maxConcurrentWakes) break;
      const next = this.selectNextDispatchableWake();
      if (!next) break;
      const claimed = this.db.markWakeDispatching(next.id);
      if (!claimed) continue;
      const result = await this.wake(claimed.agentId, {
        trigger: claimed.triggerKind,
        reason: claimed.reason,
        correlationId: claimed.correlationId,
      });
      if (!result.ok && result.reason === "wake_in_progress") {
        // Another lease owner is handling it; leave the queue entry consumed.
        this.db.completeWakeQueueEntry(claimed.id, "done");
      } else {
        this.db.completeWakeQueueEntry(claimed.id, result.ok ? "done" : "cancelled");
      }
      results.push(result);
    }
    return results;
  }

  private selectNextDispatchableWake() {
    const queued = this.db.listWakeQueue("queued");
    for (const entry of queued) {
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

  private quarantine(
    agentId: string,
    expectedVersion: number,
    correlationId: string,
    actor: string,
    reason: string,
    fenceToken: number,
  ): HibernateResult {
    const current = this.db.transitionAgentLifecycle({
      agentId,
      expectedVersion,
      toState: "reap-candidate",
      reason,
      actor,
      correlationId,
      fenceToken,
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
    fenceToken: number,
    attempts: number,
  ): WakeResult {
    this.db.clearAgentWakeReservation(agentId);
    const current = this.db.transitionAgentLifecycle({
      agentId,
      expectedVersion,
      toState: "reap-candidate",
      reason,
      actor,
      correlationId,
      fenceToken,
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
