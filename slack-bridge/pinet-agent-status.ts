import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SlackBridgeRuntimeMode } from "./runtime-mode.js";

export type PinetAgentStatusValue = "working" | "idle";

export interface PinetAgentStatusBrokerDbPort {
  updateAgentStatus: (agentId: string, status: PinetAgentStatusValue) => void;
}

export interface PinetAgentStatusDeps {
  getPinetEnabled: () => boolean;
  getBrokerRole: () => "broker" | "follower" | null;
  getDesiredAgentStatus: () => PinetAgentStatusValue;
  setDesiredAgentStatus: (status: PinetAgentStatusValue) => void;
  getActiveBrokerDb: () => PinetAgentStatusBrokerDbPort | null;
  getActiveBrokerSelfId: () => string | null;
  hasFollowerClient: () => boolean;
  syncFollowerDesiredStatus: (
    status: PinetAgentStatusValue,
    options: { force?: boolean },
  ) => Promise<void>;
  runBrokerMaintenance: (ctx: ExtensionContext) => void;
  getInboxLength: () => number;
  getCurrentRuntimeMode: () => SlackBridgeRuntimeMode;
  maybeDrainInboxIfIdle: (ctx: ExtensionContext) => boolean;
  getExtensionContext: () => ExtensionContext | undefined;
}

export interface PinetAgentStatus {
  syncDesiredAgentStatus: (options?: { force?: boolean }) => Promise<void>;
  reportStatus: (status: PinetAgentStatusValue, options?: { force?: boolean }) => Promise<void>;
  signalAgentSettled: (ctx?: ExtensionContext) => Promise<void>;
  signalAgentFree: (
    ctx?: ExtensionContext,
    options?: { requirePinet?: boolean },
  ) => Promise<{ queuedInboxCount: number; drainedQueuedInbox: boolean }>;
}

export function createPinetAgentStatus(deps: PinetAgentStatusDeps): PinetAgentStatus {
  async function syncDesiredAgentStatus(options: { force?: boolean } = {}): Promise<void> {
    if (!deps.getPinetEnabled()) {
      return;
    }

    const desiredAgentStatus = deps.getDesiredAgentStatus();
    if (deps.getBrokerRole() === "broker") {
      const db = deps.getActiveBrokerDb();
      const selfId = deps.getActiveBrokerSelfId();
      if (!db || !selfId) {
        return;
      }
      db.updateAgentStatus(selfId, desiredAgentStatus);
      return;
    }

    if (deps.getBrokerRole() === "follower" && deps.hasFollowerClient()) {
      await deps.syncFollowerDesiredStatus(desiredAgentStatus, options);
    }
  }

  async function reportStatus(
    status: PinetAgentStatusValue,
    options: { force?: boolean } = {},
  ): Promise<void> {
    deps.setDesiredAgentStatus(status);
    await syncDesiredAgentStatus(options);
  }

  // agent-standards-ignore prefer-inline-single-use-helper: automatic settlement publishes idle without the manual free command's inbox drain.
  async function signalAgentSettled(ctx?: ExtensionContext): Promise<void> {
    if (!deps.getPinetEnabled()) {
      return;
    }

    await reportStatus("idle");
    const maintenanceCtx = ctx ?? deps.getExtensionContext();
    if (deps.getBrokerRole() === "broker" && maintenanceCtx) {
      deps.runBrokerMaintenance(maintenanceCtx);
    }
  }

  async function signalAgentFree(
    ctx?: ExtensionContext,
    options: { requirePinet?: boolean } = {},
  ): Promise<{ queuedInboxCount: number; drainedQueuedInbox: boolean }> {
    const pinetEnabled = deps.getPinetEnabled();
    if (!pinetEnabled && options.requirePinet) {
      throw new Error("Pinet is not running. Use /pinet start or /pinet follow first.");
    }

    const maintenanceCtx = ctx ?? deps.getExtensionContext();
    await signalAgentSettled(maintenanceCtx);

    const queuedInboxCount = deps.getInboxLength();
    const shouldDrainQueuedInbox = pinetEnabled || deps.getCurrentRuntimeMode() === "single";
    const drainedQueuedInbox =
      shouldDrainQueuedInbox && queuedInboxCount > 0 && maintenanceCtx
        ? deps.maybeDrainInboxIfIdle(maintenanceCtx)
        : false;

    return { queuedInboxCount, drainedQueuedInbox };
  }

  return {
    syncDesiredAgentStatus,
    reportStatus,
    signalAgentSettled,
    signalAgentFree,
  };
}
