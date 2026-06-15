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

const COMPACT_READ_DETAIL_LIMIT = 10;
const COMPACT_READ_TEXT_MESSAGE_LIMIT = 3;
const COMPACT_READ_PREVIEW_LENGTH = 96;

function truncateText(value: string, maxLength = COMPACT_READ_PREVIEW_LENGTH): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function classifyReadMessage(item: PinetReadMessage): PinetMailClass {
  return classifyPinetMail({
    source: item.message.source,
    threadId: item.message.threadId,
    sender: item.message.sender,
    body: item.message.body,
    metadata: item.message.metadata,
  }).class;
}

function formatCompactMessagePreview(item: PinetReadMessage): string {
  const label = formatPinetMailClassLabel(classifyReadMessage(item));
  return `- [${label}] [${item.message.source}/${item.message.threadId} #${item.message.id}] ${item.message.sender}: ${truncateText(item.message.body)}`;
}

function isMessageBodyTruncated(item: PinetReadMessage): boolean {
  return truncateText(item.message.body) !== item.message.body.replace(/\s+/g, " ").trim();
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
      const label = formatPinetMailClassLabel(classifyReadMessage(item));
      lines.push(
        `- [${label}] [${item.message.source}/${item.message.threadId} #${item.message.id}] ${item.message.sender}: ${item.message.body}`,
      );
    }
  }

  if (result.unreadThreads.length > 0) {
    lines.push("", "Unread thread pointers:");
    for (const thread of result.unreadThreads.slice(0, COMPACT_READ_DETAIL_LIMIT)) {
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
  const messages = result.messages.slice(0, COMPACT_READ_DETAIL_LIMIT);
  const unreadThreads = result.unreadThreads.slice(0, COMPACT_READ_DETAIL_LIMIT);
  const messageTruncated = Math.max(0, result.messages.length - messages.length);
  const unreadThreadTruncated = Math.max(0, result.unreadThreads.length - unreadThreads.length);
  const summaryParts = [
    `${result.messages.length} msg`,
    `unread ${result.unreadCountBefore}→${result.unreadCountAfter}`,
    result.markedReadIds.length > 0 ? `marked ${result.markedReadIds.length}` : null,
    result.unreadThreads.length > 0
      ? `${result.unreadThreads.length} unread thread${result.unreadThreads.length === 1 ? "" : "s"}`
      : null,
  ].filter((item): item is string => Boolean(item));

  const details: Record<string, unknown> = {
    summary: summaryParts.join("; "),
    messageCount: result.messages.length,
    unreadBefore: result.unreadCountBefore,
    unreadAfter: result.unreadCountAfter,
  };

  if (result.markedReadIds.length > 0) {
    details.markedReadCount = result.markedReadIds.length;
  }

  if (messages.length > 0) {
    details.messages = messages.map((item) => ({
      id: item.message.id,
      threadId: item.message.threadId,
      source: item.message.source,
      sender: item.message.sender,
      class: classifyReadMessage(item),
    }));
    details.exactBodies = "args.full=true args.unread_only=false";
  }

  if (messageTruncated > 0) {
    details.messagesTruncated = messageTruncated;
  }

  if (unreadThreads.length > 0) {
    details.unreadThreads = unreadThreads.map((thread) => ({
      threadId: thread.threadId,
      source: thread.source,
      unread: thread.unreadCount,
      latestMessageId: thread.latestMessageId,
      class: thread.highestMailClass,
      summary: summarizeUnreadThreadCounts(thread),
    }));
  }

  if (unreadThreadTruncated > 0) {
    details.unreadThreadsTruncated = unreadThreadTruncated;
  }

  return details;
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
  const lines = [
    `Pinet read: ${result.messages.length} ${mode} message${result.messages.length === 1 ? "" : "s"}; unread ${result.unreadCountBefore}→${result.unreadCountAfter}${markedSuffix}${unreadThreadSuffix}.`,
  ];

  if (options.threadId && result.messages.length > 0) {
    const shownMessages = result.messages.slice(0, COMPACT_READ_TEXT_MESSAGE_LIMIT);
    lines.push(...shownMessages.map(formatCompactMessagePreview));
    const truncated = result.messages.length - shownMessages.length;
    if (truncated > 0) {
      lines.push(`… ${truncated} more message${truncated === 1 ? "" : "s"}.`);
    }
    if (truncated > 0 || shownMessages.some(isMessageBodyTruncated)) {
      lines.push("Use args.full=true args.unread_only=false for exact bodies.");
    }
  }

  return lines.join("\n");
}
