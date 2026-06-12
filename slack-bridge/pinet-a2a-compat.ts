import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { PinetReadOptions, PinetReadResult } from "@pinet/pinet-core/pinet-read-formatting";
import type { PinetToolsAgentRecord } from "./pinet-tools.js";

export interface RegisterPinetA2ACompatToolsDeps {
  pinetEnabled: () => boolean;
  brokerRole: () => "broker" | "follower" | null;
  requireToolPolicy: (toolName: string, threadTs: string | undefined, action: string) => void;
  sendPinetAgentMessage: (
    target: string,
    body: string,
    metadata?: Record<string, unknown>,
  ) => Promise<{ messageId: number; target: string }>;
  readPinetInbox: (options: PinetReadOptions) => Promise<PinetReadResult>;
  listBrokerAgents: () => PinetToolsAgentRecord[];
  listFollowerAgents: (includeGhosts: boolean) => Promise<PinetToolsAgentRecord[]>;
}

type CommentActorType = "human" | "agent";

const DEFAULT_THREAD_ID = "global";
const CONTEXT_THREAD_PREFIX = "ctx:";

interface CommentContext {
  file: string;
  startLine?: number;
  endLine?: number;
}

interface CompatCommentAddParams {
  body?: string;
  comment?: string;
  threadId?: string;
  thread_id?: string;
  actorType?: string;
  actor_type?: string;
  actorId?: string;
  actor_id?: string;
  file?: string;
  start_line?: number;
  end_line?: number;
  context?: {
    file?: string;
    startLine?: number;
    endLine?: number;
  } | null;
}

interface CompatCommentRecord {
  id: string;
  threadId: string;
  actorType: CommentActorType;
  actorId: string;
  createdAt: string;
  bodyPath: string;
  body: string;
  context?: CommentContext;
  pinetThreadId: string;
  pinetMessageId: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeThreadId(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : DEFAULT_THREAD_ID;
}

function normalizeActorType(value: unknown): CommentActorType {
  return value === "human" ? "human" : "agent";
}

function normalizeActorId(value: unknown, actorType: CommentActorType): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (actorType === "human") return process.env.USER?.trim() || "human";
  return process.env.PI_NICKNAME?.trim() || "pi";
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeContext(value: unknown): CommentContext | undefined {
  if (!isRecord(value) || typeof value.file !== "string") return undefined;
  const file = value.file.trim();
  if (!file) return undefined;

  let startLine = normalizePositiveInteger(value.startLine);
  let endLine = normalizePositiveInteger(value.endLine);
  if (startLine != null && endLine == null) endLine = startLine;
  if (startLine == null && endLine != null) startLine = endLine;
  if (startLine != null && endLine != null && startLine > endLine) {
    [startLine, endLine] = [endLine, startLine];
  }

  return {
    file,
    ...(startLine != null ? { startLine } : {}),
    ...(endLine != null ? { endLine } : {}),
  };
}

function getStringMetadata(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getRecordMetadata(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = metadata?.[key];
  return isRecord(value) ? value : null;
}

function isBrokerAgent(agent: PinetToolsAgentRecord): boolean {
  const metadata = agent.metadata;
  const capabilities = getRecordMetadata(metadata, "capabilities");
  return (
    metadata?.role === "broker" ||
    capabilities?.role === "broker" ||
    metadata?.subtreeBroker === true
  );
}

async function listVisibleAgents(
  deps: RegisterPinetA2ACompatToolsDeps,
): Promise<PinetToolsAgentRecord[]> {
  if (deps.brokerRole() === "broker") return deps.listBrokerAgents();
  if (deps.brokerRole() === "follower") return await deps.listFollowerAgents(true);
  return [];
}

async function resolveCompatTarget(deps: RegisterPinetA2ACompatToolsDeps): Promise<string> {
  const agents = await listVisibleAgents(deps);
  const liveBroker = agents.find((agent) => isBrokerAgent(agent) && !agent.disconnectedAt);
  if (liveBroker) return liveBroker.id;

  const brokerWasVisible = agents.some(isBrokerAgent);
  throw new Error(
    brokerWasVisible
      ? "No live Pinet broker/subtree broker agent is visible for legacy a2a comment compatibility."
      : "No Pinet broker/subtree broker agent is visible for legacy a2a comment compatibility.",
  );
}

function buildContextThreadId(context: CommentContext | undefined): string | null {
  if (!context?.file || context.startLine == null || context.endLine == null) return null;
  return `${CONTEXT_THREAD_PREFIX}${context.file}:${context.startLine}-${context.endLine}`;
}

function resolveThreadId(threadId: unknown, context: CommentContext | undefined): string {
  const normalized = normalizeThreadId(threadId);
  if (normalized !== DEFAULT_THREAD_ID) return normalized;
  return buildContextThreadId(context) ?? DEFAULT_THREAD_ID;
}

function formatContextLine(context: CommentContext | undefined): string | null {
  if (!context) return null;
  if (context.startLine != null && context.endLine != null) {
    return `Context: ${context.file}:${context.startLine}-${context.endLine}`;
  }
  return `Context: ${context.file}`;
}

export function buildCompatCommentMessage(input: CompatCommentAddParams): {
  body: string;
  threadId: string;
  actorType: CommentActorType;
  actorId: string;
  context?: CommentContext;
  metadata: Record<string, unknown>;
} {
  const rawBody = typeof input.comment === "string" ? input.comment : input.body;
  const body = rawBody?.trim() ?? "";
  if (!body) throw new Error("Comment body cannot be empty");

  const actorType = normalizeActorType(input.actor_type ?? input.actorType);
  const actorId = normalizeActorId(input.actor_id ?? input.actorId, actorType);
  const context = normalizeContext(
    input.context ??
      (typeof input.file === "string"
        ? { file: input.file, startLine: input.start_line, endLine: input.end_line }
        : undefined),
  );
  const threadId = resolveThreadId(input.thread_id ?? input.threadId, context);
  const header = [
    "A2A compatibility comment",
    `Thread: ${threadId}`,
    `Actor: ${actorType}:${actorId}`,
    formatContextLine(context),
  ].filter((line): line is string => Boolean(line));

  return {
    body: `${header.join("\n")}\n\n${body}`,
    threadId,
    actorType,
    actorId,
    ...(context ? { context } : {}),
    metadata: {
      a2aCompat: true,
      legacyTool: "comment_add",
      legacyThreadId: threadId,
      legacyActorType: actorType,
      legacyActorId: actorId,
      ...(context ? { legacyContext: context } : {}),
    },
  };
}

function getCompatMessageBody(body: string): string {
  const marker = "\n\n";
  const index = body.indexOf(marker);
  return index >= 0 && body.startsWith("A2A compatibility comment\n")
    ? body.slice(index + marker.length)
    : body;
}

export function mapPinetReadResultToCompatComments(
  result: PinetReadResult,
  requestedThreadId?: string,
): { threadId: string; total: number; comments: CompatCommentRecord[] } {
  const filterThreadId = requestedThreadId?.trim();
  const comments = result.messages
    .map((item): CompatCommentRecord | null => {
      const metadata = item.message.metadata ?? {};
      const legacyThreadId = getStringMetadata(metadata, "legacyThreadId") ?? item.message.threadId;
      if (
        filterThreadId &&
        legacyThreadId !== filterThreadId &&
        item.message.threadId !== filterThreadId
      ) {
        return null;
      }
      const legacyContext = getRecordMetadata(metadata, "legacyContext");
      const context = normalizeContext(legacyContext);
      const actorType = normalizeActorType(metadata.legacyActorType);
      const actorId =
        getStringMetadata(metadata, "legacyActorId") ??
        getStringMetadata(metadata, "senderAgent") ??
        item.message.sender;
      return {
        id: `pinet-${item.message.id}`,
        threadId: legacyThreadId,
        actorType,
        actorId,
        createdAt: item.message.createdAt,
        bodyPath: `pinet:${item.message.id}`,
        body: getCompatMessageBody(item.message.body),
        ...(context ? { context } : {}),
        pinetThreadId: item.message.threadId,
        pinetMessageId: item.message.id,
      };
    })
    .filter((comment): comment is CompatCommentRecord => comment !== null);

  return {
    threadId: filterThreadId || DEFAULT_THREAD_ID,
    total: result.totalMatching ?? comments.length,
    comments,
  };
}

export function registerPinetA2ACompatTools(
  pi: ExtensionAPI,
  deps: RegisterPinetA2ACompatToolsDeps,
): void {
  pi.registerTool({
    name: "comment_add",
    label: "A2A Comment Add (Pinet compatibility)",
    description:
      "Compatibility shim for legacy PiComms/a2a comment writers. Sends the comment through Pinet to the visible broker or subtree broker instead of writing the removed local PiComms store.",
    parameters: Type.Object({
      comment: Type.Optional(Type.String({ description: "Legacy markdown comment body" })),
      body: Type.Optional(Type.String({ description: "Comment body (camelCase alias)" })),
      thread_id: Type.Optional(Type.String({ description: "Legacy PiComms/a2a thread id" })),
      threadId: Type.Optional(Type.String({ description: "Thread id (camelCase alias)" })),
      actor_type: Type.Optional(
        Type.String({ description: 'Legacy actor type: "agent" or "human"' }),
      ),
      actorType: Type.Optional(Type.String({ description: "Actor type (camelCase alias)" })),
      actor_id: Type.Optional(Type.String({ description: "Legacy actor id/name" })),
      actorId: Type.Optional(Type.String({ description: "Actor id/name (camelCase alias)" })),
      file: Type.Optional(Type.String({ description: "Optional legacy file path for context" })),
      start_line: Type.Optional(Type.Number({ description: "Optional legacy start line" })),
      end_line: Type.Optional(Type.Number({ description: "Optional legacy end line" })),
      context: Type.Optional(
        Type.Union([
          Type.Object({
            file: Type.Optional(Type.String()),
            startLine: Type.Optional(Type.Number()),
            endLine: Type.Optional(Type.Number()),
          }),
          Type.Null(),
        ]),
      ),
    }),
    async execute(_toolCallId, params) {
      deps.requireToolPolicy(
        "comment_add",
        undefined,
        `thread_id=${params.thread_id ?? params.threadId ?? ""}`,
      );
      if (!deps.pinetEnabled()) {
        throw new Error("Pinet is not running. Use /pinet start or /pinet follow first.");
      }

      const compat = buildCompatCommentMessage(params);
      const target = await resolveCompatTarget(deps);
      const sent = await deps.sendPinetAgentMessage(target, compat.body, compat.metadata);
      return {
        content: [
          {
            type: "text",
            text: `A2A compatibility comment sent through Pinet to ${sent.target} (message ${sent.messageId}).`,
          },
        ],
        details: {
          id: `pinet-${sent.messageId}`,
          threadId: compat.threadId,
          target: sent.target,
          messageId: sent.messageId,
          actorType: compat.actorType,
          actorId: compat.actorId,
          ...(compat.context ? { context: compat.context } : {}),
        },
      };
    },
  });

  pi.registerTool({
    name: "comment_list",
    label: "A2A Comment List (Pinet compatibility)",
    description:
      "Compatibility shim for legacy PiComms/a2a comment readers. Returns this agent's Pinet inbox rows as comment-shaped records; it does not read the removed local PiComms store.",
    parameters: Type.Object({
      thread_id: Type.Optional(
        Type.String({
          description:
            "Legacy thread id to filter; use an a2a: prefix to filter by native Pinet thread id",
        }),
      ),
      threadId: Type.Optional(Type.String({ description: "Thread id (camelCase alias)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum messages to return" })),
    }),
    async execute(_toolCallId, params) {
      deps.requireToolPolicy(
        "comment_list",
        undefined,
        `thread_id=${params.thread_id ?? params.threadId ?? ""}`,
      );
      if (!deps.pinetEnabled()) {
        throw new Error("Pinet is not running. Use /pinet start or /pinet follow first.");
      }

      const rawThreadId = params.thread_id ?? params.threadId;
      const threadId = normalizeThreadId(rawThreadId);
      const result = await deps.readPinetInbox({
        ...(threadId.startsWith("a2a:") ? { threadId } : {}),
        ...(!threadId.startsWith("a2a:") ? { legacyThreadId: threadId } : {}),
        ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
        unreadOnly: false,
        markRead: false,
      });
      const comments = mapPinetReadResultToCompatComments(result, threadId || undefined);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(comments, null, 2),
          },
        ],
        details: comments,
      };
    },
  });
}
