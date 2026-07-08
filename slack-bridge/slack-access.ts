import type { RuntimeScopeCarrier } from "@pinet/transport-core";
import {
  buildSlackCompatibilityScope,
  isUserAllowed,
  isChannelId,
  stripBotMention,
  isAbortError,
} from "./helpers.js";
import {
  buildSlackInboundMessageText,
  extractSlackMessageFileMetadata,
  type SlackMessageFileMetadata,
} from "./slack-message-context.js";
import {
  extractSlackInteractivePayloadFromEnvelope,
  normalizeSlackBlockActionPayload,
  normalizeSlackViewSubmissionPayload,
  type SlackInteractiveInboxEvent,
} from "./slack-block-kit.js";
import { extractSlackSocketDedupKey } from "./slack-socket-dedup.js";
import { extractPiAgentThreadOwnerHint, type ThreadOwnerHint } from "./broker/router.js";

export {
  SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE,
  SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS,
} from "./slack-socket-dedup.js";

export type SlackCall = (
  method: string,
  token: string,
  body?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface SlackAccessCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): unknown;
  has?(key: K): boolean;
}

export interface SlackAccessSet<K> {
  has(key: K): boolean;
  add(key: K): unknown;
  delete?(key: K): unknown;
}

export interface SlackThreadContext {
  channelId: string;
  teamId?: string;
  scope: RuntimeScopeCarrier;
}

function buildSlackThreadContext(channelId: string, teamId?: string | null): SlackThreadContext {
  const normalizedTeamId =
    typeof teamId === "string" && teamId.trim().length > 0 ? teamId.trim() : undefined;
  return {
    channelId,
    ...(normalizedTeamId ? { teamId: normalizedTeamId } : {}),
    scope: buildSlackCompatibilityScope({
      teamId: normalizedTeamId,
      channelId,
    }),
  };
}

export function buildSlackThreadRuntimeScope(input: {
  channelId?: string | null;
  context?: SlackThreadContext | null;
}): RuntimeScopeCarrier {
  return (
    input.context?.scope ??
    buildSlackCompatibilityScope({
      teamId: input.context?.teamId,
      channelId: input.context?.channelId ?? input.channelId,
    })
  );
}

export interface ParsedSlashCommand {
  command: string;
  text: string;
  channelId: string;
  userId: string;
  responseUrl?: string;
  triggerId?: string;
  teamId?: string;
}

export interface ParsedEnvelope {
  envelopeId?: string;
  type: string;
  dedupKey?: string;
  event?: Record<string, unknown>;
  interactivePayload?: Record<string, unknown>;
  slashCommand?: ParsedSlashCommand;
}

export function isSlackUserAllowed(allowlist: Set<string> | null, userId: string): boolean {
  return isUserAllowed(allowlist, userId);
}

/**
 * Parse a raw Socket Mode WebSocket frame into a structured envelope.
 * Returns null if the frame is malformed JSON.
 */
export function parseSocketFrame(raw: string): ParsedEnvelope | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const result: ParsedEnvelope = {
      type: (data.type as string) ?? "",
    };
    if (data.envelope_id) {
      result.envelopeId = data.envelope_id as string;
    }
    const dedupKey = extractSlackSocketDedupKey(data);
    if (dedupKey) {
      result.dedupKey = dedupKey;
    }
    if (data.type === "events_api") {
      const payload = data.payload as { event?: Record<string, unknown> } | undefined;
      result.event = payload?.event;
    }

    const interactivePayload = extractSlackInteractivePayloadFromEnvelope(data);
    if (interactivePayload) {
      result.interactivePayload = interactivePayload;
    }
    if (data.type === "slash_commands") {
      const slashCommand = extractSlackSlashCommandPayload(data.payload);
      if (slashCommand) {
        result.slashCommand = slashCommand;
      }
    }
    return result;
  } catch {
    return null;
  }
}

function extractSlackSlashCommandPayload(payload: unknown): ParsedSlashCommand | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command.trim() : "";
  const text = typeof record.text === "string" ? record.text : "";
  const channelId = typeof record.channel_id === "string" ? record.channel_id : "";
  const userId = typeof record.user_id === "string" ? record.user_id : "";
  if (!command || !channelId || !userId) return null;
  return {
    command,
    text,
    channelId,
    userId,
    ...(typeof record.response_url === "string" ? { responseUrl: record.response_url } : {}),
    ...(typeof record.trigger_id === "string" ? { triggerId: record.trigger_id } : {}),
    ...(typeof record.team_id === "string" ? { teamId: record.team_id } : {}),
  };
}

export interface ParsedThreadStarted {
  channelId: string;
  threadTs: string;
  userId: string;
  context?: SlackThreadContext;
}

/**
 * Extract thread info from an assistant_thread_started event.
 */
export function extractThreadStarted(evt: Record<string, unknown>): ParsedThreadStarted | null {
  const t = evt.assistant_thread as Record<string, unknown> | undefined;
  if (!t) return null;

  const channelId =
    typeof t.channel_id === "string" && t.channel_id.length > 0 ? t.channel_id : null;
  const threadTs = typeof t.thread_ts === "string" && t.thread_ts.length > 0 ? t.thread_ts : null;
  const userId = typeof t.user_id === "string" && t.user_id.length > 0 ? t.user_id : null;
  if (!channelId || !threadTs || !userId) {
    return null;
  }

  const result: ParsedThreadStarted = {
    channelId,
    threadTs,
    userId,
  };

  const ctx = t.context as { channel_id?: string; team_id?: string } | undefined;
  if (ctx?.channel_id) {
    result.context = buildSlackThreadContext(ctx.channel_id, ctx.team_id);
  }

  return result;
}

export interface ParsedThreadContextChanged {
  threadTs: string;
  context?: SlackThreadContext;
}

export function extractThreadContextChanged(
  evt: Record<string, unknown>,
): ParsedThreadContextChanged | null {
  const t = evt.assistant_thread as Record<string, unknown> | undefined;
  if (!t) return null;

  const threadTs = typeof t.thread_ts === "string" && t.thread_ts.length > 0 ? t.thread_ts : null;
  if (!threadTs) {
    return null;
  }

  const result: ParsedThreadContextChanged = { threadTs };
  const ctx = t.context as { channel_id?: string; team_id?: string } | undefined;
  if (ctx?.channel_id) {
    result.context = buildSlackThreadContext(ctx.channel_id, ctx.team_id);
  }

  return result;
}

export interface ParsedAppHomeOpened {
  userId: string;
  tab: string;
  eventTs: string | null;
}

export function extractAppHomeOpened(evt: Record<string, unknown>): ParsedAppHomeOpened | null {
  const userId = typeof evt.user === "string" && evt.user.length > 0 ? evt.user : null;
  if (!userId) return null;

  const tab = typeof evt.tab === "string" && evt.tab.length > 0 ? evt.tab : "home";
  return {
    userId,
    tab,
    eventTs: typeof evt.event_ts === "string" && evt.event_ts.length > 0 ? evt.event_ts : null,
  };
}

/**
 * Classification result for an incoming message event.
 * Uses a discriminated union so TypeScript narrows fields when relevant is true.
 */
export interface SlackMessageClassificationMetadata extends Record<string, unknown> {
  slackSubtype?: string;
  slackFiles?: SlackMessageFileMetadata[];
}

export type MessageClassification =
  | { relevant: false }
  | {
      relevant: true;
      threadTs: string;
      channel: string;
      userId: string;
      text: string;
      isDM: boolean;
      isChannelMention: boolean;
      messageTs: string;
      metadata?: SlackMessageClassificationMetadata;
    };

/**
 * Classify an incoming Slack message event. Determines whether the
 * message is relevant (DM, known thread, or bot mention) and
 * extracts the cleaned fields.
 */
export function classifyMessage(
  evt: Record<string, unknown>,
  botUserId: string | null,
  trackedThreadIds: Set<string>,
  isKnownThread?: (threadTs: string) => boolean,
): MessageClassification {
  const subtype = typeof evt.subtype === "string" ? evt.subtype : undefined;
  const allowsSubtype = subtype === undefined || subtype === "file_share";
  if (!allowsSubtype || evt.bot_id) return { relevant: false };

  const text = (evt.text as string) ?? "";
  const user = evt.user as string;
  const threadTs = evt.thread_ts as string | undefined;
  const channel = evt.channel as string;
  const channelType = evt.channel_type as string | undefined;

  const isKnown = !!threadTs && (isKnownThread?.(threadTs) ?? trackedThreadIds.has(threadTs));
  const isDM = channelType === "im";
  const isMention = botUserId != null && text.includes(`<@${botUserId}>`);

  if (!isKnown && !isDM && !isMention) return { relevant: false };

  const effectiveTs = threadTs ?? (evt.ts as string);
  const isChannelMention = isMention && !isDM && !isKnown;
  const cleanText = isChannelMention && botUserId ? stripBotMention(text, botUserId) : text;
  const slackFiles = extractSlackMessageFileMetadata(evt.files);
  const metadata: SlackMessageClassificationMetadata = {
    ...(subtype ? { slackSubtype: subtype } : {}),
    ...(slackFiles.length > 0 ? { slackFiles } : {}),
  };

  return {
    relevant: true,
    threadTs: effectiveTs,
    channel,
    userId: user,
    text: buildSlackInboundMessageText(cleanText, evt),
    isDM,
    isChannelMention,
    messageTs: (evt.ts as string) ?? effectiveTs,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/**
 * Parse a member_joined_channel event. Returns null if required fields
 * are missing.
 */
export function parseMemberJoinedChannel(
  evt: Record<string, unknown>,
  botUserId: string | null,
): { channel: string; isSelf: boolean } | null {
  const user = evt.user as string | undefined;
  const channel = evt.channel as string | undefined;
  if (!user || !channel) return null;
  return { channel, isSelf: user === botUserId };
}

export interface FetchSlackMessageByTsInput {
  slack: SlackCall;
  token: string;
  channel: string;
  messageTs: string;
}

export async function fetchSlackMessageByTs(
  input: FetchSlackMessageByTsInput,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await input.slack("conversations.history", input.token, {
      channel: input.channel,
      oldest: input.messageTs,
      latest: input.messageTs,
      inclusive: true,
      limit: 1,
    });
    const messages = (response.messages as Record<string, unknown>[]) ?? [];
    return messages.find((message) => message.ts === input.messageTs) ?? messages[0] ?? null;
  } catch {
    return null;
  }
}

export interface SlackReactionInput {
  slack: SlackCall;
  token: string;
  channel: string;
  timestamp: string;
  emoji: string;
}

export async function addSlackReaction(input: SlackReactionInput): Promise<void> {
  try {
    await input.slack("reactions.add", input.token, {
      channel: input.channel,
      timestamp: input.timestamp,
      name: input.emoji,
    });
  } catch {
    /* already_reacted or non-critical */
  }
}

export async function removeSlackReaction(input: SlackReactionInput): Promise<void> {
  try {
    await input.slack("reactions.remove", input.token, {
      channel: input.channel,
      timestamp: input.timestamp,
      name: input.emoji,
    });
  } catch {
    /* not_reacted or non-critical */
  }
}

export interface ResolveSlackUserNameInput {
  slack: SlackCall;
  token: string;
  userId: string;
  cache?: SlackAccessCache<string, string>;
  shouldUseResult?: () => boolean;
}

export async function resolveSlackUserName(input: ResolveSlackUserNameInput): Promise<string> {
  const cached = input.cache?.get(input.userId);
  if (cached) return cached;

  try {
    const response = await input.slack("users.info", input.token, {
      user: input.userId,
    });
    if (input.shouldUseResult && !input.shouldUseResult()) {
      return input.userId;
    }
    const user = response.user as { real_name?: string; name?: string };
    const name = user.real_name ?? user.name ?? input.userId;
    input.cache?.set(input.userId, name);
    return name;
  } catch {
    return input.userId;
  }
}

export interface ResolveSlackChannelIdInput {
  slack: SlackCall;
  token: string;
  nameOrId: string;
  cache?: SlackAccessCache<string, string>;
}

export async function resolveSlackChannelId(input: ResolveSlackChannelIdInput): Promise<string> {
  if (isChannelId(input.nameOrId)) return input.nameOrId;

  const name = input.nameOrId.replace(/^#/, "");
  const cached = input.cache?.get(name);
  if (cached) return cached;

  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = {
      types: "public_channel,private_channel",
      limit: 200,
    };
    if (cursor) {
      body.cursor = cursor;
    }
    const response = await input.slack("conversations.list", input.token, body);
    const channels = (response.channels as { id: string; name: string }[]) ?? [];
    for (const channel of channels) {
      input.cache?.set(channel.name, channel.id);
    }
    const resolved =
      input.cache?.get(name) ?? channels.find((channel) => channel.name === name)?.id;
    if (resolved) {
      return resolved;
    }
    cursor =
      (response.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ||
      undefined;
  } while (cursor);

  throw new Error(`Channel "${name}" not found.`);
}

export interface ClearSlackThreadStatusInput {
  slack: SlackCall;
  token: string;
  channelId: string;
  threadTs: string;
}

export async function clearSlackThreadStatus(input: ClearSlackThreadStatusInput): Promise<void> {
  try {
    await input.slack("assistant.threads.setStatus", input.token, {
      channel_id: input.channelId,
      thread_ts: input.threadTs,
      status: "",
    });
  } catch {
    /* non-critical */
  }
}

export interface SlackSuggestedPrompt {
  title: string;
  message: string;
}

export interface SetSlackSuggestedPromptsInput {
  slack: SlackCall;
  token: string;
  channelId: string;
  threadTs: string;
  prompts: SlackSuggestedPrompt[];
}

export async function setSlackSuggestedPrompts(
  input: SetSlackSuggestedPromptsInput,
): Promise<void> {
  try {
    await input.slack("assistant.threads.setSuggestedPrompts", input.token, {
      channel_id: input.channelId,
      thread_ts: input.threadTs,
      prompts: input.prompts,
    });
  } catch {
    /* non-critical */
  }
}

export interface ResolveSlackThreadOwnerHintInput {
  slack: SlackCall;
  token: string;
  channel: string;
  threadTs: string;
  cache?: SlackAccessCache<string, ThreadOwnerHint>;
  limit?: number;
}

export async function resolveSlackThreadOwnerHint(
  input: ResolveSlackThreadOwnerHintInput,
): Promise<ThreadOwnerHint | null> {
  if (!input.channel || !input.threadTs) {
    return null;
  }

  const cacheKey = `${input.channel}:${input.threadTs}`;
  const cached = input.cache?.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const response = await input.slack("conversations.replies", input.token, {
      channel: input.channel,
      ts: input.threadTs,
      limit: input.limit ?? 200,
      include_all_metadata: true,
    });
    const replies = (response.messages as Record<string, unknown>[]) ?? [];
    const hint = extractPiAgentThreadOwnerHint(replies);
    if (hint) {
      input.cache?.set(cacheKey, hint);
    }
    return hint;
  } catch {
    return null;
  }
}

export const RECONNECT_DELAY_MS = 5000;

export interface SlackSocketModeClientConfig {
  slack: SlackCall;
  botToken: string;
  appToken: string;
  resolveBotUserIdOnConnect?: boolean;
  reconnectDelayMs?: number;
  dedup?: SlackAccessSet<string>;
  abortAndWait?: () => Promise<void>;
  onOpen?: () => void;
  onReconnectScheduled?: () => void;
  onError?: (error: unknown) => void;
  onThreadStarted?: (event: ParsedThreadStarted) => Promise<void> | void;
  onThreadContextChanged?: (event: ParsedThreadContextChanged) => Promise<void> | void;
  onMessage?: (event: Record<string, unknown>) => Promise<void> | void;
  onReactionAdded?: (event: Record<string, unknown>) => Promise<void> | void;
  onMemberJoinedChannel?: (event: { channel: string; isSelf: boolean }) => Promise<void> | void;
  onAppHomeOpened?: (event: ParsedAppHomeOpened) => Promise<void> | void;
  onInteractive?: (event: SlackInteractiveInboxEvent) => Promise<void> | void;
  onSlashCommand?: (event: ParsedSlashCommand) => Promise<void> | void;
}

export class SlackSocketModeClient {
  private readonly config: SlackSocketModeClientConfig;
  private botUserId: string | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  constructor(config: SlackSocketModeClientConfig) {
    this.config = config;
  }

  getBotUserId(): string | null {
    return this.botUserId;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    this.shuttingDown = false;
    if (this.config.resolveBotUserIdOnConnect ?? true) {
      const auth = await this.config.slack("auth.test", this.config.botToken);
      this.botUserId = typeof auth.user_id === "string" ? auth.user_id : null;
    }
    await this.connectSocketMode();
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore close errors */
    }
    this.ws = null;
    await this.config.abortAndWait?.();
  }

  private async connectSocketMode(): Promise<void> {
    if (this.shuttingDown) return;

    try {
      const response = await this.config.slack("apps.connections.open", this.config.appToken);
      this.ws = new WebSocket(response.url as string);

      this.ws.addEventListener("open", () => {
        this.config.onOpen?.();
      });

      this.ws.addEventListener("message", (event) => {
        void this.handleFrame(String(event.data)).catch((error) => {
          this.config.onError?.(error);
        });
      });

      this.ws.addEventListener("close", () => {
        if (!this.shuttingDown) {
          this.scheduleReconnect();
        }
      });

      this.ws.addEventListener("error", () => {
        /* close fires after error — handled there */
      });
    } catch (error) {
      if (!isAbortError(error)) {
        this.config.onError?.(error);
      }
      this.scheduleReconnect();
    }
  }

  private async handleFrame(raw: string): Promise<void> {
    if (this.shuttingDown) return;

    const envelope = parseSocketFrame(raw);
    if (!envelope) return;

    if (envelope.envelopeId) {
      this.ws?.send(JSON.stringify({ envelope_id: envelope.envelopeId }));
    }

    const dedupKey = envelope.dedupKey ?? null;

    try {
      if (dedupKey) {
        if (this.config.dedup?.has(dedupKey)) {
          return;
        }
        this.config.dedup?.add(dedupKey);
      }

      if (envelope.type === "disconnect") {
        this.scheduleReconnect();
        return;
      }

      if (envelope.interactivePayload) {
        let normalized: SlackInteractiveInboxEvent | null = null;
        if (envelope.interactivePayload.type === "block_actions") {
          normalized = normalizeSlackBlockActionPayload(envelope.interactivePayload);
        } else if (envelope.interactivePayload.type === "view_submission") {
          normalized = normalizeSlackViewSubmissionPayload(envelope.interactivePayload);
        }
        if (normalized) {
          await this.config.onInteractive?.(normalized);
        }
        return;
      }

      if (envelope.slashCommand) {
        await this.config.onSlashCommand?.(envelope.slashCommand);
        return;
      }

      if (!envelope.event) return;

      const evt = envelope.event;
      switch (evt.type) {
        case "assistant_thread_started": {
          const parsed = extractThreadStarted(evt);
          if (parsed) {
            await this.config.onThreadStarted?.(parsed);
          }
          break;
        }
        case "assistant_thread_context_changed": {
          const parsed = extractThreadContextChanged(evt);
          if (parsed) {
            await this.config.onThreadContextChanged?.(parsed);
          }
          break;
        }
        case "message":
          await this.config.onMessage?.(evt);
          break;
        case "reaction_added":
          await this.config.onReactionAdded?.(evt);
          break;
        case "member_joined_channel": {
          const parsed = parseMemberJoinedChannel(evt, this.botUserId);
          if (parsed) {
            await this.config.onMemberJoinedChannel?.(parsed);
          }
          break;
        }
        case "app_home_opened": {
          const parsed = extractAppHomeOpened(evt);
          if (parsed && parsed.tab === "home") {
            await this.config.onAppHomeOpened?.(parsed);
          }
          break;
        }
      }
    } catch (error) {
      if (dedupKey) {
        this.config.dedup?.delete?.(dedupKey);
      }
      throw error;
    }
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.config.onReconnectScheduled?.();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectSocketMode();
    }, this.config.reconnectDelayMs ?? RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }
}
