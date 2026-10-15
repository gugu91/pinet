import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-dashboard.js";
import {
  createBrokerRuntime,
  resolveConfiguredBrokerSkinTheme,
  type BrokerRuntimeDeps,
} from "./broker-runtime.js";
import type { SlackActivityLogger } from "./activity-log.js";
import type { MessageAdapter } from "./broker/types.js";
import * as brokerModule from "./broker/index.js";
import { BrokerClient } from "./broker/client.js";

function createDeps(overrides: Partial<BrokerRuntimeDeps> = {}): BrokerRuntimeDeps {
  return {
    getSettings: () => ({}),
    getAllowedUsers: () => null,
    getBrokerStableId: () => "broker-stable-id",
    setBrokerStableId: vi.fn(),
    getActiveSkinTheme: () => null,
    setActiveSkinTheme: vi.fn(),
    setAgentOwnerToken: vi.fn(),
    getAgentMetadata: vi.fn(async () => ({})),
    applyLocalAgentIdentity: vi.fn(),
    buildSkinMetadata: vi.fn((metadata) => metadata ?? {}),
    getMeshRoleFromMetadata: vi.fn(
      () => "broker" as ReturnType<BrokerRuntimeDeps["getMeshRoleFromMetadata"]>,
    ) as BrokerRuntimeDeps["getMeshRoleFromMetadata"],
    handleInboundMessage: vi.fn(),
    pushInboxMessages: vi.fn(),
    updateBadge: vi.fn(),
    maybeDrainInboxIfIdle: vi.fn(() => false),
    deliverSteeringMessage: vi.fn(() => true),
    requestRemoteControl: vi.fn(() => ({
      accepted: true,
      shouldStartNow: false,
      status: "queued" as const,
      scheduledCommand: "reload" as const,
      ackDisposition: "immediate" as const,
      currentCommand: null,
      queuedCommand: null,
    })),
    deferControlAck: vi.fn(),
    runRemoteControl: vi.fn(),
    formatError: (error: unknown) => String(error),
    deliveryState: {
      pendingInboxIds: new Set<number>(),
    },
    onMaintenanceResult: vi.fn(),
    onMaintenanceError: vi.fn(),
    onScheduledWakeupError: vi.fn(),
    onAgentStatusChange: vi.fn(),
    onAdminShutdownRequested: vi.fn(async () => {}),
    createActivityLogger: vi.fn(
      () =>
        ({
          clearPending: vi.fn(),
          getRecentEntries: vi.fn(() => []),
          log: vi.fn(),
        }) as unknown as SlackActivityLogger,
    ),
    formatTrackedAgent: vi.fn((agentId: string) => agentId),
    summarizeTrackedAssignmentStatus: vi.fn(() => ({
      summary: "assigned",
      tone: "info" as const,
    })),
    sendMaintenanceMessage: vi.fn(),
    trySendFollowUp: vi.fn(),
    refreshHomeTabs: vi.fn(async () => undefined),
    buildControlPlaneDashboardSnapshot: vi.fn(
      (input) => input as unknown as BrokerControlPlaneDashboardSnapshot,
    ),
    buildCurrentDashboardSnapshot: vi.fn(async () => null),
    createAdapterBindings: [],
    ...overrides,
  };
}

describe("broker-runtime", () => {
  it("resolves broker skin strictly from config with default fallback", () => {
    expect(resolveConfiguredBrokerSkinTheme({ skinTheme: "foundation" })).toBe("foundation");
    expect(resolveConfiguredBrokerSkinTheme({ skinTheme: "classic" })).toBe("default");
    expect(resolveConfiguredBrokerSkinTheme({})).toBe("default");
  });

  it("tears down a broker whose adapter connection is aborted", async () => {
    let rejectConnect!: (error: Error) => void;
    const adapter = {
      name: "hanging-adapter",
      connect: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectConnect = reject;
          }),
      ),
      disconnect: vi.fn(async () => undefined),
      onInbound: vi.fn(),
      send: vi.fn(async () => undefined),
    } satisfies MessageAdapter;
    const adapters: MessageAdapter[] = [];
    const db = {
      setAllowedUsers: vi.fn(),
      getSetting: vi.fn(() => null),
      getAllAgents: vi.fn(() => []),
      setSetting: vi.fn(),
      registerAgent: vi.fn(() => ({
        id: "broker-self",
        name: "Cobalt Olive Crane",
        emoji: "🪶",
      })),
      unregisterAgent: vi.fn(),
      releaseThreadClaims: vi.fn(() => 0),
      recoverPendingTargetedBacklog: vi.fn(() => 0),
      getPendingInboxCount: vi.fn(() => 0),
      getInbox: vi.fn(() => []),
    };
    const stop = vi.fn(async () => undefined);
    const startBroker = vi.spyOn(brokerModule, "startBroker").mockResolvedValue({
      db,
      server: {
        setAgentRegistrationResolver: vi.fn(),
        onAgentMessage: vi.fn(),
        onAgentStatusChange: vi.fn(),
        setAdminShutdownHandler: vi.fn(),
      },
      lock: { isLeader: () => true, release: vi.fn() },
      adapters,
      addAdapter: (nextAdapter: MessageAdapter) => {
        adapters.push(nextAdapter);
      },
      removeAdapters: vi.fn(async () => undefined),
      stop,
    } as never);
    const runtime = createBrokerRuntime(
      createDeps({
        createAdapterBindings: [() => ({ adapter })],
      }),
    );
    const ctx = {
      sessionManager: {
        getLeafId: () => "broker-startup-leaf",
      },
      ui: { notify: vi.fn() },
    } as never as ExtensionContext;
    const controller = new AbortController();

    try {
      const connecting = runtime.connect(ctx, controller.signal);
      await vi.waitFor(() => {
        expect(adapter.connect).toHaveBeenCalledOnce();
      });
      controller.abort();
      await vi.waitFor(() => {
        expect(adapter.disconnect).toHaveBeenCalledOnce();
      });
      rejectConnect(new Error("adapter startup failed"));

      await expect(connecting).rejects.toThrow("adapter startup failed");
      expect(db.unregisterAgent).toHaveBeenCalledWith("broker-self");
      expect(stop).toHaveBeenCalledOnce();
      expect(runtime.isConnected()).toBe(false);
    } finally {
      startBroker.mockRestore();
    }
  });

  it("ignores control commands from worker-key agents but obeys trusted followers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-broker-control-"));
    const socketPath = path.join(root, "broker.sock");
    const meshSecret = "test-mesh-secret";
    const realStartBroker = brokerModule.startBroker;
    const startBroker = vi.spyOn(brokerModule, "startBroker").mockImplementation(() =>
      realStartBroker({
        dbPath: path.join(root, "broker.db"),
        socketPath,
        lockPath: path.join(root, "broker.lock"),
        meshSecret,
      }),
    );
    const deps = createDeps();
    const runtime = createBrokerRuntime(deps);
    const notify = vi.fn();
    const ctx = {
      sessionManager: { getLeafId: () => "broker-self" },
      ui: { notify },
    } as never as ExtensionContext;
    const clients: BrokerClient[] = [];
    const connect = async (options: { meshSecret: string } | { workerKey: string }) => {
      const client = new BrokerClient({ path: socketPath, ...options });
      clients.push(client);
      await client.connect();
      return client;
    };

    try {
      await runtime.connect(ctx);
      const admin = await connect({ meshSecret });
      const { key } = await admin.issueWorkerKey({ hostId: "studio", workerId: "w1" });
      const worker = await connect({ workerKey: key });
      await worker.register("", "", {}, "studio:worker:w1");
      await worker.sendAgentMessage("broker-self", "/exit");
      await worker.sendAgentMessage("broker-self", "status update", {
        kind: "pinet_control",
        command: "reload",
      });
      expect(deps.requestRemoteControl).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith("Ignored exit from a worker-key agent.", "warning");

      const trusted = await connect({ meshSecret });
      await trusted.register("", "", {}, "local:session:/tmp/trusted.jsonl");
      await trusted.sendAgentMessage("broker-self", "/exit");
      expect(deps.requestRemoteControl).toHaveBeenCalledWith("exit", ctx);
    } finally {
      for (const client of clients) client.disconnect();
      await runtime.disconnect();
      startBroker.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears transient Home tab observability state on disconnect", async () => {
    const runtime = createBrokerRuntime(createDeps());

    runtime.setLastHomeTabSnapshot({
      roster: [],
    } as unknown as BrokerControlPlaneDashboardSnapshot);
    runtime.setLastHomeTabRefreshAt("2026-04-14T18:01:00.000Z");
    runtime.setLastHomeTabError("home tab failed once");

    await runtime.disconnect();

    expect(runtime.getHomeTabViewerIds()).toEqual([]);
    expect(runtime.getLastHomeTabSnapshot()).toBeNull();
    expect(runtime.getLastHomeTabRefreshAt()).toBeNull();
    expect(runtime.getLastHomeTabError()).toBeNull();
  });
});
