import { stripVTControlCharacters } from "node:util";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentGoal, GoalCheckpoint, GoalContinuationClaim } from "./domain.js";

export function displayGoalText(value: string, maxLength: number): string {
  const normalized = Array.from(stripVTControlCharacters(value).replaceAll(/\r?\n/g, " "))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && (code < 127 || code > 159);
    })
    .join("")
    .trim();
  return stripVTControlCharacters(truncateToWidth(normalized, Math.max(0, maxLength)));
}

export function goalDisplayName(goal: AgentGoal, maxLength = 72): string {
  return displayGoalText(goal.name ?? goal.objective, maxLength);
}

export function goalStatusEmoji(goal: AgentGoal): string {
  if (goal.snoozedUntil || goal.status === "paused") return "⏸️";
  if (goal.status === "complete") return "✅";
  if (goal.status === "blocked") return "⛔";
  if (goal.status === "budget_limited") return "⏱️";
  return "🎯";
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatGoalStatus(goal: AgentGoal, now = Date.now()): string {
  const end = goal.status === "active" ? now : Date.parse(goal.updatedAt);
  return `${goalStatusEmoji(goal)} ${goalDisplayName(goal, 40)} ${formatElapsed(end - Date.parse(goal.createdAt))}`;
}

export function formatGoalDashboard(
  goal: AgentGoal,
  claim?: GoalContinuationClaim,
  checkpoints: GoalCheckpoint[] = [],
): string[] {
  const lines = [
    `Goal · ${goal.status} · v${goal.version}`,
    goalDisplayName(goal),
    displayGoalText(goal.objective, 120),
  ];
  const limits = [
    goal.budget.maxIterations === undefined
      ? undefined
      : `Turns ${goal.usage.iterations}/${goal.budget.maxIterations}`,
    goal.budget.maxRuntimeMs === undefined
      ? undefined
      : `Runtime ${Math.round(goal.budget.maxRuntimeMs / 60_000)}m`,
  ].filter((value): value is string => value !== undefined);
  lines.push(limits.length ? `Limits: ${limits.join(" · ")}` : "Limits: off");
  if (goal.snoozedUntil) lines.push(`Snoozed until ${goal.snoozedUntil}`);
  if (goal.lastEvaluation) {
    lines.push(
      `Last ${goal.lastEvaluation.outcome.toUpperCase()}: ${displayGoalText(goal.lastEvaluation.reason, 100)}`,
    );
  }
  if (goal.blockedReason) lines.push(`Reason: ${displayGoalText(goal.blockedReason, 100)}`);
  if (claim) lines.push(`Continuation: ${claim.state} · attempt ${claim.attempt}`);
  for (const checkpoint of checkpoints.slice(0, 3)) {
    lines.push(`Checkpoint ${checkpoint.createdAt}`);
    lines.push(`DONE: ${displayGoalText(checkpoint.summary, 90)}`);
    if (checkpoint.nextStep) lines.push(`TODO: ${displayGoalText(checkpoint.nextStep, 90)}`);
    if (checkpoint.evidence) lines.push(`EVIDENCE: ${displayGoalText(checkpoint.evidence, 90)}`);
    if (checkpoint.blocker) lines.push(`BLOCKED: ${displayGoalText(checkpoint.blocker, 90)}`);
  }
  if (checkpoints.length > 3) lines.push(`… and ${checkpoints.length - 3} more checkpoints`);
  lines.push("/goal update · snooze <duration> · close · hide");
  return lines;
}

/** One line per unfinished goal, marking the current session and how to reach the others. */
export function formatGoalList(goals: AgentGoal[], currentScopeId: string): string[] {
  if (goals.length === 0) return ["No unfinished goals in any session."];
  return goals.map((goal) => {
    const where = goal.scopeId === currentScopeId ? "this session" : `pi --session ${goal.scopeId}`;
    const settled = goal.lastSettledAt ?? goal.updatedAt;
    return `${goalStatusEmoji(goal)} ${goal.status} · ${goalDisplayName(goal, 48)} · ${goal.usage.iterations} turns · last ${settled} · ${where}`;
  });
}

export function formatOrphanGoalNotice(
  goals: AgentGoal[],
  currentScopeId: string,
): string | undefined {
  const others = goals.filter((goal) => goal.scopeId !== currentScopeId);
  if (others.length === 0) return undefined;
  return `${others.length} unfinished goal${others.length === 1 ? "" : "s"} in other sessions; /goal list shows how to resume them`;
}
