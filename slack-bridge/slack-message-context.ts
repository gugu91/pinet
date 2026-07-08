type SlackMessageContextObject = Record<string, unknown>;

export interface SlackMessageContextEvent extends SlackMessageContextObject {
  blocks?: unknown;
  attachments?: unknown;
  files?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asRecord(value: unknown): SlackMessageContextObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as SlackMessageContextObject)
    : null;
}

function asRecordArray(value: unknown): SlackMessageContextObject[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is SlackMessageContextObject => typeof item === "object" && item !== null,
      )
    : [];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipLine(value: string, maxLength = 220): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function pushContextLine(lines: string[], rawValue: string | null | undefined): void {
  if (!rawValue) return;
  const normalized = clipLine(normalizeWhitespace(rawValue));
  if (!normalized) return;
  lines.push(normalized);
}

function extractTextObject(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return [];

  const text = asString(record.text);
  return text ? [text] : [];
}

function extractRichTextElementText(element: SlackMessageContextObject): string[] {
  const type = asString(element.type) ?? "";

  switch (type) {
    case "text": {
      const text = asString(element.text);
      return text ? [text] : [];
    }
    case "link": {
      const text = asString(element.text);
      const url = asString(element.url);
      if (text && url && text !== url) {
        return [`${text} (${url})`];
      }
      return text ? [text] : url ? [url] : [];
    }
    case "emoji": {
      const name = asString(element.name);
      return name ? [`:${name}:`] : [];
    }
    case "user": {
      const userId = asString(element.user_id);
      return userId ? [`<@${userId}>`] : [];
    }
    case "channel": {
      const channelId = asString(element.channel_id);
      return channelId ? [`<#${channelId}>`] : [];
    }
    case "rich_text_section":
    case "rich_text_list":
    case "rich_text_quote":
    case "rich_text_preformatted": {
      return asRecordArray(element.elements).flatMap((child) => extractRichTextElementText(child));
    }
    default:
      return [];
  }
}

function extractBlockContextLines(blocks: unknown): string[] {
  const lines: string[] = [];

  for (const block of asRecordArray(blocks)) {
    const type = asString(block.type) ?? "";

    switch (type) {
      case "header":
      case "section": {
        for (const value of extractTextObject(block.text)) {
          pushContextLine(lines, value);
        }
        for (const field of asRecordArray(block.fields)) {
          for (const value of extractTextObject(field)) {
            pushContextLine(lines, value);
          }
        }
        break;
      }
      case "context": {
        for (const element of asRecordArray(block.elements)) {
          for (const value of extractTextObject(element)) {
            pushContextLine(lines, value);
          }
        }
        break;
      }
      case "image": {
        pushContextLine(lines, asString(block.alt_text));
        break;
      }
      case "rich_text": {
        for (const element of asRecordArray(block.elements)) {
          const text = extractRichTextElementText(element).join("");
          pushContextLine(lines, text);
        }
        break;
      }
      default:
        break;
    }
  }

  return lines;
}

function extractAttachmentContextLines(attachments: unknown): string[] {
  const lines: string[] = [];

  for (const attachment of asRecordArray(attachments)) {
    pushContextLine(lines, asString(attachment.pretext));
    pushContextLine(lines, asString(attachment.title));
    pushContextLine(lines, asString(attachment.text));
    pushContextLine(lines, asString(attachment.fallback));
    pushContextLine(lines, asString(attachment.footer));
    lines.push(...extractBlockContextLines(attachment.blocks));
  }

  return lines;
}

export interface SlackMessageFileMetadata {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  prettyType?: string;
  permalink?: string;
  mode?: string;
  size?: number;
}

export function extractSlackMessageFileMetadata(files: unknown): SlackMessageFileMetadata[] {
  const extracted: SlackMessageFileMetadata[] = [];

  for (const file of asRecordArray(files)) {
    const metadata: SlackMessageFileMetadata = {
      ...(asString(file.id) ? { id: asString(file.id) ?? undefined } : {}),
      ...(asString(file.name) ? { name: asString(file.name) ?? undefined } : {}),
      ...(asString(file.title) ? { title: asString(file.title) ?? undefined } : {}),
      ...(asString(file.mimetype) ? { mimetype: asString(file.mimetype) ?? undefined } : {}),
      ...(asString(file.filetype) ? { filetype: asString(file.filetype) ?? undefined } : {}),
      ...(asString(file.pretty_type)
        ? { prettyType: asString(file.pretty_type) ?? undefined }
        : {}),
      ...(asString(file.permalink) ? { permalink: asString(file.permalink) ?? undefined } : {}),
      ...(asString(file.mode) ? { mode: asString(file.mode) ?? undefined } : {}),
      ...(typeof file.size === "number" ? { size: file.size } : {}),
    };

    if (Object.keys(metadata).length === 0) continue;
    extracted.push(metadata);
  }

  return extracted;
}

function extractFileContextLines(files: unknown): string[] {
  const lines: string[] = [];

  for (const file of extractSlackMessageFileMetadata(files)) {
    const title = file.title ?? file.name;
    const prettyType = file.prettyType ?? file.filetype ?? file.mimetype;
    const parts = [
      title,
      prettyType,
      file.mode,
      file.id ? `id=${file.id}` : null,
      file.permalink ?? null,
    ].filter((part): part is string => Boolean(part));
    if (parts.length === 0) continue;

    pushContextLine(lines, parts.join(" — "));
  }

  return lines;
}

function dedupeContextLines(baseText: string, lines: string[]): string[] {
  const baseNormalized = normalizeWhitespace(baseText).toLowerCase();
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const line of lines) {
    const normalized = normalizeWhitespace(line).toLowerCase();
    if (!normalized) continue;
    if (baseNormalized && normalized === baseNormalized) {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(line);
  }

  return deduped;
}

export function extractSlackMessageContextLines(
  evt: SlackMessageContextEvent,
  baseText = "",
): string[] {
  const lines = [
    ...extractBlockContextLines(evt.blocks),
    ...extractAttachmentContextLines(evt.attachments),
    ...extractFileContextLines(evt.files),
  ];

  return dedupeContextLines(baseText, lines).slice(0, 4);
}

export function buildSlackInboundMessageText(
  baseText: string,
  evt: SlackMessageContextEvent,
): string {
  const trimmedBase = baseText.trim();
  const contextLines = extractSlackMessageContextLines(evt, trimmedBase);

  if (contextLines.length === 0) {
    return trimmedBase;
  }

  const prefix = trimmedBase.length > 0 ? trimmedBase : "(Slack message had no plain-text body)";
  return `${prefix}\n\nSlack message context:\n${contextLines.map((line) => `- ${line}`).join("\n")}`;
}
