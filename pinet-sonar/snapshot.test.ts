import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { BrokerDB } from "@pinet/broker-core";
import {
  LIVE_HEARTBEAT_MAX_MS,
  RECENT_HEARTBEAT_MAX_MS,
  bucketHourlyTraffic,
  classifyLiveness,
  getDefaultBrokerDbPath,
  parseIsoMs,
  readMeshSnapshot,
} from "./snapshot.ts";

describe("classifyLiveness", () => {
  it("classifies missing heartbeats as stale", () => {
    expect(classifyLiveness(null)).toBe("stale");
  });

  it("classifies fresh heartbeats as live up to the boundary", () => {
    expect(classifyLiveness(0)).toBe("live");
    expect(classifyLiveness(LIVE_HEARTBEAT_MAX_MS)).toBe("live");
    expect(classifyLiveness(LIVE_HEARTBEAT_MAX_MS + 1)).toBe("recent");
  });

  it("classifies old heartbeats as stale past the recent boundary", () => {
    expect(classifyLiveness(RECENT_HEARTBEAT_MAX_MS)).toBe("recent");
    expect(classifyLiveness(RECENT_HEARTBEAT_MAX_MS + 1)).toBe("stale");
  });
});

describe("parseIsoMs", () => {
  it("parses ISO timestamps", () => {
    expect(parseIsoMs("2026-07-10T12:00:00.000Z")).toBe(Date.parse("2026-07-10T12:00:00.000Z"));
  });

  it("returns null for empty and invalid values", () => {
    expect(parseIsoMs(null)).toBeNull();
    expect(parseIsoMs(undefined)).toBeNull();
    expect(parseIsoMs("")).toBeNull();
    expect(parseIsoMs("not-a-date")).toBeNull();
  });
});

describe("bucketHourlyTraffic", () => {
  const nowMs = Date.parse("2026-07-10T12:30:00.000Z");

  it("produces one aligned bucket per hour", () => {
    const buckets = bucketHourlyTraffic([], nowMs, 24);
    expect(buckets).toHaveLength(24);
    expect(buckets[23]?.hourStartIso).toBe("2026-07-10T12:00:00.000Z");
    expect(buckets[0]?.hourStartIso).toBe("2026-07-09T13:00:00.000Z");
  });

  it("counts inbound and outbound into the right buckets", () => {
    const buckets = bucketHourlyTraffic(
      [
        { createdAt: "2026-07-10T12:05:00.000Z", direction: "inbound" },
        { createdAt: "2026-07-10T12:59:59.000Z", direction: "outbound" },
        { createdAt: "2026-07-10T11:00:00.000Z", direction: "inbound" },
      ],
      nowMs,
      24,
    );
    expect(buckets[23]).toMatchObject({ inbound: 1, outbound: 1 });
    expect(buckets[22]).toMatchObject({ inbound: 1, outbound: 0 });
  });

  it("ignores rows outside the window and unparseable timestamps", () => {
    const buckets = bucketHourlyTraffic(
      [
        { createdAt: "2026-07-09T12:59:59.000Z", direction: "inbound" },
        { createdAt: "2026-07-11T00:00:00.000Z", direction: "inbound" },
        { createdAt: "garbage", direction: "inbound" },
      ],
      nowMs,
      24,
    );
    expect(buckets.every((bucket) => bucket.inbound === 0 && bucket.outbound === 0)).toBe(true);
  });
});

describe("getDefaultBrokerDbPath", () => {
  it("points at ~/.pi/pinet-broker.db", () => {
    expect(getDefaultBrokerDbPath()).toBe(path.join(os.homedir(), ".pi", "pinet-broker.db"));
  });
});

describe("readMeshSnapshot", () => {
  let tempDir: string | null = null;
  let fixtureDb: DatabaseSync | null = null;

  afterEach(() => {
    fixtureDb?.close();
    fixtureDb = null;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function createFixtureDb(): { dbPath: string; db: DatabaseSync } {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-sonar-test-"));
    const dbPath = path.join(tempDir, "broker.db");

    // Run the real broker migrations so the fixture matches production schema.
    const broker = new BrokerDB(dbPath);
    broker.initialize();
    broker.close();

    fixtureDb = new DatabaseSync(dbPath);
    return { dbPath, db: fixtureDb };
  }

  it("sweeps agents, lanes, traffic, threads, and the duty roster", () => {
    const { dbPath, db } = createFixtureDb();
    const now = new Date("2026-07-10T12:30:00.000Z");
    const nowIso = now.toISOString();
    const earlier = "2026-07-10T12:28:00.000Z";
    const longAgo = "2026-07-09T00:00:00.000Z";

    db.prepare(
      `INSERT INTO agents (id, name, emoji, pid, connected_at, last_seen, last_heartbeat, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("agent-1", "Solar Rust Dolphin", "🐬", 111, longAgo, earlier, earlier, "working");
    db.prepare(
      `INSERT INTO agents (id, name, emoji, pid, connected_at, last_seen, last_heartbeat, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("agent-2", "Frozen Hazel Whale", "🐋", 222, longAgo, longAgo, longAgo, "idle");

    db.prepare(
      `INSERT INTO threads (thread_id, source, channel, owner_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("slack:C1:1.1", "slack", "C1", "agent-1", longAgo, earlier);

    const insertMessage = db.prepare(
      `INSERT INTO messages (thread_id, source, direction, sender, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertMessage.run("slack:C1:1.1", "slack", "inbound", "user", "ping", earlier);
    insertMessage.run("slack:C1:1.1", "slack", "outbound", "agent-1", "pong", earlier);
    insertMessage.run("slack:C1:1.1", "agent", "inbound", "agent-2", "old", longAgo);

    db.prepare(
      `INSERT INTO pinet_lanes (lane_id, name, state, owner_agent_id, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("lane-1", "Sonar lane", "active", "agent-1", longAgo, earlier, earlier);
    db.prepare(
      `INSERT INTO pinet_lanes (lane_id, name, state, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("lane-2", "Finished lane", "done", longAgo, longAgo, longAgo);
    db.prepare(
      `INSERT INTO pinet_lane_participants (lane_id, agent_id, lane_role, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("lane-1", "agent-1", "lead", longAgo, earlier, earlier);

    db.prepare(
      `INSERT INTO unrouted_backlog (thread_id, channel, message_id, reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("slack:C1:1.1", "C1", 1, "no owner", "pending", earlier, earlier);

    db.prepare(
      `INSERT INTO task_assignments (agent_id, issue_number, status, thread_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("agent-1", 42, "pr_open", "slack:C1:1.1", longAgo, earlier);

    db.prepare(
      `INSERT INTO scheduled_wakeups (agent_id, thread_id, body, fire_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("agent-1", "slack:C1:1.1", "chase the follow-up", "2026-07-11T09:00:00.000Z", earlier);

    db.prepare(
      `INSERT INTO port_leases (id, purpose, port, host, owner_agent_id, status, acquired_at, renewed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "lease-1",
      "dev server",
      4321,
      "127.0.0.1",
      "agent-1",
      "active",
      earlier,
      earlier,
      "2026-07-10T13:00:00.000Z",
    );

    const snapshot = readMeshSnapshot({ dbPath, now });

    expect(snapshot.generatedAt).toBe(nowIso);
    expect(snapshot.schemaVersion).toBeGreaterThanOrEqual(18);
    expect(snapshot.totals).toEqual({ agents: 2, threads: 1, messages: 3, lanes: 2 });

    const dolphin = snapshot.agents.find((agent) => agent.id === "agent-1");
    expect(dolphin).toMatchObject({
      name: "Solar Rust Dolphin",
      emoji: "🐬",
      status: "working",
      liveness: "live",
      ownedThreadCount: 1,
      disconnected: false,
    });
    const whale = snapshot.agents.find((agent) => agent.id === "agent-2");
    expect(whale).toMatchObject({ status: "idle", liveness: "stale", ownedThreadCount: 0 });

    expect(snapshot.laneStateCounts).toEqual(
      expect.arrayContaining([
        { state: "active", count: 1 },
        { state: "done", count: 1 },
      ]),
    );
    expect(snapshot.openLanes).toHaveLength(1);
    expect(snapshot.openLanes[0]).toMatchObject({
      laneId: "lane-1",
      state: "active",
      participantCount: 1,
      ownerAgentId: "agent-1",
    });

    expect(snapshot.trafficTotals).toEqual(
      expect.arrayContaining([
        { source: "slack", direction: "inbound", count: 1 },
        { source: "slack", direction: "outbound", count: 1 },
        { source: "agent", direction: "inbound", count: 1 },
      ]),
    );
    const lastBucket = snapshot.trafficLast24h.at(-1);
    expect(lastBucket).toMatchObject({ inbound: 1, outbound: 1 });
    expect(snapshot.busiestThreads24h[0]).toMatchObject({ threadId: "slack:C1:1.1", count: 2 });

    expect(snapshot.recentThreads[0]).toMatchObject({
      threadId: "slack:C1:1.1",
      ownerAgent: "agent-1",
    });

    expect(snapshot.backlogPending).toBe(1);
    expect(snapshot.openTaskAssignments[0]).toMatchObject({
      agentId: "agent-1",
      issueNumber: 42,
      status: "pr_open",
    });
    expect(snapshot.upcomingWakeups[0]).toMatchObject({ body: "chase the follow-up" });
    expect(snapshot.activePortLeases[0]).toMatchObject({ port: 4321, purpose: "dev server" });
  });

  it("does not modify the database", () => {
    const { dbPath, db } = createFixtureDb();
    db.prepare(
      `INSERT INTO agents (id, name, emoji, pid, connected_at, last_seen, last_heartbeat, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "agent-1",
      "Sentinel",
      "🦈",
      1,
      "2026-07-10T00:00:00.000Z",
      "2026-07-10T00:00:00.000Z",
      "2026-07-10T00:00:00.000Z",
      "idle",
    );

    const before = fs.statSync(dbPath).size;
    readMeshSnapshot({ dbPath, now: new Date("2026-07-10T12:00:00.000Z") });
    expect(fs.statSync(dbPath).size).toBe(before);
  });

  it("sweeps an empty just-migrated database without errors", () => {
    const { dbPath } = createFixtureDb();
    const snapshot = readMeshSnapshot({ dbPath, now: new Date("2026-07-10T12:00:00.000Z") });
    expect(snapshot.totals).toEqual({ agents: 0, threads: 0, messages: 0, lanes: 0 });
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.trafficLast24h).toHaveLength(24);
    expect(snapshot.backlogPending).toBe(0);
  });
});
