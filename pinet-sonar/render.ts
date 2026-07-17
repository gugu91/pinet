/**
 * Datasheet renderer for pinet-sonar.
 *
 * Renders a MeshSnapshot as a single self-contained HTML page in the
 * repository's standards-document register: two inks (near-black and signal
 * red) on white, system fonts only, § numbered sections, hairline rules.
 * Red is functional annotation only. One animation: the sonar dial sweep,
 * disabled under prefers-reduced-motion.
 */

import type { MeshSnapshot, SonarAgent, SonarTrafficBucket } from "./snapshot.ts";

// ─── Pure formatting helpers ─────────────────────────────

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatAge(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return "—";
  const clamped = Math.max(0, ageMs);
  const seconds = Math.round(clamped / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(1, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

export function formatUtcMinute(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

// ─── Traffic figure ──────────────────────────────────────

/**
 * Render the 24-hour traffic histogram as an inline SVG figure. Inbound bars
 * rise above the baseline in ink; outbound bars hang below in the soft ink.
 * The in-progress hour carries the red "now" tick.
 */
export function renderTrafficSvg(buckets: SonarTrafficBucket[]): string {
  const slot = 40;
  const barWidth = 26;
  const baselineY = 96;
  const upMax = 72;
  const downMax = 40;
  const width = Math.max(1, buckets.length) * slot;
  const height = 150;

  const peak = Math.max(1, ...buckets.map((bucket) => Math.max(bucket.inbound, bucket.outbound)));

  const parts: string[] = [];
  parts.push(
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Hourly mesh traffic, last 24 hours" preserveAspectRatio="none" class="traffic">`,
  );
  parts.push(
    `<line x1="0" y1="${baselineY}" x2="${width}" y2="${baselineY}" stroke="var(--rule-faint)" stroke-width="1" vector-effect="non-scaling-stroke" />`,
  );

  buckets.forEach((bucket, index) => {
    const x = index * slot + (slot - barWidth) / 2;
    const upHeight = Math.round((bucket.inbound / peak) * upMax);
    const downHeight = Math.round((bucket.outbound / peak) * downMax);
    if (upHeight > 0) {
      parts.push(
        `<rect x="${x}" y="${baselineY - upHeight}" width="${barWidth}" height="${upHeight}" fill="var(--ink)" />`,
      );
    }
    if (downHeight > 0) {
      parts.push(
        `<rect x="${x}" y="${baselineY + 1}" width="${barWidth}" height="${downHeight}" fill="var(--ink-soft)" />`,
      );
    }
  });

  const nowX = width - slot / 2;
  parts.push(
    `<line x1="${nowX}" y1="${baselineY - upMax - 6}" x2="${nowX}" y2="${baselineY + downMax + 6}" stroke="var(--signal)" stroke-width="1.5" vector-effect="non-scaling-stroke" />`,
  );
  parts.push("</svg>");
  return parts.join("");
}

// ─── Page ────────────────────────────────────────────────

// agent-standards-ignore prefer-inline-single-use-helper: §01 body builder kept parallel to the other section-body expressions; inlining a 30-line table builder into the page template would bury it.
function podRows(agents: SonarAgent[]): string {
  if (agents.length === 0) {
    return `<tr><td colspan="7" class="empty">— no agents registered —</td></tr>`;
  }
  const ordered = [...agents].sort((a, b) => {
    if (a.status !== b.status) return a.status === "working" ? -1 : 1;
    return (
      (a.heartbeatAgeMs ?? Number.MAX_SAFE_INTEGER) - (b.heartbeatAgeMs ?? Number.MAX_SAFE_INTEGER)
    );
  });
  return ordered
    .map((agent) => {
      const pip =
        agent.status === "working"
          ? `<span class="pip pip-working" title="working">●</span>`
          : `<span class="pip pip-idle" title="idle">○</span>`;
      const indent = agent.treeDepth > 0 ? `${"\u00a0".repeat(agent.treeDepth * 2)}└ ` : "";
      const livenessClass = agent.liveness === "live" ? "" : " dim";
      const state = agent.disconnected ? "disconnected" : agent.supervisionState;
      return `<tr>
        <td class="pipcol">${pip}</td>
        <td>${indent}${escapeHtml(agent.emoji)} ${escapeHtml(agent.name)}</td>
        <td>${escapeHtml(agent.status.toUpperCase())}</td>
        <td class="${livenessClass.trim()}">${escapeHtml(agent.liveness.toUpperCase())}</td>
        <td class="num">${escapeHtml(formatAge(agent.heartbeatAgeMs))}</td>
        <td>${escapeHtml(state.toUpperCase())}</td>
        <td class="num">${agent.ownedThreadCount}</td>
      </tr>`;
    })
    .join("\n");
}

function section(num: string, title: string, bodyHtml: string): string {
  return `<section id="s${num}">
    <div class="s-head"><span class="s-num">§${num}</span><h2>${escapeHtml(title)}</h2></div>
    ${bodyHtml}
  </section>`;
}

export function renderSonarHtml(snapshot: MeshSnapshot): string {
  const agentLabels = new Map<string, string>();
  for (const agent of snapshot.agents) {
    agentLabels.set(agent.id, `${agent.emoji} ${agent.name}`);
  }
  const agentLabel = (id: string | null): string => {
    if (!id) return "—";
    return agentLabels.get(id) ?? truncateMiddle(id, 18);
  };

  const laneStrip =
    snapshot.laneStateCounts.length === 0
      ? "— no lanes recorded —"
      : snapshot.laneStateCounts
          .map((entry) => `${escapeHtml(entry.state.toUpperCase())}\u00a0${entry.count}`)
          .join(" · ");

  const openLaneRows =
    snapshot.openLanes.length === 0
      ? `<tr><td colspan="6" class="empty">— no open lanes —</td></tr>`
      : snapshot.openLanes
          .map((lane) => {
            const title = lane.name ?? lane.task ?? lane.laneId;
            const ref = [
              lane.issueNumber !== null ? `#${lane.issueNumber}` : null,
              lane.prNumber !== null ? `PR\u00a0#${lane.prNumber}` : null,
            ]
              .filter((value) => value !== null)
              .join(" · ");
            const ageMs = Date.parse(lane.lastActivityAt);
            const age = Number.isNaN(ageMs) ? null : Date.parse(snapshot.generatedAt) - ageMs;
            return `<tr>
              <td>${escapeHtml(lane.state.toUpperCase())}</td>
              <td>${escapeHtml(truncateMiddle(title, 72))}</td>
              <td>${escapeHtml(ref || "—")}</td>
              <td>${escapeHtml(agentLabel(lane.ownerAgentId))}</td>
              <td class="num">${lane.participantCount}</td>
              <td class="num">${escapeHtml(formatAge(age))}</td>
            </tr>`;
          })
          .join("\n");

  const trafficTotalRows =
    snapshot.trafficTotals.length === 0
      ? `<tr><td colspan="3" class="empty">— no messages recorded —</td></tr>`
      : snapshot.trafficTotals
          .map(
            (entry) => `<tr>
              <td>${escapeHtml(entry.source.toUpperCase())}</td>
              <td>${escapeHtml(entry.direction.toUpperCase())}</td>
              <td class="num">${entry.count}</td>
            </tr>`,
          )
          .join("\n");

  const busyRows =
    snapshot.busiestThreads24h.length === 0
      ? `<tr><td colspan="3" class="empty">— quiet water: no traffic in 24 h —</td></tr>`
      : snapshot.busiestThreads24h
          .map(
            (thread) => `<tr>
              <td>${escapeHtml(truncateMiddle(thread.threadId, 56))}</td>
              <td>${escapeHtml(thread.source.toUpperCase())}</td>
              <td class="num">${thread.count}</td>
            </tr>`,
          )
          .join("\n");

  const recentThreadRows =
    snapshot.recentThreads.length === 0
      ? `<tr><td colspan="4" class="empty">— no threads —</td></tr>`
      : snapshot.recentThreads
          .map((thread) => {
            const ageMs = Date.parse(thread.updatedAt);
            const age = Number.isNaN(ageMs) ? null : Date.parse(snapshot.generatedAt) - ageMs;
            return `<tr>
              <td>${escapeHtml(truncateMiddle(thread.threadId, 48))}</td>
              <td>${escapeHtml(thread.source.toUpperCase())}</td>
              <td>${escapeHtml(agentLabel(thread.ownerAgent))}</td>
              <td class="num">${escapeHtml(formatAge(age))}</td>
            </tr>`;
          })
          .join("\n");

  const assignmentRows =
    snapshot.openTaskAssignments.length === 0
      ? `<tr><td colspan="4" class="empty">— no open task assignments —</td></tr>`
      : snapshot.openTaskAssignments
          .map(
            (task) => `<tr>
              <td>${escapeHtml(task.repoKey)}\u00a0#${task.issueNumber}</td>
              <td>${escapeHtml(task.taskKind.toUpperCase())}</td>
              <td>${escapeHtml(task.status.toUpperCase())}</td>
              <td>${escapeHtml(agentLabel(task.agentId))}</td>
            </tr>`,
          )
          .join("\n");

  const wakeupRows =
    snapshot.upcomingWakeups.length === 0
      ? `<tr><td colspan="3" class="empty">— no scheduled wakeups —</td></tr>`
      : snapshot.upcomingWakeups
          .map(
            (wakeup) => `<tr>
              <td>${escapeHtml(formatUtcMinute(wakeup.fireAt))}</td>
              <td>${escapeHtml(agentLabel(wakeup.agentId))}</td>
              <td>${escapeHtml(truncateMiddle(wakeup.body, 88))}</td>
            </tr>`,
          )
          .join("\n");

  const leaseRows =
    snapshot.activePortLeases.length === 0
      ? `<tr><td colspan="4" class="empty">— no active port leases —</td></tr>`
      : snapshot.activePortLeases
          .map(
            (lease) => `<tr>
              <td class="num">${lease.port}</td>
              <td>${escapeHtml(lease.host)}</td>
              <td>${escapeHtml(truncateMiddle(lease.purpose, 48))}</td>
              <td>${escapeHtml(agentLabel(lease.ownerAgentId))}</td>
            </tr>`,
          )
          .join("\n");

  const workingCount = snapshot.agents.filter((agent) => agent.status === "working").length;
  const liveCount = snapshot.agents.filter((agent) => agent.liveness === "live").length;
  const traffic24hCount = snapshot.trafficLast24h.reduce(
    (sum, bucket) => sum + bucket.inbound + bucket.outbound,
    0,
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pinet mesh — sonar sweep</title>
<style>
  :root {
    --paper: #ffffff;
    --paper-deep: #f4f0f0;
    --ink: #171112;
    --ink-soft: #5d5254;
    --rule-faint: #ddd4d5;
    --signal: #c8102e;
    --sans: "Helvetica Neue", Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: var(--sans);
    line-height: 1.45;
  }
  main { max-width: 66rem; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
  header.sweep {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1.5rem;
    border-bottom: 3px double var(--ink);
    padding-bottom: 1.25rem;
  }
  header.sweep h1 {
    font-size: 1.9rem;
    font-weight: 700;
    letter-spacing: -0.025em;
    margin: 0 0 0.4rem;
  }
  .doc-line { font-family: var(--mono); font-size: 0.72rem; color: var(--ink-soft); margin: 0.15rem 0; }
  .doc-line .k { color: var(--signal); }
  .dial { flex: none; }
  .dial .needle {
    transform-origin: 50% 50%;
    animation: sweep 8s linear infinite;
  }
  @keyframes sweep { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .dial .needle { animation: none; } }
  section { margin-top: 2.25rem; }
  .s-head {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    border-bottom: 1px solid var(--ink);
    padding-bottom: 0.35rem;
    margin-bottom: 0.75rem;
  }
  .s-num { font-family: var(--mono); font-size: 0.8rem; color: var(--signal); }
  h2 { font-size: 0.95rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; margin: 0; }
  table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 0.76rem; }
  th {
    text-align: left;
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 400;
    color: var(--ink-soft);
    border-bottom: 1px solid var(--rule-faint);
    padding: 0.3rem 0.6rem 0.3rem 0;
  }
  td { border-bottom: 1px solid var(--rule-faint); padding: 0.32rem 0.6rem 0.32rem 0; vertical-align: top; }
  td.num, th.num { text-align: right; }
  td.pipcol { width: 1.2rem; }
  td.empty { color: var(--ink-soft); }
  .dim { color: var(--ink-soft); }
  .pip-working { color: var(--signal); }
  .pip-idle { color: var(--ink-soft); }
  .strip { font-family: var(--mono); font-size: 0.76rem; margin: 0 0 0.9rem; }
  figure { margin: 0 0 1rem; }
  figure svg.traffic { width: 100%; height: 150px; display: block; background: var(--paper-deep); }
  figcaption { font-family: var(--mono); font-size: 0.66rem; color: var(--ink-soft); margin-top: 0.4rem; }
  figcaption .k { color: var(--signal); }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
  @media (max-width: 48rem) { .cols { grid-template-columns: 1fr; } }
  h3 { font-family: var(--mono); font-size: 0.66rem; font-weight: 400; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-soft); margin: 1.1rem 0 0.4rem; }
  footer {
    margin-top: 3rem;
    border-top: 3px double var(--ink);
    padding-top: 0.8rem;
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--ink-soft);
  }
</style>
</head>
<body>
<main>
  <header class="sweep">
    <div>
      <h1>Pinet mesh — sonar sweep</h1>
      <p class="doc-line"><span class="k">SWEPT</span> ${escapeHtml(formatUtcMinute(snapshot.generatedAt))} · <span class="k">DB</span> ${escapeHtml(snapshot.dbPath)} · <span class="k">SCHEMA</span> v${snapshot.schemaVersion}</p>
      <p class="doc-line"><span class="k">AGENTS</span> ${snapshot.totals.agents} (${workingCount} working, ${liveCount} live) · <span class="k">THREADS</span> ${snapshot.totals.threads} · <span class="k">MESSAGES</span> ${snapshot.totals.messages} · <span class="k">LANES</span> ${snapshot.totals.lanes}</p>
    </div>
    <svg class="dial" width="72" height="72" viewBox="0 0 72 72" role="img" aria-label="Sonar dial">
      <circle cx="36" cy="36" r="33" fill="none" stroke="var(--ink)" stroke-width="1.5" />
      <circle cx="36" cy="36" r="22" fill="none" stroke="var(--rule-faint)" stroke-width="1" />
      <circle cx="36" cy="36" r="11" fill="none" stroke="var(--rule-faint)" stroke-width="1" />
      <line class="needle" x1="36" y1="36" x2="36" y2="5" stroke="var(--signal)" stroke-width="1.5" />
      <circle cx="36" cy="36" r="1.6" fill="var(--ink)" />
    </svg>
  </header>

  ${section(
    "01",
    "Pod",
    `<table>
      <thead><tr><th></th><th>Agent</th><th>Status</th><th>Liveness</th><th class="num">Heartbeat</th><th>Supervision</th><th class="num">Threads owned</th></tr></thead>
      <tbody>${podRows(snapshot.agents)}</tbody>
    </table>`,
  )}

  ${section(
    "02",
    "Traffic",
    `<figure>
      ${renderTrafficSvg(snapshot.trafficLast24h)}
      <figcaption><span class="k">Fig. 1</span> — hourly message traffic, trailing 24 h (${traffic24hCount} messages). Ink above the baseline: inbound. Soft ink below: outbound. Red tick: the in-progress hour.</figcaption>
    </figure>
    <div class="cols">
      <div>
        <h3>Totals by source and direction</h3>
        <table>
          <thead><tr><th>Source</th><th>Direction</th><th class="num">Messages</th></tr></thead>
          <tbody>${trafficTotalRows}</tbody>
        </table>
      </div>
      <div>
        <h3>Busiest threads, trailing 24 h</h3>
        <table>
          <thead><tr><th>Thread</th><th>Source</th><th class="num">Messages</th></tr></thead>
          <tbody>${busyRows}</tbody>
        </table>
      </div>
    </div>`,
  )}

  ${section(
    "03",
    "Lanes",
    `<p class="strip">${laneStrip}</p>
    <table>
      <thead><tr><th>State</th><th>Lane</th><th>Refs</th><th>Owner</th><th class="num">Crew</th><th class="num">Last activity</th></tr></thead>
      <tbody>${openLaneRows}</tbody>
    </table>`,
  )}

  ${section(
    "04",
    "Threads",
    `<table>
      <thead><tr><th>Thread</th><th>Source</th><th>Owner</th><th class="num">Updated</th></tr></thead>
      <tbody>${recentThreadRows}</tbody>
    </table>`,
  )}

  ${section(
    "05",
    "Duty roster",
    `<div class="cols">
      <div>
        <h3>Open task assignments</h3>
        <table>
          <thead><tr><th>Task</th><th>Kind</th><th>Status</th><th>Agent</th></tr></thead>
          <tbody>${assignmentRows}</tbody>
        </table>
        <h3>Unrouted backlog</h3>
        <p class="strip">${snapshot.backlogPending === 0 ? "PENDING 0 — clear water" : `<span class="pip-working">PENDING ${snapshot.backlogPending}</span>`}</p>
      </div>
      <div>
        <h3>Scheduled wakeups</h3>
        <table>
          <thead><tr><th>Fire at</th><th>Agent</th><th>Body</th></tr></thead>
          <tbody>${wakeupRows}</tbody>
        </table>
        <h3>Active port leases</h3>
        <table>
          <thead><tr><th class="num">Port</th><th>Host</th><th>Purpose</th><th>Owner</th></tr></thead>
          <tbody>${leaseRows}</tbody>
        </table>
      </div>
    </div>`,
  )}

  <footer>
    One read-only sweep of ${escapeHtml(snapshot.dbPath)} by @pinet/sonar.
    No broker state was modified. The mesh drew this picture of itself.
  </footer>
</main>
</body>
</html>
`;
}
