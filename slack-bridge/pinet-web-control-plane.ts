import * as crypto from "node:crypto";
import * as http from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { redactSensitiveText } from "./activity-log.js";
import type { BrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-dashboard.js";
import type { SlackBridgeSettings } from "./helpers.js";

const DEFAULT_WEB_CONTROL_PLANE_HOST = "127.0.0.1";
const DEFAULT_WEB_CONTROL_PLANE_PORT = 17771;
const DEFAULT_WEB_CONTROL_PLANE_USERNAME = "pinet";
const DEFAULT_WEB_CONTROL_PLANE_PASSWORD_ENV = "PINET_WEB_CONTROL_PLANE_PASSWORD";
const BASIC_REALM = "Pinet Control Plane";

export interface PinetWebControlPlaneSettings {
  enabled?: boolean;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  passwordEnv?: string;
}

export interface ResolvedPinetWebControlPlaneSettings {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface PinetWebControlPlaneDeps {
  getSettings: () => SlackBridgeSettings;
  buildDashboardSnapshot: () => Promise<BrokerControlPlaneDashboardSnapshot | null>;
  env?: NodeJS.ProcessEnv;
}

export interface PinetWebControlPlane {
  start: () => Promise<string | null>;
  stop: () => Promise<void>;
  isStarted: () => boolean;
  getUrl: () => string | null;
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
  settings: SlackBridgeSettings,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPinetWebControlPlaneSettings | null {
  const controlPlane = settings.webControlPlane;
  if (!controlPlane?.enabled) {
    return null;
  }

  const host = normalizeOptionalString(controlPlane.host) ?? DEFAULT_WEB_CONTROL_PLANE_HOST;
  if (!isLoopbackHost(host)) {
    throw new Error(
      "Pinet web control plane host must be loopback-only (127.0.0.1, ::1, or localhost).",
    );
  }

  const username =
    normalizeOptionalString(controlPlane.username) ??
    normalizeOptionalString(env.PINET_WEB_CONTROL_PLANE_USERNAME) ??
    DEFAULT_WEB_CONTROL_PLANE_USERNAME;
  const passwordEnvName =
    normalizeOptionalString(controlPlane.passwordEnv) ?? DEFAULT_WEB_CONTROL_PLANE_PASSWORD_ENV;
  const password =
    normalizeOptionalString(controlPlane.password) ?? normalizeOptionalString(env[passwordEnvName]);

  if (!password) {
    throw new Error(
      `Pinet web control plane requires Basic Auth credentials; set slack-bridge.webControlPlane.password or ${passwordEnvName}.`,
    );
  }

  return {
    enabled: true,
    host,
    port: normalizePort(controlPlane.port),
    username,
    password,
  };
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

function writeMethodNotAllowed(
  res: http.ServerResponse,
  options: { headOnly?: boolean } = {},
): void {
  res.writeHead(405, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    Allow: "GET, HEAD",
  });
  res.end(options.headOnly ? undefined : "Method Not Allowed\n");
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

function stripLaneFreeText(value: string): string {
  const separatorIndex = value.indexOf(" — ");
  return redactSensitiveText(separatorIndex >= 0 ? value.slice(0, separatorIndex) : value);
}

export function buildPinetWebControlPlaneSnapshot(
  snapshot: BrokerControlPlaneDashboardSnapshot,
): BrokerControlPlaneDashboardSnapshot {
  return {
    ...snapshot,
    currentBranch: snapshot.currentBranch ? redactSensitiveText(snapshot.currentBranch) : null,
    ralphSnooze: snapshot.ralphSnooze
      ? {
          ...snapshot.ralphSnooze,
          reason: null,
          source: null,
        }
      : null,
    maintenanceAnomalies: snapshot.maintenanceAnomalies.map(redactSensitiveText),
    anomalies: snapshot.anomalies.map(redactSensitiveText),
    activeTasks: snapshot.activeTasks.map(redactSensitiveText),
    recentOutcomes: snapshot.recentOutcomes.map(redactSensitiveText),
    activeLanes: snapshot.activeLanes.map(stripLaneFreeText),
    detachedLanes: snapshot.detachedLanes.map(stripLaneFreeText),
    roster: snapshot.roster.map((row) => ({
      id: redactSensitiveText(row.id),
      role: redactSensitiveText(row.role),
      label: redactSensitiveText(row.label),
      status: redactSensitiveText(row.status),
      health: redactSensitiveText(row.health),
      workload: redactSensitiveText(row.workload),
      taskSummary: redactSensitiveText(row.taskSummary),
      heartbeat: redactSensitiveText(row.heartbeat),
      branch: redactSensitiveText(row.branch),
      worktree: redactSensitiveText(row.worktree),
    })),
    recentCycles: snapshot.recentCycles.map((cycle) => ({
      ...cycle,
      anomalySummary: redactSensitiveText(cycle.anomalySummary),
    })),
  };
}

function renderList(items: string[]): string {
  if (items.length === 0) return "<li>None</li>";
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n");
}

function renderDashboardHtml(snapshot: BrokerControlPlaneDashboardSnapshot): string {
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
  const recentCycles = snapshot.recentCycles
    .map(
      (cycle) => `
        <tr>
          <td>${escapeHtml(cycle.startedAt)}</td>
          <td>${escapeHtml(cycle.duration)}</td>
          <td>${escapeHtml(cycle.agentCount)}</td>
          <td>${escapeHtml(cycle.backlogCount)}</td>
          <td>${escapeHtml(cycle.ghostCount)}</td>
          <td>${escapeHtml(cycle.stuckCount)}</td>
          <td>${escapeHtml(cycle.anomalySummary)}</td>
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
  <p>Read-only broker dashboard. Auto-refreshes every 30 seconds. JSON: <a href="/api/dashboard"><code>/api/dashboard</code></a>.</p>
  <section class="grid" aria-label="Broker metrics">
    <div class="card"><div>Total agents</div><div class="metric">${escapeHtml(snapshot.totalAgents)}</div></div>
    <div class="card"><div>Live agents</div><div class="metric">${escapeHtml(snapshot.liveAgents)}</div></div>
    <div class="card"><div>Idle workers</div><div class="metric">${escapeHtml(snapshot.idleWorkers)}</div></div>
    <div class="card"><div>Working workers</div><div class="metric">${escapeHtml(snapshot.workingWorkers)}</div></div>
    <div class="card"><div>Pending backlog</div><div class="metric">${escapeHtml(snapshot.pendingBacklogCount)}</div></div>
    <div class="card"><div>Anomalies</div><div class="metric">${escapeHtml(snapshot.anomalies.length + snapshot.maintenanceAnomalies.length)}</div></div>
  </section>
  <h2>State</h2>
  <ul>
    <li>Broker branch: ${escapeHtml(snapshot.currentBranch ?? "unknown")}</li>
    <li>Cycle started: ${escapeHtml(snapshot.cycleStartedAt)}</li>
    <li>RALPH snooze: ${escapeHtml(snapshot.ralphSnooze?.active ? `active until ${snapshot.ralphSnooze.until ?? "unknown"}` : "inactive")}</li>
  </ul>
  <h2>Active tasks</h2>
  <ul>${renderList(snapshot.activeTasks)}</ul>
  <h2>Active lanes</h2>
  <ul>${renderList(snapshot.activeLanes)}</ul>
  <h2>Anomalies</h2>
  <ul>${renderList([...snapshot.anomalies, ...snapshot.maintenanceAnomalies])}</ul>
  <h2>Roster</h2>
  <table>
    <thead><tr><th>Agent</th><th>Role</th><th>Status</th><th>Health</th><th>Workload</th><th>Tasks</th><th>Branch</th><th>Worktree</th></tr></thead>
    <tbody>${rosterRows || '<tr><td colspan="8">No agents</td></tr>'}</tbody>
  </table>
  <h2>Recent cycles</h2>
  <table>
    <thead><tr><th>Started</th><th>Duration</th><th>Agents</th><th>Backlog</th><th>Ghosts</th><th>Stuck</th><th>Anomalies</th></tr></thead>
    <tbody>${recentCycles || '<tr><td colspan="7">No recent cycles</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}

export function createPinetWebControlPlane(deps: PinetWebControlPlaneDeps): PinetWebControlPlane {
  let server: http.Server | null = null;
  let url: string | null = null;

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    credentials: Pick<ResolvedPinetWebControlPlaneSettings, "username" | "password">,
  ): Promise<void> {
    if (!isAuthorized(req.headers.authorization, credentials)) {
      writeUnauthorized(res);
      return;
    }

    const method = req.method ?? "GET";
    const headOnly = method === "HEAD";
    if (method !== "GET" && method !== "HEAD") {
      writeMethodNotAllowed(res, { headOnly: false });
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

    const rawSnapshot = await deps.buildDashboardSnapshot();
    if (!rawSnapshot) {
      writeResponse(
        res,
        503,
        JSON.stringify({ ok: false, error: "broker dashboard is unavailable" }),
        "application/json; charset=utf-8",
        { headOnly },
      );
      return;
    }

    const snapshot = buildPinetWebControlPlaneSnapshot(rawSnapshot);

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

    await stop();
    const nextServer = http.createServer((req, res) => {
      void handleRequest(req, res, resolvedSettings).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        writeResponse(
          res,
          500,
          JSON.stringify({ ok: false, error: message }),
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
