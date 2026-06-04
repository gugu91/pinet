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

  it("wakes a manual snooze when a live worker is active", async () => {
    const state = createRalphLoopState();
    setRalphLoopSnooze(state, { durationMs: 10 * 60_000, now: Date.now() });
    state.snoozeEmptyCycleCount = 4;
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
    try {
      process.chdir(tempDir);
      await runRalphLoopCycle(ctx, state, deps);
    } finally {
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

describe("runRalphLoopCycle GitHub event relay", () => {
  async function runGithubRelayCycle(
    overrides: {
      resolvedStatus?: "assigned" | "pr_open" | "pr_merged";
      nextStatus?: "assigned" | "pr_open" | "pr_merged" | "pr_closed";
      nextPrNumber?: number | null;
      safeThread?: boolean;
    } = {},
  ) {
    const state = createRalphLoopState();
    const logActivity = vi.fn();
    const emitGithubEventRelay = vi.fn(async () => undefined);
    const upsertPinetLane = vi.fn();
    const updateTaskAssignmentProgress = vi.fn();
    const now = new Date().toISOString();
    const rawAssignment = {
      id: 1,
      agentId: "worker-1",
      issueNumber: 774,
      branch: "feat/github-event-relay-774",
      prNumber: null,
      status: "assigned",
      threadId: "a2a:broker:worker",
      sourceMessageId: null,
      repoOwner: "gugu91",
      repoName: "extensions",
      repoRoot: null,
      taskKind: "implementation",
      createdAt: now,
      updatedAt: now,
    } as const;
    const lane = {
      laneId: "issue-774",
      name: null,
      task: null,
      issueNumber: 774,
      prNumber: null,
      threadId: "123.456",
      ownerAgentId: null,
      implementationLeadAgentId: null,
      pmMode: false,
      state: "active",
      summary: null,
      metadata: { consent: "maintainer", github: { owner: "gugu91", repo: "extensions" } },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      participants: [],
    };
    const db = {
      getRecentRalphCycles: () => [],
      getAllAgents: () => [],
      getPendingInboxCount: () => 0,
      getOwnedThreadCount: () => 0,
      getBacklogCount: () => 0,
      listTaskAssignmentsAwaitingFirstReply: () => [],
      listTaskAssignments: () => [rawAssignment],
      getMessagesByIds: () => [],
      listPinetLanes: () => [lane],
      upsertPinetLane,
      updateTaskAssignmentProgress,
      getThread: (threadId: string) =>
        overrides.safeThread === false || threadId !== "123.456"
          ? null
          : {
              threadId: "123.456",
              source: "slack",
              channel: "C123",
              ownerAgent: "worker-1",
              ownerBinding: null,
              metadata: null,
              createdAt: now,
              updatedAt: now,
            },
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
      logActivity,
      emitGithubEventRelay,
      resolveTrackedTaskAssignments: vi.fn(async () => [
        {
          ...rawAssignment,
          status: overrides.resolvedStatus ?? "assigned",
          prNumber:
            (overrides.resolvedStatus ?? "assigned") === (overrides.nextStatus ?? "pr_open")
              ? overrides.nextPrNumber === undefined
                ? 123
                : overrides.nextPrNumber
              : rawAssignment.prNumber,
          nextStatus: overrides.nextStatus ?? "pr_open",
          nextPrNumber: overrides.nextPrNumber === undefined ? 123 : overrides.nextPrNumber,
          branchAheadCount: 0,
          issueState: "OPEN" as const,
        },
      ]),
    });
    const ctx = { isIdle: () => true, ui: { notify: vi.fn() } } as unknown as ExtensionContext;

    const originalCwd = process.cwd();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-github-relay-test-"));
    try {
      process.chdir(tempDir);
      await runRalphLoopCycle(ctx, state, deps);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    return { emitGithubEventRelay, logActivity, upsertPinetLane, updateTaskAssignmentProgress };
  }

  it("emits PR-open relays, merges lane metadata, and updates assignment progress", async () => {
    const { emitGithubEventRelay, upsertPinetLane, updateTaskAssignmentProgress } =
      await runGithubRelayCycle();

    expect(updateTaskAssignmentProgress).toHaveBeenCalledWith(1, "pr_open", 123);
    expect(upsertPinetLane).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "issue-774",
        prNumber: 123,
        metadata: expect.objectContaining({
          consent: "maintainer",
          github: expect.objectContaining({
            owner: "gugu91",
            repo: "extensions",
            repoKey: "gugu91/extensions",
            prNumber: 123,
            status: "pr_open",
          }),
        }),
      }),
    );
    expect(emitGithubEventRelay).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { threadId: "123.456", source: "slack", channel: "C123" },
        text: expect.stringContaining("opened/ready for review"),
        metadata: expect.objectContaining({
          githubEventRelay: expect.objectContaining({ status: "pr_open", prNumber: 123 }),
        }),
      }),
    );
  });

  it("skips unchanged assignments to preserve status-transition dedupe", async () => {
    const { emitGithubEventRelay, upsertPinetLane, updateTaskAssignmentProgress } =
      await runGithubRelayCycle({ resolvedStatus: "pr_open", nextStatus: "pr_open" });

    expect(updateTaskAssignmentProgress).not.toHaveBeenCalled();
    expect(upsertPinetLane).not.toHaveBeenCalled();
    expect(emitGithubEventRelay).not.toHaveBeenCalled();
  });

  it("skips visible delivery when no safe Slack-backed target is resolvable", async () => {
    const { emitGithubEventRelay, logActivity, upsertPinetLane } = await runGithubRelayCycle({
      safeThread: false,
    });

    expect(upsertPinetLane).toHaveBeenCalled();
    expect(emitGithubEventRelay).not.toHaveBeenCalled();
    expect(logActivity.mock.calls.map(([entry]) => entry.title)).toContain("GitHub relay skipped");
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
