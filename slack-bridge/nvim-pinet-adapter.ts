import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
  buildContextualThreadMetadata,
  buildNvimThreadId,
  formatAnchorForMessage,
  hasSameCodeRevision,
  parseContextualThreadMetadata,
  updateContextualThreadResolvedState,
  type CodeRevisionIdentity,
  type ContextJsonObject,
  type ContextJsonValue,
  type ContextualThreadMetadata,
} from "./code-anchor.js";
import type {
  BrokerMessage,
  InboundMessage,
  MessageAdapter,
  OutboundMessage,
  ThreadInfo,
  DocumentInfo,
} from "./broker/types.js";
import { resolveCommand } from "@pinet/transport-core/commands";

export interface NvimAdapterDbPort {
  getThread(threadId: string): ThreadInfo | null;
  getDocument(documentId: string): DocumentInfo | null;
  getDocumentByAlias(source: string, externalId: string): DocumentInfo | null;
  upsertDocument(document: Omit<DocumentInfo, "createdAt" | "updatedAt">): DocumentInfo;
  bindDocumentAlias(
    source: string,
    externalId: string,
    documentId: string,
    metadata?: Record<string, ContextJsonValue> | null,
  ): void;
  setDocumentOwner(documentId: string, ownerAgent: string | null): DocumentInfo;
  subscribeDocument(documentId: string, agentId: string): void;
  unsubscribeDocument(documentId: string, agentId: string): void;
  listDocumentSubscribers(documentId: string): string[];
  getDocumentRecipients(documentId: string): string[];
  createThread(thread: ThreadInfo): ThreadInfo;
  updateThread(threadId: string, updates: Partial<ThreadInfo>): void;
  getThreads(ownerAgent?: string): ThreadInfo[];
  getMessagesForThread(threadId: string, limit?: number): BrokerMessage[];
  insertMessage(
    threadId: string,
    source: string,
    direction: "inbound" | "outbound",
    sender: string,
    body: string,
    targetAgentIds: string[],
    metadata?: Record<string, ContextJsonValue>,
  ): BrokerMessage;
  getAgent?(agentId: string): { id: string; name: string } | null;
}

export interface NvimRepositoryContext {
  repository: string;
  worktree: string;
  branch: string;
  headOid: string;
  baseOid: string | null;
}

export interface NvimPinetAdapterOptions extends NvimRepositoryContext {
  db: NvimAdapterDbPort;
  getAgentById: (agentId: string) => { id: string; name: string } | null;
}

interface NvimRpcRequest {
  id: string | null;
  type: string;
  payload: ContextJsonObject;
}

interface NvimCreateThreadRequest {
  targetAgentId: string | null;
  body: string;
  anchor: CodeRevisionIdentity;
  startLine: number;
  endLine: number;
  selectedText: string | null;
  contextText: string | null;
}

interface NvimReplyRequest {
  threadId: string;
  body: string;
}

interface NvimResolveRequest {
  threadId: string;
  resolved: boolean;
}

interface NvimListRequest {
  anchor: CodeRevisionIdentity;
  includeResolved: boolean;
  limit: number;
}

interface NvimDocumentAgentRequest {
  anchor: CodeRevisionIdentity;
  agentId: string;
}

interface NvimDocumentRequest {
  anchor: CodeRevisionIdentity;
}

interface NvimBindThreadRequest extends NvimDocumentRequest {
  threadId: string;
}

interface NvimEditorState {
  file: string | null;
  line: number | null;
  visibleStart: number | null;
  visibleEnd: number | null;
  selectionStart: number | null;
  selectionEnd: number | null;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(resolveCommand("git"), args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function resolveNvimRepositoryContext(cwd: string): NvimRepositoryContext | null {
  try {
    const worktree = fs.realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
    const commonDir = fs.realpathSync(
      git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
    const repository = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
    const branch = git(cwd, "branch", "--show-current");
    const headOid = git(cwd, "rev-parse", "HEAD");
    let baseOid: string | null = null;
    try {
      baseOid = git(cwd, "merge-base", "HEAD", "@{upstream}");
    } catch {
      baseOid = null;
    }
    return { repository, worktree, branch, headOid, baseOid };
  } catch {
    return null;
  }
}

export function buildGitFileAliasExternalId(
  anchor: Pick<CodeRevisionIdentity, "repository" | "worktree" | "path">,
): string {
  return `${anchor.repository}\0${anchor.worktree}\0${anchor.path}`;
}

export function buildGitFileDocumentId(
  anchor: Pick<CodeRevisionIdentity, "repository" | "worktree" | "path">,
): string {
  return `doc:git-file:${createHash("sha256").update(buildGitFileAliasExternalId(anchor)).digest("hex")}`;
}

function computeRepoSocketHash(worktree: string, branch: string): string {
  return createHash("sha256").update(`${worktree}:${branch}`).digest("hex");
}

export function computeNvimSocketPath(worktree: string, branch: string): string {
  const dir = "/tmp/pi-nvim";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return path.join(dir, `${computeRepoSocketHash(worktree, branch)}.sock`);
}

function getRecord(value: ContextJsonValue | undefined): ContextJsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function getString(record: ContextJsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getPositiveInteger(
  record: ContextJsonObject,
  key: string,
  fallback: number | null,
): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}

// agent-standards-ignore prefer-inline-single-use-helper: versioned socket envelope parser is a protocol boundary.
function parseRequest(line: string): { id: string | null; request: NvimRpcRequest | null } {
  const parsed = JSON.parse(line) as ContextJsonValue;
  const record = getRecord(parsed);
  const id = record ? getString(record, "id") : null;
  const type = record ? getString(record, "type") : null;
  if (!record || !type) return { id, request: null };
  return {
    id,
    request: {
      id,
      type,
      payload: getRecord(record.payload) ?? record,
    },
  };
}

function parseAnchor(payload: ContextJsonObject): NvimListRequest["anchor"] | null {
  const anchor = getRecord(payload.anchor);
  if (!anchor) return null;
  const repository = getString(anchor, "repository");
  const worktree = getString(anchor, "worktree");
  const anchorPath = getString(anchor, "path");
  const headOid = getString(anchor, "headOid");
  const blobOid = getString(anchor, "blobOid");
  const side = anchor.side === "old" || anchor.side === "new" ? anchor.side : null;
  const anchorKind =
    anchor.anchorKind === "normal" || anchor.anchorKind === "diff"
      ? anchor.anchorKind
      : side
        ? "diff"
        : null;
  if (!repository || !worktree || !anchorPath || !headOid || !blobOid || !anchorKind) return null;
  if (anchorKind === "diff" && !side) return null;
  if (anchorKind === "normal" && typeof anchor.dirty !== "boolean") return null;
  return {
    repository,
    worktree,
    path: anchorPath,
    baseOid: getString(anchor, "baseOid"),
    headOid,
    blobOid,
    anchorKind,
    ...(side ? { side } : {}),
    ...(anchorKind === "normal"
      ? { headBlobOid: getString(anchor, "headBlobOid"), dirty: anchor.dirty === true }
      : {}),
  };
}

// agent-standards-ignore prefer-inline-single-use-helper: create payload parser is a named protocol DTO boundary.
function parseCreateThreadRequest(payload: ContextJsonObject): NvimCreateThreadRequest | null {
  const targetAgentId = getString(payload, "targetAgentId");
  const body = getString(payload, "body");
  const anchor = parseAnchor(payload);
  const startLine = getPositiveInteger(payload, "startLine", null);
  const endLine = getPositiveInteger(payload, "endLine", startLine);
  if (!body || !anchor || startLine == null || endLine == null) return null;
  return {
    targetAgentId,
    body,
    anchor,
    startLine,
    endLine,
    selectedText: getString(payload, "selectedText"),
    contextText: getString(payload, "contextText"),
  };
}

// agent-standards-ignore prefer-inline-single-use-helper: reply payload parser is a named protocol DTO boundary.
function parseReplyRequest(payload: ContextJsonObject): NvimReplyRequest | null {
  const threadId = getString(payload, "threadId");
  const body = getString(payload, "body");
  return threadId && body ? { threadId, body } : null;
}

// agent-standards-ignore prefer-inline-single-use-helper: resolution payload parser is a named protocol DTO boundary.
function parseResolveRequest(payload: ContextJsonObject): NvimResolveRequest | null {
  const threadId = getString(payload, "threadId");
  if (!threadId || typeof payload.resolved !== "boolean") return null;
  return { threadId, resolved: payload.resolved };
}

// agent-standards-ignore prefer-inline-single-use-helper: list payload parser is a named protocol DTO boundary.
function parseListRequest(payload: ContextJsonObject): NvimListRequest | null {
  const anchor = parseAnchor(payload);
  if (!anchor) return null;
  return {
    anchor,
    includeResolved: typeof payload.includeResolved === "boolean" ? payload.includeResolved : false,
    limit: getPositiveInteger(payload, "limit", 100) ?? 100,
  };
}

// agent-standards-ignore prefer-inline-single-use-helper: document payload parser is a named protocol DTO boundary.
function parseDocumentRequest(payload: ContextJsonObject): NvimDocumentRequest | null {
  const anchor = parseAnchor(payload);
  return anchor ? { anchor } : null;
}

function parseBindThreadRequest(payload: ContextJsonObject): NvimBindThreadRequest | null {
  const anchor = parseAnchor(payload);
  const threadId = getString(payload, "threadId");
  return anchor && threadId ? { anchor, threadId } : null;
}

function parseDocumentAgentRequest(payload: ContextJsonObject): NvimDocumentAgentRequest | null {
  const anchor = parseAnchor(payload);
  const agentId = getString(payload, "agentId");
  return anchor && agentId ? { anchor, agentId } : null;
}

function serializeMetadata(metadata: ContextualThreadMetadata): Record<string, ContextJsonValue> {
  return JSON.parse(JSON.stringify(metadata)) as Record<string, ContextJsonValue>;
}

function sendJson(socket: net.Socket, payload: ContextJsonObject): void {
  socket.write(`${JSON.stringify(payload)}\n`);
}

export class NvimPinetAdapter implements MessageAdapter {
  readonly name = "nvim";
  private readonly repoSocketHash: string;
  private readonly socketPath: string;
  private server: net.Server | null = null;
  private inboundHandler: ((msg: InboundMessage) => void) | null = null;
  private readonly clients = new Set<net.Socket>();
  private readonly editorState: NvimEditorState = {
    file: null,
    line: null,
    visibleStart: null,
    visibleEnd: null,
    selectionStart: null,
    selectionEnd: null,
  };

  constructor(private readonly options: NvimPinetAdapterOptions) {
    this.repoSocketHash = computeRepoSocketHash(options.worktree, options.branch);
    this.socketPath = computeNvimSocketPath(options.worktree, options.branch);
  }

  async connect(): Promise<void> {
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Missing stale socket is fine.
    }

    await new Promise<void>((resolve, reject) => {
      this.server = net.createServer((socket) => this.accept(socket));
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server?.off("error", reject);
        fs.chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Ignore stale socket cleanup failures.
    }
  }

  onInbound(handler: (msg: InboundMessage) => void): void {
    this.inboundHandler = handler;
  }

  async send(message: OutboundMessage): Promise<void> {
    this.broadcast({
      type: "thread.updated",
      payload: {
        threadId: message.threadId,
        channel: message.channel,
        body: message.text,
        sender: message.agentName ?? "agent",
      },
    });
  }

  private accept(socket: net.Socket): void {
    this.clients.add(socket);
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) this.handleLine(socket, line);
      }
    });
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
  }

  private handleLine(socket: net.Socket, line: string): void {
    let request: NvimRpcRequest | null = null;
    let requestId: string | null = null;
    try {
      const parsed = parseRequest(line);
      request = parsed.request;
      requestId = parsed.id;
      if (!request) {
        sendJson(socket, {
          type: "error",
          id: requestId ?? "request-error",
          error: { code: "invalid_request", message: "type is required" },
        });
        return;
      }
      const result = this.handleRequest(request);
      if (request.id) sendJson(socket, { type: "ok", id: request.id, result });
    } catch (error) {
      sendJson(socket, {
        type: "error",
        id: requestId ?? request?.id ?? "request-error",
        error: {
          code: "request_error",
          message: error instanceof Error ? error.message : "nvim request failed",
        },
      });
    }
  }

  private handleRequest(request: NvimRpcRequest): ContextJsonObject {
    switch (request.type) {
      case "buffer_focus": {
        const file = getString(request.payload, "file");
        const line = getPositiveInteger(request.payload, "line", null);
        if (file) this.editorState.file = file;
        if (line != null) this.editorState.line = line;
        return { status: "ok" };
      }
      case "visible_range": {
        const file = getString(request.payload, "file");
        if (file) this.editorState.file = file;
        this.editorState.visibleStart = getPositiveInteger(request.payload, "start", null);
        this.editorState.visibleEnd = getPositiveInteger(request.payload, "end", null);
        return { status: "ok" };
      }
      case "selection": {
        const file = getString(request.payload, "file");
        if (file) this.editorState.file = file;
        this.editorState.selectionStart = getPositiveInteger(request.payload, "start", null);
        this.editorState.selectionEnd = getPositiveInteger(request.payload, "end", null);
        return { status: "ok" };
      }
      case "editor.context":
        return { ...this.editorState };
      case "editor.open": {
        const file = getString(request.payload, "file");
        if (!file) throw new Error("file is required");
        const line = getPositiveInteger(request.payload, "line", null);
        this.broadcast({ type: "open_file", file, ...(line ? { line } : {}) });
        return { delivered: this.clients.size > 1 };
      }
      case "pinet.thread.create":
        return this.createThread(request.payload);
      case "pinet.thread.reply":
        return this.replyToThread(request.payload);
      case "pinet.thread.resolve":
        return this.resolveThread(request.payload);
      case "pinet.thread.list":
        return this.listThreads(request.payload);
      case "pinet.thread.get":
        return this.getThread(request.payload);
      case "pinet.document.get":
        return this.getDocument(request.payload);
      case "pinet.document.owner":
        return this.setDocumentOwner(request.payload);
      case "pinet.document.subscribe":
        return this.subscribeDocument(request.payload, true);
      case "pinet.document.unsubscribe":
        return this.subscribeDocument(request.payload, false);
      case "pinet.document.bind_thread":
        return this.bindDocumentThread(request.payload);
      default:
        throw new Error(`Unknown nvim request: ${request.type}`);
    }
  }

  private resolveGitDocument(anchor: CodeRevisionIdentity): DocumentInfo | null {
    return (
      this.options.db.getDocumentByAlias("nvim", buildGitFileAliasExternalId(anchor)) ??
      this.options.db.getDocument(buildGitFileDocumentId(anchor))
    );
  }

  private createThread(payload: ContextJsonObject): ContextJsonObject {
    const parsed = parseCreateThreadRequest(payload);
    if (!parsed) throw new Error("body, anchor, startLine, and endLine are required");
    if (
      parsed.anchor.repository !== this.options.repository ||
      parsed.anchor.worktree !== this.options.worktree
    ) {
      throw new Error("code anchor does not belong to this Pinet worktree");
    }
    let document = this.resolveGitDocument(parsed.anchor);
    const documentId = document?.documentId ?? buildGitFileDocumentId(parsed.anchor);
    const targetAgentId = parsed.targetAgentId ?? document?.ownerAgent ?? null;
    if (!targetAgentId)
      throw new Error("targetAgentId is required until this document has an owner");
    if (!this.options.getAgentById(targetAgentId)) {
      throw new Error(`Unknown target agent: ${targetAgentId}`);
    }
    if (!document) {
      document = this.options.db.upsertDocument({
        documentId,
        kind: "git_file",
        title: parsed.anchor.path,
        ownerAgent: targetAgentId,
        ownerBinding: "explicit",
        metadata: {
          repository: parsed.anchor.repository,
          worktree: parsed.anchor.worktree,
          path: parsed.anchor.path,
        },
      });
      this.options.db.bindDocumentAlias(
        "nvim",
        buildGitFileAliasExternalId(parsed.anchor),
        documentId,
      );
    }
    const metadata = buildContextualThreadMetadata({
      ...parsed.anchor,
      startLine: parsed.startLine,
      endLine: parsed.endLine,
      selectedText: parsed.selectedText,
      contextText: parsed.contextText,
    });
    const threadId = buildNvimThreadId(this.repoSocketHash);
    const now = new Date().toISOString();
    this.options.db.createThread({
      threadId,
      source: "nvim",
      channel: this.repoSocketHash,
      ownerAgent: targetAgentId,
      ownerBinding: "explicit",
      metadata: { ...serializeMetadata(metadata), documentId },
      createdAt: now,
      updatedAt: now,
    });
    this.emitInbound(
      threadId,
      targetAgentId,
      `${formatAnchorForMessage(metadata)}\n\n${parsed.body}`,
      {
        pinetKind: "contextual_thread_message",
        schemaVersion: 1,
        event: "thread.created",
        documentId,
      },
    );
    return { threadId, metadata: serializeMetadata(metadata) };
  }

  private replyToThread(payload: ContextJsonObject): ContextJsonObject {
    const parsed = parseReplyRequest(payload);
    if (!parsed) throw new Error("threadId and body are required");
    const thread = this.options.db.getThread(parsed.threadId);
    if (!thread) throw new Error(`Unknown thread: ${parsed.threadId}`);
    const documentId =
      typeof thread.metadata?.documentId === "string" ? thread.metadata.documentId : null;
    this.emitInbound(parsed.threadId, thread.ownerAgent ?? "", parsed.body, {
      pinetKind: "contextual_thread_message",
      schemaVersion: 1,
      event: "thread.reply",
      ...(documentId ? { documentId } : {}),
    });
    return { threadId: parsed.threadId };
  }

  private resolveThread(payload: ContextJsonObject): ContextJsonObject {
    const parsed = parseResolveRequest(payload);
    if (!parsed) throw new Error("threadId and resolved are required");
    const thread = this.options.db.getThread(parsed.threadId);
    const metadata = parseContextualThreadMetadata(thread?.metadata as ContextJsonValue);
    if (!thread || !metadata) throw new Error(`Unknown contextual thread: ${parsed.threadId}`);
    const updated = updateContextualThreadResolvedState(metadata, parsed.resolved, "nvim");
    this.options.db.updateThread(parsed.threadId, { metadata: serializeMetadata(updated) });
    const documentId =
      typeof thread.metadata?.documentId === "string" ? thread.metadata.documentId : null;
    this.emitInbound(
      parsed.threadId,
      thread.ownerAgent ?? "",
      parsed.resolved ? "Resolved this thread." : "Reopened this thread.",
      {
        pinetKind: "contextual_thread_message",
        schemaVersion: 1,
        event: parsed.resolved ? "thread.resolved" : "thread.reopened",
        ...(documentId ? { documentId } : {}),
      },
    );
    this.broadcast({ type: "thread.updated", payload: { threadId: parsed.threadId } });
    return { threadId: parsed.threadId, metadata: serializeMetadata(updated) };
  }

  private listThreads(payload: ContextJsonObject): ContextJsonObject {
    const parsed = parseListRequest(payload);
    if (!parsed) throw new Error("revision-aware anchor is required");
    const threads = this.options.db
      .getThreads()
      .map((thread) => ({
        thread,
        metadata: parseContextualThreadMetadata(thread.metadata as ContextJsonValue),
      }))
      .filter(
        (item): item is { thread: ThreadInfo; metadata: ContextualThreadMetadata } =>
          item.metadata !== null && hasSameCodeRevision(item.metadata.codeAnchor, parsed.anchor),
      )
      .filter((item) => parsed.includeResolved || !item.metadata.state.resolved)
      .slice(0, parsed.limit)
      .map((item) => this.serializeThread(item.thread, item.metadata, 20));
    return { threads };
  }

  private getThread(payload: ContextJsonObject): ContextJsonObject {
    const threadId = getString(payload, "threadId");
    if (!threadId) throw new Error("threadId is required");
    const thread = this.options.db.getThread(threadId);
    const metadata = parseContextualThreadMetadata(thread?.metadata as ContextJsonValue);
    if (!thread || !metadata) throw new Error(`Unknown contextual thread: ${threadId}`);
    return this.serializeThread(thread, metadata, 50);
  }

  private getDocument(payload: ContextJsonObject): ContextJsonObject {
    const parsed = parseDocumentRequest(payload);
    if (!parsed) throw new Error("revision-aware anchor is required");
    const document = this.resolveGitDocument(parsed.anchor);
    const documentId = document?.documentId ?? buildGitFileDocumentId(parsed.anchor);
    return {
      documentId,
      ownerAgentId: document?.ownerAgent ?? null,
      subscribers: document ? this.options.db.listDocumentSubscribers(documentId) : [],
    };
  }

  private setDocumentOwner(payload: ContextJsonObject): ContextJsonObject {
    const parsed = parseDocumentAgentRequest(payload);
    if (!parsed) throw new Error("anchor and agentId are required");
    if (!this.options.getAgentById(parsed.agentId))
      throw new Error(`Unknown agent: ${parsed.agentId}`);
    const existingDocument = this.resolveGitDocument(parsed.anchor);
    const documentId = existingDocument?.documentId ?? buildGitFileDocumentId(parsed.anchor);
    if (!existingDocument) {
      this.options.db.upsertDocument({
        documentId,
        kind: "git_file",
        title: parsed.anchor.path,
        ownerAgent: parsed.agentId,
        ownerBinding: "explicit",
        metadata: {
          repository: parsed.anchor.repository,
          worktree: parsed.anchor.worktree,
          path: parsed.anchor.path,
        },
      });
    } else {
      this.options.db.setDocumentOwner(documentId, parsed.agentId);
    }
    this.options.db.bindDocumentAlias(
      "nvim",
      buildGitFileAliasExternalId(parsed.anchor),
      documentId,
    );
    for (const thread of this.options.db.getThreads()) {
      if (thread.metadata?.documentId === documentId && thread.ownerAgent !== parsed.agentId) {
        this.options.db.updateThread(thread.threadId, {
          ownerAgent: parsed.agentId,
          ownerBinding: "explicit",
        });
      }
    }
    this.emitDocumentEvent(
      documentId,
      parsed.agentId,
      `Document owner changed to ${parsed.agentId}.`,
      "document.owner_changed",
    );
    return this.getDocument({ anchor: parsed.anchor });
  }

  private subscribeDocument(payload: ContextJsonObject, subscribe: boolean): ContextJsonObject {
    const parsed = parseDocumentAgentRequest(payload);
    if (!parsed) throw new Error("anchor and agentId are required");
    if (!this.options.getAgentById(parsed.agentId))
      throw new Error(`Unknown agent: ${parsed.agentId}`);
    const document = this.resolveGitDocument(parsed.anchor);
    const documentId = document?.documentId ?? buildGitFileDocumentId(parsed.anchor);
    if (!document) throw new Error(`Unknown document: ${documentId}`);
    if (subscribe) this.options.db.subscribeDocument(documentId, parsed.agentId);
    else this.options.db.unsubscribeDocument(documentId, parsed.agentId);
    const updatedDocument = this.options.db.getDocument(documentId)!;
    this.emitDocumentEvent(
      documentId,
      updatedDocument.ownerAgent ?? parsed.agentId,
      subscribe
        ? `${parsed.agentId} subscribed to this document.`
        : `${parsed.agentId} unsubscribed from this document.`,
      subscribe ? "document.subscribed" : "document.unsubscribed",
    );
    return this.getDocument({ anchor: parsed.anchor });
  }

  private bindDocumentThread(payload: ContextJsonObject): ContextJsonObject {
    const parsed = parseBindThreadRequest(payload);
    if (!parsed) throw new Error("anchor and threadId are required");
    const document = this.resolveGitDocument(parsed.anchor);
    if (!document?.ownerAgent)
      throw new Error("Set a document owner before binding a Slack thread");
    const thread = this.options.db.getThread(parsed.threadId);
    if (!thread || thread.source !== "slack") {
      throw new Error(`Unknown Slack thread: ${parsed.threadId}`);
    }

    const previousDocumentId =
      typeof thread.metadata?.documentId === "string" ? thread.metadata.documentId : null;
    if (previousDocumentId && previousDocumentId !== document.documentId) {
      for (const subscriber of this.options.db.listDocumentSubscribers(previousDocumentId)) {
        this.options.db.subscribeDocument(document.documentId, subscriber);
      }
    }
    const referenceExternalId = `${thread.channel}\0${thread.threadId}`;
    this.options.db.bindDocumentAlias(
      "slack-thread-ref",
      referenceExternalId,
      document.documentId,
      { channelId: thread.channel, threadTs: thread.threadId },
    );
    const scopedExternalId =
      typeof thread.metadata?.documentAliasExternalId === "string"
        ? thread.metadata.documentAliasExternalId
        : null;
    if (scopedExternalId) {
      this.options.db.bindDocumentAlias("slack", scopedExternalId, document.documentId, {
        channelId: thread.channel,
        threadTs: thread.threadId,
      });
    }
    this.options.db.updateThread(thread.threadId, {
      ownerAgent: document.ownerAgent,
      ownerBinding: "explicit",
      metadata: {
        ...(thread.metadata ?? {}),
        documentId: document.documentId,
        documentReferenceExternalId: referenceExternalId,
      },
    });
    this.emitDocumentEvent(
      document.documentId,
      document.ownerAgent,
      `Bound Slack thread ${thread.channel}/${thread.threadId} to this document.`,
      "document.thread_bound",
    );
    return this.getDocument({ anchor: parsed.anchor });
  }

  private emitDocumentEvent(
    documentId: string,
    ownerAgentId: string,
    body: string,
    event: string,
  ): void {
    const threadId = `document:${documentId}`;
    const now = new Date().toISOString();
    const existing = this.options.db.getThread(threadId);
    if (!existing) {
      this.options.db.createThread({
        threadId,
        source: "nvim",
        channel: this.repoSocketHash,
        ownerAgent: ownerAgentId,
        ownerBinding: "explicit",
        metadata: { pinetKind: "document_thread", documentId },
        createdAt: now,
        updatedAt: now,
      });
    } else if (existing.ownerAgent !== ownerAgentId) {
      this.options.db.updateThread(threadId, { ownerAgent: ownerAgentId });
    }
    this.emitInbound(threadId, ownerAgentId, body, {
      pinetKind: "document_message",
      schemaVersion: 1,
      event,
      documentId,
    });
    this.broadcast({ type: "document.updated", payload: { documentId } });
  }

  private serializeThread(
    thread: ThreadInfo,
    metadata: ContextualThreadMetadata,
    messageLimit: number,
  ): ContextJsonObject {
    const messages = this.options.db.getMessagesForThread(thread.threadId, messageLimit);
    return {
      threadId: thread.threadId,
      updatedAt: thread.updatedAt,
      metadata: serializeMetadata(metadata),
      messages: messages.map((message) => ({
        id: message.id,
        sender: message.sender,
        direction: message.direction,
        body: message.body,
        createdAt: message.createdAt,
      })),
    };
  }

  private emitInbound(
    threadId: string,
    targetAgentId: string,
    text: string,
    metadata: Record<string, ContextJsonValue>,
  ): void {
    this.inboundHandler?.({
      source: "nvim",
      threadId,
      channel: this.repoSocketHash,
      userId: "nvim",
      userName: "Neovim",
      text,
      timestamp: new Date().toISOString(),
      metadata: {
        ...metadata,
        ...(targetAgentId ? { threadAffinityOwnerAgentId: targetAgentId } : {}),
      },
    });
  }

  private broadcast(payload: ContextJsonObject): void {
    for (const client of this.clients) sendJson(client, payload);
  }
}

export function createNvimPinetRuntimeAdapterFactory(): (context: {
  broker: { db: NvimAdapterDbPort };
  ctx: { cwd: string };
}) => { adapter: MessageAdapter } | [] {
  return ({ broker, ctx }) => {
    const repositoryContext = resolveNvimRepositoryContext(ctx.cwd);
    if (!repositoryContext) return [];
    return {
      adapter: new NvimPinetAdapter({
        ...repositoryContext,
        db: broker.db,
        getAgentById: (agentId) => broker.db.getAgent?.(agentId) ?? null,
      }),
    };
  };
}
