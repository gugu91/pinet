import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NormalizedMessageContent } from "@pinet/transport-core";
import { Type } from "@sinclair/typebox";
import { getDefaultIMessageThreadId, normalizeIMessageRecipient } from "@pinet/imessage-bridge";
import type { Broker } from "./broker/index.js";
import { sendBrokerMessage } from "./broker/message-send.js";

export interface IMessageToolMetadata extends Record<string, unknown> {
  recipient: string;
}

export interface IMessageToolSendInput {
  threadId: string;
  body: string;
  source: "imessage";
  channel: string;
  content: NormalizedMessageContent;
  agentName: string;
  agentEmoji: string;
  agentOwnerToken: string;
  metadata: IMessageToolMetadata;
}

export interface IMessageToolSendResult {
  adapter: string;
  messageId: number;
}

export interface RegisterIMessageToolsDeps {
  pinetEnabled: () => boolean;
  brokerRole: () => "broker" | "follower" | null;
  requireToolPolicy: (toolName: string, threadTs: string | undefined, action: string) => void;
  getActiveBroker: () => Broker | null;
  getActiveBrokerSelfId: () => string | null;
  sendFollowerIMessage: (input: IMessageToolSendInput) => Promise<IMessageToolSendResult>;
  getAgentIdentity: () => {
    name: string;
    emoji: string;
    ownerToken: string;
  };
  trackOwnedThread: (threadId: string, channel: string, source: "imessage") => void;
}

export function registerIMessageTools(pi: ExtensionAPI, deps: RegisterIMessageToolsDeps): void {
  pi.registerTool({
    name: "imessage_send",
    label: "iMessage Send",
    description:
      "Send a message through the local send-first iMessage adapter on the active broker.",
    promptSnippet:
      "Send a message through the local send-first iMessage adapter on the active Pinet broker. Use when a task needs a narrow macOS iMessage send path.",
    parameters: Type.Object({
      to: Type.String({
        description: "Recipient handle, phone number, email, or local chat identifier",
      }),
      text: Type.String({ description: "Message body" }),
      thread_id: Type.Optional(
        Type.String({
          description:
            "Optional transport thread id. Defaults to a stable iMessage thread id derived from the recipient.",
        }),
      ),
    }),
    async execute(_id, params) {
      deps.requireToolPolicy(
        "imessage_send",
        undefined,
        `to=${params.to} | thread_id=${params.thread_id ?? ""} | text=${params.text}`,
      );

      if (!deps.pinetEnabled()) {
        throw new Error("Pinet is not running. Use /pinet start or /pinet follow first.");
      }

      const recipient = normalizeIMessageRecipient(params.to);
      const text = params.text.trim();
      if (!text) {
        throw new Error("text is required");
      }
      const threadId = params.thread_id?.trim() || getDefaultIMessageThreadId(recipient);
      const { name, emoji, ownerToken } = deps.getAgentIdentity();
      const request: IMessageToolSendInput = {
        threadId,
        body: text,
        source: "imessage",
        channel: recipient,
        content: { text },
        agentName: name,
        agentEmoji: emoji,
        agentOwnerToken: ownerToken,
        metadata: { recipient },
      };

      let result: IMessageToolSendResult;
      if (deps.brokerRole() === "broker") {
        const broker = deps.getActiveBroker();
        const selfId = deps.getActiveBrokerSelfId();
        if (!broker || !selfId) {
          throw new Error("Broker agent identity is unavailable.");
        }
        if (!broker.adapters.some((candidate) => candidate.name === "imessage")) {
          throw new Error(
            "iMessage adapter is not enabled or not ready on the active broker. Set slack-bridge.imessage.enabled: true and restart /pinet start.",
          );
        }

        const brokerResult = await sendBrokerMessage(
          {
            db: broker.db,
            adapters: broker.adapters,
          },
          {
            threadId,
            body: text,
            senderAgentId: selfId,
            source: request.source,
            channel: request.channel,
            content: request.content,
            agentName: request.agentName,
            agentEmoji: request.agentEmoji,
            agentOwnerToken: request.agentOwnerToken,
            metadata: request.metadata,
          },
        );
        result = {
          adapter: brokerResult.adapter,
          messageId: brokerResult.message.id,
        };
      } else if (deps.brokerRole() === "follower") {
        result = await deps.sendFollowerIMessage(request);
      } else {
        throw new Error("Pinet is in an unexpected state.");
      }

      deps.trackOwnedThread(threadId, recipient, "imessage");

      return {
        content: [
          {
            type: "text",
            text: `Sent iMessage to ${recipient} (thread_id: ${threadId}).`,
          },
        ],
        details: {
          threadId,
          channel: recipient,
          source: "imessage",
          adapter: result.adapter,
          messageId: result.messageId,
        },
      };
    },
  });
}
