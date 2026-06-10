import os from "node:os";

import {
  addSlackReaction,
  buildSlackThreadRuntimeScope,
  classifyMessage,
  extractAppHomeOpened,
  extractThreadContextChanged,
  extractThreadStarted,
  fetchSlackMessageByTs,
  isSlackUserAllowed,
  removeSlackReaction,
  resolveSlackUserName,
  setSlackSuggestedPrompts,
  SlackSocketModeClient,
  type ParsedAppHomeOpened,
  type ParsedThreadContextChanged,
  type ParsedThreadStarted,
} from "../../slack-access.js";
import {
  createAbortableOperationTracker,
  callSlackAPI,
  isAbortError,
  buildAllowlist,
  buildPinetControlMessage,
  buildPinetControlMetadata,
} from "../../helpers.js";
import {
  buildReactionTriggerMessage,
  normalizeReactionName,
  resolveReactionCommands,
  type ReactionCommandSettings,
} from "../../reaction-triggers.js";
import { TtlCache, TtlSet } from "../../ttl-cache.js";
import {
  SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE,
  SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS,
} from "../../slack-access.js";
import {
  DEFAULT_SLACK_THREAD_STATUS,
  SlackThreadStatusManager,
} from "../../slack-thread-status.js";
import { performSlackUploads, prepareSlackUpload } from "../../slack-upload.js";
import type {
  AdapterCapabilityRequest,
  AdapterCapabilityResult,
  InboundMessage,
  OutboundMessage,
  MessageAdapter,
} from "./types.js";

export {
  classifyMessage,
  extractAppHomeOpened,
  extractThreadStarted,
  parseMemberJoinedChannel,
  parseSocketFrame,
  RECONNECT_DELAY_MS,
} from "../../slack-access.js";

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
  allowedUsers?: string[];
  allowAllWorkspaceUsers?: boolean;
  suggestedPrompts?: { title: string; message: string }[];
  reactionCommands?: ReactionCommandSettings;
  /** Check whether a thread_ts belongs to a known thread in the broker DB. */
  isKnownThread?: (threadTs: string) => boolean;
  /** Load durable thread metadata from the broker DB after cache eviction. */
  getKnownThread?: (threadTs: string) => {
    channelId: string;
    context?: ParsedThreadStarted["context"] | null;
  } | null;
  /** Persist thread metadata in the broker DB without claiming ownership. */
  rememberKnownThread?: (
    threadTs: string,
    channelId: string,
    context?: ParsedThreadStarted["context"] | null,
  ) => void;
  /**
   * Gate reaction-trigger handling after the reacted message thread is known.
   * Use this to require an already authorized/Pinet-owned thread before an
   * opt-in reaction command can enqueue work or mutate durable thread state.
   *
   * Reaction triggers are denied by default: when this callback is not
   * configured, opt-in reaction commands never route, even for threads the
   * adapter has merely seen/cached. Authorization must be explicit so that
   * reactions pass the same invoked/owned-thread admission bar as normal
   * Slack messages (#812).
   */
  isReactionThreadAuthorized?: (threadTs: string, channelId: string) => boolean;
  /** Best-effort callback for Home tab opens. */
  onAppHomeOpened?: (event: ParsedAppHomeOpened) => Promise<void> | void;
}

interface SlackThreadInfo {
  channelId: string;
  threadTs: string;
  userId: string;
  context?: ParsedThreadStarted["context"];
}

export const SLACK_THREAD_CACHE_MAX_SIZE = 5000;
export const SLACK_THREAD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const SLACK_PENDING_ATTENTION_MAX_THREADS = 1000;
export const SLACK_PENDING_ATTENTION_TTL_MS = 2 * 60 * 60 * 1000;
export const SLACK_PENDING_ATTENTION_MAX_MESSAGES_PER_THREAD = 50;

export class SlackAdapter implements MessageAdapter {
  readonly name = "slack";

  private readonly config: SlackAdapterConfig;
  private readonly allowlist: Set<string> | null;
  private slackRequests = createAbortableOperationTracker();
  private botUserId: string | null = null;
  private socketMode: SlackSocketModeClient | null = null;
  private shuttingDown = false;
  private inboundHandler: ((msg: InboundMessage) => void) | null = null;
  private readonly reactionCommands: Map<string, { action: string; prompt: string }>;

  private readonly threads: TtlCache<string, SlackThreadInfo>;
  private readonly userNames = new TtlCache<string, string>({
    maxSize: 2000,
    ttlMs: 60 * 60 * 1000,
  });
  private readonly processedSocketDeliveries = new TtlSet<string>({
    maxSize: SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE,
    ttlMs: SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS,
  });
  private readonly pendingEyes: TtlCache<string, { channel: string; messageTs: string }[]>;
  private readonly threadStatuses: SlackThreadStatusManager;

  constructor(config: SlackAdapterConfig) {
    this.config = config;
    this.threads = new TtlCache<string, SlackThreadInfo>({
      maxSize: SLACK_THREAD_CACHE_MAX_SIZE,
      ttlMs: SLACK_THREAD_CACHE_TTL_MS,
    });
    this.pendingEyes = new TtlCache<string, { channel: string; messageTs: string }[]>({
      maxSize: SLACK_PENDING_ATTENTION_MAX_THREADS,
      ttlMs: SLACK_PENDING_ATTENTION_TTL_MS,
    });
    this.threadStatuses = new SlackThreadStatusManager({
      slack: this.callSlack.bind(this),
      getBotToken: () => this.config.botToken,
      formatError: errorMsg,
      logger: console,
    });
    this.allowlist = buildAllowlist(
      {
        allowedUsers: config.allowedUsers,
        allowAllWorkspaceUsers: config.allowAllWorkspaceUsers,
      },
      undefined,
      undefined,
    );
    this.reactionCommands = resolveReactionCommands(config.reactionCommands);
  }

  private async callSlack(method: string, token: string, body?: Record<string, unknown>) {
    return this.slackRequests.run((signal) => callSlackAPI(method, token, body, { signal }));
  }

  async connect(): Promise<void> {
    this.shuttingDown = false;
    this.slackRequests = createAbortableOperationTracker();
    this.socketMode = new SlackSocketModeClient({
      slack: this.callSlack.bind(this),
      botToken: this.config.botToken,
      appToken: this.config.appToken,
      dedup: this.processedSocketDeliveries,
      abortAndWait: () => this.slackRequests.abortAndWait(),
      onThreadStarted: (event) => this.onThreadStarted(event),
      onThreadContextChanged: (event) => this.onContextChanged(event),
      onMessage: (event) => this.onMessage(event),
      onReactionAdded: (event) => this.onReactionAdded(event),
      onMemberJoinedChannel: (event) => this.onMemberJoined(event),
      onAppHomeOpened: (event) => this.onAppHomeOpened(event),
      onInteractive: (event) => this.emitInteractiveInbound(event),
      onError: (error) => {
        if (!isAbortError(error)) {
          console.error(`[slack-adapter] Socket Mode: ${errorMsg(error)}`);
        }
      },
    });
    await this.socketMode.connect();
    this.botUserId = this.socketMode.getBotUserId();
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    await this.threadStatuses.clearAll();
    const socketMode = this.socketMode;
    this.socketMode = null;
    if (socketMode) {
      await socketMode.disconnect();
      return;
    }
    await this.slackRequests.abortAndWait();
  }

  onInbound(handler: (msg: InboundMessage) => void): void {
    this.inboundHandler = handler;
  }

  async invokeCapability(request: AdapterCapabilityRequest): Promise<AdapterCapabilityResult> {
    if (request.capability !== "api.call") {
      throw new Error(`Unsupported Slack adapter capability: ${request.capability}`);
    }

    const method = typeof request.params.method === "string" ? request.params.method.trim() : "";
    if (!method) {
      throw new Error("method is required for Slack api.call capability");
    }

    const body =
      request.params.params &&
      typeof request.params.params === "object" &&
      !Array.isArray(request.params.params)
        ? (request.params.params as Record<string, unknown>)
        : {};
    const result = await this.callSlack(method, this.config.botToken, body);
    return {
      result,
      ...this.buildSlackApiCapabilityEffects(method, body, result),
    };
  }

  async send(msg: OutboundMessage): Promise<void> {
    const contentSlackBlocks = msg.content?.slackBlocks;
    const slackBlocks =
      contentSlackBlocks && contentSlackBlocks.length > 0
        ? contentSlackBlocks
        : msg.blocks && msg.blocks.length > 0
          ? msg.blocks
          : undefined;
    const body: Record<string, unknown> = {
      channel: msg.channel,
      text: msg.content?.text ?? msg.text,
      thread_ts: msg.threadId,
      ...(slackBlocks ? { blocks: slackBlocks } : {}),
    };
    const scope = msg.scope ?? this.resolveScopeForThread(msg.threadId, msg.channel);

    if (msg.agentName ?? msg.agentOwnerToken ?? msg.metadata ?? msg.scope) {
      body.metadata = {
        event_type: "pi_agent_msg",
        event_payload: {
          ...(msg.agentName ? { agent: msg.agentName } : {}),
          ...(msg.agentOwnerToken ? { agent_owner: msg.agentOwnerToken } : {}),
          ...(msg.agentEmoji ? { emoji: msg.agentEmoji } : {}),
          ...(scope ? { scope } : {}),
          ...msg.metadata,
        },
      };
    }

    if (msg.files && msg.files.length > 0) {
      if (slackBlocks && slackBlocks.length > 0) {
        throw new Error(
          "Slack text+file replies use Slack's external upload flow, which does not support Block Kit blocks in the same upload message. Omit blocks or send a separate block-only message.",
        );
      }
      const uploads = await Promise.all(
        msg.files.map((file) =>
          prepareSlackUpload(
            {
              path: file.path,
              ...(file.filename ? { filename: file.filename } : {}),
              ...(file.title ? { title: file.title } : {}),
              ...(file.filetype ? { filetype: file.filetype } : {}),
            },
            process.cwd(),
            os.tmpdir(),
          ),
        ),
      );
      await performSlackUploads({
        uploads,
        channelId: msg.channel,
        threadTs: msg.threadId,
        initialComment: msg.content?.text ?? msg.text,
        slack: this.callSlack.bind(this),
        token: this.config.botToken,
      });
    } else {
      await this.callSlack("chat.postMessage", this.config.botToken, body);
    }
    if (this.shuttingDown) return;

    const pending = this.pendingEyes.get(msg.threadId);
    if (pending) {
      for (const entry of pending) {
        void this.removeReaction(entry.channel, entry.messageTs, "eyes");
      }
      this.pendingEyes.delete(msg.threadId);
    }

    void this.clearThreadStatus(msg.channel, msg.threadId);
  }

  private buildSlackApiCapabilityEffects(
    method: string,
    body: Record<string, unknown>,
    result: Record<string, unknown>,
  ): Pick<AdapterCapabilityResult, "effects"> {
    if (method !== "chat.postMessage") {
      return {};
    }

    const threadTs = typeof body.thread_ts === "string" ? body.thread_ts : "";
    const messageTs = typeof result.ts === "string" ? result.ts : "";
    const channel =
      typeof body.channel === "string"
        ? body.channel
        : typeof result.channel === "string"
          ? result.channel
          : undefined;
    const threadId = threadTs || messageTs;
    if (!threadId) {
      return {};
    }

    return {
      effects: {
        claimThread: {
          threadId,
          ...(channel ? { channel } : {}),
        },
      },
    };
  }

  getBotUserId(): string | null {
    return this.socketMode?.getBotUserId() ?? this.botUserId;
  }

  getTrackedThreadIds(): Set<string> {
    this.threads.sweep();
    return new Set([...this.threads.entries()].map(([threadTs]) => threadTs));
  }

  isConnected(): boolean {
    return this.socketMode?.isConnected() ?? false;
  }

  private resolveScopeForThread(threadTs: string, channelId: string) {
    return buildSlackThreadRuntimeScope({
      channelId,
      context: this.getThread(threadTs)?.context ?? null,
    });
  }

  private async onThreadStarted(
    event: ParsedThreadStarted | Record<string, unknown>,
  ): Promise<void> {
    if (this.shuttingDown) return;

    const parsed = isParsedThreadStarted(event) ? event : extractThreadStarted(event);
    if (!parsed) return;

    const info: SlackThreadInfo = {
      channelId: parsed.channelId,
      threadTs: parsed.threadTs,
      userId: parsed.userId,
    };

    if (parsed.context) {
      info.context = parsed.context;
    }

    this.threads.set(info.threadTs, info);
    try {
      this.config.rememberKnownThread?.(info.threadTs, info.channelId, info.context ?? null);
    } catch {
      /* best effort — DB cache sync must not break Slack event handling */
    }
    await this.setSuggestedPrompts(info.channelId, info.threadTs);
  }

  private onContextChanged(event: ParsedThreadContextChanged | Record<string, unknown>): void {
    if (this.shuttingDown) return;

    const parsed = isParsedThreadContextChanged(event) ? event : extractThreadContextChanged(event);
    if (!parsed) return;

    const existing = this.getThread(parsed.threadTs);
    if (!existing || !parsed.context) return;

    existing.context = parsed.context;
    this.threads.set(parsed.threadTs, existing);
    try {
      this.config.rememberKnownThread?.(parsed.threadTs, existing.channelId, existing.context);
    } catch {
      /* best effort — DB cache sync must not break Slack event handling */
    }
  }

  private async onAppHomeOpened(
    event: ParsedAppHomeOpened | Record<string, unknown>,
  ): Promise<void> {
    if (this.shuttingDown) return;

    const parsed = isParsedAppHomeOpened(event) ? event : extractAppHomeOpened(event);
    if (!parsed || parsed.tab !== "home") {
      return;
    }

    try {
      await this.config.onAppHomeOpened?.(parsed);
    } catch (error) {
      console.error(`[slack-adapter] Home tab callback failed: ${errorMsg(error)}`);
    }
  }

  private async fetchMessageByTs(
    channel: string,
    messageTs: string,
  ): Promise<Record<string, unknown> | null> {
    return fetchSlackMessageByTs({
      slack: this.callSlack.bind(this),
      token: this.config.botToken,
      channel,
      messageTs,
    });
  }

  private async onReactionAdded(evt: Record<string, unknown>): Promise<void> {
    if (this.shuttingDown) return;

    const item = evt.item as { type?: string; channel?: string; ts?: string } | undefined;
    const userId = evt.user as string | undefined;
    const rawReaction = evt.reaction as string | undefined;
    if (!item || item.type !== "message" || !item.channel || !item.ts || !userId || !rawReaction) {
      return;
    }

    if (userId === this.botUserId) return;

    let reactionName: string;
    try {
      reactionName = normalizeReactionName(rawReaction);
    } catch {
      return;
    }

    const command = this.reactionCommands.get(reactionName);
    if (!command || !isSlackUserAllowed(this.allowlist, userId)) {
      return;
    }

    try {
      const isInterruptReaction = command.action === "interrupt";
      const reactedMessage = await this.fetchMessageByTs(item.channel, item.ts);
      const reactedMessageFetchStatus = reactedMessage ? "found" : "unavailable";

      const threadTs =
        (reactedMessage?.thread_ts as string | undefined) ??
        (reactedMessage?.ts as string | undefined) ??
        item.ts;

      const cachedThread = this.getCachedThread(threadTs);
      if (!this.isReactionThreadAuthorized(threadTs, item.channel, cachedThread)) {
        return;
      }

      const existingThread = cachedThread ?? this.getThread(threadTs);
      if (!existingThread || existingThread.channelId !== item.channel) {
        return;
      }

      const reactorName = isInterruptReaction
        ? await this.resolveUser(userId).catch(() => userId)
        : await this.resolveUser(userId);
      if (this.shuttingDown) return;
      const reactedMessageAuthorId =
        (reactedMessage?.user as string | undefined) ?? (evt.item_user as string | undefined);
      const reactedMessageAuthor = isInterruptReaction
        ? (reactedMessageAuthorId ??
          ((reactedMessage?.bot_id as string | undefined) ? "bot" : "unknown"))
        : reactedMessageAuthorId
          ? await this.resolveUser(reactedMessageAuthorId)
          : (reactedMessage?.bot_id as string | undefined)
            ? "bot"
            : "unknown";
      if (this.shuttingDown) return;

      const reactedMessageText = isInterruptReaction
        ? "(interrupt control; reacted message text omitted)"
        : typeof reactedMessage?.text === "string" && reactedMessage.text.trim().length > 0
          ? reactedMessage.text
          : reactedMessage
            ? "(no text)"
            : "(message text unavailable; Slack did not return the reacted message, so use the channel/thread/message ids for context)";

      const reactionEventTs = (evt.event_ts as string | undefined) ?? item.ts;
      this.inboundHandler?.({
        source: "slack",
        threadId: threadTs,
        channel: item.channel,
        userId,
        userName: reactorName,
        text: isInterruptReaction
          ? buildPinetControlMessage("interrupt")
          : buildReactionTriggerMessage({
              reactionName,
              command,
              reactorName,
              channel: item.channel,
              threadTs,
              messageTs: item.ts,
              reactedMessageText,
              reactedMessageAuthor,
            }),
        timestamp: reactionEventTs,
        metadata: {
          reactionTrigger: true,
          reactionName,
          reactionAction: command.action,
          ...(isInterruptReaction
            ? {
                ...buildPinetControlMetadata("interrupt"),
                kind: "pinet_control",
                command: "interrupt",
                slackReactionControl: true,
              }
            : {}),
          reactorUserId: userId,
          reactorName,
          reactionEventTs,
          referencedSource: "slack",
          referencedChannel: item.channel,
          referencedThreadTs: threadTs,
          referencedMessageTs: item.ts,
          referencedExternalId: `${item.channel}:${item.ts}`,
          reactedMessageFetchStatus,
          reactedMessageAuthor,
          ...(reactedMessageAuthorId ? { reactedMessageAuthorId } : {}),
        },
        scope: buildSlackThreadRuntimeScope({
          channelId: item.channel,
          context: existingThread.context,
        }),
      });

      await this.addReaction(item.channel, item.ts, "white_check_mark");
    } catch (error) {
      console.error(`[slack-adapter] reaction trigger failed: ${errorMsg(error)}`);
      await this.addReaction(item.channel, item.ts, "x");
    }
  }

  private getCachedThread(threadTs: string): SlackThreadInfo | undefined {
    const cached = this.threads.get(threadTs);
    if (cached) {
      this.threads.set(threadTs, cached);
    }
    return cached;
  }

  private isReactionThreadAuthorized(
    threadTs: string,
    channelId: string,
    cachedThread?: SlackThreadInfo,
  ): boolean {
    if (cachedThread && cachedThread.channelId !== channelId) return false;

    // Deny by default (#812): without an explicit authorization gate, a
    // merely cached/known thread must never authorize reaction routing.
    const authorize = this.config.isReactionThreadAuthorized;
    if (!authorize) return false;

    try {
      return authorize(threadTs, channelId);
    } catch (error) {
      // Authorization failures must fail closed without posting visible
      // error reactions into threads Pinet does not own.
      console.error(`[slack-adapter] reaction thread authorization failed: ${errorMsg(error)}`);
      return false;
    }
  }

  private async onMessage(evt: Record<string, unknown>): Promise<void> {
    if (this.shuttingDown) return;

    const classified = classifyMessage(
      evt,
      this.botUserId,
      this.getTrackedThreadIds(),
      this.config.isKnownThread,
    );
    if (!classified.relevant) return;

    const { threadTs, channel, userId, text, isDM, isChannelMention, messageTs, metadata } =
      classified;

    if (
      isDM &&
      typeof evt.thread_ts === "string" &&
      this.shouldSuppressLegacyThreadedDm(threadTs)
    ) {
      return;
    }

    // Check the allowlist before recording any thread state so unauthorized
    // traffic can never mint known-thread/affinity side effects (#812).
    if (!isSlackUserAllowed(this.allowlist, userId)) return;

    if (!this.getThread(threadTs)) {
      this.threads.set(threadTs, {
        channelId: channel,
        threadTs,
        userId,
      });
    }

    void this.threadStatuses.begin(channel, threadTs, DEFAULT_SLACK_THREAD_STATUS);
    void this.addReaction(channel, messageTs, "eyes");
    const pending = this.pendingEyes.get(threadTs) ?? [];
    pending.push({ channel, messageTs });
    if (pending.length > SLACK_PENDING_ATTENTION_MAX_MESSAGES_PER_THREAD) {
      pending.splice(0, pending.length - SLACK_PENDING_ATTENTION_MAX_MESSAGES_PER_THREAD);
    }
    this.pendingEyes.set(threadTs, pending);

    const userName = await this.resolveUser(userId);
    if (this.shuttingDown) return;

    const threadInfo = this.getThread(threadTs);
    this.inboundHandler?.({
      source: "slack",
      threadId: threadTs,
      channel,
      userId,
      userName,
      text,
      timestamp: messageTs,
      scope: buildSlackThreadRuntimeScope({
        channelId: channel,
        context: threadInfo?.context,
      }),
      ...(isChannelMention ? { isChannelMention: true } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }

  private async emitInteractiveInbound(normalized: {
    channel: string;
    threadTs: string;
    userId: string;
    text: string;
    timestamp: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    // Check the allowlist before recording in-memory or durable thread state
    // so unauthorized interactive events cannot mint known-thread/affinity
    // side effects (#812).
    if (!isSlackUserAllowed(this.allowlist, normalized.userId)) return;

    if (!this.getThread(normalized.threadTs)) {
      this.threads.set(normalized.threadTs, {
        channelId: normalized.channel,
        threadTs: normalized.threadTs,
        userId: normalized.userId,
      });
    }

    try {
      this.config.rememberKnownThread?.(normalized.threadTs, normalized.channel, null);
    } catch {
      /* best effort — DB cache sync must not break Slack event handling */
    }

    const userName = await this.resolveUser(normalized.userId);
    if (this.shuttingDown) return;

    const threadInfo = this.getThread(normalized.threadTs);
    this.inboundHandler?.({
      source: "slack",
      threadId: normalized.threadTs,
      channel: normalized.channel,
      userId: normalized.userId,
      userName,
      text: normalized.text,
      timestamp: normalized.timestamp,
      metadata: normalized.metadata,
      scope: buildSlackThreadRuntimeScope({
        channelId: normalized.channel,
        context: threadInfo?.context,
      }),
    });
  }

  private onMemberJoined(event: { channel: string; isSelf: boolean }): void {
    if (!event.isSelf) return;

    this.inboundHandler?.({
      source: "slack",
      threadId: "",
      channel: event.channel,
      userId: "system",
      text: `Bot was added to channel ${event.channel}`,
      timestamp: String(Date.now() / 1000),
      scope: buildSlackThreadRuntimeScope({ channelId: event.channel }),
    });
  }

  private shouldSuppressLegacyThreadedDm(threadTs: string): boolean {
    const cached = this.threads.get(threadTs);
    if (cached) return false;

    const known = this.config.getKnownThread?.(threadTs);
    return !!known && known.channelId.startsWith("D") && !known.context;
  }

  private getThread(threadTs: string): SlackThreadInfo | undefined {
    const cached = this.threads.get(threadTs);
    if (cached) {
      this.threads.set(threadTs, cached);
      return cached;
    }

    const known = this.config.getKnownThread?.(threadTs);
    if (!known?.channelId) return undefined;

    const restored: SlackThreadInfo = {
      channelId: known.channelId,
      threadTs,
      userId: "",
      ...(known.context ? { context: known.context } : {}),
    };
    this.threads.set(threadTs, restored);
    return restored;
  }

  private async addReaction(channel: string, ts: string, emoji: string): Promise<void> {
    await addSlackReaction({
      slack: this.callSlack.bind(this),
      token: this.config.botToken,
      channel,
      timestamp: ts,
      emoji,
    });
  }

  private async removeReaction(channel: string, ts: string, emoji: string): Promise<void> {
    await removeSlackReaction({
      slack: this.callSlack.bind(this),
      token: this.config.botToken,
      channel,
      timestamp: ts,
      emoji,
    });
  }

  private async resolveUser(userId: string): Promise<string> {
    return resolveSlackUserName({
      slack: this.callSlack.bind(this),
      token: this.config.botToken,
      userId,
      cache: this.userNames,
      shouldUseResult: () => !this.shuttingDown,
    });
  }

  private async clearThreadStatus(channelId: string, threadTs: string): Promise<void> {
    await this.threadStatuses.clear(channelId, threadTs);
  }

  private async setSuggestedPrompts(channelId: string, threadTs: string): Promise<void> {
    const prompts = this.config.suggestedPrompts ?? [
      { title: "Status", message: "What are you working on right now?" },
      { title: "Help", message: "I need help with something in the codebase" },
      { title: "Review", message: "Summarise the recent changes" },
    ];
    await setSlackSuggestedPrompts({
      slack: this.callSlack.bind(this),
      token: this.config.botToken,
      channelId,
      threadTs,
      prompts,
    });
  }
}

function isParsedThreadStarted(
  value: ParsedThreadStarted | Record<string, unknown>,
): value is ParsedThreadStarted {
  return (
    typeof value.channelId === "string" &&
    typeof value.threadTs === "string" &&
    typeof value.userId === "string"
  );
}

function isParsedThreadContextChanged(
  value: ParsedThreadContextChanged | Record<string, unknown>,
): value is ParsedThreadContextChanged {
  return typeof value.threadTs === "string";
}

function isParsedAppHomeOpened(
  value: ParsedAppHomeOpened | Record<string, unknown>,
): value is ParsedAppHomeOpened {
  return typeof value.userId === "string" && typeof value.tab === "string";
}

function errorMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
