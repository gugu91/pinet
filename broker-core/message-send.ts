import type { TransportJsonObject, TransportRichBlock } from "@pinet/transport-core";
import type {
  BrokerMessage,
  MessageAdapter,
  NormalizedMessageContent,
  OutboundAttachmentFile,
  OutboundMessage,
  ThreadInfo,
} from "./types.js";

export interface BrokerMessageSenderDb {
  getThread(threadId: string): ThreadInfo | null;
  getDocumentRecipients?(documentId: string): string[];
  createThread(
    threadId: string,
    source: string,
    channel: string,
    ownerAgent: string | null,
  ): ThreadInfo;
  updateThread(threadId: string, updates: Partial<ThreadInfo>): void;
  claimThread(threadId: string, agentId: string, source?: string, channel?: string): boolean;
  insertMessage(
    threadId: string,
    source: string,
    direction: "inbound" | "outbound",
    sender: string,
    body: string,
    targetAgentIds: string[],
    metadata?: TransportJsonObject,
  ): BrokerMessage;
}

export interface BrokerMessageSenderDeps {
  db: BrokerMessageSenderDb;
  adapters: ReadonlyArray<Pick<MessageAdapter, "name" | "send">>;
}

export interface SendBrokerMessageInput {
  threadId: string;
  body: string;
  senderAgentId: string;
  source?: string;
  channel?: string;
  content?: NormalizedMessageContent;
  blocks?: ReadonlyArray<TransportRichBlock>;
  files?: ReadonlyArray<OutboundAttachmentFile>;
  agentName?: string;
  agentEmoji?: string;
  agentOwnerToken?: string;
  metadata?: TransportJsonObject;
}

function normalizeMessageContent(
  content?: NormalizedMessageContent,
): NormalizedMessageContent | undefined {
  if (!content) {
    return undefined;
  }

  const text = content.text.trim();
  if (!text) {
    throw new Error("content.text is required when content is provided.");
  }

  const markdown = content.markdown?.trim();
  return {
    text,
    ...(markdown ? { markdown } : {}),
    ...(content.slackBlocks && content.slackBlocks.length > 0
      ? { slackBlocks: content.slackBlocks }
      : {}),
  };
}

export interface SendBrokerMessageResult {
  thread: ThreadInfo;
  message: BrokerMessage;
  adapter: string;
}

export async function sendBrokerMessage(
  deps: BrokerMessageSenderDeps,
  input: SendBrokerMessageInput,
): Promise<SendBrokerMessageResult> {
  const threadId = input.threadId.trim();
  const body = input.body.trim();
  if (!threadId || !body) {
    throw new Error("threadId and body are required.");
  }

  const existingThread = deps.db.getThread(threadId);
  if (existingThread?.source === "agent" && threadId.startsWith("wakeup:")) {
    // A scheduled wake-up has no sender to answer, so the reply stays in the owner's thread history.
    if (existingThread.ownerAgent !== input.senderAgentId) {
      throw new Error(`Wake-up thread ${threadId} belongs to another agent.`);
    }
    const message = deps.db.insertMessage(
      threadId,
      "agent",
      "outbound",
      input.senderAgentId,
      body,
      [],
    );
    return { thread: existingThread, message, adapter: "agent" };
  }
  const source = (input.source ?? existingThread?.source ?? "").trim();
  const channel = (input.channel ?? existingThread?.channel ?? "").trim();

  if (!source) {
    throw new Error(`No transport source is recorded for thread ${threadId}.`);
  }
  if (!channel) {
    throw new Error(`No transport channel is recorded for thread ${threadId}.`);
  }

  const adapter = deps.adapters.find((candidate) => candidate.name === source);
  if (!adapter) {
    throw new Error(`No adapter is registered for transport source ${JSON.stringify(source)}.`);
  }

  const content = normalizeMessageContent(input.content);
  const messageBody = content?.text ?? body;

  let thread = existingThread;
  if (thread?.ownerAgent && thread.ownerAgent !== input.senderAgentId) {
    throw new Error(`Thread ${threadId} is already owned by another agent.`);
  }

  if (!thread || thread.ownerAgent === null) {
    const claimed = deps.db.claimThread(threadId, input.senderAgentId, source, channel);
    if (!claimed) {
      throw new Error(`Thread ${threadId} is already owned by another agent.`);
    }
    thread = deps.db.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} was claimed but could not be read back.`);
    }
  }

  if (thread.source !== source || thread.channel !== channel) {
    deps.db.updateThread(threadId, { source, channel });
    thread = { ...thread, source, channel };
  }

  const outbound: OutboundMessage = {
    threadId,
    channel,
    text: messageBody,
    ...(content ? { content } : {}),
    ...(input.blocks && input.blocks.length > 0 ? { blocks: input.blocks } : {}),
    ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
    ...(input.agentName ? { agentName: input.agentName } : {}),
    ...(input.agentEmoji ? { agentEmoji: input.agentEmoji } : {}),
    ...(input.agentOwnerToken ? { agentOwnerToken: input.agentOwnerToken } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  await adapter.send(outbound);

  const documentId =
    typeof thread.metadata?.documentId === "string" ? thread.metadata.documentId : null;
  const documentRecipients = documentId
    ? (deps.db.getDocumentRecipients?.(documentId) ?? []).filter(
        (agentId) => agentId !== input.senderAgentId,
      )
    : [];
  const message = deps.db.insertMessage(
    threadId,
    source,
    "outbound",
    input.senderAgentId,
    messageBody,
    [...new Set(documentRecipients)],
    {
      ...(input.metadata ?? {}),
      ...(documentId ? { documentId } : {}),
    },
  );

  return {
    thread,
    message,
    adapter: adapter.name,
  };
}
