import { randomUUID } from "node:crypto";
import type {
  AgentGoal,
  GoalBudget,
  GoalCheckpoint,
  GoalBudgetUpdate,
  GoalContinuation,
  GoalContinuationClaim,
  GoalContinuationKind,
  GoalEvaluation,
  GoalEvaluator,
  GoalEvent,
  GoalEventSink,
  GoalPendingEvaluation,
  GoalProgress,
  GoalRetryPolicy,
  GoalStatus,
  GoalStorage,
  GoalTerminalCandidate,
  GoalTerminalCandidateRecord,
  GoalWakeScheduler,
} from "./domain.js";
import { TimerGoalWakeScheduler } from "./wake-scheduler.js";

const DEFAULT_BUDGET: GoalBudget = {};
const DEFAULT_RETRY_POLICY: GoalRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
};
/**
 * Evaluator calls hit a remote model; rate limits and auth refreshes need seconds, not
 * milliseconds. Waits of 2s, 4s, 8s, 16s, 30s give about a minute of resilience.
 */
export const DEFAULT_EVALUATOR_RETRY_POLICY: GoalRetryPolicy = {
  maxAttempts: 6,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
};
export const EVALUATION_UNAVAILABLE_PREFIX = "Goal evaluation unavailable";

export interface GoalRuntimeOptions {
  defaultBudget?: GoalBudget;
  retryPolicy?: GoalRetryPolicy;
  evaluatorRetryPolicy?: GoalRetryPolicy;
  eventSink?: GoalEventSink;
  claimTtlMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
  /** @deprecated Every settled run is evaluated. Retained for configuration compatibility. */
  evaluationInterval?: number;
  wakeScheduler?: GoalWakeScheduler;
}

export class GoalRuntime {
  private readonly evaluatingScopes = new Set<string>();
  private readonly recoveringScopes = new Set<string>();
  private readonly budget: GoalBudget;
  private readonly retryPolicy: GoalRetryPolicy;
  private readonly evaluatorRetryPolicy: GoalRetryPolicy;
  private readonly eventSink?: GoalEventSink;
  private readonly claimTtlMs: number;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly wakeScheduler: GoalWakeScheduler;
  private closed = false;

  constructor(
    private readonly storage: GoalStorage,
    private readonly evaluator: GoalEvaluator,
    private readonly continuation: GoalContinuation,
    private readonly now: () => Date = () => new Date(),
    options: GoalRuntimeOptions = {},
  ) {
    this.budget = options.defaultBudget ?? DEFAULT_BUDGET;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.evaluatorRetryPolicy =
      options.evaluatorRetryPolicy ?? options.retryPolicy ?? DEFAULT_EVALUATOR_RETRY_POLICY;
    this.eventSink = options.eventSink;
    this.claimTtlMs = options.claimTtlMs ?? 5 * 60_000;
    this.wakeScheduler =
      options.wakeScheduler ?? new TimerGoalWakeScheduler(() => this.now().getTime());
    if (
      options.evaluationInterval !== undefined &&
      (!Number.isInteger(options.evaluationInterval) || options.evaluationInterval < 0)
    ) {
      throw new Error("Goal evaluationInterval must be a non-negative integer");
    }
    this.delay =
      options.delay ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  close(closeStorage = true): void {
    this.closed = true;
    this.wakeScheduler.close();
    if (closeStorage) this.storage.close();
  }

  async get(scopeId: string): Promise<AgentGoal | undefined> {
    return this.storage.get(scopeId);
  }

  async listUnfinished(): Promise<AgentGoal[]> {
    return this.storage.listUnfinished();
  }

  async getContinuationClaim(scopeId: string): Promise<GoalContinuationClaim | undefined> {
    return this.storage.getContinuationClaim(scopeId);
  }

  async getTerminalCandidate(scopeId: string): Promise<GoalTerminalCandidateRecord | undefined> {
    return this.storage.getTerminalCandidate(scopeId);
  }

  async listCheckpoints(scopeId: string): Promise<GoalCheckpoint[]> {
    return this.storage.listCheckpoints(scopeId);
  }

  async create(
    scopeId: string,
    objective: string,
    budget = this.budget,
    name?: string,
  ): Promise<AgentGoal> {
    const trimmedObjective = objective.trim();
    if (!trimmedObjective) throw new Error("Goal objective cannot be empty");
    if (
      budget.maxIterations !== undefined &&
      (!Number.isInteger(budget.maxIterations) || budget.maxIterations <= 0)
    ) {
      throw new Error("Goal maxIterations must be a positive integer");
    }
    if (
      budget.maxIterations !== undefined &&
      this.budget.maxIterations !== undefined &&
      budget.maxIterations > this.budget.maxIterations
    ) {
      throw new Error(
        `Goal maxIterations cannot exceed the configured limit of ${this.budget.maxIterations}`,
      );
    }
    if (
      budget.maxTokens !== undefined &&
      (!Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0)
    ) {
      throw new Error("Goal maxTokens must be a positive finite number");
    }
    if (
      budget.maxTokens !== undefined &&
      this.budget.maxTokens !== undefined &&
      budget.maxTokens > this.budget.maxTokens
    ) {
      throw new Error(
        `Goal maxTokens cannot exceed the configured limit of ${this.budget.maxTokens}`,
      );
    }
    if (
      budget.maxRuntimeMs !== undefined &&
      (!Number.isFinite(budget.maxRuntimeMs) || budget.maxRuntimeMs <= 0)
    ) {
      throw new Error("Goal maxRuntimeMs must be a positive finite number");
    }
    if (
      budget.maxRuntimeMs !== undefined &&
      this.budget.maxRuntimeMs !== undefined &&
      budget.maxRuntimeMs > this.budget.maxRuntimeMs
    ) {
      throw new Error(
        `Goal maxRuntimeMs cannot exceed the configured limit of ${this.budget.maxRuntimeMs}`,
      );
    }
    if (await this.storage.get(scopeId)) {
      throw new Error("This session already has a goal; clear it before creating another");
    }

    const timestamp = this.now().toISOString();
    const goal: AgentGoal = {
      id: randomUUID(),
      scopeId,
      name: name?.trim() || trimmedObjective.slice(0, 72),
      objective: trimmedObjective,
      status: "active",
      budget: { ...budget },
      usage: { iterations: 0, tokens: 0 },
      nextContinuationKind: "started",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.storage.create(goal);
    await this.record({ type: "goal.created", goal });
    return goal;
  }

  async updateBudget(scopeId: string, update: GoalBudgetUpdate): Promise<AgentGoal> {
    const current = await this.requireGoal(scopeId);
    if (current.status === "complete") throw new Error("Cannot change a complete goal budget");
    if (
      update.maxIterations === undefined &&
      update.maxRuntimeMs === undefined &&
      update.maxTokens === undefined &&
      !update.disabled
    ) {
      throw new Error("A goal limit update requires turns, runtime, or off");
    }
    if (
      update.maxIterations !== undefined &&
      (!Number.isInteger(update.maxIterations) || update.maxIterations <= 0)
    ) {
      throw new Error("Goal maxIterations must be a positive integer");
    }
    if (
      update.maxRuntimeMs !== undefined &&
      (!Number.isFinite(update.maxRuntimeMs) || update.maxRuntimeMs <= 0)
    ) {
      throw new Error("Goal maxRuntimeMs must be a positive finite number");
    }
    if (
      update.maxTokens !== undefined &&
      (!Number.isFinite(update.maxTokens) || update.maxTokens <= 0)
    ) {
      throw new Error("Goal maxTokens must be a positive finite number");
    }
    if (
      update.maxIterations !== undefined &&
      this.budget.maxIterations !== undefined &&
      update.maxIterations > this.budget.maxIterations
    ) {
      throw new Error(
        `Goal maxIterations cannot exceed the configured limit of ${this.budget.maxIterations}`,
      );
    }
    if (
      update.maxTokens !== undefined &&
      this.budget.maxTokens !== undefined &&
      update.maxTokens > this.budget.maxTokens
    ) {
      throw new Error(
        `Goal maxTokens cannot exceed the configured limit of ${this.budget.maxTokens}`,
      );
    }
    if (
      update.maxRuntimeMs !== undefined &&
      this.budget.maxRuntimeMs !== undefined &&
      update.maxRuntimeMs > this.budget.maxRuntimeMs
    ) {
      throw new Error(
        `Goal maxRuntimeMs cannot exceed the configured limit of ${this.budget.maxRuntimeMs}`,
      );
    }
    const minimumIterations =
      current.status === "active" ? current.usage.iterations + 1 : current.usage.iterations;
    if (update.maxIterations !== undefined && update.maxIterations < minimumIterations) {
      throw new Error(
        current.status === "active"
          ? `Goal maxIterations must leave capacity for the current turn (${minimumIterations} minimum)`
          : `Goal maxIterations cannot be lower than ${current.usage.iterations} accounted turns`,
      );
    }
    const minimumTokens =
      current.status === "active" ? current.usage.tokens + 1 : current.usage.tokens;
    if (update.maxTokens !== undefined && update.maxTokens < minimumTokens) {
      throw new Error(
        current.status === "active"
          ? `Goal maxTokens must leave capacity beyond ${current.usage.tokens} accounted tokens`
          : `Goal maxTokens cannot be lower than ${current.usage.tokens} accounted tokens`,
      );
    }

    const nextBudget: GoalBudget = update.disabled
      ? {}
      : {
          ...current.budget,
          ...(update.maxIterations === undefined ? {} : { maxIterations: update.maxIterations }),
          ...(update.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: update.maxRuntimeMs }),
          ...(update.maxTokens === undefined ? {} : { maxTokens: update.maxTokens }),
        };
    const candidate: AgentGoal = {
      ...current,
      budget: nextBudget,
      version: current.version + 1,
      updatedAt: this.now().toISOString(),
    };
    const exhausted = this.budgetExhausted(candidate);
    const next =
      current.status === "budget_limited" && !exhausted
        ? { ...candidate, status: "active" as const, blockedReason: undefined }
        : candidate;
    if (!(await this.storage.updateBudget(next, current.version))) {
      throw new Error("Goal changed while its budget was being updated; retry the command");
    }
    await this.record({ type: "goal.budget_changed", goal: next, previousBudget: current.budget });
    if (current.status === "budget_limited" && next.status === "active") {
      await this.continueWithClaim(next, "Continue with the expanded goal budget.");
    }
    return next;
  }

  async updateDetails(
    scopeId: string,
    update: { name?: string; objective?: string },
  ): Promise<AgentGoal> {
    const current = await this.requireGoal(scopeId);
    if (current.status === "complete") throw new Error("Cannot edit a closed goal");
    const name = update.name?.trim();
    const objective = update.objective?.trim();
    if (update.name !== undefined && !name) throw new Error("Goal name cannot be empty");
    if (update.objective !== undefined && !objective)
      throw new Error("Goal objective cannot be empty");
    if (name === undefined && objective === undefined)
      throw new Error("A goal update requires name or objective");
    const objectiveChanged = objective !== undefined && objective !== current.objective;
    const next: AgentGoal = {
      ...current,
      ...(name === undefined ? {} : { name }),
      ...(objective === undefined ? {} : { objective }),
      ...(objectiveChanged ? { nextContinuationKind: "updated" as const } : {}),
      version: current.version + 1,
      updatedAt: this.now().toISOString(),
    };
    if (!(await this.storage.updateBudget(next, current.version))) {
      throw new Error("Goal changed while it was being edited; retry the command");
    }
    await this.record({ type: "goal.updated", goal: next });
    if (objectiveChanged) {
      const claim = await this.storage.getContinuationClaim(scopeId);
      if (claim) await this.storage.deleteContinuationClaim(scopeId, claim.claimId);
      const latest = await this.storage.get(scopeId);
      if (latest?.id === next.id && latest.status === "active") {
        await this.continueWithClaim(latest, "Begin work on the updated objective.");
      }
    } else if (await this.storage.getPendingEvaluation(scopeId)) {
      await this.processPendingEvaluation(scopeId);
    }
    return (await this.storage.get(scopeId)) ?? next;
  }

  async addCheckpoint(
    scopeId: string,
    input: { summary: string; evidence?: string; nextStep?: string; blocker?: string },
  ): Promise<GoalCheckpoint> {
    const goal = await this.requireGoal(scopeId);
    if (goal.status === "complete") throw new Error("Cannot checkpoint a closed goal");
    const summary = input.summary.trim();
    if (!summary) throw new Error("A checkpoint summary is required");
    const checkpoint: GoalCheckpoint = {
      id: randomUUID(),
      scopeId,
      goalId: goal.id,
      summary,
      evidence: input.evidence?.trim() || undefined,
      nextStep: input.nextStep?.trim() || undefined,
      blocker: input.blocker?.trim() || undefined,
      createdAt: this.now().toISOString(),
    };
    if (!(await this.storage.addCheckpoint(checkpoint))) {
      throw new Error("Goal changed while its checkpoint was being recorded; retry");
    }
    await this.record({ type: "goal.checkpoint_added", goal, checkpoint });
    return checkpoint;
  }

  async snooze(scopeId: string, durationMs: number): Promise<AgentGoal> {
    if (!Number.isFinite(durationMs) || durationMs <= 0)
      throw new Error("Goal snooze duration must be positive");
    const current = await this.requireGoal(scopeId);
    if (current.status === "complete") throw new Error("Cannot snooze a closed goal");
    const snoozedUntil = new Date(this.now().getTime() + durationMs).toISOString();
    const next: AgentGoal = {
      ...current,
      status: "active",
      blockedReason: undefined,
      snoozedUntil,
      version: current.version + 1,
      updatedAt: this.now().toISOString(),
    };
    if (!(await this.storage.updateBudget(next, current.version))) {
      throw new Error("Goal changed while it was being snoozed; retry the command");
    }
    const claim = await this.storage.getContinuationClaim(scopeId);
    if (claim) await this.storage.deleteContinuationClaim(scopeId, claim.claimId);
    this.scheduleRecovery(scopeId, snoozedUntil);
    await this.record({ type: "goal.snoozed", goal: next, snoozedUntil });
    return next;
  }

  async closeGoal(scopeId: string): Promise<AgentGoal> {
    const current = await this.requireGoal(scopeId);
    if (current.status === "complete") return current;
    return this.setStatus(scopeId, "complete");
  }

  async setStatus(
    scopeId: string,
    status: Extract<GoalStatus, "active" | "paused" | "complete">,
  ): Promise<AgentGoal> {
    const current = await this.requireGoal(scopeId);
    const transitionAllowed =
      (status === "active" && (current.status === "paused" || current.status === "blocked")) ||
      (status === "paused" && current.status === "active") ||
      (status === "complete" && current.status !== "complete");
    if (!transitionAllowed) throw new Error(`Cannot change a ${current.status} goal to ${status}`);
    const next: AgentGoal = {
      ...current,
      status,
      blockedReason: undefined,
      snoozedUntil: undefined,
      version: current.version + 1,
      updatedAt: this.now().toISOString(),
    };
    if (!(await this.storage.replace(next, current.version))) {
      throw new Error("Goal changed while its status was being updated; retry the command");
    }
    const pending = await this.storage.getPendingEvaluation(scopeId);
    if (pending) await this.storage.deletePendingEvaluation(scopeId, pending.evaluationId);
    const candidate = await this.storage.getTerminalCandidate(scopeId);
    if (candidate) await this.storage.deleteTerminalCandidate(scopeId, candidate.candidateId);
    const claim = await this.storage.getContinuationClaim(scopeId);
    if (claim) await this.storage.deleteContinuationClaim(scopeId, claim.claimId);
    this.wakeScheduler.cancel(scopeId);
    await this.record({ type: "goal.status_changed", goal: next, previousStatus: current.status });
    return next;
  }

  async clear(scopeId: string): Promise<boolean> {
    const current = await this.storage.get(scopeId);
    if (!current) return false;
    const result = await this.storage.delete(scopeId, current.id, current.version);
    if (result === "missing") return false;
    if (result === "conflict") {
      throw new Error("Goal changed while it was being cleared; retry the command");
    }
    this.wakeScheduler.cancel(scopeId);
    await this.record({ type: "goal.cleared", goal: current });
    return true;
  }

  async requestTerminalCandidate(
    scopeId: string,
    candidate: GoalTerminalCandidate,
  ): Promise<GoalTerminalCandidateRecord> {
    const goal = await this.requireGoal(scopeId);
    if (goal.status !== "active") {
      throw new Error(`Cannot request a terminal decision for a ${goal.status} goal`);
    }
    const reason = candidate.reason.trim();
    if (!reason) throw new Error("A terminal goal candidate requires a concrete reason");
    const record: GoalTerminalCandidateRecord = {
      ...candidate,
      reason,
      scopeId,
      goalId: goal.id,
      goalVersion: goal.version,
      candidateId: randomUUID(),
      createdAt: this.now().toISOString(),
    };
    if (!(await this.storage.putTerminalCandidate(record))) {
      throw new Error("Goal changed while its terminal candidate was being recorded; retry");
    }
    await this.record({ type: "goal.terminal_candidate_requested", goal, candidate: record });
    return record;
  }

  async start(
    scopeId: string,
    reason = "Begin working toward the new goal.",
    kind: GoalContinuationKind = "continuation",
  ): Promise<void> {
    const goal = await this.requireGoal(scopeId);
    if (goal.status !== "active") throw new Error(`Cannot start a ${goal.status} goal`);
    if (this.budgetExhausted(goal)) {
      await this.markBudgetLimited(goal);
      return;
    }
    await this.continueWithClaim(goal, reason, kind);
  }

  async acknowledgeContinuation(scopeId: string): Promise<void> {
    const claim = await this.storage.getContinuationClaim(scopeId);
    if (claim && (await this.storage.acknowledgeContinuationClaim(scopeId, claim.claimId))) {
      this.wakeScheduler.cancel(scopeId);
    }
  }

  async recover(scopeId: string): Promise<void> {
    if (this.closed || this.recoveringScopes.has(scopeId)) return;
    this.recoveringScopes.add(scopeId);
    try {
      if (await this.storage.getPendingEvaluation(scopeId))
        await this.processPendingEvaluation(scopeId);
      let goal = await this.storage.get(scopeId);
      if (!goal || goal.status !== "active") return;
      if (goal.snoozedUntil) {
        if (Date.parse(goal.snoozedUntil) > this.now().getTime()) {
          this.scheduleRecovery(scopeId, goal.snoozedUntil);
          return;
        }
        const awakened: AgentGoal = {
          ...goal,
          snoozedUntil: undefined,
          version: goal.version + 1,
          updatedAt: this.now().toISOString(),
        };
        if (!(await this.storage.updateBudget(awakened, goal.version))) return;
        goal = awakened;
        await this.record({ type: "goal.snooze_expired", goal });
      }
      if (this.budgetExhausted(goal)) {
        await this.markBudgetLimited(goal);
        return;
      }
      let claim = await this.storage.getContinuationClaim(scopeId);
      const now = this.now().getTime();
      if (claim && (claim.goalId !== goal.id || claim.goalVersion !== goal.version)) {
        await this.storage.deleteContinuationClaim(scopeId, claim.claimId);
        claim = undefined;
      }
      if (claim) {
        const claimIsLive = Date.parse(claim.expiresAt) > now;
        if (claimIsLive && claim.state === "started") {
          this.scheduleRecovery(scopeId, claim.expiresAt);
          return;
        }
        if (claimIsLive && claim.state === "deferred" && Date.parse(claim.availableAt) > now) {
          this.scheduleRecovery(scopeId, claim.availableAt);
          return;
        }
        await this.record({ type: "goal.recovered", goal });
        await this.runContinuationClaim(goal, claim);
        return;
      }
      await this.record({ type: "goal.recovered", goal });
      await this.continueWithClaim(goal, "Resume the persisted active goal.");
    } finally {
      this.recoveringScopes.delete(scopeId);
    }
  }

  async settle(
    scopeId: string,
    progress: GoalProgress,
    options: { accountUsage?: boolean } = {},
  ): Promise<void> {
    const settlementId = randomUUID();
    const ownsEvaluation = !this.evaluatingScopes.has(scopeId);
    if (ownsEvaluation) this.evaluatingScopes.add(scopeId);
    try {
      const goal = await this.storage.get(scopeId);
      if (!goal || goal.status !== "active") return;
      await this.acknowledgeContinuation(scopeId);
      let durableCandidate = await this.storage.getTerminalCandidate(scopeId);
      if (
        durableCandidate &&
        (durableCandidate.goalId !== goal.id || durableCandidate.goalVersion !== goal.version)
      ) {
        await this.storage.deleteTerminalCandidate(scopeId, durableCandidate.candidateId);
        durableCandidate = undefined;
      }
      const timestamp = this.now().toISOString();
      const pending: GoalPendingEvaluation = {
        scopeId,
        goalId: goal.id,
        goalVersion: goal.version,
        evaluationId: settlementId,
        iterationsDelta: options.accountUsage === false ? 0 : 1,
        progress: {
          ...progress,
          tokenDelta: options.accountUsage === false ? 0 : Math.max(0, progress.tokenDelta ?? 0),
          terminalCandidate:
            progress.terminalCandidate ??
            (durableCandidate
              ? { outcome: durableCandidate.outcome, reason: durableCandidate.reason }
              : undefined),
        },
        attempt: 0,
        availableAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (!(await this.storage.appendPendingEvaluation(pending))) return;
      if (durableCandidate) {
        await this.storage.deleteTerminalCandidate(scopeId, durableCandidate.candidateId);
      }
      if (!ownsEvaluation) return;
      await this.processPendingEvaluation(scopeId, true);
    } finally {
      if (ownsEvaluation) {
        this.evaluatingScopes.delete(scopeId);
        if (!this.closed && (await this.storage.getPendingEvaluation(scopeId))) {
          await this.processPendingEvaluation(scopeId);
        }
      }
    }
  }

  private async processPendingEvaluation(scopeId: string, ownsEvaluation = false): Promise<void> {
    if (!ownsEvaluation) {
      if (this.evaluatingScopes.has(scopeId)) return;
      this.evaluatingScopes.add(scopeId);
    }
    try {
      while (true) {
        const pending = await this.storage.getPendingEvaluation(scopeId);
        if (!pending) return;
        const goal = await this.storage.get(scopeId);
        if (!goal || goal.status !== "active") {
          await this.storage.deletePendingEvaluation(scopeId, pending.evaluationId);
          return;
        }
        if (goal.lastEvaluation?.id === pending.evaluationId) {
          await this.storage.deletePendingEvaluation(scopeId, pending.evaluationId);
          if (goal.lastEvaluation.outcome === "continue" && !this.budgetExhausted(goal)) {
            await this.continueWithClaim(goal, goal.lastEvaluation.reason);
          }
          continue;
        }
        if (goal.id !== pending.goalId || goal.version !== pending.goalVersion) {
          await this.storage.deletePendingEvaluation(scopeId, pending.evaluationId);
          continue;
        }
        const waitMs = Date.parse(pending.availableAt) - this.now().getTime();
        if (waitMs > 0) await this.delay(waitMs);

        const accountedUsage = {
          iterations: goal.usage.iterations + pending.iterationsDelta,
          tokens: goal.usage.tokens + (pending.progress.tokenDelta ?? 0),
        };
        const projectedGoal: AgentGoal = { ...goal, usage: accountedUsage };
        let evaluation: GoalEvaluation;
        try {
          evaluation = await this.evaluator.evaluate(projectedGoal, pending.progress);
        } catch (error) {
          if (this.closed) return;
          const latestPending = await this.storage.getPendingEvaluation(scopeId);
          if (!latestPending || latestPending.evaluationId !== pending.evaluationId) continue;
          const failure = error instanceof Error ? error : new Error(String(error));
          const attempt = pending.attempt + 1;
          if (attempt >= this.evaluatorRetryPolicy.maxAttempts) {
            // The evaluator, not the objective, failed. Never report that as a blocked goal:
            // keep working and re-evaluate on the next settle. Only pause once evaluation has
            // been unavailable for consecutive settlements, so a dead evaluator cannot drive
            // an unbounded unevaluated loop.
            const unavailableAt = this.now().toISOString();
            const reason = `${EVALUATION_UNAVAILABLE_PREFIX} after ${attempt} attempts: ${failure.message}`;
            const previouslyUnavailable =
              goal.lastEvaluation?.reason.startsWith(EVALUATION_UNAVAILABLE_PREFIX) ?? false;
            const unevaluated: AgentGoal = {
              ...goal,
              status: "active",
              blockedReason: undefined,
              usage: accountedUsage,
              lastSettledAt: unavailableAt,
              lastEvaluation: {
                id: pending.evaluationId,
                outcome: "continue",
                reason,
                at: unavailableAt,
              },
              version: goal.version + 1,
              updatedAt: unavailableAt,
            };
            // User-configured ceilings hold regardless of whether the evaluator answered.
            const next: AgentGoal = this.budgetExhausted(unevaluated)
              ? {
                  ...unevaluated,
                  status: "budget_limited",
                  blockedReason: "Goal continuation budget exhausted",
                }
              : previouslyUnavailable
                ? {
                    ...unevaluated,
                    status: "paused",
                    blockedReason: `${reason}. Paused after consecutive unavailable evaluations; resume when the model is reachable.`,
                  }
                : unevaluated;
            if (!(await this.storage.commitEvaluation(next, goal.version, pending.evaluationId))) {
              continue;
            }
            await this.record({
              type: "goal.progress_accounted",
              goal: next,
              tokenDelta: pending.progress.tokenDelta ?? 0,
            });
            await this.record({
              type: "goal.retry_exhausted",
              scopeId,
              goalId: goal.id,
              operation: "evaluator",
              attempt,
              error: failure.message,
            });
            if (next.status === "active") {
              await this.continueWithClaim(
                next,
                `${reason}. Continue from the latest checkpoint; the next settle re-evaluates.`,
              );
              continue;
            }
            await this.record({
              type: "goal.status_changed",
              goal: next,
              previousStatus: goal.status,
            });
            return;
          }
          const retryAt = new Date(
            this.now().getTime() + this.retryDelay(attempt, this.evaluatorRetryPolicy),
          ).toISOString();
          const retry: GoalPendingEvaluation = {
            ...pending,
            attempt,
            availableAt: retryAt,
            lastError: failure.message,
            updatedAt: this.now().toISOString(),
          };
          if (!(await this.storage.replacePendingEvaluation(retry, pending.evaluationId))) {
            continue;
          }
          await this.record({
            type: "goal.retry_scheduled",
            scopeId,
            goalId: goal.id,
            operation: "evaluator",
            attempt,
            availableAt: retryAt,
            error: failure.message,
          });
          continue;
        }

        if (this.closed) return;
        const latestPending = await this.storage.getPendingEvaluation(scopeId);
        if (!latestPending || latestPending.evaluationId !== pending.evaluationId) continue;
        const evaluatedAt = this.now().toISOString();
        const evaluated: AgentGoal = {
          ...goal,
          status: evaluation.outcome === "continue" ? "active" : evaluation.outcome,
          blockedReason: evaluation.outcome === "blocked" ? evaluation.reason : undefined,
          usage: accountedUsage,
          lastSettledAt: evaluatedAt,
          lastEvaluation: { id: pending.evaluationId, ...evaluation, at: evaluatedAt },
          version: goal.version + 1,
          updatedAt: evaluatedAt,
        };
        const next =
          evaluation.outcome === "continue" && this.budgetExhausted(evaluated)
            ? {
                ...evaluated,
                status: "budget_limited" as const,
                blockedReason: "Goal continuation budget exhausted",
              }
            : evaluated;
        if (!(await this.storage.commitEvaluation(next, goal.version, pending.evaluationId))) {
          continue;
        }
        await this.record({
          type: "goal.progress_accounted",
          goal: next,
          tokenDelta: pending.progress.tokenDelta ?? 0,
        });
        await this.record({ type: "goal.evaluated", goal: next, evaluation });
        if (
          next.status === "active" &&
          evaluation.outcome === "continue" &&
          pending.progress.terminalCandidate === undefined
        ) {
          await this.record({ type: "goal.auto_continued", goal: next });
        }
        if (next.status === "active") {
          await this.continueWithClaim(next, evaluation.reason);
        } else
          await this.record({
            type: "goal.status_changed",
            goal: next,
            previousStatus: goal.status,
          });
      }
    } finally {
      if (!ownsEvaluation) {
        this.evaluatingScopes.delete(scopeId);
        if (!this.closed && (await this.storage.getPendingEvaluation(scopeId))) {
          await this.processPendingEvaluation(scopeId);
        }
      }
    }
  }

  private async continueWithClaim(
    goal: AgentGoal,
    reason: string,
    kind: GoalContinuationKind = "continuation",
  ): Promise<void> {
    if (goal.snoozedUntil && Date.parse(goal.snoozedUntil) > this.now().getTime()) {
      this.scheduleRecovery(goal.scopeId, goal.snoozedUntil);
      return;
    }
    const lifecycleKind = goal.nextContinuationKind ?? kind;
    const existingClaim = await this.storage.getContinuationClaim(goal.scopeId);
    if (existingClaim) {
      if (
        existingClaim.goalId === goal.id &&
        existingClaim.goalVersion === goal.version &&
        existingClaim.kind === lifecycleKind
      ) {
        return;
      }
      await this.storage.deleteContinuationClaim(goal.scopeId, existingClaim.claimId);
    }
    const timestamp = this.now().toISOString();
    const claim: GoalContinuationClaim = {
      scopeId: goal.scopeId,
      goalId: goal.id,
      goalVersion: goal.version,
      claimId: randomUUID(),
      state: "claimed",
      kind: lifecycleKind,
      reason,
      attempt: 0,
      availableAt: timestamp,
      expiresAt: new Date(this.now().getTime() + this.claimTtlMs).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!(await this.storage.createContinuationClaim(claim))) return;
    await this.record({ type: "goal.continuation_claimed", goal, claim });
    await this.runContinuationClaim(goal, claim);
  }

  private async runContinuationClaim(goal: AgentGoal, claim: GoalContinuationClaim): Promise<void> {
    for (let attempt = claim.attempt + 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      const currentGoal = await this.storage.get(goal.scopeId);
      const currentClaim = await this.storage.getContinuationClaim(goal.scopeId);
      if (
        currentGoal?.id === goal.id &&
        currentGoal.status === "active" &&
        currentGoal.version !== goal.version &&
        currentClaim?.claimId === claim.claimId
      ) {
        if (currentClaim.state === "started") {
          this.scheduleRecovery(goal.scopeId, currentClaim.expiresAt);
        } else if (
          currentClaim.state === "deferred" &&
          Date.parse(currentClaim.availableAt) > this.now().getTime()
        ) {
          this.scheduleRecovery(goal.scopeId, currentClaim.availableAt);
        } else {
          await this.runContinuationClaim(currentGoal, currentClaim);
        }
        return;
      }
      if (
        !currentGoal ||
        currentGoal.id !== goal.id ||
        currentGoal.version !== goal.version ||
        currentGoal.status !== "active" ||
        currentClaim?.claimId !== claim.claimId
      ) {
        if (currentClaim?.claimId === claim.claimId) {
          await this.storage.deleteContinuationClaim(goal.scopeId, claim.claimId);
        }
        return;
      }
      const waitMs = Date.parse(claim.availableAt) - this.now().getTime();
      if (waitMs > 0) await this.delay(waitMs);
      let result;
      try {
        result = await this.continuation.continueIfIdle(goal, {
          claimId: claim.claimId,
          kind: claim.kind,
          idempotencyKey: `${goal.id}:${goal.version}`,
          expectedGoalVersion: goal.version,
          reason: claim.reason,
        });
      } catch (error) {
        result = {
          status: "unavailable" as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (this.closed) return;
      if (result.status === "started") {
        claim.attempt = attempt;
        claim.state = "started";
        claim.lastError = undefined;
        claim.updatedAt = this.now().toISOString();
        if (!(await this.storage.replaceContinuationClaim(claim, claim.claimId))) return;
        this.scheduleRecovery(goal.scopeId, claim.expiresAt);
        await this.record({ type: "goal.continuation_started", goal, claim });
        return;
      }
      const retryDelay = result.retryAfterMs ?? this.retryDelay(attempt);
      claim.state = "deferred";
      claim.lastError = result.reason;
      claim.availableAt = new Date(this.now().getTime() + retryDelay).toISOString();
      claim.updatedAt = this.now().toISOString();
      if (result.status === "busy") {
        if (!(await this.storage.replaceContinuationClaim(claim, claim.claimId))) return;
        this.scheduleRecovery(goal.scopeId, claim.availableAt);
        await this.record({ type: "goal.continuation_deferred", goal, claim });
        return;
      }
      claim.attempt = attempt;
      if (!(await this.storage.replaceContinuationClaim(claim, claim.claimId))) return;
      if (attempt < this.retryPolicy.maxAttempts) {
        await this.record({
          type: "goal.retry_scheduled",
          scopeId: goal.scopeId,
          goalId: goal.id,
          operation: "continuation",
          attempt,
          availableAt: claim.availableAt,
          error: result.reason,
          claimId: claim.claimId,
        });
        await this.delay(retryDelay);
        claim.state = "claimed";
        claim.updatedAt = this.now().toISOString();
        if (!(await this.storage.replaceContinuationClaim(claim, claim.claimId))) return;
      }
    }
    await this.blockAfterRetryExhaustion(
      goal,
      "continuation",
      new Error(claim.lastError ?? "Continuation unavailable"),
      claim.attempt,
      claim.claimId,
    );
  }

  private async blockAfterRetryExhaustion(
    goal: AgentGoal,
    operation: "evaluator" | "continuation",
    error: Error,
    attempt: number,
    claimId: string | undefined,
  ): Promise<void> {
    const current = await this.storage.get(goal.scopeId);
    if (
      !current ||
      current.id !== goal.id ||
      current.version !== goal.version ||
      current.status !== "active"
    ) {
      return;
    }
    if (claimId) {
      const claim = await this.storage.getContinuationClaim(goal.scopeId);
      if (claim?.claimId !== claimId) return;
    }
    const next: AgentGoal = {
      ...current,
      status: "blocked",
      blockedReason: `${operation} failed after ${attempt} attempts: ${error.message}`,
      version: current.version + 1,
      updatedAt: this.now().toISOString(),
    };
    if (!(await this.storage.replace(next, current.version))) return;
    if (claimId) await this.storage.deleteContinuationClaim(goal.scopeId, claimId);
    this.wakeScheduler.cancel(goal.scopeId);
    await this.record({
      type: "goal.retry_exhausted",
      scopeId: goal.scopeId,
      goalId: goal.id,
      operation,
      attempt,
      error: error.message,
      claimId,
    });
    await this.record({ type: "goal.status_changed", goal: next, previousStatus: current.status });
  }

  private budgetExhausted(goal: AgentGoal): boolean {
    return (
      (goal.budget.maxIterations !== undefined &&
        goal.usage.iterations >= goal.budget.maxIterations) ||
      (goal.budget.maxTokens !== undefined && goal.usage.tokens >= goal.budget.maxTokens) ||
      (goal.budget.maxRuntimeMs !== undefined &&
        this.now().getTime() - Date.parse(goal.createdAt) >= goal.budget.maxRuntimeMs)
    );
  }

  private async markBudgetLimited(goal: AgentGoal): Promise<void> {
    const next: AgentGoal = {
      ...goal,
      status: "budget_limited",
      blockedReason: "Goal continuation budget exhausted",
      version: goal.version + 1,
      updatedAt: this.now().toISOString(),
    };
    if (await this.storage.replace(next, goal.version)) {
      this.wakeScheduler.cancel(goal.scopeId);
      await this.record({ type: "goal.status_changed", goal: next, previousStatus: goal.status });
    }
  }

  private scheduleRecovery(scopeId: string, wakeAt: string): void {
    if (this.closed) return;
    this.wakeScheduler.schedule(scopeId, wakeAt, () => {
      void this.recover(scopeId).catch((error) =>
        this.record({
          type: "goal.error",
          operation: "scheduled recovery",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  private retryDelay(attempt: number, policy: GoalRetryPolicy = this.retryPolicy): number {
    return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  }

  private async record(event: GoalEvent): Promise<void> {
    try {
      await this.eventSink?.record(event);
    } catch {
      // Event sinks are observational and must not own goal lifecycle progress.
    }
  }

  private async requireGoal(scopeId: string): Promise<AgentGoal> {
    const goal = await this.storage.get(scopeId);
    if (!goal) throw new Error("This session has no goal");
    return goal;
  }
}
