import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ChatHttpTransport,
  SlackAdapter,
  SlackWebApiTransport,
  type ChatMessage,
} from "./adapter.js";
import { SqliteMappingStore } from "./mapping.js";
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
};
export type SlackExtensionOptions = {
  chatUrl?: string;
  chatToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackUserId?: string;
  databasePath?: string;
  mentionMap?: Record<string, string>;
  fetch?: typeof fetch;
};
export function registerSlack(pi: ExtensionAPI, supplied: SlackExtensionOptions = {}) {
  const chatUrl = supplied.chatUrl ?? process.env.PINET_CHAT_URL,
    chatToken = supplied.chatToken ?? process.env.PINET_SLACK_CHAT_TOKEN,
    botToken = supplied.slackBotToken ?? process.env.SLACK_BOT_TOKEN,
    appToken = supplied.slackAppToken ?? process.env.SLACK_APP_TOKEN,
    userId = supplied.slackUserId ?? process.env.SLACK_BOT_USER_ID;
  const mappings = new SqliteMappingStore(
    supplied.databasePath ??
      process.env.PINET_SLACK_DB ??
      join(homedir(), ".pi", "agent", "pinet-slack.sqlite"),
  );
  const transport = supplied.fetch ?? fetch;
  const configured = Boolean(chatUrl && chatToken && botToken && appToken && userId);
  const adapter = configured
    ? new SlackAdapter({
        mappings,
        slack: new SlackWebApiTransport(botToken!, transport),
        chat: new ChatHttpTransport(chatUrl!, chatToken!, transport),
        ownSlackUserId: userId!,
        mentionMap: supplied.mentionMap,
      })
    : undefined;
  const socket =
    adapter && appToken ? new SlackSocketModeClient(appToken, adapter, transport) : undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  const cursors = new Map<string, number>();
  // agent-standards-ignore prefer-inline-single-use-helper: interval callback is a named lifecycle operation and is testable independently of timer setup.
  async function pollChat() {
    if (!adapter || !chatUrl || !chatToken) return;
    for (const mapping of mappings.listChannels()) {
      const after = cursors.get(mapping.chatChannelId) ?? 0;
      const response = await transport(
        new URL(`/v1/channels/${mapping.chatChannelId}/messages?after=${after}`, chatUrl),
        { headers: { authorization: `Bearer ${chatToken}` } },
      );
      if (!response.ok) continue;
      const payload = (await response.json()) as {
        data: ChatMessage[] & Array<{ cursor: number }>;
      };
      for (const message of payload.data) {
        cursors.set(
          mapping.chatChannelId,
          Math.max(cursors.get(mapping.chatChannelId) ?? 0, message.cursor),
        );
        if (!mappings.hasChatMessage(message.id)) await adapter.send(message);
      }
    }
  }
  pi.on("session_start", async () => {
    if (!socket) return;
    await socket.start();
    poller = setInterval(() => {
      void pollChat();
    }, 2000);
    poller.unref();
  });
  pi.on("session_shutdown", () => {
    socket?.stop();
    if (poller) clearInterval(poller);
    mappings.close();
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
            },
          };
        else if (p.action === "status") value = { configured, mappings: mappings.listChannels() };
        else if (p.action === "bind_channel") {
          const mapping = {
            slackChannelId: need(p.slackChannelId, "slackChannelId"),
            chatChannelId: need(p.chatChannelId, "chatChannelId"),
          };
          mappings.bindChannel(mapping);
          value = mapping;
        } else if (p.action === "bind_thread") {
          const mapping = {
            slackChannelId: need(p.slackChannelId, "slackChannelId"),
            chatChannelId: need(p.chatChannelId, "chatChannelId"),
            slackThreadTs: need(p.slackThreadTs, "slackThreadTs"),
            chatParentId: need(p.chatParentId, "chatParentId"),
          };
          mappings.bindThread(mapping);
          value = mapping;
        } else throw new Error("Unknown action; call help");
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
