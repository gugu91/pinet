import {
  classifyPinetMail,
  formatPinetMailClassLabel,
  type PinetMailClass,
} from "@pinet/broker-core/mail-classification";

export interface PinetInboxItem {
  inboxId: number;
  delivered: boolean;
  readAt: string | null;
  message: {
    id: number;
    threadId: string;
    source: string;
    direction: string;
    sender: string;
    body: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  };
}

export interface PinetReadMessage {
  inboxId: number;
  delivered: boolean;
  readAt: string | null;
  message: PinetInboxItem["message"];
}

export interface PinetUnreadThreadSummary {
  threadId: string;
  source: string;
  channel: string;
  unreadCount: number;
  latestMessageId: number;
  latestAt: string;
  highestMailClass: PinetMailClass;
  mailClassCounts: Record<PinetMailClass, number>;
}

export interface PinetReadResult {
  messages: PinetReadMessage[];
  unreadCountBefore: number;
  unreadCountAfter: number;
  unreadThreads: PinetUnreadThreadSummary[];
  markedReadIds: number[];
}

export interface PinetReadOptions {
  threadId?: string;
  limit?: number;
  unreadOnly?: boolean;
  markRead?: boolean;
}

function truncateText(value: string, maxLength = 180): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatPinetReadResultFull(
  result: PinetReadResult,
  options: PinetReadOptions,
): string {
  const scope = options.threadId ? `thread ${options.threadId}` : "your Pinet inbox";
  const mode = options.unreadOnly === false ? "latest" : "unread";
  const lines = [
    `Pinet read (${mode}) from ${scope}: ${result.messages.length} message${result.messages.length === 1 ? "" : "s"}.`,
    `Unread before: ${result.unreadCountBefore}; unread after: ${result.unreadCountAfter}.`,
  ];

  if (result.messages.length > 0) {
    lines.push("");
    for (const item of result.messages) {
      const classification = classifyPinetMail({
        source: item.message.source,
        threadId: item.message.threadId,
        sender: item.message.sender,
        body: item.message.body,
        metadata: item.message.metadata,
      });
      const label = formatPinetMailClassLabel(classification.class);
      lines.push(
        `- [${label}] [${item.message.source}/${item.message.threadId} #${item.message.id}] ${item.message.sender}: ${item.message.body}`,
      );
    }
  }

  if (result.unreadThreads.length > 0) {
    lines.push("", "Unread thread pointers:");
    for (const thread of result.unreadThreads.slice(0, 10)) {
      const label = formatPinetMailClassLabel(thread.highestMailClass);
      const counts = summarizeUnreadThreadCounts(thread);
      lines.push(
        `- [${label}] ${thread.threadId} (${thread.source}${thread.channel ? `/${thread.channel}` : ""}): ${thread.unreadCount} unread${counts ? ` (${counts})` : ""}; latest #${thread.latestMessageId}; pointer=pinet action=read args.thread_id=${thread.threadId} args.unread_only=true`,
      );
    }
  }

  if (result.markedReadIds.length > 0) {
    lines.push("", `Marked read: ${result.markedReadIds.join(", ")}.`);
  }

  return lines.join("\n");
}

export function summarizeUnreadThreadCounts(thread: PinetUnreadThreadSummary): string {
  return [
    thread.mailClassCounts.steering > 0 ? `${thread.mailClassCounts.steering} steering` : null,
    thread.mailClassCounts.fwup > 0 ? `${thread.mailClassCounts.fwup} fwup` : null,
    thread.mailClassCounts.maintenance_context > 0
      ? `${thread.mailClassCounts.maintenance_context} maintenance/context`
      : null,
  ]
    .filter((item): item is string => Boolean(item))
    .join(", ");
}

export function buildCompactPinetReadDetails(result: PinetReadResult): Record<string, unknown> {
  return {
    messageCount: result.messages.length,
    unreadCountBefore: result.unreadCountBefore,
    unreadCountAfter: result.unreadCountAfter,
    markedReadIds: result.markedReadIds,
    messages: result.messages.map((item) => {
      const classification = classifyPinetMail({
        source: item.message.source,
        threadId: item.message.threadId,
        sender: item.message.sender,
        body: item.message.body,
        metadata: item.message.metadata,
      });
      return {
        inboxId: item.inboxId,
        messageId: item.message.id,
        threadId: item.message.threadId,
        source: item.message.source,
        sender: item.message.sender,
        class: classification.class,
        preview: truncateText(item.message.body),
      };
    }),
    unreadThreads: result.unreadThreads.slice(0, 10).map((thread) => ({
      threadId: thread.threadId,
      source: thread.source,
      unreadCount: thread.unreadCount,
      latestMessageId: thread.latestMessageId,
      highestMailClass: thread.highestMailClass,
      mailClassSummary: summarizeUnreadThreadCounts(thread),
    })),
  };
}

export function formatPinetReadResultCompact(
  result: PinetReadResult,
  options: PinetReadOptions,
): string {
  const mode = options.unreadOnly === false ? "latest" : "unread";
  const markedSuffix =
    result.markedReadIds.length > 0 ? `; marked ${result.markedReadIds.length}` : "";
  const unreadThreadSuffix =
    result.unreadThreads.length > 0
      ? `; ${result.unreadThreads.length} unread thread${result.unreadThreads.length === 1 ? "" : "s"}`
      : "";

  return `Pinet read: ${result.messages.length} ${mode} message${result.messages.length === 1 ? "" : "s"}; unread ${result.unreadCountBefore}→${result.unreadCountAfter}${markedSuffix}${unreadThreadSuffix}.`;
}
