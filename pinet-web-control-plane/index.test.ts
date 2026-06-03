import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDashboardSnapshotFromDb,
  createPinetWebControlPlane,
  redactSensitiveText,
  resolvePinetWebControlPlaneSettings,
  type PinetWebControlPlaneDashboardSnapshot,
} from "./index.js";

const snapshot: PinetWebControlPlaneDashboardSnapshot = {
  generatedAt: "2026-06-03T08:00:00.000Z",
  dbPath: "/tmp/pinet-broker.db",
  totalAgents: 2,
  liveAgents: 2,
  brokerCount: 1,
  workerCount: 1,
  idleWorkers: 1,
  workingWorkers: 0,
  pendingBacklogCount: 0,
  taskCounts: {
    assigned: 1,
    branchPushed: 0,
    openPrs: 0,
    mergedPrs: 0,
    closedPrs: 0,
  },
  activeTasks: ["#771 assigned"],
  recentOutcomes: [],
  activeLanes: ["issue-771 [active] (#771) owner worker-1"],
  detachedLanes: [],
  roster: [
    {
      id: "broker-1",
      role: "broker",
      label: "🦦 The Broker Otter <script>",
      status: "working",
      health: "live",
      workload: "0 inbox / 0 threads",
      taskSummary: "—",
      heartbeat: "now",
      branch: "main",
      worktree: "main checkout",
    },
  ],
};

function basicAuth(username = "pinet", password = "secret"): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      status TEXT NOT NULL,
      last_heartbeat TEXT,
      metadata TEXT,
      disconnected_at TEXT
    );
    CREATE TABLE inbox (agent_id TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE threads (owner_agent TEXT);
    CREATE TABLE unrouted_backlog (status TEXT NOT NULL);
    CREATE TABLE task_assignments (
      agent_id TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      branch TEXT,
      pr_number INTEGER,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE pinet_lanes (
      lane_id TEXT NOT NULL,
      issue_number INTEGER,
      pr_number INTEGER,
      owner_agent_id TEXT,
      implementation_lead_agent_id TEXT,
      pm_mode INTEGER NOT NULL,
      state TEXT NOT NULL,
      summary TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO agents (id, name, emoji, status, last_heartbeat, metadata, disconnected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "broker-1",
    "The Broker Otter",
    "🦦",
    "working",
    "2026-06-03T08:00:00.000Z",
    JSON.stringify({ role: "broker", branch: "main", worktreeKind: "main" }),
    null,
  );
  db.prepare(
    `INSERT INTO agents (id, name, emoji, status, last_heartbeat, metadata, disconnected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "worker-1",
    "Worker Crane",
    "🦩",
    "idle",
    "2026-06-03T08:01:00.000Z",
    JSON.stringify({
      role: "worker",
      branch: "feat/web-control-plane token=xoxb-secret",
      worktreeKind: "linked",
      worktreePath: "/tmp/worktree password=hunter2",
    }),
    null,
  );
  db.prepare("INSERT INTO inbox (agent_id, delivered) VALUES (?, 0)").run("worker-1");
  db.prepare("INSERT INTO threads (owner_agent) VALUES (?)").run("worker-1");
  db.prepare("INSERT INTO unrouted_backlog (status) VALUES ('pending')").run();
  db.prepare(
    `INSERT INTO task_assignments (agent_id, issue_number, branch, pr_number, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("worker-1", 771, "feat/web-control-plane", null, "assigned", "2026-06-03T08:02:00.000Z");
  db.prepare(
    `INSERT INTO pinet_lanes (lane_id, issue_number, pr_number, owner_agent_id, implementation_lead_agent_id, pm_mode, state, summary, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "issue-771",
    771,
    null,
    "worker-1",
    "worker-1",
    1,
    "active",
    "free text prompt token=xoxb-secret",
    "2026-06-03T08:03:00.000Z",
  );
  return db;
}

describe("pinet web control plane package metadata", () => {
  it("declares a standalone pi extension package", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      name?: string;
      pi?: { extensions?: string[] };
    };

    expect(pkg.name).toBe("@gugu910/pi-pinet-web-control-plane");
    expect(pkg.pi?.extensions).toEqual(["./dist/index.js"]);
  });
});

describe("resolvePinetWebControlPlaneSettings", () => {
  it("is disabled unless explicitly enabled", () => {
    expect(resolvePinetWebControlPlaneSettings({}, {})).toBeNull();
  });

  it("requires Basic Auth credentials when enabled", () => {
    expect(() => resolvePinetWebControlPlaneSettings({ enabled: true }, {})).toThrow(
      "requires Basic Auth credentials",
    );
  });

  it("accepts a password from the configured environment variable", () => {
    expect(
      resolvePinetWebControlPlaneSettings(
        { enabled: true, port: 0, passwordEnv: "PINET_TEST_PASSWORD" },
        { PINET_TEST_PASSWORD: "secret" },
      ),
    ).toMatchObject({ host: "127.0.0.1", username: "pinet", password: "secret" });
  });

  it("rejects non-loopback hosts", () => {
    expect(() =>
      resolvePinetWebControlPlaneSettings(
        { enabled: true, host: "0.0.0.0", password: "secret" },
        {},
      ),
    ).toThrow("loopback-only");
  });

  it("does not treat hostnames that start with 127 as loopback literals", () => {
    expect(() =>
      resolvePinetWebControlPlaneSettings(
        { enabled: true, host: "127.example.test", password: "secret" },
        {},
      ),
    ).toThrow("loopback-only");
  });
});

describe("buildDashboardSnapshotFromDb", () => {
  it("builds a web-safe read-only broker snapshot without raw lane summaries", () => {
    const db = createDb();
    try {
      const webSnapshot = buildDashboardSnapshotFromDb(db, {
        dbPath: "/tmp/pinet-broker.db",
        now: new Date("2026-06-03T08:04:00.000Z"),
      });

      expect(webSnapshot).toMatchObject({
        totalAgents: 2,
        liveAgents: 2,
        brokerCount: 1,
        workerCount: 1,
        pendingBacklogCount: 1,
        activeTasks: ["#771 assigned"],
        activeLanes: ["issue-771 [active] (#771 · PM) owner worker-1 lead worker-1"],
      });
      const serialized = JSON.stringify(webSnapshot);
      expect(serialized).not.toContain("free text prompt");
      expect(serialized).not.toContain("xoxb-secret");
      expect(serialized).not.toContain("hunter2");
    } finally {
      db.close();
    }
  });
});

describe("redactSensitiveText", () => {
  it("redacts Slack/app/Bearer/JSON/env token-shaped values", () => {
    const redacted = redactSensitiveText(
      'token=xoxb-secret xapp-1-secret Bearer secret123 {"token":"abc123"} SLACK_BOT_TOKEN=xoxb-hidden PASSWORD=hunter2',
    );

    expect(redacted).toContain("token= [REDACTED]");
    expect(redacted).toContain("Bearer [REDACTED]");
    expect(redacted).not.toContain("xapp-1-secret");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("xoxb-hidden");
    expect(redacted).not.toContain("hunter2");
  });
});

describe("createPinetWebControlPlane", () => {
  const servers: Array<ReturnType<typeof createPinetWebControlPlane>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  it("does not start unless the current process owns the broker lock by default", async () => {
    const controlPlane = createPinetWebControlPlane({
      getSettings: () => ({ enabled: true, port: 0, password: "secret" }),
      buildDashboardSnapshot: async () => snapshot,
      isBrokerLeader: () => false,
    });
    servers.push(controlPlane);

    await expect(controlPlane.start()).resolves.toBeNull();
    expect(controlPlane.isStarted()).toBe(false);
  });

  it("stops serving if broker ownership is lost", async () => {
    let brokerLeader = true;
    const controlPlane = createPinetWebControlPlane({
      getSettings: () => ({ enabled: true, port: 0, password: "secret" }),
      buildDashboardSnapshot: async () => snapshot,
      isBrokerLeader: () => brokerLeader,
    });
    servers.push(controlPlane);

    const url = await controlPlane.start();
    brokerLeader = false;
    const response = await fetch(new URL("/api/dashboard", url!), {
      headers: { Authorization: basicAuth() },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "web control plane is only available in the active broker process",
    });

    for (let attempt = 0; attempt < 10 && controlPlane.isStarted(); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(controlPlane.isStarted()).toBe(false);

    const handoffPort = Number(new URL(url!).port);
    const newLeaderControlPlane = createPinetWebControlPlane({
      getSettings: () => ({ enabled: true, port: handoffPort, password: "secret" }),
      buildDashboardSnapshot: async () => snapshot,
      isBrokerLeader: () => true,
    });
    servers.push(newLeaderControlPlane);

    await expect(newLeaderControlPlane.start()).resolves.toBe(`http://127.0.0.1:${handoffPort}/`);
  });

  it("serves authenticated dashboard JSON", async () => {
    const controlPlane = createPinetWebControlPlane({
      getSettings: () => ({ enabled: true, port: 0, password: "secret", requireBrokerLock: false }),
      buildDashboardSnapshot: async () => snapshot,
    });
    servers.push(controlPlane);

    const url = await controlPlane.start();
    const response = await fetch(new URL("/api/dashboard", url!), {
      headers: { Authorization: basicAuth() },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      activeTasks: ["#771 assigned"],
    });
  });

  it("challenges unauthenticated requests", async () => {
    const controlPlane = createPinetWebControlPlane({
      getSettings: () => ({ enabled: true, port: 0, password: "secret", requireBrokerLock: false }),
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
      getSettings: () => ({ enabled: true, port: 0, password: "secret", requireBrokerLock: false }),
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
      getSettings: () => ({ enabled: true, port: 0, password: "secret", requireBrokerLock: false }),
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
      getSettings: () => ({ enabled: true, port: 0, password: "secret", requireBrokerLock: false }),
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
