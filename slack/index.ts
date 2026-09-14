import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ChatHttpTransport,
  SlackAdapter,
  SlackWebApiTransport,
  type ChatMessage,
} from "./adapter.js";
import { SqliteMappingStore, type MappingStore } from "./mapping.js";
import { SlackSocketModeClient } from "./socket.js";
export * from "./adapter.js";
export * from "./mapping.js";
export * from "./socket.js";
type Params = {
  action: string;
  slackChannelId?: string;
  chatChannelId?: string;
  slackThreadTs?: string;
  chatParentId?: string;
  messageId?: string;
};
export class SlackChatPoller {
  private inFlight = false;
  constructor(
    private readonly mappings: MappingStore,
    private readonly adapter: SlackAdapter,
    private readonly chatUrl: string,
    private readonly chatToken: string,
    private readonly transport: typeof fetch,
  ) {}
  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      for (const mapping of this.mappings.listChannels()) {
        const after = this.mappings.getCursor(mapping.chatChannelId);
        const response = await this.transport(
          new URL(`/v1/channels/${mapping.chatChannelId}/messages?after=${after}`, this.chatUrl),
          { headers: { authorization: `Bearer ${this.chatToken}` } },
        );
        if (!response.ok) continue;
        const payload = (await response.json()) as {
          data: ChatMessage[] & Array<{ cursor: number }>;
        };
        for (const message of payload.data) {
          if (!this.mappings.hasChatMessage(message.id)) {
            const outcome = await this.adapter.send(message);
            if (outcome.status === "ignored")
              this.mappings.advanceCursor(mapping.chatChannelId, message.cursor);
          } else this.mappings.advanceCursor(mapping.chatChannelId, message.cursor);
        }
      }
    } finally {
      this.inFlight = false;
    }
  }
}

export type SlackExtensionOptions = {
  chatUrl?: string;
  chatToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackUserId?: string;
  databasePath?: string;
  mentionMap?: Record<string, string>;
  fetch?: typeof fetch;
  enabled?: boolean;
  mappingStoreFactory?: (path: string) => MappingStore;
};
export function registerSlack(pi: ExtensionAPI, supplied: SlackExtensionOptions = {}) {
  const chatUrl = supplied.chatUrl ?? process.env.PINET_CHAT_URL,
    chatToken = supplied.chatToken ?? process.env.PINET_SLACK_CHAT_TOKEN,
    botToken = supplied.slackBotToken ?? process.env.SLACK_BOT_TOKEN,
    appToken = supplied.slackAppToken ?? process.env.SLACK_APP_TOKEN,
    userId = supplied.slackUserId ?? process.env.SLACK_BOT_USER_ID;
  const enabled = supplied.enabled ?? process.env.PINET_SLACK_ENABLED === "true";
  const configured = Boolean(enabled && chatUrl && chatToken && botToken && appToken && userId);
  const databasePath =
    supplied.databasePath ??
    process.env.PINET_SLACK_DB ??
    join(homedir(), ".pi", "agent", "pinet-slack.sqlite");
  const transport = supplied.fetch ?? fetch;
  let mappings: MappingStore | undefined;
  let socket: SlackSocketModeClient | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  const getMappings = () => {
    if (!enabled) throw new Error("Set PINET_SLACK_ENABLED=true to activate the Slack adapter");
    mappings ??= supplied.mappingStoreFactory
      ? supplied.mappingStoreFactory(databasePath)
      : new SqliteMappingStore(databasePath);
    return mappings;
  };
  pi.on("session_start", async () => {
    if (!configured || socket) return;
    const activeGeneration = ++generation;
    const activeMappings = getMappings();
    const adapter = new SlackAdapter({
      mappings: activeMappings,
      slack: new SlackWebApiTransport(botToken!, transport),
      chat: new ChatHttpTransport(chatUrl!, chatToken!, transport),
      ownSlackUserId: userId!,
      mentionMap: supplied.mentionMap,
    });
    const activeSocket = new SlackSocketModeClient(appToken!, adapter, transport);
    socket = activeSocket;
    const chatPoller = new SlackChatPoller(
      activeMappings,
      adapter,
      chatUrl!,
      chatToken!,
      transport,
    );
    await activeSocket.start();
    if (generation !== activeGeneration || socket !== activeSocket) return;
    poller = setInterval(() => {
      void chatPoller.poll().catch(() => {});
    }, 2000);
    poller.unref();
  });
  pi.on("session_shutdown", () => {
    ++generation;
    const activeSocket = socket;
    socket = undefined;
    activeSocket?.stop();
    if (poller) clearInterval(poller);
    poller = undefined;
    mappings?.close();
    mappings = undefined;
  });
  pi.registerTool({
    name: "pinet_slack",
    label: "Pinet Slack",
    description:
      "Configure durable Slack channel/thread mappings. Slack transport runs only with explicit credentials. Call help for schemas.",
    promptSnippet: "Slack mapping dispatcher; use help for action schemas.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string" },
        slackChannelId: { type: "string" },
        chatChannelId: { type: "string" },
        slackThreadTs: { type: "string" },
        chatParentId: { type: "string" },
        messageId: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_id, raw) {
      const p = raw as Params;
      try {
        let value: object;
        if (p.action === "help")
          value = {
            actions: {
              help: {},
              status: {},
              bind_channel: { slackChannelId: "string", chatChannelId: "string" },
              bind_thread: {
                slackChannelId: "string",
                chatChannelId: "string",
                slackThreadTs: "string",
                chatParentId: "string",
              },
              outbound_ambiguous: {},
              outbound_retry: { messageId: "string" },
            },
          };
        else if (p.action === "status")
          value = { enabled, configured, mappings: mappings?.listChannels() ?? [] };
        else if (p.action === "bind_channel") {
          const mapping = {
            slackChannelId: need(p.slackChannelId, "slackChannelId"),
            chatChannelId: need(p.chatChannelId, "chatChannelId"),
          };
          getMappings().bindChannel(mapping);
          value = mapping;
        } else if (p.action === "bind_thread") {
          const mapping = {
            slackChannelId: need(p.slackChannelId, "slackChannelId"),
            chatChannelId: need(p.chatChannelId, "chatChannelId"),
            slackThreadTs: need(p.slackThreadTs, "slackThreadTs"),
            chatParentId: need(p.chatParentId, "chatParentId"),
          };
          getMappings().bindThread(mapping);
          value = mapping;
        } else if (p.action === "outbound_ambiguous")
          value = { messageIds: getMappings().listAmbiguousOutbound() };
        else if (p.action === "outbound_retry")
          value = { retried: getMappings().retryOutbound(need(p.messageId, "messageId")) };
        else throw new Error("Unknown action; call help");
        return {
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          details: value,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });
  pi.registerCommand("pinet-slack", {
    description: "Show Pinet Slack adapter status",
    handler: async (_args, ctx) =>
      ctx.ui.notify(
        configured ? "Pinet Slack is configured" : "Pinet Slack is not configured",
        configured ? "info" : "warning",
      ),
  });
}
function need(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
export default function slack(pi: ExtensionAPI) {
  registerSlack(pi);
}
