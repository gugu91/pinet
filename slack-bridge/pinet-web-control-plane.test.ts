import { afterEach, describe, expect, it } from "vitest";
import type { BrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-dashboard.js";
import {
  buildPinetWebControlPlaneSnapshot,
  createPinetWebControlPlane,
  resolvePinetWebControlPlaneSettings,
} from "./pinet-web-control-plane.js";

const snapshot: BrokerControlPlaneDashboardSnapshot = {
  cycleStartedAt: "2026-06-03T08:00:00.000Z",
  cycleDurationMs: 0,
  currentBranch: "feat/web-control-plane-771",
  ralphSnooze: null,
  totalAgents: 2,
  liveAgents: 2,
  brokerCount: 1,
  workerCount: 1,
  idleWorkers: 1,
  workingWorkers: 0,
  ghostAgents: 0,
  stuckAgents: 0,
  pendingBacklogCount: 0,
  nudgesThisCycle: 0,
  idleDrainCandidates: 0,
  assignedBacklogCount: 0,
  reapedAgents: 0,
  repairedThreadClaims: 0,
  maintenanceAnomalies: [],
  anomalies: [],
  taskCounts: {
    assigned: 0,
    branchPushed: 0,
    openPrs: 0,
    mergedPrs: 0,
    closedPrs: 0,
  },
  activeTasks: ["#771 assigned"],
  recentOutcomes: [],
  activeLanes: [],
  detachedLanes: [],
  roster: [
    {
      id: "broker-1",
      role: "broker",
      label: "🦦 The Broker Otter <script>",
      status: "working",
      health: "healthy",
      workload: "0 inbox / 0 threads",
      taskSummary: "—",
      heartbeat: "now",
      branch: "main",
      worktree: "main checkout",
    },
  ],
  recentCycles: [],
};

function basicAuth(username = "pinet", password = "secret"): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("resolvePinetWebControlPlaneSettings", () => {
  it("is disabled unless explicitly enabled", () => {
    expect(resolvePinetWebControlPlaneSettings({}, {})).toBeNull();
  });

  it("requires Basic Auth credentials when enabled", () => {
    expect(() =>
      resolvePinetWebControlPlaneSettings({ webControlPlane: { enabled: true } }, {}),
    ).toThrow("requires Basic Auth credentials");
  });

  it("accepts a password from the configured environment variable", () => {
    expect(
      resolvePinetWebControlPlaneSettings(
        { webControlPlane: { enabled: true, port: 0, passwordEnv: "PINET_TEST_PASSWORD" } },
        { PINET_TEST_PASSWORD: "secret" },
      ),
    ).toMatchObject({ host: "127.0.0.1", username: "pinet", password: "secret" });
  });

  it("rejects non-loopback hosts", () => {
    expect(() =>
      resolvePinetWebControlPlaneSettings(
        { webControlPlane: { enabled: true, host: "0.0.0.0", password: "secret" } },
        {},
      ),
    ).toThrow("loopback-only");
  });

  it("does not treat hostnames that start with 127 as loopback literals", () => {
    expect(() =>
      resolvePinetWebControlPlaneSettings(
        { webControlPlane: { enabled: true, host: "127.example.test", password: "secret" } },
        {},
      ),
    ).toThrow("loopback-only");
  });
});

describe("createPinetWebControlPlane", () => {
  const servers: Array<ReturnType<typeof createPinetWebControlPlane>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  it("redacts free-form and secret-shaped broker text from the web snapshot", () => {
    const webSnapshot = buildPinetWebControlPlaneSnapshot({
      ...snapshot,
      ralphSnooze: {
        active: true,
        until: "2026-06-03T09:00:00.000Z",
        reason: "operator pasted token=xoxb-secret",
        source: "password=hunter2",
        emptyCycleCount: 1,
      },
      activeLanes: ["issue-771 [active] (#771) owner worker — password=hunter2 prompt draft"],
      anomalies: [
        'adapter failed token=xoxb-secret xapp-1-secret Bearer secret123 {"token":"abc123"} SLACK_BOT_TOKEN=xoxb-hidden',
      ],
    });

    expect(webSnapshot.ralphSnooze).toMatchObject({ reason: null, source: null });
    expect(webSnapshot.activeLanes).toEqual(["issue-771 [active] (#771) owner worker"]);
    const serialized = JSON.stringify(webSnapshot);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("xoxb-secret");
    expect(serialized).not.toContain("xapp-1-secret");
    expect(serialized).not.toContain("Bearer secret123");
    expect(serialized).not.toContain('"token":"abc123"');
    expect(serialized).not.toContain("xoxb-hidden");
    expect(webSnapshot.anomalies[0]).toContain("token= [REDACTED]");
    expect(webSnapshot.anomalies[0]).toContain("Bearer [REDACTED]");
  });

  it("serves authenticated dashboard JSON", async () => {
    const controlPlane = createPinetWebControlPlane({
      getSettings: () => ({ webControlPlane: { enabled: true, port: 0, password: "secret" } }),
      buildDashboardSnapshot: async () => snapshot,
    });
    servers.push(controlPlane);

    const url = await controlPlane.start();
    const response = await fetch(new URL("/api/dashboard", url!), {
      headers: { Authorization: basicAuth() },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      currentBranch: "feat/web-control-plane-771",
      activeTasks: ["#771 assigned"],
    });
  });

  it("challenges unauthenticated requests", async () => {
    const controlPlane = createPinetWebControlPlane({
      getSettings: () => ({ webControlPlane: { enabled: true, port: 0, password: "secret" } }),
      buildDashboardSnapshot: async () => snapshot,
    });
    servers.push(controlPlane);

    const url = await controlPlane.start();
    const response = await fetch(new URL("/api/dashboard", url!));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
  });

  it("rejects non-read HTTP methods", async () => {
    const controlPlane = createPinetWebControlPlane({
      getSettings: () => ({ webControlPlane: { enabled: true, port: 0, password: "secret" } }),
      buildDashboardSnapshot: async () => snapshot,
    });
    servers.push(controlPlane);

    const url = await controlPlane.start();
    const response = await fetch(new URL("/api/dashboard", url!), {
      method: "POST",
      headers: { Authorization: basicAuth() },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("serves escaped read-only HTML", async () => {
    const controlPlane = createPinetWebControlPlane({
      getSettings: () => ({ webControlPlane: { enabled: true, port: 0, password: "secret" } }),
      buildDashboardSnapshot: async () => snapshot,
    });
    servers.push(controlPlane);

    const url = await controlPlane.start();
    const response = await fetch(url!, { headers: { Authorization: basicAuth() } });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Pinet Control Plane");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("The Broker Otter <script>");
  });

  it("returns 503 when the broker snapshot is unavailable", async () => {
    const controlPlane = createPinetWebControlPlane({
      getSettings: () => ({ webControlPlane: { enabled: true, port: 0, password: "secret" } }),
      buildDashboardSnapshot: async () => null,
    });
    servers.push(controlPlane);

    const url = await controlPlane.start();
    const response = await fetch(new URL("/api/dashboard", url!), {
      headers: { Authorization: basicAuth() },
    });

    expect(response.status).toBe(503);
  });
});
