import type { MappingStore } from "./mapping.js";
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
export type SlackInboundMessage = {
  channel: string;
  ts: string;
  threadTs: string | null;
  user: string;
  text: string;
  botId: string | null;
};
export type ChatMessage = {
  id: string;
  channelId: string;
  parentId: string | null;
  markdown: string;
  senderId: string;
  clientId: string;
  mentions: string[];
};
export interface SlackTransport {
  postMessage(value: { channel: string; text: string; threadTs?: string }): Promise<{ ts: string }>;
}
export interface ChatTransport {
  send(value: {
    channelId: string;
    markdown: string;
    parentId: string | null;
    mentions: string[];
    clientId: string;
  }): Promise<{ id: string }>;
}
export type SlackAdapterOptions = {
  mappings: MappingStore;
  slack: SlackTransport;
  chat: ChatTransport;
  ownSlackUserId: string;
  mentionMap?: Record<string, string>;
};
export class SlackAdapter {
  constructor(private options: SlackAdapterOptions) {}
  async receive(
    message: SlackInboundMessage,
  ): Promise<{ status: "relayed" | "ignored"; reason?: string; chatMessageId?: string }> {
    if (
      message.botId ||
      message.user === this.options.ownSlackUserId ||
      this.options.mappings.hasSlackMessage(message.channel, message.ts)
    )
      return { status: "ignored", reason: "loop prevention" };
    const channel = this.options.mappings.channelBySlack(message.channel);
    if (!channel) return { status: "ignored", reason: "unmapped channel" };
    let parentId: string | null = null;
    if (message.threadTs && message.threadTs !== message.ts) {
      const thread = this.options.mappings.threadBySlack(message.channel, message.threadTs);
      if (!thread) return { status: "ignored", reason: "unmapped thread" };
      parentId = thread.chatParentId;
    }
    const mentions = [...message.text.matchAll(/<@([A-Z0-9]+)>/g)]
      .map((match) => this.options.mentionMap?.[match[1]!])
      .filter((value): value is string => Boolean(value));
    const sent = await this.options.chat.send({
      channelId: channel.chatChannelId,
      markdown: `**Slack user ${message.user}:** ${message.text}`,
      parentId,
      mentions,
      clientId: `slack:${message.channel}:${message.ts}`,
    });
    this.options.mappings.recordRelay("slack-to-chat", message.channel, message.ts, sent.id);
    if (!message.threadTs || message.threadTs === message.ts)
      this.options.mappings.bindThread({
        ...channel,
        slackThreadTs: message.ts,
        chatParentId: sent.id,
      });
    return { status: "relayed", chatMessageId: sent.id };
  }
  async send(
    message: ChatMessage,
  ): Promise<{ status: "relayed" | "ignored"; slackTs?: string; reason?: string }> {
    const channel = this.options.mappings.channelByChat(message.channelId);
    if (!channel) return { status: "ignored", reason: "unmapped channel" };
    let threadTs: string | undefined;
    if (message.parentId) {
      const thread = this.options.mappings.threadByChat(message.channelId, message.parentId);
      if (!thread) return { status: "ignored", reason: "unmapped thread" };
      threadTs = thread.slackThreadTs;
    }
    const sent = await this.options.slack.postMessage({
      channel: channel.slackChannelId,
      text: message.markdown,
      ...(threadTs ? { threadTs } : {}),
    });
    this.options.mappings.recordRelay("chat-to-slack", channel.slackChannelId, sent.ts, message.id);
    if (!message.parentId)
      this.options.mappings.bindThread({
        ...channel,
        slackThreadTs: sent.ts,
        chatParentId: message.id,
      });
    return { status: "relayed", slackTs: sent.ts };
  }
}
export class SlackWebApiTransport implements SlackTransport {
  constructor(
    private token: string,
    private transport: typeof fetch = fetch,
  ) {}
  async postMessage(value: { channel: string; text: string; threadTs?: string }) {
    const response = await this.transport("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: value.channel, text: value.text, thread_ts: value.threadTs }),
    });
    const payload = (await response.json()) as { ok: boolean; ts?: string; error?: string };
    if (!response.ok || !payload.ok || !payload.ts)
      throw new Error(`Slack send failed: ${payload.error ?? response.status}`);
    return { ts: payload.ts };
  }
}
export class ChatHttpTransport implements ChatTransport {
  constructor(
    private baseUrl: string,
    private token: string,
    private transport: typeof fetch = fetch,
  ) {}
  async send(value: {
    channelId: string;
    markdown: string;
    parentId: string | null;
    mentions: string[];
    clientId: string;
  }) {
    const response = await this.transport(
      new URL(`/v1/channels/${value.channelId}/messages`, this.baseUrl),
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(value),
      },
    );
    const payload = (await response.json()) as {
      data?: { id: string };
      error?: { message: string };
    };
    if (!response.ok || !payload.data)
      throw new Error(payload.error?.message ?? `Chat send failed (${response.status})`);
    return payload.data;
  }
}
export function parseSlackMessage(value: JsonValue): SlackInboundMessage | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") return;
  const event = (value as JsonObject).event;
  if (!event || Array.isArray(event) || typeof event !== "object") return;
  const row = event as JsonObject;
  if (
    row.type !== "message" ||
    typeof row.channel !== "string" ||
    typeof row.ts !== "string" ||
    typeof row.text !== "string" ||
    typeof row.user !== "string"
  )
    return;
  return {
    channel: row.channel,
    ts: row.ts,
    text: row.text,
    user: row.user,
    threadTs: typeof row.thread_ts === "string" ? row.thread_ts : null,
    botId: typeof row.bot_id === "string" ? row.bot_id : null,
  };
}
