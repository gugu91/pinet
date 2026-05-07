import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createPinetAgentStatus,
  type PinetAgentStatusBrokerDbPort,
  type PinetAgentStatusDeps,
  type PinetAgentStatusValue,
} from "./pinet-agent-status.js";

function createContext(): ExtensionContext {
  return {} as ExtensionContext;
}

function createDeps(overrides: Partial<PinetAgentStatusDeps> = {}) {
  let desiredAgentStatus: PinetAgentStatusValue = "working";
  const ctx = createContext();
  const updateAgentStatus = vi.fn();
  const syncFollowerDesiredStatus = vi.fn(async () => undefined);
  const runBrokerMaintenance = vi.fn();
  const maybeDrainInboxIfIdle = vi.fn(() => true);
  const brokerDb: PinetAgentStatusBrokerDbPort = {
    updateAgentStatus,
  };

  const deps: PinetAgentStatusDeps = {
    getPinetEnabled: () => true,
    getBrokerRole: () => null,
    getDesiredAgentStatus: () => desiredAgentStatus,
    setDesiredAgentStatus: (status) => {
      desiredAgentStatus = status;
    },
    getActiveBrokerDb: () => brokerDb,
    getActiveBrokerSelfId: () => "agent-1",
    hasFollowerClient: () => false,
    syncFollowerDesiredStatus,
    runBrokerMaintenance,
    getInboxLength: () => 0,
    getCurrentRuntimeMode: () => "off",
    maybeDrainInboxIfIdle,
    getExtensionContext: () => ctx,
    ...overrides,
  };

  return {
    deps,
    ctx,
    updateAgentStatus,
    syncFollowerDesiredStatus,
    runBrokerMaintenance,
    maybeDrainInboxIfIdle,
    getDesiredAgentStatus: () => desiredAgentStatus,
  };
}

describe("createPinetAgentStatus", () => {
  it("updates broker status in the broker db", async () => {
    const { deps, updateAgentStatus, syncFollowerDesiredStatus } = createDeps({
      getBrokerRole: () => "broker",
    });
    const pinetAgentStatus = createPinetAgentStatus(deps);

    await pinetAgentStatus.syncDesiredAgentStatus();

    expect(updateAgentStatus).toHaveBeenCalledWith("agent-1", "working");
    expect(syncFollowerDesiredStatus).not.toHaveBeenCalled();
  });

  it("stores desired status and syncs followers through the extracted port", async () => {
    const { deps, syncFollowerDesiredStatus, getDesiredAgentStatus } = createDeps({
      getBrokerRole: () => "follower",
      hasFollowerClient: () => true,
    });
    const pinetAgentStatus = createPinetAgentStatus(deps);

    await pinetAgentStatus.reportStatus("idle");

    expect(getDesiredAgentStatus()).toBe("idle");
    expect(syncFollowerDesiredStatus).toHaveBeenCalledWith("idle", {});
  });

  it("signals broker free, runs maintenance, and drains queued inbox via the cached context", async () => {
    const {
      deps,
      ctx,
      updateAgentStatus,
      runBrokerMaintenance,
      maybeDrainInboxIfIdle,
      getDesiredAgentStatus,
    } = createDeps({
      getBrokerRole: () => "broker",
      getInboxLength: () => 2,
      getCurrentRuntimeMode: () => "broker",
    });
    const pinetAgentStatus = createPinetAgentStatus(deps);

    const result = await pinetAgentStatus.signalAgentFree();

    expect(getDesiredAgentStatus()).toBe("idle");
    expect(updateAgentStatus).toHaveBeenCalledWith("agent-1", "idle");
    expect(runBrokerMaintenance).toHaveBeenCalledWith(ctx);
    expect(maybeDrainInboxIfIdle).toHaveBeenCalledWith(ctx);
    expect(result).toEqual({ queuedInboxCount: 2, drainedQueuedInbox: true });
  });

  it("drains queued inbox in single mode even when Pinet is off", async () => {
    const { deps, ctx, updateAgentStatus, maybeDrainInboxIfIdle } = createDeps({
      getPinetEnabled: () => false,
      getInboxLength: () => 1,
      getCurrentRuntimeMode: () => "single",
    });
    const pinetAgentStatus = createPinetAgentStatus(deps);

    const result = await pinetAgentStatus.signalAgentFree();

    expect(updateAgentStatus).not.toHaveBeenCalled();
    expect(maybeDrainInboxIfIdle).toHaveBeenCalledWith(ctx);
    expect(result).toEqual({ queuedInboxCount: 1, drainedQueuedInbox: true });
  });

  it("throws when requirePinet is set but Pinet is not running", async () => {
    const { deps } = createDeps({
      getPinetEnabled: () => false,
    });
    const pinetAgentStatus = createPinetAgentStatus(deps);

    await expect(
      pinetAgentStatus.signalAgentFree(undefined, { requirePinet: true }),
    ).rejects.toThrow("Pinet is not running. Use /pinet start or /pinet follow first.");
  });
});
