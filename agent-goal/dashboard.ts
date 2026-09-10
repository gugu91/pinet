import { stripVTControlCharacters } from "node:util";
import type { AgentGoal, GoalCheckpoint, GoalContinuationClaim } from "./domain.js";

export function displayGoalText(value: string, maxLength: number): string {
  const normalized = Array.from(stripVTControlCharacters(value).replaceAll(/\r?\n/g, " "))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && (code < 127 || code > 159);
    })
    .join("")
    .trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

export function goalDisplayName(goal: AgentGoal): string {
  return displayGoalText(goal.name ?? goal.objective, 72);
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
  return `🎯 ${goalDisplayName(goal)} ${formatElapsed(end - Date.parse(goal.createdAt))}`;
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
    lines.push(`Checkpoint ${checkpoint.createdAt}: ${displayGoalText(checkpoint.summary, 90)}`);
  }
  if (checkpoints.length > 3) lines.push(`… and ${checkpoints.length - 3} more checkpoints`);
  lines.push("/goal update · snooze <duration> · close · hide");
  return lines;
}
