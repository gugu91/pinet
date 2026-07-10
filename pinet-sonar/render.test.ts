import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  formatAge,
  formatUtcMinute,
  renderSonarHtml,
  renderTrafficSvg,
  truncateMiddle,
} from "./render.ts";
import type { MeshSnapshot } from "./snapshot.ts";

describe("escapeHtml", () => {
  it("escapes HTML-sensitive characters", () => {
    expect(escapeHtml(`<script>alert("hi") & 'bye'</script>`)).toBe(
      "&lt;script&gt;alert(&quot;hi&quot;) &amp; &#39;bye&#39;&lt;/script&gt;",
    );
  });
});

describe("formatAge", () => {
  it("formats ages across unit boundaries", () => {
    expect(formatAge(null)).toBe("—");
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(45_000)).toBe("45s");
    expect(formatAge(5 * 60_000)).toBe("5m");
    expect(formatAge(3 * 60 * 60_000)).toBe("3h");
    expect(formatAge(2 * 24 * 60 * 60_000)).toBe("2d");
  });

  it("clamps negative ages to zero", () => {
    expect(formatAge(-5000)).toBe("0s");
  });
});

describe("truncateMiddle", () => {
  it("keeps short values intact", () => {
    expect(truncateMiddle("short", 10)).toBe("short");
  });

  it("truncates long values in the middle", () => {
    const result = truncateMiddle("abcdefghijklmnopqrstuvwxyz", 11);
    expect(result).toBe("abcde…vwxyz");
    expect(result.length).toBe(11);
  });
});

describe("formatUtcMinute", () => {
  it("formats ISO timestamps to minute precision", () => {
    expect(formatUtcMinute("2026-07-10T12:34:56.789Z")).toBe("2026-07-10T12:34Z");
  });

  it("passes through unparseable values", () => {
    expect(formatUtcMinute("garbage")).toBe("garbage");
  });
});

describe("renderTrafficSvg", () => {
  it("draws inbound bars in ink and outbound bars in soft ink", () => {
    const svg = renderTrafficSvg([
      { hourStartIso: "2026-07-10T11:00:00.000Z", inbound: 4, outbound: 2 },
      { hourStartIso: "2026-07-10T12:00:00.000Z", inbound: 0, outbound: 1 },
    ]);
    expect(svg).toContain('fill="var(--ink)"');
    expect(svg).toContain('fill="var(--ink-soft)"');
    expect(svg).toContain('stroke="var(--signal)"');
  });

  it("renders no bars for silent buckets", () => {
    const svg = renderTrafficSvg([
      { hourStartIso: "2026-07-10T12:00:00.000Z", inbound: 0, outbound: 0 },
    ]);
    expect(svg).not.toContain("<rect");
  });
});

function buildSnapshot(overrides: Partial<MeshSnapshot> = {}): MeshSnapshot {
  return {
    generatedAt: "2026-07-10T12:00:00.000Z",
    dbPath: "/tmp/broker.db",
    schemaVersion: 18,
    totals: { agents: 1, threads: 2, messages: 3, lanes: 4 },
    agents: [
      {
        id: "agent-1",
        name: "Solar Rust <Dolphin>",
        emoji: "🐬",
        status: "working",
        supervisionState: "root",
        treeDepth: 0,
        parentAgentId: null,
        laneId: null,
        connectedAt: "2026-07-10T10:00:00.000Z",
        lastHeartbeat: "2026-07-10T11:59:30.000Z",
        heartbeatAgeMs: 30_000,
        liveness: "live",
        disconnected: false,
        ownedThreadCount: 2,
      },
    ],
    laneStateCounts: [
      { state: "active", count: 3 },
      { state: "done", count: 1 },
    ],
    openLanes: [
      {
        laneId: "lane-1",
        name: "Sonar lane",
        task: null,
        state: "active",
        issueNumber: 42,
        prNumber: null,
        ownerAgentId: "agent-1",
        participantCount: 2,
        lastActivityAt: "2026-07-10T11:58:00.000Z",
      },
    ],
    trafficTotals: [{ source: "slack", direction: "inbound", count: 3 }],
    trafficLast24h: [{ hourStartIso: "2026-07-10T11:00:00.000Z", inbound: 2, outbound: 1 }],
    busiestThreads24h: [{ threadId: "slack:C1:1.1", source: "slack", count: 3 }],
    recentThreads: [
      {
        threadId: "slack:C1:1.1",
        source: "slack",
        channel: "C1",
        ownerAgent: "agent-1",
        updatedAt: "2026-07-10T11:59:00.000Z",
      },
    ],
    backlogPending: 0,
    openTaskAssignments: [],
    upcomingWakeups: [],
    activePortLeases: [],
    ...overrides,
  };
}

describe("renderSonarHtml", () => {
  it("renders a self-contained datasheet with all five sections", () => {
    const html = renderSonarHtml(buildSnapshot());
    expect(html).toContain("<!doctype html>");
    for (const marker of ["§01", "§02", "§03", "§04", "§05"]) {
      expect(html).toContain(marker);
    }
    for (const title of ["Pod", "Traffic", "Lanes", "Threads", "Duty roster"]) {
      expect(html).toContain(`<h2>${title}</h2>`);
    }
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  it("escapes agent-controlled strings", () => {
    const html = renderSonarHtml(buildSnapshot());
    expect(html).toContain("Solar Rust &lt;Dolphin&gt;");
    expect(html).not.toContain("Solar Rust <Dolphin>");
  });

  it("resolves agent ids to labelled names in lanes and threads", () => {
    const html = renderSonarHtml(buildSnapshot());
    expect(html.match(/🐬 Solar Rust &lt;Dolphin&gt;/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("renders calm empty states for a quiet mesh", () => {
    const html = renderSonarHtml(
      buildSnapshot({
        agents: [],
        laneStateCounts: [],
        openLanes: [],
        trafficTotals: [],
        busiestThreads24h: [],
        recentThreads: [],
      }),
    );
    expect(html).toContain("— no agents registered —");
    expect(html).toContain("— no open lanes —");
    expect(html).toContain("— quiet water: no traffic in 24 h —");
    expect(html).toContain("— no threads —");
    expect(html).toContain("PENDING 0 — clear water");
  });

  it("surfaces pending backlog in signal red", () => {
    const html = renderSonarHtml(buildSnapshot({ backlogPending: 3 }));
    expect(html).toContain("PENDING 3");
    expect(html).toContain('<span class="pip-working">PENDING 3</span>');
  });

  it("respects reduced motion for the single dial animation", () => {
    const html = renderSonarHtml(buildSnapshot());
    expect(html).toContain("prefers-reduced-motion");
    expect(html.match(/animation:/g)?.length).toBe(2); // dial sweep + reduced-motion none
  });
});
