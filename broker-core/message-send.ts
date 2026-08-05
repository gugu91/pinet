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
  getMessageByExternalId(source: string, externalId: string): BrokerMessage | null;
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

/**
 * The target transport thread is owned by a different agent. Permanent for
 * this sender: retrying the identical send cannot succeed unless ownership
 * changes, so callers should treat it as a terminal delivery outcome rather
 * than a transient failure.
 */
export class ThreadOwnershipConflictError extends Error {
  readonly threadId: string;

  constructor(threadId: string) {
    super(`Thread ${threadId} is already owned by another agent.`);
    this.name = "ThreadOwnershipConflictError";
    this.threadId = threadId;
  }
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

  // Idempotent retry, checked before the ownership claim: a send that already
  // committed must stay recoverable even if thread ownership has since
  // changed, so the retry never re-claims or re-delivers. The committed
  // message must match the same thread, sender, and body — a reused key is a
  // collision, never permission to skip delivery for unrelated content.
  const rawExternalId = input.metadata?.externalId ?? input.metadata?.external_id;
  const explicitExternalId =
    typeof rawExternalId === "string" && rawExternalId.trim().length > 0 ? rawExternalId : null;
  if (explicitExternalId) {
    const committed = deps.db.getMessageByExternalId(source, explicitExternalId);
    if (committed) {
      if (
        committed.threadId !== threadId ||
        committed.sender !== input.senderAgentId ||
        committed.body !== messageBody
      ) {
        throw new Error(
          `Idempotency key collision for transport source ${JSON.stringify(source)}.`,
        );
      }
      if (!existingThread) {
        throw new Error(`Thread ${threadId} has a committed message but no thread record.`);
      }
      return { thread: existingThread, message: committed, adapter: adapter.name };
    }
  }

  let thread = existingThread;
  if (thread?.ownerAgent && thread.ownerAgent !== input.senderAgentId) {
    throw new ThreadOwnershipConflictError(threadId);
  }

  if (!thread || thread.ownerAgent === null) {
    const claimed = deps.db.claimThread(threadId, input.senderAgentId, source, channel);
    if (!claimed) {
      throw new ThreadOwnershipConflictError(threadId);
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

  const message = deps.db.insertMessage(
    threadId,
    source,
    "outbound",
    input.senderAgentId,
    messageBody,
    [],
    input.metadata,
  );

  return {
    thread,
    message,
    adapter: adapter.name,
  };
}
