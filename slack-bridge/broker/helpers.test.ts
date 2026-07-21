import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { BrokerDB as CoreBrokerDB } from "@pinet/broker-core/schema";
import { BrokerDB, CURRENT_BROKER_SCHEMA_VERSION } from "./schema.js";
import { LeaderLock } from "./leader.js";
import { startBroker, type Broker } from "./index.js";
import { runBrokerMaintenancePass } from "./maintenance.js";
import { BrokerSocketServer } from "./socket-server.js";
import { buildTaskAssignmentReport } from "../task-assignments.js";
import { buildSlackCompatibilityScope } from "../helpers.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

// ─── Helpers ─────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "broker-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * JSON-RPC client over TCP for testing.
 */
class RpcClient {
  private socket: net.Socket;
  private buffer = "";
  private pending = new Map<
    number | string,
    { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf-8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        const response = JSON.parse(line) as JsonRpcResponse;
        const id = response.id;
        if (id !== null && this.pending.has(id)) {
          this.pending.get(id)!.resolve(response);
          this.pending.delete(id);
        }
      }
    });
  }

  call(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify(request) + "\n");
    });
  }

  destroy(): void {
    this.socket.destroy();
    for (const p of this.pending.values()) {
      p.reject(new Error("Connection destroyed"));
    }
    this.pending.clear();
  }
}

function connectClient(info: { type: "tcp"; host: string; port: number }): Promise<RpcClient> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: info.host, port: info.port }, () => {
      resolve(new RpcClient(socket));
    });
    socket.on("error", reject);
  });
}

function connectRawSocket(info: { type: "tcp"; host: string; port: number }): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: info.host, port: info.port }, () => {
      resolve(socket);
    });
    socket.on("error", reject);
  });
}

// ─── Schema tests ────────────────────────────────────────

describe("BrokerDB", () => {
  let dir: string;
  let db: BrokerDB;

  beforeEach(() => {
    dir = tmpDir();
    db = new BrokerDB(path.join(dir, "test.db"));
    db.initialize();
  });

  afterEach(() => {
    db.close();
    cleanup(dir);
  });

  it("creates tables without error", () => {
    // initialize() already ran — just verify we can query
    expect(db.getAgents()).toEqual([]);
  });

  it("keeps RALPH cycle storage out of the broker-core base schema", () => {
    const coreDbPath = path.join(dir, "core.db");
    const coreDb = new CoreBrokerDB(coreDbPath);
    coreDb.initialize();
    coreDb.close();

    const inspectDb = new DatabaseSync(coreDbPath);
    const ralphTable = inspectDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ralph_cycles'")
      .get() as { name?: string } | undefined;
    inspectDb.close();

    expect(ralphTable).toBeUndefined();
  });

  it("migrates a legacy agents table and stamps the schema version", () => {
    const dbPath = path.join(dir, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        pid INTEGER NOT NULL,
        connected_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
    `);
    legacyDb
      .prepare(
        `INSERT INTO agents (id, name, emoji, pid, connected_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-1",
        "Legacy Agent",
        "🧓",
        42,
        "2026-04-01T10:00:00.000Z",
        "2026-04-01T10:05:00.000Z",
      );
    legacyDb.close();

    const migratedDb = new BrokerDB(dbPath);
    expect(() => migratedDb.initialize()).not.toThrow();

    const migratedAgent = migratedDb.getAgentById("legacy-1");
    expect(migratedAgent?.lastHeartbeat).toBe("2026-04-01T10:05:00.000Z");
    expect(migratedAgent?.disconnectedAt).toBeTruthy();
    expect(migratedDb.getAgents()).toEqual([]);
    migratedDb.close();

    const inspectDb = new DatabaseSync(dbPath);
    const versionRow = inspectDb.prepare("PRAGMA user_version").get() as { user_version: number };
    const columns = inspectDb.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
    const backlogColumns = inspectDb.prepare("PRAGMA table_info(unrouted_backlog)").all() as Array<{
      name: string;
    }>;
    const taskAssignmentTable = inspectDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_assignments'")
      .get() as { name: string } | undefined;
    inspectDb.close();

    expect(versionRow.user_version).toBe(CURRENT_BROKER_SCHEMA_VERSION);
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "stable_id",
        "metadata",
        "status",
        "last_heartbeat",
        "disconnected_at",
        "resumable_until",
      ]),
    );
    expect(backlogColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["preferred_agent_id"]),
    );
    expect(taskAssignmentTable?.name).toBe("task_assignments");
  });

  it("adds backlog recipient-affinity columns when migrating from schema v3", () => {
    const dbPath = path.join(dir, "legacy-backlog.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY NOT NULL,
        stable_id TEXT,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        pid INTEGER NOT NULL,
        connected_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        last_heartbeat TEXT,
        metadata TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        disconnected_at TEXT,
        resumable_until TEXT
      );

      CREATE TABLE unrouted_backlog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        message_id INTEGER NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'assigned', 'dropped')),
        assigned_agent_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      PRAGMA user_version = 3;
    `);
    legacyDb.close();

    const migratedDb = new BrokerDB(dbPath);
    expect(() => migratedDb.initialize()).not.toThrow();
    migratedDb.close();

    const inspectDb = new DatabaseSync(dbPath);
    const versionRow = inspectDb.prepare("PRAGMA user_version").get() as { user_version: number };
    const backlogColumns = inspectDb.prepare("PRAGMA table_info(unrouted_backlog)").all() as Array<{
      name: string;
    }>;
    inspectDb.close();

    expect(versionRow.user_version).toBe(CURRENT_BROKER_SCHEMA_VERSION);
    expect(backlogColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["preferred_agent_id"]),
    );
  });

  it("adds task assignment tracking when migrating from schema v5", () => {
    const dbPath = path.join(dir, "legacy-task-assignments.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY NOT NULL,
        stable_id TEXT,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        pid INTEGER NOT NULL,
        connected_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        last_heartbeat TEXT,
        metadata TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        disconnected_at TEXT,
        resumable_until TEXT,
        idle_since TEXT,
        last_activity TEXT
      );

      CREATE TABLE unrouted_backlog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        message_id INTEGER NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'assigned', 'dropped')),
        preferred_agent_id TEXT,
        assigned_agent_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE ralph_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        ghost_agent_ids TEXT NOT NULL DEFAULT '[]',
        nudge_agent_ids TEXT NOT NULL DEFAULT '[]',
        idle_drain_agent_ids TEXT NOT NULL DEFAULT '[]',
        stuck_agent_ids TEXT NOT NULL DEFAULT '[]',
        anomalies TEXT NOT NULL DEFAULT '[]',
        anomaly_signature TEXT NOT NULL DEFAULT '',
        follow_up_delivered INTEGER NOT NULL DEFAULT 0,
        agent_count INTEGER NOT NULL DEFAULT 0,
        backlog_count INTEGER NOT NULL DEFAULT 0
      );

      PRAGMA user_version = 5;
    `);
    legacyDb.close();

    const migratedDb = new BrokerDB(dbPath);
    expect(() => migratedDb.initialize()).not.toThrow();
    migratedDb.close();

    const inspectDb = new DatabaseSync(dbPath);
    const versionRow = inspectDb.prepare("PRAGMA user_version").get() as { user_version: number };
    const taskAssignmentColumns = inspectDb
      .prepare("PRAGMA table_info(task_assignments)")
      .all() as Array<{
      name: string;
    }>;
    inspectDb.close();

    expect(versionRow.user_version).toBe(CURRENT_BROKER_SCHEMA_VERSION);
    expect(taskAssignmentColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "agent_id",
        "issue_number",
        "branch",
        "pr_number",
        "status",
        "thread_id",
        "source_message_id",
      ]),
    );
  });

  it("migrates schema v6 task assignments to issue-owned rows and keeps the latest reassignment", () => {
    const dbPath = path.join(dir, "legacy-task-assignment-ownership.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY NOT NULL,
        stable_id TEXT,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        pid INTEGER NOT NULL,
        connected_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        last_heartbeat TEXT,
        metadata TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        disconnected_at TEXT,
        resumable_until TEXT,
        idle_since TEXT,
        last_activity TEXT
      );

      CREATE TABLE task_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        branch TEXT,
        pr_number INTEGER,
        status TEXT NOT NULL DEFAULT 'assigned'
          CHECK(status IN ('assigned', 'branch_pushed', 'pr_open', 'pr_merged', 'pr_closed')),
        thread_id TEXT NOT NULL,
        source_message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, issue_number)
      );

      CREATE INDEX idx_task_assignments_agent_status
        ON task_assignments(agent_id, status, updated_at DESC);
      CREATE INDEX idx_task_assignments_branch
        ON task_assignments(branch);

      INSERT INTO task_assignments (
        agent_id,
        issue_number,
        branch,
        pr_number,
        status,
        thread_id,
        source_message_id,
        created_at,
        updated_at
      ) VALUES
        (
          'worker-1',
          114,
          'feat/ralph-completion-v1',
          201,
          'pr_open',
          'a2a:broker:worker-1',
          42,
          '2026-04-02T10:00:00.000Z',
          '2026-04-02T10:05:00.000Z'
        ),
        (
          'worker-2',
          114,
          'feat/ralph-completion-v2',
          NULL,
          'assigned',
          'a2a:broker:worker-2',
          43,
          '2026-04-02T10:06:00.000Z',
          '2026-04-02T10:10:00.000Z'
        );

      PRAGMA user_version = 6;
    `);
    legacyDb.close();

    const migratedDb = new BrokerDB(dbPath);
    expect(() => migratedDb.initialize()).not.toThrow();

    const assignments = migratedDb.listTaskAssignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      agentId: "worker-2",
      issueNumber: 114,
      branch: "feat/ralph-completion-v2",
      status: "assigned",
      prNumber: null,
      sourceMessageId: 43,
    });
    migratedDb.close();

    const inspectDb = new DatabaseSync(dbPath);
    const versionRow = inspectDb.prepare("PRAGMA user_version").get() as { user_version: number };
    inspectDb.close();

    expect(versionRow.user_version).toBe(CURRENT_BROKER_SCHEMA_VERSION);
  });

  it("adds scheduled wake-up tracking when migrating from schema v7", () => {
    const dbPath = path.join(dir, "legacy-scheduled-wakeups.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY NOT NULL,
        stable_id TEXT,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        pid INTEGER NOT NULL,
        connected_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        last_heartbeat TEXT,
        metadata TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        disconnected_at TEXT,
        resumable_until TEXT,
        idle_since TEXT,
        last_activity TEXT
      );

      CREATE TABLE task_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        branch TEXT,
        pr_number INTEGER,
        status TEXT NOT NULL DEFAULT 'assigned'
          CHECK(status IN ('assigned', 'branch_pushed', 'pr_open', 'pr_merged', 'pr_closed')),
        thread_id TEXT NOT NULL,
        source_message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(issue_number)
      );

      PRAGMA user_version = 7;
    `);
    legacyDb.close();

    const migratedDb = new BrokerDB(dbPath);
    expect(() => migratedDb.initialize()).not.toThrow();
    migratedDb.close();

    const inspectDb = new DatabaseSync(dbPath);
    const versionRow = inspectDb.prepare("PRAGMA user_version").get() as { user_version: number };
    const columns = inspectDb.prepare("PRAGMA table_info(scheduled_wakeups)").all() as Array<{
      name: string;
    }>;
    inspectDb.close();

    expect(versionRow.user_version).toBe(CURRENT_BROKER_SCHEMA_VERSION);
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "agent_id",
        "agent_stable_id",
        "thread_id",
        "body",
        "fire_at",
        "created_at",
      ]),
    );
  });

  it("backfills scheduled wake-up stable ids when migrating from schema v8", () => {
    const dbPath = path.join(dir, "legacy-scheduled-wakeups-v8.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY NOT NULL,
        stable_id TEXT,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        pid INTEGER NOT NULL,
        connected_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        last_heartbeat TEXT,
        metadata TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        disconnected_at TEXT,
        resumable_until TEXT,
        idle_since TEXT,
        last_activity TEXT
      );

      CREATE TABLE task_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        branch TEXT,
        pr_number INTEGER,
        status TEXT NOT NULL DEFAULT 'assigned'
          CHECK(status IN ('assigned', 'branch_pushed', 'pr_open', 'pr_merged', 'pr_closed')),
        thread_id TEXT NOT NULL,
        source_message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(issue_number)
      );

      CREATE TABLE scheduled_wakeups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        body TEXT NOT NULL,
        fire_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      INSERT INTO agents (
        id, stable_id, name, emoji, pid,
        connected_at, last_seen, last_heartbeat,
        metadata, status, disconnected_at, resumable_until,
        idle_since, last_activity
      ) VALUES (
        'worker-1', 'host:session:/tmp/worker-1', 'Worker', '⏰', 1,
        '2026-04-02T14:00:00.000Z', '2026-04-02T14:00:00.000Z', '2026-04-02T14:00:00.000Z',
        NULL, 'idle', NULL, NULL,
        '2026-04-02T14:00:00.000Z', NULL
      );

      INSERT INTO scheduled_wakeups (agent_id, thread_id, body, fire_at, created_at)
      VALUES (
        'worker-1',
        'wakeup:worker-1',
        'Wake me later',
        '2026-04-02T14:05:00.000Z',
        '2026-04-02T14:00:00.000Z'
      );

      PRAGMA user_version = 8;
    `);
    legacyDb.close();

    const migratedDb = new BrokerDB(dbPath);
    expect(() => migratedDb.initialize()).not.toThrow();
    migratedDb.close();

    const inspectDb = new DatabaseSync(dbPath);
    const row = inspectDb
      .prepare("SELECT agent_stable_id FROM scheduled_wakeups WHERE agent_id = ?")
      .get("worker-1") as { agent_stable_id: string | null };
    inspectDb.close();

    expect(row.agent_stable_id).toBe("host:session:/tmp/worker-1");
  });

  it("recreates an invalid database file from scratch instead of crashing", () => {
    const dbPath = path.join(dir, "invalid.db");
    fs.writeFileSync(dbPath, "not a sqlite database", "utf-8");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const recreatedDb = new BrokerDB(dbPath);
    expect(() => recreatedDb.initialize()).not.toThrow();
    expect(recreatedDb.getAgents()).toEqual([]);
    recreatedDb.close();

    const inspectDb = new DatabaseSync(dbPath);
    const versionRow = inspectDb.prepare("PRAGMA user_version").get() as { user_version: number };
    inspectDb.close();

    expect(errorSpy).toHaveBeenCalled();
    expect(versionRow.user_version).toBe(CURRENT_BROKER_SCHEMA_VERSION);
    errorSpy.mockRestore();
  });

  it("registerAgent and getAgents", () => {
    const agent = db.registerAgent("a1", "TestAgent", "🤖", 1234);
    expect(agent.id).toBe("a1");
    expect(agent.name).toBe("TestAgent");
    expect(agent.emoji).toBe("🤖");
    expect(agent.pid).toBe(1234);

    const agents = db.getAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("a1");
  });

  it("registerAgent stores typed Pinet subtree hierarchy metadata", () => {
    const parent = db.registerAgent("parent", "Parent", "🧭", 100);
    const child = db.registerAgent("child", "Child", "🪴", 101, {
      parentAgentId: parent.id,
      spawnedByAgentId: parent.id,
      launchId: "launch-1",
      subtreeRole: "reviewer",
      laneId: "issue-761",
    });

    expect(child).toMatchObject({
      parentAgentId: parent.id,
      rootAgentId: parent.id,
      treeDepth: 1,
      spawnedByAgentId: parent.id,
      supervisionState: "supervised",
      launchId: "launch-1",
      subtreeRole: "reviewer",
      laneId: "issue-761",
    });
    expect(db.getAgentDescendants(parent.id).map((agent) => agent.id)).toEqual(["child"]);
  });

  it("unregisterAgent orphans descendants and notifies supervised parents when children exit", () => {
    db.registerAgent("parent", "Parent", "🧭", 100);
    db.registerAgent("child", "Child", "🪴", 101, { parentAgentId: "parent" });
    db.registerAgent("grandchild", "Grandchild", "🌱", 102, { parentAgentId: "child" });

    db.unregisterAgent("child");

    expect(db.getAgentById("grandchild")).toMatchObject({
      parentAgentId: null,
      supervisionState: "orphaned",
    });
    const parentInbox = db.readInbox("parent", { unreadOnly: false, markRead: false });
    expect(parentInbox.messages[0]?.message.body).toContain("Child worker Child (child) exited");
    const grandchildInbox = db.readInbox("grandchild", { unreadOnly: false, markRead: false });
    expect(grandchildInbox.messages[0]?.message.metadata).toMatchObject({
      lifecycle: "parent_orphaned_child",
      parentAgentId: "child",
      childAgentId: "grandchild",
    });
  });

  it("rejects dead parents and hierarchy cycles during subtree registration", () => {
    db.registerAgent("parent", "Parent", "🧭", 100);
    db.registerAgent("child", "Child", "🪴", 101, { parentAgentId: "parent" });

    expect(() =>
      db.registerAgent("parent", "Parent", "🧭", 100, { parentAgentId: "child" }),
    ).toThrow("descendants");

    db.unregisterAgent("parent");
    expect(() =>
      db.registerAgent("new-child", "New Child", "🌱", 102, { parentAgentId: "parent" }),
    ).toThrow("parent parent is not live");
  });

  it("registerAgent upserts on conflict", () => {
    db.registerAgent("a1", "First", "🔵", 100);
    db.registerAgent("a1", "Updated", "🔴", 200);

    const agents = db.getAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("Updated");
    expect(agents[0].pid).toBe(200);
  });

  it("registerAgent refreshes identities for reconnecting stable agents", () => {
    const first = db.registerAgent("a1", "Original", "🧠", 100, undefined, "host:session:/tmp/a");
    db.unregisterAgent(first.id);

    const resumed = db.registerAgent(
      "a2",
      "Different",
      "🤖",
      200,
      undefined,
      "host:session:/tmp/a",
    );

    expect(resumed.id).toBe(first.id);
    expect(resumed.name).toBe("Different");
    expect(resumed.emoji).toBe("🤖");
    expect(db.getAgents()).toHaveLength(1);
  });

  it("registerAgent enforces unique names for different identities", () => {
    const first = db.registerAgent("a1", "Hyper Owl", "🦉", 100, undefined, "host:session:/tmp/a");
    const second = db.registerAgent("a2", "Hyper Owl", "🦎", 200, undefined, "host:session:/tmp/b");

    expect(first.name).toBe("Hyper Owl");
    expect(second.name).toBe("Hyper Owl 2");
    expect(db.getAgents().map((agent) => agent.name)).toEqual(["Hyper Owl", "Hyper Owl 2"]);
  });

  it("registerAgent refreshes themed identities for reconnecting stable agents", () => {
    db.registerAgent(
      "a1",
      "Hyper Owl",
      "🦉",
      100,
      { role: "worker", skinTheme: "default", personality: "whimsical" },
      "host:session:/tmp/a",
    );
    db.unregisterAgent("a1");

    const refreshed = db.registerAgent(
      "a2",
      "Night Ranger",
      "🌙",
      200,
      { role: "worker", skinTheme: "night's watch", personality: "grim but steady" },
      "host:session:/tmp/a",
    );

    expect(refreshed.id).toBe("a1");
    expect(refreshed.name).toBe("Night Ranger");
    expect(refreshed.emoji).toBe("🌙");
    expect(refreshed.metadata).toMatchObject({ skinTheme: "night's watch" });
  });

  it("stores broker settings as JSON values", () => {
    db.setSetting("pinet.skinTheme", { theme: "cyberpunk hackers" });

    expect(db.getSetting<{ theme: string }>("pinet.skinTheme")).toEqual({
      theme: "cyberpunk hackers",
    });

    db.deleteSetting("pinet.skinTheme");
    expect(db.getSetting("pinet.skinTheme")).toBeNull();
  });

  it("updates agent identity without losing stable id or metadata", () => {
    db.registerAgent(
      "a1",
      "Hyper Owl",
      "🦉",
      100,
      { role: "worker", skinTheme: "default" },
      "host:session:/tmp/a",
    );

    const updated = db.updateAgentIdentity("a1", {
      name: "Night Ranger",
      emoji: "🌙",
      metadata: { role: "worker", skinTheme: "night's watch", personality: "grim but steady" },
    });

    expect(updated).toMatchObject({
      id: "a1",
      stableId: "host:session:/tmp/a",
      name: "Night Ranger",
      emoji: "🌙",
      metadata: {
        role: "worker",
        skinTheme: "night's watch",
        personality: "grim but steady",
      },
    });
  });

  it("updates agent metadata without changing identity fields", () => {
    db.registerAgent(
      "a1",
      "Hyper Owl",
      "🦉",
      100,
      { branch: "main", role: "worker" },
      "host:session:/tmp/a",
    );

    const updated = db.updateAgentMetadata("a1", {
      branch: "feature/live",
      workdirDirty: true,
    });

    expect(updated).toMatchObject({
      id: "a1",
      stableId: "host:session:/tmp/a",
      name: "Hyper Owl",
      emoji: "🦉",
      metadata: { branch: "feature/live", workdirDirty: true },
    });
    expect(db.updateAgentMetadata("missing", { branch: "main" })).toBeNull();
  });

  it("records and updates task assignment progress", () => {
    db.registerAgent("worker-1", "Hyper Horse", "🐎", 100);

    const created = db.recordTaskAssignment(
      "worker-1",
      114,
      "feat/ralph-completion-v2",
      "a2a:broker:worker-1",
      42,
    );
    expect(created.status).toBe("assigned");
    expect(created.prNumber).toBeNull();

    db.updateTaskAssignmentProgress(created.id, "pr_open", 201);
    const updated = db.listTaskAssignments();
    expect(updated).toHaveLength(1);
    expect(updated[0].status).toBe("pr_open");
    expect(updated[0].prNumber).toBe(201);
  });

  it("does not reset tracked progress when the broker sends a reminder on the same branch", () => {
    db.registerAgent("worker-1", "Hyper Horse", "🐎", 100);

    const created = db.recordTaskAssignment(
      "worker-1",
      114,
      "feat/ralph-completion-v2",
      "a2a:broker:worker-1",
      42,
    );
    db.updateTaskAssignmentProgress(created.id, "pr_open", 201);

    const tracked = db.recordTaskAssignment(
      "worker-1",
      114,
      "feat/ralph-completion-v2",
      "a2a:broker:worker-1",
      43,
    );

    expect(tracked.id).toBe(created.id);
    expect(tracked.status).toBe("pr_open");
    expect(tracked.prNumber).toBe(201);
    expect(tracked.sourceMessageId).toBe(43);
  });

  it("resets tracked progress when the broker reassigns the same issue to a new branch", () => {
    db.registerAgent("worker-1", "Hyper Horse", "🐎", 100);

    const created = db.recordTaskAssignment(
      "worker-1",
      114,
      "feat/ralph-completion-v1",
      "a2a:broker:worker-1",
      42,
    );
    db.updateTaskAssignmentProgress(created.id, "pr_merged", 201);

    const reassigned = db.recordTaskAssignment(
      "worker-1",
      114,
      "feat/ralph-completion-v2",
      "a2a:broker:worker-1",
      44,
    );

    expect(reassigned.id).toBe(created.id);
    expect(reassigned.branch).toBe("feat/ralph-completion-v2");
    expect(reassigned.status).toBe("assigned");
    expect(reassigned.prNumber).toBeNull();
  });

  it("reassigns issue ownership across workers and reports only the latest assignee", () => {
    db.registerAgent("worker-1", "Hyper Horse", "🐎", 100);
    db.registerAgent("worker-2", "Frozen Raven", "🐦‍⬛", 101);

    const created = db.recordTaskAssignment(
      "worker-1",
      114,
      "feat/ralph-completion-v1",
      "a2a:broker:worker-1",
      42,
    );
    db.updateTaskAssignmentProgress(created.id, "pr_open", 201);

    const reassigned = db.recordTaskAssignment(
      "worker-2",
      114,
      "feat/ralph-completion-v2",
      "a2a:broker:worker-2",
      43,
    );

    expect(reassigned.id).toBe(created.id);
    expect(reassigned.agentId).toBe("worker-2");
    expect(reassigned.branch).toBe("feat/ralph-completion-v2");
    expect(reassigned.status).toBe("assigned");
    expect(reassigned.prNumber).toBeNull();

    const tracked = db.listTaskAssignments();
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatchObject({
      agentId: "worker-2",
      issueNumber: 114,
      branch: "feat/ralph-completion-v2",
      status: "assigned",
      prNumber: null,
    });

    const report = buildTaskAssignmentReport(
      tracked,
      new Map([
        ["worker-1", { name: "Hyper Horse", emoji: "🐎" }],
        ["worker-2", { name: "Frozen Raven", emoji: "🐦‍⬛" }],
      ]),
    );
    expect(report).toBe(
      [
        "RALPH LOOP — WORKER STATUS:",
        "- 🐦‍⬛ Frozen Raven: #114 → repo unknown; progress not checked ⚠️",
      ].join("\n"),
    );
  });

  it("lists active tracked assignments that still have no reply to the original sender", () => {
    db.registerAgent("broker", "Broker Crane", "🪿", 10);
    db.registerAgent("worker-1", "Hyper Horse", "🐎", 100);

    db.createThread("a2a:broker:worker-1", "agent", "", "broker");
    const sourceMessage = db.insertMessage(
      "a2a:broker:worker-1",
      "agent",
      "inbound",
      "broker",
      "Please take issue #114",
      ["worker-1"],
      { senderAgent: "Broker Crane", a2a: true },
    );

    db.recordTaskAssignment("worker-1", 114, "fix/114", "a2a:broker:worker-1", sourceMessage.id);

    expect(db.listTaskAssignmentsAwaitingFirstReply()).toEqual([
      {
        id: expect.any(Number),
        agentId: "worker-1",
        issueNumber: 114,
        status: "assigned",
        sourceMessageId: sourceMessage.id,
        originalSenderAgentId: "broker",
      },
    ]);
  });

  it("stops tracking once the assignee replies and ignores completed tracked assignments", () => {
    db.registerAgent("broker", "Broker Crane", "🪿", 10);
    db.registerAgent("worker-1", "Hyper Horse", "🐎", 100);

    db.createThread("a2a:broker:worker-1", "agent", "", "broker");
    const sourceMessage = db.insertMessage(
      "a2a:broker:worker-1",
      "agent",
      "inbound",
      "broker",
      "Please take issue #114",
      ["worker-1"],
      { senderAgent: "Broker Crane", a2a: true },
    );
    const tracked = db.recordTaskAssignment(
      "worker-1",
      114,
      "fix/114",
      "a2a:broker:worker-1",
      sourceMessage.id,
    );

    db.updateTaskAssignmentProgress(tracked.id, "pr_merged", 201);
    expect(db.listTaskAssignmentsAwaitingFirstReply()).toEqual([]);

    db.updateTaskAssignmentProgress(tracked.id, "assigned", null);
    expect(db.listTaskAssignmentsAwaitingFirstReply()).toHaveLength(1);

    db.createThread("a2a:worker-1:broker", "agent", "", "worker-1");
    db.insertMessage(
      "a2a:worker-1:broker",
      "agent",
      "inbound",
      "worker-1",
      "Working on it",
      ["broker"],
      { senderAgent: "Hyper Horse", a2a: true },
    );

    expect(db.listTaskAssignmentsAwaitingFirstReply()).toEqual([]);
  });

  it("startup reconciliation preserves ownership until reconnect and refreshes the returning identity", () => {
    const dbPath = path.join(dir, "restart.db");
    const firstDb = new BrokerDB(dbPath);
    firstDb.initialize();

    const original = firstDb.registerAgent(
      "a1",
      "Hyper Owl",
      "🦉",
      100,
      undefined,
      "host:session:/tmp/a",
    );
    firstDb.createThread("t-restart", "slack", "C1", original.id);
    firstDb.close();

    const restartedDb = new BrokerDB(dbPath);
    restartedDb.initialize();

    expect(restartedDb.getAgents()).toEqual([]);
    expect(restartedDb.getAgentById(original.id)?.disconnectedAt).toBeTruthy();
    expect(restartedDb.getAgentById(original.id)?.resumableUntil).toBeTruthy();
    expect(restartedDb.getThread("t-restart")?.ownerAgent).toBe(original.id);

    const resumed = restartedDb.registerAgent(
      "a2",
      "Different Owl",
      "🦎",
      200,
      undefined,
      "host:session:/tmp/a",
    );

    expect(resumed.id).toBe(original.id);
    expect(resumed.name).toBe("Different Owl");
    expect(resumed.emoji).toBe("🦎");
    expect(restartedDb.getThread("t-restart")?.ownerAgent).toBe(original.id);

    restartedDb.close();
  });

  it("unregisterAgent requeues undelivered work, deletes inbox rows, and releases claims", () => {
    db.registerAgent("a1", "Agent", "🤖", 1);
    db.createThread("t-unregister", "slack", "#general", "a1");
    db.insertMessage("t-unregister", "slack", "inbound", "U1", "pending slack work", ["a1"], {
      channel: "#general",
    });
    db.insertMessage("t-unregister", "agent", "inbound", "broker-1", "pending a2a work", ["a1"], {
      senderAgent: "Broker",
      a2a: true,
    });
    db.insertMessage("t-unregister", "agent", "outbound", "a1", "already sent", ["a1"]);

    const sqlite = (db as unknown as { getDb(): DatabaseSync }).getDb();
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM inbox WHERE agent_id = ?").get("a1") as {
        count: number;
      },
    ).toEqual({ count: 3 });

    db.unregisterAgent("a1");

    expect(db.getAgents()).toEqual([]);
    expect(db.getAgentById("a1")?.name).toBe("Agent");
    expect(db.getAgentById("a1")?.resumableUntil).toBeNull();
    expect(db.getThread("t-unregister")?.ownerAgent).toBeNull();
    expect(db.getPendingBacklog().map((entry) => entry.messageId)).toHaveLength(2);
    expect(db.getPendingBacklog().map((entry) => entry.threadId)).toEqual([
      "t-unregister",
      "t-unregister",
    ]);
    expect(db.getInbox("a1")).toHaveLength(0);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM inbox WHERE agent_id = ?").get("a1") as {
        count: number;
      },
    ).toEqual({ count: 0 });
  });

  it("schedules wake-ups and delivers them when due", () => {
    db.registerAgent("worker-1", "Worker", "⏰", 1);

    const scheduled = db.scheduleWakeup(
      "worker-1",
      "Check whether PR #62 merged",
      "2026-04-02T14:05:00.000Z",
    );

    expect(db.listScheduledWakeups("worker-1")).toHaveLength(1);
    expect(db.deliverDueScheduledWakeups("2026-04-02T14:04:59.000Z")).toHaveLength(0);

    const deliveries = db.deliverDueScheduledWakeups("2026-04-02T14:05:00.000Z");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].wakeup.id).toBe(scheduled.id);
    expect(deliveries[0].message.body).toBe("Check whether PR #62 merged");
    expect(deliveries[0].message.threadId).toBe("wakeup:worker-1");
    expect(deliveries[0].message.metadata).toEqual(
      expect.objectContaining({
        scheduledWakeup: true,
        a2a: true,
        pinetMailClass: "fwup",
      }),
    );
    expect(db.listScheduledWakeups("worker-1")).toHaveLength(0);

    const inbox = db.getInbox("worker-1");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].message.body).toBe("Check whether PR #62 merged");
  });

  it("keeps due wake-ups pending until the target agent reconnects", () => {
    db.registerAgent("worker-1", "Worker", "⏰", 1, undefined, "host:session:/tmp/worker-1");
    db.disconnectAgent("worker-1", 60_000);
    db.scheduleWakeup("worker-1", "Wake me when CI is done", "2026-04-02T14:05:00.000Z");

    expect(db.deliverDueScheduledWakeups("2026-04-02T14:05:00.000Z")).toHaveLength(0);
    expect(db.listScheduledWakeups("worker-1")).toHaveLength(1);

    db.registerAgent("worker-1b", "Worker", "⏰", 2, undefined, "host:session:/tmp/worker-1");

    const deliveries = db.deliverDueScheduledWakeups("2026-04-02T14:05:01.000Z");
    expect(deliveries).toHaveLength(1);
    expect(db.listScheduledWakeups("worker-1")).toHaveLength(0);
    expect(db.getInbox("worker-1")).toHaveLength(1);
  });

  it("persists scheduled wake-ups across broker restart", () => {
    const dbPath = path.join(dir, "scheduled-restart.db");
    const firstDb = new BrokerDB(dbPath);
    firstDb.initialize();
    firstDb.registerAgent("worker-1", "Worker", "⏰", 1, undefined, "host:session:/tmp/restart");
    firstDb.scheduleWakeup("worker-1", "Wake me after restart", "2026-04-02T14:05:00.000Z");
    firstDb.close();

    const restartedDb = new BrokerDB(dbPath);
    restartedDb.initialize();
    expect(restartedDb.listScheduledWakeups("worker-1")).toHaveLength(1);

    const resumed = restartedDb.registerAgent(
      "worker-2",
      "Different Worker",
      "🦎",
      2,
      undefined,
      "host:session:/tmp/restart",
    );
    expect(resumed.id).toBe("worker-1");

    const deliveries = restartedDb.deliverDueScheduledWakeups("2026-04-02T14:05:00.000Z");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].message.body).toBe("Wake me after restart");
    restartedDb.close();
  });

  it("keeps scheduled wake-ups after purge and rebinds them by stable id", () => {
    const stableId = "host:session:/tmp/purge-reconnect";
    db.registerAgent("worker-1", "Worker", "⏰", 1, undefined, stableId);
    db.scheduleWakeup("worker-1", "Wake me after purge", "2026-04-02T14:05:00.000Z");
    db.unregisterAgent("worker-1");

    expect(db.purgeDisconnectedAgents(0)).toEqual(["worker-1"]);
    expect(db.listScheduledWakeups()).toHaveLength(1);

    const resumed = db.registerAgent("worker-2", "Worker", "🦎", 2, undefined, stableId);
    expect(resumed.id).toBe("worker-2");
    expect(db.listScheduledWakeups(resumed.id)).toHaveLength(1);

    const deliveries = db.deliverDueScheduledWakeups("2026-04-02T14:05:00.000Z");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].message.body).toBe("Wake me after purge");
    expect(db.getInbox(resumed.id)).toHaveLength(1);
    expect(db.listScheduledWakeups(resumed.id)).toHaveLength(0);
  });

  it("getAllAgents includes recently disconnected agents for visibility", () => {
    db.registerAgent("a1", "Agent", "🤖", 1);
    db.unregisterAgent("a1");

    const allAgents = db.getAllAgents();
    expect(allAgents).toHaveLength(1);
    expect(allAgents[0]?.id).toBe("a1");
    expect(allAgents[0]?.disconnectedAt).toBeTruthy();
  });

  it("touchAgent updates last_seen", () => {
    db.registerAgent("a1", "Agent", "🤖", 1);
    const before = db.getAgents()[0].lastSeen;

    // Small delay to ensure timestamp differs
    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }

    db.touchAgent("a1");
    const after = db.getAgents()[0].lastSeen;
    expect(after >= before).toBe(true);
  });

  it("heartbeatAgent updates last_heartbeat", () => {
    db.registerAgent("a1", "Agent", "🤖", 1);
    const before = db.getAgents()[0].lastHeartbeat;

    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }

    db.heartbeatAgent("a1");
    const after = db.getAgentById("a1")?.lastHeartbeat;
    expect(after).toBeDefined();
    expect(after! >= before).toBe(true);
  });

  it("disconnectAgent keeps claims during the resumable window", () => {
    db.registerAgent("a1", "Agent", "🤖", 1);
    db.createThread("t-resumable", "slack", "#general", "a1");

    db.disconnectAgent("a1", 60_000);

    expect(db.getAgents()).toEqual([]);
    expect(db.getAgentById("a1")?.disconnectedAt).toBeTruthy();
    expect(db.getAgentById("a1")?.resumableUntil).toBeTruthy();
    expect(db.getThread("t-resumable")?.ownerAgent).toBe("a1");
  });

  it("pruneStaleAgents disconnects stale agents and releases their thread claims", () => {
    db.registerAgent("a1", "Agent", "🤖", 1);
    db.createThread("t1", "slack", "#general", "a1");

    const pruned = db.pruneStaleAgents(0);

    expect(pruned).toContain("a1");
    expect(db.getAgents()).toEqual([]);
    expect(db.getThread("t1")?.ownerAgent).toBeNull();
    expect(db.getAgentById("a1")).not.toBeNull();
  });

  it("purgeDisconnectedAgents waits for the grace window before deleting ghosts", () => {
    db.registerAgent("active", "Active", "🟢", 1);
    db.registerAgent("resumable", "Resumable", "🟡", 2);
    db.registerAgent("ghost", "Ghost", "⚫️", 3);
    db.registerAgent("gone", "Gone", "⚪️", 4);
    db.createThread("t-gone", "slack", "C1", "gone");
    db.insertMessage("t-gone", "slack", "inbound", "U1", "recover me", ["gone"], {
      channel: "C1",
    });

    db.disconnectAgent("resumable", 60_000);
    db.disconnectAgent("ghost", 0);
    db.unregisterAgent("gone");

    expect(db.purgeDisconnectedAgents()).toEqual([]);

    const purged = db.purgeDisconnectedAgents(0);

    expect(purged.sort()).toEqual(["ghost", "gone"]);
    expect(db.getAgentById("active")).not.toBeNull();
    expect(db.getAgentById("resumable")).not.toBeNull();
    expect(db.getAgentById("ghost")).toBeNull();
    expect(db.getAgentById("gone")).toBeNull();
    expect(db.getInbox("gone")).toHaveLength(0);
    // Thread ownership should be released after purge
    expect(db.getThread("t-gone")?.ownerAgent).toBeNull();
    // Messages should be moved to backlog for reassignment
    expect(db.getPendingBacklog().map((entry) => entry.threadId)).toContain("t-gone");
  });

  it("queueUnroutedMessage persists pending backlog without assigning an owner", () => {
    const backlog = db.queueUnroutedMessage(
      {
        source: "slack",
        threadId: "t-unrouted",
        channel: "C1",
        userId: "U1",
        text: "hello backlog",
        timestamp: "100.200",
      },
      "no_route",
    );

    expect(backlog.threadId).toBe("t-unrouted");
    expect(backlog.status).toBe("pending");
    expect(db.getPendingBacklog()).toHaveLength(1);
    expect(db.getThread("t-unrouted")?.ownerAgent).toBeNull();
  });

  it("requeueUndeliveredMessages keeps pending Slack work targeted to its original recipient", () => {
    db.registerAgent("worker-1", "Worker", "🤖", 1);
    db.createThread("t-requeue", "slack", "C1", "worker-1");
    db.insertMessage("t-requeue", "slack", "inbound", "U1", "hello", ["worker-1"], {
      channel: "C1",
    });

    const moved = db.requeueUndeliveredMessages("worker-1");

    expect(moved).toBe(1);
    expect(db.getInbox("worker-1")).toHaveLength(0);
    expect(db.getPendingBacklog()).toHaveLength(1);
    expect(db.getPendingBacklog()[0].threadId).toBe("t-requeue");
    expect(db.getPendingBacklog()[0].preferredAgentId).toBe("worker-1");
  });

  it("requeueUndeliveredMessages also requeues pending agent-to-agent work", () => {
    db.registerAgent("worker-1", "Worker", "🤖", 1);
    db.createThread("t-requeue-a2a", "agent", "", "worker-1");
    db.insertMessage(
      "t-requeue-a2a",
      "agent",
      "inbound",
      "broker-1",
      "follow up with the user",
      ["worker-1"],
      {
        senderAgent: "Broker",
        a2a: true,
      },
    );

    const moved = db.requeueUndeliveredMessages("worker-1");

    expect(moved).toBe(1);
    expect(db.getInbox("worker-1")).toHaveLength(0);
    expect(db.getPendingBacklog()).toHaveLength(1);
    expect(db.getPendingBacklog()[0].threadId).toBe("t-requeue-a2a");
    expect(db.getPendingBacklog()[0].channel).toBe("");
    expect(db.getPendingBacklog()[0].preferredAgentId).toBe("worker-1");
  });

  it("maintenance requeues disconnected Slack owner work without assigning it to another worker", () => {
    db.registerAgent("worker-1", "Worker", "🤖", 1);
    db.registerAgent("worker-2", "Other Worker", "🦊", 2);
    db.createThread("t-orphan", "slack", "C1", "worker-1");
    // Use disconnectAgent with 0ms window so resumable_until expires immediately
    db.disconnectAgent("worker-1", 0);

    db.queueMessage("worker-1", {
      source: "slack",
      threadId: "t-orphan",
      channel: "C1",
      userId: "U1",
      text: "stuck during resume window",
      timestamp: "100.200",
    });

    // Ensure resumable_until is in the past
    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }

    const result = runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    expect(result.reapedAgentIds).toContain("worker-1");
    expect(result.assignedBacklogCount).toBe(0);
    expect(db.getAgentById("worker-1")).not.toBeNull();
    expect(db.getInbox("worker-1")).toHaveLength(0);
    expect(db.getInbox("worker-2")).toHaveLength(0);
    expect(db.getPendingBacklog()).toHaveLength(1);
    expect(db.getPendingBacklog()[0]).toMatchObject({
      threadId: "t-orphan",
      preferredAgentId: "worker-1",
      assignedAgentId: null,
    });
    expect(db.getThread("t-orphan")?.ownerAgent).toBeNull();
  });

  it("maintenance purge drops expired targeted Slack work instead of assigning it elsewhere", () => {
    db.registerAgent("gone", "Gone", "⚪️", 4);
    db.createThread("t-gone-maint", "slack", "C1", "gone");
    db.insertMessage("t-gone-maint", "slack", "inbound", "U1", "recover me too", ["gone"], {
      channel: "C1",
    });
    db.unregisterAgent("gone");

    const sqlite = (db as unknown as { getDb(): DatabaseSync }).getDb();
    sqlite
      .prepare("UPDATE agents SET disconnected_at = ?, resumable_until = NULL WHERE id = ?")
      .run(new Date(Date.now() - 2 * 60 * 60_000).toISOString(), "gone");

    const result = runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    const backlogRow = sqlite
      .prepare(
        "SELECT status, reason, preferred_agent_id FROM unrouted_backlog WHERE thread_id = ?",
      )
      .get("t-gone-maint") as
      | { status: string; reason: string; preferred_agent_id: string | null }
      | undefined;

    expect(db.getAgentById("gone")).toBeNull();
    expect(db.getInbox("gone")).toHaveLength(0);
    expect(db.getPendingBacklog()).toHaveLength(0);
    expect(backlogRow).toEqual({
      status: "dropped",
      reason: "preferred_agent_missing",
      preferred_agent_id: "gone",
    });
    expect(result.anomalies).toContain("dropped 1 undeliverable targeted backlog entry");
    expect(db.getThread("t-gone-maint")?.ownerAgent).toBeNull();
  });

  it("maintenance resets orphaned assigned targeted backlog to pending while the preferred agent is still resumable", () => {
    db.registerAgent("sender", "Sender", "📤", 1);
    db.registerAgent("receiver", "Receiver", "📥", 2);
    db.createThread("a2a:sender:receiver", "agent", "", "sender");
    db.insertMessage(
      "a2a:sender:receiver",
      "agent",
      "inbound",
      "sender",
      "please pick this up",
      ["receiver"],
      {
        senderAgent: "Sender",
        a2a: true,
      },
    );
    db.requeueUndeliveredMessages("receiver");

    const backlog = db.getPendingBacklog()[0];
    expect(backlog.preferredAgentId).toBe("receiver");
    db.assignBacklogEntry(backlog.id, "receiver");
    db.disconnectAgent("receiver", 60_000);

    const sqlite = (db as unknown as { getDb(): DatabaseSync }).getDb();
    sqlite
      .prepare("DELETE FROM inbox WHERE message_id = ? AND agent_id = ?")
      .run(backlog.messageId, "receiver");

    const result = runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    const repairedBacklog = sqlite
      .prepare(
        "SELECT status, reason, preferred_agent_id, assigned_agent_id FROM unrouted_backlog WHERE id = ?",
      )
      .get(backlog.id) as
      | {
          status: string;
          reason: string;
          preferred_agent_id: string | null;
          assigned_agent_id: string | null;
        }
      | undefined;

    expect(result.assignedBacklogCount).toBe(0);
    expect(result.pendingBacklogCount).toBe(1);
    expect(result.anomalies).toContain("reset 1 orphaned backlog assignment to pending");
    expect(db.getAgentById("receiver")).not.toBeNull();
    expect(repairedBacklog).toEqual({
      status: "pending",
      reason: "agent_disconnected",
      preferred_agent_id: "receiver",
      assigned_agent_id: null,
    });
  });

  it("maintenance resets orphaned assigned generic backlog to pending once the assignee is missing", () => {
    db.registerAgent("worker-1", "Worker", "🤖", 1);

    const backlog = db.queueUnroutedMessage(
      {
        source: "slack",
        threadId: "1775638755.200989",
        channel: "C123",
        userId: "U123",
        text: "recover this stranded generic backlog",
        timestamp: "100.200",
      },
      "no_route",
    );

    expect(db.assignBacklogEntry(backlog.id, "worker-1")?.status).toBe("assigned");
    expect(db.getThread("1775638755.200989")?.ownerAgent).toBe("worker-1");

    const sqlite = (db as unknown as { getDb(): DatabaseSync }).getDb();
    sqlite
      .prepare("DELETE FROM inbox WHERE message_id = ? AND agent_id = ?")
      .run(backlog.messageId, "worker-1");
    sqlite.prepare("DELETE FROM agents WHERE id = ?").run("worker-1");

    const result = runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    const repairedBacklog = sqlite
      .prepare(
        "SELECT status, reason, preferred_agent_id, assigned_agent_id FROM unrouted_backlog WHERE id = ?",
      )
      .get(backlog.id) as
      | {
          status: string;
          reason: string;
          preferred_agent_id: string | null;
          assigned_agent_id: string | null;
        }
      | undefined;
    const orphanedInboxCount = (
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM inbox WHERE message_id = ? AND agent_id = ?")
        .get(backlog.messageId, "worker-1") as { count: number }
    ).count;

    expect(result.assignedBacklogCount).toBe(0);
    expect(result.pendingBacklogCount).toBe(1);
    expect(result.anomalies).toContain("released 1 orphaned thread claim");
    expect(result.anomalies).toContain("reset 1 orphaned backlog assignment to pending");
    expect(result.anomalies).toContain("pending unrouted backlog has no live workers");
    expect(db.getThread("1775638755.200989")?.ownerAgent).toBeNull();
    expect(orphanedInboxCount).toBe(0);
    expect(repairedBacklog).toEqual({
      status: "pending",
      reason: "no_route",
      preferred_agent_id: null,
      assigned_agent_id: null,
    });
  });

  it("maintenance drops stale targeted backlog once the preferred agent is purged", () => {
    db.registerAgent("sender", "Sender", "📤", 1);
    db.registerAgent("receiver", "Receiver", "📥", 2);
    db.createThread("a2a:sender:receiver", "agent", "", "sender");
    db.insertMessage(
      "a2a:sender:receiver",
      "agent",
      "inbound",
      "sender",
      "please pick this up",
      ["receiver"],
      {
        senderAgent: "Sender",
        a2a: true,
      },
    );
    db.requeueUndeliveredMessages("receiver");

    const backlog = db.getPendingBacklog()[0];
    expect(backlog.preferredAgentId).toBe("receiver");
    db.assignBacklogEntry(backlog.id, "receiver");

    const sqlite = (db as unknown as { getDb(): DatabaseSync }).getDb();
    sqlite
      .prepare("DELETE FROM inbox WHERE message_id = ? AND agent_id = ?")
      .run(backlog.messageId, "receiver");
    sqlite.prepare("DELETE FROM agents WHERE id = ?").run("receiver");

    const result = runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    const droppedBacklog = sqlite
      .prepare(
        "SELECT status, reason, preferred_agent_id, assigned_agent_id FROM unrouted_backlog WHERE id = ?",
      )
      .get(backlog.id) as
      | {
          status: string;
          reason: string;
          preferred_agent_id: string | null;
          assigned_agent_id: string | null;
        }
      | undefined;

    expect(result.pendingBacklogCount).toBe(0);
    expect(result.assignedBacklogCount).toBe(0);
    expect(result.anomalies).toContain("dropped 1 undeliverable targeted backlog entry");
    expect(db.getAgentById("receiver")).toBeNull();
    expect(db.getBacklogCount("pending")).toBe(0);
    expect(db.getBacklogCount("dropped")).toBe(1);
    expect(droppedBacklog).toEqual({
      status: "dropped",
      reason: "preferred_agent_missing",
      preferred_agent_id: "receiver",
      assigned_agent_id: null,
    });
  });

  it("maintenance rebinds broker-targeted backlog to the live broker", () => {
    db.registerAgent("broker", "Broker", "🦔", 1, { role: "broker" });
    db.registerAgent("sender", "Sender", "📤", 2);
    db.createThread("a2a:sender:broker", "agent", "", "sender");
    db.queueMessage("broker", {
      source: "agent",
      threadId: "a2a:sender:broker",
      channel: "",
      userId: "sender",
      text: "recover this broker-targeted report",
      timestamp: "100.200",
    });

    expect(db.getInbox("broker")).toHaveLength(1);
    expect(db.requeueUndeliveredMessages("broker")).toBe(1);
    expect(db.getPendingBacklog()).toHaveLength(1);
    expect(db.getPendingBacklog()[0]?.preferredAgentId).toBe("broker");

    const result = runBrokerMaintenancePass(db, {
      brokerAgentId: "broker",
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    const reboundBacklog = db.getBacklogCount("assigned");

    expect(result.pendingBacklogCount).toBe(0);
    expect(result.assignedBacklogCount).toBe(1);
    expect(result.anomalies).toContain("rebound 1 broker-targeted backlog item to the live broker");
    expect(reboundBacklog).toBe(1);
    expect(db.getInbox("broker")).toHaveLength(1);
    expect(db.getInbox("broker")[0]?.message.body).toBe("recover this broker-targeted report");
  });

  it("createThread and getThread", () => {
    const thread = db.createThread("t1", "slack", "#general", "a1");
    expect(thread.threadId).toBe("t1");
    expect(thread.source).toBe("slack");
    expect(thread.channel).toBe("#general");
    expect(thread.ownerAgent).toBe("a1");
    expect(thread.ownerBinding).toBeNull();

    const fetched = db.getThread("t1");
    expect(fetched).not.toBeNull();
    expect(fetched!.threadId).toBe("t1");
  });

  it("persists explicit thread ownership bindings across restart", () => {
    db.createThread({
      threadId: "t-explicit",
      source: "slack",
      channel: "#general",
      ownerAgent: "hippo",
      ownerBinding: "explicit",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    expect(db.getThread("t-explicit")).toMatchObject({
      ownerAgent: "hippo",
      ownerBinding: "explicit",
    });

    db.close();
    db = new BrokerDB(path.join(dir, "test.db"));
    db.initialize();

    expect(db.getThread("t-explicit")).toMatchObject({
      ownerAgent: "hippo",
      ownerBinding: "explicit",
    });
  });

  it("getThread returns null for missing thread", () => {
    expect(db.getThread("nonexistent")).toBeNull();
  });

  it("getThreads filters by owner", () => {
    db.createThread("t1", "slack", "#a", "agent-1");
    db.createThread("t2", "slack", "#b", "agent-2");
    db.createThread("t3", "slack", "#c", "agent-1");

    const agent1Threads = db.getThreads("agent-1");
    expect(agent1Threads).toHaveLength(2);

    const allThreads = db.getThreads();
    expect(allThreads).toHaveLength(3);
  });

  it("getOwnedThreadCount returns the number of claimed threads", () => {
    db.createThread("t1", "slack", "#a", "agent-1");
    db.createThread("t2", "slack", "#b", "agent-2");
    db.createThread("t3", "slack", "#c", "agent-1");

    expect(db.getOwnedThreadCount("agent-1")).toBe(2);
    expect(db.getOwnedThreadCount("agent-2")).toBe(1);
    expect(db.getOwnedThreadCount("missing")).toBe(0);
  });

  it("claimThread creates a new thread and claims it", () => {
    const claimed = db.claimThread("t-new", "agent-1", "slack", "#general");
    expect(claimed).toBe(true);
    const thread = db.getThread("t-new");
    expect(thread).not.toBeNull();
    expect(thread!.ownerAgent).toBe("agent-1");
  });

  it("claimThread succeeds on unclaimed existing thread", () => {
    db.createThread("t-unclaimed", "slack", "#general", null);
    const claimed = db.claimThread("t-unclaimed", "agent-1");
    expect(claimed).toBe(true);
    expect(db.getThread("t-unclaimed")!.ownerAgent).toBe("agent-1");
  });

  it("claimThread allows re-claim by same agent", () => {
    db.claimThread("t-mine", "agent-1");
    const reclaimed = db.claimThread("t-mine", "agent-1");
    expect(reclaimed).toBe(true);
    expect(db.getThread("t-mine")!.ownerAgent).toBe("agent-1");
  });

  it("claimThread rejects claim when another agent owns the thread", () => {
    db.claimThread("t-taken", "agent-1");
    const claimed = db.claimThread("t-taken", "agent-2");
    expect(claimed).toBe(false);
    expect(db.getThread("t-taken")!.ownerAgent).toBe("agent-1");
  });

  it("claimThread is atomic — no TOCTOU window between read and write", () => {
    // Simulate the race: agent-1 claims, then agent-2 tries to claim.
    // With the old read-then-write pattern, a race could let both succeed.
    // The atomic INSERT...ON CONFLICT...WHERE ensures only one wins.
    const first = db.claimThread("t-race", "agent-1");
    const second = db.claimThread("t-race", "agent-2");
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(db.getThread("t-race")!.ownerAgent).toBe("agent-1");
  });

  it("insertMessage and getInbox", () => {
    db.registerAgent("a1", "Agent1", "🔵", 1);
    db.registerAgent("a2", "Agent2", "🔴", 2);
    db.createThread("t1", "slack", "#general", "a1");

    const msg = db.insertMessage("t1", "slack", "inbound", "user1", "hello", ["a1", "a2"]);
    expect(msg.id).toBeGreaterThan(0);
    expect(msg.body).toBe("hello");

    const inbox1 = db.getInbox("a1");
    expect(inbox1).toHaveLength(1);
    expect(inbox1[0].message.body).toBe("hello");
    expect(inbox1[0].entry.delivered).toBe(false);

    const inbox2 = db.getInbox("a2");
    expect(inbox2).toHaveLength(1);
  });

  it("markDelivered removes from pending inbox", () => {
    db.registerAgent("a1", "Agent1", "🔵", 1);
    db.createThread("t1", "slack", "#general", "a1");
    db.insertMessage("t1", "slack", "inbound", "user1", "hello", ["a1"]);

    const before = db.getInbox("a1");
    expect(before).toHaveLength(1);

    db.markDelivered([before[0].entry.id], "a1");

    const after = db.getInbox("a1");
    expect(after).toHaveLength(0);
  });

  it("markDelivered scoped to agent does not affect other agents", () => {
    db.registerAgent("a1", "Agent1", "🔵", 1);
    db.registerAgent("a2", "Agent2", "🔴", 2);
    db.createThread("t1", "slack", "#general", "a1");
    db.insertMessage("t1", "slack", "inbound", "user1", "hello", ["a1", "a2"]);

    const inbox1 = db.getInbox("a1");
    const inbox2 = db.getInbox("a2");

    // Ack only for agent a1
    db.markDelivered([inbox1[0].entry.id], "a1");

    expect(db.getInbox("a1")).toHaveLength(0);
    expect(db.getInbox("a2")).toHaveLength(1);

    // Attempting to ack a2's inbox entry with a1 should be a no-op
    db.markDelivered([inbox2[0].entry.id], "a1");
    expect(db.getInbox("a2")).toHaveLength(1);
  });

  it("markDelivered clears assigned targeted backlog after the intended recipient acks it", () => {
    db.registerAgent("sender", "Sender", "📤", 1);
    db.registerAgent("target", "Target", "📥", 2);
    db.createThread("a2a:sender:target", "agent", "", "sender");
    db.insertMessage("a2a:sender:target", "agent", "inbound", "sender", "complete me", ["target"], {
      senderAgent: "Sender",
      a2a: true,
    });

    expect(db.requeueUndeliveredMessages("target")).toBe(1);
    const [backlog] = db.getPendingBacklog();
    expect(db.assignBacklogEntry(backlog.id, "target")?.status).toBe("assigned");

    const inbox = db.getInbox("target");
    expect(inbox).toHaveLength(1);

    db.markDelivered([inbox[0].entry.id], "target");

    expect(db.getInbox("target")).toHaveLength(0);
    expect(db.getBacklogCount("pending")).toBe(0);
    expect(db.getBacklogCount("assigned")).toBe(0);
    expect(db.getBacklogCount("dropped")).toBe(0);
  });

  it("markDelivered leaves assigned untargeted backlog intact after ack", () => {
    db.registerAgent("worker-1", "Worker", "🤖", 1);
    const backlog = db.queueUnroutedMessage(
      {
        source: "slack",
        threadId: "t-untargeted-ack",
        channel: "C1",
        userId: "U1",
        text: "leave this assigned",
        timestamp: "100.200",
      },
      "no_route",
    );

    expect(db.assignBacklogEntry(backlog.id, "worker-1")?.status).toBe("assigned");

    const inbox = db.getInbox("worker-1");
    expect(inbox).toHaveLength(1);

    db.markDelivered([inbox[0].entry.id], "worker-1");

    const sqlite = (db as unknown as { getDb(): DatabaseSync }).getDb();
    const row = sqlite
      .prepare(
        "SELECT status, preferred_agent_id, assigned_agent_id FROM unrouted_backlog WHERE id = ?",
      )
      .get(backlog.id) as
      | { status: string; preferred_agent_id: string | null; assigned_agent_id: string | null }
      | undefined;

    expect(db.getInbox("worker-1")).toHaveLength(0);
    expect(db.getBacklogCount("assigned")).toBe(1);
    expect(row).toEqual({
      status: "assigned",
      preferred_agent_id: null,
      assigned_agent_id: "worker-1",
    });
  });

  it("markDeliveredByMessageId leaves assigned untargeted backlog intact after ack", () => {
    db.registerAgent("worker-1", "Worker", "🤖", 1);
    const backlog = db.queueUnroutedMessage(
      {
        source: "slack",
        threadId: "t-untargeted-ack-by-message",
        channel: "C1",
        userId: "U1",
        text: "leave this assigned too",
        timestamp: "100.200",
      },
      "no_route",
    );

    expect(db.assignBacklogEntry(backlog.id, "worker-1")?.status).toBe("assigned");

    db.markDeliveredByMessageId(backlog.messageId, "worker-1");

    const sqlite = (db as unknown as { getDb(): DatabaseSync }).getDb();
    const row = sqlite
      .prepare(
        "SELECT status, preferred_agent_id, assigned_agent_id FROM unrouted_backlog WHERE id = ?",
      )
      .get(backlog.id) as
      | { status: string; preferred_agent_id: string | null; assigned_agent_id: string | null }
      | undefined;

    expect(db.getInbox("worker-1")).toHaveLength(0);
    expect(db.getBacklogCount("assigned")).toBe(1);
    expect(row).toEqual({
      status: "assigned",
      preferred_agent_id: null,
      assigned_agent_id: "worker-1",
    });
  });

  it("insertMessage with metadata round-trips JSON", () => {
    db.registerAgent("a1", "Agent", "🔵", 1);
    db.createThread("t1", "slack", "#general", "a1");

    db.insertMessage("t1", "slack", "inbound", "user1", "hi", ["a1"], {
      priority: "high",
      tags: ["urgent"],
    });

    const inbox = db.getInbox("a1");
    expect(inbox[0].message.metadata).toEqual({
      priority: "high",
      tags: ["urgent"],
    });
  });

  it("queueMessage preserves first-class scope carriers inside stored metadata without schema changes", () => {
    db.registerAgent("a1", "Agent", "🔵", 1);
    db.createThread("t-scope", "slack", "C_SCOPE", "a1");

    const scope = buildSlackCompatibilityScope({ teamId: "T_SCOPE", channelId: "C_SCOPE" });
    db.queueMessage("a1", {
      source: "slack",
      threadId: "t-scope",
      channel: "C_SCOPE",
      userId: "U_SCOPE",
      text: "scoped hello",
      timestamp: "100.200",
      scope,
    });

    const inbox = db.getInbox("a1");
    expect(inbox[0].message.metadata).toMatchObject({
      channel: "C_SCOPE",
      userId: "U_SCOPE",
      timestamp: "100.200",
      scope,
    });
  });

  it("insertMessage without metadata stores null", () => {
    db.registerAgent("a1", "Agent", "🔵", 1);
    db.createThread("t1", "slack", "#general", "a1");

    db.insertMessage("t1", "slack", "inbound", "user1", "hi", ["a1"]);

    const inbox = db.getInbox("a1");
    expect(inbox[0].message.metadata).toBeNull();
  });

  it("direction CHECK constraint rejects invalid values", () => {
    db.createThread("t1", "slack", "#general", "a1");
    expect(() => {
      db.insertMessage("t1", "slack", "invalid" as "inbound", "u", "x", []);
    }).toThrow();
  });

  it("double initialize is safe", () => {
    db.initialize(); // second call
    expect(db.getAgents()).toEqual([]);
  });

  it("throws when used before initialize", () => {
    const db2 = new BrokerDB(path.join(dir, "uninit.db"));
    expect(() => db2.getAgents()).toThrow("not initialized");
    // no close needed — never opened
  });
});

// ─── Leader election tests ───────────────────────────────

describe("LeaderLock", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("acquires lock when file does not exist", () => {
    const lock = new LeaderLock(path.join(dir, "test.lock"));
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isLeader()).toBe(true);
    lock.release();
    expect(lock.isLeader()).toBe(false);
  });

  it("writes current PID to lock file", () => {
    const lockPath = path.join(dir, "test.lock");
    const lock = new LeaderLock(lockPath);
    lock.tryAcquire();

    const content = fs.readFileSync(lockPath, "utf-8").trim();
    expect(content).toBe(String(process.pid));
    lock.release();
  });

  it("release removes lock file", () => {
    const lockPath = path.join(dir, "test.lock");
    const lock = new LeaderLock(lockPath);
    lock.tryAcquire();
    lock.release();

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("fails when lock is held by current process via different instance", () => {
    const lockPath = path.join(dir, "test.lock");

    // Simulate another instance holding the lock by writing our own PID
    // (process.pid is always running)
    fs.writeFileSync(lockPath, String(process.pid), "utf-8");

    const lock = new LeaderLock(lockPath);
    expect(lock.tryAcquire()).toBe(false);
    expect(lock.isLeader()).toBe(false);
  });

  it("reclaims stale lock (dead PID)", () => {
    const lockPath = path.join(dir, "test.lock");

    // Write a PID that almost certainly doesn't exist
    fs.writeFileSync(lockPath, "2147483647", "utf-8");

    const lock = new LeaderLock(lockPath);
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isLeader()).toBe(true);
    lock.release();
  });

  it("second lock on same file fails", () => {
    const lockPath = path.join(dir, "test.lock");
    const lock1 = new LeaderLock(lockPath);
    const lock2 = new LeaderLock(lockPath);

    expect(lock1.tryAcquire()).toBe(true);
    expect(lock2.tryAcquire()).toBe(false);

    lock1.release();
  });

  it("second lock succeeds after first releases", () => {
    const lockPath = path.join(dir, "test.lock");
    const lock1 = new LeaderLock(lockPath);
    const lock2 = new LeaderLock(lockPath);

    lock1.tryAcquire();
    lock1.release();

    expect(lock2.tryAcquire()).toBe(true);
    lock2.release();
  });

  it("tryAcquire is idempotent", () => {
    const lock = new LeaderLock(path.join(dir, "test.lock"));
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });

  it("release is safe when not acquired", () => {
    const lock = new LeaderLock(path.join(dir, "test.lock"));
    lock.release(); // should not throw
    expect(lock.isLeader()).toBe(false);
  });
});

// ─── Socket server tests (TCP mode for sandbox compat) ───

describe("BrokerSocketServer", () => {
  let dir: string;
  let db: BrokerDB;
  let server: BrokerSocketServer;

  beforeEach(async () => {
    dir = tmpDir();
    db = new BrokerDB(path.join(dir, "test.db"));
    db.initialize();
    // Use TCP with port 0 (auto-assign) since Unix sockets may be
    // blocked in sandboxed environments
    server = new BrokerSocketServer(db, { type: "tcp", host: "127.0.0.1", port: 0 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    cleanup(dir);
  });

  function getInfo() {
    return server.getConnectInfo() as { type: "tcp"; host: string; port: number };
  }

  async function sendRawLine(line: string): Promise<JsonRpcResponse> {
    const socket = await connectRawSocket(getInfo());

    const response = new Promise<JsonRpcResponse>((resolve) => {
      socket.once("data", (chunk) => {
        const payload = chunk.toString("utf-8").trim();
        resolve(JSON.parse(payload) as JsonRpcResponse);
      });
    });

    socket.write(line + "\n");
    const result = await response;
    socket.destroy();
    return result;
  }

  it("accepts connections", async () => {
    const client = await connectClient(getInfo());
    client.destroy();
  });

  it("allows loopback raw TCP listen targets and rejects non-loopback ones", () => {
    expect(
      () => new BrokerSocketServer(db, { type: "tcp", host: "localhost", port: 0 }),
    ).not.toThrow();
    expect(() => new BrokerSocketServer(db, { type: "tcp", host: "::1", port: 0 })).not.toThrow();
    expect(() => new BrokerSocketServer(db, { type: "tcp", host: "0.0.0.0", port: 0 })).toThrow(
      /loopback-only/i,
    );
    expect(
      () => new BrokerSocketServer(db, { type: "tcp", host: "192.168.1.25", port: 0 }),
    ).toThrow(/loopback-only/i);
  });

  it("register returns agentId", async () => {
    const client = await connectClient(getInfo());
    const res = await client.call("register", { name: "TestBot", emoji: "🤖" });

    expect(res.error).toBeUndefined();
    const result = res.result as { agentId: string; name: string; emoji: string };
    expect(result.agentId).toBeTruthy();
    expect(result.name).toBe("TestBot");
    expect(result.emoji).toBe("🤖");

    client.destroy();
  });

  it("unregister removes agent", async () => {
    const client = await connectClient(getInfo());
    await client.call("register", { name: "Bot", emoji: "🤖" });
    const res = await client.call("unregister");

    expect(res.error).toBeUndefined();
    expect((res.result as { ok: boolean }).ok).toBe(true);

    // Agent should be gone from DB
    expect(db.getAgents()).toHaveLength(0);

    client.destroy();
  });

  it("unregister fails when not registered", async () => {
    const client = await connectClient(getInfo());
    const res = await client.call("unregister");

    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain("Not registered");

    client.destroy();
  });

  it("heartbeat updates last_heartbeat for registered agents", async () => {
    const client = await connectClient(getInfo());
    const registerRes = await client.call("register", { name: "Pulse", emoji: "💓", pid: 1 });
    const agentId = (registerRes.result as { agentId: string }).agentId;
    const before = db.getAgentById(agentId)?.lastHeartbeat;
    expect(before).toBeDefined();

    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }

    const heartbeatRes = await client.call("heartbeat");
    expect(heartbeatRes.error).toBeUndefined();
    expect((heartbeatRes.result as { ok: boolean }).ok).toBe(true);

    const after = db.getAgentById(agentId)?.lastHeartbeat;
    expect(after).toBeDefined();
    expect(after! >= before!).toBe(true);

    client.destroy();
  });

  it("agents.list returns connected agents", async () => {
    const client1 = await connectClient(getInfo());
    const client2 = await connectClient(getInfo());

    await client1.call("register", { name: "Alpha", emoji: "🅰️" });
    await client2.call("register", { name: "Beta", emoji: "🅱️" });

    const res = await client1.call("agents.list");
    expect(res.error).toBeUndefined();
    const agents = res.result as Array<{ name: string }>;
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.name).sort()).toEqual(["Alpha", "Beta"]);

    client1.destroy();
    client2.destroy();
  });

  it("agents.list can include disconnected agents for visibility", async () => {
    const client1 = await connectClient(getInfo());
    const client2 = await connectClient(getInfo());

    await client1.call("register", { name: "Alpha", emoji: "🅰️" });
    const beta = await client2.call("register", { name: "Beta", emoji: "🅱️" });
    const betaId = (beta.result as { agentId: string }).agentId;
    await client2.call("unregister");

    const res = await client1.call("agents.list", { includeDisconnected: true });
    expect(res.error).toBeUndefined();
    const agents = res.result as Array<{ id: string; disconnectedAt?: string | null }>;
    expect(agents.map((a) => a.id)).toContain(betaId);
    expect(agents.find((a) => a.id === betaId)?.disconnectedAt).toBeTruthy();

    client1.destroy();
    client2.destroy();
  });

  it("send creates message and routes to other agents", async () => {
    const client1 = await connectClient(getInfo());
    const client2 = await connectClient(getInfo());

    await client1.call("register", { name: "Sender", emoji: "📤" });
    await client2.call("register", { name: "Receiver", emoji: "📥" });

    const sendRes = await client1.call("send", {
      threadId: "thread-1",
      body: "Hello from sender",
      source: "test",
      channel: "#test",
    });
    expect(sendRes.error).toBeUndefined();
    expect((sendRes.result as { messageId: number }).messageId).toBeGreaterThan(0);

    // Receiver should see it in inbox
    const pollRes = await client2.call("inbox.poll");
    expect(pollRes.error).toBeUndefined();
    const items = pollRes.result as Array<{ inboxId: number; message: { body: string } }>;
    expect(items).toHaveLength(1);
    expect(items[0].message.body).toBe("Hello from sender");

    // Sender should NOT see it in their own inbox
    const senderPoll = await client1.call("inbox.poll");
    expect((senderPoll.result as unknown[]).length).toBe(0);

    client1.destroy();
    client2.destroy();
  });

  it("inbox.ack marks messages as delivered", async () => {
    const client1 = await connectClient(getInfo());
    const client2 = await connectClient(getInfo());

    await client1.call("register", { name: "Sender", emoji: "📤" });
    await client2.call("register", { name: "Receiver", emoji: "📥" });

    await client1.call("send", {
      threadId: "t1",
      body: "test msg",
      source: "test",
      channel: "#test",
    });

    const poll1 = await client2.call("inbox.poll");
    const items = poll1.result as Array<{ inboxId: number }>;
    expect(items).toHaveLength(1);

    const ackRes = await client2.call("inbox.ack", { ids: [items[0].inboxId] });
    expect(ackRes.error).toBeUndefined();

    // Should be empty after ack
    const poll2 = await client2.call("inbox.poll");
    expect((poll2.result as unknown[]).length).toBe(0);

    client1.destroy();
    client2.destroy();
  });

  it("threads.list returns agent threads", async () => {
    const client = await connectClient(getInfo());
    await client.call("register", { name: "Bot", emoji: "🤖" });

    await client.call("send", {
      threadId: "t1",
      body: "msg1",
      source: "test",
      channel: "#general",
    });
    await client.call("send", {
      threadId: "t2",
      body: "msg2",
      source: "test",
      channel: "#random",
    });

    const res = await client.call("threads.list");
    expect(res.error).toBeUndefined();
    const threads = res.result as Array<{ threadId: string }>;
    expect(threads).toHaveLength(2);

    client.destroy();
  });

  it("unknown method returns error", async () => {
    const client = await connectClient(getInfo());
    const res = await client.call("nonexistent.method");

    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32601);
    expect(res.error!.message).toContain("Unknown method");

    client.destroy();
  });

  it("invalid JSON returns parse error", async () => {
    const res = await sendRawLine("not valid json");

    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32700);
    expect(res.id).toBeNull();
  });

  it("rejects non-object JSON-RPC payloads as invalid requests", async () => {
    for (const payload of ["null", "[]", "true", "123"]) {
      const res = await sendRawLine(payload);
      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32600);
      expect(res.id).toBeNull();
    }
  });

  it("rejects requests with the wrong jsonrpc version", async () => {
    const res = await sendRawLine(
      JSON.stringify({ jsonrpc: "1.0", id: 7, method: "register", params: {} }),
    );

    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32600);
    expect(res.id).toBe(7);
  });

  it("rejects requests with invalid ids", async () => {
    for (const id of [null, false, 0, ""]) {
      const res = await sendRawLine(
        JSON.stringify({ jsonrpc: "2.0", id, method: "register", params: {} }),
      );
      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32600);
      expect(res.id).toBeNull();
    }
  });

  it("rejects requests with non-object params", async () => {
    const res = await sendRawLine(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "register", params: [] }),
    );

    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32600);
    expect(res.id).toBe(9);
  });

  it("cleans up agent on disconnect", async () => {
    const client = await connectClient(getInfo());
    await client.call("register", { name: "Ephemeral", emoji: "💨" });

    expect(db.getAgents()).toHaveLength(1);

    client.destroy();

    // Wait for close event to propagate
    await new Promise((r) => setTimeout(r, 50));

    expect(db.getAgents()).toHaveLength(0);
  });

  it("send without registration fails", async () => {
    const client = await connectClient(getInfo());
    const res = await client.call("send", { threadId: "t1", body: "hi" });

    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain("Not registered");

    client.destroy();
  });

  it("inbox.ack with invalid ids param returns error", async () => {
    const client = await connectClient(getInfo());
    await client.call("register", { name: "Bot", emoji: "🤖" });

    const res = await client.call("inbox.ack", { ids: "not-an-array" });
    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain("array");

    client.destroy();
  });
});

// ─── startBroker leader lock integration ─────────────────
// Use TCP with port 0 (auto-assign) since Unix sockets may be
// blocked in sandboxed environments.

describe("startBroker leader lock", () => {
  const TCP_TARGET = { type: "tcp" as const, host: "127.0.0.1", port: 0 };
  let dir: string;
  const brokers: Broker[] = [];

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(async () => {
    for (const b of brokers.splice(0)) {
      await b.stop();
    }
    cleanup(dir);
  });

  /** Helper: start a broker with TCP + per-test dir, track for cleanup */
  async function launch(
    overrides: { lockPath?: string; dbSuffix?: string; meshSecretPath?: string } = {},
  ): Promise<Broker> {
    const b = await startBroker({
      dbPath: path.join(dir, `${overrides.dbSuffix ?? "test"}.db`),
      listenTarget: TCP_TARGET,
      lockPath: overrides.lockPath ?? path.join(dir, "broker.lock"),
      ...(overrides.meshSecretPath ? { meshSecretPath: overrides.meshSecretPath } : {}),
    });
    brokers.push(b);
    return b;
  }

  it("acquires lock on startup and releases on stop", async () => {
    const lockPath = path.join(dir, "broker.lock");
    const broker = await launch({ lockPath });

    // Lock file should exist with our PID
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf-8").trim()).toBe(String(process.pid));

    await broker.stop();
    brokers.length = 0;

    // Lock file should be cleaned up
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("rejects second broker while first is running", async () => {
    const lockPath = path.join(dir, "broker.lock");
    await launch({ lockPath });

    await expect(
      startBroker({
        dbPath: path.join(dir, "test2.db"),
        listenTarget: TCP_TARGET,
        lockPath,
        meshSecretPath: path.join(dir, "pinet.secret"),
      }),
    ).rejects.toThrow("Another pinet broker is already running");
  });

  it("second broker starts after first stops", async () => {
    const lockPath = path.join(dir, "broker.lock");
    const broker1 = await launch({ lockPath });
    await broker1.stop();
    brokers.length = 0;

    const broker2 = await launch({ lockPath, dbSuffix: "test2" });
    expect(broker2.lock.isLeader()).toBe(true);
  });

  it("reclaims stale lock from dead process", async () => {
    const lockPath = path.join(dir, "broker.lock");

    // Simulate a crashed broker by writing a dead PID
    fs.writeFileSync(lockPath, "2147483647", "utf-8");

    const broker = await launch({ lockPath });
    expect(broker.lock.isLeader()).toBe(true);
  });

  it("rejects non-loopback raw TCP listen targets before creating broker artifacts", async () => {
    const lockPath = path.join(dir, "broker.lock");
    const meshSecretPath = path.join(dir, "pinet.secret");

    await expect(
      startBroker({
        dbPath: path.join(dir, "blocked.db"),
        listenTarget: { type: "tcp", host: "0.0.0.0", port: 0 },
        lockPath,
        meshSecretPath,
      }),
    ).rejects.toThrow(/loopback-only/i);

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(meshSecretPath)).toBe(false);
  });

  it("releases broker resources when TLS listener validation fails", async () => {
    const lockPath = path.join(dir, "broker.lock");

    await expect(
      startBroker({
        dbPath: path.join(dir, "invalid-tls.db"),
        listenTarget: {
          type: "tls",
          host: "0.0.0.0",
          port: 0,
          tls: { key: "", cert: "" },
        },
        lockPath,
      }),
    ).rejects.toThrow(/requires both a private key and a certificate/i);

    expect(fs.existsSync(lockPath)).toBe(false);
    const recovered = await launch({ lockPath, dbSuffix: "after-invalid-tls" });
    expect(recovered.lock.isLeader()).toBe(true);
  });

  it("starts without creating a mesh secret when none is configured", async () => {
    const meshSecretPath = path.join(dir, "pinet.secret");

    await launch();

    expect(fs.existsSync(meshSecretPath)).toBe(false);
  });

  it("creates and persists a mesh secret on startup when a secret path is configured", async () => {
    const meshSecretPath = path.join(dir, "pinet.secret");

    await launch({ meshSecretPath });

    expect(fs.existsSync(meshSecretPath)).toBe(true);
    const secret = fs.readFileSync(meshSecretPath, "utf-8").trim();
    expect(secret).toHaveLength(64);
  });

  it("releases lock when db initialization fails", async () => {
    const lockPath = path.join(dir, "broker.lock");

    // Make the db path a directory so SQLite open fails
    const badDbPath = path.join(dir, "bad.db");
    fs.mkdirSync(badDbPath, { recursive: true });

    await expect(
      startBroker({
        dbPath: badDbPath,
        listenTarget: TCP_TARGET,
        lockPath,
        meshSecretPath: path.join(dir, "pinet.secret"),
      }),
    ).rejects.toThrow();

    // Lock should have been cleaned up on failure
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
