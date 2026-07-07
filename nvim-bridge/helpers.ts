import { buildContextThreadId, type CommentRecord } from "./comments.js";

export interface EditorState {
  file: string | null;
  line: number | null;
  visibleStart: number | null;
  visibleEnd: number | null;
  selectionStart: number | null;
  selectionEnd: number | null;
}

export type NvimEvent =
  | { type: "buffer_focus"; file: string; line: number }
  | { type: "visible_range"; file: string; start: number; end: number }
  | { type: "selection"; file: string; start: number; end: number }
  | { type: "trigger_agent"; prompt: string };

export type CommentRpcRequest =
  | {
      id: string;
      type: "comment.list" | "comment.sync";
      payload: { threadId?: string; limit?: number };
    }
  | {
      id: string;
      type: "comment.list_all";
      payload: { limit?: number };
    }
  | {
      id: string;
      type: "comment.add";
      payload: {
        body: string;
        threadId?: string;
        actorType?: string;
        actorId?: string;
        context?: {
          file?: string;
          startLine?: number;
          endLine?: number;
        };
      };
    };

type NvimRpcJsonPrimitive = string | number | boolean | null;
export type NvimRpcJsonValue = NvimRpcJsonPrimitive | NvimRpcJsonObject | NvimRpcJsonValue[];
export interface NvimRpcJsonObject {
  [key: string]: NvimRpcJsonValue;
}

function asNvimRpcObject(value: unknown): NvimRpcJsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as NvimRpcJsonObject;
}

export function toPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

export function formatContext(state: EditorState): string {
  if (!state.file) return "";

  let msg = `User is viewing ${state.file}`;

  if (state.visibleStart != null && state.visibleEnd != null) {
    msg += `, lines ${state.visibleStart}-${state.visibleEnd}`;
  }

  if (state.line != null) {
    msg += ` (cursor at line ${state.line})`;
  }

  if (state.selectionStart != null && state.selectionEnd != null) {
    msg += `, selection on lines ${state.selectionStart}-${state.selectionEnd}`;
  }

  msg += ".";
  return msg;
}

export function parseNvimEvent(value: unknown): NvimEvent | null {
  const event = asNvimRpcObject(value);
  if (!event || typeof event.type !== "string") return null;

  switch (event.type) {
    case "buffer_focus": {
      const line = toPositiveInteger(event.line);
      if (typeof event.file !== "string" || line == null) return null;
      return {
        type: "buffer_focus",
        file: event.file,
        line,
      };
    }

    case "visible_range": {
      const start = toPositiveInteger(event.start);
      const end = toPositiveInteger(event.end);
      if (typeof event.file !== "string" || start == null || end == null) return null;
      return {
        type: "visible_range",
        file: event.file,
        start,
        end,
      };
    }

    case "selection": {
      const start = toPositiveInteger(event.start);
      const end = toPositiveInteger(event.end);
      if (typeof event.file !== "string" || start == null || end == null) return null;
      return {
        type: "selection",
        file: event.file,
        start,
        end,
      };
    }

    case "trigger_agent": {
      if (typeof event.prompt !== "string") return null;
      return {
        type: "trigger_agent",
        prompt: event.prompt,
      };
    }

    default:
      return null;
  }
}

export function parseCommentRpcRequest(value: unknown): CommentRpcRequest | null {
  const request = asNvimRpcObject(value);
  if (
    !request ||
    typeof request.id !== "string" ||
    !request.id.trim() ||
    typeof request.type !== "string"
  ) {
    return null;
  }

  if (request.type === "comment.list" || request.type === "comment.sync") {
    const payload = asNvimRpcObject(request.payload) ?? {};
    const limit = toPositiveInteger(payload.limit);
    return {
      id: request.id,
      type: request.type,
      payload: {
        threadId: typeof payload.threadId === "string" ? payload.threadId : undefined,
        limit: limit ?? undefined,
      },
    };
  }

  if (request.type === "comment.list_all") {
    const payload = asNvimRpcObject(request.payload) ?? {};
    const limit = toPositiveInteger(payload.limit);
    return {
      id: request.id,
      type: "comment.list_all",
      payload: {
        limit: limit ?? undefined,
      },
    };
  }

  if (request.type === "comment.add") {
    const payload = asNvimRpcObject(request.payload);
    if (!payload || typeof payload.body !== "string") return null;

    const context = asNvimRpcObject(payload.context);

    return {
      id: request.id,
      type: "comment.add",
      payload: {
        body: payload.body,
        threadId: typeof payload.threadId === "string" ? payload.threadId : undefined,
        actorType: typeof payload.actorType === "string" ? payload.actorType : undefined,
        actorId: typeof payload.actorId === "string" ? payload.actorId : undefined,
        context: context
          ? {
              file: typeof context.file === "string" ? context.file : undefined,
              startLine: toPositiveInteger(context.startLine) ?? undefined,
              endLine: toPositiveInteger(context.endLine) ?? undefined,
            }
          : undefined,
      },
    };
  }

  return null;
}

function formatCommentContext(comment: CommentRecord): string {
  if (!comment.context?.file) return "";

  if (comment.context.startLine != null && comment.context.endLine != null) {
    return ` (${comment.context.file}:${comment.context.startLine}-${comment.context.endLine})`;
  }

  return ` (${comment.context.file})`;
}

function getCurrentCommentContext(state: EditorState): {
  file: string;
  startLine: number;
  endLine: number;
} | null {
  if (!state.file) return null;

  const startLine = state.selectionStart ?? state.line;
  const endLine = state.selectionEnd ?? state.line;
  if (startLine == null || endLine == null) return null;

  const normalizedStart = Math.min(startLine, endLine);
  const normalizedEnd = Math.max(startLine, endLine);

  return {
    file: state.file,
    startLine: normalizedStart,
    endLine: normalizedEnd,
  };
}

function commentMatchesCurrentContext(comment: CommentRecord, state: EditorState): boolean {
  const current = getCurrentCommentContext(state);
  if (!current || !comment.context?.file || comment.context.file !== current.file) {
    return false;
  }

  const startLine = comment.context.startLine ?? comment.context.endLine;
  const endLine = comment.context.endLine ?? comment.context.startLine;
  if (startLine == null || endLine == null) return false;

  if (current.startLine !== current.endLine) {
    return startLine === current.startLine && endLine === current.endLine;
  }

  return startLine <= current.startLine && endLine >= current.startLine;
}

function formatCommentForRead(comment: CommentRecord): string {
  const actor = `${comment.actorType}:${comment.actorId}`;
  const contextSuffix = formatCommentContext(comment);
  const bodyLines = comment.body.split(/\r?\n/);
  const firstLine = bodyLines.shift() ?? "";

  let chunk = `- ${actor}${contextSuffix}`;
  if (firstLine.trim()) {
    chunk += ` — ${firstLine.trim()}`;
  }

  if (bodyLines.length > 0) {
    const remainder = bodyLines.join("\n").trim();
    if (remainder) {
      chunk += `\n  ${remainder.replace(/\n/g, "\n  ")}`;
    }
  }

  return `${chunk}\n`;
}

export function buildPiCommsReadPrompt(
  state: EditorState,
  comments: CommentRecord[],
  totalCount: number,
  maxChars = 18000,
): { prompt: string; included: number; truncated: boolean } {
  const header: string[] = ["Apply these persistent PiComms comments as guidance for the task."];

  const context = formatContext(state);
  if (context) {
    header.push(`Current editor context: ${context}`);
  }

  const currentContext = getCurrentCommentContext(state);
  const currentThreadId = buildContextThreadId(currentContext ?? undefined);

  const prioritized = [...comments].sort((a, b) => {
    const aRelevant =
      (currentThreadId != null && a.threadId === currentThreadId) ||
      commentMatchesCurrentContext(a, state);
    const bRelevant =
      (currentThreadId != null && b.threadId === currentThreadId) ||
      commentMatchesCurrentContext(b, state);
    if (aRelevant !== bRelevant) {
      return aRelevant ? -1 : 1;
    }
    return a.createdAt.localeCompare(b.createdAt);
  });

  const relevantComments = prioritized.filter(
    (comment) =>
      (currentThreadId != null && comment.threadId === currentThreadId) ||
      commentMatchesCurrentContext(comment, state),
  );
  const otherComments = prioritized.filter((comment) => !relevantComments.includes(comment));

  const sections: string[] = [];
  let usedChars = 0;
  let included = 0;

  const appendSection = (title: string, items: CommentRecord[]): void => {
    if (items.length === 0) return;

    let section = `${title}:\n`;
    let sectionIncluded = 0;

    for (const comment of items) {
      const chunk = formatCommentForRead(comment);
      if (usedChars + section.length + chunk.length > maxChars && included > 0) {
        break;
      }

      section += chunk;
      usedChars += chunk.length;
      included += 1;
      sectionIncluded += 1;
    }

    if (sectionIncluded > 0) {
      sections.push(section.trimEnd());
    }
  };

  appendSection("Most relevant PiComms", relevantComments);
  appendSection("Other PiComms in this repository", otherComments);

  const truncated = included < totalCount;
  const footer: string[] = [`Loaded comments: ${included}/${totalCount}.`];
  if (truncated) {
    footer.push("Some comments were omitted due to prompt size limits.");
  }

  return {
    prompt: `${header.join("\n")}\n\n${sections.join("\n\n")}\n\n${footer.join("\n")}`.trim(),
    included,
    truncated,
  };
}
