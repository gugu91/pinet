import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentGoal,
  GoalCheckpoint,
  GoalContinuationClaim,
  GoalDeleteResult,
  GoalEvaluation,
  GoalPendingEvaluation,
  GoalStatus,
  GoalStorage,
  GoalTerminalCandidateRecord,
} from "./domain.js";

interface GoalRow {
  id: string;
  scope_id: string;
  name: string | null;
  objective: string;
  status: GoalStatus;
  blocked_reason: string | null;
  snoozed_until: string | null;
  max_iterations: number;
  max_tokens: number | null;
  max_runtime_ms: number | null;
  iterations_used: number;
  tokens_used: number;
  last_settled_at: string | null;
  last_evaluation_id: string | null;
  last_evaluation_outcome: GoalEvaluation["outcome"] | null;
  last_evaluation_reason: string | null;
  last_evaluation_at: string | null;
  next_continuation_kind: Extract<GoalContinuationClaim["kind"], "started" | "updated"> | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface PendingEvaluationRow {
  scope_id: string;
  goal_id: string;
  goal_version: number;
  evaluation_id: string;
  iterations_delta: number;
  latest_output: string;
  token_delta: number;
  candidate_outcome: "complete" | "blocked" | null;
  candidate_reason: string | null;
  attempt: number;
  available_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface TerminalCandidateRow {
  scope_id: string;
  goal_id: string;
  goal_version: number;
  candidate_id: string;
  outcome: "complete" | "blocked";
  reason: string;
  created_at: string;
}

interface ClaimRow {
  scope_id: string;
  goal_id: string;
  goal_version: number;
  claim_id: string;
  state: GoalContinuationClaim["state"];
  kind: GoalContinuationClaim["kind"];
  reason: string;
  attempt: number;
  available_at: string;
  expires_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export class SqliteGoalStorage implements GoalStorage {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    const goalTableSql = `CREATE TABLE IF NOT EXISTS agent_goals (
      scope_id TEXT PRIMARY KEY NOT NULL,
      id TEXT UNIQUE NOT NULL,
      name TEXT,
      objective TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'blocked', 'budget_limited', 'complete')),
      blocked_reason TEXT,
      snoozed_until TEXT,
      max_iterations INTEGER NOT NULL DEFAULT 25,
      max_tokens INTEGER,
      max_runtime_ms INTEGER,
      iterations_used INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      last_settled_at TEXT,
      last_evaluation_id TEXT,
      last_evaluation_outcome TEXT,
      last_evaluation_reason TEXT,
      last_evaluation_at TEXT,
      next_continuation_kind TEXT CHECK (next_continuation_kind IN ('started', 'updated')),
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    this.db.exec(`PRAGMA journal_mode = WAL; ${goalTableSql};`);
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(agent_goals)").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    );
    for (const [name, definition] of [
      ["name", "TEXT"],
      ["snoozed_until", "TEXT"],
      ["max_iterations", "INTEGER NOT NULL DEFAULT 25"],
      ["max_tokens", "INTEGER"],
      ["max_runtime_ms", "INTEGER"],
      ["iterations_used", "INTEGER NOT NULL DEFAULT 0"],
      ["tokens_used", "INTEGER NOT NULL DEFAULT 0"],
      ["last_settled_at", "TEXT"],
      ["last_evaluation_id", "TEXT"],
      ["last_evaluation_outcome", "TEXT"],
      ["last_evaluation_reason", "TEXT"],
      ["next_continuation_kind", "TEXT CHECK (next_continuation_kind IN ('started', 'updated'))"],
      ["last_evaluation_at", "TEXT"],
    ] as const) {
      if (!columns.has(name))
        this.db.exec(`ALTER TABLE agent_goals ADD COLUMN ${name} ${definition}`);
    }
    const tableDefinition = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_goals'")
      .get() as { sql: string };
    if (!tableDefinition.sql.includes("budget_limited")) {
      this.db.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS agent_goal_pending_evaluations;
        DROP TABLE IF EXISTS agent_goal_continuations;
        ALTER TABLE agent_goals RENAME TO agent_goals_legacy;
        ${goalTableSql};
        INSERT INTO agent_goals
          (scope_id, id, objective, status, blocked_reason, max_iterations, max_tokens,
           max_runtime_ms, iterations_used, tokens_used, last_settled_at,
           last_evaluation_id, last_evaluation_outcome, last_evaluation_reason, last_evaluation_at,
           version, created_at, updated_at)
        SELECT scope_id, id, objective, status, blocked_reason, max_iterations, max_tokens,
          max_runtime_ms, iterations_used, tokens_used, last_settled_at,
          last_evaluation_id, last_evaluation_outcome, last_evaluation_reason, last_evaluation_at,
          version, created_at, updated_at
        FROM agent_goals_legacy;
        DROP TABLE agent_goals_legacy;
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    }
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS agent_goal_checkpoints (
        id TEXT PRIMARY KEY NOT NULL,
        scope_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence TEXT,
        next_step TEXT,
        blocker TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (scope_id) REFERENCES agent_goals(scope_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS agent_goal_checkpoints_scope_created
        ON agent_goal_checkpoints(scope_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS agent_goal_terminal_candidates (
        scope_id TEXT PRIMARY KEY NOT NULL,
        goal_id TEXT NOT NULL,
        goal_version INTEGER NOT NULL,
        candidate_id TEXT UNIQUE NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('complete', 'blocked')),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (scope_id) REFERENCES agent_goals(scope_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS agent_goal_pending_evaluations (
        scope_id TEXT PRIMARY KEY NOT NULL,
        goal_id TEXT NOT NULL,
        goal_version INTEGER NOT NULL,
        evaluation_id TEXT UNIQUE NOT NULL,
        iterations_delta INTEGER NOT NULL DEFAULT 1,
        latest_output TEXT NOT NULL,
        token_delta INTEGER NOT NULL,
        candidate_outcome TEXT CHECK (candidate_outcome IN ('complete', 'blocked')),
        candidate_reason TEXT,
        attempt INTEGER NOT NULL,
        available_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (scope_id) REFERENCES agent_goals(scope_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS agent_goal_continuations (
        scope_id TEXT PRIMARY KEY NOT NULL,
        goal_id TEXT NOT NULL,
        goal_version INTEGER NOT NULL,
        claim_id TEXT UNIQUE NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('claimed', 'deferred', 'started')),
        kind TEXT NOT NULL DEFAULT 'continuation' CHECK (kind IN ('started', 'updated', 'continuation')),
        reason TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        available_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (scope_id) REFERENCES agent_goals(scope_id) ON DELETE CASCADE
      );
    `);
    const pendingColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(agent_goal_pending_evaluations)").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    if (!pendingColumns.has("iterations_delta")) {
      this.db.exec(
        "ALTER TABLE agent_goal_pending_evaluations ADD COLUMN iterations_delta INTEGER NOT NULL DEFAULT 1",
      );
    }
    if (!pendingColumns.has("candidate_outcome")) {
      this.db.exec(
        "ALTER TABLE agent_goal_pending_evaluations ADD COLUMN candidate_outcome TEXT CHECK (candidate_outcome IN ('complete', 'blocked'))",
      );
    }
    if (!pendingColumns.has("candidate_reason")) {
      this.db.exec("ALTER TABLE agent_goal_pending_evaluations ADD COLUMN candidate_reason TEXT");
    }
    const claimColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(agent_goal_continuations)").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    if (!claimColumns.has("kind")) {
      this.db.exec(
        "ALTER TABLE agent_goal_continuations ADD COLUMN kind TEXT NOT NULL DEFAULT 'continuation' CHECK (kind IN ('started', 'updated', 'continuation'))",
      );
    }
  }

  async get(scopeId: string): Promise<AgentGoal | undefined> {
    const row = this.db.prepare("SELECT * FROM agent_goals WHERE scope_id = ?").get(scopeId) as
      | GoalRow
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      scopeId: row.scope_id,
      name: row.name ?? undefined,
      objective: row.objective,
      status: row.status,
      blockedReason: row.blocked_reason ?? undefined,
      snoozedUntil: row.snoozed_until ?? undefined,
      budget: {
        maxIterations: row.max_iterations > 0 ? row.max_iterations : undefined,
        maxTokens: row.max_tokens ?? undefined,
        maxRuntimeMs: row.max_runtime_ms ?? undefined,
      },
      usage: { iterations: row.iterations_used, tokens: row.tokens_used },
      lastSettledAt: row.last_settled_at ?? undefined,
      nextContinuationKind: row.next_continuation_kind ?? undefined,
      lastEvaluation:
        row.last_evaluation_id &&
        row.last_evaluation_outcome &&
        row.last_evaluation_reason &&
        row.last_evaluation_at
          ? {
              id: row.last_evaluation_id,
              outcome: row.last_evaluation_outcome,
              reason: row.last_evaluation_reason,
              at: row.last_evaluation_at,
            }
          : undefined,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async create(goal: AgentGoal): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO agent_goals
          (scope_id, id, name, objective, status, blocked_reason, snoozed_until,
           max_iterations, max_tokens, max_runtime_ms, iterations_used, tokens_used,
           last_settled_at, last_evaluation_id, last_evaluation_outcome,
           last_evaluation_reason, last_evaluation_at, next_continuation_kind,
           version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        goal.scopeId,
        goal.id,
        goal.name ?? null,
        goal.objective,
        goal.status,
        goal.blockedReason ?? null,
        goal.snoozedUntil ?? null,
        goal.budget.maxIterations ?? 0,
        goal.budget.maxTokens ?? null,
        goal.budget.maxRuntimeMs ?? null,
        goal.usage.iterations,
        goal.usage.tokens,
        goal.lastSettledAt ?? null,
        goal.lastEvaluation?.id ?? null,
        goal.lastEvaluation?.outcome ?? null,
        goal.lastEvaluation?.reason ?? null,
        goal.lastEvaluation?.at ?? null,
        goal.nextContinuationKind ?? null,
        goal.version,
        goal.createdAt,
        goal.updatedAt,
      );
  }

  async replace(goal: AgentGoal, expectedVersion: number): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE agent_goals SET name = ?, objective = ?, status = ?, blocked_reason = ?,
         snoozed_until = ?, max_iterations = ?, max_tokens = ?, max_runtime_ms = ?,
         iterations_used = ?, tokens_used = ?, last_settled_at = ?, last_evaluation_id = ?,
         last_evaluation_outcome = ?, last_evaluation_reason = ?, last_evaluation_at = ?,
         next_continuation_kind = ?, version = ?, updated_at = ?
         WHERE scope_id = ? AND id = ? AND version = ?`,
      )
      .run(
        goal.name ?? null,
        goal.objective,
        goal.status,
        goal.blockedReason ?? null,
        goal.snoozedUntil ?? null,
        goal.budget.maxIterations ?? 0,
        goal.budget.maxTokens ?? null,
        goal.budget.maxRuntimeMs ?? null,
        goal.usage.iterations,
        goal.usage.tokens,
        goal.lastSettledAt ?? null,
        goal.lastEvaluation?.id ?? null,
        goal.lastEvaluation?.outcome ?? null,
        goal.lastEvaluation?.reason ?? null,
        goal.lastEvaluation?.at ?? null,
        goal.nextContinuationKind ?? null,
        goal.version,
        goal.updatedAt,
        goal.scopeId,
        goal.id,
        expectedVersion,
      );
    return result.changes === 1;
  }

  async updateBudget(goal: AgentGoal, expectedVersion: number): Promise<boolean> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE agent_goals SET name = ?, objective = ?, status = ?, blocked_reason = ?,
           snoozed_until = ?, max_iterations = ?, max_tokens = ?, max_runtime_ms = ?,
           iterations_used = ?, tokens_used = ?, last_settled_at = ?, last_evaluation_id = ?,
           last_evaluation_outcome = ?, last_evaluation_reason = ?, last_evaluation_at = ?,
           next_continuation_kind = ?, version = ?, updated_at = ?
           WHERE scope_id = ? AND id = ? AND version = ?`,
        )
        .run(
          goal.name ?? null,
          goal.objective,
          goal.status,
          goal.blockedReason ?? null,
          goal.snoozedUntil ?? null,
          goal.budget.maxIterations ?? 0,
          goal.budget.maxTokens ?? null,
          goal.budget.maxRuntimeMs ?? null,
          goal.usage.iterations,
          goal.usage.tokens,
          goal.lastSettledAt ?? null,
          goal.lastEvaluation?.id ?? null,
          goal.lastEvaluation?.outcome ?? null,
          goal.lastEvaluation?.reason ?? null,
          goal.lastEvaluation?.at ?? null,
          goal.nextContinuationKind ?? null,
          goal.version,
          goal.updatedAt,
          goal.scopeId,
          goal.id,
          expectedVersion,
        );
      if (result.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(
          `UPDATE agent_goal_pending_evaluations SET goal_version = ?
           WHERE scope_id = ? AND goal_id = ? AND goal_version = ?`,
        )
        .run(goal.version, goal.scopeId, goal.id, expectedVersion);
      this.db
        .prepare(
          `UPDATE agent_goal_terminal_candidates SET goal_version = ?
           WHERE scope_id = ? AND goal_id = ? AND goal_version = ?`,
        )
        .run(goal.version, goal.scopeId, goal.id, expectedVersion);
      this.db
        .prepare(
          `UPDATE agent_goal_continuations SET goal_version = ?
           WHERE scope_id = ? AND goal_id = ? AND goal_version = ?`,
        )
        .run(goal.version, goal.scopeId, goal.id, expectedVersion);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async addCheckpoint(checkpoint: GoalCheckpoint): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT INTO agent_goal_checkpoints
         (id, scope_id, goal_id, summary, evidence, next_step, blocker, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM agent_goals WHERE scope_id = ? AND id = ? AND status != 'complete'
         )`,
      )
      .run(
        checkpoint.id,
        checkpoint.scopeId,
        checkpoint.goalId,
        checkpoint.summary,
        checkpoint.evidence ?? null,
        checkpoint.nextStep ?? null,
        checkpoint.blocker ?? null,
        checkpoint.createdAt,
        checkpoint.scopeId,
        checkpoint.goalId,
      );
    return result.changes === 1;
  }

  async listCheckpoints(scopeId: string): Promise<GoalCheckpoint[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM agent_goal_checkpoints WHERE scope_id = ? ORDER BY created_at DESC, id DESC",
      )
      .all(scopeId);
    return rows.map((row) => {
      if (
        typeof row.id !== "string" ||
        typeof row.scope_id !== "string" ||
        typeof row.goal_id !== "string" ||
        typeof row.summary !== "string" ||
        typeof row.created_at !== "string"
      ) {
        throw new Error("Stored goal checkpoint is malformed");
      }
      return {
        id: row.id,
        scopeId: row.scope_id,
        goalId: row.goal_id,
        summary: row.summary,
        evidence: typeof row.evidence === "string" ? row.evidence : undefined,
        nextStep: typeof row.next_step === "string" ? row.next_step : undefined,
        blocker: typeof row.blocker === "string" ? row.blocker : undefined,
        createdAt: row.created_at,
      };
    });
  }

  async delete(
    scopeId: string,
    expectedGoalId: string,
    expectedVersion: number,
  ): Promise<GoalDeleteResult> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare("SELECT id, version FROM agent_goals WHERE scope_id = ?")
        .get(scopeId) as Pick<GoalRow, "id" | "version"> | undefined;
      if (!current) {
        this.db.exec("COMMIT");
        return "missing";
      }
      if (current.id !== expectedGoalId || current.version !== expectedVersion) {
        this.db.exec("COMMIT");
        return "conflict";
      }
      const result = this.db
        .prepare("DELETE FROM agent_goals WHERE scope_id = ? AND id = ? AND version = ?")
        .run(scopeId, expectedGoalId, expectedVersion);
      this.db.exec("COMMIT");
      return result.changes === 1 ? "deleted" : "conflict";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getPendingEvaluation(scopeId: string): Promise<GoalPendingEvaluation | undefined> {
    const row = this.db
      .prepare("SELECT * FROM agent_goal_pending_evaluations WHERE scope_id = ?")
      .get(scopeId) as PendingEvaluationRow | undefined;
    return row
      ? {
          scopeId: row.scope_id,
          goalId: row.goal_id,
          goalVersion: row.goal_version,
          evaluationId: row.evaluation_id,
          iterationsDelta: row.iterations_delta,
          progress: {
            latestOutput: row.latest_output,
            tokenDelta: row.token_delta,
            terminalCandidate:
              row.candidate_outcome && row.candidate_reason
                ? { outcome: row.candidate_outcome, reason: row.candidate_reason }
                : undefined,
          },
          attempt: row.attempt,
          availableAt: row.available_at,
          lastError: row.last_error ?? undefined,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  async appendPendingEvaluation(pending: GoalPendingEvaluation): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT INTO agent_goal_pending_evaluations
         (scope_id, goal_id, goal_version, evaluation_id, iterations_delta, latest_output,
          token_delta, candidate_outcome, candidate_reason, attempt, available_at, last_error,
          created_at, updated_at)
         SELECT ?, ?, goal.version, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM agent_goals AS goal
         WHERE goal.scope_id = ? AND goal.id = ? AND goal.status = 'active'
         ON CONFLICT(scope_id) DO UPDATE SET goal_id = excluded.goal_id,
           goal_version = excluded.goal_version, evaluation_id = excluded.evaluation_id,
           iterations_delta = CASE
             WHEN agent_goal_pending_evaluations.goal_id = excluded.goal_id
              AND agent_goal_pending_evaluations.goal_version = excluded.goal_version
             THEN agent_goal_pending_evaluations.iterations_delta + excluded.iterations_delta
             ELSE excluded.iterations_delta END,
           latest_output = excluded.latest_output,
           token_delta = CASE
             WHEN agent_goal_pending_evaluations.goal_id = excluded.goal_id
              AND agent_goal_pending_evaluations.goal_version = excluded.goal_version
             THEN agent_goal_pending_evaluations.token_delta + excluded.token_delta
             ELSE excluded.token_delta END,
           candidate_outcome = CASE
             WHEN agent_goal_pending_evaluations.goal_id = excluded.goal_id
              AND agent_goal_pending_evaluations.goal_version = excluded.goal_version
             THEN COALESCE(excluded.candidate_outcome,
               agent_goal_pending_evaluations.candidate_outcome)
             ELSE excluded.candidate_outcome END,
           candidate_reason = CASE
             WHEN agent_goal_pending_evaluations.goal_id = excluded.goal_id
              AND agent_goal_pending_evaluations.goal_version = excluded.goal_version
             THEN COALESCE(excluded.candidate_reason,
               agent_goal_pending_evaluations.candidate_reason)
             ELSE excluded.candidate_reason END,
           attempt = excluded.attempt, available_at = excluded.available_at,
           last_error = excluded.last_error,
           created_at = CASE
             WHEN agent_goal_pending_evaluations.goal_id = excluded.goal_id
              AND agent_goal_pending_evaluations.goal_version = excluded.goal_version
             THEN agent_goal_pending_evaluations.created_at ELSE excluded.created_at END,
           updated_at = excluded.updated_at`,
      )
      .run(
        pending.scopeId,
        pending.goalId,
        pending.evaluationId,
        pending.iterationsDelta,
        pending.progress.latestOutput,
        pending.progress.tokenDelta ?? 0,
        pending.progress.terminalCandidate?.outcome ?? null,
        pending.progress.terminalCandidate?.reason ?? null,
        pending.attempt,
        pending.availableAt,
        pending.lastError ?? null,
        pending.createdAt,
        pending.updatedAt,
        pending.scopeId,
        pending.goalId,
      );
    return result.changes === 1;
  }

  async putPendingEvaluation(pending: GoalPendingEvaluation): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT INTO agent_goal_pending_evaluations
         (scope_id, goal_id, goal_version, evaluation_id, iterations_delta, latest_output,
          token_delta, candidate_outcome, candidate_reason, attempt, available_at, last_error,
          created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM agent_goals WHERE scope_id = ? AND id = ? AND version = ?
         )
         ON CONFLICT(scope_id) DO UPDATE SET goal_id = excluded.goal_id,
           goal_version = excluded.goal_version, evaluation_id = excluded.evaluation_id,
           iterations_delta = excluded.iterations_delta,
           latest_output = excluded.latest_output, token_delta = excluded.token_delta,
           candidate_outcome = excluded.candidate_outcome,
           candidate_reason = excluded.candidate_reason, attempt = excluded.attempt,
           available_at = excluded.available_at,
           last_error = excluded.last_error, created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        pending.scopeId,
        pending.goalId,
        pending.goalVersion,
        pending.evaluationId,
        pending.iterationsDelta,
        pending.progress.latestOutput,
        pending.progress.tokenDelta ?? 0,
        pending.progress.terminalCandidate?.outcome ?? null,
        pending.progress.terminalCandidate?.reason ?? null,
        pending.attempt,
        pending.availableAt,
        pending.lastError ?? null,
        pending.createdAt,
        pending.updatedAt,
        pending.scopeId,
        pending.goalId,
        pending.goalVersion,
      );
    return result.changes === 1;
  }

  async replacePendingEvaluation(
    pending: GoalPendingEvaluation,
    expectedEvaluationId: string,
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE agent_goal_pending_evaluations SET goal_id = ?, goal_version = ?,
         evaluation_id = ?, iterations_delta = ?, latest_output = ?, token_delta = ?,
         candidate_outcome = ?, candidate_reason = ?, attempt = ?, available_at = ?,
         last_error = ?, created_at = ?, updated_at = ?
         WHERE scope_id = ? AND evaluation_id = ? AND EXISTS (
           SELECT 1 FROM agent_goals WHERE scope_id = ? AND id = ? AND version = ?
         )`,
      )
      .run(
        pending.goalId,
        pending.goalVersion,
        pending.evaluationId,
        pending.iterationsDelta,
        pending.progress.latestOutput,
        pending.progress.tokenDelta ?? 0,
        pending.progress.terminalCandidate?.outcome ?? null,
        pending.progress.terminalCandidate?.reason ?? null,
        pending.attempt,
        pending.availableAt,
        pending.lastError ?? null,
        pending.createdAt,
        pending.updatedAt,
        pending.scopeId,
        expectedEvaluationId,
        pending.scopeId,
        pending.goalId,
        pending.goalVersion,
      );
    return result.changes === 1;
  }

  async deletePendingEvaluation(scopeId: string, expectedEvaluationId: string): Promise<boolean> {
    const result = this.db
      .prepare(
        "DELETE FROM agent_goal_pending_evaluations WHERE scope_id = ? AND evaluation_id = ?",
      )
      .run(scopeId, expectedEvaluationId);
    return result.changes === 1;
  }

  async commitEvaluation(
    goal: AgentGoal,
    expectedGoalVersion: number,
    expectedEvaluationId: string,
  ): Promise<boolean> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.db
        .prepare(
          `UPDATE agent_goals SET status = ?, blocked_reason = ?, iterations_used = ?,
           tokens_used = ?, last_settled_at = ?, last_evaluation_id = ?,
           last_evaluation_outcome = ?, last_evaluation_reason = ?, last_evaluation_at = ?,
           version = ?, updated_at = ?
           WHERE scope_id = ? AND id = ? AND version = ? AND EXISTS (
             SELECT 1 FROM agent_goal_pending_evaluations
             WHERE scope_id = ? AND evaluation_id = ?
           )`,
        )
        .run(
          goal.status,
          goal.blockedReason ?? null,
          goal.usage.iterations,
          goal.usage.tokens,
          goal.lastSettledAt ?? null,
          goal.lastEvaluation?.id ?? null,
          goal.lastEvaluation?.outcome ?? null,
          goal.lastEvaluation?.reason ?? null,
          goal.lastEvaluation?.at ?? null,
          goal.version,
          goal.updatedAt,
          goal.scopeId,
          goal.id,
          expectedGoalVersion,
          goal.scopeId,
          expectedEvaluationId,
        );
      if (updated.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(
          `UPDATE agent_goal_continuations SET goal_version = ?
           WHERE scope_id = ? AND goal_id = ? AND goal_version = ?`,
        )
        .run(goal.version, goal.scopeId, goal.id, expectedGoalVersion);
      const deleted = this.db
        .prepare(
          "DELETE FROM agent_goal_pending_evaluations WHERE scope_id = ? AND evaluation_id = ?",
        )
        .run(goal.scopeId, expectedEvaluationId);
      if (deleted.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getTerminalCandidate(scopeId: string): Promise<GoalTerminalCandidateRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM agent_goal_terminal_candidates WHERE scope_id = ?")
      .get(scopeId) as TerminalCandidateRow | undefined;
    return row
      ? {
          scopeId: row.scope_id,
          goalId: row.goal_id,
          goalVersion: row.goal_version,
          candidateId: row.candidate_id,
          outcome: row.outcome,
          reason: row.reason,
          createdAt: row.created_at,
        }
      : undefined;
  }

  async putTerminalCandidate(candidate: GoalTerminalCandidateRecord): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT INTO agent_goal_terminal_candidates
         (scope_id, goal_id, goal_version, candidate_id, outcome, reason, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM agent_goals
           WHERE scope_id = ? AND id = ? AND version = ? AND status = 'active'
         )
         ON CONFLICT(scope_id) DO UPDATE SET goal_id = excluded.goal_id,
           goal_version = excluded.goal_version, candidate_id = excluded.candidate_id,
           outcome = excluded.outcome, reason = excluded.reason, created_at = excluded.created_at`,
      )
      .run(
        candidate.scopeId,
        candidate.goalId,
        candidate.goalVersion,
        candidate.candidateId,
        candidate.outcome,
        candidate.reason,
        candidate.createdAt,
        candidate.scopeId,
        candidate.goalId,
        candidate.goalVersion,
      );
    return result.changes === 1;
  }

  async deleteTerminalCandidate(scopeId: string, expectedCandidateId: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM agent_goal_terminal_candidates WHERE scope_id = ? AND candidate_id = ?")
      .run(scopeId, expectedCandidateId);
    return result.changes === 1;
  }

  async getContinuationClaim(scopeId: string): Promise<GoalContinuationClaim | undefined> {
    const row = this.db
      .prepare("SELECT * FROM agent_goal_continuations WHERE scope_id = ?")
      .get(scopeId) as ClaimRow | undefined;
    return row
      ? {
          scopeId: row.scope_id,
          goalId: row.goal_id,
          goalVersion: row.goal_version,
          claimId: row.claim_id,
          state: row.state,
          kind: row.kind,
          reason: row.reason,
          attempt: row.attempt,
          availableAt: row.available_at,
          expiresAt: row.expires_at,
          lastError: row.last_error ?? undefined,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  async createContinuationClaim(claim: GoalContinuationClaim): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_goal_continuations
         (scope_id, goal_id, goal_version, claim_id, state, kind, reason, attempt,
          available_at, expires_at, last_error, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM agent_goals
           WHERE scope_id = ? AND id = ? AND version = ? AND status = 'active'
         )`,
      )
      .run(
        claim.scopeId,
        claim.goalId,
        claim.goalVersion,
        claim.claimId,
        claim.state,
        claim.kind,
        claim.reason,
        claim.attempt,
        claim.availableAt,
        claim.expiresAt,
        claim.lastError ?? null,
        claim.createdAt,
        claim.updatedAt,
        claim.scopeId,
        claim.goalId,
        claim.goalVersion,
      );
    return result.changes === 1;
  }

  async replaceContinuationClaim(
    claim: GoalContinuationClaim,
    expectedClaimId: string,
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE agent_goal_continuations SET goal_id = ?,
         goal_version = (SELECT version FROM agent_goals WHERE scope_id = ? AND id = ?),
         claim_id = ?, state = ?, kind = ?, reason = ?, attempt = ?, available_at = ?, expires_at = ?,
         last_error = ?, updated_at = ? WHERE scope_id = ? AND claim_id = ?
         AND goal_id = ? AND EXISTS (
           SELECT 1 FROM agent_goals WHERE scope_id = ? AND id = ? AND status = 'active'
         )`,
      )
      .run(
        claim.goalId,
        claim.scopeId,
        claim.goalId,
        claim.claimId,
        claim.state,
        claim.kind,
        claim.reason,
        claim.attempt,
        claim.availableAt,
        claim.expiresAt,
        claim.lastError ?? null,
        claim.updatedAt,
        claim.scopeId,
        expectedClaimId,
        claim.goalId,
        claim.scopeId,
        claim.goalId,
      );
    return result.changes === 1;
  }

  async acknowledgeContinuationClaim(scopeId: string, expectedClaimId: string): Promise<boolean> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const claim = this.db
        .prepare(
          `SELECT claim.goal_id, claim.goal_version, claim.kind
           FROM agent_goal_continuations AS claim
           JOIN agent_goals AS goal ON goal.scope_id = claim.scope_id
            AND goal.id = claim.goal_id AND goal.version = claim.goal_version
           WHERE claim.scope_id = ? AND claim.claim_id = ? AND claim.state = 'started'`,
        )
        .get(scopeId, expectedClaimId) as
        | { goal_id: string; goal_version: number; kind: GoalContinuationClaim["kind"] }
        | undefined;
      if (!claim) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(
          `UPDATE agent_goals SET next_continuation_kind = NULL
           WHERE scope_id = ? AND id = ? AND version = ? AND next_continuation_kind = ?`,
        )
        .run(scopeId, claim.goal_id, claim.goal_version, claim.kind);
      const deleted = this.db
        .prepare(
          `DELETE FROM agent_goal_continuations
           WHERE scope_id = ? AND claim_id = ? AND goal_id = ? AND goal_version = ?`,
        )
        .run(scopeId, expectedClaimId, claim.goal_id, claim.goal_version);
      if (deleted.changes !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async deleteContinuationClaim(scopeId: string, expectedClaimId: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM agent_goal_continuations WHERE scope_id = ? AND claim_id = ?")
      .run(scopeId, expectedClaimId);
    return result.changes === 1;
  }

  close(): void {
    this.db.close();
  }
}
