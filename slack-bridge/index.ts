import "./module-reload.js";
import * as fs from "node:fs";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { probeGitBranch, probeGitContext, type GitContext } from "./git-metadata.js";
import {
  type FollowerRuntimeDiagnostic,
  type InboxMessage,
  loadSettings as loadSettingsFromFile,
  buildAllowlist,
  resolvePinetMeshAuth,
  reloadPinetRuntimeInPlaceSafely,
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
import {
  inspectBrokerLock,
  probeBrokerSocket,
  replaceBrokerOwner,
  type ReplaceBrokerOwnerResult,
} from "./broker/index.js";
import { readMeshSecret } from "./broker/auth.js";
import {
  collectAgentLifecycleStatuses,
  type AgentLifecycleStatus,
  type HibernationCommandResult,
} from "@pinet/broker-core";
import { resolveHibernationSettings } from "./hibernation-config.js";
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
import { createCompactionGate } from "./compaction-gate.js";
import {
  createIMessageAdapter,
  detectIMessageMvpEnvironment,
  formatIMessageMvpReadiness,
} from "@pinet/imessage-bridge";
import {
  SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE,
  SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS,
} from "./slack-access.js";
import {
  createFollowerDeliveryState,
  markFollowerInboxIdsDelivered,
  queueFollowerInboxIds,
} from "./follower-delivery.js";
import {
  createFollowerRuntime,
  resolveBrokerSocketPath,
  type BrokerClientRef,
} from "./follower-runtime.js";
import { createPinetRuntime } from "./pinet-runtime.js";
import {
  createSinglePlayerRuntime,
  type SinglePlayerPendingAttentionEntry,
  type SinglePlayerThreadInfo,
} from "./single-player-runtime.js";
import { createBrokerRuntime } from "./broker-runtime.js";
import { createSlackPinetRuntimeAdapterFactory } from "./slack-pinet-runtime-adapter.js";
import {
  createNvimPinetRuntimeAdapterFactory,
  resolveNvimRepositoryContext,
} from "./nvim-pinet-adapter.js";
import {
  formatContextualThreadContext,
  selectOpenContextualThreads,
  type ContextualThreadContextMessage,
} from "./contextual-thread-context.js";
import { SlackActivityLogger } from "./activity-log.js";
import {
  createBrokerDeliveryState,
  queueBrokerInboxIds,
  discardQueuedInboxMessages,
} from "./broker-delivery.js";
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
import { createSlackRequestRuntime, type SlackRequestCall } from "./slack-request-runtime.js";
import { readJoinFile, type JoinFile } from "./join-file.js";
import { getSlackMessageAgeMs, isStaleSlackMessage } from "./stale-slack-messages.js";
import {
  formatSlackAgentsDashboard,
  formatSlackAgentsUsage,
  isSlackAgentCommand,
  isSlackAgentsListCommand,
  resolveSlackAgentCommandNames,
  shouldIncludeSlackAgentsGhosts,
} from "./slack-agents-command.js";
import { createPinetRegistrationGate } from "./pinet-registration-gate.js";
import { createBrokerRuntimeAccess } from "./broker-runtime-access.js";
import { createInboxDrainRuntime } from "./inbox-drain-runtime.js";
import {
  createSubtreeBrokerRuntime,
  getExtensionEntryPath,
  SUBTREE_INHERITED_ENV_KEYS,
} from "./subtree-broker-runtime.js";
import { routeHibernationCommand } from "./broker/hibernation-command-router.js";
import { createAgentCompletionRuntime } from "./agent-completion-runtime.js";
import { sendBrokerMessage } from "./broker/message-send.js";
import { SlackThreadStatusManager } from "./slack-thread-status.js";
import {
  type SlackBridgeRuntimeMode,
  isBrokerManagedFollowerLaunch,
  resolveSlackBridgeStartupRuntimeMode,
} from "./runtime-mode.js";
import {
  buildSlackScopeDriftWarning,
  createPendingSlackScopeDiagnostics,
  createUncheckedSlackScopeDiagnostics,
  detectSlackScopeDiagnostics,
} from "./slack-scope-diagnostics.js";
import { reportDiagnostic, setDiagnosticSink } from "@pinet/transport-core/diagnostics";

// Settings and helpers imported from ./helpers.js

// Process-wide because /reload evaluates a fresh copy of this module (see module-reload.ts).
const RUNTIME_MODE_ACROSS_RELOAD: unique symbol = Symbol.for("pinet.runtimeModeAcrossReload");
const runtimeModeAcrossReload = ((
  globalThis as typeof globalThis & {
    [RUNTIME_MODE_ACROSS_RELOAD]?: { mode?: SlackBridgeRuntimeMode };
  }
)[RUNTIME_MODE_ACROSS_RELOAD] ??= {});

/** What a started runtime mode holds while it runs. */
type PinetRole =
  | { mode: "single" }
  | { mode: "broker" }
  | { mode: "follower"; client: BrokerClientRef };

export default function (pi: ExtensionAPI) {
  let settings = loadSettingsFromFile();

  let botToken = settings.botToken ?? process.env.SLACK_BOT_TOKEN;
  let appToken = settings.appToken ?? process.env.SLACK_APP_TOKEN;
  // Followers need no Slack tokens; only the broker and single-player mode talk to the Slack app.
  const hasSlackTokens = () => Boolean(botToken && appToken);

  pi.registerFlag("pinet-join", {
    description: "Join a Pinet broker as a worker using this join file (from pinet-worker issue)",
    type: "string",
  });
  pi.registerFlag("pinet-follow", {
    description: "Follow the running Pinet broker in this process only, without changing settings",
    type: "boolean",
  });
  // A flag, not an env var: child pi processes must not inherit this worker's identity.
  let startupJoinFile: JoinFile | null = null;
  const joinFilePath = () => {
    const value = pi.getFlag("pinet-join");
    return typeof value === "string" && value ? value : null;
  };

  const slackRequestRuntime = createSlackRequestRuntime();
  // An empty token means "no local Slack app": a follower then calls Slack through the broker.
  const slack: SlackRequestCall = async (method, token, body) => {
    if (token) return slackRequestRuntime.slack(method, token, body);
    const followerClient = getFollowerClient();
    if (followerClient) return followerClient.slackProxy(method, body ?? {});
    throw new Error("Slack bot token is not configured.");
  };

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
    getBrokerRole: getBrokerRole,
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

  const compactionGate = createCompactionGate(() => {
    maybeDrainInboxIfIdle();
    const ctx = sessionUiRuntime.getExtensionContext();
    if (ctx) subtreeBrokerRuntime.drainInbox(ctx);
  });
  const isIdleAndNotCompacting = () =>
    !compactionGate.isActive() && (sessionUiRuntime.getExtensionContext()?.isIdle?.() ?? true);
  let deliverTrackedSlackFollowUpMessage: (options: {
    prompt: string;
    messages: Pick<InboxMessage, "threadTs">[];
  }) => boolean = () => false;
  const inboxDrainRuntime = createInboxDrainRuntime({
    sendUserMessage: (body) => {
      pi.sendUserMessage(body);
    },
    isIdle: isIdleAndNotCompacting,
    takeInboxMessages: (maxMessages) => inbox.splice(0, maxMessages ?? inbox.length),
    restoreInboxMessages: (messages) => {
      inbox.unshift(...messages);
    },
    updateBadge,
    userNames,
    getSecurityPrompt: () => securityPrompt,
    deliverTrackedSlackFollowUpMessage: (options) => deliverTrackedSlackFollowUpMessage(options),
    getBrokerRole: getBrokerRole,
    hasFollowerClient: () => getFollowerClient() !== null,
    flushFollowerDeliveredAcks: () => followerRuntime.flushDeliveredAcks(),
    markBrokerInboxIdsDelivered: (inboxIds) => {
      brokerRuntime.markDelivered(inboxIds);
    },
    markSubtreeInboxIdsDelivered: (inboxIds) => {
      subtreeBrokerRuntime.markDelivered(inboxIds);
    },
    getFollowerDeliveryState: () => followerDeliveryState,
  });
  const { deliverFollowUpMessage, flushDeliveredFollowerAcks, drainInbox } = inboxDrainRuntime;
  drainInboxPort = drainInbox;

  function deliverSteeringMessage(text: string, ctx: ExtensionContext): boolean {
    try {
      return compactionGate.tryDeliver(() => {
        if (ctx.isIdle?.() ?? true) {
          pi.sendUserMessage(text);
        } else {
          pi.sendUserMessage(text, { deliverAs: "steer" });
        }
      });
    } catch (error) {
      reportDiagnostic("error", `[slack-bridge] Pinet steering delivery failed: ${msg(error)}`);
      return false;
    }
  }

  // ─── Helpers ─────────────────────────────────────────

  let gitContext: GitContext | null = null;
  const runtimeAgentContext = createRuntimeAgentContext({
    cwd: process.cwd(),
    getSettings: () => settings,
    setSettings: (nextSettings) => {
      settings = nextSettings;
    },
    getBotToken: () => botToken,
    // A --pinet-join worker reaches Slack only through its broker. Local tokens may belong to
    // another Slack app, such as the worker machine owner's own workspace.
    setBotToken: (token) => {
      botToken = joinFilePath() ? undefined : token;
    },
    getAppToken: () => appToken,
    setAppToken: (token) => {
      appToken = joinFilePath() ? undefined : token;
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
    getBrokerRole: getBrokerRole,
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
    getGitContext: async (signal) => {
      gitContext ??= await probeGitContext(process.cwd(), undefined, signal);
      return gitContext;
    },
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
    if (ctx?.hasUI) ctx.ui.notify(warning, "warning");
    else reportDiagnostic("warning", `[slack-bridge] ${warning}`);
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
    getBrokerRole: getBrokerRole,
    getBrokerPromptSetting: () => settings.brokerPrompt,
  });

  let isSinglePlayerShuttingDown = () => false;
  let isSinglePlayerConnected = () => false;
  const slackThreadStatuses = new SlackThreadStatusManager({
    slack,
    getBotToken: () => botToken ?? "",
    formatError: msg,
  });
  const slackRuntimeAccess = createSlackRuntimeAccess({
    slack,
    getBotToken: () => botToken ?? "",
    userNames,
    channelCache,
    persistState,
    isSinglePlayerShuttingDown: () => isSinglePlayerShuttingDown(),
    getSuggestedPrompts: () => settings.suggestedPrompts,
    getAgentName: () => agentName,
    getThreads: () => threads,
    getBrokerRole: getBrokerRole,
    resolveBrokerThreadChannel: (threadTs) =>
      brokerRuntime.getBroker()?.db.getThread(threadTs)?.channel ?? null,
    resolveFollowerThreadChannel: async (threadTs) =>
      (await getFollowerClient()?.resolveThread(threadTs)) ?? null,
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
    getBrokerRole: getBrokerRole,
    getRuntimeMode: getRuntimeMode,
    isFollowerConnected: () => getFollowerClient() !== null,
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
    getPinetEnabled: isPinetEnabled,
    getBrokerRole: getBrokerRole,
    getDesiredAgentStatus: () => desiredAgentStatus,
    setDesiredAgentStatus: (status) => {
      desiredAgentStatus = status;
    },
    getActiveBrokerDb,
    getActiveBrokerSelfId,
    hasFollowerClient: () => getFollowerClient() !== null,
    syncFollowerDesiredStatus: (options) => followerRuntime.syncDesiredStatus(options),
    runBrokerMaintenance: (ctx) => {
      brokerRuntime.runMaintenance(ctx);
    },
    getInboxLength: () => inbox.length,
    getCurrentRuntimeMode: getRuntimeMode,
    maybeDrainInboxIfIdle,
    getExtensionContext: () => sessionUiRuntime.getExtensionContext() ?? undefined,
  });
  const { reportStatus, signalAgentFree } = pinetAgentStatus;
  // Every run starts here, whatever started it: Slack, Pinet, steering or local input.
  // agent_end's auto-free marks it idle again.
  pi.on("agent_start", () => {
    void reportStatus("working").catch(() => {
      /* best effort: follower polling retries the sync */
    });
  });
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
    getBrokerRole: getBrokerRole,
    getGuardrails: () => guardrails,
    requireToolPolicy,
    formatAction: formatConfirmationAction,
    formatError: msg,
    deliverFollowUpMessage,
    beginThreadStatus: (channel, threadTs, status) =>
      slackThreadStatuses.begin(channel, threadTs, status),
    updateThreadStatus: (channel, threadTs, status) =>
      slackThreadStatuses.update(channel, threadTs, status),
    clearThreadStatus: (channel, threadTs) => slackThreadStatuses.clear(channel, threadTs),
    onCompletionAgentEnd: agentCompletionRuntime.onAgentEnd,
    setDeliverTrackedSlackFollowUpMessage: (deliver) => {
      deliverTrackedSlackFollowUpMessage = deliver;
    },
  });
  const pinetMaintenanceDelivery = createPinetMaintenanceDelivery({
    getActiveBrokerDb,
    getActiveBrokerSelfId,
    isIdle: isIdleAndNotCompacting,
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
  const subtreeBrokerRuntime = createSubtreeBrokerRuntime({
    cwd: process.cwd(),
    getSettings: () => settings,
    getAgentStableId: () => agentStableId,
    getCentralAgentId: () => getFollowerClient()?.getRegisteredIdentity()?.agentId ?? null,
    getAgentIdentity: () => ({ name: agentName, emoji: agentEmoji }),
    getAgentMetadata,
    getMeshRoleFromMetadata: (metadata, fallbackRole) =>
      getMeshRoleFromMetadata(metadata, fallbackRole),
    pushInboxMessages: (messages) => {
      inbox.push(...messages);
    },
    discardQueuedInboxMessages: (inboxIds) => {
      discardQueuedInboxMessages(inbox, "subtree", inboxIds);
    },
    updateBadge,
    maybeDrainInboxIfIdle,
    deliverSteeringMessage,
    requestRemoteControl,
    runRemoteControl,
    formatError: msg,
  });
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
    isSingleRuntimeActive: () => {
      const state = pinetRuntime.state();
      return state.kind !== "off" && state.mode === "single";
    },
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
    beginThreadStatus: (channelId, threadTs, status) =>
      slackThreadStatuses.begin(channelId, threadTs, status),
    claimOwnedThread: (threadTs, channelId, source = "slack") => {
      if (getBrokerRole() === "broker") {
        brokerRuntime.claimThread(threadTs, channelId, source);
      } else {
        void getFollowerClient()
          ?.claimThread(threadTs, channelId, source)
          .catch(() => {
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

  // The one owner of this process's runtime mode. Every start, stop, reload
  // and mode change goes through it; the readers below derive from its state.
  const pinetRuntime = createPinetRuntime<PinetRole, ExtensionContext>({
    start: async (ctx, mode, { signal, publish }) => {
      slackRequestRuntime.reset();
      singlePlayerRuntime.resetShutdownState();
      if (mode === "single") {
        await singlePlayerRuntime.connect(ctx, signal);
        signal.throwIfAborted();
        botUserId = singlePlayerRuntime.getBotUserId() ?? botUserId;
        await publish({ mode: "single" });
      } else if (mode === "broker") {
        await connectAsBroker(ctx, { publish }, signal);
      } else {
        await connectAsFollower(ctx, signal, publish);
      }
      void ensureSlackScopeDiagnostics(ctx);
    },
    stop: (ctx, options) => stopPinetRoles(ctx, options),
    reload: async (ctx, running, { setRole }) => {
      const currentRole = running.mode === "single" ? null : running.mode;
      let reloadBrokerInPlace = false;
      const validateRefreshedState = () => {
        if (currentRole !== "follower" && !hasSlackTokens()) {
          throw new Error("Slack tokens are not configured after reload.");
        }
        if (currentRole === "broker") {
          reloadBrokerInPlace = brokerRuntime.canReloadInPlace();
        }
      };

      if (currentRole === "broker") {
        await reloadPinetRuntimeInPlaceSafely({
          snapshotState: () => snapshotReloadableRuntime(),
          restoreState: (snapshot) => {
            restoreReloadableRuntime(snapshot);
          },
          refreshState: () => {
            refreshSettings();
          },
          validateRefreshedState,
          reloadRuntime: async () => {
            if (reloadBrokerInPlace) {
              const result = await brokerRuntime.reloadAdapters(ctx);
              botUserId = result.botUserId;
              await toolRegistrationRuntime.sync(pi, getRuntimeMode());
              return;
            }

            await setRole(null);
            await stopPinetRoles(ctx, { releaseIdentity: false });
            slackRequestRuntime.reset();
            singlePlayerRuntime.resetShutdownState();
            setExtStatus(ctx, "reconnecting");
            await connectAsBroker(ctx, { refreshSettings: false, publish: setRole });
          },
        });
        return;
      }

      await reloadPinetRuntimeSafely({
        getCurrentRole: () => currentRole,
        snapshotState: () => snapshotReloadableRuntime(),
        restoreState: (snapshot) => {
          restoreReloadableRuntime(snapshot);
        },
        refreshState: () => {
          refreshSettings();
        },
        validateRefreshedState,
        stopRuntime: async () => {
          await setRole(null);
          await stopPinetRoles(ctx, { releaseIdentity: false });
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
            await connectAsBroker(ctx, { publish: setRole });
            return;
          }
          await connectAsFollower(ctx, undefined, setRole);
        },
      });
    },
    onChange: async (ctx, state) => {
      if (state.kind === "off") setExtStatus(ctx, "off");
      if (state.kind === "starting") setExtStatus(ctx, "reconnecting");
      await toolRegistrationRuntime.sync(pi, getRuntimeMode());
    },
  });
  // Function declarations so the many dependency objects above can take them.
  function runningRole(): PinetRole | null {
    const state = pinetRuntime.state();
    return state.kind === "running" ? state.role : null;
  }
  function getRuntimeMode(): SlackBridgeRuntimeMode {
    return runningRole()?.mode ?? "off";
  }
  function getBrokerRole(): "broker" | "follower" | null {
    const mode = runningRole()?.mode;
    return mode === "broker" || mode === "follower" ? mode : null;
  }
  function getFollowerClient(): BrokerClientRef["client"] | null {
    const role = runningRole();
    return role?.mode === "follower" ? role.client.client : null;
  }
  function isPinetEnabled(): boolean {
    return getBrokerRole() !== null;
  }
  function reloadPinetRuntime(ctx: ExtensionContext): Promise<void> {
    return pinetRuntime.reload(ctx);
  }
  let lastFollowerUnregisterError: string | null = null;
  let followerRuntimeDiagnostic: FollowerRuntimeDiagnostic | null = null;
  const followerDeliveryState = createFollowerDeliveryState();
  let desiredAgentStatus: "working" | "idle" = "idle";
  const pinetRegistrationGate = createPinetRegistrationGate();

  const brokerThreadOwnerHints = createBrokerThreadOwnerHints({
    slack,
    getBotToken: () => botToken!,
  });
  const { resolveBrokerThreadOwnerHint } = brokerThreadOwnerHints;

  const handleBrokerAppHomeOpened = async (userId: string, ctx: ExtensionContext) => {
    await pinetHomeTabs.publishCurrentPinetHomeTabSafely(userId, ctx, new Date().toISOString());
  };
  const handleBrokerSlackSlashCommand = async (event: {
    command: string;
    text: string;
  }): Promise<string | null> => {
    const commandNames = resolveSlackAgentCommandNames(settings, activeSkinTheme);
    if (!isSlackAgentCommand(event.command, commandNames)) {
      return null;
    }
    if (!isSlackAgentsListCommand(event.command, event.text, commandNames)) {
      return formatSlackAgentsUsage(commandNames);
    }
    const snapshot = await buildCurrentBrokerControlPlaneDashboardSnapshot();
    if (!snapshot) {
      return "Pinet broker dashboard data is not available yet. Try again after the broker completes a maintenance cycle.";
    }
    return formatSlackAgentsDashboard(snapshot, shouldIncludeSlackAgentsGhosts(event.text));
  };
  const slackPinetAdapterFactory = createSlackPinetRuntimeAdapterFactory({
    getSettings: () => settings,
    getBotToken: () => botToken!,
    getAppToken: () => appToken!,
    getAllowedUsers: () => allowedUsers,
    shouldAllowAllWorkspaceUsers: () =>
      resolveAllowAllWorkspaceUsers(settings, process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS),
    setExtStatus,
    onAppHomeOpened: handleBrokerAppHomeOpened,
    onSlashCommand: handleBrokerSlackSlashCommand,
  });

  const brokerRuntime = createBrokerRuntime({
    getSettings: () => settings,
    getAllowedUsers: () => allowedUsers,
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
        if (isStaleSlackMessage(message)) {
          const ageMs = getSlackMessageAgeMs(message);
          reportDiagnostic(
            "info",
            `[slack-bridge] skipped stale Slack inbound message older than 15m: channel=${message.channel} thread=${message.threadId} ts=${message.timestamp} age_ms=${ageMs ?? "unknown"}`,
          );
          return;
        }

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
                  threadOwnerHint: ownerHint,
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

        if (decision.action === "broadcast") {
          const remoteAgentIds = decision.agentIds.filter((agentId) => agentId !== selfId);
          if (broker.db.queueMessageToAgents) {
            broker.db.queueMessageToAgents(remoteAgentIds, routedMessage);
          } else {
            for (const agentId of remoteAgentIds) broker.db.queueMessage(agentId, routedMessage);
          }
          if (!decision.agentIds.includes(selfId)) return;
        }

        if (
          decision.action === "deliver" ||
          decision.action === "broadcast" ||
          decision.action === "unrouted"
        ) {
          const persisted = routedMessage.threadId
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
        reportDiagnostic("error", `[slack-bridge] broker inbound routing failed: ${msg(err)}`);
      }
    },
    pushInboxMessages: (messages) => {
      inbox.push(...messages);
    },
    updateBadge,
    maybeDrainInboxIfIdle,
    deliverSteeringMessage,
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
    createAdapterBindings: [slackPinetAdapterFactory, createNvimPinetRuntimeAdapterFactory()],
    onAdminShutdownRequested: async (ctx) => {
      // `/pinet start replace` from another local session: stop being the
      // broker but keep this session alive (issue #951).
      ctx.ui.notify(
        "Pinet broker shutdown requested by another local session (/pinet start replace). Stopping the broker runtime in this session.",
        "warning",
      );
      await pinetRuntime.setMode(ctx, "off", { releaseIdentity: true });
      slackRequestRuntime.reset();
      singlePlayerRuntime.resetShutdownState();
    },
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
    getPinetEnabled: isPinetEnabled,
    getBrokerRole: getBrokerRole,
    getActiveBrokerDb,
    getActiveBrokerSelfId,
    getAgentName: () => agentName,
    getFollowerClient,
    sendSubtreeAgentMessage: (target, body, metadata) =>
      subtreeBrokerRuntime.sendMessage(target, body, metadata),
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
    searchPinetSessions,
  } = pinetMeshOps;

  async function runHibernationCommand(
    command: "hibernate" | "wake",
    target: string,
    reason?: string,
  ): Promise<HibernationCommandResult> {
    // Thin wrapper: DB-topology resolution + executor composition live in the
    // extracted, independently-tested production router, so the live extension and
    // the production-route E2E drive the exact same integration code. `brokerRole`,
    // the runtime-activation authority (via the router's internal
    // `hibernationRuntimeActive()` gate), the real subtree control accessor, and the
    // central-DB fallback are all threaded through unchanged.
    return routeHibernationCommand({
      command,
      target,
      ...(reason !== undefined ? { reason } : {}),
      brokerRole: getBrokerRole(),
      hib: resolveHibernationSettings(settings),
      getRuntimeControl: () => subtreeBrokerRuntime.getHibernationRuntimeControl(),
      getFallbackDb: () => getActiveBrokerDb(),
      extensionEntryPath: getExtensionEntryPath(),
      inheritedEnvKeys: SUBTREE_INHERITED_ENV_KEYS,
    });
  }

  async function listPinetLanes(options: PinetLaneListOptions) {
    if (getBrokerRole() === "broker") {
      const db = getActiveBrokerDb();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.listPinetLanes(options);
    }
    const followerClient = getFollowerClient();
    if (followerClient) {
      return await followerClient.listLanes(options);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function upsertPinetLane(input: PinetLaneUpsertInput) {
    if (getBrokerRole() === "broker") {
      const db = getActiveBrokerDb();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.upsertPinetLane(input);
    }
    const followerClient = getFollowerClient();
    if (followerClient) {
      return await followerClient.upsertLane(input);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function setPinetLaneParticipant(input: PinetLaneParticipantUpsertInput) {
    if (getBrokerRole() === "broker") {
      const db = getActiveBrokerDb();
      const selfId = getActiveBrokerSelfId();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.setPinetLaneParticipant({
        ...input,
        agentId: input.agentId.trim().length > 0 ? input.agentId : (selfId ?? input.agentId),
      });
    }
    const followerClient = getFollowerClient();
    if (followerClient) {
      return await followerClient.setLaneParticipant(input);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function acquirePortLease(input: PortLeaseAcquireInput) {
    if (getBrokerRole() === "broker") {
      const db = getActiveBrokerDb();
      const selfId = getActiveBrokerSelfId();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.acquirePortLease({ ...input, ownerAgentId: input.ownerAgentId ?? selfId ?? null });
    }
    const followerClient = getFollowerClient();
    if (followerClient) {
      return await followerClient.acquirePortLease(input);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function renewPortLease(input: PortLeaseRenewInput) {
    if (getBrokerRole() === "broker") {
      const db = getActiveBrokerDb();
      const selfId = getActiveBrokerSelfId();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.renewPortLease({ ...input, ownerAgentId: input.ownerAgentId ?? selfId ?? null });
    }
    const followerClient = getFollowerClient();
    if (followerClient) {
      return await followerClient.renewPortLease(input);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function releasePortLease(input: PortLeaseReleaseInput) {
    if (getBrokerRole() === "broker") {
      const db = getActiveBrokerDb();
      const selfId = getActiveBrokerSelfId();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.releasePortLease({ ...input, ownerAgentId: input.ownerAgentId ?? selfId ?? null });
    }
    const followerClient = getFollowerClient();
    if (followerClient) {
      return await followerClient.releasePortLease(input);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function getPortLease(leaseId: string) {
    if (getBrokerRole() === "broker") {
      const db = getActiveBrokerDb();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.getPortLease(leaseId);
    }
    const followerClient = getFollowerClient();
    if (followerClient) {
      return await followerClient.getPortLease(leaseId);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function listPortLeases(options: PortLeaseListOptions) {
    if (getBrokerRole() === "broker") {
      const db = getActiveBrokerDb();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.listPortLeases(options);
    }
    const followerClient = getFollowerClient();
    if (followerClient) {
      return await followerClient.listPortLeases(options);
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function expirePortLeases() {
    if (getBrokerRole() === "broker") {
      const db = getActiveBrokerDb();
      if (!db) throw new Error("Broker database is unavailable.");
      return db.expirePortLeases();
    }
    const followerClient = getFollowerClient();
    if (followerClient) {
      return await followerClient.expirePortLeases();
    }
    throw new Error("Pinet is in an unexpected state.");
  }

  async function readPinetInbox(options: {
    threadId?: string;
    limit?: number;
    unreadOnly?: boolean;
    markRead?: boolean;
  }) {
    if (getBrokerRole() === "broker") {
      const db = getActiveBrokerDb();
      const selfId = getActiveBrokerSelfId();
      if (!db || !selfId) {
        throw new Error("Broker agent identity is unavailable.");
      }
      const result = db.readInbox(selfId, options);
      if (result.markedReadIds.length > 0) {
        brokerRuntime.markDelivered(result.markedReadIds);
        discardQueuedInboxMessages(inbox, "broker", result.markedReadIds);
        updateBadge();
      }
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

    const followerClient = getFollowerClient();
    if (followerClient) {
      const subtreeResult = subtreeBrokerRuntime.readInbox(options);
      if (subtreeResult && (subtreeResult.messages.length > 0 || Boolean(options.threadId))) {
        return consumePinetReadConfirmationReplies(subtreeResult, consumeConfirmationReply);
      }
      const result = await followerClient.readInbox(options);
      if (result.markedReadIds.length > 0) {
        markFollowerInboxIdsDelivered(followerDeliveryState, result.markedReadIds);
        discardQueuedInboxMessages(inbox, "broker", result.markedReadIds);
        updateBadge();
        await followerRuntime.flushDeliveredAcks();
      }
      return consumePinetReadConfirmationReplies(result, consumeConfirmationReply);
    }

    throw new Error("Pinet is in an unexpected state.");
  }

  /** Ask the runtime for `mode`, refusing Slack modes without tokens before touching what runs. */
  function setRuntimeMode(ctx: ExtensionContext, mode: SlackBridgeRuntimeMode): Promise<void> {
    if (mode !== "off" && mode !== "follower" && !hasSlackTokens()) {
      return Promise.reject(
        new Error(
          `Pinet ${mode} mode needs SLACK_BOT_TOKEN and SLACK_APP_TOKEN. Without them, join a running broker with /pinet follow.`,
        ),
      );
    }
    return pinetRuntime.setMode(ctx, mode);
  }

  /**
   * Resolve the local mesh secret value for client-side broker RPCs
   * (graceful takeover). Returns null when no secret is configured or the
   * secret file is unreadable — callers degrade to fenced termination.
   */
  function resolveLocalMeshSecretValue(): string | null {
    const meshAuth = resolvePinetMeshAuth(settings);
    if (meshAuth.meshSecret) {
      return meshAuth.meshSecret;
    }
    try {
      return meshAuth.meshSecretPath ? readMeshSecret(meshAuth.meshSecretPath) : readMeshSecret();
    } catch {
      return null;
    }
  }

  async function stopPinetRoles(
    ctx: ExtensionContext,
    options: { releaseIdentity: boolean },
  ): Promise<void> {
    flushPersist();
    await subtreeBrokerRuntime.stop({ releaseIdentity: options.releaseIdentity });
    await brokerRuntime.disconnect({ releaseIdentity: options.releaseIdentity });
    const { unregisterError } = await followerRuntime
      .disconnect(ctx, { releaseIdentity: options.releaseIdentity })
      .catch((error: Error) => ({ unregisterError: msg(error) }));
    lastFollowerUnregisterError = unregisterError;
    followerRuntimeDiagnostic = null;
    await singlePlayerRuntime.disconnect();
    desiredAgentStatus = "idle";
  }

  // ─── Tools ──────────────────────────────────────────

  const toolRegistrationRuntime = createToolRegistrationRuntime({
    buildPromptGuidelines: agentPromptGuidance.buildPromptGuidelines,
    slackTools: {
      getBotToken: () => botToken ?? "",
      getDefaultChannel: () => settings.defaultChannel,
      getSecurityPrompt: () => securityPrompt,
      inbox,
      slack,
      getAgentName: () => agentName,
      getAgentEmoji: () => agentEmoji,
      getAgentOwnerToken: () => agentOwnerToken,
      getLastDmChannel: () => lastDmChannel,
      updateBadge,
      markSubtreeInboxIdsDelivered: (inboxIds) => {
        subtreeBrokerRuntime.markDelivered(inboxIds);
      },
      resolveUser,
      threadContext: singlePlayerRuntime.getThreadContextPort(),
      resolveChannel,
      rememberChannel,
      requireToolPolicy,
      getBotUserId: () => botUserId,
      registerConfirmationRequest,
      pinetDelivery: {
        isEnabled: isPinetEnabled,
        isAvailable: isPinetEnabled,
        sendSlackMessage: async (input) => {
          const content = {
            text: input.text,
            markdown: input.text,
            ...(input.blocks && input.blocks.length > 0 ? { slackBlocks: input.blocks } : {}),
          };
          if (getBrokerRole() === "broker") {
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
                ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
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
          const followerClient = getFollowerClient();
          if (followerClient) {
            return followerClient.sendMessage({
              threadId: input.threadId,
              body: input.text,
              source: "slack",
              channel: input.channel,
              content,
              ...(input.blocks && input.blocks.length > 0 ? { blocks: input.blocks } : {}),
              ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
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
      pinetEnabled: isPinetEnabled,
      brokerRole: getBrokerRole,
      requireToolPolicy,
      sendPinetAgentMessage,
      sendPinetBroadcastMessage,
      replyToPinetThread: async (threadId, body) => {
        if (getBrokerRole() !== "broker") {
          const followerClient = getFollowerClient();
          if (!followerClient) throw new Error("Pinet is in an unexpected state.");
          const result = await followerClient.sendMessage({ threadId, body });
          return {
            messageId: result.messageId,
            threadId: result.threadId,
            source: result.source,
            channel: result.channel,
          };
        }
        const broker = getActiveBroker();
        const selfId = getActiveBrokerSelfId();
        if (!broker || !selfId) throw new Error("Broker agent identity is unavailable.");
        const result = await sendBrokerMessage(
          { db: broker.db, adapters: broker.adapters },
          { threadId, body, senderAgentId: selfId },
        );
        return {
          messageId: result.message.id,
          threadId: result.thread.threadId,
          source: result.thread.source,
          channel: result.thread.channel,
        };
      },
      signalAgentFree,
      scheduleBrokerWakeup,
      scheduleFollowerWakeup,
      readPinetInbox,
      listBrokerAgents,
      listFollowerAgents,
      searchPinetSessions,
      listSubtreeAgents: (includeGhosts) => subtreeBrokerRuntime.listAgents(includeGhosts),
      getSubtreeSelfAgentId: () => subtreeBrokerRuntime.getStatus().selfAgentId,
      spawnSubtreeWorker: async (input) => {
        const activeCtx = sessionUiRuntime.getExtensionContext();
        if (!activeCtx) throw new Error("No active Pi extension context for subtree spawn.");
        return await subtreeBrokerRuntime.spawnWorker(activeCtx, input);
      },
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
        getRuntimeMode() === "broker" ? brokerRuntime.getRalphSnoozeStatus() : null,
      snoozeRalphLoop: (input) => brokerRuntime.snoozeRalphLoop(input),
      clearRalphSnooze: () => brokerRuntime.clearRalphSnooze(),
      runHibernateCommand: ({ target, reason }) =>
        runHibernationCommand("hibernate", target, reason),
      runWakeCommand: ({ target, reason }) => runHibernationCommand("wake", target, reason),
      getAgentLifecycleProjection: (agentIds?: string[]): AgentLifecycleStatus[] => {
        if (getBrokerRole() !== "broker") return [];
        const db = getActiveBrokerDb();
        if (!db) return [];
        const hib = resolveHibernationSettings(settings);
        return collectAgentLifecycleStatuses(db, {
          ...(agentIds ? { agentIds } : {}),
          maxConcurrentWakes: hib.maxConcurrentWakes,
          maxConcurrentWakesPerRepo: hib.maxConcurrentWakesPerRepo,
        });
      },
    },
    iMessageTools: {
      pinetEnabled: isPinetEnabled,
      brokerRole: getBrokerRole,
      requireToolPolicy,
      getActiveBroker,
      getActiveBrokerSelfId,
      sendFollowerIMessage: async (input) => {
        const followerClient = getFollowerClient();
        if (!followerClient) {
          throw new Error("Pinet is in an unexpected state.");
        }

        const result = await followerClient.sendMessage(input);
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

  async function connectAsBroker(
    ctx: ExtensionContext,
    options: { refreshSettings?: boolean; publish: (role: PinetRole) => Promise<void> },
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    setExtStatus(ctx, "reconnecting");
    if (options.refreshSettings !== false) {
      refreshSettings();
    }
    maybeWarnSlackUserAccess(ctx);
    maybeWarnSlackGuardrailPosture(ctx);

    const {
      botUserId: brokerBotUserId,
      recoveredBrokerMessages,
      recoveredTargetedBacklogCount,
      releasedBrokerClaims,
    } = await brokerRuntime.connect(ctx, signal);
    signal?.throwIfAborted();
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
          const abortConnect = () => {
            void imessageAdapter.disconnect().catch(() => undefined);
          };
          signal?.addEventListener("abort", abortConnect, { once: true });
          try {
            await imessageAdapter.connect();
            signal?.throwIfAborted();
            broker.addAdapter(imessageAdapter);
          } finally {
            signal?.removeEventListener("abort", abortConnect);
          }

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

    signal?.throwIfAborted();
    broker.server.setOutboundMessageAdapters?.(broker.adapters);

    await options.publish({ mode: "broker" });
    void reportStatus(ctx.isIdle?.() === false ? "working" : "idle").catch(() => {});

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
    getJoinFile: () => {
      const validated = startupJoinFile;
      startupJoinFile = null;
      if (validated) return validated;
      const joinPath = joinFilePath();
      return joinPath ? readJoinFile(joinPath) : null;
    },
    getSettings: () => settings,
    refreshSettings,
    getPinetEnabled: isPinetEnabled,
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
    onRegistrationIdentityApplied: async () => {
      if (getRuntimeMode() === "follower") {
        await toolRegistrationRuntime.sync(pi, getRuntimeMode());
      }
    },
    persistState,
    updateBadge,
    maybeDrainInboxIfIdle,
    requestRemoteControl,
    deferControlAck: deferFollowerControlAck,
    runRemoteControl,
    deliverFollowUpMessage,
    deliverSteeringMessage,
    setExtStatus,
    getRuntimeDiagnostic: () => followerRuntimeDiagnostic,
    setRuntimeDiagnostic: (diagnostic) => {
      followerRuntimeDiagnostic = diagnostic;
    },
    handleTerminalReconnectFailure: async (ctx, error) => {
      reportDiagnostic("error", `[slack-bridge] follower reconnect failed: ${msg(error)}`);
      const diagnostic = followerRuntimeDiagnostic;
      await pinetRuntime.setMode(ctx, "off").catch((stopError: Error) => {
        reportDiagnostic("error", `[slack-bridge] follower stop failed: ${msg(stopError)}`);
      });
      followerRuntimeDiagnostic = diagnostic;
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
      pinetEnabled: isPinetEnabled,
      pinetRegistrationBlocked: pinetRegistrationGate.isBlocked,
      runtimeMode: getRuntimeMode,
      runtimeConnected: () =>
        getRuntimeMode() === "broker"
          ? brokerRuntime.isConnected()
          : getRuntimeMode() === "follower"
            ? (getFollowerClient()?.isConnected() ?? false)
            : getRuntimeMode() === "single"
              ? singlePlayerRuntime.isConnected()
              : false,
      brokerRole: getBrokerRole,
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
        getRuntimeMode() === "broker" ? brokerRuntime.getRalphSnoozeStatus() : null,
      snoozeRalphLoop: (input) => brokerRuntime.snoozeRalphLoop(input),
      clearRalphSnooze: () => brokerRuntime.clearRalphSnooze(),
      getBrokerControlPlaneHomeTabViewerIds,
      lastBrokerControlPlaneHomeTabRefreshAt: () => brokerRuntime.getLastHomeTabRefreshAt(),
      lastBrokerControlPlaneHomeTabError: () => brokerRuntime.getLastHomeTabError(),
      subtreeBrokerStatus: () => subtreeBrokerRuntime.getStatus(),
      inspectGlobalBroker: async () => {
        const lock = inspectBrokerLock();
        if (lock.state !== "alive") {
          return { lock, probe: null };
        }
        return { lock, probe: await probeBrokerSocket() };
      },
      getPinetRegistrationBlockReason: pinetRegistrationGate.getBlockReason,
      replaceGlobalBroker: async (): Promise<ReplaceBrokerOwnerResult> =>
        replaceBrokerOwner({ meshSecret: resolveLocalMeshSecretValue() }),
      connectAsBroker: (ctx) => setRuntimeMode(ctx, "broker"),
      connectAsFollower: (ctx) => setRuntimeMode(ctx, "follower"),
      reloadPinetRuntime,
      disconnectFollower,
      startSubtreeBroker: (ctx) => subtreeBrokerRuntime.start(ctx),
      stopSubtreeBroker: () => subtreeBrokerRuntime.stop({ releaseIdentity: true }),
      spawnSubtreeWorker: (ctx, input) => subtreeBrokerRuntime.spawnWorker(ctx, input),
      sendPinetAgentMessage,
      signalAgentFree,
      applyLocalAgentIdentity: async (name, emoji, personality) => {
        applyLocalAgentIdentity(name, emoji, personality);
        await toolRegistrationRuntime.sync(pi, getRuntimeMode());
      },
      setExtStatus,
      setExtCtx: sessionUiRuntime.setExtCtx,
    },
  });

  commandRegistrationRuntime.register(pi);

  async function connectAsFollower(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    publish: (role: PinetRole) => Promise<void>,
  ): Promise<void> {
    signal?.throwIfAborted();
    pinetRegistrationGate.assertCanRegister();

    const clientRef = await followerRuntime.connect(ctx, signal);
    signal?.throwIfAborted();
    followerRuntimeDiagnostic = null;
    await publish({ mode: "follower", client: clientRef });
    // A run may already be under way: its agent_start fired before Pinet was connected.
    void reportStatus(ctx.isIdle?.() === false ? "working" : "idle").catch(() => {});
    setExtStatus(ctx, "ok");
  }

  async function disconnectFollower(
    ctx: ExtensionContext,
  ): Promise<{ unregisterError: string | null }> {
    await pinetRuntime.setMode(ctx, "off");
    return { unregisterError: lastFollowerUnregisterError };
  }

  // ─── Lifecycle ──────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    const reloadedMode = event.reason === "reload" ? runtimeModeAcrossReload.mode : undefined;
    delete runtimeModeAcrossReload.mode;
    compactionGate.reset();
    singlePlayerRuntime.resetShutdownState();
    slackRequestRuntime.reset();
    resetRemoteControlState();
    resetPendingRemoteControlAcks();
    sessionUiRuntime.prepareForSessionStart(ctx);
    if (ctx.mode === "tui") {
      // The TUI owns the terminal: a console write would draw over it.
      setDiagnosticSink((level, message) => {
        if (level !== "info") ctx.ui.notify(message, level);
      });
    }
    // Restore persisted thread state (always restore, even before /pinet)
    restorePersistedRuntimeState(ctx);
    const pinetRegistrationBlocked = pinetRegistrationGate.evaluateSessionStart(ctx);
    const joinPath = joinFilePath();
    startupJoinFile = null;
    if (joinPath) {
      // Tokens loaded before flags were parsed; a worker must not use them (see setBotToken).
      botToken = undefined;
      appToken = undefined;
      try {
        startupJoinFile = readJoinFile(joinPath);
        // Explicit membership also applies to headless sessions.
        pinetRegistrationGate.reset();
      } catch (error) {
        ctx.ui.notify(`Pinet join file rejected: ${msg(error)}`, "error");
        await pinetRuntime.setMode(ctx, "off");
        return;
      }
    }

    if (!startupJoinFile && pinetRegistrationBlocked) {
      reportDiagnostic(
        "info",
        "[slack-bridge] detected local subagent context; skipping Pinet registration",
      );
      await pinetRuntime.setMode(ctx, "off");
      return;
    }

    refreshSettings();
    maybeWarnSlackUserAccess(ctx);
    // Process-scoped: overrides runtimeMode for this process only and never edits settings.
    const followRequested = pi.getFlag("pinet-follow") === true;
    const brokerSocketPath = resolveBrokerSocketPath();
    const configuredMode =
      reloadedMode ??
      (startupJoinFile
        ? "follower"
        : resolveSlackBridgeStartupRuntimeMode(settings, {
            brokerSocketExists: fs.existsSync(brokerSocketPath),
            brokerManagedFollowerLaunch: isBrokerManagedFollowerLaunch(),
            processFollowRequested: followRequested,
          }));
    const startupMode = configuredMode === "follower" || hasSlackTokens() ? configuredMode : "off";

    if (startupMode === "off") {
      if (followRequested && !startupJoinFile && !reloadedMode) {
        const failure = `--pinet-follow found no broker socket at ${brokerSocketPath}. Slack, Pinet and iMessage tools stay off. Start the broker or set PINET_SOCKET_PATH, then restart this process.`;
        reportDiagnostic("error", `[slack-bridge] ${failure}`);
        ctx.ui.notify(failure, "warning");
      }
      await pinetRuntime.setMode(ctx, "off");
      return;
    }

    // A later mode request supersedes this one; the runtime then resolves it unstarted.
    const startup = pinetRuntime.setMode(ctx, startupMode).then(
      () => {
        if (getRuntimeMode() !== startupMode) return;
        if (startupMode === "single") maybeWarnSlackGuardrailPosture(ctx);
        reportDiagnostic("info", `[slack-bridge] runtime mode: ${startupMode}`);
      },
      (error: Error) => {
        reportDiagnostic(
          "error",
          `[slack-bridge] runtime start (${startupMode}) failed: ${msg(error)}`,
        );
        if (joinPath || followRequested) {
          ctx.ui.notify(
            `Pinet could not join the broker: ${msg(error)}. Slack, Pinet and iMessage tools stay off.`,
            "warning",
          );
        }
        slackRequestRuntime.reset();
        singlePlayerRuntime.resetShutdownState();
      },
    );
    // Explicit joins need their tools enabled before Pi builds the first prompt.
    if (joinPath || followRequested) await startup;
  });

  // ─── Agent event wiring ──────────────────────────────

  agentEventRuntime.register(pi);

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!isPinetEnabled()) return;
    const repository = resolveNvimRepositoryContext(ctx.cwd);
    if (!repository) return;

    try {
      const brokerDb = getBrokerRole() === "broker" ? getActiveBrokerDb() : null;
      const selfId = getBrokerRole() === "broker" ? getActiveBrokerSelfId() : null;
      const followerClient = getFollowerClient();
      const threads =
        brokerDb && selfId
          ? brokerDb.getThreads(selfId)
          : followerClient
            ? await followerClient.listThreads()
            : [];
      const selected = selectOpenContextualThreads(threads, repository, 5);
      if (selected.length === 0) return;

      const messagesByThread = new Map<string, ContextualThreadContextMessage[]>();
      for (const item of selected) {
        if (brokerDb) {
          messagesByThread.set(
            item.thread.threadId,
            brokerDb
              .getMessagesForThread(item.thread.threadId, 6)
              .map((message) => ({ sender: message.sender, body: message.body })),
          );
          continue;
        }
        if (followerClient) {
          const result = await followerClient.readInbox({
            threadId: item.thread.threadId,
            unreadOnly: false,
            markRead: false,
            limit: 6,
          });
          messagesByThread.set(
            item.thread.threadId,
            result.messages.map(({ message }) => ({ sender: message.sender, body: message.body })),
          );
        }
      }

      const content = formatContextualThreadContext(selected, messagesByThread);
      if (!content) return;
      return {
        message: {
          customType: "pinet-contextual-threads",
          content,
          display: true,
        },
      };
    } catch (error) {
      reportDiagnostic("error", `[slack-bridge] contextual thread hydration failed: ${msg(error)}`);
      return;
    }
  });

  pi.on("session_before_compact", (event) => {
    compactionGate.begin(event.signal);
  });

  pi.on("session_compact", () => {
    compactionGate.end();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // /reload replaces Pinet's code, not its state: keep this agent's identity, threads and
    // inbox, and restart the mode it was in, including off. A mode change still in progress
    // has no settled mode, so the reload starts from the defaults instead.
    const reloading = event.reason === "reload";
    if (reloading && pinetRuntime.requestedMode() === getRuntimeMode()) {
      runtimeModeAcrossReload.mode = getRuntimeMode();
    }
    compactionGate.reset();
    resetRemoteControlState();
    resetPendingRemoteControlAcks();
    sessionUiRuntime.cleanupForSessionShutdown();
    flushPersist();
    try {
      await pinetRuntime.setMode(ctx, "off", { releaseIdentity: !reloading });
      // Top-level Slack tools run in every mode, including off: refuse new calls and abort
      // in-flight ones.
      await singlePlayerRuntime.disconnect();
      pinetRegistrationGate.reset();
    } finally {
      setDiagnosticSink(null);
    }
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
