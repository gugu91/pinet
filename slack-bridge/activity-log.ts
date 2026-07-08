import type { SlackResult } from "./slack-api.js";

export type ActivityLogLevel = "errors" | "actions" | "verbose";
export type ActivityLogTone = "info" | "success" | "warning" | "error";

export interface ActivityLogField {
  label: string;
  value: string | number | boolean | null | undefined;
}

export interface ActivityLogEntry {
  kind: string;
  level: ActivityLogLevel;
  title: string;
  summary: string;
  details?: string[];
  fields?: ActivityLogField[];
  tone?: ActivityLogTone;
  timestamp?: string;
}

export interface LoggedActivityLogEntry extends ActivityLogEntry {
  timestamp: string;
}

export type ActivityLogSlackBlock = Record<string, unknown>;

export interface ActivityLogPostMessageBody extends Record<string, unknown> {
  channel: string;
  text: string;
  blocks: ActivityLogSlackBlock[];
  thread_ts?: string;
}

interface QueuedActivityLogEntry {
  entry: LoggedActivityLogEntry;
  attempts: number;
}

export interface SlackActivityLoggerDeps {
  getBotToken: () => string | undefined;
  getLogChannel: () => string | undefined;
  getLogLevel: () => string | undefined;
  getAgentName: () => string;
  getAgentEmoji: () => string;
  resolveChannel: (nameOrId: string) => Promise<string>;
  slack: (method: string, token: string, body?: ActivityLogPostMessageBody) => Promise<SlackResult>;
  onError?: (error: unknown) => void;
  now?: () => Date;
  maxRecentEntries?: number;
}

const LEVEL_RANK: Record<ActivityLogLevel, number> = {
  errors: 0,
  actions: 1,
  verbose: 2,
};

const DEFAULT_MAX_RECENT_ENTRIES = 100;
const MAX_TEXT_LENGTH = 2800;
const REDACTED = "[REDACTED]";

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replaceAll("\u0000", "").trim();
}

function truncate(value: string, maxLength = MAX_TEXT_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function normalizeActivityLogLevel(value: string | undefined): ActivityLogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "errors" || normalized === "actions" || normalized === "verbose") {
    return normalized;
  }
  return "actions";
}

export function shouldLogActivity(
  configuredLevel: ActivityLogLevel,
  eventLevel: ActivityLogLevel,
): boolean {
  return LEVEL_RANK[eventLevel] <= LEVEL_RANK[configuredLevel];
}

export function redactSensitiveText(value: string): string {
  let redacted = normalizeWhitespace(value);

  const replacements: Array<[RegExp, string]> = [
    [/xox[baprs]-[A-Za-z0-9-]+/g, REDACTED],
    [/xoxe\.[A-Za-z0-9.-]+/g, REDACTED],
    [/(Bearer\s+)[^\s]+/gi, `$1${REDACTED}`],
    [
      /\b(token|password|secret|api[_-]?key|authorization)\b\s*([:=])\s*([^\s,;]+)/gi,
      `$1$2 ${REDACTED}`,
    ],
    [
      /("(?:token|password|secret|api[_-]?key|authorization)"\s*:\s*")([^"]+)(")/gi,
      `$1${REDACTED}$3`,
    ],
    [/(SLACK_[A-Z_]+)=([^\s]+)/g, `$1=${REDACTED}`],
  ];

  for (const [pattern, replacement] of replacements) {
    redacted = redacted.replace(pattern, replacement);
  }

  return truncate(redacted);
}

function sanitizeFieldValue(value: ActivityLogField["value"]): string {
  if (value == null) {
    return "—";
  }
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  return redactSensitiveText(String(value));
}

function sanitizeEntry(entry: ActivityLogEntry, now: Date): LoggedActivityLogEntry {
  return {
    ...entry,
    title: redactSensitiveText(entry.title),
    summary: redactSensitiveText(entry.summary),
    details: entry.details?.map((detail) => redactSensitiveText(detail)).filter(Boolean),
    fields: entry.fields
      ?.map((field) => ({
        label: redactSensitiveText(field.label),
        value: sanitizeFieldValue(field.value),
      }))
      .filter((field) => field.label.length > 0),
    timestamp: entry.timestamp ?? now.toISOString(),
  };
}

function getToneEmoji(tone: ActivityLogTone | undefined): string {
  switch (tone) {
    case "success":
      return "✅";
    case "warning":
      return "⚠️";
    case "error":
      return "🚨";
    case "info":
    default:
      return "📡";
  }
}

function formatSlackTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toISOString().replace(".000Z", "Z");
}

export function buildActivityLogText(
  agentName: string,
  agentEmoji: string,
  entry: LoggedActivityLogEntry,
): string {
  return `${getToneEmoji(entry.tone)} ${entry.title} — ${entry.summary} (${agentEmoji} ${agentName} · ${formatSlackTimestamp(entry.timestamp)})`;
}

export function buildActivityLogBlocks(
  agentName: string,
  agentEmoji: string,
  entry: LoggedActivityLogEntry,
): ActivityLogSlackBlock[] {
  const blocks: ActivityLogSlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${getToneEmoji(entry.tone)} ${entry.title}*\n${entry.summary}`,
      },
    },
  ];

  const fields = (entry.fields ?? [])
    .filter((field) => field.value !== "—")
    .slice(0, 10)
    .map((field) => ({
      type: "mrkdwn",
      text: `*${field.label}*\n${field.value}`,
    }));
  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }

  if (entry.details && entry.details.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: entry.details.map((detail) => `• ${detail}`).join("\n"),
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${agentEmoji} ${agentName} · ${entry.kind} · ${formatSlackTimestamp(entry.timestamp)}`,
      },
    ],
  });

  return blocks;
}

export function buildActivityLogThreadHeader(
  agentName: string,
  agentEmoji: string,
  dateKey: string,
): { text: string; blocks: ActivityLogSlackBlock[] } {
  return {
    text: `Pinet activity log — ${dateKey}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*📚 Pinet activity log — ${dateKey}*\nBroker-side coordination updates: assignments, completions, merges, stalls, and RALPH maintenance events.`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${agentEmoji} ${agentName} · daily thread`,
          },
        ],
      },
    ],
  };
}

export function formatRecentActivityLogEntries(
  entries: ReadonlyArray<LoggedActivityLogEntry>,
): string {
  if (entries.length === 0) {
    return "No activity log entries recorded in this session.";
  }

  return entries
    .map((entry) => `[${formatSlackTimestamp(entry.timestamp)}] ${entry.title} — ${entry.summary}`)
    .join("\n");
}

export class SlackActivityLogger {
  private readonly queue: QueuedActivityLogEntry[] = [];
  private readonly recent: LoggedActivityLogEntry[] = [];
  private readonly maxRecentEntries: number;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushRunning = false;
  private resolvedChannelCache: { raw: string; id: string } | null = null;
  private dailyThreadCache: { rawChannel: string; dateKey: string; threadTs: string } | null = null;

  constructor(private readonly deps: SlackActivityLoggerDeps) {
    this.maxRecentEntries = deps.maxRecentEntries ?? DEFAULT_MAX_RECENT_ENTRIES;
  }

  log(entry: ActivityLogEntry): void {
    const rawChannel = this.deps.getLogChannel()?.trim();
    if (!rawChannel) {
      return;
    }

    const configuredLevel = normalizeActivityLogLevel(this.deps.getLogLevel());
    if (!shouldLogActivity(configuredLevel, entry.level)) {
      return;
    }

    const sanitized = sanitizeEntry(entry, this.getNow());
    this.recent.unshift(sanitized);
    this.recent.splice(this.maxRecentEntries);
    this.queue.push({ entry: sanitized, attempts: 0 });
    this.scheduleFlush(0);
  }

  getRecentEntries(limit = 20): LoggedActivityLogEntry[] {
    return this.recent.slice(0, Math.max(0, limit));
  }

  clearPending(): void {
    this.queue.splice(0, this.queue.length);
    this.resolvedChannelCache = null;
    this.dailyThreadCache = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private getNow(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer || this.flushRunning || this.queue.length === 0) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNext();
    }, delayMs);
    this.flushTimer.unref?.();
  }

  private async flushNext(): Promise<void> {
    if (this.flushRunning) {
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      return;
    }

    this.flushRunning = true;
    try {
      await this.postEntry(next.entry);
    } catch (error) {
      if (next.attempts < 2) {
        this.queue.unshift({ entry: next.entry, attempts: next.attempts + 1 });
      } else {
        this.deps.onError?.(error);
      }
    } finally {
      this.flushRunning = false;
      if (this.queue.length > 0) {
        this.scheduleFlush(1000);
      }
    }
  }

  private async resolveLogChannel(rawChannel: string): Promise<string> {
    if (this.resolvedChannelCache?.raw === rawChannel) {
      return this.resolvedChannelCache.id;
    }

    const channelId = await this.deps.resolveChannel(rawChannel);
    this.resolvedChannelCache = { raw: rawChannel, id: channelId };
    return channelId;
  }

  private async ensureDailyThread(rawChannel: string, channelId: string): Promise<string> {
    const dateKey = this.getNow().toISOString().slice(0, 10);
    if (
      this.dailyThreadCache?.rawChannel === rawChannel &&
      this.dailyThreadCache.dateKey === dateKey
    ) {
      return this.dailyThreadCache.threadTs;
    }

    const token = this.deps.getBotToken();
    if (!token) {
      throw new Error("Slack bot token unavailable for activity logging.");
    }

    const heading = buildActivityLogThreadHeader(
      this.deps.getAgentName(),
      this.deps.getAgentEmoji(),
      dateKey,
    );
    const response = await this.deps.slack("chat.postMessage", token, {
      channel: channelId,
      text: heading.text,
      blocks: heading.blocks,
    });

    const threadTs = typeof response.ts === "string" ? response.ts : null;
    if (!threadTs) {
      throw new Error("Slack activity log thread creation did not return a ts.");
    }

    this.dailyThreadCache = { rawChannel, dateKey, threadTs };
    return threadTs;
  }

  private async postEntry(entry: LoggedActivityLogEntry): Promise<void> {
    const rawChannel = this.deps.getLogChannel()?.trim();
    const token = this.deps.getBotToken();
    if (!rawChannel || !token) {
      return;
    }

    const channelId = await this.resolveLogChannel(rawChannel);
    const threadTs = await this.ensureDailyThread(rawChannel, channelId);

    await this.deps.slack("chat.postMessage", token, {
      channel: channelId,
      thread_ts: threadTs,
      text: buildActivityLogText(this.deps.getAgentName(), this.deps.getAgentEmoji(), entry),
      blocks: buildActivityLogBlocks(this.deps.getAgentName(), this.deps.getAgentEmoji(), entry),
    });
  }
}
