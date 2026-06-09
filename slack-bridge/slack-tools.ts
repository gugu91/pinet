import os from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { InboxMessage } from "./helpers.js";
import type { SlackResult } from "./slack-api.js";
import {
  buildSlackCanvasCreateRequest,
  buildSlackCanvasEditRequest,
  buildSlackCanvasSectionsLookupRequest,
  extractSlackCanvasCommentsPage,
  extractSlackChannelCanvasId,
  normalizeSlackCanvasCommentsLimit,
  normalizeSlackCanvasCreateKind,
  normalizeSlackCanvasUpdateMode,
  pickSlackCanvasSectionId,
} from "./canvases.js";
import { normalizeSlackBlocksInput, summarizeSlackBlocksForPolicy } from "./slack-block-kit.js";
import { encodeSlackModalPrivateMetadata, normalizeSlackModalViewInput } from "./slack-modals.js";
import {
  findSlackPresenceDirectoryUser,
  formatSlackPresenceLine,
  formatSlackPresenceTimestamp,
  getBestSlackPresenceUserName,
  isSlackUserId,
  resolveSlackPresenceDndEndTs,
  stripSlackUserReference,
  type SlackDndInfoLike,
  type SlackPresenceDirectoryUser,
  type SlackPresenceSnapshot,
} from "./slack-presence.js";
import {
  buildSlackThreadExport,
  filterSlackExportMessagesByRange,
  parseSlackExportBoundaryTs,
} from "./slack-export.js";
import { normalizeReactionName } from "./reaction-triggers.js";
import { resolveScheduledWakeupFireAt } from "./scheduled-wakeups.js";
import { fetchSlackFileToCache, type SlackFileDescriptor } from "./slack-file-access.js";
import { extractSlackMessageFileMetadata } from "./slack-message-context.js";
import { performSlackUpload, performSlackUploads, prepareSlackUpload } from "./slack-upload.js";
import { TtlCache } from "./ttl-cache.js";
import {
  DEFAULT_SLACK_THREAD_STATUS,
  normalizeSlackThreadStatus,
  setSlackThreadStatus,
  SLACK_THREAD_LOADING_MESSAGES,
} from "./slack-thread-status.js";

export interface SlackToolsThreadContextPort {
  resolveThreadChannel: (threadTs: string | undefined) => Promise<string | null>;
  noteThreadReply: (threadTs: string, channelId: string) => void;
  clearPendingAttention: (threadTs: string) => void;
}

export interface SlackPinetDeliveryInput {
  threadId: string;
  channel: string;
  text: string;
  blocks?: ReadonlyArray<Record<string, unknown>>;
  files?: ReadonlyArray<{ path: string; filename?: string; title?: string; filetype?: string }>;
}

export interface SlackPinetDeliveryResult {
  adapter: string;
  messageId: number;
  threadId: string;
  channel: string;
  source: string;
}

export interface SlackPinetDeliveryPort {
  isAvailable: () => boolean;
  sendSlackMessage: (input: SlackPinetDeliveryInput) => Promise<SlackPinetDeliveryResult>;
}

export interface RegisterSlackToolsDeps {
  getBotToken: () => string;
  getDefaultChannel: () => string | undefined;
  getSecurityPrompt: () => string;
  inbox: InboxMessage[];
  slack: (method: string, token: string, body?: Record<string, unknown>) => Promise<SlackResult>;
  getAgentName: () => string;
  getAgentEmoji: () => string;
  getAgentOwnerToken: () => string;
  getLastDmChannel: () => string | null;
  updateBadge: () => void;
  resolveUser: (userId: string) => Promise<string>;
  threadContext: SlackToolsThreadContextPort;
  resolveChannel: (nameOrId: string) => Promise<string>;
  rememberChannel: (name: string, channelId: string) => void;
  requireToolPolicy: (toolName: string, threadTs: string | undefined, action: string) => void;
  registerConfirmationRequest: (
    threadTs: string,
    tool: string,
    action: string,
  ) => {
    status: "created" | "refreshed" | "conflict";
    conflict?: { toolPattern: string; action: string };
  };
  getBotUserId: () => string | null;
  pinetDelivery?: SlackPinetDeliveryPort;
}

type SlackDispatcherStatus = "succeeded" | "failed";
type SlackDispatcherErrorClass = "input" | "auth" | "network" | "rate-limit" | "not-found";

interface SlackDispatcherError {
  class: SlackDispatcherErrorClass;
  message: string;
  retryable: boolean;
  hint: string;
}

interface SlackDispatcherEnvelope {
  status: SlackDispatcherStatus;
  data: unknown;
  errors: SlackDispatcherError[];
  warnings: string[];
}

type SlackOutputFormat = "cli" | "json";

interface SlackOutputOptions {
  format: SlackOutputFormat;
  full: boolean;
}

const SLACK_OUTPUT_OPTION_PARAMETERS = {
  format: Type.Optional(
    Type.String({ description: 'Response presentation format: "cli" (default) or "json".' }),
  ),
  response_format: Type.Optional(
    Type.String({
      description:
        "Alias for response presentation format. Use this when an action already owns a format argument, such as export.",
    }),
  ),
  full: Type.Optional(
    Type.Boolean({
      description: "Include full structured details instead of compact default details.",
    }),
  ),
};

const SLACK_ACTIONS_WITH_FORMAT_ARG = new Set(["export"]);

const SLACK_LOCAL_FILE_ATTACHMENT_PARAMETERS = Type.Array(
  Type.Object({
    path: Type.String({
      description:
        "Local file path to attach. For safety, only files inside the current working directory or system temp directory are allowed.",
    }),
    filename: Type.Optional(Type.String({ description: "Optional Slack filename override" })),
    title: Type.Optional(Type.String({ description: "Optional Slack title" })),
    filetype: Type.Optional(Type.String({ description: "Optional Slack filetype override" })),
  }),
  { description: "Optional local files to attach to the same Slack message as text." },
);

interface SlackActionToolDefinition extends ToolDefinition {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: NonNullable<ToolDefinition["execute"]>;
}

const SLACK_DISPATCHER_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  react: [{ action: "react", args: { emoji: "👀", thread_ts: "1712345678.000100" } }],
  read: [{ action: "read", args: { thread_ts: "1712345678.000100", limit: 20 } }],
  upload: [
    {
      action: "upload",
      args: {
        content: "diff --git a/example b/example",
        filename: "changes.diff",
        filetype: "diff",
        thread_ts: "1712345678.000100",
      },
    },
  ],
  file: [
    {
      action: "file",
      args: {
        op: "download",
        file_id: "F0123456789",
        thread_ts: "1712345678.000100",
      },
    },
  ],
  schedule: [
    {
      action: "schedule",
      args: { text: "Follow-up reminder", thread_ts: "1712345678.000100", delay: "30m" },
    },
  ],
  presence: [{ action: "presence", args: { users: ["@alice", "U123456"] } }],
  export: [{ action: "export", args: { thread_ts: "1712345678.000100", format: "markdown" } }],
  status: [
    { action: "status", args: { thread_ts: "1712345678.000100", status: "Reading context…" } },
    { action: "status", args: { thread_ts: "1712345678.000100", clear: true } },
  ],
  post_channel: [
    {
      action: "post_channel",
      args: { channel: "#deployments", text: "Deploy complete" },
    },
    {
      action: "post_channel",
      args: {
        channel: "#deployments",
        text: "Deploy evidence attached",
        files: [{ path: "/tmp/evidence.png", filename: "evidence.png" }],
      },
    },
  ],
  read_channel: [{ action: "read_channel", args: { channel: "#deployments", limit: 20 } }],
  confirm_action: [
    {
      action: "confirm_action",
      args: {
        thread_ts: "1712345678.000100",
        tool: "slack:delete",
        action:
          "channel=#deployments | thread_ts=1712345678.000100 | ts=1712345678.000200 | thread=false",
      },
    },
  ],
  delete: [
    {
      action: "delete",
      args: { ts: "1712345678.000200", thread_ts: "1712345678.000100", confirm: true },
    },
  ],
  pin: [
    {
      action: "pin",
      args: { action: "pin", message_ts: "1712345678.000100", thread_ts: "1712345678.000100" },
    },
  ],
  bookmark: [
    {
      action: "bookmark",
      args: { action: "add", channel: "#project", title: "Runbook", url: "https://example.com" },
    },
  ],
  create_channel: [{ action: "create_channel", args: { name: "proj-alpha" } }],
  project_create: [{ action: "project_create", args: { name: "proj-alpha", topic: "Alpha" } }],
  canvas_comments_read: [
    { action: "canvas_comments_read", args: { canvas_id: "F0123", limit: 20 } },
  ],
  canvas_create: [
    { action: "canvas_create", args: { title: "Launch notes", markdown: "# Launch" } },
    {
      action: "canvas_create",
      args: { kind: "channel", channel: "#project", title: "Runbook", markdown: "# Runbook" },
    },
  ],
  canvas_update: [
    {
      action: "canvas_update",
      args: { canvas_id: "F0123", markdown: "## Update", mode: "append" },
    },
  ],
  modal_open: [
    {
      action: "modal_open",
      args: { trigger_id: "fresh-trigger-id", view: { type: "modal", blocks: [] } },
    },
  ],
  modal_push: [
    {
      action: "modal_push",
      args: { trigger_id: "fresh-trigger-id", view: { type: "modal", blocks: [] } },
    },
  ],
  modal_update: [
    {
      action: "modal_update",
      args: { view_id: "V123", view: { type: "modal", blocks: [] } },
    },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSlackDispatcherActionName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("slack action must be a string. Use action='help' to list available actions.");
  }

  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (!normalized) {
    throw new Error("slack action is required. Use action='help' to list available actions.");
  }
  if (normalized.startsWith("slack:")) return normalized.slice("slack:".length);
  if (normalized.startsWith("slack_")) return normalized.slice("slack_".length);
  return normalized;
}

function normalizeSlackGuardrailToolName(toolName: string): string {
  const normalized = toolName.trim().toLowerCase().replace(/-/g, "_");
  if (normalized.startsWith("slack:")) return normalized;
  if (
    normalized.startsWith("slack_") &&
    normalized !== "slack_inbox" &&
    normalized !== "slack_send"
  ) {
    return `slack:${normalized.slice("slack_".length)}`;
  }
  return toolName;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPinetDeliveryFallbackError(error: unknown): boolean {
  const lower = getErrorMessage(error).toLowerCase();
  if (lower.includes("already owned")) return false;
  return (
    lower.includes("not running") ||
    lower.includes("unexpected state") ||
    lower.includes("unavailable") ||
    lower.includes("not connected") ||
    lower.includes("disconnected") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("econn") ||
    lower.includes("socket") ||
    lower.includes("no transport source") ||
    lower.includes("no transport channel") ||
    lower.includes("only allows local file paths") ||
    lower.includes("no adapter") ||
    lower.includes("identity is unavailable")
  );
}

function classifySlackDispatcherError(error: unknown): SlackDispatcherError {
  const message = getErrorMessage(error);
  const lower = message.toLowerCase();

  if (
    lower.includes("not_authed") ||
    lower.includes("invalid_auth") ||
    lower.includes("token_revoked") ||
    lower.includes("missing_scope") ||
    lower.includes("access_denied")
  ) {
    return {
      class: "auth",
      message,
      retryable: false,
      hint: "Check Slack token configuration, app installation, channel membership, and required OAuth scopes.",
    };
  }

  if (lower.includes("rate_limited") || lower.includes("rate limit")) {
    return {
      class: "rate-limit",
      message,
      retryable: true,
      hint: "Wait for Slack rate limits to clear, then retry the same action if it is idempotent.",
    };
  }

  if (
    lower.includes("not_found") ||
    lower.includes("not found") ||
    lower.includes("channel_not_found") ||
    lower.includes("user_not_found") ||
    lower.includes("canvas_not_found") ||
    lower.includes("file_not_found")
  ) {
    return {
      class: "not-found",
      message,
      retryable: false,
      hint: "Verify Slack IDs, channel names, canvas/file IDs, and whether the bot can access the target.",
    };
  }

  if (lower.includes("files.getuploadurlexternal") && lower.includes("invalid_arguments")) {
    return {
      class: "input",
      message,
      retryable: false,
      hint: "Slack rejected upload metadata for files.getUploadURLExternal (invalid_arguments). Check filename and snippet_type; remove unsupported snippet extensions for inline content and retry.",
    };
  }

  if (lower.includes("slack raw upload failed")) {
    const rawStatusMatch = message.match(/Slack raw upload failed \(http\s*(\d{3})/i);
    const rawStatus = rawStatusMatch?.[1];

    if (rawStatus === "429") {
      return {
        class: "rate-limit",
        message,
        retryable: true,
        hint: "Wait for Slack rate limits to clear, then retry the same action if it is idempotent.",
      };
    }

    if (
      lower.includes("transport") ||
      lower.includes("network") ||
      lower.includes("fetch") ||
      lower.includes("timeout") ||
      lower.includes("econnreset") ||
      lower.includes("etimedout") ||
      lower.includes("possible outbound proxy/firewall block")
    ) {
      return {
        class: "network",
        message,
        retryable: true,
        hint: "Upload data-plane host is unavailable. Verify egress rules/proxy allowlist for files.slack.com and uploads.slack.com, then retry.",
      };
    }

    if (rawStatus && rawStatus.startsWith("5")) {
      return {
        class: "network",
        message,
        retryable: true,
        hint: "Retry after checking network connectivity. For write actions, verify whether Slack already applied the request before retrying.",
      };
    }

    if (rawStatus && rawStatus.startsWith("4")) {
      return {
        class: "input",
        message,
        retryable: false,
        hint: "Slack rejected the upload payload. Verify the upload URL/request metadata and retry; if this persists, classify as a Slack-side upload failure.",
      };
    }

    return {
      class: "network",
      message,
      retryable: true,
      hint: "Retry after checking network connectivity. For write actions, verify whether Slack already applied the request before retrying.",
    };
  }

  if (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("timeout") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout")
  ) {
    return {
      class: "network",
      message,
      retryable: true,
      hint: "Retry after checking network connectivity. For write actions, verify whether Slack already applied the request before retrying.",
    };
  }

  return {
    class: "input",
    message,
    retryable: false,
    hint: "Call slack with action='help' and args.topic set to the action name for the expected schema and examples.",
  };
}

function extractToolResponseText(response: unknown): string | undefined {
  if (!isRecord(response) || !Array.isArray(response.content)) return undefined;

  const lines = response.content
    .map((item) => {
      if (!isRecord(item)) return undefined;
      return typeof item.text === "string" ? item.text : undefined;
    })
    .filter((line): line is string => line != null && line.length > 0);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function extractToolResponseDetails(response: unknown): unknown {
  return isRecord(response) && "details" in response ? response.details : undefined;
}

function extractToolResponseFullDetails(response: unknown): unknown {
  return isRecord(response) && "fullDetails" in response ? response.fullDetails : undefined;
}

function normalizeSlackOutputOptions(action: string, args: unknown): SlackOutputOptions {
  if (args != null && !isRecord(args)) {
    throw new Error("slack args must be an object.");
  }

  const ownsFormatArg = SLACK_ACTIONS_WITH_FORMAT_ARG.has(action);
  const rawResponseFormat = isRecord(args) ? args.response_format : undefined;
  const rawFormat =
    rawResponseFormat ?? (isRecord(args) && !ownsFormatArg ? args.format : undefined);
  const normalizedFormat = rawFormat == null ? "cli" : String(rawFormat).trim().toLowerCase();
  if (normalizedFormat !== "cli" && normalizedFormat !== "json") {
    throw new Error(
      ownsFormatArg
        ? 'response_format must be "cli" or "json" when provided.'
        : 'format must be "cli" or "json" when provided.',
    );
  }
  const format: SlackOutputFormat = normalizedFormat;

  const rawFull = isRecord(args) ? args.full : undefined;
  if (rawFull != null && typeof rawFull !== "boolean") {
    throw new Error("full must be a boolean when provided.");
  }

  return { format, full: rawFull === true };
}

function getSlackEnvelopeCliText(envelope: SlackDispatcherEnvelope): string {
  if (envelope.status === "succeeded" && isRecord(envelope.data)) {
    const text = envelope.data.text;
    if (typeof text === "string" && text.length > 0) return text;
  }
  return JSON.stringify(envelope, null, 2);
}

function buildSlackDispatcherResponse(
  envelope: SlackDispatcherEnvelope,
  output: SlackOutputOptions = { format: "json", full: true },
): {
  content: Array<{ type: "text"; text: string }>;
  details: SlackDispatcherEnvelope;
} {
  return {
    content: [
      {
        type: "text",
        text:
          output.format === "json"
            ? JSON.stringify(envelope, null, 2)
            : getSlackEnvelopeCliText(envelope),
      },
    ],
    details: envelope,
  };
}

function buildSlackActionSuccessEnvelope(
  response: unknown,
  output: SlackOutputOptions = { format: "json", full: true },
): SlackDispatcherEnvelope {
  return {
    status: "succeeded",
    data: {
      text: extractToolResponseText(response),
      details: output.full
        ? (extractToolResponseFullDetails(response) ?? extractToolResponseDetails(response))
        : extractToolResponseDetails(response),
    },
    errors: [],
    warnings: [],
  };
}

function buildSlackActionFailureEnvelope(error: unknown): SlackDispatcherEnvelope {
  return {
    status: "failed",
    data: null,
    errors: [classifySlackDispatcherError(error)],
    warnings: [],
  };
}

function getSlackDispatcherExamples(action: string): Array<Record<string, unknown>> {
  return SLACK_DISPATCHER_EXAMPLES[action] ?? [{ action, args: {} }];
}

function buildSlackOutputControlsHelp(action?: string): Record<string, unknown> {
  const ownsFormatArg = action != null && SLACK_ACTIONS_WITH_FORMAT_ARG.has(action);
  return {
    format: ownsFormatArg
      ? "Reserved for this action's own payload format; use response_format for dispatcher output."
      : 'Optional response presentation: "cli" (default) or "json".',
    response_format:
      'Optional response presentation alias: "cli" (default) or "json". Prefer this when an action already owns a format argument.',
    full: "Optional boolean. Include full structured details instead of compact default details.",
  };
}

function truncateSlackText(value: string, maxLength = 180): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function buildSlackInboxPromptGuidelines(): string[] {
  return [
    "You are connected to Slack via the slack-bridge extension.",
    "When Slack messages arrive: ACK briefly, do the work, report blockers immediately, and report the outcome when done.",
    "Use slack_send for direct assistant-thread replies. Use the slack dispatcher for non-hot Slack actions such as reactions, reads, uploads, schedules, channel posts, pins, bookmarks, canvases, modals, presence, exports, and confirmations.",
    "Call slack with action='help' for the cold-action catalogue, or action='help' with args.topic for a specific action schema and examples.",
    "Security guardrails may be active for Slack-triggered actions. Cold Slack actions are checked with slack:<action> guardrail names.",
    "Slack emoji reactions are ignored by default. Only treat opt-in structured 'Reaction trigger from Slack:' inbox messages from authorized Pinet threads as user instructions tied to the referenced Slack message or thread; never infer work from a plain emoji reaction alone.",
  ];
}

function buildSlackSendPromptGuidelines(): string[] {
  return [
    "Use slack_send for replies in the current Slack assistant thread; always reply where the task came from.",
    "For rich Block Kit JSON examples or modal/canvas patterns, load the slack-bridge skill instead of relying on tool schemas.",
  ];
}

function getSlackCanvasSummary(markdown?: string): string {
  if (markdown == null || markdown.length === 0) return "(empty canvas)";
  const collapsed = markdown.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 80) return collapsed;
  return `${collapsed.slice(0, 77)}...`;
}

function normalizeOptionalSlackCursor(cursor?: string): string | undefined {
  const trimmed = cursor?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function buildSlackCanvasCommentsSummaryText(input: {
  canvasId: string;
  title?: string;
  commentsCount: number;
  returnedCount: number;
  nextCursor?: string;
  comments: Array<{
    userName?: string;
    userId?: string;
    createdTs?: string;
    text: string;
  }>;
}): string {
  const label = input.title ? `${input.title} (${input.canvasId})` : input.canvasId;
  const lines = [
    `Canvas comments for ${label}`,
    `Returned ${input.returnedCount} of ${input.commentsCount} comment(s).`,
  ];

  if (input.comments.length === 0) {
    lines.push("(no comments)");
  } else {
    for (const comment of input.comments) {
      const author = comment.userName ?? comment.userId ?? "unknown";
      const created = comment.createdTs ?? "unknown-ts";
      lines.push(`[${created}] ${author}: ${comment.text}`);
    }
  }

  if (input.nextCursor) {
    lines.push(`More comments are available. Re-run with cursor=${input.nextCursor}.`);
  }

  return lines.join("\n");
}

function isSlackMethodError(err: unknown, method: string, ...codes: string[]): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  return codes.some((code) => err.message.includes(`Slack ${method}: ${code}`));
}

function normalizeSlackPinAction(action: string): "pin" | "unpin" {
  const normalized = action.trim().toLowerCase();
  if (normalized === "pin" || normalized === "unpin") {
    return normalized;
  }
  throw new Error("action must be 'pin' or 'unpin'.");
}

function normalizeSlackBookmarkAction(action: string): "add" | "remove" | "list" {
  const normalized = action.trim().toLowerCase();
  if (normalized === "add" || normalized === "remove" || normalized === "list") {
    return normalized;
  }
  throw new Error("action must be 'add', 'remove', or 'list'.");
}

function normalizeSlackBookmarkUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("url is required when action='add'.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("url must be an absolute http(s) URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use http or https.");
  }

  return parsed.toString();
}

function asSlackObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedSlackString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface SlackReadFileAttachment {
  fileId?: string;
  messageTs: string;
  filename?: string;
  mimetype?: string;
  filetype?: string;
  prettyType?: string;
  size?: number;
  path?: string;
  sha256?: string;
  cacheDir?: string;
  expiresAt?: string;
  downloadStatus: "downloaded" | "failed" | "metadata-only";
  error?: string;
}

function extractSlackUploadMessageTs(
  response: Record<string, unknown>,
  channelId: string,
): string | undefined {
  const files = Array.isArray(response.files) ? response.files : [];
  for (const fileValue of files) {
    const file = asSlackObject(fileValue);
    const shares = asSlackObject(file?.shares);
    for (const shareKind of ["public", "private"] as const) {
      const shareByChannel = asSlackObject(shares?.[shareKind]);
      const channelShares = shareByChannel?.[channelId];
      if (!Array.isArray(channelShares)) continue;
      for (const shareValue of channelShares) {
        const share = asSlackObject(shareValue);
        const ts = asTrimmedSlackString(share?.ts);
        if (ts) return ts;
      }
    }
  }

  return undefined;
}

function extractSlackCanvasPermalink(response: Record<string, unknown>): string | undefined {
  const direct =
    asTrimmedSlackString(response.permalink) ??
    asTrimmedSlackString(response.url) ??
    asTrimmedSlackString(response.link);
  if (direct) return direct;

  const canvas = asSlackObject(response.canvas);
  const canvasLink =
    asTrimmedSlackString(canvas?.permalink) ??
    asTrimmedSlackString(canvas?.url) ??
    asTrimmedSlackString(canvas?.link);
  if (canvasLink) return canvasLink;

  const file = asSlackObject(response.file);
  return asTrimmedSlackString(file?.permalink);
}

function isPiAgentSlackMessage(
  message: Record<string, unknown>,
  botUserId: string | null,
  agentOwnerToken: string,
): boolean {
  const messageUser = typeof message.user === "string" ? message.user : undefined;
  if (messageUser) {
    return botUserId != null && messageUser === botUserId;
  }

  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") {
    return false;
  }

  if ((metadata as { event_type?: unknown }).event_type !== "pi_agent_msg") {
    return false;
  }

  const eventPayload = (metadata as { event_payload?: unknown }).event_payload;
  if (!eventPayload || typeof eventPayload !== "object") {
    return false;
  }

  return (eventPayload as { agent_owner?: unknown }).agent_owner === agentOwnerToken;
}

function summarizeSlackDeleteAction(input: {
  channel?: string;
  defaultChannel?: string;
  threadTs?: string;
  ts: string;
  thread?: boolean;
}): string {
  return `channel=${input.channel ?? input.defaultChannel ?? ""} | thread_ts=${input.threadTs ?? ""} | ts=${input.ts} | thread=${input.thread ?? false}`;
}

export function registerSlackTools(pi: ExtensionAPI, deps: RegisterSlackToolsDeps): void {
  const {
    getBotToken,
    getDefaultChannel,
    getSecurityPrompt,
    inbox,
    slack,
    getAgentName,
    getAgentEmoji,
    getAgentOwnerToken,
    getLastDmChannel,
    updateBadge,
    resolveUser,
    threadContext,
    resolveChannel,
    rememberChannel,
    requireToolPolicy: requireToolPolicyForName,
    registerConfirmationRequest,
    getBotUserId,
    pinetDelivery,
  } = deps;

  async function resolveTrackedThreadChannel(threadTs: string | undefined): Promise<string | null> {
    return threadContext.resolveThreadChannel(threadTs);
  }

  function noteThreadReply(threadTs: string, channelId: string): void {
    threadContext.noteThreadReply(threadTs, channelId);
  }

  function clearPendingThreadAttention(threadTs: string): void {
    threadContext.clearPendingAttention(threadTs);
  }

  function requireToolPolicy(toolName: string, threadTs: string | undefined, action: string): void {
    requireToolPolicyForName(normalizeSlackGuardrailToolName(toolName), threadTs, action);
  }

  async function resolveSlackSendChannel(threadTs: string | undefined): Promise<string | null> {
    const trackedThreadChannel = await resolveTrackedThreadChannel(threadTs);
    if (trackedThreadChannel) return trackedThreadChannel;

    if (!threadTs) {
      const defaultChannel = getDefaultChannel();
      if (defaultChannel) return resolveChannel(defaultChannel);
      return null;
    }

    const lastDmChannel = getLastDmChannel();
    if (lastDmChannel) return lastDmChannel;

    return null;
  }

  async function deliverSlackMessage(input: {
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: Array<Record<string, unknown>>;
    files?: Array<{ path: string; filename?: string; title?: string; filetype?: string }>;
  }): Promise<{
    ts?: string;
    threadTs?: string;
    channel: string;
    blocksCount: number;
    delivery: "pinet" | "slack";
    adapter?: string;
    messageId?: number;
    fallbackReason?: string;
  }> {
    const blocks = input.blocks ? normalizeSlackBlocksInput(input.blocks) : undefined;
    let fallbackReason: string | undefined;

    if (input.threadTs && pinetDelivery) {
      try {
        if (pinetDelivery.isAvailable()) {
          const result = await pinetDelivery.sendSlackMessage({
            threadId: input.threadTs,
            channel: input.channel,
            text: input.text,
            ...(blocks ? { blocks } : {}),
            ...(input.files ? { files: input.files } : {}),
          });
          return {
            threadTs: input.threadTs,
            channel: result.channel,
            blocksCount: blocks?.length ?? 0,
            delivery: "pinet",
            adapter: result.adapter,
            messageId: result.messageId,
          };
        }
      } catch (error) {
        if (!isPinetDeliveryFallbackError(error)) throw error;
        fallbackReason = getErrorMessage(error);
      }
    }

    if (input.files && input.files.length > 0) {
      if (blocks && blocks.length > 0) {
        throw new Error(
          "Slack text+file replies use Slack's external upload flow, which does not support Block Kit blocks in the same upload message. Omit blocks or send a separate block-only message.",
        );
      }
      const uploads = await Promise.all(
        input.files.map((file) =>
          prepareSlackUpload(
            {
              path: file.path,
              ...(file.filename ? { filename: file.filename } : {}),
              ...(file.title ? { title: file.title } : {}),
              ...(file.filetype ? { filetype: file.filetype } : {}),
            },
            process.cwd(),
            os.tmpdir(),
          ),
        ),
      );
      const uploadResult = await performSlackUploads({
        uploads,
        channelId: input.channel,
        ...(input.threadTs ? { threadTs: input.threadTs } : {}),
        initialComment: input.text,
        slack,
        token: getBotToken(),
      });
      const uploadTs = extractSlackUploadMessageTs(uploadResult.response, input.channel);
      return {
        ...(uploadTs ? { ts: uploadTs } : {}),
        threadTs: input.threadTs ?? uploadTs,
        channel: input.channel,
        blocksCount: blocks?.length ?? 0,
        delivery: "slack",
        ...(fallbackReason ? { fallbackReason } : {}),
      };
    }

    const body: Record<string, unknown> = {
      channel: input.channel,
      text: input.text,
      metadata: {
        event_type: "pi_agent_msg",
        event_payload: { agent: getAgentName(), agent_owner: getAgentOwnerToken() },
      },
    };
    if (blocks) {
      body.blocks = blocks;
    }
    if (input.threadTs) body.thread_ts = input.threadTs;

    const response = await slack("chat.postMessage", getBotToken(), body);
    const message = isRecord(response.message) ? response.message : null;
    const ts = typeof message?.ts === "string" ? message.ts : undefined;
    return {
      ...(ts ? { ts } : {}),
      channel: input.channel,
      blocksCount: blocks?.length ?? 0,
      delivery: "slack",
      ...(fallbackReason ? { fallbackReason } : {}),
    };
  }

  const slackActionRegistry = new Map<string, SlackActionToolDefinition>();

  function registerSlackAction(definition: SlackActionToolDefinition): void {
    const action = normalizeSlackDispatcherActionName(definition.name);
    if (action === "help") {
      throw new Error("slack help is reserved for dispatcher schema discovery.");
    }
    slackActionRegistry.set(action, definition);
  }

  function buildSlackDispatcherHelpEnvelope(args: unknown): SlackDispatcherEnvelope {
    if (args != null && !isRecord(args)) {
      return buildSlackActionFailureEnvelope(new Error("slack help args must be an object."));
    }

    const topic = isRecord(args) && typeof args.topic === "string" ? args.topic : undefined;
    if (topic) {
      const action = normalizeSlackDispatcherActionName(topic);
      const definition = slackActionRegistry.get(action);
      if (!definition) {
        return buildSlackActionFailureEnvelope(
          new Error(`Unknown Slack action topic '${topic}'. Use action='help' to list actions.`),
        );
      }

      return {
        status: "succeeded",
        data: {
          action,
          summary: definition.description ?? "",
          guardrail_tool: `slack:${action}`,
          args_schema: definition.parameters ?? {},
          examples: getSlackDispatcherExamples(action),
          output_controls: buildSlackOutputControlsHelp(action),
        },
        errors: [],
        warnings: [],
      };
    }

    return {
      status: "succeeded",
      data: {
        actions: [
          {
            action: "help",
            summary: "List Slack dispatcher actions or return a specific action argument schema.",
            guardrail_tool: null,
          },
          ...[...slackActionRegistry.entries()].map(([action, definition]) => ({
            action,
            summary: definition.description ?? "",
            guardrail_tool: `slack:${action}`,
          })),
        ],
        output_controls: buildSlackOutputControlsHelp(),
      },
      errors: [],
      warnings: [],
    };
  }

  pi.registerTool({
    name: "slack",
    label: "Slack",
    description:
      "Dispatcher for non-hot Slack actions: react, read, upload, file, schedule, presence, export, post_channel, read_channel, confirm_action, delete, pin, bookmark, create_channel, project_create, canvas_comments_read, canvas_create, canvas_update, modal_open, modal_push, modal_update, and help. Use slack_inbox and slack_send for hot-path inbox/reply work.",
    promptSnippet:
      "Run non-hot Slack actions through a compact dispatcher. Use action='help' for the action catalogue or args.topic for a specific schema. Defaults to compact cli output; pass args.format='json' (or args.response_format='json' when the action owns format) or args.full=true for structured/full details.",
    promptGuidelines: [
      "Use slack_inbox and slack_send for the hot path. Use this dispatcher for every other Slack action.",
      "Cold actions are guarded as slack:<action>, for example slack:upload or slack:canvas_update.",
      "The dispatcher returns {status,data,errors,warnings}. On input errors, call action='help' with args.topic for the action schema.",
      "For Block Kit templates, modal patterns, and canvas examples, load the slack-bridge skill lazily.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description:
          "Action name: help | react | read | upload | file | schedule | presence | export | post_channel | read_channel | confirm_action | delete | pin | bookmark | create_channel | project_create | canvas_comments_read | canvas_create | canvas_update | modal_open | modal_push | modal_update",
      }),
      args: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            "Action arguments. Call slack with action='help' and args.topic='<action>' for the exact JSON schema and examples. Add format='cli'|'json' and full=true for explicit presentation control; use response_format when the action already has a format field.",
        }),
      ),
    }),
    async execute(_id, params) {
      try {
        const action = normalizeSlackDispatcherActionName(params.action);
        const args = params.args ?? {};

        let output: SlackOutputOptions;
        try {
          output = normalizeSlackOutputOptions(action, args);
        } catch (error) {
          return buildSlackDispatcherResponse(buildSlackActionFailureEnvelope(error));
        }

        if (action === "help") {
          return buildSlackDispatcherResponse(buildSlackDispatcherHelpEnvelope(args), output);
        }

        if (!isRecord(args)) {
          return buildSlackDispatcherResponse(
            buildSlackActionFailureEnvelope(new Error("slack args must be an object.")),
            output,
          );
        }

        const definition = slackActionRegistry.get(action);
        if (!definition) {
          return buildSlackDispatcherResponse(
            buildSlackActionFailureEnvelope(
              new Error(`Unknown Slack action '${action}'. Use action='help' to list actions.`),
            ),
            output,
          );
        }

        const response = await definition.execute(
          `slack:${action}`,
          args,
          undefined,
          undefined,
          undefined as unknown as ExtensionContext,
        );
        return buildSlackDispatcherResponse(
          buildSlackActionSuccessEnvelope(response, output),
          output,
        );
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        return buildSlackDispatcherResponse(buildSlackActionFailureEnvelope(error), {
          format: "json",
          full: true,
        });
      }
    },
  });

  type SlackCanvasFallbackResult = {
    canvasId: string;
    permalink?: string;
    permalinkLookupError?: string;
    bookmarkId?: string;
    bookmarkStatus: "added" | "skipped" | "failed";
    bookmarkError?: string;
  };

  async function createStandaloneCanvasFallback(input: {
    channelId: string;
    channelLabel: string;
    title?: string;
    markdown?: string;
  }): Promise<SlackCanvasFallbackResult> {
    const fallbackRequest = buildSlackCanvasCreateRequest({
      kind: "standalone",
      title: input.title,
      markdown: input.markdown,
      channelId: input.channelId,
    });

    let fallbackResponse: SlackResult;
    try {
      fallbackResponse = await slack(fallbackRequest.method, getBotToken(), fallbackRequest.body);
    } catch (fallbackErr) {
      const fallbackMessage =
        fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(
        `Slack channel canvas creation failed with canvas_tab_creation_failed, and standalone fallback creation also failed: ${fallbackMessage}. To recover manually, create a standalone canvas with channel=${input.channelLabel} and update/share it by canvas_id.`,
      );
    }

    const fallbackCanvasId = asTrimmedSlackString(fallbackResponse.canvas_id);
    if (!fallbackCanvasId) {
      throw new Error(
        `Slack channel canvas creation failed with canvas_tab_creation_failed, and standalone fallback creation did not return a canvas_id. To recover manually, create a standalone canvas with channel=${input.channelLabel} and update/share it by canvas_id.`,
      );
    }

    let permalink = extractSlackCanvasPermalink(fallbackResponse);
    let permalinkLookupError: string | undefined;
    if (!permalink) {
      try {
        const fileInfo = await slack("files.info", getBotToken(), { file: fallbackCanvasId });
        permalink = extractSlackCanvasPermalink(fileInfo);
      } catch (permalinkErr) {
        permalinkLookupError =
          permalinkErr instanceof Error ? permalinkErr.message : String(permalinkErr);
      }
    }

    let bookmarkId: string | undefined;
    let bookmarkStatus: "added" | "skipped" | "failed" = "skipped";
    let bookmarkError: string | undefined;
    if (permalink) {
      try {
        const title =
          input.title && input.title.trim().length > 0
            ? input.title.trim()
            : `Canvas ${fallbackCanvasId}`;
        const bookmarkResponse = await slack("bookmarks.add", getBotToken(), {
          channel_id: input.channelId,
          title,
          type: "link",
          link: normalizeSlackBookmarkUrl(permalink),
          emoji: ":memo:",
        });
        const bookmark = asSlackObject(bookmarkResponse.bookmark);
        bookmarkId = asTrimmedSlackString(bookmark?.id);
        bookmarkStatus = "added";
      } catch (bookmarkErr) {
        bookmarkStatus = "failed";
        bookmarkError = bookmarkErr instanceof Error ? bookmarkErr.message : String(bookmarkErr);
      }
    }

    return {
      canvasId: fallbackCanvasId,
      bookmarkStatus,
      ...(permalink ? { permalink } : {}),
      ...(permalinkLookupError ? { permalinkLookupError } : {}),
      ...(bookmarkId ? { bookmarkId } : {}),
      ...(bookmarkError ? { bookmarkError } : {}),
    };
  }

  function buildStandaloneCanvasFallbackBookmarkSummary(input: {
    channelLabel: string;
    canvasId: string;
    permalink?: string;
    permalinkLookupError?: string;
    bookmarkId?: string;
    bookmarkStatus: "added" | "skipped" | "failed";
    bookmarkError?: string;
  }): string {
    if (input.bookmarkStatus === "added") {
      return ` Bookmarked it in ${input.channelLabel}${input.bookmarkId ? ` as ${input.bookmarkId}` : ""}.`;
    }
    if (input.permalink) {
      return ` Could not bookmark it automatically${input.bookmarkError ? ` (${input.bookmarkError})` : ""}; add ${input.permalink} as a channel bookmark if you need a durable channel link.`;
    }
    return ` Slack did not expose a permalink${input.permalinkLookupError ? ` (${input.permalinkLookupError})` : ""}; use canvas_id=${input.canvasId} directly or add a bookmark manually once you have the canvas URL.`;
  }

  async function resolveCanvasTarget(
    canvasId: string | undefined,
    channel: string | undefined,
  ): Promise<{ canvasId: string; channelId?: string; channelLabel?: string }> {
    const trimmedCanvasId = canvasId?.trim();
    if (trimmedCanvasId) {
      return { canvasId: trimmedCanvasId };
    }

    const channelInput = channel?.trim();
    if (!channelInput) {
      throw new Error("Provide either canvas_id or channel.");
    }

    const channelId = await resolveChannel(channelInput);
    const info = await slack("conversations.info", getBotToken(), { channel: channelId });
    const resolvedCanvasId = extractSlackChannelCanvasId(info);
    if (!resolvedCanvasId) {
      throw new Error(
        `Slack did not expose a channel canvas ID in conversations.info for ${channelInput}. Provide canvas_id directly. If channel canvas tab creation failed earlier, use the standalone fallback canvas_id returned by canvas_create. Otherwise run canvas_create with kind='channel' and channel='${channelInput}'; if Slack rejects channel tab creation, canvas_create will auto-create and bookmark a standalone fallback. Use kind='standalone' only when you intentionally want to skip the channel-tab attempt.`,
      );
    }

    return {
      canvasId: resolvedCanvasId,
      channelId,
      channelLabel: channelInput,
    };
  }

  async function assertCanvasCommentsTargetIsCanvas(canvasId: string): Promise<void> {
    try {
      await slack("canvases.sections.lookup", getBotToken(), {
        canvas_id: canvasId,
        criteria: { section_types: ["any_header"] },
      });
    } catch (err) {
      if (isSlackMethodError(err, "canvases.sections.lookup", "canvas_deleted")) {
        throw new Error(`Canvas ${canvasId} is no longer available.`);
      }
      if (isSlackMethodError(err, "canvases.sections.lookup", "access_denied")) {
        throw new Error(`Canvas ${canvasId} is not accessible with the current bot token.`);
      }
      if (isSlackMethodError(err, "canvases.sections.lookup", "canvas_not_found")) {
        throw new Error(
          `Canvas ${canvasId} is unavailable, inaccessible, or not a canvas. This tool only reads comments for Slack canvases.`,
        );
      }
      throw err;
    }
  }

  async function resolveSlackTargetChannel(
    threadTs: string | undefined,
    channel: string | undefined,
  ): Promise<string> {
    const trackedThreadChannel = threadTs ? await resolveTrackedThreadChannel(threadTs) : null;
    if (trackedThreadChannel) {
      return trackedThreadChannel;
    }

    const channelInput = channel?.trim();
    if (channelInput) {
      return resolveChannel(channelInput);
    }

    if (!threadTs) {
      const dmChannel = getLastDmChannel();
      if (dmChannel) {
        return dmChannel;
      }

      const defaultChannel = getDefaultChannel();
      if (defaultChannel) {
        return resolveChannel(defaultChannel);
      }
    }

    throw new Error(
      threadTs
        ? "Unknown Slack thread. If you know the destination channel, pass channel explicitly."
        : "No active Slack thread. Provide channel or configure defaultChannel in settings.json.",
    );
  }

  async function fetchSlackThreadMessages(
    channelId: string,
    threadTs: string,
    oldest?: string,
    latest?: string,
    includeAllMetadata = false,
  ): Promise<Record<string, unknown>[]> {
    const messages: Record<string, unknown>[] = [];
    let cursor: string | undefined;

    do {
      const response = await slack("conversations.replies", getBotToken(), {
        channel: channelId,
        ts: threadTs,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
        ...(oldest ? { oldest } : {}),
        ...(latest ? { latest } : {}),
        ...(includeAllMetadata ? { include_all_metadata: true } : {}),
      });

      const batch = Array.isArray(response.messages)
        ? (response.messages as Record<string, unknown>[])
        : [];
      messages.push(...batch);

      const nextCursor = (response.response_metadata as { next_cursor?: string } | undefined)
        ?.next_cursor;
      cursor = typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : undefined;
    } while (cursor);

    return messages;
  }

  async function resolveSlackDeleteTargets(input: {
    channel?: string;
    threadTs?: string;
    ts: string;
    thread?: boolean;
  }): Promise<{ channelId: string; messageTsList: string[] }> {
    const channelId = await resolveSlackTargetChannel(input.threadTs, input.channel);
    const targetTs = input.ts.trim();
    if (!targetTs) {
      throw new Error("ts is required.");
    }

    if (!input.thread) {
      return { channelId, messageTsList: [targetTs] };
    }

    const messages = await fetchSlackThreadMessages(
      channelId,
      targetTs,
      undefined,
      undefined,
      true,
    );
    const threadRootTs =
      messages.length > 0 && typeof messages[0]?.ts === "string"
        ? (messages[0].ts as string)
        : undefined;
    if (!threadRootTs) {
      throw new Error(
        `Slack did not return a thread rooted at ${targetTs} in channel ${input.channel ?? channelId}.`,
      );
    }
    if (threadRootTs !== targetTs) {
      throw new Error("When thread=true, ts must be the thread root timestamp.");
    }

    const undeletableMessages = messages
      .filter((message) => !isPiAgentSlackMessage(message, getBotUserId(), getAgentOwnerToken()))
      .map((message) => (typeof message.ts === "string" ? message.ts : "unknown-ts"));
    if (undeletableMessages.length > 0) {
      throw new Error(
        `Cannot delete thread ${targetTs} because it includes message(s) not posted by the current bot: ${undeletableMessages.join(", ")}. Delete those messages individually instead.`,
      );
    }

    const messageTsList = messages
      .map((message) => (typeof message.ts === "string" ? message.ts : undefined))
      .filter((messageTs): messageTs is string => messageTs != null && messageTs.length > 0);
    if (messageTsList.length === 0) {
      throw new Error(`Slack did not return any deletable messages for thread ${targetTs}.`);
    }

    return {
      channelId,
      messageTsList: [...messageTsList.slice(1), messageTsList[0]],
    };
  }

  async function buildSlackExportPayload(messages: Record<string, unknown>[]): Promise<{
    mentionNames: Record<string, string>;
    authors: string[];
    messages: Array<{
      ts?: string;
      authorName?: string;
      text?: string;
      files?: Array<{
        name?: string;
        title?: string;
        mimetype?: string;
        id?: string;
        filetype?: string;
        permalink?: string;
        preview?: string;
      }>;
    }>;
  }> {
    const userIds = new Set<string>();

    for (const message of messages) {
      const userId = typeof message.user === "string" ? message.user : undefined;
      if (userId) {
        userIds.add(userId);
      }

      const text = typeof message.text === "string" ? message.text : "";
      for (const match of text.matchAll(/<@([A-Z0-9]+)>/g)) {
        if (match[1]) {
          userIds.add(match[1]);
        }
      }
    }

    const mentionNames = Object.fromEntries(
      await Promise.all(
        [...userIds].map(async (userId) => [userId, await resolveUser(userId)] as const),
      ),
    );

    const exportedMessages = messages.map((message) => {
      const userId = typeof message.user === "string" ? message.user : undefined;
      const authorName = userId
        ? mentionNames[userId]
        : typeof message.username === "string"
          ? message.username
          : typeof message.bot_id === "string"
            ? `bot:${message.bot_id}`
            : "bot";
      const rawFiles = Array.isArray(message.files)
        ? (message.files as Array<Record<string, unknown>>)
        : [];

      return {
        ts: typeof message.ts === "string" ? message.ts : undefined,
        authorName,
        text: typeof message.text === "string" ? message.text : "",
        files: rawFiles.map((file) => ({
          id: typeof file.id === "string" ? file.id : undefined,
          name: typeof file.name === "string" ? file.name : undefined,
          title: typeof file.title === "string" ? file.title : undefined,
          mimetype: typeof file.mimetype === "string" ? file.mimetype : undefined,
          filetype: typeof file.filetype === "string" ? file.filetype : undefined,
          permalink: typeof file.permalink === "string" ? file.permalink : undefined,
          preview: typeof file.preview === "string" ? file.preview : undefined,
        })),
      };
    });

    return {
      mentionNames,
      authors: [...new Set(exportedMessages.map((message) => message.authorName).filter(Boolean))],
      messages: exportedMessages,
    };
  }

  async function resolveReactionChannel(
    threadTs: string | undefined,
    channel: string | undefined,
  ): Promise<string> {
    const trackedThreadChannel = threadTs ? await resolveTrackedThreadChannel(threadTs) : null;
    if (trackedThreadChannel) {
      return trackedThreadChannel;
    }

    const channelInput = channel?.trim();
    if (channelInput) {
      return resolveChannel(channelInput);
    }

    throw new Error(
      threadTs
        ? "Unknown Slack thread. If you know the destination channel, pass channel explicitly."
        : "Provide channel when reacting to a message outside the current tracked thread.",
    );
  }

  async function resolveSlackModalThreadContext(
    threadTs: string | undefined,
  ): Promise<{ threadTs: string; channel: string } | null> {
    const normalizedThreadTs = threadTs?.trim();
    if (!normalizedThreadTs) {
      return null;
    }

    const channel = await resolveTrackedThreadChannel(normalizedThreadTs);
    if (!channel) {
      throw new Error(
        `No active Slack thread for thread_ts ${normalizedThreadTs}. Pass a live Slack thread so modal submissions can route back correctly.`,
      );
    }

    return {
      threadTs: normalizedThreadTs,
      channel,
    };
  }

  async function buildSlackModalView(
    view: unknown,
    threadTs: string | undefined,
  ): Promise<Record<string, unknown>> {
    const normalizedView = normalizeSlackModalViewInput(view);
    const threadContext = await resolveSlackModalThreadContext(threadTs);
    const privateMetadata =
      typeof normalizedView.private_metadata === "string"
        ? normalizedView.private_metadata
        : undefined;
    const encodedPrivateMetadata = encodeSlackModalPrivateMetadata(privateMetadata, threadContext);
    if (encodedPrivateMetadata !== undefined) {
      normalizedView.private_metadata = encodedPrivateMetadata;
    }
    return normalizedView;
  }

  function rethrowSlackModalError(err: unknown, action: "open" | "push" | "update"): never {
    if (isSlackMethodError(err, `views.${action}`, "invalid_trigger")) {
      throw new Error(
        `Slack trigger_id expired before views.${action} could run. Ask the user to click the button or retry the interaction again, then immediately reopen the modal.`,
      );
    }
    throw err;
  }

  const presenceCache = new TtlCache<string, SlackPresenceSnapshot>({
    maxSize: 512,
    ttlMs: 30_000,
  });
  let presenceDirectoryCache: { fetchedAt: number; users: SlackPresenceDirectoryUser[] } | null =
    null;

  function normalizeSlackPresenceTargets(
    user: string | undefined,
    users: string[] | undefined,
  ): string[] {
    const requested = [user, ...(users ?? [])]
      .map((value) => value?.trim() ?? "")
      .filter((value) => value.length > 0);

    if (requested.length === 0) {
      throw new Error("Provide user or users so Slack knows whose presence to check.");
    }

    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const value of requested) {
      const key = stripSlackUserReference(value).toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(value);
      }
    }
    return deduped;
  }

  async function listSlackPresenceDirectoryUsers(): Promise<SlackPresenceDirectoryUser[]> {
    const now = Date.now();
    if (presenceDirectoryCache && now - presenceDirectoryCache.fetchedAt <= 5 * 60_000) {
      return presenceDirectoryCache.users;
    }

    const users: SlackPresenceDirectoryUser[] = [];
    let cursor: string | undefined;

    do {
      const response = await slack("users.list", getBotToken(), {
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      const batch = Array.isArray(response.members)
        ? (response.members as SlackPresenceDirectoryUser[])
        : [];
      users.push(...batch.filter((member) => member.deleted !== true));

      const nextCursor = (response.response_metadata as { next_cursor?: string } | undefined)
        ?.next_cursor;
      cursor = typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : undefined;
    } while (cursor);

    presenceDirectoryCache = { fetchedAt: now, users };
    return users;
  }

  async function resolveSlackPresenceTarget(
    identifier: string,
  ): Promise<{ userId: string; userName?: string }> {
    const normalized = stripSlackUserReference(identifier);
    if (!normalized) {
      throw new Error("Slack user identifier cannot be empty.");
    }

    if (isSlackUserId(normalized)) {
      return { userId: normalized.toUpperCase() };
    }

    const users = await listSlackPresenceDirectoryUsers();
    const match = findSlackPresenceDirectoryUser(users, normalized);
    if (!match?.id) {
      throw new Error(`Slack user '${identifier}' was not found.`);
    }

    return {
      userId: match.id,
      userName: getBestSlackPresenceUserName(match),
    };
  }

  function parseSlackPresenceNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  }

  async function fetchSlackPresenceSnapshot(
    userId: string,
    userNameHint?: string,
  ): Promise<SlackPresenceSnapshot> {
    const cached = presenceCache.get(userId);
    if (cached) {
      if (userNameHint && cached.userName !== userNameHint) {
        const hydrated = { ...cached, userName: userNameHint };
        presenceCache.set(userId, hydrated);
        return hydrated;
      }
      return cached;
    }

    const [presenceResponse, dndResponse] = await Promise.all([
      slack("users.getPresence", getBotToken(), { user: userId }),
      slack("dnd.info", getBotToken(), { user: userId }),
    ]);

    const dndEndTs = resolveSlackPresenceDndEndTs(dndResponse as SlackDndInfoLike);
    const presenceValue =
      typeof presenceResponse.presence === "string" ? presenceResponse.presence : "unknown";
    const lastActivity = parseSlackPresenceNumber(presenceResponse.last_activity);
    const snapshot: SlackPresenceSnapshot = {
      userId,
      userName: userNameHint ?? (await resolveUser(userId)),
      presence: presenceValue,
      dndEnabled: dndResponse.dnd_enabled === true || dndResponse.snooze_enabled === true,
      dndEndTs,
      dndEndAt: formatSlackPresenceTimestamp(dndEndTs),
      autoAway: presenceResponse.auto_away === true,
      manualAway: presenceResponse.manual_away === true,
      connectionCount: parseSlackPresenceNumber(presenceResponse.connection_count),
      lastActivity,
      online:
        typeof presenceResponse.online === "boolean"
          ? presenceResponse.online
          : presenceValue === "active"
            ? true
            : presenceValue === "away"
              ? false
              : undefined,
    };

    presenceCache.set(userId, snapshot);
    return snapshot;
  }

  pi.registerTool({
    name: "slack_inbox",
    label: "Slack Inbox",
    description:
      "Return pending Slack messages that arrived since the last check, then clear the queue.",
    promptSnippet: "Check for new incoming Slack messages.",
    promptGuidelines: buildSlackInboxPromptGuidelines(),
    parameters: Type.Object({}),
    async execute() {
      const securityPrompt = getSecurityPrompt();
      const securityHeader = securityPrompt ? `${securityPrompt}\n\n` : "";
      const agentName = getAgentName();
      const agentEmoji = getAgentEmoji();

      if (inbox.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `${securityHeader}(no new messages) — you are ${agentEmoji} ${agentName}`,
            },
          ],
          details: { count: 0, messages: [] },
        };
      }

      const pending = inbox.splice(0, inbox.length);
      updateBadge();

      const lines: string[] = [];
      for (const message of pending) {
        const name = await resolveUser(message.userId);
        const prefix = message.isChannelMention
          ? `[thread ${message.threadTs}] (channel mention in <#${message.channel}>) ${name}`
          : `[thread ${message.threadTs}] ${name}`;
        const metadataSuffix =
          message.metadata?.kind === "slack_block_action"
            ? ` | metadata=${JSON.stringify({
                kind: message.metadata.kind,
                triggerId: message.metadata.triggerId ?? null,
                actionId: message.metadata.actionId ?? null,
                value: message.metadata.value ?? null,
                parsedValue: message.metadata.parsedValue ?? null,
                viewId: message.metadata.viewId ?? null,
              })}`
            : message.metadata?.kind === "slack_view_submission"
              ? ` | metadata=${JSON.stringify({
                  kind: message.metadata.kind,
                  triggerId: message.metadata.triggerId ?? null,
                  callbackId: message.metadata.callbackId ?? null,
                  viewId: message.metadata.viewId ?? null,
                  stateValues: message.metadata.stateValues ?? null,
                })}`
              : message.metadata?.kind
                ? ` | metadata.kind=${String(message.metadata.kind)}`
                : "";
        lines.push(`${prefix} (${message.timestamp}): ${message.text}${metadataSuffix}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `${securityHeader}You are ${agentEmoji} ${agentName}.\n\n${lines.join("\n")}`,
          },
        ],
        details: { count: pending.length, messages: pending },
      };
    },
  });

  registerSlackAction({
    name: "slack_modal_open",
    label: "Slack Modal Open",
    description: "Open a Slack modal with views.open using a fresh trigger_id.",
    promptSnippet: "Open a Slack modal to collect structured input or approvals.",
    parameters: Type.Object({
      trigger_id: Type.String({ description: "Fresh Slack trigger_id from a recent interaction" }),
      view: Type.Record(Type.String(), Type.Unknown(), {
        description: "Slack modal view JSON object (type='modal')",
      }),
      thread_ts: Type.Optional(
        Type.String({
          description:
            "Optional Slack thread to bind into private_metadata so view submissions route back into the thread",
        }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_modal_open",
        params.thread_ts,
        `thread_ts=${params.thread_ts ?? ""} | trigger_id=${params.trigger_id} | view=modal`,
      );

      try {
        const view = await buildSlackModalView(params.view, params.thread_ts);
        const response = await slack("views.open", getBotToken(), {
          trigger_id: params.trigger_id,
          view,
        });
        const modalView = response.view as Record<string, unknown> | undefined;
        return {
          content: [
            {
              type: "text",
              text: `Opened Slack modal${params.thread_ts ? ` for thread ${params.thread_ts}` : ""}.`,
            },
          ],
          details: {
            thread_ts: params.thread_ts ?? null,
            view_id: typeof modalView?.id === "string" ? modalView.id : null,
            external_id: typeof modalView?.external_id === "string" ? modalView.external_id : null,
            hash: typeof modalView?.hash === "string" ? modalView.hash : null,
            view,
          },
        };
      } catch (err) {
        rethrowSlackModalError(err, "open");
      }
    },
  });

  registerSlackAction({
    name: "slack_modal_push",
    label: "Slack Modal Push",
    description: "Push a new view onto an open Slack modal stack using views.push.",
    promptSnippet: "Push another Slack modal view for a multi-step workflow.",
    parameters: Type.Object({
      trigger_id: Type.String({ description: "Fresh Slack trigger_id from a recent interaction" }),
      view: Type.Record(Type.String(), Type.Unknown(), {
        description: "Slack modal view JSON object (type='modal')",
      }),
      thread_ts: Type.Optional(
        Type.String({
          description:
            "Optional Slack thread to bind into private_metadata so later submissions route back into the thread",
        }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_modal_push",
        params.thread_ts,
        `thread_ts=${params.thread_ts ?? ""} | trigger_id=${params.trigger_id} | view=modal`,
      );

      try {
        const view = await buildSlackModalView(params.view, params.thread_ts);
        const response = await slack("views.push", getBotToken(), {
          trigger_id: params.trigger_id,
          view,
        });
        const modalView = response.view as Record<string, unknown> | undefined;
        return {
          content: [
            {
              type: "text",
              text: `Pushed a new Slack modal view${params.thread_ts ? ` for thread ${params.thread_ts}` : ""}.`,
            },
          ],
          details: {
            thread_ts: params.thread_ts ?? null,
            view_id: typeof modalView?.id === "string" ? modalView.id : null,
            external_id: typeof modalView?.external_id === "string" ? modalView.external_id : null,
            hash: typeof modalView?.hash === "string" ? modalView.hash : null,
            view,
          },
        };
      } catch (err) {
        rethrowSlackModalError(err, "push");
      }
    },
  });

  registerSlackAction({
    name: "slack_modal_update",
    label: "Slack Modal Update",
    description: "Update an open Slack modal using views.update.",
    promptSnippet: "Update an existing Slack modal with a new view.",
    parameters: Type.Object({
      view: Type.Record(Type.String(), Type.Unknown(), {
        description: "Slack modal view JSON object (type='modal')",
      }),
      view_id: Type.Optional(
        Type.String({ description: "Slack view_id from a modal interaction" }),
      ),
      external_id: Type.Optional(Type.String({ description: "Slack external_id for the modal" })),
      hash: Type.Optional(
        Type.String({ description: "Optional modal hash for optimistic locking" }),
      ),
      thread_ts: Type.Optional(
        Type.String({
          description:
            "Optional Slack thread to bind into private_metadata so later submissions route back into the thread",
        }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_modal_update",
        params.thread_ts,
        `thread_ts=${params.thread_ts ?? ""} | view_id=${params.view_id ?? ""} | external_id=${params.external_id ?? ""} | view=modal`,
      );

      if (!params.view_id && !params.external_id) {
        throw new Error("Provide either view_id or external_id when updating a Slack modal.");
      }

      try {
        const view = await buildSlackModalView(params.view, params.thread_ts);
        const response = await slack("views.update", getBotToken(), {
          ...(params.view_id ? { view_id: params.view_id } : {}),
          ...(params.external_id ? { external_id: params.external_id } : {}),
          ...(params.hash ? { hash: params.hash } : {}),
          view,
        });
        const modalView = response.view as Record<string, unknown> | undefined;
        return {
          content: [
            {
              type: "text",
              text: `Updated Slack modal${params.view_id ? ` ${params.view_id}` : ""}.`,
            },
          ],
          details: {
            thread_ts: params.thread_ts ?? null,
            view_id: typeof modalView?.id === "string" ? modalView.id : (params.view_id ?? null),
            external_id:
              typeof modalView?.external_id === "string"
                ? modalView.external_id
                : (params.external_id ?? null),
            hash: typeof modalView?.hash === "string" ? modalView.hash : (params.hash ?? null),
            view,
          },
        };
      } catch (err) {
        rethrowSlackModalError(err, "update");
      }
    },
  });

  pi.registerTool({
    name: "slack_send",
    label: "Slack Send",
    description: "Send a message in a Slack assistant thread.",
    promptSnippet:
      "Reply in a Slack assistant thread. When you receive a task: ACK briefly, do the work, report blockers immediately, report the outcome when done. Always reply where the task came from.",
    promptGuidelines: buildSlackSendPromptGuidelines(),
    parameters: Type.Object({
      text: Type.String({ description: "Message text (Slack markdown)" }),
      thread_ts: Type.Optional(
        Type.String({
          description: "Thread to reply in. Omit to start a new conversation.",
        }),
      ),
      blocks: Type.Optional(
        Type.Array(Type.Record(Type.String(), Type.Unknown()), {
          description: "Optional Slack Block Kit blocks JSON array",
        }),
      ),
      files: Type.Optional(SLACK_LOCAL_FILE_ATTACHMENT_PARAMETERS),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_send",
        params.thread_ts,
        `thread_ts=${params.thread_ts ?? ""} | text=${params.text} | blocks=${summarizeSlackBlocksForPolicy(params.blocks)} | files=${Array.isArray(params.files) ? params.files.length : 0}`,
      );

      const channel = await resolveSlackSendChannel(params.thread_ts);
      if (!channel) {
        throw new Error(
          params.thread_ts
            ? "No active Slack thread. If you know the channel and thread_ts, use the slack dispatcher action post_channel instead."
            : "No active Slack thread and no defaultChannel configured in settings.json. Set slack-bridge.defaultChannel or use the slack dispatcher action post_channel with a channel.",
        );
      }

      const delivery = await deliverSlackMessage({
        channel,
        text: params.text,
        ...(params.thread_ts ? { threadTs: params.thread_ts } : {}),
        ...(params.blocks ? { blocks: params.blocks } : {}),
        ...(params.files ? { files: params.files } : {}),
      });
      const ts = delivery.ts;
      const threadTs = params.thread_ts ?? delivery.threadTs;
      const actualTs = threadTs ?? ts;
      if (!actualTs) {
        throw new Error("Slack delivery did not return a message timestamp.");
      }

      noteThreadReply(actualTs, channel);

      if (params.thread_ts) {
        clearPendingThreadAttention(params.thread_ts);
      }

      return {
        content: [
          {
            type: "text",
            text: params.thread_ts
              ? `Replied in thread ${params.thread_ts}.`
              : `Sent message (thread_ts: ${actualTs}). Use this to continue the conversation.`,
          },
        ],
        details: {
          ...(ts ? { ts } : {}),
          ...(threadTs ? { thread_ts: threadTs } : {}),
          channel,
          blocksCount: delivery.blocksCount,
          delivery: delivery.delivery,
          filesCount: Array.isArray(params.files) ? params.files.length : 0,
          ...(delivery.adapter ? { adapter: delivery.adapter } : {}),
          ...(delivery.messageId ? { messageId: delivery.messageId } : {}),
          ...(delivery.fallbackReason ? { fallbackReason: delivery.fallbackReason } : {}),
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_react",
    label: "Slack React",
    description: "Add an emoji reaction to a Slack message or thread root.",
    promptSnippet:
      "Add a reaction to a Slack thread root or message. Use this for lightweight acknowledgements like 👀, ✅, or 🔄.",
    parameters: Type.Object({
      emoji: Type.String({
        description:
          "Reaction emoji or Slack reaction name, e.g. 👀, ✅, :eyes:, or white_check_mark",
      }),
      thread_ts: Type.Optional(
        Type.String({
          description: "Tracked Slack thread. If timestamp is omitted, reacts to the thread root.",
        }),
      ),
      timestamp: Type.Optional(
        Type.String({
          description:
            "Specific message timestamp to react to. Defaults to thread_ts when omitted.",
        }),
      ),
      channel: Type.Optional(
        Type.String({
          description:
            "Optional channel name or ID. Required when reacting to a standalone message outside the current tracked thread.",
        }),
      ),
    }),
    async execute(_id, params) {
      const targetTimestamp = params.timestamp ?? params.thread_ts;
      if (!targetTimestamp) {
        throw new Error("Provide thread_ts or timestamp so Slack knows which message to react to.");
      }

      requireToolPolicy(
        "slack_react",
        params.thread_ts,
        `emoji=${params.emoji} | thread_ts=${params.thread_ts ?? ""} | timestamp=${targetTimestamp} | channel=${params.channel ?? ""}`,
      );

      const reactionName = normalizeReactionName(params.emoji);
      const channelId = await resolveReactionChannel(params.thread_ts, params.channel);

      await slack("reactions.add", getBotToken(), {
        channel: channelId,
        timestamp: targetTimestamp,
        name: reactionName,
      });

      return {
        content: [
          {
            type: "text",
            text: `Added :${reactionName}: to message ${targetTimestamp}.`,
          },
        ],
        details: {
          channel: channelId,
          timestamp: targetTimestamp,
          emoji: reactionName,
          ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}),
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_upload",
    label: "Slack Upload",
    description:
      "Upload a file or snippet into Slack using the external upload flow. Supports inline content and guarded local file paths.",
    promptSnippet:
      "Upload files, snippets, diffs, logs, screenshots, or generated artifacts into Slack threads when inline text would be awkward or too long.",
    parameters: Type.Object({
      content: Type.Optional(
        Type.String({
          description:
            "Inline content to upload as a snippet or file. Provide exactly one of content or path.",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description:
            "Local file path to upload. For safety, only files inside the current working directory or system temp directory are allowed.",
        }),
      ),
      filename: Type.Optional(
        Type.String({
          description:
            "Filename shown in Slack. Required for inline content, optional for path uploads.",
        }),
      ),
      filetype: Type.Optional(
        Type.String({
          description: "Optional filetype/snippet language override, e.g. diff, typescript, json.",
        }),
      ),
      title: Type.Optional(
        Type.String({ description: "Optional Slack title for the uploaded file" }),
      ),
      channel: Type.Optional(
        Type.String({
          description:
            "Optional channel name or ID. Omit to use the current thread channel, active DM, or defaultChannel.",
        }),
      ),
      thread_ts: Type.Optional(
        Type.String({ description: "Optional thread timestamp to attach the upload to" }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_upload",
        params.thread_ts,
        `thread_ts=${params.thread_ts ?? ""} | channel=${params.channel ?? getDefaultChannel() ?? ""} | filename=${params.filename ?? ""} | path=${params.path ?? ""} | content_length=${params.content?.length ?? 0}`,
      );

      const upload = await prepareSlackUpload(params, process.cwd(), os.tmpdir());
      const channelId = await resolveSlackTargetChannel(params.thread_ts, params.channel);
      const { fileId, response } = await performSlackUpload({
        upload,
        channelId,
        threadTs: params.thread_ts,
        slack,
        token: getBotToken(),
      });

      if (params.thread_ts) {
        noteThreadReply(params.thread_ts, channelId);
        clearPendingThreadAttention(params.thread_ts);
      }

      const uploadedFiles = Array.isArray(response.files)
        ? (response.files as Record<string, unknown>[])
        : [];
      const uploadedFile = uploadedFiles[0];
      const permalink =
        uploadedFile && typeof uploadedFile.permalink === "string"
          ? uploadedFile.permalink
          : undefined;

      return {
        content: [
          {
            type: "text",
            text: params.thread_ts
              ? `Uploaded \`${upload.filename}\` to thread ${params.thread_ts}.`
              : `Uploaded \`${upload.filename}\` to channel ${params.channel ?? channelId}.`,
          },
        ],
        details: {
          fileId,
          channel: channelId,
          filename: upload.filename,
          title: upload.title,
          source: upload.source,
          ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}),
          ...(permalink ? { permalink } : {}),
          ...(upload.resolvedPath ? { path: upload.resolvedPath } : {}),
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_file",
    label: "Slack File Access",
    description:
      "Download a Slack-hosted file from a known file ID, optionally verified against a thread/message, into controlled local temp cache storage without exposing private Slack URLs.",
    promptSnippet:
      "Use slack action=file with op=download to turn a Slack-hosted file_id from slackFiles metadata into a safe local file descriptor/path. Private Slack download URLs are never returned.",
    parameters: Type.Object({
      op: Type.String({ description: "Operation. Currently only download is supported." }),
      file_id: Type.String({ description: "Slack file ID, for example F0123456789." }),
      thread_ts: Type.Optional(
        Type.String({
          description:
            "Optional Slack thread timestamp. When provided, the file must appear in that thread.",
        }),
      ),
      message_ts: Type.Optional(
        Type.String({
          description:
            "Optional Slack message timestamp inside the thread. When provided, the file must appear on that exact message.",
        }),
      ),
      channel: Type.Optional(
        Type.String({
          description:
            "Optional channel name or ID. Omit when thread_ts is tracked by the Slack bridge.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (params.op !== "download") {
        throw new Error("slack file op must be download.");
      }
      requireToolPolicy(
        "slack_file",
        params.thread_ts,
        `op=download | file_id=${params.file_id} | thread_ts=${params.thread_ts ?? ""} | message_ts=${params.message_ts ?? ""} | channel=${params.channel ?? ""}`,
      );

      const channelId = params.thread_ts
        ? await resolveSlackTargetChannel(params.thread_ts, params.channel)
        : params.channel
          ? await resolveChannel(params.channel)
          : undefined;
      const descriptor = await fetchSlackFileToCache(
        params.file_id,
        {
          ...(channelId ? { channelId } : {}),
          ...(params.thread_ts ? { threadTs: params.thread_ts } : {}),
          ...(params.message_ts ? { messageTs: params.message_ts } : {}),
        },
        { slack, token: getBotToken() },
      );

      return {
        content: [
          {
            type: "text",
            text: `Downloaded Slack file ${descriptor.fileId} to ${descriptor.path}.`,
          },
        ],
        details: descriptor,
      };
    },
  });

  registerSlackAction({
    name: "slack_read",
    label: "Slack Read",
    description: "Read messages from a Slack assistant thread.",
    promptSnippet: "Read messages from a Slack assistant thread.",
    parameters: Type.Object({
      thread_ts: Type.String({ description: "Thread to read." }),
      limit: Type.Optional(Type.Number({ description: "Max messages (default 20)" })),
      download_files: Type.Optional(
        Type.Boolean({
          description:
            "Download attached Slack-hosted files to the local temp cache and return safe descriptors. Defaults to true.",
        }),
      ),
      ...SLACK_OUTPUT_OPTION_PARAMETERS,
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_read",
        params.thread_ts,
        `thread_ts=${params.thread_ts} | limit=${params.limit ?? 20} | download_files=${params.download_files !== false}`,
      );

      const channel = (await resolveTrackedThreadChannel(params.thread_ts)) ?? getLastDmChannel();
      if (!channel) {
        throw new Error("Unknown thread.");
      }

      const response = await slack("conversations.replies", getBotToken(), {
        channel,
        ts: params.thread_ts,
        limit: params.limit ?? 20,
      });

      const messages = response.messages as Record<string, unknown>[];
      const full = params.full === true;
      const shouldDownloadFiles = params.download_files !== false;
      const downloadFile = async (
        fileId: string,
        messageTs: string,
      ): Promise<SlackFileDescriptor> =>
        fetchSlackFileToCache(
          fileId,
          { channelId: channel, threadTs: params.thread_ts, messageTs },
          { slack, token: getBotToken() },
        );
      const formattedMessages = await Promise.all(
        messages.map(async (message) => {
          const userId = message.user as string | undefined;
          const name = userId ? await resolveUser(userId) : "bot";
          const text = (message.text as string) ?? "";
          const ts = message.ts as string;
          const files = await Promise.all(
            extractSlackMessageFileMetadata(message.files).map(async (file) => {
              const fileId = file.id;
              if (!fileId) {
                return {
                  messageTs: ts,
                  ...(file.name ? { filename: file.name } : {}),
                  ...(file.mimetype ? { mimetype: file.mimetype } : {}),
                  ...(file.filetype ? { filetype: file.filetype } : {}),
                  ...(file.prettyType ? { prettyType: file.prettyType } : {}),
                  ...(file.size != null ? { size: file.size } : {}),
                  downloadStatus: "metadata-only",
                } satisfies Omit<SlackReadFileAttachment, "fileId">;
              }
              const base = {
                fileId,
                messageTs: ts,
                ...(file.name ? { filename: file.name } : {}),
                ...(file.mimetype ? { mimetype: file.mimetype } : {}),
                ...(file.filetype ? { filetype: file.filetype } : {}),
                ...(file.prettyType ? { prettyType: file.prettyType } : {}),
                ...(file.size != null ? { size: file.size } : {}),
              };
              if (!shouldDownloadFiles) {
                return {
                  ...base,
                  downloadStatus: "metadata-only",
                } satisfies SlackReadFileAttachment;
              }
              try {
                const descriptor = await downloadFile(fileId, ts);
                return {
                  ...base,
                  filename: descriptor.filename,
                  ...(descriptor.mimetype ? { mimetype: descriptor.mimetype } : {}),
                  ...(descriptor.filetype ? { filetype: descriptor.filetype } : {}),
                  ...(descriptor.prettyType ? { prettyType: descriptor.prettyType } : {}),
                  size: descriptor.size,
                  path: descriptor.path,
                  sha256: descriptor.sha256,
                  cacheDir: descriptor.cacheDir,
                  expiresAt: descriptor.expiresAt,
                  downloadStatus: "downloaded",
                } satisfies SlackReadFileAttachment;
              } catch (error) {
                return {
                  ...base,
                  downloadStatus: "failed",
                  error: getErrorMessage(error),
                } satisfies SlackReadFileAttachment;
              }
            }),
          );
          return { ts, name, text, preview: truncateSlackText(text), files };
        }),
      );
      const lines = formattedMessages.flatMap((message) => {
        const messageLine = full
          ? `[${message.ts}] ${message.name}: ${message.text}`
          : `[${message.ts}] ${message.name}: ${message.preview}`;
        const fileLines = message.files.map((file) => {
          const filename = file.filename ? ` ${file.filename}` : "";
          const type = file.prettyType ?? file.filetype ?? file.mimetype ?? "file";
          if (file.downloadStatus === "downloaded") {
            return `  [file downloaded] ${file.fileId}${filename} (${type}) -> ${file.path}`;
          }
          if (file.downloadStatus === "failed") {
            return `  [file metadata] ${file.fileId}${filename} (${type}) download failed: ${file.error}`;
          }
          return `  [file metadata] ${"fileId" in file ? file.fileId : "unknown-file"}${filename} (${type})`;
        });
        return [messageLine, ...fileLines];
      });
      const downloadedFilesCount = formattedMessages.reduce(
        (count, message) =>
          count + message.files.filter((file) => file.downloadStatus === "downloaded").length,
        0,
      );
      const failedFilesCount = formattedMessages.reduce(
        (count, message) =>
          count + message.files.filter((file) => file.downloadStatus === "failed").length,
        0,
      );
      if (!full && messages.length > 0) {
        lines.push("", "Use args.full=true for exact message text.");
      }
      if (downloadedFilesCount > 0 || failedFilesCount > 0) {
        lines.push(
          "",
          `File attachments: ${downloadedFilesCount} downloaded to the local temp cache${failedFilesCount > 0 ? `; ${failedFilesCount} failed and returned metadata only` : ""}.`,
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") || "(no messages)" }],
        details: full
          ? {
              count: messages.length,
              downloadedFilesCount,
              failedFilesCount,
              messages: formattedMessages.map((message) => ({
                ts: message.ts,
                user: message.name,
                text: message.text,
                files: message.files,
              })),
            }
          : {
              count: messages.length,
              downloadedFilesCount,
              failedFilesCount,
              messages: formattedMessages.map((message) => ({
                ts: message.ts,
                user: message.name,
                preview: message.preview,
                files: message.files,
              })),
            },
        fullDetails: {
          count: messages.length,
          downloadedFilesCount,
          failedFilesCount,
          messages: formattedMessages.map((message) => ({
            ts: message.ts,
            user: message.name,
            text: message.text,
            files: message.files,
          })),
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_status",
    label: "Slack Thread Status",
    description:
      "Set or clear Slack's in-thread shimmer/thinking status for the current thread. Best-effort; failures do not affect final replies.",
    promptSnippet:
      "Update visible Slack thread status with short safe progress hints such as Reading context… or Drafting reply…. Do not expose chain-of-thought.",
    parameters: Type.Object({
      thread_ts: Type.String({ description: "Slack thread timestamp to update." }),
      channel: Type.Optional(
        Type.String({
          description:
            "Optional channel name or ID. Omit when the thread is tracked by the Slack bridge.",
        }),
      ),
      status: Type.Optional(
        Type.Union(
          [
            Type.Literal("is thinking…"),
            Type.Literal("Reading context…"),
            Type.Literal("Calling tool…"),
            Type.Literal("Drafting reply…"),
            Type.Literal("Checking Slack…"),
          ],
          {
            description:
              "Controlled visible status text. Ignored when clear=true. Only safe operational progress labels are accepted.",
          },
        ),
      ),
      clear: Type.Optional(Type.Boolean({ description: "Clear the visible thread status." })),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_status",
        params.thread_ts,
        `thread_ts=${params.thread_ts} | channel=${params.channel ?? ""} | clear=${params.clear === true}`,
      );
      const channelId = await resolveSlackTargetChannel(params.thread_ts, params.channel);
      const status =
        params.clear === true
          ? ""
          : normalizeSlackThreadStatus(params.status ?? DEFAULT_SLACK_THREAD_STATUS);
      await setSlackThreadStatus({
        slack,
        token: getBotToken(),
        channelId,
        threadTs: params.thread_ts,
        status,
        loadingMessages: SLACK_THREAD_LOADING_MESSAGES,
      });
      return {
        content: [
          {
            type: "text",
            text: status
              ? `Updated Slack thread status to “${status}”.`
              : "Cleared Slack thread status.",
          },
        ],
        details: { channel: channelId, thread_ts: params.thread_ts, status },
      };
    },
  });

  registerSlackAction({
    name: "slack_presence",
    label: "Slack Presence",
    description:
      "Check whether one or more Slack users are active, away, or in Do Not Disturb before messaging them.",
    promptSnippet:
      "Check whether Slack users are active, away, or in DND before pinging them, routing work, or deciding whether to schedule a follow-up.",
    parameters: Type.Object({
      user: Type.Optional(
        Type.String({
          description: "Single Slack user ID, mention, @handle, display name, or real name",
        }),
      ),
      users: Type.Optional(
        Type.Array(
          Type.String({
            description: "Multiple Slack user IDs, mentions, @handles, or names to check in batch",
          }),
        ),
      ),
    }),
    async execute(_id, params) {
      const targets = normalizeSlackPresenceTargets(params.user, params.users);
      requireToolPolicy(
        "slack_presence",
        undefined,
        `user=${params.user ?? ""} | users=${targets.join(",")}`,
      );

      const resolvedTargets = await Promise.all(
        targets.map(async (target) => ({
          target,
          ...(await resolveSlackPresenceTarget(target)),
        })),
      );
      const snapshots = await Promise.all(
        resolvedTargets.map(({ userId, userName }) => fetchSlackPresenceSnapshot(userId, userName)),
      );

      return {
        content: [{ type: "text", text: snapshots.map(formatSlackPresenceLine).join("\n") }],
        details: {
          count: snapshots.length,
          results: snapshots.map((snapshot) => ({
            user: snapshot.userId,
            user_name: snapshot.userName,
            presence: snapshot.presence,
            online: snapshot.online,
            auto_away: snapshot.autoAway,
            manual_away: snapshot.manualAway,
            dnd_enabled: snapshot.dndEnabled,
            dnd_end_ts: snapshot.dndEndTs,
            dnd_end_at: snapshot.dndEndAt,
            connection_count: snapshot.connectionCount,
            last_activity: snapshot.lastActivity,
          })),
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_export",
    label: "Slack Export",
    description:
      "Export a Slack thread as markdown, plain text, or JSON for documentation and archival.",
    promptSnippet:
      "Export a Slack thread before turning it into docs, ADRs, canvases, archives, or follow-up summaries.",
    parameters: Type.Object({
      thread_ts: Type.String({ description: "Thread timestamp to export" }),
      channel: Type.Optional(
        Type.String({
          description:
            "Channel name or ID. Omit to use the current thread channel, active DM, or defaultChannel.",
        }),
      ),
      format: Type.Optional(
        Type.String({ description: "Export format: 'markdown' (default), 'plain', or 'json'" }),
      ),
      include_metadata: Type.Optional(
        Type.Boolean({ description: "Include timestamps and author names (default true)" }),
      ),
      oldest: Type.Optional(
        Type.String({
          description: "Optional oldest boundary as a Slack ts or ISO-8601 UTC timestamp",
        }),
      ),
      latest: Type.Optional(
        Type.String({
          description: "Optional latest boundary as a Slack ts or ISO-8601 UTC timestamp",
        }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_export",
        params.thread_ts,
        `thread_ts=${params.thread_ts} | channel=${params.channel ?? ""} | format=${params.format ?? "markdown"} | include_metadata=${params.include_metadata ?? true} | oldest=${params.oldest ?? ""} | latest=${params.latest ?? ""}`,
      );

      const channelId = await resolveSlackTargetChannel(params.thread_ts, params.channel);
      const oldestTs = params.oldest?.trim()
        ? parseSlackExportBoundaryTs(params.oldest)
        : undefined;
      const latestTs = params.latest?.trim()
        ? parseSlackExportBoundaryTs(params.latest)
        : undefined;

      if (oldestTs != null && latestTs != null && oldestTs > latestTs) {
        throw new Error("oldest must be earlier than or equal to latest.");
      }

      const rawMessages = await fetchSlackThreadMessages(
        channelId,
        params.thread_ts,
        oldestTs != null ? String(oldestTs) : undefined,
        latestTs != null ? String(latestTs) : undefined,
      );
      const exportPayload = await buildSlackExportPayload(rawMessages);
      const filteredMessages = filterSlackExportMessagesByRange(
        exportPayload.messages,
        oldestTs,
        latestTs,
      );
      const participants = [
        ...new Set(filteredMessages.map((message) => message.authorName).filter(Boolean)),
      ];
      const exportText = buildSlackThreadExport({
        format: params.format,
        includeMetadata: params.include_metadata,
        threadTs: params.thread_ts,
        channelId,
        channelLabel: params.channel,
        messages: filteredMessages,
        mentionNames: exportPayload.mentionNames,
      });

      return {
        content: [
          {
            type: "text",
            text: exportText || "(no messages)",
          },
        ],
        details: {
          thread_ts: params.thread_ts,
          channel: channelId,
          format: params.format?.trim().toLowerCase() ?? "markdown",
          include_metadata: params.include_metadata ?? true,
          count: filteredMessages.length,
          participants,
          ...(oldestTs != null ? { oldest: oldestTs } : {}),
          ...(latestTs != null ? { latest: latestTs } : {}),
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_create_channel",
    label: "Slack Create Channel",
    description: "Create a new Slack channel, optionally setting its topic and purpose.",
    promptSnippet: "Create a new Slack channel.",
    parameters: Type.Object({
      name: Type.String({
        description: "Channel name (lowercase, no spaces, max 80 chars)",
      }),
      topic: Type.Optional(Type.String({ description: "Channel topic" })),
      purpose: Type.Optional(Type.String({ description: "Channel purpose" })),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_create_channel",
        undefined,
        `name=${params.name} | topic=${params.topic ?? ""} | purpose=${params.purpose ?? ""}`,
      );

      const response = await slack("conversations.create", getBotToken(), {
        name: params.name,
      });
      const channel = response.channel as { id: string; name: string };

      if (params.topic) {
        await slack("conversations.setTopic", getBotToken(), {
          channel: channel.id,
          topic: params.topic,
        });
      }
      if (params.purpose) {
        await slack("conversations.setPurpose", getBotToken(), {
          channel: channel.id,
          purpose: params.purpose,
        });
      }

      rememberChannel(channel.name, channel.id);

      return {
        content: [{ type: "text", text: `Created channel #${channel.name} (${channel.id})` }],
        details: { id: channel.id, name: channel.name },
      };
    },
  });

  // ─── Project channel creation ──────────────────────────

  registerSlackAction({
    name: "slack_project_create",
    label: "Slack Project Create",
    description:
      "Create a Slack project channel with an attached RFC canvas and bot membership in one step.",
    promptSnippet:
      "Create a project channel, attach an RFC/spec canvas, and invite the Pinet bot — all in one call.",
    parameters: Type.Object({
      name: Type.String({
        description: "Channel name (lowercase, no spaces, max 80 chars)",
      }),
      topic: Type.Optional(Type.String({ description: "Channel topic" })),
      purpose: Type.Optional(Type.String({ description: "Channel purpose" })),
      canvas_title: Type.Optional(
        Type.String({ description: "Title for the RFC/spec canvas (defaults to channel name)" }),
      ),
      canvas_markdown: Type.Optional(
        Type.String({ description: "Markdown content for the RFC/spec canvas" }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_project_create",
        undefined,
        `name=${params.name} | topic=${params.topic ?? ""} | canvas=${params.canvas_title ?? params.name}`,
      );

      // 1. Create the channel
      const createResponse = await slack("conversations.create", getBotToken(), {
        name: params.name,
      });
      const channel = createResponse.channel as { id: string; name: string };
      rememberChannel(channel.name, channel.id);

      // 2. Set topic and purpose if provided
      if (params.topic) {
        await slack("conversations.setTopic", getBotToken(), {
          channel: channel.id,
          topic: params.topic,
        });
      }
      if (params.purpose) {
        await slack("conversations.setPurpose", getBotToken(), {
          channel: channel.id,
          purpose: params.purpose,
        });
      }

      // 3. Invite the bot to the channel (if we know the bot user id)
      const botId = getBotUserId();
      let botInvited = false;
      if (botId) {
        try {
          await slack("conversations.invite", getBotToken(), {
            channel: channel.id,
            users: botId,
          });
          botInvited = true;
        } catch (err) {
          // already_in_channel is fine — the bot created the channel so it's already a member
          if (isSlackMethodError(err, "conversations.invite", "already_in_channel")) {
            botInvited = true;
          }
          // Other errors are non-fatal — the channel still works, just without explicit bot membership
        }
      }

      // 4. Create the channel canvas with the RFC/spec
      const canvasTitle = params.canvas_title?.trim() || `${channel.name} RFC`;
      let canvasId: string | null = null;
      let canvasKind: "channel" | "standalone" | null = null;
      let canvasFallback: SlackCanvasFallbackResult | null = null;
      let canvasFailure: string | null = null;
      try {
        const canvasRequest = buildSlackCanvasCreateRequest({
          kind: "channel",
          title: canvasTitle,
          markdown: params.canvas_markdown,
          channelId: channel.id,
        });
        const canvasResponse = await slack(canvasRequest.method, getBotToken(), canvasRequest.body);
        canvasId = canvasResponse.canvas_id as string;
        canvasKind = "channel";
      } catch (err) {
        if (
          isSlackMethodError(err, "conversations.canvases.create", "canvas_tab_creation_failed")
        ) {
          try {
            canvasFallback = await createStandaloneCanvasFallback({
              channelId: channel.id,
              channelLabel: `#${channel.name}`,
              title: canvasTitle,
              markdown: params.canvas_markdown,
            });
            canvasId = canvasFallback.canvasId;
            canvasKind = "standalone";
          } catch (fallbackErr) {
            canvasFailure =
              fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          }
        } else {
          // Canvas creation failure is non-fatal — the channel is still usable
          canvasFailure = err instanceof Error ? err.message : String(err);
        }
      }

      const parts = [`Created project channel #${channel.name} (${channel.id})`];
      if (canvasId && canvasKind === "standalone" && canvasFallback) {
        const bookmarkSummary = buildStandaloneCanvasFallbackBookmarkSummary({
          channelLabel: `#${channel.name}`,
          canvasId,
          permalink: canvasFallback.permalink,
          permalinkLookupError: canvasFallback.permalinkLookupError,
          bookmarkId: canvasFallback.bookmarkId,
          bookmarkStatus: canvasFallback.bookmarkStatus,
          bookmarkError: canvasFallback.bookmarkError,
        });
        parts.push(
          `Slack could not create the project channel canvas tab (canvas_tab_creation_failed). Created standalone fallback RFC canvas: ${canvasId} — "${canvasTitle}".${bookmarkSummary} Use canvas_update with canvas_id=${canvasId} for future updates.`,
        );
      } else if (canvasId) {
        parts.push(`RFC canvas: ${canvasId} — "${canvasTitle}"`);
      } else {
        parts.push(
          `Canvas creation failed${canvasFailure ? ` (${canvasFailure})` : ""} — retry with canvas_create kind='channel' channel='#${channel.name}' so the Slack bridge can auto-create/bookmark a standalone fallback if Slack rejects channel tab creation.`,
        );
      }
      if (botInvited) {
        parts.push("Bot joined the channel.");
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: {
          channel_id: channel.id,
          channel_name: channel.name,
          canvas_id: canvasId,
          canvas_title: canvasTitle,
          canvas_kind: canvasKind,
          bot_invited: botInvited,
          ...(canvasFallback
            ? {
                canvas_fallback: true,
                canvas_fallback_reason: "canvas_tab_creation_failed",
                bookmark_status: canvasFallback.bookmarkStatus,
                next_action: `canvas_update canvas_id=${canvasFallback.canvasId}`,
                ...(canvasFallback.permalink ? { permalink: canvasFallback.permalink } : {}),
                ...(canvasFallback.bookmarkId ? { bookmark_id: canvasFallback.bookmarkId } : {}),
                ...(canvasFallback.bookmarkError
                  ? { bookmark_error: canvasFallback.bookmarkError }
                  : {}),
                ...(canvasFallback.permalinkLookupError
                  ? { permalink_lookup_error: canvasFallback.permalinkLookupError }
                  : {}),
              }
            : {}),
          ...(canvasFailure ? { canvas_error: canvasFailure } : {}),
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_post_channel",
    label: "Slack Post Channel",
    description:
      "Post a message to a Slack channel (by name or ID), optionally in a thread. Uses defaultChannel from settings if channel is omitted.",
    promptSnippet:
      "Post a message to a Slack channel or thread. Use when you need to target a specific channel or thread by ID.",
    parameters: Type.Object({
      channel: Type.Optional(
        Type.String({
          description: "Channel name or ID (uses defaultChannel from settings if omitted)",
        }),
      ),
      text: Type.String({ description: "Message text (Slack markdown)" }),
      thread_ts: Type.Optional(Type.String({ description: "Thread timestamp to reply in" })),
      blocks: Type.Optional(
        Type.Array(Type.Record(Type.String(), Type.Unknown()), {
          description: "Optional Slack Block Kit blocks JSON array",
        }),
      ),
      files: Type.Optional(SLACK_LOCAL_FILE_ATTACHMENT_PARAMETERS),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_post_channel",
        params.thread_ts,
        `channel=${params.channel ?? getDefaultChannel() ?? ""} | thread_ts=${params.thread_ts ?? ""} | text=${params.text} | blocks=${summarizeSlackBlocksForPolicy(params.blocks)} | files=${Array.isArray(params.files) ? params.files.length : 0}`,
      );

      const resolvedThreadChannel = await resolveTrackedThreadChannel(params.thread_ts);
      const channelInput = params.channel ?? getDefaultChannel();
      let channelId = params.channel ? await resolveChannel(params.channel) : resolvedThreadChannel;

      if (!channelId && channelInput) {
        channelId = await resolveChannel(channelInput);
      }
      if (!channelId) {
        throw new Error("No channel specified and no defaultChannel configured in settings.json.");
      }

      const delivery = await deliverSlackMessage({
        channel: channelId,
        text: params.text,
        ...(params.thread_ts ? { threadTs: params.thread_ts } : {}),
        ...(params.blocks ? { blocks: params.blocks } : {}),
        ...(params.files ? { files: params.files } : {}),
      });
      const ts = delivery.ts;
      const threadTs = params.thread_ts ?? delivery.threadTs;
      const actualTs = threadTs ?? ts;
      if (!actualTs) {
        throw new Error("Slack delivery did not return a message timestamp.");
      }

      noteThreadReply(actualTs, channelId);

      const channelLabel = params.channel ?? resolvedThreadChannel ?? channelInput ?? channelId;
      return {
        content: [
          {
            type: "text",
            text: params.thread_ts
              ? `Replied in thread ${params.thread_ts} in channel ${channelLabel}.`
              : `Posted to #${channelLabel} (ts: ${actualTs}).`,
          },
        ],
        details: {
          ...(ts ? { ts } : {}),
          ...(threadTs ? { thread_ts: threadTs } : {}),
          channel: channelId,
          blocksCount: delivery.blocksCount,
          delivery: delivery.delivery,
          filesCount: Array.isArray(params.files) ? params.files.length : 0,
          ...(delivery.adapter ? { adapter: delivery.adapter } : {}),
          ...(delivery.messageId ? { messageId: delivery.messageId } : {}),
          ...(delivery.fallbackReason ? { fallbackReason: delivery.fallbackReason } : {}),
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_delete",
    label: "Slack Delete",
    description:
      "Delete a Slack message posted by the bot, or delete an entire thread rooted at a bot-posted message.",
    promptSnippet:
      "Delete a bot-posted Slack message. This is destructive — set confirm=true, and prefer explicit approval before deleting whole threads.",
    parameters: Type.Object({
      ts: Type.String({
        description:
          "Timestamp (ts) of the message to delete. When thread=true, this must be the thread root timestamp.",
      }),
      channel: Type.Optional(
        Type.String({
          description:
            "Channel name or ID. Omit to use the current thread channel, active DM, or defaultChannel.",
        }),
      ),
      thread_ts: Type.Optional(
        Type.String({
          description:
            "Optional thread timestamp used to resolve the current channel when channel is omitted.",
        }),
      ),
      thread: Type.Optional(
        Type.Boolean({
          description: "Delete the entire thread rooted at ts (default false).",
        }),
      ),
      confirm: Type.Optional(
        Type.Boolean({
          description: "Must be true to confirm this irreversible deletion.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (params.confirm !== true) {
        throw new Error(
          "Deleting Slack messages is irreversible. Re-run with confirm=true once you've verified the target.",
        );
      }

      requireToolPolicy(
        "slack_delete",
        params.thread_ts,
        summarizeSlackDeleteAction({
          channel: params.channel,
          defaultChannel: getDefaultChannel(),
          threadTs: params.thread_ts,
          ts: params.ts,
          thread: params.thread,
        }),
      );

      const deleteThread = params.thread === true;
      const { channelId, messageTsList } = await resolveSlackDeleteTargets({
        channel: params.channel,
        threadTs: params.thread_ts,
        ts: params.ts,
        thread: deleteThread,
      });

      for (const messageTs of messageTsList) {
        await slack("chat.delete", getBotToken(), {
          channel: channelId,
          ts: messageTs,
        });
      }

      const targetTs = params.ts.trim();
      const deletedCount = messageTsList.length;
      const channelLabel = params.channel ?? channelId;

      return {
        content: [
          {
            type: "text",
            text: deleteThread
              ? `Deleted thread rooted at ${targetTs} in channel ${channelLabel} (${deletedCount} message${deletedCount === 1 ? "" : "s"}).`
              : `Deleted message ${targetTs} from channel ${channelLabel}.`,
          },
        ],
        details: {
          channel: channelId,
          ts: targetTs,
          thread: deleteThread,
          deleted_count: deletedCount,
          deleted_ts: messageTsList,
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_pin",
    label: "Slack Pin",
    description: "Pin or unpin a Slack message by timestamp.",
    promptSnippet:
      "Pin important Slack messages like decisions, confirmations, or follow-up items. Unpin stale ones when they are no longer relevant.",
    parameters: Type.Object({
      action: Type.String({ description: "'pin' to pin a message or 'unpin' to remove the pin" }),
      message_ts: Type.String({ description: "Timestamp (ts) of the message to pin or unpin" }),
      channel: Type.Optional(
        Type.String({
          description:
            "Channel name or ID. Omit to use the current thread channel, active DM, or defaultChannel.",
        }),
      ),
      thread_ts: Type.Optional(
        Type.String({
          description: "Optional thread timestamp used to resolve the current channel",
        }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_pin",
        params.thread_ts,
        `action=${params.action} | channel=${params.channel ?? getDefaultChannel() ?? ""} | thread_ts=${params.thread_ts ?? ""} | message_ts=${params.message_ts}`,
      );

      const action = normalizeSlackPinAction(params.action);
      const messageTs = params.message_ts.trim();
      if (!messageTs) {
        throw new Error("message_ts is required.");
      }

      const channelId = await resolveSlackTargetChannel(params.thread_ts, params.channel);
      const method = action === "pin" ? "pins.add" : "pins.remove";
      const body = { channel: channelId, timestamp: messageTs };

      try {
        await slack(method, getBotToken(), body);
      } catch (err) {
        if (action === "pin" && isSlackMethodError(err, "pins.add", "already_pinned")) {
          return {
            content: [
              {
                type: "text",
                text: `Message ${messageTs} is already pinned in channel ${params.channel ?? channelId}.`,
              },
            ],
            details: {
              channel: channelId,
              message_ts: messageTs,
              action,
              status: "already_pinned",
            },
          };
        }

        if (action === "unpin" && isSlackMethodError(err, "pins.remove", "no_pin", "not_pinned")) {
          return {
            content: [
              {
                type: "text",
                text: `Message ${messageTs} is not currently pinned in channel ${params.channel ?? channelId}.`,
              },
            ],
            details: { channel: channelId, message_ts: messageTs, action, status: "not_pinned" },
          };
        }

        throw err;
      }

      return {
        content: [
          {
            type: "text",
            text:
              action === "pin"
                ? `Pinned message ${messageTs} in channel ${params.channel ?? channelId}.`
                : `Unpinned message ${messageTs} in channel ${params.channel ?? channelId}.`,
          },
        ],
        details: {
          channel: channelId,
          message_ts: messageTs,
          action,
          status: action === "pin" ? "pinned" : "unpinned",
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_bookmark",
    label: "Slack Bookmark",
    description:
      "Add, list, or remove channel bookmarks for durable links like repos, dashboards, docs, and runbooks.",
    promptSnippet:
      "Use bookmarks for persistent channel-header links. Add repos, dashboards, docs, and runbooks; list existing bookmarks; remove stale ones by ID.",
    parameters: Type.Object({
      action: Type.String({ description: "'add', 'list', or 'remove'" }),
      channel: Type.Optional(
        Type.String({
          description:
            "Channel name or ID. Omit to use the current thread channel, active DM, or defaultChannel.",
        }),
      ),
      thread_ts: Type.Optional(
        Type.String({
          description: "Optional thread timestamp used to resolve the current channel",
        }),
      ),
      title: Type.Optional(
        Type.String({ description: "Bookmark title (required when action='add')" }),
      ),
      url: Type.Optional(Type.String({ description: "Bookmark URL (required when action='add')" })),
      emoji: Type.Optional(
        Type.String({ description: "Optional emoji label for the bookmark, e.g. :rocket:" }),
      ),
      bookmark_id: Type.Optional(
        Type.String({ description: "Bookmark ID (required when action='remove')" }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_bookmark",
        params.thread_ts,
        `action=${params.action} | channel=${params.channel ?? getDefaultChannel() ?? ""} | thread_ts=${params.thread_ts ?? ""} | title=${params.title ?? ""} | url=${params.url ?? ""} | bookmark_id=${params.bookmark_id ?? ""}`,
      );

      const action = normalizeSlackBookmarkAction(params.action);
      const channelId = await resolveSlackTargetChannel(params.thread_ts, params.channel);
      const channelLabel = params.channel ?? channelId;

      if (action === "list") {
        const response = await slack("bookmarks.list", getBotToken(), { channel_id: channelId });
        const bookmarks = Array.isArray(response.bookmarks)
          ? (response.bookmarks as Array<Record<string, unknown>>)
          : [];
        const lines = bookmarks.map((bookmark) => {
          const id = typeof bookmark.id === "string" ? bookmark.id : "(unknown-id)";
          const title = typeof bookmark.title === "string" ? bookmark.title : "(untitled)";
          const link = typeof bookmark.link === "string" ? bookmark.link : "(no link)";
          const emoji =
            typeof bookmark.emoji === "string" && bookmark.emoji.length > 0
              ? `${bookmark.emoji} `
              : "";
          return `- ${id}: ${emoji}${title} -> ${link}`;
        });

        return {
          content: [
            {
              type: "text",
              text:
                lines.length > 0
                  ? `Bookmarks in ${channelLabel}:\n${lines.join("\n")}`
                  : `No bookmarks found in ${channelLabel}.`,
            },
          ],
          details: { channel: channelId, count: bookmarks.length, bookmarks },
        };
      }

      if (action === "add") {
        const title = params.title?.trim();
        if (!title) {
          throw new Error("title is required when action='add'.");
        }

        const link = normalizeSlackBookmarkUrl(params.url ?? "");
        const emoji = params.emoji?.trim();
        const response = await slack("bookmarks.add", getBotToken(), {
          channel_id: channelId,
          title,
          type: "link",
          link,
          ...(emoji ? { emoji } : {}),
        });
        const bookmark =
          response.bookmark && typeof response.bookmark === "object"
            ? (response.bookmark as Record<string, unknown>)
            : undefined;
        const bookmarkId = bookmark && typeof bookmark.id === "string" ? bookmark.id : undefined;

        return {
          content: [
            {
              type: "text",
              text: `Added bookmark '${title}' to ${channelLabel}.`,
            },
          ],
          details: {
            channel: channelId,
            action,
            title,
            url: link,
            ...(emoji ? { emoji } : {}),
            ...(bookmarkId ? { bookmark_id: bookmarkId } : {}),
          },
        };
      }

      const bookmarkId = params.bookmark_id?.trim();
      if (!bookmarkId) {
        throw new Error("bookmark_id is required when action='remove'.");
      }

      try {
        await slack("bookmarks.remove", getBotToken(), {
          channel_id: channelId,
          bookmark_id: bookmarkId,
        });
      } catch (err) {
        if (isSlackMethodError(err, "bookmarks.remove", "not_found")) {
          return {
            content: [
              {
                type: "text",
                text: `Bookmark ${bookmarkId} was not found in ${channelLabel}.`,
              },
            ],
            details: { channel: channelId, action, bookmark_id: bookmarkId, status: "not_found" },
          };
        }

        throw err;
      }

      return {
        content: [
          {
            type: "text",
            text: `Removed bookmark ${bookmarkId} from ${channelLabel}.`,
          },
        ],
        details: { channel: channelId, action, bookmark_id: bookmarkId, status: "removed" },
      };
    },
  });

  registerSlackAction({
    name: "slack_schedule",
    label: "Slack Schedule",
    description:
      "Schedule a Slack message for later using chat.scheduleMessage. Supports relative delays and absolute times.",
    promptSnippet:
      "Schedule a Slack message for later instead of waiting around. Use it for reminders, timed announcements, and delayed follow-ups.",
    parameters: Type.Object({
      text: Type.String({ description: "Message text (Slack markdown)" }),
      channel: Type.Optional(
        Type.String({
          description:
            "Channel name or ID. Omit to use the current thread channel, active DM, or defaultChannel.",
        }),
      ),
      thread_ts: Type.Optional(
        Type.String({ description: "Optional thread timestamp to reply in later" }),
      ),
      delay: Type.Optional(
        Type.String({ description: "Relative delay like 5m, 30s, 1h30m, or 1d" }),
      ),
      at: Type.Optional(
        Type.String({ description: "Absolute ISO-8601 UTC time, e.g. 2026-04-02T14:30:00Z" }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_schedule",
        params.thread_ts,
        `channel=${params.channel ?? getDefaultChannel() ?? ""} | thread_ts=${params.thread_ts ?? ""} | delay=${params.delay ?? ""} | at=${params.at ?? ""} | text=${params.text}`,
      );

      const text = params.text.trim();
      if (!text) {
        throw new Error("text is required");
      }

      const channelId = await resolveSlackTargetChannel(params.thread_ts, params.channel);
      const fireAt = resolveScheduledWakeupFireAt({ delay: params.delay, at: params.at });
      const postAt = Math.floor(Date.parse(fireAt) / 1000);

      const body: Record<string, unknown> = {
        channel: channelId,
        text,
        post_at: postAt,
      };
      if (params.thread_ts) {
        body.thread_ts = params.thread_ts;
      }

      const response = await slack("chat.scheduleMessage", getBotToken(), body);
      const scheduledMessageId =
        typeof response.scheduled_message_id === "string"
          ? response.scheduled_message_id
          : undefined;

      return {
        content: [
          {
            type: "text",
            text: params.thread_ts
              ? `Scheduled message for ${fireAt} in thread ${params.thread_ts}.`
              : `Scheduled message for ${fireAt} in channel ${params.channel ?? channelId}.`,
          },
        ],
        details: {
          channel: channelId,
          post_at: postAt,
          fire_at: fireAt,
          ...(scheduledMessageId ? { scheduled_message_id: scheduledMessageId } : {}),
          ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}),
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_read_channel",
    label: "Slack Read Channel",
    description: "Read messages from a Slack channel or a thread within a channel.",
    promptSnippet: "Read messages from a Slack channel.",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel name or ID" }),
      thread_ts: Type.Optional(
        Type.String({ description: "Thread timestamp to read replies from" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max messages to return (default 20)" })),
      ...SLACK_OUTPUT_OPTION_PARAMETERS,
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_read_channel",
        params.thread_ts,
        `channel=${params.channel} | thread_ts=${params.thread_ts ?? ""} | limit=${params.limit ?? 20}`,
      );

      const channelId = await resolveChannel(params.channel);
      const limit = params.limit ?? 20;

      let messages: Record<string, unknown>[];
      if (params.thread_ts) {
        const response = await slack("conversations.replies", getBotToken(), {
          channel: channelId,
          ts: params.thread_ts,
          limit,
        });
        messages = response.messages as Record<string, unknown>[];
      } else {
        const response = await slack("conversations.history", getBotToken(), {
          channel: channelId,
          limit,
        });
        messages = (response.messages as Record<string, unknown>[]).reverse();
      }

      const full = params.full === true;
      const formattedMessages = await Promise.all(
        messages.map(async (message) => {
          const userId = message.user as string | undefined;
          const name = userId ? await resolveUser(userId) : "bot";
          const text = (message.text as string) ?? "";
          const ts = message.ts as string;
          return { ts, name, text, preview: truncateSlackText(text) };
        }),
      );
      const lines = formattedMessages.map((message) =>
        full
          ? `[${message.ts}] ${message.name}: ${message.text}`
          : `[${message.ts}] ${message.name}: ${message.preview}`,
      );
      if (!full && messages.length > 0) {
        lines.push("", "Use args.full=true for exact channel message text.");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") || "(no messages)" }],
        details: full
          ? { count: messages.length, channel: channelId }
          : {
              count: messages.length,
              channel: channelId,
              messages: formattedMessages.map((message) => ({
                ts: message.ts,
                user: message.name,
                preview: message.preview,
              })),
            },
        fullDetails: {
          count: messages.length,
          channel: channelId,
          messages: formattedMessages.map((message) => ({
            ts: message.ts,
            user: message.name,
            text: message.text,
          })),
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_canvas_comments_read",
    label: "Slack Canvas Comments Read",
    description:
      "Read comments attached to a Slack canvas after validating the target with Slack's canvas APIs.",
    promptSnippet:
      "Inspect comments attached to a Slack canvas in read-only mode. This tool validates canvas targets before using files.info, and it does not inspect generic Slack files.",
    parameters: Type.Object({
      canvas_id: Type.Optional(
        Type.String({
          description:
            "Canvas ID to inspect. The ID is validated as a canvas before comments are read.",
        }),
      ),
      channel: Type.Optional(
        Type.String({ description: "Channel name or ID whose channel canvas should be inspected" }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max comments to return per call (default 20, max 200)" }),
      ),
      cursor: Type.Optional(
        Type.String({
          description: "Pagination cursor returned by a previous canvas comment read",
        }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_canvas_comments_read",
        undefined,
        `canvas_id=${params.canvas_id ?? ""} | channel=${params.channel ?? ""} | limit=${params.limit ?? 20} | cursor=${params.cursor ?? ""}`,
      );

      const target = await resolveCanvasTarget(params.canvas_id, params.channel);
      const limit = normalizeSlackCanvasCommentsLimit(params.limit);
      const cursor = normalizeOptionalSlackCursor(params.cursor);

      await assertCanvasCommentsTargetIsCanvas(target.canvasId);

      let response: SlackResult;
      try {
        response = await slack("files.info", getBotToken(), {
          file: target.canvasId,
          limit,
          ...(cursor ? { cursor } : {}),
        });
      } catch (err) {
        if (
          isSlackMethodError(
            err,
            "files.info",
            "channel_canvas_deleted",
            "file_deleted",
            "file_not_found",
          )
        ) {
          throw new Error(`Canvas ${target.canvasId} is no longer available.`);
        }
        if (isSlackMethodError(err, "files.info", "access_denied")) {
          throw new Error(
            `Canvas ${target.canvasId} is not accessible with the current bot token.`,
          );
        }
        throw err;
      }

      const page = extractSlackCanvasCommentsPage(
        response as unknown as Record<string, unknown>,
        target.canvasId,
      );
      if (page.canvasId !== target.canvasId) {
        throw new Error(
          `Slack files.info returned comments for ${page.canvasId}, but canvas comment inspection requested ${target.canvasId}.`,
        );
      }
      const comments = await Promise.all(
        page.comments.map(async (comment) => ({
          ...comment,
          ...(comment.userId ? { userName: await resolveUser(comment.userId) } : {}),
        })),
      );

      return {
        content: [
          {
            type: "text",
            text: buildSlackCanvasCommentsSummaryText({
              canvasId: page.canvasId,
              title: page.title,
              commentsCount: page.commentsCount,
              returnedCount: page.returnedCount,
              nextCursor: page.nextCursor,
              comments,
            }),
          },
        ],
        details: {
          canvas_id: page.canvasId,
          channel: target.channelId,
          title: page.title,
          permalink: page.permalink,
          comments_count: page.commentsCount,
          returned_count: page.returnedCount,
          ...(page.page ? { page: page.page } : {}),
          ...(page.pages ? { pages: page.pages } : {}),
          ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
          comments: comments.map((comment) => ({
            id: comment.id,
            user_id: comment.userId,
            user_name: comment.userName,
            created_ts: comment.createdTs,
            text: comment.text,
          })),
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_canvas_create",
    label: "Slack Canvas Create",
    description:
      "Create a Slack canvas with markdown content, either standalone or as a channel canvas. If Slack cannot create a channel canvas tab, creates a standalone channel-attached fallback and bookmarks it when possible.",
    promptSnippet:
      "Create a Slack canvas for long-lived documentation. Use standalone canvases for shared docs and kind='channel' for a channel's main canvas; channel tab failures fall back to a standalone canvas plus bookmark when possible.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Canvas title" })),
      markdown: Type.Optional(
        Type.String({
          description: "Initial canvas content in markdown. Omit for an empty canvas.",
        }),
      ),
      channel: Type.Optional(
        Type.String({ description: "Channel name or ID to attach the canvas to" }),
      ),
      kind: Type.Optional(
        Type.String({
          description:
            "Canvas kind: 'standalone' (default) or 'channel'. Channel canvas tab failures fall back to a standalone canvas and return its canvas_id.",
        }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_canvas_create",
        undefined,
        `kind=${params.kind ?? "standalone"} | channel=${params.channel ?? ""} | title=${params.title ?? ""}`,
      );

      const channelInput = params.channel?.trim();
      const channelId = channelInput ? await resolveChannel(channelInput) : undefined;
      const kind = normalizeSlackCanvasCreateKind(params.kind);

      // For channel canvases, check if one already exists before creating
      if (kind === "channel" && channelId) {
        const info = await slack("conversations.info", getBotToken(), { channel: channelId });
        const existingCanvasId = extractSlackChannelCanvasId(info);
        if (existingCanvasId) {
          return {
            content: [
              {
                type: "text",
                text: `Canvas already exists for ${channelInput ?? channelId}: ${existingCanvasId}. Returning existing canvas instead of creating a duplicate.`,
              },
            ],
            details: {
              canvas_id: existingCanvasId,
              kind: "channel",
              channel: channelId,
              existing: true,
            },
          };
        }
      }

      const request = buildSlackCanvasCreateRequest({
        kind: params.kind,
        title: params.title,
        markdown: params.markdown,
        channelId,
      });

      if (channelInput && channelId) {
        rememberChannel(channelInput.replace(/^#/, ""), channelId);
      }

      let response: SlackResult;
      try {
        response = await slack(request.method, getBotToken(), request.body);
      } catch (err) {
        if (
          request.kind !== "channel" ||
          !channelId ||
          !isSlackMethodError(err, "conversations.canvases.create", "canvas_tab_creation_failed")
        ) {
          throw err;
        }

        const channelLabel = channelInput ?? channelId;
        const fallback = await createStandaloneCanvasFallback({
          channelId,
          channelLabel,
          title: params.title,
          markdown: params.markdown,
        });
        const bookmarkSummary = buildStandaloneCanvasFallbackBookmarkSummary({
          channelLabel,
          canvasId: fallback.canvasId,
          permalink: fallback.permalink,
          permalinkLookupError: fallback.permalinkLookupError,
          bookmarkId: fallback.bookmarkId,
          bookmarkStatus: fallback.bookmarkStatus,
          bookmarkError: fallback.bookmarkError,
        });

        return {
          content: [
            {
              type: "text",
              text: `Slack could not create a channel canvas tab for ${channelLabel} (canvas_tab_creation_failed). Created standalone fallback canvas ${fallback.canvasId} attached to ${channelLabel}.${bookmarkSummary} Use canvas_update with canvas_id=${fallback.canvasId} for future updates. Initial content: ${getSlackCanvasSummary(params.markdown)}`,
            },
          ],
          details: {
            canvas_id: fallback.canvasId,
            kind: "standalone",
            requested_kind: "channel",
            channel: channelId,
            fallback: true,
            fallback_reason: "canvas_tab_creation_failed",
            bookmark_status: fallback.bookmarkStatus,
            next_action: `canvas_update canvas_id=${fallback.canvasId}`,
            ...(fallback.permalink ? { permalink: fallback.permalink } : {}),
            ...(fallback.bookmarkId ? { bookmark_id: fallback.bookmarkId } : {}),
            ...(fallback.bookmarkError ? { bookmark_error: fallback.bookmarkError } : {}),
            ...(fallback.permalinkLookupError
              ? { permalink_lookup_error: fallback.permalinkLookupError }
              : {}),
          },
        };
      }

      const canvasId = response.canvas_id as string;
      const channelLabel = channelInput ?? channelId;
      const targetSummary =
        request.kind === "channel"
          ? `Created channel canvas ${canvasId}${channelLabel ? ` for ${channelLabel}` : ""}.`
          : `Created standalone canvas ${canvasId}${channelLabel ? ` attached to ${channelLabel}` : ""}.`;

      return {
        content: [
          {
            type: "text",
            text: `${targetSummary} Initial content: ${getSlackCanvasSummary(params.markdown)}`,
          },
        ],
        details: {
          canvas_id: canvasId,
          kind: request.kind,
          channel: channelId,
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_canvas_update",
    label: "Slack Canvas Update",
    description:
      "Append, prepend, or replace content in an existing Slack canvas by canvas ID or channel canvas lookup.",
    promptSnippet:
      "Update a Slack canvas. Use mode='append' or 'prepend' for additive updates, or mode='replace' to replace the whole canvas or a matched section.",
    parameters: Type.Object({
      canvas_id: Type.Optional(Type.String({ description: "Canvas ID to update" })),
      channel: Type.Optional(
        Type.String({
          description:
            "Channel name or ID whose channel canvas should be updated. If Slack does not expose a channel canvas ID, provide the standalone fallback canvas_id returned by canvas_create.",
        }),
      ),
      markdown: Type.String({ description: "Canvas content in markdown" }),
      mode: Type.Optional(
        Type.String({ description: "Update mode: 'append' (default), 'prepend', or 'replace'" }),
      ),
      section_contains_text: Type.Optional(
        Type.String({
          description: "When mode='replace', replace the first section matching this text",
        }),
      ),
      section_type: Type.Optional(
        Type.String({
          description: "Optional section type for lookups: 'h1', 'h2', 'h3', or 'any_header'",
        }),
      ),
      section_index: Type.Optional(
        Type.Number({
          description:
            "Optional 1-based section index to choose when the lookup matches multiple sections",
        }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "slack_canvas_update",
        undefined,
        `canvas_id=${params.canvas_id ?? ""} | channel=${params.channel ?? ""} | mode=${params.mode ?? "append"} | section_contains_text=${params.section_contains_text ?? ""}`,
      );

      const mode = normalizeSlackCanvasUpdateMode(params.mode);
      if (params.section_contains_text && mode !== "replace") {
        throw new Error("section_contains_text can only be used with mode='replace'.");
      }
      if (params.section_index != null && !params.section_contains_text) {
        throw new Error("section_index can only be used together with section_contains_text.");
      }

      const target = await resolveCanvasTarget(params.canvas_id, params.channel);
      let sectionId: string | undefined;

      if (params.section_contains_text) {
        const lookup = buildSlackCanvasSectionsLookupRequest({
          canvasId: target.canvasId,
          containsText: params.section_contains_text,
          sectionType: params.section_type,
        });
        const response = await slack(
          "canvases.sections.lookup",
          getBotToken(),
          lookup as unknown as Record<string, unknown>,
        );
        const sections = response.sections as Array<{ id?: string }> | undefined;
        try {
          sectionId = pickSlackCanvasSectionId(sections, params.section_index);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Canvas section lookup for '${params.section_contains_text}' failed: ${message}`,
          );
        }
      }

      const request = buildSlackCanvasEditRequest({
        canvasId: target.canvasId,
        markdown: params.markdown,
        mode,
        sectionId,
      });
      await slack("canvases.edit", getBotToken(), request as unknown as Record<string, unknown>);

      const sectionSummary = params.section_contains_text
        ? ` Replaced section matching '${params.section_contains_text}'.`
        : "";
      const targetSummary = target.channelLabel
        ? `Updated channel canvas ${target.canvasId} for ${target.channelLabel}.`
        : `Updated canvas ${target.canvasId}.`;

      return {
        content: [
          {
            type: "text",
            text: `${targetSummary} Mode: ${mode}.${sectionSummary} Content: ${getSlackCanvasSummary(params.markdown)}`,
          },
        ],
        details: {
          canvas_id: target.canvasId,
          channel: target.channelId,
          mode,
          section_id: sectionId,
        },
      };
    },
  });

  registerSlackAction({
    name: "slack_confirm_action",
    label: "Slack Confirm Action",
    description:
      "Request user confirmation in a Slack thread before performing a dangerous action. Use when security guardrails require confirmation for a tool.",
    promptSnippet: "Request confirmation in Slack before dangerous actions.",
    parameters: Type.Object({
      thread_ts: Type.String({ description: "Thread to post confirmation request in" }),
      action: Type.String({
        description:
          "Exact action string required by the guarded tool. Copy it from the guardrail error and retry the guarded call unchanged after approval.",
      }),
      tool: Type.String({
        description:
          "Exact guardrail tool name that requires confirmation. For Slack dispatcher actions, use slack:<action> such as slack:delete.",
      }),
    }),
    async execute(_id, params) {
      const channelId = await resolveTrackedThreadChannel(params.thread_ts);
      if (!channelId) {
        throw new Error(`No active Slack thread for thread_ts: ${params.thread_ts}`);
      }

      const confirmationTool = normalizeSlackGuardrailToolName(params.tool);
      const confirmMessage =
        `⚠️ *Action requires confirmation*\n\n` +
        `Tool: \`${confirmationTool}\`\n` +
        `Action: ${params.action}\n\n` +
        `Reply *yes* to approve or *no* to reject.`;

      const registration = registerConfirmationRequest(
        params.thread_ts,
        confirmationTool,
        params.action,
      );
      if (registration.status === "conflict") {
        throw new Error(
          `Thread ${params.thread_ts} already has a pending confirmation for tool "${registration.conflict?.toolPattern}" and action ${JSON.stringify(registration.conflict?.action ?? "")}. Wait for a reply or expiry before requesting another action in the same thread.`,
        );
      }

      if (registration.status === "refreshed") {
        return {
          content: [
            {
              type: "text",
              text: `A matching confirmation request is already pending in thread ${params.thread_ts}. Wait for the user's response via slack_inbox before proceeding.`,
            },
          ],
          details: {
            thread_ts: params.thread_ts,
            tool: confirmationTool,
            status: registration.status,
          },
        };
      }

      await slack("chat.postMessage", getBotToken(), {
        channel: channelId,
        thread_ts: params.thread_ts,
        text: confirmMessage,
        metadata: {
          event_type: "pi_agent_msg",
          event_payload: { agent: getAgentName(), agent_owner: getAgentOwnerToken() },
        },
      });

      return {
        content: [
          {
            type: "text",
            text: `Confirmation requested in thread ${params.thread_ts}. Wait for the user's response via slack_inbox before proceeding. If the user approves, continue with the action. If denied, inform them and skip the action.`,
          },
        ],
        details: {
          thread_ts: params.thread_ts,
          tool: confirmationTool,
          status: registration.status,
        },
      };
    },
  });
}
