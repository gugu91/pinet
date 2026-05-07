import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { BrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-dashboard.js";
import {
  createPinetHomeTabs,
  type PinetHomeTabsBrokerPort,
  type PinetHomeTabsDeps,
} from "./pinet-home-tabs.js";

function createBrokerHomeTabs(): PinetHomeTabsBrokerPort {
  let lastHomeTabError: string | null = null;

  return {
    isConnected: vi.fn(() => false),
    publishCurrentHomeTabSafely: vi.fn(async () => false),
    getHomeTabViewerIds: vi.fn(() => []),
    getLastHomeTabError: vi.fn(() => lastHomeTabError),
    setLastHomeTabSnapshot: vi.fn(),
    setLastHomeTabRefreshAt: vi.fn(),
    setLastHomeTabError: vi.fn((value: string | null) => {
      lastHomeTabError = value;
    }),
  };
}

function createContext() {
  const notify = vi.fn();
  const ctx = {
    ui: {
      notify,
    },
  } as unknown as ExtensionContext;

  return { ctx, notify };
}

function createBrokerSnapshot(): BrokerControlPlaneDashboardSnapshot {
  return {
    cycleStartedAt: "2026-04-15T00:00:00.000Z",
    cycleDurationMs: 2500,
    currentBranch: "main",
    totalAgents: 2,
    liveAgents: 2,
    brokerCount: 1,
    workerCount: 1,
    idleWorkers: 0,
    workingWorkers: 1,
    ghostAgents: 1,
    stuckAgents: 1,
    pendingBacklogCount: 3,
    nudgesThisCycle: 1,
    idleDrainCandidates: 0,
    assignedBacklogCount: 1,
    reapedAgents: 1,
    repairedThreadClaims: 2,
    maintenanceAnomalies: ["released 2 orphaned thread claims"],
    anomalies: ["ghost agents detected: ghost-1"],
    taskCounts: {
      assigned: 0,
      branchPushed: 1,
      openPrs: 1,
      mergedPrs: 1,
      closedPrs: 0,
    },
    activeTasks: ["#217 PR #225 open"],
    recentOutcomes: ["#205 PR #205 merged"],
    activeLanes: ["issue-688 [active] (#688 · PM) owner worker-pm"],
    detachedLanes: ["issue-123 [detached] (#123) — manual"],
    roster: [
      {
        id: "broker-1",
        role: "broker",
        label: "🦦 The Broker Otter",
        status: "working",
        health: "healthy",
        workload: "0 inbox / 0 threads",
        taskSummary: "—",
        heartbeat: "2s ago",
        branch: "main",
        worktree: "main checkout",
      },
    ],
    recentCycles: [
      {
        startedAt: "2026-04-15 00:00Z",
        duration: "2.5s",
        agentCount: 2,
        backlogCount: 3,
        ghostCount: 1,
        stuckCount: 1,
        anomalySummary: "ghost agents detected: ghost-1",
        followUpDelivered: true,
      },
    ],
  };
}

function createDeps(overrides: Partial<PinetHomeTabsDeps> = {}) {
  const brokerHomeTabs = createBrokerHomeTabs();
  const slack = vi.fn(async () => ({ ok: true }));

  const deps: PinetHomeTabsDeps = {
    slack,
    getBotToken: () => "xoxb-test",
    formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    getAgentName: () => "Cobalt Olive Crane",
    getAgentEmoji: () => "🦩",
    getBrokerRole: () => null,
    getRuntimeMode: () => "single",
    isFollowerConnected: () => false,
    isSinglePlayerConnected: () => true,
    getActiveThreads: () => 3,
    getPendingInboxCount: () => 1,
    getDefaultChannel: () => "ops-control",
    getBrokerHomeTabs: () => brokerHomeTabs,
    getCurrentBranch: async () => "feat/pinet-home-tabs",
    ...overrides,
  };

  return { deps, brokerHomeTabs, slack };
}

describe("createPinetHomeTabs", () => {
  it("refreshes broker control-plane home tabs and stores the latest snapshot state", async () => {
    const brokerHomeTabs = createBrokerHomeTabs();
    brokerHomeTabs.getHomeTabViewerIds = vi.fn(() => ["U123", "U456"]);
    const { deps, slack } = createDeps({
      getBrokerHomeTabs: () => brokerHomeTabs,
    });
    const homeTabs = createPinetHomeTabs(deps);
    const { ctx, notify } = createContext();
    const snapshot = createBrokerSnapshot();

    await homeTabs.refreshBrokerControlPlaneHomeTabs(ctx, snapshot, "2026-04-15T00:00:00.000Z");

    expect(brokerHomeTabs.setLastHomeTabSnapshot).toHaveBeenCalledWith(snapshot);
    expect(brokerHomeTabs.setLastHomeTabRefreshAt).toHaveBeenCalledWith("2026-04-15T00:00:00.000Z");
    expect(brokerHomeTabs.setLastHomeTabError).toHaveBeenLastCalledWith(null);
    expect(slack).toHaveBeenCalledTimes(2);
    expect(slack).toHaveBeenNthCalledWith(
      1,
      "views.publish",
      "xoxb-test",
      expect.objectContaining({ user_id: "U123" }),
    );
    expect(slack).toHaveBeenNthCalledWith(
      2,
      "views.publish",
      "xoxb-test",
      expect.objectContaining({ user_id: "U456" }),
    );
    const firstPublishBody = (slack.mock.calls[0] as unknown[] | undefined)?.[2] as
      | Record<string, unknown>
      | undefined;
    expect(JSON.stringify(firstPublishBody)).toContain("Lane metadata");
    expect(JSON.stringify(firstPublishBody)).toContain("issue-688 [active]");
    expect(JSON.stringify(firstPublishBody)).toContain("issue-123 [detached]");
    expect(notify).not.toHaveBeenCalled();
  });

  it("delegates broker home-tab publishes to the broker runtime when available", async () => {
    const brokerHomeTabs = createBrokerHomeTabs();
    brokerHomeTabs.isConnected = vi.fn(() => true);
    brokerHomeTabs.publishCurrentHomeTabSafely = vi.fn(async () => true);
    const { deps, slack } = createDeps({
      getBrokerHomeTabs: () => brokerHomeTabs,
      getBrokerRole: () => "broker",
      getRuntimeMode: () => "broker",
    });
    const homeTabs = createPinetHomeTabs(deps);
    const { ctx } = createContext();

    await homeTabs.publishCurrentPinetHomeTab("U123", ctx, "2026-04-15T00:00:00.000Z");

    expect(brokerHomeTabs.publishCurrentHomeTabSafely).toHaveBeenCalledWith(
      "U123",
      ctx,
      "2026-04-15T00:00:00.000Z",
    );
    expect(slack).not.toHaveBeenCalled();
  });

  it("falls back to the standalone Home tab when broker publishing does not handle the request", async () => {
    const brokerHomeTabs = createBrokerHomeTabs();
    brokerHomeTabs.isConnected = vi.fn(() => true);
    brokerHomeTabs.publishCurrentHomeTabSafely = vi.fn(async () => false);
    const { deps, slack } = createDeps({
      getBrokerHomeTabs: () => brokerHomeTabs,
      getBrokerRole: () => "broker",
      getRuntimeMode: () => "follower",
      isFollowerConnected: () => false,
      getActiveThreads: () => 5,
      getPendingInboxCount: () => 2,
      getDefaultChannel: () => null,
      getCurrentBranch: async () => "main",
    });
    const homeTabs = createPinetHomeTabs(deps);
    const { ctx } = createContext();

    await homeTabs.publishCurrentPinetHomeTab("U123", ctx);

    expect(slack).toHaveBeenCalledWith(
      "views.publish",
      "xoxb-test",
      expect.objectContaining({
        user_id: "U123",
        view: expect.objectContaining({ type: "home" }),
      }),
    );
    const body = (slack.mock.calls[0] as unknown[] | undefined)?.[2] as
      | Record<string, unknown>
      | undefined;
    expect(JSON.stringify(body)).toContain("Cobalt Olive Crane");
    expect(JSON.stringify(body)).toContain("follower");
    expect(JSON.stringify(body)).toContain("main");
    expect(JSON.stringify(body)).toContain("Pending inbox");
    expect(brokerHomeTabs.setLastHomeTabError).toHaveBeenCalledWith(null);
  });

  it("reports Home tab publish failures safely", async () => {
    const { deps, brokerHomeTabs } = createDeps({
      slack: vi.fn(async () => {
        throw new Error("views.publish failed");
      }),
    });
    const homeTabs = createPinetHomeTabs(deps);
    const { ctx, notify } = createContext();

    await homeTabs.publishCurrentPinetHomeTabSafely("U123", ctx);

    expect(notify).toHaveBeenCalledWith(
      "Pinet Home tab publish failed: views.publish failed",
      "warning",
    );
    expect(brokerHomeTabs.setLastHomeTabError).toHaveBeenCalledWith(
      "Pinet Home tab publish failed: views.publish failed",
    );
  });
});
