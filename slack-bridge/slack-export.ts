export type SlackExportFormat = "markdown" | "json" | "plain";

export interface SlackExportFileInput {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  permalink?: string;
  preview?: string;
}

export interface SlackExportMessageInput {
  ts?: string;
  authorName?: string;
  text?: string;
  files?: SlackExportFileInput[];
}

export interface BuildSlackThreadExportOptions {
  format?: string;
  includeMetadata?: boolean;
  threadTs: string;
  channelId: string;
  channelLabel?: string;
  messages: SlackExportMessageInput[];
  mentionNames?: Record<string, string>;
}

function decodeSlackEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function formatSlackToken(token: string, mentionNames: Record<string, string>): string {
  if (token.startsWith("@")) {
    const userId = token.slice(1);
    return `@${mentionNames[userId] ?? userId}`;
  }

  if (token.startsWith("#")) {
    const [, fallback] = token.split("|");
    return `#${fallback ?? token.slice(1)}`;
  }

  if (token.startsWith("!")) {
    if (token === "!here" || token === "!channel" || token === "!everyone") {
      return `@${token.slice(1)}`;
    }

    if (token.startsWith("!subteam^")) {
      const [, handle] = token.split("|");
      return `@${handle ?? "group"}`;
    }

    if (token.startsWith("!date^")) {
      const [, fallback] = token.split("|");
      return fallback ?? token;
    }

    return token.slice(1);
  }

  const [target, label] = token.split("|");
  if (!target) {
    return token;
  }

  if (target.startsWith("mailto:")) {
    const visible = label ?? target.slice("mailto:".length);
    return `[${visible}](${target})`;
  }

  if (target.startsWith("http://") || target.startsWith("https://")) {
    const visible = label ?? target;
    return `[${visible}](${target})`;
  }

  return label ?? target;
}

export function convertSlackMrkdwnToMarkdown(
  text: string,
  mentionNames: Record<string, string> = {},
): string {
  const decoded = decodeSlackEntities(text);
  const withTokens = decoded.replace(/<([^>]+)>/g, (_match, token: string) =>
    formatSlackToken(token, mentionNames),
  );

  return withTokens
    .replace(/(^|[\s(])\*(\S(?:[\s\S]*?\S)?)\*(?=$|[\s).,!?:;])/g, "$1**$2**")
    .replace(/(^|[\s(])~(\S(?:[\s\S]*?\S)?)~(?=$|[\s).,!?:;])/g, "$1~~$2~~");
}

export function normalizeSlackExportFormat(format?: string): SlackExportFormat {
  const normalized = format?.trim().toLowerCase() ?? "markdown";
  if (normalized === "markdown" || normalized === "json" || normalized === "plain") {
    return normalized;
  }
  throw new Error("format must be 'markdown', 'json', or 'plain'.");
}

export function parseSlackExportBoundaryTs(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Timestamp boundary cannot be empty.");
  }

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid timestamp boundary: ${value}`);
  }

  return parsed / 1000;
}

export function filterSlackExportMessagesByRange(
  messages: SlackExportMessageInput[],
  oldestTs?: number,
  latestTs?: number,
): SlackExportMessageInput[] {
  return messages.filter((message) => {
    const ts = message.ts ? Number.parseFloat(message.ts) : Number.NaN;
    if (!Number.isFinite(ts)) {
      return true;
    }
    if (oldestTs != null && ts < oldestTs) {
      return false;
    }
    if (latestTs != null && ts > latestTs) {
      return false;
    }
    return true;
  });
}

export function formatSlackExportTimestamp(ts?: string): string {
  if (!ts) {
    return "unknown time";
  }

  const numeric = Number.parseFloat(ts);
  if (!Number.isFinite(numeric)) {
    return ts;
  }

  return new Date(numeric * 1000).toISOString();
}

function buildSlackFileSummary(file: SlackExportFileInput): string {
  const label = file.title ?? file.name ?? "attachment";
  const type = file.filetype ?? file.mimetype;
  const parts = [`- ${label}`];

  if (type) {
    parts.push(`(${type})`);
  }
  if (file.id) {
    parts.push(`id=${file.id}`);
  }
  if (file.permalink) {
    parts.push(`— ${file.permalink}`);
  }

  let line = parts.join(" ");
  const preview = file.preview?.trim();
  if (preview) {
    line += `\n  Preview: ${preview}`;
  }

  return line;
}

function buildSlackExportHeader(
  options: BuildSlackThreadExportOptions,
  participants: string[],
): string[] {
  const header = ["# Slack Thread Export", ""];
  header.push(`- Thread: \`${options.threadTs}\``);
  header.push(
    options.channelLabel
      ? `- Channel: ${options.channelLabel} (\`${options.channelId}\`)`
      : `- Channel: \`${options.channelId}\``,
  );
  header.push(`- Messages: ${options.messages.length}`);
  if (participants.length > 0) {
    header.push(`- Participants: ${participants.join(", ")}`);
  }
  header.push("");
  return header;
}

function buildMarkdownExport(options: BuildSlackThreadExportOptions): string {
  const mentionNames = options.mentionNames ?? {};
  const participants = [
    ...new Set(options.messages.map((message) => message.authorName).filter(Boolean)),
  ];
  const lines = buildSlackExportHeader(options, participants as string[]);

  options.messages.forEach((message, index) => {
    const heading =
      options.includeMetadata !== false
        ? `## ${formatSlackExportTimestamp(message.ts)} — ${message.authorName ?? "unknown"}`
        : `## Message ${index + 1}`;
    lines.push(heading, "");

    const body = convertSlackMrkdwnToMarkdown(message.text ?? "", mentionNames).trim();
    lines.push(body || "(no text)");

    if ((message.files?.length ?? 0) > 0) {
      lines.push("", "Attachments:");
      for (const file of message.files ?? []) {
        lines.push(buildSlackFileSummary(file));
      }
    }

    lines.push("", "---", "");
  });

  return lines.join("\n").trim();
}

function buildPlainExport(options: BuildSlackThreadExportOptions): string {
  const mentionNames = options.mentionNames ?? {};
  const lines: string[] = [];

  for (const message of options.messages) {
    if (options.includeMetadata !== false) {
      lines.push(`[${formatSlackExportTimestamp(message.ts)}] ${message.authorName ?? "unknown"}`);
    }
    lines.push(
      convertSlackMrkdwnToMarkdown(message.text ?? "", mentionNames).trim() || "(no text)",
    );

    if ((message.files?.length ?? 0) > 0) {
      lines.push("Attachments:");
      for (const file of message.files ?? []) {
        lines.push(buildSlackFileSummary(file));
      }
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

function buildJsonExport(options: BuildSlackThreadExportOptions): string {
  const mentionNames = options.mentionNames ?? {};
  const payload = {
    format: "json",
    thread_ts: options.threadTs,
    channel: options.channelId,
    channel_label: options.channelLabel,
    include_metadata: options.includeMetadata !== false,
    message_count: options.messages.length,
    messages: options.messages.map((message, index) => ({
      index: index + 1,
      ...(options.includeMetadata !== false
        ? {
            ts: message.ts,
            timestamp: formatSlackExportTimestamp(message.ts),
            author: message.authorName ?? "unknown",
          }
        : {}),
      text: convertSlackMrkdwnToMarkdown(message.text ?? "", mentionNames),
      files: (message.files ?? []).map((file) => ({
        id: file.id,
        title: file.title,
        name: file.name,
        type: file.filetype ?? file.mimetype,
        permalink: file.permalink,
        preview: file.preview,
      })),
    })),
  };

  return JSON.stringify(payload, null, 2);
}

export function buildSlackThreadExport(options: BuildSlackThreadExportOptions): string {
  const format = normalizeSlackExportFormat(options.format);
  if (format === "json") {
    return buildJsonExport(options);
  }
  if (format === "plain") {
    return buildPlainExport(options);
  }
  return buildMarkdownExport(options);
}
