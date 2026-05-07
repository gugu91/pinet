import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-dashboard.js";
import { probeGitBranch } from "./git-metadata.js";
import {
  publishSlackHomeTab,
  renderBrokerControlPlaneHomeTabView,
  renderStandalonePinetHomeTabView,
  type PublishSlackHomeTabInput,
} from "./home-tab.js";
import type { SlackBridgeRuntimeMode } from "./runtime-mode.js";

export interface PinetHomeTabsBrokerPort {
  isConnected: () => boolean;
  publishCurrentHomeTabSafely: (
    userId: string,
    ctx: ExtensionContext,
    openedAt?: string,
  ) => Promise<boolean>;
  getHomeTabViewerIds: () => string[];
  getLastHomeTabError: () => string | null;
  setLastHomeTabSnapshot: (snapshot: BrokerControlPlaneDashboardSnapshot | null) => void;
  setLastHomeTabRefreshAt: (value: string | null) => void;
  setLastHomeTabError: (value: string | null) => void;
}

export interface PinetHomeTabsDeps {
  slack: PublishSlackHomeTabInput["slack"];
  getBotToken: () => string | undefined;
  formatError: (error: unknown) => string;
  getAgentName: () => string;
  getAgentEmoji: () => string;
  getBrokerRole: () => "broker" | "follower" | null;
  getRuntimeMode: () => SlackBridgeRuntimeMode;
  isFollowerConnected: () => boolean;
  isSinglePlayerConnected: () => boolean;
  getActiveThreads: () => number;
  getPendingInboxCount: () => number;
  getDefaultChannel: () => string | null | undefined;
  getBrokerHomeTabs: () => PinetHomeTabsBrokerPort;
  getCurrentBranch?: () => Promise<string | null>;
}

export interface PinetHomeTabs {
  refreshBrokerControlPlaneHomeTabs: (
    ctx: ExtensionContext,
    snapshot: BrokerControlPlaneDashboardSnapshot,
    refreshedAt: string,
    userIds?: string[],
  ) => Promise<void>;
  reportHomeTabPublishFailure: (ctx: ExtensionContext, err: unknown) => void;
  publishCurrentPinetHomeTab: (
    userId: string,
    ctx: ExtensionContext,
    openedAt?: string,
  ) => Promise<void>;
  publishCurrentPinetHomeTabSafely: (
    userId: string,
    ctx: ExtensionContext,
    openedAt?: string,
  ) => Promise<void>;
}

function buildHomeTabPublishFailureMessage(
  formatError: (error: unknown) => string,
  err: unknown,
): string {
  return `Pinet Home tab publish failed: ${formatError(err)}`;
}

function getConnectedState(deps: PinetHomeTabsDeps): boolean {
  const mode = deps.getRuntimeMode();
  const brokerHomeTabs = deps.getBrokerHomeTabs();
  if (mode === "broker") {
    return brokerHomeTabs.isConnected();
  }
  if (mode === "follower") {
    return deps.isFollowerConnected();
  }
  if (mode === "single") {
    return deps.isSinglePlayerConnected();
  }
  return false;
}

export function createPinetHomeTabs(deps: PinetHomeTabsDeps): PinetHomeTabs {
  function reportHomeTabPublishFailure(ctx: ExtensionContext, err: unknown): void {
    const brokerHomeTabs = deps.getBrokerHomeTabs();
    const homeTabMessage = buildHomeTabPublishFailureMessage(deps.formatError, err);
    if (homeTabMessage !== brokerHomeTabs.getLastHomeTabError()) {
      ctx.ui.notify(homeTabMessage, "warning");
    }
    brokerHomeTabs.setLastHomeTabError(homeTabMessage);
  }

  async function refreshBrokerControlPlaneHomeTabs(
    ctx: ExtensionContext,
    snapshot: BrokerControlPlaneDashboardSnapshot,
    refreshedAt: string,
    userIds: string[] = deps.getBrokerHomeTabs().getHomeTabViewerIds(),
  ): Promise<void> {
    const botToken = deps.getBotToken();
    if (!botToken || userIds.length === 0) {
      return;
    }

    const brokerHomeTabs = deps.getBrokerHomeTabs();
    brokerHomeTabs.setLastHomeTabSnapshot(snapshot);
    let hadError = false;

    for (const userId of userIds) {
      try {
        await publishSlackHomeTab({
          slack: deps.slack,
          token: botToken,
          userId,
          view: renderBrokerControlPlaneHomeTabView(snapshot),
        });
      } catch (err) {
        hadError = true;
        reportHomeTabPublishFailure(ctx, err);
      }
    }

    if (!hadError) {
      brokerHomeTabs.setLastHomeTabError(null);
    }
    brokerHomeTabs.setLastHomeTabRefreshAt(refreshedAt);
  }

  async function publishCurrentPinetHomeTab(
    userId: string,
    ctx: ExtensionContext,
    openedAt: string = new Date().toISOString(),
  ): Promise<void> {
    const botToken = deps.getBotToken();
    if (!botToken) {
      return;
    }

    const brokerHomeTabs = deps.getBrokerHomeTabs();
    if (brokerHomeTabs.isConnected() && deps.getBrokerRole() === "broker") {
      if (await brokerHomeTabs.publishCurrentHomeTabSafely(userId, ctx, openedAt)) {
        return;
      }
    }

    const currentBranch = deps.getCurrentBranch
      ? await deps.getCurrentBranch()
      : ((await probeGitBranch(process.cwd())) ?? null);
    await publishSlackHomeTab({
      slack: deps.slack,
      token: botToken,
      userId,
      view: renderStandalonePinetHomeTabView({
        agentName: deps.getAgentName(),
        agentEmoji: deps.getAgentEmoji(),
        connected: getConnectedState(deps),
        mode: deps.getRuntimeMode(),
        activeThreads: deps.getActiveThreads(),
        pendingInbox: deps.getPendingInboxCount(),
        currentBranch,
        defaultChannel: deps.getDefaultChannel() ?? null,
      }),
    });
    brokerHomeTabs.setLastHomeTabError(null);
  }

  async function publishCurrentPinetHomeTabSafely(
    userId: string,
    ctx: ExtensionContext,
    openedAt: string = new Date().toISOString(),
  ): Promise<void> {
    try {
      await publishCurrentPinetHomeTab(userId, ctx, openedAt);
    } catch (err) {
      reportHomeTabPublishFailure(ctx, err);
    }
  }

  return {
    refreshBrokerControlPlaneHomeTabs,
    reportHomeTabPublishFailure,
    publishCurrentPinetHomeTab,
    publishCurrentPinetHomeTabSafely,
  };
}
