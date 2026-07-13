import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type FollowerRuntimeDiagnostic,
  type FollowerThreadState,
  type InboxMessage,
  type PinetControlCommand,
  type PinetRemoteControlRequestResult,
  type PinetSteeringInboxEntry,
  type SlackBridgeSettings,
  buildFollowerRuntimeDiagnostic,
  buildPinetOwnerToken,
  extractPinetSteeringInboxEntry,
  extractPinetControlCommand,
  formatPinetInboxMessages,
  formatPinetSteeringMessage,
  getFollowerOwnedThreadReclaims,
  getFollowerReconnectUiUpdate,
  partitionFollowerInboxEntries,
  resolvePinetMeshAuth,
  resolveRuntimeAgentIdentity,
  syncFollowerInboxEntries,
  syncTransferredSlackThreadContexts,
} from "./helpers.js";
import {
  type FollowerDeliveryState,
  drainFollowerAckBatches,
  hasDeliveredFollowerInboxIds,
  isFollowerInboxIdTracked,
  markFollowerInboxIdsDelivered,
  queueFollowerInboxIds,
  resetFollowerDeliveryState,
} from "./follower-delivery.js";
import { BrokerClient, DEFAULT_SOCKET_PATH } from "./broker/client.js";

function resolveBrokerSocketPath(): string {
  const envPath = process.env.PINET_SOCKET_PATH?.trim();
  return envPath && envPath.length > 0 ? envPath : DEFAULT_SOCKET_PATH;
}

export type BrokerClientRef = {
  client: BrokerClient;
  pollInterval: ReturnType<typeof setInterval> | null;
};

type SharedFollowerThreadState = Pick<
  FollowerThreadState,
  "channelId" | "threadTs" | "userId" | "source" | "owner"
>;

export interface FollowerRuntimeDeps {
  getSettings: () => SlackBridgeSettings;
  refreshSettings: () => void;
  getPinetEnabled: () => boolean;
  getAgentIdentity: () => { name: string; emoji: string };
  getAgentStableId: () => string;
  getAgentOwnerToken: () => string;
  setAgentOwnerToken: (ownerToken: string) => void;
  getDesiredAgentStatus: () => "working" | "idle";
  getAgentAliases: () => Iterable<string>;
  getThreads: () => Map<string, SharedFollowerThreadState>;
  getLastDmChannel: () => string | null;
  setLastDmChannel: (channelId: string | null) => void;
  pushInboxMessages: (messages: InboxMessage[]) => void;
  getAgentMetadata: (role: "broker" | "worker") => Promise<Record<string, unknown>>;
  applyRegistrationIdentity: (registration: {
    name: string;
    emoji: string;
    metadata?: Record<string, unknown> | null;
  }) => Promise<void> | void;
  persistState: () => void;
  updateBadge: () => void;
  maybeDrainInboxIfIdle: (ctx: ExtensionContext) => boolean;
  requestRemoteControl: (
    command: PinetControlCommand,
    ctx: ExtensionContext,
  ) => PinetRemoteControlRequestResult;
  deferControlAck: (command: PinetControlCommand, inboxId: number) => void;
  runRemoteControl: (command: PinetControlCommand, ctx: ExtensionContext) => void;
  deliverFollowUpMessage: (text: string) => boolean;
  deliverSteeringMessage: (text: string, ctx: ExtensionContext) => boolean;
  setExtStatus: (ctx: ExtensionContext, state: "ok" | "reconnecting" | "error" | "off") => void;
  getRuntimeDiagnostic: () => FollowerRuntimeDiagnostic | null;
  setRuntimeDiagnostic: (diagnostic: FollowerRuntimeDiagnostic | null) => void;
  handleTerminalReconnectFailure: (ctx: ExtensionContext, error: Error) => Promise<void> | void;
  formatError: (error: unknown) => string;
  deliveryState: FollowerDeliveryState;
}

export interface FollowerRuntime {
  connect: (ctx: ExtensionContext) => Promise<BrokerClientRef>;
  disconnect: (
    ctx: ExtensionContext,
    options?: { releaseIdentity?: boolean },
  ) => Promise<{ unregisterError: string | null }>;
  syncDesiredStatus: (
    desiredStatus: "working" | "idle",
    options?: { force?: boolean },
  ) => Promise<void>;
  flushDeliveredAcks: () => Promise<void>;
  getClientRef: () => BrokerClientRef | null;
}

function getInboxIds(entries: Array<{ inboxId?: number }>): number[] {
  return entries.flatMap((entry) => (typeof entry.inboxId === "number" ? [entry.inboxId] : []));
}

function mergeFollowerThreadUpdates(
  threads: Map<string, SharedFollowerThreadState>,
  updates: FollowerThreadState[],
): void {
  for (const nextThread of updates) {
    const existing = threads.get(nextThread.threadTs);
    if (!existing) {
      threads.set(nextThread.threadTs, { ...nextThread });
      continue;
    }
    existing.channelId = nextThread.channelId;
    existing.threadTs = nextThread.threadTs;
    existing.userId = nextThread.userId;
    existing.owner = nextThread.owner;
    existing.source = nextThread.source ?? existing.source;
  }
}

export function createFollowerRuntime(deps: FollowerRuntimeDeps): FollowerRuntime {
  let clientRef: BrokerClientRef | null = null;
  let followerPollRunning = false;
  let wasDisconnected = false;
  let followerAckPromise: Promise<void> | null = null;
  let syncedFollowerStatus: "working" | "idle" | null = null;
  let followerStatusSyncPromise: Promise<void> | null = null;
  let followerStatusSyncTarget: "working" | "idle" | null = null;

  async function flushDeliveredAcks(): Promise<void> {
    if (followerAckPromise) {
      await followerAckPromise;
      return;
    }
    if (!clientRef?.client) {
      return;
    }

    const client = clientRef.client;
    const promise = drainFollowerAckBatches(deps.deliveryState, async (ids) => {
      await client.ackMessages(ids);
    }).finally(() => {
      if (followerAckPromise === promise) {
        followerAckPromise = null;
      }
    });

    followerAckPromise = promise;
    await promise;
  }

  async function syncDesiredStatus(
    desiredStatus: "working" | "idle",
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (!clientRef) {
      return;
    }
    if (!options.force && syncedFollowerStatus === desiredStatus) {
      return;
    }
    if (followerStatusSyncPromise && followerStatusSyncTarget === desiredStatus) {
      await followerStatusSyncPromise;
      return;
    }

    const targetStatus = desiredStatus;
    const request = clientRef.client.updateStatus(targetStatus).then(() => {
      syncedFollowerStatus = targetStatus;
    });
    followerStatusSyncTarget = targetStatus;
    const inFlight = request.finally(() => {
      if (followerStatusSyncPromise === inFlight) {
        followerStatusSyncPromise = null;
        followerStatusSyncTarget = null;
      }
    });
    followerStatusSyncPromise = inFlight;
    await inFlight;
  }

  function stopPolling(): void {
    if (clientRef?.pollInterval) {
      clearInterval(clientRef.pollInterval);
      clientRef.pollInterval = null;
    }
    followerPollRunning = false;
  }

  function resetFollowerRuntimeState(): void {
    clientRef = null;
    followerPollRunning = false;
    wasDisconnected = false;
    followerAckPromise = null;
    syncedFollowerStatus = null;
    followerStatusSyncPromise = null;
    followerStatusSyncTarget = null;
    resetFollowerDeliveryState(deps.deliveryState);
  }

  async function connect(ctx: ExtensionContext): Promise<BrokerClientRef> {
    deps.refreshSettings();
    const meshAuth = resolvePinetMeshAuth(deps.getSettings());
    const client = new BrokerClient({
      path: resolveBrokerSocketPath(),
      ...(meshAuth.meshSecret ? { meshSecret: meshAuth.meshSecret } : {}),
      ...(meshAuth.meshSecretPath ? { meshSecretPath: meshAuth.meshSecretPath } : {}),
    });

    async function registerFollowerRuntime(): Promise<void> {
      deps.refreshSettings();
      const settings = deps.getSettings();
      const { name, emoji } = deps.getAgentIdentity();
      const workerIdentity = resolveRuntimeAgentIdentity(
        { name, emoji },
        settings,
        process.env.PI_NICKNAME,
        ctx.sessionManager.getSessionFile() ?? deps.getAgentStableId(),
        "worker",
      );
      const hasExplicitIdentityRequest =
        Boolean(settings.agentName?.trim() && settings.agentEmoji?.trim()) ||
        Boolean(process.env.PI_NICKNAME?.trim());

      deps.setAgentOwnerToken(buildPinetOwnerToken(deps.getAgentStableId()));
      const registration = await client.register(
        hasExplicitIdentityRequest ? workerIdentity.name : "",
        hasExplicitIdentityRequest ? workerIdentity.emoji : "",
        await deps.getAgentMetadata("worker"),
        deps.getAgentStableId(),
      );
      await deps.applyRegistrationIdentity(registration);
      client.setHeartbeatMetadataProvider(() => deps.getAgentMetadata("worker"));
    }

    async function resumeThreadClaims(): Promise<void> {
      for (const thread of getFollowerOwnedThreadReclaims(
        deps.getThreads(),
        deps.getAgentIdentity().name,
        deps.getAgentAliases(),
        deps.getAgentOwnerToken(),
      )) {
        try {
          await client.claimThread(thread.threadTs, thread.channelId, thread.source);
        } catch {
          break;
        }
      }
    }

    function startPolling(): void {
      if (!clientRef || clientRef.pollInterval) {
        return;
      }

      clientRef.pollInterval = setInterval(async () => {
        if (!deps.getPinetEnabled() || followerPollRunning || clientRef?.client !== client) {
          return;
        }

        followerPollRunning = true;
        try {
          const entries = await client.pollInbox();
          if (deps.getRuntimeDiagnostic()?.kind === "poll_failure") {
            deps.setRuntimeDiagnostic(null);
          }
          const newEntries = entries.filter(
            (entry) => !isFollowerInboxIdTracked(deps.deliveryState, entry.inboxId),
          );
          if (newEntries.length === 0) {
            if (hasDeliveredFollowerInboxIds(deps.deliveryState)) {
              void flushDeliveredAcks();
            }
            return;
          }

          const controlEntries: Array<{ inboxId: number; command: PinetControlCommand }> = [];
          const remainingEntries: typeof newEntries = [];
          for (const entry of newEntries) {
            const command = extractPinetControlCommand({
              threadId: entry.message.threadId,
              body: entry.message.body,
              metadata: entry.message.metadata,
            });
            if (command) {
              controlEntries.push({ inboxId: entry.inboxId, command });
              continue;
            }

            remainingEntries.push(entry);
          }

          if (controlEntries.length > 0) {
            const immediateAckIds: number[] = [];
            const commandsToStart: PinetControlCommand[] = [];
            for (const entry of controlEntries) {
              const queued = deps.requestRemoteControl(entry.command, ctx);
              if (queued.ackDisposition === "immediate") {
                immediateAckIds.push(entry.inboxId);
              } else {
                deps.deferControlAck(queued.scheduledCommand, entry.inboxId);
              }
              if (queued.shouldStartNow) {
                commandsToStart.push(entry.command);
              }
            }
            if (immediateAckIds.length > 0) {
              await client.ackMessages(immediateAckIds);
            }
            for (const command of commandsToStart) {
              deps.runRemoteControl(command, ctx);
            }
            return;
          }

          const steeringEntries: PinetSteeringInboxEntry[] = [];
          const queuedEntries: typeof remainingEntries = [];
          for (const entry of remainingEntries) {
            const steering = extractPinetSteeringInboxEntry(entry);
            if (steering) {
              steeringEntries.push(steering);
              continue;
            }
            queuedEntries.push(entry);
          }

          if (steeringEntries.length > 0) {
            const deliveredSteeringIds: number[] = [];
            for (const entry of steeringEntries) {
              if (deps.deliverSteeringMessage(formatPinetSteeringMessage(entry), ctx)) {
                deliveredSteeringIds.push(entry.inboxId);
              }
            }
            if (deliveredSteeringIds.length > 0) {
              markFollowerInboxIdsDelivered(deps.deliveryState, deliveredSteeringIds);
              void flushDeliveredAcks();
            }
          }

          const { nudges, agentMessages, regular } = partitionFollowerInboxEntries(queuedEntries);

          if (nudges.length > 0) {
            const nudgeText = nudges
              .map((nudge) => nudge.message.body ?? "")
              .filter(Boolean)
              .join("\n");
            if (nudgeText && deps.deliverFollowUpMessage(nudgeText)) {
              markFollowerInboxIdsDelivered(deps.deliveryState, getInboxIds(nudges));
              void flushDeliveredAcks();
            }
          }

          if (agentMessages.length > 0) {
            const transferredThreads = syncTransferredSlackThreadContexts(
              agentMessages,
              deps.getThreads(),
              deps.getAgentOwnerToken(),
            );
            if (transferredThreads.threadUpdates.length > 0) {
              mergeFollowerThreadUpdates(deps.getThreads(), transferredThreads.threadUpdates);
              if (transferredThreads.changed) {
                deps.persistState();
              }
            }

            const pinetPrompt = formatPinetInboxMessages(agentMessages);
            if (deps.deliverFollowUpMessage(pinetPrompt)) {
              markFollowerInboxIdsDelivered(deps.deliveryState, getInboxIds(agentMessages));
              void flushDeliveredAcks();
            }
          }

          if (regular.length > 0) {
            const synced = syncFollowerInboxEntries(
              regular,
              deps.getThreads(),
              deps.getAgentOwnerToken(),
              deps.getLastDmChannel(),
            );
            mergeFollowerThreadUpdates(deps.getThreads(), synced.threadUpdates);
            deps.setLastDmChannel(synced.lastDmChannel);
            deps.pushInboxMessages(synced.inboxMessages);
            queueFollowerInboxIds(deps.deliveryState, getInboxIds(regular));
            if (synced.changed) {
              deps.persistState();
            }
            deps.updateBadge();
            deps.maybeDrainInboxIfIdle(ctx);
          }
        } catch (error) {
          deps.setRuntimeDiagnostic(
            buildFollowerRuntimeDiagnostic("poll_failure", {
              detail: deps.formatError(error),
              connected: client.isConnected(),
            }),
          );
        } finally {
          void syncDesiredStatus(deps.getDesiredAgentStatus()).catch(() => {
            /* best effort */
          });
          followerPollRunning = false;
        }
      }, 2000);
    }

    try {
      await client.connect();
      await registerFollowerRuntime();
      deps.setRuntimeDiagnostic(null);

      syncedFollowerStatus = "idle";
      clientRef = {
        client,
        pollInterval: null,
      };
      followerAckPromise = null;
      wasDisconnected = false;
      followerPollRunning = false;
      resetFollowerDeliveryState(deps.deliveryState);

      client.onDisconnect(() => {
        if (clientRef?.client !== client) {
          return;
        }
        stopPolling();
        deps.setRuntimeDiagnostic(buildFollowerRuntimeDiagnostic("broker_disconnect"));
        deps.setExtStatus(ctx, "reconnecting");
        const uiUpdate = getFollowerReconnectUiUpdate("disconnect", wasDisconnected);
        wasDisconnected = uiUpdate.nextWasDisconnected;
        if (uiUpdate.notify) {
          ctx.ui.notify(uiUpdate.notify.message, uiUpdate.notify.level);
        }
      });

      client.onReconnect(() => {
        void (async () => {
          if (clientRef?.client !== client) {
            return;
          }
          try {
            await registerFollowerRuntime();
            deps.setRuntimeDiagnostic(null);
          } catch (error) {
            console.error(
              `[slack-bridge] follower reconnect registration refresh failed: ${deps.formatError(error)}`,
            );
            deps.setRuntimeDiagnostic(
              buildFollowerRuntimeDiagnostic("registration_refresh_failure", {
                detail: deps.formatError(error),
              }),
            );
            const registration = client.getRegisteredIdentity();
            if (registration) {
              await deps.applyRegistrationIdentity(registration);
            }
          }
          await resumeThreadClaims();
          syncedFollowerStatus = "idle";
          void syncDesiredStatus(deps.getDesiredAgentStatus()).catch(() => {
            /* best effort */
          });
          startPolling();
          if (hasDeliveredFollowerInboxIds(deps.deliveryState)) {
            void flushDeliveredAcks();
          }
          deps.setExtStatus(ctx, "ok");
          const uiUpdate = getFollowerReconnectUiUpdate("reconnect", wasDisconnected);
          wasDisconnected = uiUpdate.nextWasDisconnected;
          if (uiUpdate.notify) {
            ctx.ui.notify(uiUpdate.notify.message, uiUpdate.notify.level);
          }
        })();
      });

      client.onReconnectFailed((error) => {
        if (clientRef?.client !== client) {
          return;
        }
        const reconnectError = error instanceof Error ? error : new Error(String(error));
        deps.setRuntimeDiagnostic(
          buildFollowerRuntimeDiagnostic("reconnect_stopped", {
            detail: deps.formatError(reconnectError),
          }),
        );
        void deps.handleTerminalReconnectFailure(ctx, reconnectError);
      });

      await resumeThreadClaims();
      startPolling();
      return clientRef;
    } catch (error) {
      await client.unregister().catch(() => {
        /* best effort */
      });
      client.disconnect();
      resetFollowerRuntimeState();
      throw error;
    }
  }

  async function disconnect(
    _ctx: ExtensionContext,
    options: { releaseIdentity?: boolean } = {},
  ): Promise<{ unregisterError: string | null }> {
    const current = clientRef;
    stopPolling();

    await flushDeliveredAcks().catch(() => {
      /* best effort */
    });

    let unregisterError: string | null = null;
    if (current) {
      if (options.releaseIdentity === false) {
        try {
          current.client.disconnect();
        } catch {
          /* best effort */
        }
      } else {
        try {
          await current.client.disconnectGracefully();
        } catch (error) {
          unregisterError = deps.formatError(error);
        }
      }
    }

    resetFollowerRuntimeState();
    return { unregisterError };
  }

  return {
    connect,
    disconnect,
    syncDesiredStatus,
    flushDeliveredAcks,
    getClientRef: () => clientRef,
  };
}
