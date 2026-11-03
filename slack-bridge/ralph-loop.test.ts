import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyTrackedAssignmentIdleReplyStalls,
  buildTrackedAssignmentReplyNudgeMessage,
  clearRalphLoopSnooze,
  createRalphLoopState,
  getRalphLoopSnoozeStatus,
  hydrateRalphLoopReportedGhosts,
  runRalphLoopCycle,
  setRalphLoopSnooze,
  startRalphLoop,
  stopRalphLoop,
  type RalphLoopDeps,
} from "./ralph-loop.js";
import { DEFAULT_RALPH_LOOP_INTERVAL_MS, rewriteRalphLoopGhostAnomalies } from "./helpers.js";
import { BrokerDB } from "./broker/schema.js";
import * as taskAssignments from "./task-assignments.js";
import * as gitMetadata from "./git-metadata.js";

function createLoopDeps(overrides: Partial<RalphLoopDeps> = {}): RalphLoopDeps {
  return {
    getBrokerDb: () => null,
    getBrokerAgentId: () => null,
    heartbeatTimerActive: () => true,
    maintenanceTimerActive: () => true,
    runMaintenance: vi.fn(),
    sendMaintenanceMessage: vi.fn(),
    trySendFollowUp: vi.fn(),
    logActivity: vi.fn(),
    formatTrackedAgent: vi.fn((agentId: string) => agentId),
    summarizeTrackedAssignmentStatus: vi.fn(() => ({ summary: "assigned", tone: "info" })),
    refreshHomeTabs: vi.fn(async () => undefined),
    getLastMaintenance: vi.fn(() => null),
    buildControlPlaneDashboardSnapshot: vi.fn((input) => input as never),
    setLastHomeTabSnapshot: vi.fn(),
    getLastHomeTabError: vi.fn(() => null),
    setLastHomeTabError: vi.fn(),
    ...overrides,
  };
}

function buildEvaluation(ghostAgentIds: string[]) {
  return {
    ghostAgentIds,
    nudgeAgentIds: [],
    idleDrainAgentIds: [],
    stuckAgentIds: [],
    anomalies:
      ghostAgentIds.length > 0 ? [`ghost agents detected: ${ghostAgentIds.join(", ")}`] : [],
  };
}

describe("startRalphLoop", () => {
  it("uses the configured RALPH loop interval for the broker timer", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const state = createRalphLoopState();

    try {
      startRalphLoop({} as ExtensionContext, state, {
        ...createLoopDeps(),
        getSettings: () => ({ ralphLoopIntervalMs: 123_000 }),
      });

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 123_000);
    } finally {
      stopRalphLoop(state);
      setIntervalSpy.mockRestore();
    }
  });

  it("uses the five-minute default when no interval is configured", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const state = createRalphLoopState();

    try {
      startRalphLoop({} as ExtensionContext, state, createLoopDeps());

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        DEFAULT_RALPH_LOOP_INTERVAL_MS,
      );
    } finally {
      stopRalphLoop(state);
      setIntervalSpy.mockRestore();
    }
  });

  it("falls back before scheduling oversized intervals that Node would overflow", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const state = createRalphLoopState();

    try {
      startRalphLoop({} as ExtensionContext, state, {
        ...createLoopDeps(),
        getSettings: () => ({ ralphLoopIntervalMs: 3_000_000_000 }),
      });

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        DEFAULT_RALPH_LOOP_INTERVAL_MS,
      );
    } finally {
      stopRalphLoop(state);
      setIntervalSpy.mockRestore();
    }
  });
});

describe("RALPH snooze state", () => {
  it("sets, reports, and clears manual snooze state", () => {
    const state = createRalphLoopState();

    const active = setRalphLoopSnooze(state, {
      durationMs: 30 * 60_000,
      reason: "no work available",
      now: 1_000,
    });

    expect(active).toMatchObject({
      active: true,
      until: new Date(1_000 + 30 * 60_000).toISOString(),
      remainingMs: 30 * 60_000,
      reason: "no work available",
      source: "manual",
    });
    expect(getRalphLoopSnoozeStatus(state, 1_000 + 30 * 60_000 + 1)).toMatchObject({
      active: false,
      remainingMs: 0,
      reason: null,
      source: null,
    });

    clearRalphLoopSnooze(state);

    expect(getRalphLoopSnoozeStatus(state, 1_000)).toMatchObject({ active: false });
  });
});

describe("runRalphLoopCycle snooze", () => {
  it("keeps manual snooze for unchanged assignments and wakes for new work", async () => {
    const db = new BrokerDB(":memory:");
    db.initialize();
    vi.spyOn(gitMetadata, "probeGitBranch").mockResolvedValue(undefined);
    const resolve = taskAssignments.resolveTaskAssignments;
    const runner: taskAssignments.CommandRunner = async () => ({
      stdout: JSON.stringify({ state: "OPEN" }),
    });
    vi.spyOn(taskAssignments, "resolveTaskAssignments").mockImplementation(
      (assignments, cwd, _runner, lanes) => resolve(assignments, cwd, runner, lanes),
    );
    const state = createRalphLoopState();
    const followUp = vi.fn();
    const deps = createLoopDeps({
      getBrokerDb: () => db,
      getBrokerAgentId: () => "broker",
      trySendFollowUp: followUp,
    });
    const ctx = {
      isIdle: (): boolean => true,
      ui: { notify: (_message: string, _level?: string): void => {} },
    } as ExtensionContext;
    try {
      db.recordTaskAssignment("old-worker", 732, null, "a2a:old", null);
      await runRalphLoopCycle(ctx, state, deps);
      expect(state.pendingTaskAssignmentReport).not.toBeNull();
      followUp.mockClear();
      setRalphLoopSnooze(state, { durationMs: 8 * 60 * 60_000 });
      await runRalphLoopCycle(ctx, state, deps);
      await runRalphLoopCycle(ctx, state, deps);
      expect(getRalphLoopSnoozeStatus(state).active).toBe(true);
      expect(followUp).not.toHaveBeenCalled();
      db.recordTaskAssignment("new-worker", 733, null, "a2a:new", null);
      await runRalphLoopCycle(ctx, state, deps);
      expect(getRalphLoopSnoozeStatus(state).active).toBe(false);
      expect(followUp).toHaveBeenCalled();
    } finally {
      db.close();
      vi.restoreAllMocks();
    }
  });

  it.each(["participant", "agent"] as const)(
    "reports the exited worker's lane PR via %s on a differently named branch",
    async (link) => {
      const db = new BrokerDB(":memory:");
      db.initialize();
      vi.spyOn(gitMetadata, "probeGitBranch").mockResolvedValue(undefined);
      const resolve = taskAssignments.resolveTaskAssignments;
      const runner: taskAssignments.CommandRunner = async (file, args) => {
        if (file === "gh" && args[0] === "issue")
          return { stdout: JSON.stringify({ number: 732, state: "OPEN" }) };
        if (file === "gh" && args[1] === "list") return { stdout: "[]" };
        if (file === "gh" && args[1] === "view" && args[2] === "9000")
          return {
            stdout: JSON.stringify({
              number: 9000,
              state: "OPEN",
              mergedAt: null,
              headRefName: "fix/descriptive-name",
            }),
          };
        throw new Error(`Unexpected fake command: ${file} ${args.join(" ")}`);
      };
      vi.spyOn(taskAssignments, "resolveTaskAssignments").mockImplementation(
        (assignments, cwd, _runner, lanes) => resolve(assignments, cwd, runner, lanes),
      );
      const followUp = vi.fn();
      const deps = createLoopDeps({
        getBrokerDb: () => db,
        getBrokerAgentId: () => "broker",
        trySendFollowUp: followUp,
      });
      const ctx = {
        isIdle: (): boolean => true,
        ui: { notify: (_message: string, _level?: string): void => {} },
      } as ExtensionContext;
      try {
        db.registerAgent(
          "worker",
          "Worker",
          "W",
          123,
          link === "agent" ? { laneId: "historical" } : {},
        );
        db.disconnectAgent("worker", 0);
        db.recordTaskAssignment("worker", 732, "issue-732", "a2a:worker", null, {
          repoOwner: "gugu91",
          repoName: "pinet",
        });
        db.upsertPinetLane({
          laneId: "historical",
          issueNumber: 732,
          prNumber: 9000,
          state: "detached",
        });
        if (link === "participant")
          db.setPinetLaneParticipant({
            laneId: "historical",
            agentId: "worker",
            role: "implementer",
            status: "exited",
          });
        db.upsertPinetLane({
          laneId: "other-worker",
          issueNumber: 732,
          prNumber: 9999,
          ownerAgentId: "other-worker",
        });
        db.upsertPinetLane({
          laneId: "other-issue",
          issueNumber: 733,
          prNumber: 8888,
          ownerAgentId: "worker",
        });
        await runRalphLoopCycle(ctx, createRalphLoopState(), deps);
        expect(db.listTaskAssignments()[0]).toMatchObject({ status: "pr_open", prNumber: 9000 });
        expect(followUp.mock.calls.map(([body]) => body).join("\n")).toContain("PR #9000");
        expect(followUp.mock.calls.map(([body]) => body).join("\n")).not.toContain(
          "no commits, no PR",
        );
      } finally {
        db.close();
        vi.restoreAllMocks();
      }
    },
  );

  it("auto-snoozes after configured empty cycles and quiets later empty cycle logs", async () => {
    const state = createRalphLoopState();
    const logActivity = vi.fn();
    const records: unknown[] = [];
    const db = {
      getRecentRalphCycles: () => [],
      getAllAgents: () => [],
      getPendingInboxCount: () => 0,
      getOwnedThreadCount: () => 0,
      getBacklogCount: () => 0,
      listTaskAssignmentsAwaitingFirstReply: () => [],
      listTaskAssignments: () => [],
      getMessagesByIds: () => [],
      listPinetLanes: () => [],
      recordRalphCycle: (record: unknown) => {
        records.push(record);
      },
    };
    const deps = createLoopDeps({
      getBrokerDb: () => db as never,
      getBrokerAgentId: () => "broker-1",
      getLastMaintenance: () => ({
        pendingBacklogCount: 0,
        assignedBacklogCount: 0,
        reapedAgentIds: [],
        nudgedAgentIds: [],
        repairedThreadClaims: 0,
        anomalies: [],
      }),
      getSettings: () => ({
        ralphSnoozeAfterEmptyCycles: 2,
        ralphSnoozeDurationMs: 10 * 60_000,
      }),
      logActivity,
    });
    const ctx = { isIdle: () => true, ui: { notify: vi.fn() } } as unknown as ExtensionContext;

    const originalCwd = process.cwd();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-snooze-test-"));
    try {
      process.chdir(tempDir);
      await runRalphLoopCycle(ctx, state, deps);
      await runRalphLoopCycle(ctx, state, deps);
      await runRalphLoopCycle(ctx, state, deps);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(state.snoozeEmptyCycleCount).toBe(3);
    expect(getRalphLoopSnoozeStatus(state).active).toBe(true);
    expect(records).toHaveLength(3);
    expect(logActivity.mock.calls.map(([entry]) => entry.title)).toEqual([
      "RALPH cycle",
      "RALPH snoozed",
    ]);
  });

  it("wakes a manual snooze when a new live worker becomes active", async () => {
    const state = createRalphLoopState();
    const logActivity = vi.fn();
    const now = new Date().toISOString();
    const db = {
      getRecentRalphCycles: () => [],
      getAllAgents: () => [
        {
          id: "worker-1",
          name: "Busy Spren",
          emoji: "😱",
          pid: 1234,
          connectedAt: now,
          lastSeen: now,
          lastHeartbeat: now,
          lastActivity: now,
          metadata: null,
          status: "working",
        },
      ],
      getPendingInboxCount: () => 0,
      getOwnedThreadCount: () => 0,
      getBacklogCount: () => 0,
      listTaskAssignmentsAwaitingFirstReply: () => [],
      listTaskAssignments: () => [],
      getMessagesByIds: () => [],
      listPinetLanes: () => [],
      recordRalphCycle: vi.fn(),
    };
    const deps = createLoopDeps({
      getBrokerDb: () => db as never,
      getBrokerAgentId: () => "broker-1",
      getLastMaintenance: () => ({
        pendingBacklogCount: 0,
        assignedBacklogCount: 0,
        reapedAgentIds: [],
        nudgedAgentIds: [],
        repairedThreadClaims: 0,
        anomalies: [],
      }),
      getSettings: () => ({ ralphSnoozeAfterEmptyCycles: 1 }),
      logActivity,
    });
    const ctx = { isIdle: () => true, ui: { notify: vi.fn() } } as unknown as ExtensionContext;

    const originalCwd = process.cwd();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-snooze-test-"));
    const agents = vi.spyOn(db, "getAllAgents").mockReturnValueOnce([]);
    try {
      process.chdir(tempDir);
      await runRalphLoopCycle(ctx, state, deps);
      setRalphLoopSnooze(state, { durationMs: 10 * 60_000, now: Date.now() });
      state.snoozeEmptyCycleCount = 4;
      await runRalphLoopCycle(ctx, state, deps);
    } finally {
      agents.mockRestore();
      process.chdir(originalCwd);
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(getRalphLoopSnoozeStatus(state).active).toBe(false);
    expect(state.snoozeEmptyCycleCount).toBe(0);
    expect(logActivity.mock.calls.map(([entry]) => entry.title)).toContain("RALPH snooze ended");
  });

  it("does not auto-snooze while a tracked assignment remains active", async () => {
    const state = createRalphLoopState();
    state.taskAssignmentReportSignature = [
      "RALPH LOOP — WORKER STATUS:",
      "- worker-1: #732 → no commits, no PR ⚠️",
    ].join("\n");
    const logActivity = vi.fn();
    const records: unknown[] = [];
    const now = new Date().toISOString();
    const db = {
      getRecentRalphCycles: () => [],
      getAllAgents: () => [],
      getPendingInboxCount: () => 0,
      getOwnedThreadCount: () => 0,
      getBacklogCount: () => 0,
      listTaskAssignmentsAwaitingFirstReply: () => [],
      listTaskAssignments: () => [
        {
          id: 1,
          agentId: "worker-1",
          issueNumber: 732,
          branch: null,
          prNumber: null,
          status: "assigned",
          threadId: "a2a:test",
          sourceMessageId: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      getMessagesByIds: () => [],
      listPinetLanes: () => [],
      recordRalphCycle: (record: unknown) => {
        records.push(record);
      },
    };
    const deps = createLoopDeps({
      getBrokerDb: () => db as never,
      getBrokerAgentId: () => "broker-1",
      getLastMaintenance: () => ({
        pendingBacklogCount: 0,
        assignedBacklogCount: 0,
        reapedAgentIds: [],
        nudgedAgentIds: [],
        repairedThreadClaims: 0,
        anomalies: [],
      }),
      getSettings: () => ({ ralphSnoozeAfterEmptyCycles: 1 }),
      logActivity,
    });
    const ctx = { isIdle: () => true, ui: { notify: vi.fn() } } as unknown as ExtensionContext;

    const originalCwd = process.cwd();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-snooze-test-"));
    try {
      process.chdir(tempDir);
      await runRalphLoopCycle(ctx, state, deps);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(getRalphLoopSnoozeStatus(state).active).toBe(false);
    expect(state.snoozeEmptyCycleCount).toBe(0);
    expect(records).toHaveLength(1);
    expect(logActivity.mock.calls.map(([entry]) => entry.title)).toEqual(["RALPH cycle"]);
  });
});

describe("hydrateRalphLoopReportedGhosts", () => {
  it("hydrates the latest persisted ghost ids into a fresh state", () => {
    const state = createRalphLoopState();

    hydrateRalphLoopReportedGhosts(state, [{ ghostAgentIds: ["ghost-1", "ghost-2"] }]);

    expect([...state.reportedGhosts]).toEqual(["ghost-1", "ghost-2"]);
    expect(state.ghostBaselineHydrated).toBe(true);
  });

  it("does not overwrite active in-memory ghost state", () => {
    const state = createRalphLoopState();
    state.reportedGhosts.add("live-ghost");

    hydrateRalphLoopReportedGhosts(state, [{ ghostAgentIds: ["persisted-ghost"] }]);

    expect([...state.reportedGhosts]).toEqual(["live-ghost"]);
    expect(state.ghostBaselineHydrated).toBe(true);
  });

  it("suppresses re-announcing the same persisted ghost ids as NEW after a state reset", () => {
    const state = createRalphLoopState();
    hydrateRalphLoopReportedGhosts(state, [{ ghostAgentIds: ["ghost-1"] }]);

    const rewritten = rewriteRalphLoopGhostAnomalies(
      buildEvaluation(["ghost-1"]),
      state.reportedGhosts,
    );

    expect(rewritten.evaluation.ghostAgentIds).toEqual(["ghost-1"]);
    expect(rewritten.evaluation.anomalies).toEqual([]);
    expect(rewritten.newGhostIds).toEqual([]);
    expect(rewritten.nextReportedGhostIds).toEqual(["ghost-1"]);
  });

  it("still announces truly new ghost ids when the latest persisted cycle was healthy", () => {
    const state = createRalphLoopState();
    hydrateRalphLoopReportedGhosts(state, [{ ghostAgentIds: [] }]);

    const rewritten = rewriteRalphLoopGhostAnomalies(
      buildEvaluation(["ghost-1"]),
      state.reportedGhosts,
    );

    expect(rewritten.evaluation.anomalies).toEqual(["NEW ghost agents detected: ghost-1"]);
    expect(rewritten.newGhostIds).toEqual(["ghost-1"]);
    expect(rewritten.nextReportedGhostIds).toEqual(["ghost-1"]);
  });
});

describe("applyTrackedAssignmentIdleReplyStalls", () => {
  it("flags and nudges healthy idle assignees that never replied after a tracked assignment", () => {
    const evaluation = {
      ghostAgentIds: [],
      nudgeAgentIds: [],
      idleDrainAgentIds: [],
      stuckAgentIds: [],
      anomalies: [],
    };

    const pending = applyTrackedAssignmentIdleReplyStalls(
      evaluation,
      [
        {
          id: "worker-1",
          name: "Quiet Otter",
          status: "idle",
          lastHeartbeat: "2026-04-20T10:00:15.000Z",
        },
        { id: "worker-2", name: "Busy Crane", status: "working" },
      ],
      [
        {
          id: 1,
          agentId: "worker-1",
          issueNumber: 114,
          status: "assigned",
          sourceMessageId: 10,
          originalSenderAgentId: "broker",
        },
        {
          id: 2,
          agentId: "worker-1",
          issueNumber: 463,
          status: "assigned",
          sourceMessageId: 11,
          originalSenderAgentId: "broker",
        },
        {
          id: 3,
          agentId: "worker-2",
          issueNumber: 999,
          status: "assigned",
          sourceMessageId: 12,
          originalSenderAgentId: "broker",
        },
      ],
      { now: Date.parse("2026-04-20T10:00:20.000Z") },
    );

    expect(pending).toEqual(new Map([["worker-1", [114, 463]]]));
    expect(evaluation.nudgeAgentIds).toEqual(["worker-1"]);
    expect(evaluation.anomalies).toEqual([
      "Quiet Otter idle after tracked assignments #114, #463 without any agent reply to the original sender",
    ]);
  });

  it("ignores idle tracked assignees that are disconnected, resumable, or stale", () => {
    const evaluation = {
      ghostAgentIds: [],
      nudgeAgentIds: [],
      idleDrainAgentIds: [],
      stuckAgentIds: [],
      anomalies: [],
    };

    const pending = applyTrackedAssignmentIdleReplyStalls(
      evaluation,
      [
        {
          id: "healthy-worker",
          name: "Careful Moth",
          status: "idle",
          lastHeartbeat: "2026-04-20T10:00:15.000Z",
        },
        {
          id: "ghost-worker",
          name: "Ghost Goose",
          status: "idle",
          disconnectedAt: "2026-04-20T10:00:19.000Z",
        },
        {
          id: "resumable-worker",
          name: "Resumable Raven",
          status: "idle",
          disconnectedAt: "2026-04-20T10:00:19.000Z",
          resumableUntil: "2026-04-20T10:01:00.000Z",
        },
        {
          id: "stale-worker",
          name: "Stale Stoat",
          status: "idle",
          lastHeartbeat: "2026-04-20T10:00:09.000Z",
        },
      ],
      [
        {
          id: 1,
          agentId: "healthy-worker",
          issueNumber: 463,
          status: "assigned",
          sourceMessageId: 10,
          originalSenderAgentId: "broker",
        },
        {
          id: 2,
          agentId: "ghost-worker",
          issueNumber: 464,
          status: "assigned",
          sourceMessageId: 11,
          originalSenderAgentId: "broker",
        },
        {
          id: 3,
          agentId: "resumable-worker",
          issueNumber: 465,
          status: "assigned",
          sourceMessageId: 12,
          originalSenderAgentId: "broker",
        },
        {
          id: 4,
          agentId: "stale-worker",
          issueNumber: 466,
          status: "assigned",
          sourceMessageId: 13,
          originalSenderAgentId: "broker",
        },
      ],
      { now: Date.parse("2026-04-20T10:00:20.000Z") },
    );

    expect(pending).toEqual(new Map([["healthy-worker", [463]]]));
    expect(evaluation.nudgeAgentIds).toEqual(["healthy-worker"]);
    expect(evaluation.anomalies).toEqual([
      "Careful Moth idle after tracked assignment #463 without any agent reply to the original sender",
    ]);
  });
});

describe("buildTrackedAssignmentReplyNudgeMessage", () => {
  it("asks the assignee to report outcome or blocker for the tracked issues", () => {
    expect(buildTrackedAssignmentReplyNudgeMessage([114, 463], "2026-04-20T10:00:00.000Z")).toBe(
      "RALPH LOOP nudge (2026-04-20T10:00:00.000Z): you are idle after tracked assignments #114, #463 and still have not sent any agent reply to the original sender. Please report outcome or blocker now.",
    );
  });
});
