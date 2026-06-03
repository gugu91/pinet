import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import { isIP, type AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultLockPath } from "@gugu910/pi-broker-core/leader";
import { getDefaultDbPath } from "@gugu910/pi-broker-core/paths";

const SETTINGS_KEY = "pinet-web-control-plane";
const DEFAULT_WEB_CONTROL_PLANE_HOST = "127.0.0.1";
const DEFAULT_WEB_CONTROL_PLANE_PORT = 17771;
const DEFAULT_WEB_CONTROL_PLANE_USERNAME = "pinet";
const DEFAULT_WEB_CONTROL_PLANE_PASSWORD_ENV = "PINET_WEB_CONTROL_PLANE_PASSWORD";
const BASIC_REALM = "Pinet Control Plane";
const REDACTED = "[REDACTED]";

export interface PinetWebControlPlaneSettings {
  enabled?: boolean;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  passwordEnv?: string;
  dbPath?: string;
  lockPath?: string;
  requireBrokerLock?: boolean;
}

export interface ResolvedPinetWebControlPlaneSettings {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
  dbPath: string;
  lockPath: string;
  requireBrokerLock: boolean;
}

export interface PinetWebControlPlaneDeps {
  getSettings: () => PinetWebControlPlaneSettings;
  buildDashboardSnapshot: () => Promise<PinetWebControlPlaneDashboardSnapshot | null>;
  isBrokerLeader?: (settings: ResolvedPinetWebControlPlaneSettings) => boolean;
  env?: NodeJS.ProcessEnv;
}

export interface PinetWebControlPlane {
  start: () => Promise<string | null>;
  stop: () => Promise<void>;
  isStarted: () => boolean;
  getUrl: () => string | null;
}

export interface PinetWebControlPlaneDashboardSnapshot {
  generatedAt: string;
  dbPath: string;
  totalAgents: number;
  liveAgents: number;
  brokerCount: number;
  workerCount: number;
  idleWorkers: number;
  workingWorkers: number;
  pendingBacklogCount: number;
  taskCounts: {
    assigned: number;
    branchPushed: number;
    openPrs: number;
    mergedPrs: number;
    closedPrs: number;
  };
  activeTasks: string[];
  recentOutcomes: string[];
  activeLanes: string[];
  detachedLanes: string[];
  roster: PinetWebControlPlaneAgentRow[];
}

export interface PinetWebControlPlaneAgentRow {
  id: string;
  role: string;
  label: string;
  status: string;
  health: string;
  workload: string;
  taskSummary: string;
  heartbeat: string;
  branch: string;
  worktree: string;
}

interface AgentRow {
  id: string;
  name: string;
  emoji: string;
  status: string;
  last_heartbeat: string | null;
  metadata: string | null;
  disconnected_at: string | null;
}

interface TaskAssignmentRow {
  agent_id: string;
  issue_number: number;
  branch: string | null;
  pr_number: number | null;
  status: string;
  updated_at: string;
}

interface PinetLaneRow {
  lane_id: string;
  issue_number: number | null;
  pr_number: number | null;
  owner_agent_id: string | null;
  implementation_lead_agent_id: string | null;
  pm_mode: number;
  state: string;
  updated_at: string;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizePort(value: number | undefined): number {
  const port = value ?? DEFAULT_WEB_CONTROL_PLANE_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Pinet web control plane port must be an integer between 0 and 65535.");
  }
  return port;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  if (isIP(normalized) !== 4) {
    return false;
  }
  return normalized.split(".")[0] === "127";
}

export function resolvePinetWebControlPlaneSettings(
  settings: PinetWebControlPlaneSettings,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPinetWebControlPlaneSettings | null {
  if (!settings.enabled) {
    return null;
  }

  const host = normalizeOptionalString(settings.host) ?? DEFAULT_WEB_CONTROL_PLANE_HOST;
  if (!isLoopbackHost(host)) {
    throw new Error(
      "Pinet web control plane host must be loopback-only (127.0.0.1, ::1, or localhost).",
    );
  }

  const username =
    normalizeOptionalString(settings.username) ??
    normalizeOptionalString(env.PINET_WEB_CONTROL_PLANE_USERNAME) ??
    DEFAULT_WEB_CONTROL_PLANE_USERNAME;
  const passwordEnvName =
    normalizeOptionalString(settings.passwordEnv) ?? DEFAULT_WEB_CONTROL_PLANE_PASSWORD_ENV;
  const password =
    normalizeOptionalString(settings.password) ?? normalizeOptionalString(env[passwordEnvName]);

  if (!password) {
    throw new Error(
      `Pinet web control plane requires Basic Auth credentials; set ${SETTINGS_KEY}.password or ${passwordEnvName}.`,
    );
  }

  return {
    enabled: true,
    host,
    port: normalizePort(settings.port),
    username,
    password,
    dbPath: normalizeOptionalString(settings.dbPath) ?? getDefaultDbPath(),
    lockPath: normalizeOptionalString(settings.lockPath) ?? defaultLockPath(),
    requireBrokerLock: settings.requireBrokerLock !== false,
  };
}

export function isCurrentProcessBrokerLeader(lockPath = defaultLockPath()): boolean {
  try {
    const content = fs.readFileSync(lockPath, "utf-8").trim();
    return content === String(process.pid);
  } catch {
    return false;
  }
}

function timingSafeStringEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicAuth(
  authorization: string | undefined,
): { username: string; password: string } | null {
  if (!authorization?.startsWith("Basic ")) {
    return null;
  }

  const encoded = authorization.slice("Basic ".length).trim();
  let decoded = "";
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex < 0) {
    return null;
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

function isAuthorized(
  authorization: string | undefined,
  credentials: Pick<ResolvedPinetWebControlPlaneSettings, "username" | "password">,
): boolean {
  const parsed = parseBasicAuth(authorization);
  if (!parsed) {
    return false;
  }

  return (
    timingSafeStringEquals(parsed.username, credentials.username) &&
    timingSafeStringEquals(parsed.password, credentials.password)
  );
}

function writeResponse(
  res: http.ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
  options: { headOnly?: boolean } = {},
): void {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(options.headOnly ? undefined : body);
}

function writeMethodNotAllowed(res: http.ServerResponse): void {
  res.writeHead(405, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    Allow: "GET, HEAD",
  });
  res.end("Method Not Allowed\n");
}

function writeUnauthorized(res: http.ServerResponse): void {
  res.writeHead(401, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "WWW-Authenticate": `Basic realm="${BASIC_REALM}"`,
  });
  res.end("Unauthorized\n");
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function redactSensitiveText(value: string): string {
  let redacted = value.replace(/\r\n/g, "\n").replaceAll("\u0000", "").trim();
  const replacements: Array<[RegExp, string]> = [
    [/(?:xox[baprs]|xapp)-[A-Za-z0-9-]+/g, REDACTED],
    [/xoxe\.[A-Za-z0-9.-]+/g, REDACTED],
    [/(Bearer\s+)[^\s]+/gi, `$1${REDACTED}`],
    [
      /\b(token|password|passwd|secret|api[_-]?key|authorization)\b\s*([:=])\s*([^\s,;]+)/gi,
      `$1$2 ${REDACTED}`,
    ],
    [
      /("(?:token|password|secret|api[_-]?key|authorization)"\s*:\s*")([^"]+)(")/gi,
      `$1${REDACTED}$3`,
    ],
    [/(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*\b)=([^\s]+)/g, `$1=${REDACTED}`],
  ];

  for (const [pattern, replacement] of replacements) {
    redacted = redacted.replace(pattern, replacement);
  }

  return redacted.length > 2800 ? `${redacted.slice(0, 2797).trimEnd()}...` : redacted;
}

function renderList(items: string[]): string {
  if (items.length === 0) return "<li>None</li>";
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n");
}

function renderDashboardHtml(snapshot: PinetWebControlPlaneDashboardSnapshot): string {
  const rosterRows = snapshot.roster
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.label)}</td>
          <td>${escapeHtml(row.role)}</td>
          <td>${escapeHtml(row.status)}</td>
          <td>${escapeHtml(row.health)}</td>
          <td>${escapeHtml(row.workload)}</td>
          <td>${escapeHtml(row.taskSummary)}</td>
          <td>${escapeHtml(row.branch)}</td>
          <td>${escapeHtml(row.worktree)}</td>
        </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>Pinet Control Plane</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 2rem; line-height: 1.4; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.75rem; }
    .card { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 0.75rem; padding: 1rem; }
    .metric { font-size: 1.75rem; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { border-bottom: 1px solid color-mix(in srgb, CanvasText 16%, transparent); padding: 0.45rem; text-align: left; vertical-align: top; }
    th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
    code { background: color-mix(in srgb, CanvasText 8%, transparent); border-radius: 0.25rem; padding: 0.1rem 0.25rem; }
  </style>
</head>
<body>
  <h1>Pinet Control Plane</h1>
  <p>Read-only local broker dashboard. Auto-refreshes every 30 seconds. JSON: <a href="/api/dashboard"><code>/api/dashboard</code></a>.</p>
  <section class="grid" aria-label="Broker metrics">
    <div class="card"><div>Total agents</div><div class="metric">${escapeHtml(snapshot.totalAgents)}</div></div>
    <div class="card"><div>Live agents</div><div class="metric">${escapeHtml(snapshot.liveAgents)}</div></div>
    <div class="card"><div>Idle workers</div><div class="metric">${escapeHtml(snapshot.idleWorkers)}</div></div>
    <div class="card"><div>Working workers</div><div class="metric">${escapeHtml(snapshot.workingWorkers)}</div></div>
    <div class="card"><div>Pending backlog</div><div class="metric">${escapeHtml(snapshot.pendingBacklogCount)}</div></div>
    <div class="card"><div>Open PR tasks</div><div class="metric">${escapeHtml(snapshot.taskCounts.openPrs)}</div></div>
  </section>
  <h2>State</h2>
  <ul>
    <li>Generated: ${escapeHtml(snapshot.generatedAt)}</li>
    <li>Database: ${escapeHtml(snapshot.dbPath)}</li>
  </ul>
  <h2>Active tasks</h2>
  <ul>${renderList(snapshot.activeTasks)}</ul>
  <h2>Active lanes</h2>
  <ul>${renderList(snapshot.activeLanes)}</ul>
  <h2>Roster</h2>
  <table>
    <thead><tr><th>Agent</th><th>Role</th><th>Status</th><th>Health</th><th>Workload</th><th>Tasks</th><th>Branch</th><th>Worktree</th></tr></thead>
    <tbody>${rosterRows || '<tr><td colspan="8">No agents</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getNestedString(record: Record<string, unknown>, pathSegments: string[]): string | null {
  let current: unknown = record;
  for (const segment of pathSegments) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim() ? current : null;
}

function getAgentRole(metadata: Record<string, unknown>): string {
  return (
    getNestedString(metadata, ["capabilities", "role"]) ??
    getNestedString(metadata, ["role"]) ??
    "worker"
  );
}

function getAgentBranch(metadata: Record<string, unknown>): string {
  return redactSensitiveText(getNestedString(metadata, ["branch"]) ?? "—");
}

function getAgentWorktree(metadata: Record<string, unknown>): string {
  const kind = getNestedString(metadata, ["worktreeKind"]);
  if (kind === "main") return "main checkout";
  if (kind === "linked")
    return redactSensitiveText(getNestedString(metadata, ["worktreePath"]) ?? "linked");
  return "—";
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { present: number } | undefined;
  return row !== undefined;
}

function countRows(
  db: DatabaseSync,
  sql: string,
  ...values: Array<string | number | null>
): number {
  const row = db.prepare(sql).get(...values) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

function listAgents(db: DatabaseSync): AgentRow[] {
  if (!tableExists(db, "agents")) return [];
  return db
    .prepare(
      `SELECT id, name, emoji, status, last_heartbeat, metadata, disconnected_at
       FROM agents
       ORDER BY name COLLATE NOCASE`,
    )
    .all() as unknown as AgentRow[];
}

function listTaskAssignments(db: DatabaseSync): TaskAssignmentRow[] {
  if (!tableExists(db, "task_assignments")) return [];
  return db
    .prepare(
      `SELECT agent_id, issue_number, branch, pr_number, status, updated_at
       FROM task_assignments
       ORDER BY updated_at DESC`,
    )
    .all() as unknown as TaskAssignmentRow[];
}

function listPinetLanes(db: DatabaseSync): PinetLaneRow[] {
  if (!tableExists(db, "pinet_lanes")) return [];
  return db
    .prepare(
      `SELECT lane_id, issue_number, pr_number, owner_agent_id, implementation_lead_agent_id,
              pm_mode, state, updated_at
       FROM pinet_lanes
       ORDER BY updated_at DESC`,
    )
    .all() as unknown as PinetLaneRow[];
}

function formatTaskStatusShort(assignment: TaskAssignmentRow): string {
  switch (assignment.status) {
    case "pr_open":
      return `#${assignment.issue_number} PR #${assignment.pr_number ?? "?"} open`;
    case "pr_merged":
      return `#${assignment.issue_number} PR #${assignment.pr_number ?? "?"} merged`;
    case "pr_closed":
      return `#${assignment.issue_number} PR #${assignment.pr_number ?? "?"} closed`;
    case "branch_pushed":
      return `#${assignment.issue_number} pushed ${redactSensitiveText(assignment.branch ?? "branch")}`;
    case "assigned":
    default:
      return `#${assignment.issue_number} assigned`;
  }
}

function formatLaneStatusShort(lane: PinetLaneRow): string {
  const refs = [
    lane.issue_number != null ? `#${lane.issue_number}` : null,
    lane.pr_number != null ? `PR #${lane.pr_number}` : null,
    lane.pm_mode ? "PM" : null,
  ].filter((ref): ref is string => Boolean(ref));
  const owner = lane.owner_agent_id ? ` owner ${redactSensitiveText(lane.owner_agent_id)}` : "";
  const lead = lane.implementation_lead_agent_id
    ? ` lead ${redactSensitiveText(lane.implementation_lead_agent_id)}`
    : "";
  return `${redactSensitiveText(lane.lane_id)} [${redactSensitiveText(lane.state)}]${refs.length > 0 ? ` (${refs.join(" · ")})` : ""}${owner}${lead}`;
}

function summarizeAgentTasks(assignments: TaskAssignmentRow[]): string {
  if (assignments.length === 0) return "—";
  const visible = assignments.slice(0, 2).map(formatTaskStatusShort);
  if (assignments.length > 2) {
    visible.push(`+${assignments.length - 2} more`);
  }
  return visible.join("; ");
}

export function buildDashboardSnapshotFromDb(
  db: DatabaseSync,
  options: { dbPath: string; now?: Date } = { dbPath: getDefaultDbPath() },
): PinetWebControlPlaneDashboardSnapshot {
  const agents = listAgents(db);
  const assignments = listTaskAssignments(db);
  const lanes = listPinetLanes(db);
  const assignmentsByAgent = new Map<string, TaskAssignmentRow[]>();
  for (const assignment of assignments) {
    const bucket = assignmentsByAgent.get(assignment.agent_id);
    if (bucket) {
      bucket.push(assignment);
    } else {
      assignmentsByAgent.set(assignment.agent_id, [assignment]);
    }
  }

  const roster = agents.map((agent) => {
    const metadata = parseMetadata(agent.metadata);
    const role = getAgentRole(metadata);
    const pendingInboxCount = tableExists(db, "inbox")
      ? countRows(
          db,
          "SELECT COUNT(*) AS count FROM inbox WHERE agent_id = ? AND delivered = 0",
          agent.id,
        )
      : 0;
    const ownedThreadCount = tableExists(db, "threads")
      ? countRows(db, "SELECT COUNT(*) AS count FROM threads WHERE owner_agent = ?", agent.id)
      : 0;
    const health = agent.disconnected_at ? "disconnected" : "live";
    return {
      id: redactSensitiveText(agent.id),
      role: redactSensitiveText(role),
      label: `${redactSensitiveText(agent.emoji)} ${redactSensitiveText(agent.name)}`,
      status: redactSensitiveText(agent.status === "working" ? "working" : "idle"),
      health,
      workload: `${pendingInboxCount} inbox / ${ownedThreadCount} thread${ownedThreadCount === 1 ? "" : "s"}`,
      taskSummary: redactSensitiveText(summarizeAgentTasks(assignmentsByAgent.get(agent.id) ?? [])),
      heartbeat: redactSensitiveText(agent.last_heartbeat ?? "unknown"),
      branch: getAgentBranch(metadata),
      worktree: getAgentWorktree(metadata),
    };
  });

  const liveAgents = agents.filter((agent) => !agent.disconnected_at).length;
  const brokerCount = roster.filter((agent) => agent.role === "broker").length;
  const workerRows = roster.filter((agent) => agent.role !== "broker");
  const visibleAssignments = assignments.filter((assignment) => assignment.status !== "pr_closed");

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    dbPath: redactSensitiveText(options.dbPath),
    totalAgents: agents.length,
    liveAgents,
    brokerCount,
    workerCount: workerRows.length,
    idleWorkers: workerRows.filter((agent) => agent.status === "idle").length,
    workingWorkers: workerRows.filter((agent) => agent.status === "working").length,
    pendingBacklogCount: tableExists(db, "unrouted_backlog")
      ? countRows(db, "SELECT COUNT(*) AS count FROM unrouted_backlog WHERE status = 'pending'")
      : 0,
    taskCounts: {
      assigned: visibleAssignments.filter((assignment) => assignment.status === "assigned").length,
      branchPushed: visibleAssignments.filter((assignment) => assignment.status === "branch_pushed")
        .length,
      openPrs: visibleAssignments.filter((assignment) => assignment.status === "pr_open").length,
      mergedPrs: visibleAssignments.filter((assignment) => assignment.status === "pr_merged")
        .length,
      closedPrs: assignments.filter((assignment) => assignment.status === "pr_closed").length,
    },
    activeTasks: visibleAssignments
      .filter(
        (assignment) =>
          assignment.status === "assigned" ||
          assignment.status === "branch_pushed" ||
          assignment.status === "pr_open",
      )
      .map((assignment) => redactSensitiveText(formatTaskStatusShort(assignment)))
      .slice(0, 8),
    recentOutcomes: assignments
      .filter(
        (assignment) => assignment.status === "pr_merged" || assignment.status === "pr_closed",
      )
      .map((assignment) => redactSensitiveText(formatTaskStatusShort(assignment)))
      .slice(0, 8),
    activeLanes: lanes
      .filter(
        (lane) => lane.state !== "done" && lane.state !== "cancelled" && lane.state !== "detached",
      )
      .map(formatLaneStatusShort)
      .slice(0, 8),
    detachedLanes: lanes
      .filter((lane) => lane.state === "detached")
      .map(formatLaneStatusShort)
      .slice(0, 8),
    roster,
  };
}

export async function buildDashboardSnapshotFromDbPath(
  dbPath: string,
): Promise<PinetWebControlPlaneDashboardSnapshot | null> {
  if (!fs.existsSync(dbPath)) {
    return null;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return buildDashboardSnapshotFromDb(db, { dbPath });
  } finally {
    db.close();
  }
}

export function createPinetWebControlPlane(deps: PinetWebControlPlaneDeps): PinetWebControlPlane {
  let server: http.Server | null = null;
  let leaderMonitor: ReturnType<typeof setInterval> | null = null;
  let url: string | null = null;

  function hasBrokerLeadership(settings: ResolvedPinetWebControlPlaneSettings): boolean {
    return deps.isBrokerLeader?.(settings) ?? isCurrentProcessBrokerLeader(settings.lockPath);
  }

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    resolvedSettings: ResolvedPinetWebControlPlaneSettings,
  ): Promise<void> {
    if (!isAuthorized(req.headers.authorization, resolvedSettings)) {
      writeUnauthorized(res);
      return;
    }

    const method = req.method ?? "GET";
    const headOnly = method === "HEAD";
    if (method !== "GET" && method !== "HEAD") {
      writeMethodNotAllowed(res);
      return;
    }

    if (resolvedSettings.requireBrokerLock && !hasBrokerLeadership(resolvedSettings)) {
      writeResponse(
        res,
        503,
        JSON.stringify({
          ok: false,
          error: "web control plane is only available in the active broker process",
        }),
        "application/json; charset=utf-8",
        { headOnly },
      );
      res.once("finish", () => {
        void stop().catch(() => {
          /* best effort */
        });
      });
      return;
    }

    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/healthz") {
      writeResponse(
        res,
        200,
        JSON.stringify({ ok: true, service: "pinet-web-control-plane" }),
        "application/json; charset=utf-8",
        { headOnly },
      );
      return;
    }

    const snapshot = await deps.buildDashboardSnapshot();
    if (!snapshot) {
      writeResponse(
        res,
        503,
        JSON.stringify({ ok: false, error: "broker dashboard is unavailable" }),
        "application/json; charset=utf-8",
        { headOnly },
      );
      return;
    }

    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
      writeResponse(res, 200, renderDashboardHtml(snapshot), "text/html; charset=utf-8", {
        headOnly,
      });
      return;
    }

    if (requestUrl.pathname === "/api/dashboard" || requestUrl.pathname === "/dashboard.json") {
      writeResponse(
        res,
        200,
        JSON.stringify(snapshot, null, 2),
        "application/json; charset=utf-8",
        { headOnly },
      );
      return;
    }

    writeResponse(
      res,
      404,
      JSON.stringify({ ok: false, error: "not found" }),
      "application/json; charset=utf-8",
      { headOnly },
    );
  }

  async function stop(): Promise<void> {
    if (leaderMonitor) {
      clearInterval(leaderMonitor);
      leaderMonitor = null;
    }

    const activeServer = server;
    if (!activeServer) {
      url = null;
      return;
    }

    server = null;
    url = null;
    await new Promise<void>((resolve, reject) => {
      activeServer.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async function start(): Promise<string | null> {
    const resolvedSettings = resolvePinetWebControlPlaneSettings(deps.getSettings(), deps.env);
    if (!resolvedSettings) {
      await stop();
      return null;
    }

    if (resolvedSettings.requireBrokerLock && !hasBrokerLeadership(resolvedSettings)) {
      await stop();
      return null;
    }

    await stop();
    const nextServer = http.createServer((req, res) => {
      void handleRequest(req, res, resolvedSettings).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        writeResponse(
          res,
          500,
          JSON.stringify({ ok: false, error: redactSensitiveText(message) }),
          "application/json; charset=utf-8",
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      nextServer.once("error", reject);
      nextServer.listen({ host: resolvedSettings.host, port: resolvedSettings.port }, () => {
        nextServer.off("error", reject);
        resolve();
      });
    });

    server = nextServer;
    if (resolvedSettings.requireBrokerLock) {
      leaderMonitor = setInterval(() => {
        if (!hasBrokerLeadership(resolvedSettings)) {
          void stop().catch(() => {
            /* best effort */
          });
        }
      }, 1_000);
      leaderMonitor.unref?.();
    }
    const address = nextServer.address() as AddressInfo;
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
    url = `http://${host}:${address.port}/`;
    return url;
  }

  return {
    start,
    stop,
    isStarted: () => server != null,
    getUrl: () => url,
  };
}

export function loadSettings(settingsPath?: string): PinetWebControlPlaneSettings {
  const resolvedPath = settingsPath ?? path.join(os.homedir(), ".pi", "agent", "settings.json");
  try {
    const content = fs.readFileSync(resolvedPath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const settings = parsed[SETTINGS_KEY];
    return typeof settings === "object" && settings !== null && !Array.isArray(settings)
      ? (settings as PinetWebControlPlaneSettings)
      : {};
  } catch {
    return {};
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function (pi: ExtensionAPI) {
  const controlPlane = createPinetWebControlPlane({
    getSettings: () => loadSettings(),
    buildDashboardSnapshot: async () => {
      const resolvedSettings = resolvePinetWebControlPlaneSettings(loadSettings());
      if (!resolvedSettings) return null;
      return buildDashboardSnapshotFromDbPath(resolvedSettings.dbPath);
    },
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const settings = loadSettings();
    if (!settings.enabled) {
      return;
    }

    try {
      const startedUrl = await controlPlane.start();
      if (startedUrl) {
        ctx.ui.notify(`Pinet web control plane listening at ${startedUrl}`, "info");
      }
    } catch (err) {
      console.error(`[pinet-web-control-plane] start failed: ${msg(err)}`);
      ctx.ui.notify(`Pinet web control plane unavailable: ${msg(err)}`, "warning");
    }
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    try {
      await controlPlane.stop();
    } catch (err) {
      console.error(`[pinet-web-control-plane] stop failed: ${msg(err)}`);
      ctx.ui.notify(`Pinet web control plane stop failed: ${msg(err)}`, "warning");
    }
  });
}
