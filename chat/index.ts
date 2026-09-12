import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ChatClient, type ChatClientOptions } from "./client.js";
export * from "./client.js";
export * from "./domain.js";
export * from "./memory-storage.js";
export * from "./runtime.js";
export * from "./runtime-manager.js";
export * from "./server.js";
export * from "./sqlite-storage.js";

export type ChatExtensionOptions = Partial<ChatClientOptions> & {
  cursorPath?: string;
  pollIntervalMs?: number;
};
type ChatAction = {
  action: string;
  channelId?: string;
  markdown?: string;
  mentions?: string[];
  parentId?: string;
  clientId?: string;
  query?: string;
  name?: string;
  topic?: string;
  after?: number;
  hostId?: string;
  prompt?: string;
  worktree?: string;
  adapter?: string;
  requestId?: string;
};

const HELP = {
  actions: {
    help: {},
    channels: {},
    channel_create: { name: "string", topic: "string?" },
    channel_get: { channelId: "string" },
    channel_update: { channelId: "string", name: "string?", topic: "string?" },
    channel_delete: { channelId: "string" },
    join: { channelId: "string" },
    leave: { channelId: "string" },
    send: {
      channelId: "string",
      markdown: "string",
      mentions: "agent ID[]?",
      parentId: "message ID?",
      clientId: "retry key?",
    },
    history: { channelId: "string", after: "cursor?" },
    search: { query: "string" },
    agents: {},
    agent_register: { name: "string", channelId: "home channel ID?" },
    home: { channelId: "string" },
    spawn: {
      hostId: "string",
      channelId: "string?",
      prompt: "string",
      worktree: "string?",
      adapter: "process|tmux|herdr?",
    },
    runtime_status: { requestId: "string" },
  },
};

export function registerChat(pi: ExtensionAPI, supplied: ChatExtensionOptions = {}): void {
  const options = {
    baseUrl: supplied.baseUrl ?? process.env.PINET_CHAT_URL,
    token: supplied.token ?? process.env.PINET_CHAT_TOKEN,
    agentId: supplied.agentId ?? process.env.PINET_AGENT_ID,
  };
  const client =
    options.baseUrl && options.token && options.agentId
      ? new ChatClient(options as ChatClientOptions)
      : undefined;
  const cursorPath =
    supplied.cursorPath ??
    join(homedir(), ".pi", "agent", `pinet-chat-${options.agentId ?? "unconfigured"}.cursor`);
  let cursor = 0;
  try {
    cursor = Number(readFileSync(cursorPath, "utf8")) || 0;
  } catch {
    // No persisted cursor on first start.
  }
  let mentionPoller: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  async function pollMentions(): Promise<void> {
    if (!client || polling) return;
    polling = true;
    try {
      const envelope = (await client.call("GET", `/v1/mentions?after=${cursor}`)) as {
        data?: Array<{ cursor: number; senderId: string; channelId: string; markdown: string }>;
      };
      for (const message of envelope.data ?? []) {
        pi.sendUserMessage(
          `[Pinet Chat mention from ${message.senderId} in ${message.channelId}]\n${message.markdown}`,
          { deliverAs: "followUp" },
        );
        cursor = message.cursor;
        mkdirSync(dirname(cursorPath), { recursive: true });
        writeFileSync(cursorPath, String(cursor));
      }
    } finally {
      polling = false;
    }
  }
  pi.on("session_start", async () => {
    if (!client) return;
    await pollMentions();
    mentionPoller = setInterval(
      () => void pollMentions().catch(() => {}),
      supplied.pollIntervalMs ?? 2000,
    );
    mentionPoller.unref();
  });
  pi.on("session_shutdown", () => {
    if (mentionPoller) clearInterval(mentionPoller);
  });
  pi.registerTool({
    name: "pinet_chat",
    label: "Pinet chat",
    description:
      "Dispatch agent chat, discovery, channel, search, and tracked runtime actions. Call action=help for schemas.",
    promptSnippet: "Agent chat and tracked spawn dispatcher; use help for action schemas.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string" },
        channelId: { type: "string" },
        markdown: { type: "string" },
        mentions: { type: "array", items: { type: "string" } },
        parentId: { type: "string" },
        clientId: { type: "string" },
        query: { type: "string" },
        name: { type: "string" },
        topic: { type: "string" },
        after: { type: "integer" },
        hostId: { type: "string" },
        prompt: { type: "string" },
        worktree: { type: "string" },
        adapter: { type: "string" },
        requestId: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_id, raw) {
      const params = raw as ChatAction;
      if (params.action === "help") return result(HELP);
      if (!client) return failure("Set PINET_CHAT_URL, PINET_CHAT_TOKEN, and PINET_AGENT_ID");
      try {
        switch (params.action) {
          case "channels":
            return result(await client.call("GET", "/v1/channels"));
          case "channel_create":
            return result(
              await client.call("POST", "/v1/channels", { name: params.name, topic: params.topic }),
            );
          case "channel_get":
            return result(
              await client.call("GET", `/v1/channels/${required(params.channelId, "channelId")}`),
            );
          case "channel_update":
            return result(
              await client.call("PUT", `/v1/channels/${required(params.channelId, "channelId")}`, {
                name: params.name,
                topic: params.topic,
              }),
            );
          case "channel_delete":
            return result(
              await client.call(
                "DELETE",
                `/v1/channels/${required(params.channelId, "channelId")}`,
              ),
            );
          case "join":
            return result(
              await client.call(
                "POST",
                `/v1/channels/${required(params.channelId, "channelId")}/join`,
              ),
            );
          case "leave":
            return result(
              await client.call(
                "DELETE",
                `/v1/channels/${required(params.channelId, "channelId")}/join`,
              ),
            );
          case "send":
            return result(
              await client.call(
                "POST",
                `/v1/channels/${required(params.channelId, "channelId")}/messages`,
                {
                  markdown: required(params.markdown, "markdown"),
                  mentions: params.mentions,
                  parentId: params.parentId,
                  clientId: params.clientId ?? crypto.randomUUID(),
                },
              ),
            );
          case "history":
            return result(
              await client.call(
                "GET",
                `/v1/channels/${required(params.channelId, "channelId")}/messages?after=${params.after ?? 0}`,
              ),
            );
          case "search":
            return result(
              await client.call(
                "GET",
                `/v1/messages/search?q=${encodeURIComponent(required(params.query, "query"))}`,
              ),
            );
          case "agents":
            return result(await client.call("GET", "/v1/agents"));
          case "agent_register":
            return result(
              await client.call("POST", "/v1/agents", {
                name: required(params.name, "name"),
                homeChannelId: params.channelId,
              }),
            );
          case "home":
            return result(
              await client.call("PUT", "/v1/agents/me/home", {
                channelId: required(params.channelId, "channelId"),
              }),
            );
          case "spawn":
            return result(
              await client.call("POST", "/v1/runtime/requests", {
                hostId: required(params.hostId, "hostId"),
                prompt: required(params.prompt, "prompt"),
                channelId: params.channelId,
                worktree: params.worktree,
                adapter: params.adapter,
              }),
            );
          case "runtime_status":
            return result(
              await client.call(
                "GET",
                `/v1/runtime/requests/${required(params.requestId, "requestId")}`,
              ),
            );
          default:
            return failure("Unknown action; call help", false);
        }
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  });
  pi.registerCommand("pinet-chat", {
    description: "Show Pinet chat configuration",
    handler: async (_args, ctx) =>
      ctx.ui.notify(
        client
          ? `Pinet chat: ${options.agentId} at ${options.baseUrl}`
          : "Pinet chat is not configured",
        client ? "info" : "warning",
      ),
  });
}
function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function result(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}
function failure(message: string, isError = true) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { error: message },
    isError,
  };
}
export default function chat(pi: ExtensionAPI): void {
  registerChat(pi);
}
