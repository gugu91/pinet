import { describe, expect, it } from "vitest";
import {
  formatHibernationTelemetry,
  summarizeHibernationTelemetry,
} from "./hibernation-telemetry.js";
import type { AgentLifecycleEvent, AgentLifecycleState } from "./types.js";

let nextId = 1;

function event(overrides: Partial<AgentLifecycleEvent>): AgentLifecycleEvent {
  return {
    id: nextId++,
    correlationId: `corr-${nextId}`,
    agentId: "agent-a",
    fromState: "idle" as AgentLifecycleState,
    toState: "hibernated" as AgentLifecycleState,
    lifecycleVersion: 1,
    fenceToken: null,
    reason: "manual",
    triggerSource: null,
    actor: "broker",
    outcome: "accepted",
    errorCode: null,
    queueDepth: null,
    oldestQueueAgeMs: null,
    durationMs: null,
    rssBytesBefore: null,
    rssBytesAfter: null,
    createdAt: "2026-07-11T08:00:00.000Z",
    ...overrides,
  };
}

describe("summarizeHibernationTelemetry", () => {
  it("returns an empty rollup for no events", () => {
    const summary = summarizeHibernationTelemetry([]);
    expect(summary.totalEvents).toBe(0);
    expect(summary.hibernations).toBe(0);
    expect(summary.wakeSuccesses).toBe(0);
    expect(summary.failures).toBe(0);
    expect(summary.meanWakeMs).toBeNull();
    expect(summary.p95WakeMs).toBeNull();
    expect(summary.agentCount).toBe(0);
    expect(formatHibernationTelemetry(summary)).toContain("no lifecycle events");
  });

  it("counts accepted hibernations and recovered RSS", () => {
    const summary = summarizeHibernationTelemetry([
      event({ toState: "hibernated", rssBytesBefore: 500, rssBytesAfter: 200 }),
      event({ agentId: "agent-b", toState: "hibernated", rssBytesBefore: 100, rssBytesAfter: 300 }),
    ]);
    expect(summary.hibernations).toBe(2);
    // agent-a recovered 300; agent-b grew (clamped to 0).
    expect(summary.recoveredRssBytes).toBe(300);
    expect(summary.agentCount).toBe(2);
    expect(summary.failures).toBe(0);
  });

  it("computes mean and nearest-rank p95 wake latency over accepted wakes only", () => {
    const durations = [10, 20, 30, 40, 100];
    const events = durations.map((durationMs) =>
      event({ fromState: "waking", toState: "live", durationMs }),
    );
    // A non-accepted waking event must not contribute to latency.
    events.push(
      event({ fromState: "waking", toState: "live", outcome: "timeout", durationMs: 9999 }),
    );
    const summary = summarizeHibernationTelemetry(events);
    expect(summary.wakeSuccesses).toBe(5);
    expect(summary.failures).toBe(1);
    expect(summary.meanWakeMs).toBe(40);
    // nearest-rank p95 of 5 samples => ceil(0.95*5)=5 => the max (100).
    expect(summary.p95WakeMs).toBe(100);
  });

  it("tallies refusal reasons by errorCode, then reason, most frequent first", () => {
    const summary = summarizeHibernationTelemetry([
      event({ outcome: "refused", errorCode: "WAKE_FENCE_REJECTED" }),
      event({ outcome: "refused", errorCode: "WAKE_FENCE_REJECTED" }),
      event({ outcome: "refused", errorCode: null, reason: "not_idle" }),
    ]);
    expect(summary.failures).toBe(3);
    expect(summary.refusalReasons[0]).toEqual({ reason: "WAKE_FENCE_REJECTED", count: 2 });
    expect(summary.refusalReasons[1]).toEqual({ reason: "not_idle", count: 1 });
  });

  it("tracks max queue depth and oldest queue age across events", () => {
    const summary = summarizeHibernationTelemetry([
      event({ queueDepth: 3, oldestQueueAgeMs: 1000 }),
      event({ queueDepth: 7, oldestQueueAgeMs: 500 }),
      event({ queueDepth: null, oldestQueueAgeMs: 4000 }),
    ]);
    expect(summary.maxQueueDepth).toBe(7);
    expect(summary.maxOldestQueueAgeMs).toBe(4000);
  });

  it("passes retention info through when provided", () => {
    const summary = summarizeHibernationTelemetry([event({})], {
      retainedCount: 42,
      prunedCount: 8,
      lastPrunedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(summary.retainedCount).toBe(42);
    expect(summary.prunedCount).toBe(8);
    expect(summary.lastPrunedAt).toBe("2026-07-10T00:00:00.000Z");
    const text = formatHibernationTelemetry(summary);
    expect(text).toContain("retained=42");
    expect(text).toContain("pruned=8");
  });
});

describe("formatHibernationTelemetry", () => {
  it("renders a compact block with headline counters and latency", () => {
    const summary = summarizeHibernationTelemetry([
      event({ toState: "hibernated" }),
      event({ fromState: "waking", toState: "live", durationMs: 250 }),
      event({ outcome: "refused", errorCode: "stale_fence" }),
    ]);
    const text = formatHibernationTelemetry(summary);
    expect(text).toContain("hibernations=1");
    expect(text).toContain("wake_successes=1");
    expect(text).toContain("failures=1");
    expect(text).toContain("mean=250ms");
    expect(text).toContain("refusals: stale_fence x1");
    // No secret/body content ever leaks into the rendered block.
    expect(text).not.toMatch(/prompt|token|secret|body/i);
  });
});
