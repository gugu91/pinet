import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentOwnsThread, type InboxMessage, normalizeOwnedThreads } from "./helpers.js";
import {
  buildReactionTriggerMessage,
  normalizeReactionName,
  type ReactionCommandTemplate,
} from "./reaction-triggers.js";
import type { SlackInteractiveInboxEvent } from "./slack-block-kit.js";
import type { SlackToolsThreadContextPort } from "./slack-tools.js";
import {
  buildSlackThreadRuntimeScope,
  classifyMessage,
  resolveSlackThreadOwnerHint,
  SlackSocketModeClient,
  type ParsedAppHomeOpened,
  type ParsedThreadContextChanged,
  type ParsedThreadStarted,
  type SlackAccessSet,
  type SlackCall,
} from "./slack-access.js";
import { isAbortError } from "./helpers.js";

export interface SinglePlayerThreadState {
  channelId: string;
  threadTs: string;
  userId: string;
  source?: string;
  context?: ParsedThreadStarted["context"];
  owner?: string;
}

export interface SinglePlayerPendingAttention {
  channel: string;
  messageTs: string;
}

export type SinglePlayerThreadInfo = SinglePlayerThreadState;
export type SinglePlayerPendingAttentionEntry = SinglePlayerPendingAttention;

export interface SinglePlayerUnclaimedThreads {
  has: (threadTs: string) => boolean;
  add: (threadTs: string) => void;
  delete: (threadTs: string) => void;
}

export interface SinglePlayerRuntimeDeps {
  slack: SlackCall;
  getBotToken: () => string;
  getAppToken: () => string;
  dedup: SlackAccessSet<string>;
  abortSlackRequests: () => Promise<void>;
  isSingleRuntimeActive: () => boolean;
  setExtStatus: (ctx: ExtensionContext, state: "ok" | "reconnecting" | "error" | "off") => void;
  formatError: (error: unknown) => string;
  getAgentName: () => string;
  getAgentAliases: () => Iterable<string>;
  getAgentOwnerToken: () => string;
  getBotUserId: () => string | null;
  getThreads: () => Map<string, SinglePlayerThreadState>;
  getPendingEyes: () => Map<string, SinglePlayerPendingAttention[]>;
  getUnclaimedThreads: () => SinglePlayerUnclaimedThreads;
  pushInboxMessage: (message: InboxMessage) => void;
  setLastDmChannel: (channelId: string | null) => void;
  persistState: () => void;
  updateBadge: () => void;
  maybeDrainInboxIfIdle: (ctx: ExtensionContext) => boolean;
  resolveThreadChannel: (threadTs: string | undefined) => Promise<string | null>;
  setSuggestedPrompts: (channelId: string, threadTs: string) => Promise<void>;
  publishCurrentPinetHomeTab: (userId: string, ctx: ExtensionContext) => Promise<void>;
  fetchSlackMessageByTs: (
    channel: string,
    messageTs: string,
  ) => Promise<Record<string, unknown> | null>;
  addReaction: (channel: string, ts: string, emoji: string) => Promise<void>;
  removeReaction: (channel: string, ts: string, emoji: string) => Promise<void>;
  resolveUser: (userId: string) => Promise<string>;
  isUserAllowed: (userId: string) => boolean;
  getReactionCommand: (reactionName: string) => ReactionCommandTemplate | undefined;
  consumeConfirmationReply: (threadTs: string, text: string) => { approved: boolean } | null;
  claimOwnedThread: (threadTs: string, channelId: string, source?: string) => void;
  beginThreadStatus?: (channelId: string, threadTs: string, status: string) => Promise<void>;
}

type SinglePlayerControlContext = ExtensionContext & {
  abort?: () => void;
};

function interruptSinglePlayerTurn(ctx: ExtensionContext): void {
  if (ctx.isIdle?.() ?? true) return;

  try {
    (ctx as SinglePlayerControlContext).abort?.();
  } catch {
    /* best effort — interrupt controls must not crash reaction handling */
  }
}

export interface SinglePlayerRuntime {
  connect: (ctx: ExtensionContext) => Promise<void>;
  disconnect: () => Promise<void>;
  getBotUserId: () => string | null;
  isConnected: () => boolean;
  isShuttingDown: () => boolean;
  resetShutdownState: () => void;
  trackOwnedThread: (threadTs: string, channelId: string, source?: string) => void;
  getThreadContextPort: () => SlackToolsThreadContextPort;
}

type SinglePlayerThreadOwnershipResult = "continue" | "skip" | "shutdown";

export function createSinglePlayerRuntime(deps: SinglePlayerRuntimeDeps): SinglePlayerRuntime {
  let slackSocket: SlackSocketModeClient | null = null;
  let shuttingDown = false;

  function getCurrentBotUserId(): string | null {
    return slackSocket?.getBotUserId() ?? deps.getBotUserId();
  }

  function getAgentState(): {
    agentName: string;
    agentAliases: Iterable<string>;
    agentOwnerToken: string;
  } {
    return {
      agentName: deps.getAgentName(),
      agentAliases: deps.getAgentAliases(),
      agentOwnerToken: deps.getAgentOwnerToken(),
    };
  }

  function trackOwnedThread(threadTs: string, channelId: string, source = "slack"): void {
    const threads = deps.getThreads();
    const agentOwnerToken = deps.getAgentOwnerToken();
    if (!threads.has(threadTs)) {
      threads.set(threadTs, {
        channelId,
        threadTs,
        userId: "",
        source,
        owner: agentOwnerToken,
      });
    } else {
      const thread = threads.get(threadTs)!;
      if (!thread.owner) thread.owner = agentOwnerToken;
      if (!thread.source) {
        thread.source = source;
      }
    }
    deps.getUnclaimedThreads().delete(threadTs);
    deps.persistState();
  }

  function clearPendingAttention(threadTs: string): void {
    const pending = deps.getPendingEyes().get(threadTs);
    if (!pending) return;
    for (const entry of pending) {
      void deps.removeReaction(entry.channel, entry.messageTs, "eyes");
    }
    deps.getPendingEyes().delete(threadTs);
  }

  async function resolveThreadOwner(channel: string, threadTs: string): Promise<string | null> {
    const hint = await resolveSlackThreadOwnerHint({
      slack: deps.slack,
      token: deps.getBotToken(),
      channel,
      threadTs,
      limit: 50,
    });
    return hint?.agentOwner ?? hint?.agentName ?? null;
  }

  async function ensureLocalThreadOwnership(
    channel: string,
    threadTs: string,
  ): Promise<SinglePlayerThreadOwnershipResult> {
    const threads = deps.getThreads();
    const { agentName, agentAliases, agentOwnerToken } = getAgentState();
    const localOwner = threads.get(threadTs)?.owner;
    if (localOwner && !agentOwnsThread(localOwner, agentName, agentAliases, agentOwnerToken)) {
      return "skip";
    }
    if (localOwner) {
      const thread = threads.get(threadTs);
      if (thread) {
        normalizeOwnedThreads([thread], agentName, agentOwnerToken, agentAliases);
      }
      return "continue";
    }

    const unclaimedThreads = deps.getUnclaimedThreads();
    if (unclaimedThreads.has(threadTs)) {
      return "continue";
    }

    const remoteOwner = await resolveThreadOwner(channel, threadTs);
    if (shuttingDown) {
      return "shutdown";
    }

    const thread = threads.get(threadTs);
    if (remoteOwner && !agentOwnsThread(remoteOwner, agentName, agentAliases, agentOwnerToken)) {
      if (thread) thread.owner = remoteOwner;
      return "skip";
    }
    if (agentOwnsThread(remoteOwner ?? undefined, agentName, agentAliases, agentOwnerToken)) {
      if (thread) thread.owner = agentOwnerToken;
    }
    if (!remoteOwner) {
      unclaimedThreads.add(threadTs);
    }
    return "continue";
  }

  async function onThreadStarted(event: ParsedThreadStarted): Promise<void> {
    if (shuttingDown) return;

    const info: SinglePlayerThreadState = {
      channelId: event.channelId,
      threadTs: event.threadTs,
      userId: event.userId,
      source: "slack",
    };

    if (event.context) {
      info.context = event.context;
    }

    deps.getThreads().set(info.threadTs, info);
    deps.setLastDmChannel(info.channelId);
    deps.persistState();

    await deps.setSuggestedPrompts(info.channelId, info.threadTs);
  }

  function onContextChanged(event: ParsedThreadContextChanged): void {
    if (shuttingDown) return;

    const existing = deps.getThreads().get(event.threadTs);
    if (!existing || !event.context) return;

    existing.context = event.context;
    deps.persistState();
  }

  async function onAppHomeOpened(event: ParsedAppHomeOpened, ctx: ExtensionContext): Promise<void> {
    if (shuttingDown) return;

    await deps.publishCurrentPinetHomeTab(event.userId, ctx);
  }

  async function onReactionAdded(
    evt: Record<string, unknown>,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (shuttingDown) return;

    const item = evt.item as { type?: string; channel?: string; ts?: string } | undefined;
    const user = evt.user as string | undefined;
    const rawReactionName = evt.reaction as string | undefined;
    if (
      !item ||
      item.type !== "message" ||
      !item.channel ||
      !item.ts ||
      !user ||
      !rawReactionName
    ) {
      return;
    }

    if (user === getCurrentBotUserId()) {
      return;
    }

    let reactionName: string;
    try {
      reactionName = normalizeReactionName(rawReactionName);
    } catch {
      return;
    }

    const command = deps.getReactionCommand(reactionName);
    if (!command || !deps.isUserAllowed(user)) {
      return;
    }

    try {
      const isInterruptReaction = command.action === "interrupt";
      const reactedMessage = await deps.fetchSlackMessageByTs(item.channel, item.ts);

      const threadTs =
        (reactedMessage?.thread_ts as string | undefined) ??
        (reactedMessage?.ts as string | undefined) ??
        item.ts;

      const threads = deps.getThreads();
      const threadInfo = threads.get(threadTs);
      if (!threadInfo || threadInfo.channelId !== item.channel) {
        return;
      }

      const ownership = await ensureLocalThreadOwnership(item.channel, threadTs);
      if (ownership !== "continue") {
        return;
      }

      const reactorName = isInterruptReaction
        ? await deps.resolveUser(user).catch(() => user)
        : await deps.resolveUser(user);
      if (shuttingDown) return;

      if (isInterruptReaction) {
        interruptSinglePlayerTurn(ctx);
        ctx.ui.notify(`${reactorName} requested an interrupt with :${reactionName}:`, "warning");
        await deps.addReaction(item.channel, item.ts, "white_check_mark");
        return;
      }

      const reactedMessageAuthorId =
        (reactedMessage?.user as string | undefined) ?? (evt.item_user as string | undefined);
      const reactedMessageAuthor = reactedMessageAuthorId
        ? await deps.resolveUser(reactedMessageAuthorId)
        : (reactedMessage?.bot_id as string | undefined)
          ? "bot"
          : "unknown";
      if (shuttingDown) return;

      const reactedMessageText =
        typeof reactedMessage?.text === "string" && reactedMessage.text.trim().length > 0
          ? reactedMessage.text
          : reactedMessage
            ? "(no text)"
            : "(message text unavailable; Slack did not return the reacted message, so use the channel/thread/message ids for context)";
      const reactionMessage = buildReactionTriggerMessage({
        reactionName,
        command,
        reactorName,
        channel: item.channel,
        threadTs,
        messageTs: item.ts,
        reactedMessageText,
        reactedMessageAuthor,
      });

      ctx.ui.notify(`${reactorName} reacted with :${reactionName}:`, "info");
      deps.pushInboxMessage({
        channel: item.channel,
        threadTs,
        userId: user,
        text: reactionMessage,
        timestamp: (evt.event_ts as string) ?? item.ts,
        scope: buildSlackThreadRuntimeScope({
          channelId: item.channel,
          context: threadInfo?.context,
        }),
      });
      deps.persistState();
      deps.updateBadge();
      await deps.addReaction(item.channel, item.ts, "white_check_mark");

      deps.maybeDrainInboxIfIdle(ctx);
    } catch (err) {
      console.error(`[slack-bridge] reaction trigger failed: ${deps.formatError(err)}`);
      await deps.addReaction(item.channel, item.ts, "x");
    }
  }

  async function onMessage(evt: Record<string, unknown>, ctx: ExtensionContext): Promise<void> {
    if (shuttingDown) return;

    const threads = deps.getThreads();
    const classified = classifyMessage(evt, getCurrentBotUserId(), new Set(threads.keys()));
    if (!classified.relevant) return;

    const { threadTs, channel, userId, text, isDM, isChannelMention, messageTs, metadata } =
      classified;

    if (!threads.has(threadTs)) {
      threads.set(threadTs, { channelId: channel, threadTs, userId, source: "slack" });
    }

    const ownership = await ensureLocalThreadOwnership(channel, threadTs);
    if (ownership !== "continue") {
      return;
    }

    if (!deps.isUserAllowed(userId)) {
      await deps.slack("chat.postMessage", deps.getBotToken(), {
        channel,
        thread_ts: threadTs,
        text: "Sorry, I can only respond to authorized users. Please contact an admin if you need access.",
      });
      return;
    }

    if (isDM) {
      deps.setLastDmChannel(channel);
    }
    deps.persistState();

    const confirmationResult = deps.consumeConfirmationReply(threadTs, text);
    const messageText =
      confirmationResult === null
        ? text
        : confirmationResult.approved
          ? `${text}\n\n✅ User approved security confirmation request in this thread.`
          : `${text}\n\n❌ User denied security confirmation request in this thread.`;

    const name = await deps.resolveUser(userId);
    if (shuttingDown) return;
    ctx.ui.notify(`${name}: ${text.slice(0, 100)}`, "info");

    void deps.beginThreadStatus?.(channel, threadTs, "is thinking…");
    void deps.addReaction(channel, messageTs, "eyes");
    const pending = deps.getPendingEyes().get(threadTs) ?? [];
    pending.push({ channel, messageTs });
    deps.getPendingEyes().set(threadTs, pending);

    const threadInfo = threads.get(threadTs);
    deps.pushInboxMessage({
      channel,
      threadTs,
      userId,
      text: messageText,
      timestamp: messageTs,
      scope: buildSlackThreadRuntimeScope({
        channelId: channel,
        context: threadInfo?.context,
      }),
      ...(isChannelMention && { isChannelMention: true }),
      ...(metadata ? { metadata } : {}),
    });
    deps.updateBadge();

    deps.maybeDrainInboxIfIdle(ctx);
  }

  async function queueInteractiveInboxEvent(
    normalized: {
      channel: string;
      threadTs: string;
      userId: string;
      text: string;
      timestamp: string;
      metadata: Record<string, unknown>;
    },
    ctx: ExtensionContext,
  ): Promise<void> {
    const threads = deps.getThreads();
    if (!threads.has(normalized.threadTs)) {
      threads.set(normalized.threadTs, {
        channelId: normalized.channel,
        threadTs: normalized.threadTs,
        userId: normalized.userId,
        source: "slack",
      });
    }

    const ownership = await ensureLocalThreadOwnership(normalized.channel, normalized.threadTs);
    if (ownership !== "continue") {
      return;
    }

    if (!deps.isUserAllowed(normalized.userId)) {
      await deps.slack("chat.postMessage", deps.getBotToken(), {
        channel: normalized.channel,
        thread_ts: normalized.threadTs,
        text: "Sorry, I can only respond to authorized users. Please contact an admin if you need access.",
      });
      return;
    }

    if (normalized.channel.startsWith("D")) {
      deps.setLastDmChannel(normalized.channel);
    }
    deps.persistState();

    void deps.beginThreadStatus?.(normalized.channel, normalized.threadTs, "is thinking…");

    const name = await deps.resolveUser(normalized.userId);
    if (shuttingDown) return;
    ctx.ui.notify(`${name}: ${normalized.text.slice(0, 100)}`, "info");

    const threadInfo = threads.get(normalized.threadTs);
    deps.pushInboxMessage({
      channel: normalized.channel,
      threadTs: normalized.threadTs,
      userId: normalized.userId,
      text: normalized.text,
      timestamp: normalized.timestamp,
      metadata: normalized.metadata,
      scope: buildSlackThreadRuntimeScope({
        channelId: normalized.channel,
        context: threadInfo?.context,
      }),
    });
    deps.updateBadge();

    deps.maybeDrainInboxIfIdle(ctx);
  }

  const threadContextPort: SlackToolsThreadContextPort = {
    resolveThreadChannel: (threadTs) => deps.resolveThreadChannel(threadTs),
    noteThreadReply: (threadTs, channelId) => {
      trackOwnedThread(threadTs, channelId, "slack");
      deps.claimOwnedThread(threadTs, channelId, "slack");
    },
    clearPendingAttention: (threadTs) => {
      clearPendingAttention(threadTs);
    },
  };

  return {
    async connect(ctx: ExtensionContext): Promise<void> {
      shuttingDown = false;

      const socket = new SlackSocketModeClient({
        slack: deps.slack,
        botToken: deps.getBotToken(),
        appToken: deps.getAppToken(),
        resolveBotUserIdOnConnect: false,
        dedup: deps.dedup,
        abortAndWait: deps.abortSlackRequests,
        onOpen: () => deps.setExtStatus(ctx, "ok"),
        onReconnectScheduled: () => {
          if (!shuttingDown && deps.isSingleRuntimeActive()) {
            deps.setExtStatus(ctx, "reconnecting");
          }
        },
        onError: (error) => {
          if (!isAbortError(error)) {
            console.error(`[slack-bridge] Slack access: ${deps.formatError(error)}`);
          }
        },
        onThreadStarted: (event) => onThreadStarted(event),
        onThreadContextChanged: (event) => onContextChanged(event),
        onAppHomeOpened: (event) => onAppHomeOpened(event, ctx),
        onMessage: (event) => onMessage(event, ctx),
        onReactionAdded: (event) => onReactionAdded(event, ctx),
        onMemberJoinedChannel: async ({ channel, isSelf }) => {
          if (!isSelf) return;
          ctx.ui.notify(`Pinet added to channel ${channel}`, "info");
          deps.pushInboxMessage({
            channel,
            threadTs: "",
            userId: "system",
            text: `Pinet was added to channel <#${channel}>. You can now post messages there.`,
            timestamp: String(Date.now() / 1000),
          });
          deps.updateBadge();
          deps.maybeDrainInboxIfIdle(ctx);
        },
        onInteractive: (event: SlackInteractiveInboxEvent) =>
          queueInteractiveInboxEvent(event, ctx),
      });

      slackSocket = socket;
      await socket.connect();
    },

    async disconnect(): Promise<void> {
      shuttingDown = true;
      const socket = slackSocket;
      slackSocket = null;
      if (socket) {
        await socket.disconnect();
        return;
      }
      await deps.abortSlackRequests();
    },

    getBotUserId(): string | null {
      return slackSocket?.getBotUserId() ?? null;
    },

    isConnected(): boolean {
      return slackSocket?.isConnected() ?? false;
    },

    isShuttingDown(): boolean {
      return shuttingDown;
    },

    resetShutdownState(): void {
      shuttingDown = false;
    },

    trackOwnedThread(threadTs: string, channelId: string, source = "slack"): void {
      trackOwnedThread(threadTs, channelId, source);
    },

    getThreadContextPort(): SlackToolsThreadContextPort {
      return threadContextPort;
    },
  };
}
