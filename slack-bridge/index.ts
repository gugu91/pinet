import * as fs from "node:fs";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGitContextCache, probeGitBranch, probeGitContext } from "./git-metadata.js";
import {
  type FollowerRuntimeDiagnostic,
  type InboxMessage,
  loadSettings as loadSettingsFromFile,
  buildAllowlist,
  reloadPinetRuntimeSafely,
  buildPinetOwnerToken,
  resolveAgentIdentity,
  resolveBrokerStableId,
  resolveAgentStableId,
  resolveAllowAllWorkspaceUsers,
  trackBrokerInboundThread,
} from "./helpers.js";
import { buildSecurityPrompt, type SecurityGuardrails } from "./guardrails.js";
import { TtlCache, TtlSet } from "./ttl-cache.js";
import { resolveReactionCommands } from "./reaction-triggers.js";
import { DEFAULT_SOCKET_PATH } from "./broker/client.js";
import type {
  PortLeaseAcquireInput,
  PortLeaseListOptions,
  PortLeaseReleaseInput,
  PortLeaseRenewInput,
  PinetLaneListOptions,
  PinetLaneParticipantUpsertInput,
  PinetLaneUpsertInput,
} from "./broker/types.js";
import { createCommandRegistrationRuntime } from "./command-registration-runtime.js";
import { createToolRegistrationRuntime } from "./tool-registration-runtime.js";
import { createSlackRuntimeAccess } from "./slack-runtime-access.js";
import { createThreadConfirmationPolicy } from "./thread-confirmations.js";
import { persistDeliveredInboundMessage } from "./broker-inbound-persistence.js";
import {
  createIMessageAdapter,
  detectIMessageMvpEnvironment,
  formatIMessageMvpReadiness,
} from "@gugu910/pi-imessage-bridge";
import {
  SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE,
  SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS,
} from "./slack-access.js";
import {
  createFollowerDeliveryState,
  markFollowerInboxIdsDelivered,
  queueFollowerInboxIds,
} from "./follower-delivery.js";
import { createFollowerRuntime, type BrokerClientRef } from "./follower-runtime.js";
import {
  createSinglePlayerRuntime,
  type SinglePlayerPendingAttentionEntry,
  type SinglePlayerThreadInfo,
} from "./single-player-runtime.js";
import { createBrokerRuntime } from "./broker-runtime.js";
import { SlackActivityLogger } from "./activity-log.js";
import { createBrokerDeliveryState, queueBrokerInboxIds } from "./broker-delivery.js";
import { buildBrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-dashboard.js";
import { createPinetHomeTabs } from "./pinet-home-tabs.js";
import { createPinetAgentStatus } from "./pinet-agent-status.js";
import { createBrokerThreadOwnerHints } from "./broker-thread-owner-hints.js";
import { createPersistedRuntimeState } from "./persisted-runtime-state.js";
import { createRuntimeAgentContext } from "./runtime-agent-context.js";
import { createPinetActivityFormatting } from "./pinet-activity-formatting.js";
import { createPinetControlPlaneDashboard } from "./pinet-control-plane-dashboard.js";
import { createPinetMaintenanceDelivery } from "./pinet-maintenance-delivery.js";
import { createPinetRemoteControlAcks } from "./pinet-remote-control-acks.js";
import { createPinetRemoteControl } from "./pinet-remote-control.js";
import { createPinetMeshOps } from "./pinet-mesh-ops.js";
import { consumePinetReadConfirmationReplies } from "./pinet-confirmation-replies.js";
import { createAgentPromptGuidance } from "./agent-prompt-guidance.js";
import { createAgentEventRuntime } from "./agent-event-runtime.js";
import { createSessionUiRuntime } from "./session-ui-runtime.js";
import { createSlackRequestRuntime } from "./slack-request-runtime.js";
import { createPinetRegistrationGate } from "./pinet-registration-gate.js";
import { createBrokerRuntimeAccess } from "./broker-runtime-access.js";
import { createInboxDrainRuntime } from "./inbox-drain-runtime.js";
import { createAgentCompletionRuntime } from "./agent-completion-runtime.js";
import { sendBrokerMessage } from "./broker/message-send.js";
import {
  type SlackBridgeRuntimeMode,
  resolveSlackBridgeStartupRuntimeMode,
} from "./runtime-mode.js";
import {
  buildSlackScopeDriftWarning,
  createPendingSlackScopeDiagnostics,
  createUncheckedSlackScopeDiagnostics,
  detectSlackScopeDiagnostics,
} from "./slack-scope-diagnostics.js";

// Settings and helpers imported from ./helpers.js

export default function (pi: ExtensionAPI) {
  let settings = loadSettingsFromFile();

  let botToken = settings.botToken ?? process.env.SLACK_BOT_TOKEN;
  let appToken = settings.appToken ?? process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) return;

  const slackRequestRuntime = createSlackRequestRuntime();
  const { slack } = slackRequestRuntime;

  // allowedUsers / allowAllWorkspaceUsers: settings.json takes priority, env vars as fallback
  let allowedUsers = buildAllowlist(
    settings,
    process.env.SLACK_ALLOWED_USERS,
    process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS,
  );
  let reactionCommands = resolveReactionCommands(settings.reactionCommands);

  const initialIdentity = resolveAgentIdentity(settings, process.env.PI_NICKNAME, process.cwd());
  let agentName = initialIdentity.name;
  let agentEmoji = initialIdentity.emoji;
  let agentStableId = resolveAgentStableId(undefined, undefined, os.hostname(), process.cwd());
  let brokerStableId = resolveBrokerStableId(undefined, os.hostname(), process.cwd());
  let agentOwnerToken = buildPinetOwnerToken(agentStableId);
  let activeSkinTheme: string | null = null;
  let agentPersonality: string | null = null;
  const agentAliases = new Set<string>();
  // Security guardrails
  let guardrails: SecurityGuardrails = settings.security ?? {};
  let securityPrompt = buildSecurityPrompt(guardrails);

  let botUserId: string | null = null;
  let slackScopeDiagnostics = createUncheckedSlackScopeDiagnostics();
  let slackScopeDiagnosticsRefresh: Promise<void> | null = null;
  let lastSlackScopeDriftWarning = "";

  const threads = new Map<string, SinglePlayerThreadInfo>();
  const pendingEyes = new Map<string, SinglePlayerPendingAttentionEntry[]>(); // thread_ts → message ts list // thread_ts values showing "is thinking…"
  const userNames = new TtlCache<string, string>({ maxSize: 2000, ttlMs: 60 * 60 * 1000 });
  let lastDmChannel: string | null = null;
  const channelCache = new TtlCache<string, string>({ maxSize: 500, ttlMs: 30 * 60 * 1000 });
  const unclaimedThreads = new TtlSet<string>({ maxSize: 5000, ttlMs: 5 * 60 * 1000 });
  const processedSlackSocketDeliveries = new TtlSet<string>({
    maxSize: SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE,
    ttlMs: SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS,
  });

  const {
    formatAction: formatConfirmationAction,
    registerRequest: registerConfirmationRequest,
    consumeReply: consumeConfirmationReply,
    requireToolPolicy,
  } = createThreadConfirmationPolicy({
    getGuardrails: () => guardrails,
  });

  // ─── State persistence ──────────────────────────────

  const persistedRuntimeState = createPersistedRuntimeState({
    pi,
    threads,
    userNames,
    getLastDmChannel: () => lastDmChannel,
    setLastDmChannel: (channelId) => {
      lastDmChannel = channelId;
    },
    getAgentName: () => agentName,
    setAgentName: (name) => {
      agentName = name;
    },
    getAgentEmoji: () => agentEmoji,
    setAgentEmoji: (emoji) => {
      agentEmoji = emoji;
    },
    getAgentStableId: () => agentStableId,
    setAgentStableId: (stableId) => {
      agentStableId = stableId;
    },
    getBrokerStableId: () => brokerStableId,
    setBrokerStableId: (stableId) => {
      brokerStableId = stableId;
    },
    getBrokerRole: () => brokerRole,
    getActiveSkinTheme: () => activeSkinTheme,
    setActiveSkinTheme: (theme) => {
      activeSkinTheme = theme;
    },
    getAgentPersonality: () => agentPersonality,
    setAgentPersonality: (personality) => {
      agentPersonality = personality;
    },
    agentAliases,
    setAgentOwnerToken: (ownerToken) => {
      agentOwnerToken = ownerToken;
    },
    getSettings: () => settings,
    formatError: msg,
  });
  const { persistState, flushPersist, restorePersistedRuntimeState } = persistedRuntimeState;

  // ─── Inbox queue ────────────────────────────────────

  const inbox: InboxMessage[] = [];
  const brokerDeliveryState = createBrokerDeliveryState();
  let drainInboxPort: (() => void) | null = null;
  const sessionUiRuntime = createSessionUiRuntime({
    getAgentName: () => agentName,
    getAgentEmoji: () => agentEmoji,
    getInboxLength: () => inbox.length,
    drainInbox: () => {
      drainInboxPort?.();
    },
  });
  const { updateBadge, setExtStatus, maybeDrainInboxIfIdle } = sessionUiRuntime;
  let reportAgentStatus: (status: "working" | "idle") => Promise<void> = async () => {};
  let deliverTrackedSlackFollowUpMessage: (options: {
    prompt: string;
    messages: Pick<InboxMessage, "threadTs">[];
  }) => boolean = () => false;
  const inboxDrainRuntime = createInboxDrainRuntime({
    sendUserMessage: (body) => {
      pi.sendUserMessage(body);
    },
    isIdle: () => sessionUiRuntime.getExtensionContext()?.isIdle?.() ?? true,
    takeInboxMessages: (maxMessages) => inbox.splice(0, maxMessages ?? inbox.length),
    restoreInboxMessages: (messages) => {
      inbox.unshift(...messages);
    },
    updateBadge,
    reportStatus: (status) => reportAgentStatus(status),
    userNames,
    getSecurityPrompt: () => securityPrompt,
    deliverTrackedSlackFollowUpMessage: (options) => deliverTrackedSlackFollowUpMessage(options),
    getBrokerRole: () => brokerRole,
    hasFollowerClient: () => brokerClient?.client != null,
    flushFollowerDeliveredAcks: () => followerRuntime.flushDeliveredAcks(),
    markBrokerInboxIdsDelivered: (inboxIds) => {
      brokerRuntime.markDelivered(inboxIds);
    },
    getFollowerDeliveryState: () => followerDeliveryState,
  });
  const { deliverFollowUpMessage, flushDeliveredFollowerAcks, drainInbox } = inboxDrainRuntime;
  drainInboxPort = drainInbox;

  // ─── Helpers ─────────────────────────────────────────

  const gitContextCache = createGitContextCache(() => probeGitContext(process.cwd()));
  const runtimeAgentContext = createRuntimeAgentContext({
    cwd: process.cwd(),
    getSettings: () => settings,
    setSettings: (nextSettings) => {
      settings = nextSettings;
    },
    getBotToken: () => botToken,
    setBotToken: (token) => {
      botToken = token;
    },
    getAppToken: () => appToken,
    setAppToken: (token) => {
      appToken = token;
    },
    getAllowedUsers: () => allowedUsers,
    setAllowedUsers: (users) => {
      allowedUsers = users;
    },
    getGuardrails: () => guardrails,
    setGuardrails: (nextGuardrails) => {
      guardrails = nextGuardrails;
    },
    getReactionCommands: () => reactionCommands,
    setReactionCommands: (commands) => {
      reactionCommands = commands;
    },
    getSecurityPrompt: () => securityPrompt,
    setSecurityPrompt: (prompt) => {
      securityPrompt = prompt;
    },
    getAgentName: () => agentName,
    setAgentName: (name) => {
      agentName = name;
    },
    getAgentEmoji: () => agentEmoji,
    setAgentEmoji: (emoji) => {
      agentEmoji = emoji;
    },
    getAgentStableId: () => agentStableId,
    getBrokerStableId: () => brokerStableId,
    getBrokerRole: () => brokerRole,
    getAgentOwnerToken: () => agentOwnerToken,
    setAgentOwnerToken: (ownerToken) => {
      agentOwnerToken = ownerToken;
    },
    getActiveSkinTheme: () => activeSkinTheme,
    setActiveSkinTheme: (theme) => {
      activeSkinTheme = theme;
    },
    getAgentPersonality: () => agentPersonality,
    setAgentPersonality: (personality) => {
      agentPersonality = personality;
    },
    getAgentAliases: () => agentAliases,
    getThreads: () => threads,
    getExtensionContext: sessionUiRuntime.getExtensionContext,
    persistState,
    updateBadge,
    getGitContext: () => gitContextCache.get(),
  });
  const {
    isUserAllowed,
    maybeWarnSlackUserAccess,
    maybeWarnSlackGuardrailPosture,
    applyLocalAgentIdentity,
    refreshSettings,
    snapshotReloadableRuntime,
    restoreReloadableRuntime,
    getAgentMetadata,
    getMeshRoleFromMetadata,
    buildSkinMetadata,
    applyRegistrationIdentity,
  } = runtimeAgentContext;

  async function refreshSlackScopeDiagnostics(ctx?: ExtensionContext): Promise<void> {
    if (!botToken) {
      slackScopeDiagnostics = createUncheckedSlackScopeDiagnostics();
      lastSlackScopeDriftWarning = "";
      return;
    }

    slackScopeDiagnostics = createPendingSlackScopeDiagnostics();
    const diagnostics = await detectSlackScopeDiagnostics({ token: botToken });
    slackScopeDiagnostics = diagnostics;

    const warning = buildSlackScopeDriftWarning(diagnostics);
    if (!warning) {
      lastSlackScopeDriftWarning = "";
      return;
    }

    if (warning === lastSlackScopeDriftWarning) {
      return;
    }

    lastSlackScopeDriftWarning = warning;
    console.warn(`[slack-bridge] ${warning}`);
    ctx?.ui.notify(warning, "warning");
  }

  async function ensureSlackScopeDiagnostics(ctx?: ExtensionContext): Promise<void> {
    if (slackScopeDiagnosticsRefresh) {
      await slackScopeDiagnosticsRefresh;
      return;
    }

    slackScopeDiagnosticsRefresh = refreshSlackScopeDiagnostics(ctx)
      .catch((error) => {
        slackScopeDiagnostics = {
          status: "unavailable",
          checkedAt: new Date().toISOString(),
          summary: `unavailable (${msg(error)})`,
          surfaces: [],
          missingScopes: [],
          results: [],
          error: msg(error),
        };
        lastSlackScopeDriftWarning = "";
      })
      .finally(() => {
        slackScopeDiagnosticsRefresh = null;
      });

    await slackScopeDiagnosticsRefresh;
  }

  const agentPromptGuidance = createAgentPromptGuidance({
    getIdentityGuidelines: runtimeAgentContext.getIdentityGuidelines,
    getAgentName: () => agentName,
    getAgentEmoji: () => agentEmoji,
    getActiveSkinTheme: () => activeSkinTheme,
    getAgentPersonality: () => agentPersonality,
    getBrokerRole: () => brokerRole,
    getBrokerPromptSetting: () => settings.brokerPrompt,
  });

  let isSinglePlayerShuttingDown = () => false;
  let isSinglePlayerConnected = () => false;
  const slackRuntimeAccess = createSlackRuntimeAccess({
    slack,
    getBotToken: () => botToken!,
    userNames,
    channelCache,
    persistState,
    isSinglePlayerShuttingDown: () => isSinglePlayerShuttingDown(),
    getSuggestedPrompts: () => settings.suggestedPrompts,
    getAgentName: () => agentName,
    getThreads: () => threads,
    getBrokerRole: () => brokerRole,
    resolveBrokerThreadChannel: (threadTs) =>
      brokerRuntime.getBroker()?.db.getThread(threadTs)?.channel ?? null,
    resolveFollowerThreadChannel: async (threadTs) =>
      (await brokerClient?.client.resolveThread(threadTs)) ?? null,
  });
  const {
    addReaction,
    removeReaction,
    resolveUser,
    rememberChannel,
    resolveChannel,
    resolveFollowerReplyChannel,
    clearThreadStatus,
    setSuggestedPrompts,
    fetchSlackMessageByTs,
  } = slackRuntimeAccess;
  const pinetHomeTabs = createPinetHomeTabs({
    slack,
    getBotToken: () => botToken,
    formatError: msg,
    getAgentName: () => agentName,
    getAgentEmoji: () => agentEmoji,
    getBrokerRole: () => brokerRole,
    getRuntimeMode: () => currentRuntimeMode,
    isFollowerConnected: () => brokerClient != null,
    isSinglePlayerConnected: () => isSinglePlayerConnected(),
    getActiveThreads: () => threads.size,
    getPendingInboxCount: () => inbox.length,
    getDefaultChannel: () => settings.defaultChannel ?? null,
    getCurrentBranch: async () => (await probeGitBranch(process.cwd())) ?? null,
    getBrokerHomeTabs: () => brokerRuntime,
  });
  const brokerRuntimeAccess = createBrokerRuntimeAccess({
    getBroker: () => brokerRuntime.getBroker(),
    getSelfId: () => brokerRuntime.getSelfId(),
    getHomeTabViewerIds: () => brokerRuntime.getHomeTabViewerIds(),
  });
  const {
    getActiveBroker,
    getActiveBrokerDb,
    getActiveBrokerSelfId,
    getBrokerControlPlaneHomeTabViewerIds,
  } = brokerRuntimeAccess;
  const pinetAgentStatus = createPinetAgentStatus({
    getPinetEnabled: () => pinetEnabled,
    getBrokerRole: () => brokerRole,
    getDesiredAgentStatus: () => desiredAgentStatus,
    setDesiredAgentStatus: (status) => {
      desiredAgentStatus = status;
    },
    getActiveBrokerDb,
    getActiveBrokerSelfId,
    hasFollowerClient: () => brokerClient != null,
    syncFollowerDesiredStatus: (status, options) =>
      followerRuntime.syncDesiredStatus(status, options),
    runBrokerMaintenance: (ctx) => {
      brokerRuntime.runMaintenance(ctx);
    },
    getInboxLength: () => inbox.length,
    getCurrentRuntimeMode: () => currentRuntimeMode,
    maybeDrainInboxIfIdle,
    getExtensionContext: () => sessionUiRuntime.getExtensionContext() ?? undefined,
  });
  const { reportStatus, signalAgentFree } = pinetAgentStatus;
  reportAgentStatus = reportStatus;
  const agentCompletionRuntime = createAgentCompletionRuntime({
    getThreads: () => threads,
    clearThreadStatus,
    clearFollowUpPending: () => {
      brokerRuntime.clearFollowUpPending();
    },
    signalAgentFree: (ctx) => signalAgentFree(ctx),
    formatError: msg,
  });
  const agentEventRuntime = createAgentEventRuntime({
    getBrokerRole: () => brokerRole,
    getGuardrails: () => guardrails,
    requireToolPolicy,
    formatAction: formatConfirmationAction,
    formatError: msg,
    deliverFollowUpMessage,
    beforeAgentStart: agentPromptGuidance.beforeAgentStart,
    onCompletionAgentEnd: agentCompletionRuntime.onAgentEnd,
    setDeliverTrackedSlackFollowUpMessage: (deliver) => {
      deliverTrackedSlackFollowUpMessage = deliver;
    },
  });
  const pinetMaintenanceDelivery = createPinetMaintenanceDelivery({
    getActiveBrokerDb,
    getActiveBrokerSelfId,
    isIdle: () => sessionUiRuntime.getExtensionContext()?.isIdle?.() ?? true,
    sendUserMessage: (body) => {
      pi.sendUserMessage(body);
    },
  });
  const { sendBrokerMaintenanceMessage, trySendBrokerFollowUp } = pinetMaintenanceDelivery;
  const pinetRemoteControlAcks = createPinetRemoteControlAcks({
    queueBrokerInboxIds: (inboxIds) => {
      queueBrokerInboxIds(brokerDeliveryState, inboxIds);
    },
    isBrokerConnected: () => brokerRuntime.isConnected(),
    markBrokerInboxIdsDelivered: (inboxIds) => {
      brokerRuntime.markDelivered(inboxIds);
    },
    queueFollowerInboxIds: (inboxIds) => {
      queueFollowerInboxIds(followerDeliveryState, inboxIds);
    },
    markFollowerInboxIdsDelivered: (inboxIds) => {
      markFollowerInboxIdsDelivered(followerDeliveryState, inboxIds);
    },
    flushDeliveredFollowerAcks,
  });
  const {
    resetPendingRemoteControlAcks,
    deferBrokerControlAck,
    deferFollowerControlAck,
    flushDeferredRemoteControlAcks,
  } = pinetRemoteControlAcks;
  const pinetRemoteControl = createPinetRemoteControl({
    flushDeferredRemoteControlAcks,
    reloadPinetRuntime,
    formatError: msg,
  });
  const { requestRemoteControl, runRemoteControl, resetRemoteControlState } = pinetRemoteControl;
  const pinetActivityFormatting = createPinetActivityFormatting({
    getActiveBrokerDb,
  });
  const { formatTrackedAgent, summarizeTrackedAssignmentStatus } = pinetActivityFormatting;
  const pinetControlPlaneDashboard = createPinetControlPlaneDashboard({
    getActiveBrokerDb,
    getActiveBrokerSelfId,
    heartbeatTimerActive: () => brokerRuntime.heartbeatTimerActive(),
    maintenanceTimerActive: () => brokerRuntime.maintenanceTimerActive(),
    getLastMaintenance: () => brokerRuntime.getLastMaintenance(),
    getRalphSnoozeStatus: () => brokerRuntime.getRalphSnoozeStatus(),
  });
  const { buildCurrentBrokerControlPlaneDashboardSnapshot } = pinetControlPlaneDashboard;

  // ─── Socket Mode (native WebSocket) ─────────────────

  const singlePlayerRuntime = createSinglePlayerRuntime({
    slack,
    getBotToken: () => botToken!,
    getAppToken: () => appToken!,
    dedup: processedSlackSocketDeliveries,
    abortSlackRequests: slackRequestRuntime.abortAndWait,
    isSingleRuntimeActive: () => currentRuntimeMode === "single",
    setExtStatus,
    formatError: msg,
    getAgentName: () => agentName,
    getAgentAliases: () => agentAliases,
    getAgentOwnerToken: () => agentOwnerToken,
    getBotUserId: () => botUserId,
    getThreads: () => threads,
    getPendingEyes: () => pendingEyes,
    getUnclaimedThreads: () => unclaimedThreads,
    pushInboxMessage: (message) => {
      inbox.push(message);
    },
    setLastDmChannel: (channelId) => {
      lastDmChannel = channelId;
    },
    persistState,
    updateBadge,
    maybeDrainInboxIfIdle,
    resolveThreadChannel: resolveFollowerReplyChannel,
    setSuggestedPrompts,
    publishCurrentPinetHomeTab: (userId, ctx) =>
      pinetHomeTabs.publishCurrentPinetHomeTabSafely(userId, ctx),
    fetchSlackMessageByTs,
    addReaction,
    removeReaction,
    resolveUser,
    isUserAllowed,
    getReactionCommand: (reactionName) => reactionCommands.get(reactionName),
    consumeConfirmationReply,
    claimOwnedThread: (threadTs, channelId, source = "slack") => {
      if (brokerRole === "broker") {
        brokerRuntime.claimThread(threadTs, channelId, source);
      } else if (brokerRole === "follower" && brokerClient?.client) {
        void brokerClient.client.claimThread(threadTs, channelId, source).catch(() => {
          /* broker gone, best effort */
        });
      }
    },
  });

  isSinglePlayerShuttingDown = () => singlePlayerRuntime.isShuttingDown();
  isSinglePlayerConnected = () => singlePlayerRuntime.isConnected();

  // ─── Reconnect / status ─────────────────────────────

  // ─── Agent-to-agent messaging tools ──────────────────

  // These are registered unconditionally but only work when pinet is active.
  // The variables they reference (pinetEnabled, brokerRole, brokerRuntime,
  // brokerClient) are declared in the Commands section just below.

  // Forward-declared — assigned in the Commands section below.
  let pinetEnabled = false;
  let currentRuntimeMode: SlackBridgeRuntimeMode = "off";
  let brokerRole: "broker" | "follower" | null = null;
  let brokerClient: BrokerClientRef | null = null;
  let followerRuntimeDiagnostic: FollowerRuntimeDiagnostic | null = null;
  const followerDeliveryState = createFollowerDeliveryState();
  let desiredAgentStatus: "working" | "idle" = "idle";
  const pinetRegistrationGate = createPinetRegistrationGate();

  const brokerThreadOwnerHints = createBrokerThreadOwnerHints({
    slack,
    getBotToken: () => botToken!,
  });
  const { resolveBrokerThreadOwnerHint } = brokerThreadOwnerHints;

  const brokerRuntime = createBrokerRuntime({
    getSettings: () => settings,
    getBotToken: () => botToken!,
    getAppToken: () => appToken!,
    getAllowedUsers: () => allowedUsers,
    shouldAllowAllWorkspaceUsers: () =>
      resolveAllowAllWorkspaceUsers(settings, process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS),
    getBrokerStableId: () => brokerStableId,
    setBrokerStableId: (stableId) => {
      brokerStableId = stableId;
    },
    getActiveSkinTheme: () => activeSkinTheme,
    setActiveSkinTheme: (theme) => {
      activeSkinTheme = theme;
    },
    setAgentOwnerToken: (ownerToken) => {
      agentOwnerToken = ownerToken;
    },
    getAgentMetadata,
    applyLocalAgentIdentity,
    buildSkinMetadata: (metadata, personality, statusVocabulary) =>
      buildSkinMetadata(metadata ?? undefined, personality, statusVocabulary),
    getMeshRoleFromMetadata: (metadata, fallbackRole) =>
      getMeshRoleFromMetadata(metadata ?? undefined, fallbackRole),
    handleInboundMessage: async ({ message, broker, router, selfId, ctx }) => {
      try {
        const ownerHint =
          message.source === "slack" && message.threadId && message.channel
            ? await resolveBrokerThreadOwnerHint(message.channel, message.threadId)
            : null;
        const routedMessage =
          ownerHint && (ownerHint.agentOwner || ownerHint.agentName)
            ? {
                ...message,
                metadata: {
                  ...(message.metadata ?? {}),
                  ...(ownerHint.agentOwner ? { threadOwnerAgentOwner: ownerHint.agentOwner } : {}),
                  ...(ownerHint.agentName ? { threadOwnerAgentName: ownerHint.agentName } : {}),
                },
              }
            : message;

        trackBrokerInboundThread(threads, routedMessage);

        const decision = router.route(routedMessage);

        if (routedMessage.threadId && routedMessage.channel) {
          broker.db.updateThread(routedMessage.threadId, {
            source: routedMessage.source,
            channel: routedMessage.channel,
          });
        }

        if (decision.action === "deliver" && decision.agentId !== selfId) {
          broker.db.queueMessage(decision.agentId, routedMessage);
          return;
        }

        if (decision.action === "deliver" || decision.action === "unrouted") {
          const persisted =
            routedMessage.source === "slack" && routedMessage.threadId
              ? persistDeliveredInboundMessage(broker.db, selfId, routedMessage)
              : null;

          if (persisted && !persisted.result.freshDelivery) {
            return;
          }

          inbox.push({
            channel: routedMessage.channel,
            threadTs: routedMessage.threadId,
            userId: routedMessage.userId,
            text: persisted?.notificationText ?? routedMessage.text,
            timestamp: routedMessage.timestamp,
            metadata: routedMessage.metadata ?? null,
            ...(persisted ? { brokerInboxId: persisted.result.entry.id } : {}),
            ...(routedMessage.scope ? { scope: routedMessage.scope } : {}),
          });
          updateBadge();
          maybeDrainInboxIfIdle(ctx);
        }
      } catch (err) {
        console.error(`[slack-bridge] broker inbound routing failed: ${msg(err)}`);
      }
    },
    onAppHomeOpened: async (userId, ctx) => {
      await pinetHomeTabs.publishCurrentPinetHomeTabSafely(userId, ctx, new Date().toISOString());
    },
    pushInboxMessages: (messages) => {
      inbox.push(...messages);
    },
    updateBadge,
    maybeDrainInboxIfIdle,
    requestRemoteControl,
    deferControlAck: deferBrokerControlAck,
    runRemoteControl,
    formatError: msg,
    deliveryState: brokerDeliveryState,
    createActivityLogger: (onError) =>
      new SlackActivityLogger({
        getBotToken: () => botToken,
        getLogChannel: () => settings.logChannel,
        getLogLevel: () => settings.logLevel,
        getAgentName: () => agentName,
        getAgentEmoji: () => agentEmoji,
        resolveChannel,
        slack,
        onError,
      }),
    formatTrackedAgent,
    summarizeTrackedAssignmentStatus,
    sendMaintenanceMessage: (targetAgentId, body) => {
      sendBrokerMaintenanceMessage(targetAgentId, body);
    },
    trySendFollowUp: (body, onDelivered) => {
      trySendBrokerFollowUp(body, onDelivered);
    },
    refreshHomeTabs: async (ctx, snapshot, refreshedAt, userIds) => {
      await pinetHomeTabs.refreshBrokerControlPlaneHomeTabs(ctx, snapshot, refreshedAt, userIds);
    },
    buildControlPlaneDashboardSnapshot: (input) =>
      buildBrokerControlPlaneDashboardSnapshot(
        input as unknown as Parameters<typeof buildBrokerControlPlaneDashboardSnapshot>[0],
      ),
    buildCurrentDashboardSnapshot: async (openedAt) =>
      buildCurrentBrokerControlPlaneDashboardSnapshot(openedAt),
    onMaintenanceResult: (ctx, { result, previousSignature, signature }) => {
      if (signature && signature !== previousSignature) {
        ctx.ui.notify(`Pinet broker: ${result.anomalies.join("; ")}`, "warning");
      } else if (!signature && previousSignature) {
        ctx.ui.notify("Pinet broker health recovered", "info");
      }

      const maintenanceDetails: string[] = [];
      if (result.assignedBacklogCount > 0) {
        maintenanceDetails.push(
          `assigned ${result.assignedBacklogCount} backlog item${result.assignedBacklogCount === 1 ? "" : "s"}`,
        );
      }
      if (result.reapedAgentIds.length > 0) {
        maintenanceDetails.push(
          `reaped stale agents: ${result.reapedAgentIds.map((agentId) => formatTrackedAgent(agentId)).join(", ")}`,
        );
      }
      if (result.repairedThreadClaims > 0) {
        maintenanceDetails.push(
          `released ${result.repairedThreadClaims} orphaned thread claim${result.repairedThreadClaims === 1 ? "" : "s"}`,
        );
      }
      maintenanceDetails.push(...result.anomalies);

      const hasMaintenanceActions =
        result.assignedBacklogCount > 0 ||
        result.reapedAgentIds.length > 0 ||
        result.repairedThreadClaims > 0;
      const shouldLogMaintenance = hasMaintenanceActions || previousSignature !== signature;
      if (shouldLogMaintenance) {
        brokerRuntime.logActivity({
          kind: "broker_maintenance",
          level: hasMaintenanceActions ? "actions" : "verbose",
          title: signature ? "Broker maintenance anomaly" : "Broker maintenance recovery",
          summary: signature
            ? `Broker maintenance recorded ${maintenanceDetails.length} noteworthy event${maintenanceDetails.length === 1 ? "" : "s"}.`
            : "Broker maintenance is healthy again.",
          details:
            signature && maintenanceDetails.length > 0
              ? maintenanceDetails
              : previousSignature
                ? ["Previous anomalies cleared."]
                : undefined,
          fields: [
            { label: "Backlog", value: result.pendingBacklogCount },
            { label: "Assigned", value: result.assignedBacklogCount },
            { label: "Reaped", value: result.reapedAgentIds.length },
            { label: "Repaired", value: result.repairedThreadClaims },
          ],
          tone: signature ? "warning" : "success",
        });
      }
    },
    onMaintenanceError: (ctx, error) => {
      ctx.ui.notify(`Pinet maintenance failed: ${msg(error)}`, "error");
      brokerRuntime.logActivity({
        kind: "broker_maintenance_error",
        level: "errors",
        title: "Broker maintenance failed",
        summary: msg(error),
        tone: "error",
      });
    },
    onScheduledWakeupError: (ctx, error) => {
      ctx.ui.notify(`Pinet scheduled wake-ups failed: ${msg(error)}`, "error");
      brokerRuntime.logActivity({
        kind: "scheduled_wakeup_error",
        level: "errors",
        title: "Scheduled wake-up delivery failed",
        summary: msg(error),
        tone: "error",
      });
    },
    onAgentStatusChange: (_ctx, changedAgentId, status) => {
      brokerRuntime.logActivity({
        kind: "agent_status",
        level: "verbose",
        title: status === "idle" ? "Worker available" : "Worker busy",
        summary: `${formatTrackedAgent(changedAgentId)} marked itself ${status}.`,
        fields: [{ label: "Agent", value: formatTrackedAgent(changedAgentId) }],
        tone: status === "idle" ? "success" : "info",
      });
    },
  });

  const pinetMeshOps = createPinetMeshOps({
    getPinetEnabled: () => pinetEnabled,
    getBrokerRole: () => brokerRole,
    getActiveBrokerDb,
    getActiveBrokerSelfId,
    getAgentName: () => agentName,
    getFollowerClient: () => brokerClient?.client ?? null,
    formatTrackedAgent,
    logActivity: (entry) => {
      brokerRuntime.logActivity(entry);
    },
  });
  const {
    sendPinetAgentMessage,
    sendPinetBroadcastMessage,
    scheduleBrokerWakeup,
    scheduleFollowerWakeup,
    listBrokerAgents,
    listFollowerAgents,
  } = pinetMeshOps;

  async function listPinetLanes(options: PinetLaneListOptions) {
    if (brokerRole === "broker") {
      const db = getActiveBrokerDb();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.listPinetLanes(options);
    }
    if (brokerRole === "follower" && brokerClient?.client) {
      return await brokerClient.client.listLanes(options);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function upsertPinetLane(input: PinetLaneUpsertInput) {
    if (brokerRole === "broker") {
      const db = getActiveBrokerDb();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.upsertPinetLane(input);
    }
    if (brokerRole === "follower" && brokerClient?.client) {
      return await brokerClient.client.upsertLane(input);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function setPinetLaneParticipant(input: PinetLaneParticipantUpsertInput) {
    if (brokerRole === "broker") {
      const db = getActiveBrokerDb();
      const selfId = getActiveBrokerSelfId();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.setPinetLaneParticipant({
        ...input,
        agentId: input.agentId.trim().length > 0 ? input.agentId : (selfId ?? input.agentId),
      });
    }
    if (brokerRole === "follower" && brokerClient?.client) {
      return await brokerClient.client.setLaneParticipant(input);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function acquirePortLease(input: PortLeaseAcquireInput) {
    if (brokerRole === "broker") {
      const db = getActiveBrokerDb();
      const selfId = getActiveBrokerSelfId();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.acquirePortLease({ ...input, ownerAgentId: input.ownerAgentId ?? selfId ?? null });
    }
    if (brokerRole === "follower" && brokerClient?.client) {
      return await brokerClient.client.acquirePortLease(input);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function renewPortLease(input: PortLeaseRenewInput) {
    if (brokerRole === "broker") {
      const db = getActiveBrokerDb();
      const selfId = getActiveBrokerSelfId();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.renewPortLease({ ...input, ownerAgentId: input.ownerAgentId ?? selfId ?? null });
    }
    if (brokerRole === "follower" && brokerClient?.client) {
      return await brokerClient.client.renewPortLease(input);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function releasePortLease(input: PortLeaseReleaseInput) {
    if (brokerRole === "broker") {
      const db = getActiveBrokerDb();
      const selfId = getActiveBrokerSelfId();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.releasePortLease({ ...input, ownerAgentId: input.ownerAgentId ?? selfId ?? null });
    }
    if (brokerRole === "follower" && brokerClient?.client) {
      return await brokerClient.client.releasePortLease(input);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function getPortLease(leaseId: string) {
    if (brokerRole === "broker") {
      const db = getActiveBrokerDb();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.getPortLease(leaseId);
    }
    if (brokerRole === "follower" && brokerClient?.client) {
      return await brokerClient.client.getPortLease(leaseId);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function listPortLeases(options: PortLeaseListOptions) {
    if (brokerRole === "broker") {
      const db = getActiveBrokerDb();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.listPortLeases(options);
    }
    if (brokerRole === "follower" && brokerClient?.client) {
      return await brokerClient.client.listPortLeases(options);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function expirePortLeases() {
    if (brokerRole === "broker") {
      const db = getActiveBrokerDb();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.expirePortLeases();
    }
    if (brokerRole === "follower" && brokerClient?.client) {
      return await brokerClient.client.expirePortLeases();
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function readPinetInbox(options: {
    threadId?: string;
    limit?: number;
    unreadOnly?: boolean;
    markRead?: boolean;
  }) {
    if (brokerRole === "broker") {
      const db = getActiveBrokerDb();
      const selfId = getActiveBrokerSelfId();
      if (!db || !selfId) {
        throw new Error("Broker agent identity is unavailable.");
      }
      const result = db.readInbox(selfId, options);
      return consumePinetReadConfirmationReplies(
        {
          messages: result.messages.map((item) => ({
            inboxId: item.entry.id,
            delivered: item.entry.delivered,
            readAt: item.entry.readAt,
            message: item.message,
          })),
          unreadCountBefore: result.unreadCountBefore,
          unreadCountAfter: result.unreadCountAfter,
          unreadThreads: result.unreadThreads,
          markedReadIds: result.markedReadIds,
        },
        consumeConfirmationReply,
      );
    }

    if (brokerRole === "follower" && brokerClient?.client) {
      const result = await brokerClient.client.readInbox(options);
      return consumePinetReadConfirmationReplies(result, consumeConfirmationReply);
    }

    throw new Error("Pinet is in an unexpected state.");
  }

  async function transitionToRuntimeMode(
    ctx: ExtensionContext,
    mode: SlackBridgeRuntimeMode,
  ): Promise<void> {
    if (currentRuntimeMode === mode) {
      if (mode === "off") {
        setExtStatus(ctx, "off");
      }
      return;
    }

    if (currentRuntimeMode !== "off") {
      await stopPinetRuntime(ctx, { releaseIdentity: true });
      // Runtime transitions keep the extension alive in-process, so restore a
      // fresh top-level Slack request tracker after tearing the prior runtime down.
      slackRequestRuntime.reset();
      singlePlayerRuntime.resetShutdownState();
    }

    if (mode === "off") {
      currentRuntimeMode = "off";
      setExtStatus(ctx, "off");
      return;
    }

    if (mode === "single") {
      currentRuntimeMode = "single";
      setExtStatus(ctx, "reconnecting");
      await singlePlayerRuntime.connect(ctx);
      botUserId = singlePlayerRuntime.getBotUserId() ?? botUserId;
      void ensureSlackScopeDiagnostics(ctx);
      return;
    }

    if (mode === "broker") {
      await connectAsBroker(ctx);
      void ensureSlackScopeDiagnostics(ctx);
      return;
    }

    await connectAsFollower(ctx);
    void ensureSlackScopeDiagnostics(ctx);
  }

  async function stopPinetRuntime(
    ctx: ExtensionContext,
    options: { releaseIdentity: boolean },
  ): Promise<void> {
    flushPersist();
    await brokerRuntime.disconnect({ releaseIdentity: options.releaseIdentity });

    if (brokerClient) {
      if (options.releaseIdentity) {
        await disconnectFollower(ctx).catch(() => {
          /* best effort */
        });
      } else {
        await followerRuntime.disconnect(ctx, { releaseIdentity: false }).catch(() => {
          /* best effort */
        });
        brokerClient = null;
        desiredAgentStatus = "idle";
        brokerRole = null;
        pinetEnabled = false;
      }
    }

    await singlePlayerRuntime.disconnect();
    brokerRole = null;
    pinetEnabled = false;
    desiredAgentStatus = "idle";
    currentRuntimeMode = "off";
    setExtStatus(ctx, "off");
  }

  async function reloadPinetRuntime(ctx: ExtensionContext): Promise<void> {
    await reloadPinetRuntimeSafely({
      getCurrentRole: () => brokerRole,
      snapshotState: () => snapshotReloadableRuntime(),
      restoreState: (snapshot) => {
        restoreReloadableRuntime(snapshot);
      },
      refreshState: () => {
        refreshSettings();
      },
      validateRefreshedState: () => {
        if (!botToken || !appToken) {
          throw new Error("Slack tokens are not configured after reload.");
        }
      },
      stopRuntime: async () => {
        await stopPinetRuntime(ctx, { releaseIdentity: false });
        // Reload intentionally keeps the extension alive in-process, so restore a
        // fresh top-level Slack request tracker after aborting the previous
        // generation. This preserves shutdown abort semantics without leaving
        // top-level Slack tools permanently stuck in "shutdown in progress".
        slackRequestRuntime.reset();
        singlePlayerRuntime.resetShutdownState();
        setExtStatus(ctx, "reconnecting");
      },
      startRuntime: async (role) => {
        if (role === "broker") {
          await connectAsBroker(ctx);
          return;
        }
        await connectAsFollower(ctx);
      },
    });
  }

  // ─── Tools ──────────────────────────────────────────

  const toolRegistrationRuntime = createToolRegistrationRuntime({
    slackTools: {
      getBotToken: () => {
        if (!botToken) {
          throw new Error("Slack bot token is not configured.");
        }
        return botToken;
      },
      getDefaultChannel: () => settings.defaultChannel,
      getSecurityPrompt: () => securityPrompt,
      inbox,
      slack,
      getAgentName: () => agentName,
      getAgentEmoji: () => agentEmoji,
      getAgentOwnerToken: () => agentOwnerToken,
      getLastDmChannel: () => lastDmChannel,
      updateBadge,
      resolveUser,
      threadContext: singlePlayerRuntime.getThreadContextPort(),
      resolveChannel,
      rememberChannel,
      requireToolPolicy,
      getBotUserId: () => botUserId,
      registerConfirmationRequest,
      pinetDelivery: {
        isAvailable: () => pinetEnabled && brokerRole !== null,
        sendSlackMessage: async (input) => {
          const content = {
            text: input.text,
            markdown: input.text,
            ...(input.blocks && input.blocks.length > 0 ? { slackBlocks: input.blocks } : {}),
          };
          if (brokerRole === "broker") {
            const broker = getActiveBroker();
            const selfId = getActiveBrokerSelfId();
            if (!broker || !selfId) {
              throw new Error("Broker agent identity is unavailable.");
            }
            const result = await sendBrokerMessage(
              {
                db: broker.db,
                adapters: broker.adapters,
              },
              {
                threadId: input.threadId,
                body: input.text,
                senderAgentId: selfId,
                source: "slack",
                channel: input.channel,
                content,
                ...(input.blocks && input.blocks.length > 0 ? { blocks: input.blocks } : {}),
                agentName,
                agentEmoji,
                agentOwnerToken,
              },
            );
            return {
              adapter: result.adapter,
              messageId: result.message.id,
              threadId: result.thread.threadId,
              channel: result.thread.channel,
              source: result.thread.source,
            };
          }
          if (brokerRole === "follower") {
            if (!brokerClient?.client) {
              throw new Error("Pinet is in an unexpected state.");
            }
            return brokerClient.client.sendMessage({
              threadId: input.threadId,
              body: input.text,
              source: "slack",
              channel: input.channel,
              content,
              ...(input.blocks && input.blocks.length > 0 ? { blocks: input.blocks } : {}),
              agentName,
              agentEmoji,
              agentOwnerToken,
            });
          }
          throw new Error("Pinet is in an unexpected state.");
        },
      },
    },
    pinetTools: {
      pinetEnabled: () => pinetEnabled,
      brokerRole: () => brokerRole,
      requireToolPolicy,
      sendPinetAgentMessage,
      sendPinetBroadcastMessage,
      signalAgentFree,
      scheduleBrokerWakeup,
      scheduleFollowerWakeup,
      readPinetInbox,
      listBrokerAgents,
      listFollowerAgents,
      listPinetLanes,
      upsertPinetLane,
      setPinetLaneParticipant,
      acquirePortLease,
      renewPortLease,
      releasePortLease,
      getPortLease,
      listPortLeases,
      expirePortLeases,
      ralphSnoozeStatus: () =>
        currentRuntimeMode === "broker" ? brokerRuntime.getRalphSnoozeStatus() : null,
      snoozeRalphLoop: (input) => brokerRuntime.snoozeRalphLoop(input),
      clearRalphSnooze: () => brokerRuntime.clearRalphSnooze(),
    },
    iMessageTools: {
      pinetEnabled: () => pinetEnabled,
      brokerRole: () => brokerRole,
      requireToolPolicy,
      getActiveBroker,
      getActiveBrokerSelfId,
      sendFollowerIMessage: async (input) => {
        if (!brokerClient?.client) {
          throw new Error("Pinet is in an unexpected state.");
        }

        const result = await brokerClient.client.sendMessage(input);
        return {
          adapter: result.adapter,
          messageId: result.messageId,
        };
      },
      getAgentIdentity: () => ({
        name: agentName,
        emoji: agentEmoji,
        ownerToken: agentOwnerToken,
      }),
      trackOwnedThread: (threadId, channel, source) => {
        singlePlayerRuntime.trackOwnedThread(threadId, channel, source);
      },
    },
  });

  toolRegistrationRuntime.register(pi);

  // ─── Commands ───────────────────────────────────────

  async function connectAsBroker(ctx: ExtensionContext): Promise<void> {
    refreshSettings();
    maybeWarnSlackUserAccess(ctx);
    maybeWarnSlackGuardrailPosture(ctx);

    const {
      botUserId: brokerBotUserId,
      recoveredBrokerMessages,
      recoveredTargetedBacklogCount,
      releasedBrokerClaims,
    } = await brokerRuntime.connect(ctx);
    const broker = brokerRuntime.getBroker();
    if (!broker) {
      throw new Error("Broker runtime failed to initialize.");
    }
    botUserId = brokerBotUserId;

    if (settings.imessage?.enabled) {
      const environment = detectIMessageMvpEnvironment();
      const readinessSummary = formatIMessageMvpReadiness(environment).join(" | ");

      if (!environment.canAttemptSend) {
        ctx.ui.notify(`iMessage adapter unavailable — ${readinessSummary}`, "warning");
        brokerRuntime.logActivity({
          kind: "transport_readiness",
          level: "actions",
          title: "iMessage adapter unavailable",
          summary: readinessSummary,
          tone: "warning",
        });
      } else {
        try {
          const imessageAdapter = createIMessageAdapter();
          await imessageAdapter.connect();
          broker.addAdapter(imessageAdapter);

          if (environment.blockers.length > 0) {
            ctx.ui.notify(`iMessage send-first mode enabled — ${readinessSummary}`, "warning");
            brokerRuntime.logActivity({
              kind: "transport_readiness",
              level: "actions",
              title: "iMessage send-first mode enabled",
              summary: readinessSummary,
              tone: "warning",
            });
          }
        } catch (err) {
          ctx.ui.notify(`iMessage adapter failed to start: ${msg(err)}`, "warning");
          brokerRuntime.logActivity({
            kind: "transport_readiness",
            level: "errors",
            title: "iMessage adapter failed to start",
            summary: msg(err),
            tone: "error",
          });
        }
      }
    }

    broker.server.setOutboundMessageAdapters?.(broker.adapters);

    brokerRole = "broker";
    pinetEnabled = true;
    desiredAgentStatus = "idle";
    currentRuntimeMode = "broker";

    if (recoveredBrokerMessages > 0 || releasedBrokerClaims > 0) {
      const recoveredTargetedDetail =
        recoveredTargetedBacklogCount > 0
          ? ` including ${recoveredTargetedBacklogCount} recovered targeted backlog item${recoveredTargetedBacklogCount === 1 ? "" : "s"}`
          : "";
      ctx.ui.notify(
        `Pinet broker recovered ${recoveredBrokerMessages} pending message${recoveredBrokerMessages === 1 ? "" : "s"}${recoveredTargetedDetail} and released ${releasedBrokerClaims} broker-owned thread claim${releasedBrokerClaims === 1 ? "" : "s"}`,
        "info",
      );
    }

    brokerRuntime.startObservability(ctx);
    setExtStatus(ctx, "ok");
    brokerRuntime.logActivity({
      kind: "broker_started",
      level: "actions",
      title: "Broker started",
      summary: `${agentEmoji} ${agentName} is online and coordinating the mesh.`,
      details:
        recoveredBrokerMessages > 0 || releasedBrokerClaims > 0
          ? [
              `Recovered ${recoveredBrokerMessages} pending broker inbox item${recoveredBrokerMessages === 1 ? "" : "s"}.`,
              ...(recoveredTargetedBacklogCount > 0
                ? [
                    `Recovered ${recoveredTargetedBacklogCount} targeted backlog item${recoveredTargetedBacklogCount === 1 ? "" : "s"} during startup.`,
                  ]
                : []),
              `Released ${releasedBrokerClaims} stale broker-owned thread claim${releasedBrokerClaims === 1 ? "" : "s"}.`,
            ]
          : undefined,
      fields: [
        { label: "Bot", value: botUserId ?? "unknown" },
        { label: "Log channel", value: settings.logChannel ?? "disabled" },
        { label: "Log level", value: settings.logLevel ?? "actions" },
      ],
      tone: "success",
    });
    ctx.ui.notify(`${agentEmoji} ${agentName} — broker started (${botUserId})`, "info");
  }

  const followerRuntime = createFollowerRuntime({
    getSettings: () => settings,
    refreshSettings,
    getPinetEnabled: () => pinetEnabled,
    getAgentIdentity: () => ({ name: agentName, emoji: agentEmoji }),
    getAgentStableId: () => agentStableId,
    getAgentOwnerToken: () => agentOwnerToken,
    setAgentOwnerToken: (ownerToken) => {
      agentOwnerToken = ownerToken;
    },
    getDesiredAgentStatus: () => desiredAgentStatus,
    getAgentAliases: () => agentAliases,
    getThreads: () => threads,
    getLastDmChannel: () => lastDmChannel,
    setLastDmChannel: (channelId) => {
      lastDmChannel = channelId;
    },
    pushInboxMessages: (messages) => {
      inbox.push(...messages);
    },
    getAgentMetadata,
    applyRegistrationIdentity,
    persistState,
    updateBadge,
    maybeDrainInboxIfIdle,
    requestRemoteControl,
    deferControlAck: deferFollowerControlAck,
    runRemoteControl,
    deliverFollowUpMessage,
    setExtStatus,
    getRuntimeDiagnostic: () => followerRuntimeDiagnostic,
    setRuntimeDiagnostic: (diagnostic) => {
      followerRuntimeDiagnostic = diagnostic;
    },
    handleTerminalReconnectFailure: async (ctx, error) => {
      console.error(`[slack-bridge] follower reconnect failed: ${msg(error)}`);
      await disconnectFollower(ctx, { preserveErrorState: true }).catch(() => {
        /* best effort */
      });
      setExtStatus(ctx, "error");
      ctx.ui.notify(
        `Pinet reconnect stopped: ${msg(error)} Update slack-bridge.agentName/agentEmoji or PI_NICKNAME, or clear the explicit identity request, then run /pinet follow to retry.`,
        "error",
      );
    },
    formatError: msg,
    deliveryState: followerDeliveryState,
  });

  const commandRegistrationRuntime = createCommandRegistrationRuntime({
    pinetCommands: {
      pinetEnabled: () => pinetEnabled,
      pinetRegistrationBlocked: pinetRegistrationGate.isBlocked,
      runtimeMode: () => currentRuntimeMode,
      runtimeConnected: () =>
        currentRuntimeMode === "broker"
          ? brokerRuntime.isConnected()
          : currentRuntimeMode === "follower"
            ? (brokerClient?.client.isConnected() ?? false)
            : currentRuntimeMode === "single"
              ? singlePlayerRuntime.isConnected()
              : false,
      brokerRole: () => brokerRole,
      agentName: () => agentName,
      agentEmoji: () => agentEmoji,
      agentOwnerToken: () => agentOwnerToken,
      agentPersonality: () => agentPersonality,
      agentAliases: () => agentAliases,
      botUserId: () => botUserId,
      activeSkinTheme: () => activeSkinTheme,
      lastDmChannel: () => lastDmChannel,
      followerRuntimeDiagnostic: () => followerRuntimeDiagnostic,
      threads: () => threads,
      allowedUsers: () => allowedUsers,
      inboxLength: () => inbox.length,
      recentActivityLogEntries: (limit) => brokerRuntime.getRecentActivityEntries(limit),
      slackScopeDiagnostics: () => slackScopeDiagnostics,
      settings: () => settings,
      lastBrokerMaintenance: () => brokerRuntime.getLastMaintenance(),
      ralphSnoozeStatus: () =>
        currentRuntimeMode === "broker" ? brokerRuntime.getRalphSnoozeStatus() : null,
      snoozeRalphLoop: (input) => brokerRuntime.snoozeRalphLoop(input),
      clearRalphSnooze: () => brokerRuntime.clearRalphSnooze(),
      getBrokerControlPlaneHomeTabViewerIds,
      lastBrokerControlPlaneHomeTabRefreshAt: () => brokerRuntime.getLastHomeTabRefreshAt(),
      lastBrokerControlPlaneHomeTabError: () => brokerRuntime.getLastHomeTabError(),
      getPinetRegistrationBlockReason: pinetRegistrationGate.getBlockReason,
      connectAsBroker: (ctx) => transitionToRuntimeMode(ctx, "broker"),
      connectAsFollower: (ctx) => transitionToRuntimeMode(ctx, "follower"),
      reloadPinetRuntime,
      disconnectFollower,
      sendPinetAgentMessage,
      signalAgentFree,
      applyLocalAgentIdentity,
      setExtStatus,
      setExtCtx: sessionUiRuntime.setExtCtx,
    },
  });

  commandRegistrationRuntime.register(pi);

  async function connectAsFollower(ctx: ExtensionContext): Promise<void> {
    pinetRegistrationGate.assertCanRegister();

    const clientRef = await followerRuntime.connect(ctx);
    brokerClient = clientRef;
    followerRuntimeDiagnostic = null;
    brokerRole = "follower";
    pinetEnabled = true;
    desiredAgentStatus = "idle";
    currentRuntimeMode = "follower";
    setExtStatus(ctx, "ok");
  }

  async function disconnectFollower(
    ctx: ExtensionContext,
    options: { preserveErrorState?: boolean } = {},
  ): Promise<{ unregisterError: string | null }> {
    const result = await followerRuntime.disconnect(ctx);
    brokerClient = null;
    desiredAgentStatus = "idle";
    brokerRole = null;
    pinetEnabled = false;
    currentRuntimeMode = "off";
    if (!options.preserveErrorState) {
      followerRuntimeDiagnostic = null;
      setExtStatus(ctx, "off");
    }

    return result;
  }

  // ─── Lifecycle ──────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    singlePlayerRuntime.resetShutdownState();
    slackRequestRuntime.reset();
    resetRemoteControlState();
    resetPendingRemoteControlAcks();
    sessionUiRuntime.prepareForSessionStart(ctx);
    const pinetRegistrationBlocked = pinetRegistrationGate.evaluateSessionStart(ctx);
    // Restore persisted thread state (always restore, even before /pinet)
    restorePersistedRuntimeState(ctx);

    if (pinetRegistrationBlocked) {
      console.log("[slack-bridge] detected local subagent context; skipping Pinet registration");
      currentRuntimeMode = "off";
      setExtStatus(ctx, "off");
      return;
    }

    refreshSettings();
    maybeWarnSlackUserAccess(ctx);
    const startupMode = resolveSlackBridgeStartupRuntimeMode(settings, {
      brokerSocketExists: fs.existsSync(DEFAULT_SOCKET_PATH),
    });

    try {
      await transitionToRuntimeMode(ctx, startupMode);
      if (startupMode === "single") {
        maybeWarnSlackGuardrailPosture(ctx);
        console.log("[slack-bridge] runtime mode: single");
      } else if (startupMode === "follower") {
        console.log("[slack-bridge] runtime mode: follower");
      } else if (startupMode === "broker") {
        console.log("[slack-bridge] runtime mode: broker");
      }
    } catch (err) {
      console.error(`[slack-bridge] runtime start (${startupMode}) failed: ${msg(err)}`);
      currentRuntimeMode = "off";
      setExtStatus(ctx, "off");
    }
  });

  // ─── Agent event wiring ──────────────────────────────

  agentEventRuntime.register(pi);

  pi.on("session_compact", async (_event, ctx) => {
    maybeDrainInboxIfIdle(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    resetRemoteControlState();
    resetPendingRemoteControlAcks();
    sessionUiRuntime.cleanupForSessionShutdown();
    await stopPinetRuntime(ctx, { releaseIdentity: true });
    pinetRegistrationGate.reset();
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
