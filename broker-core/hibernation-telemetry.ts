import { sanitizeOperatorReason } from "./hibernation-status.js";
import type { AgentLifecycleEvent, AgentLifecycleRetentionInfo } from "./types.js";

/**
 * Read-only, sanitized rollup of hibernation lifecycle telemetry.
 *
 * This is the operable status surface over the append-only
 * `agent_lifecycle_events` table (see `getRecentAgentLifecycleEvents`). It is a
 * pure derivation of already-sanitized events — it never reads prompts, message
 * bodies, tokens, or environment values — so it is safe to render in a CLI,
 * dashboard, or Slack status reply without touching the live broker.
 *
 * The counts mirror the documented dogfood report query so a fleet operator can
 * reconcile this in-process summary against the raw SQL.
 */
export interface HibernationTelemetrySummary {
  /** Total events considered. */
  totalEvents: number;
  /** Accepted transitions into `hibernated`. */
  hibernations: number;
  /** Accepted `waking -> live` transitions. */
  wakeSuccesses: number;
  /** Events whose outcome was not `accepted` (refusals, stale fences, aborts). */
  failures: number;
  /** Mean accepted wake latency in ms, or null when no accepted wake is present. */
  meanWakeMs: number | null;
  /** Nearest-rank 95th percentile accepted wake latency in ms, or null. */
  p95WakeMs: number | null;
  /** Largest observed queue depth across events. */
  maxQueueDepth: number;
  /** Largest observed oldest-queued-message age in ms across events. */
  maxOldestQueueAgeMs: number;
  /** Sum of max(rssBefore - rssAfter, 0) over accepted hibernations, in bytes. */
  recoveredRssBytes: number;
  /** Non-accepted outcome reasons, most frequent first. */
  refusalReasons: Array<{ reason: string; count: number }>;
  /** Distinct agents represented in the event window. */
  agentCount: number;
  /** Retained/pruned counters when retention info is provided. */
  retainedCount: number | null;
  prunedCount: number | null;
  lastPrunedAt: string | null;
}

const ACCEPTED_OUTCOME = "accepted";

/**
 * Summarize a window of lifecycle events into an operable status rollup. Pass
 * the newest events (any order); retention info is optional passthrough.
 */
export function summarizeHibernationTelemetry(
  events: AgentLifecycleEvent[],
  retention?: AgentLifecycleRetentionInfo,
): HibernationTelemetrySummary {
  let hibernations = 0;
  let wakeSuccesses = 0;
  let failures = 0;
  let maxQueueDepth = 0;
  let maxOldestQueueAgeMs = 0;
  let recoveredRssBytes = 0;
  const wakeDurations: number[] = [];
  const refusalCounts = new Map<string, number>();
  const agents = new Set<string>();

  for (const event of events) {
    agents.add(event.agentId);

    if (event.queueDepth != null && event.queueDepth > maxQueueDepth) {
      maxQueueDepth = event.queueDepth;
    }
    if (event.oldestQueueAgeMs != null && event.oldestQueueAgeMs > maxOldestQueueAgeMs) {
      maxOldestQueueAgeMs = event.oldestQueueAgeMs;
    }

    if (event.outcome !== ACCEPTED_OUTCOME) {
      failures += 1;
      // Defense-in-depth: reasons SHOULD be sanitized at write time, but a
      // path-bearing reason must never reach this rendered aggregate even if an
      // upstream writer regresses.
      const reason = sanitizeOperatorReason(event.errorCode ?? event.reason) ?? "unspecified";
      refusalCounts.set(reason, (refusalCounts.get(reason) ?? 0) + 1);
      continue;
    }

    if (event.toState === "hibernated") {
      hibernations += 1;
      if (event.rssBytesBefore != null && event.rssBytesAfter != null) {
        recoveredRssBytes += Math.max(event.rssBytesBefore - event.rssBytesAfter, 0);
      }
    }

    if (event.fromState === "waking" && event.toState === "live") {
      wakeSuccesses += 1;
      if (event.durationMs != null) wakeDurations.push(event.durationMs);
    }
  }

  wakeDurations.sort((left, right) => left - right);
  const meanWakeMs =
    wakeDurations.length === 0
      ? null
      : wakeDurations.reduce((sum, value) => sum + value, 0) / wakeDurations.length;
  // Nearest-rank p95: rank = ceil(0.95 * N), clamped to [1, N].
  const p95WakeMs =
    wakeDurations.length === 0
      ? null
      : wakeDurations[Math.min(Math.ceil(0.95 * wakeDurations.length), wakeDurations.length) - 1];

  const refusalReasons = [...refusalCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));

  return {
    totalEvents: events.length,
    hibernations,
    wakeSuccesses,
    failures,
    meanWakeMs: meanWakeMs === null ? null : Math.round(meanWakeMs * 10) / 10,
    p95WakeMs,
    maxQueueDepth,
    maxOldestQueueAgeMs,
    recoveredRssBytes,
    refusalReasons,
    agentCount: agents.size,
    retainedCount: retention?.retainedCount ?? null,
    prunedCount: retention?.prunedCount ?? null,
    lastPrunedAt: retention?.lastPrunedAt ?? null,
  };
}

/**
 * Render a compact, human-readable status block from a telemetry summary. Safe
 * for CLI/Slack output: it contains only aggregate counters, never bodies.
 */
export function formatHibernationTelemetry(summary: HibernationTelemetrySummary): string {
  if (summary.totalEvents === 0) {
    return "Hibernation telemetry: no lifecycle events recorded.";
  }

  const lines: string[] = [];
  lines.push(
    `Hibernation telemetry (${summary.totalEvents} events, ${summary.agentCount} agents):`,
  );
  lines.push(
    `  hibernations=${summary.hibernations}  wake_successes=${summary.wakeSuccesses}  failures=${summary.failures}`,
  );

  const wakeParts: string[] = [];
  if (summary.meanWakeMs !== null) wakeParts.push(`mean=${summary.meanWakeMs}ms`);
  if (summary.p95WakeMs !== null) wakeParts.push(`p95=${summary.p95WakeMs}ms`);
  if (wakeParts.length > 0) lines.push(`  wake latency: ${wakeParts.join("  ")}`);

  if (summary.maxQueueDepth > 0 || summary.maxOldestQueueAgeMs > 0) {
    lines.push(
      `  queue: max_depth=${summary.maxQueueDepth}  max_oldest_age=${summary.maxOldestQueueAgeMs}ms`,
    );
  }

  if (summary.recoveredRssBytes > 0) {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let value = summary.recoveredRssBytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const rounded = unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
    lines.push(`  recovered RSS (est.): ${rounded} ${units[unitIndex]}`);
  }

  if (summary.refusalReasons.length > 0) {
    const top = summary.refusalReasons
      .slice(0, 5)
      .map((entry) => `${entry.reason} x${entry.count}`)
      .join(", ");
    lines.push(`  refusals: ${top}`);
  }

  if (summary.retainedCount !== null) {
    const pruned = summary.prunedCount ?? 0;
    const prunedSuffix = summary.lastPrunedAt ? ` (last pruned ${summary.lastPrunedAt})` : "";
    lines.push(`  retention: retained=${summary.retainedCount}  pruned=${pruned}${prunedSuffix}`);
  }

  return lines.join("\n");
}
