import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AuthenticatedSlackApprovalContext,
  SlackApprovalContextAuthenticator,
  SlackBrokerApprovalContext,
} from "./approval-receipts.js";
import { THOMAS_SLACK_USER_ID } from "./approval-receipts.js";

export const SLACK_APPROVAL_CONTEXT_VERSION = "pinet-slack-approval-context/v1" as const;
export const SLACK_APPROVAL_ACTION_ID = "pinet.approval.issue" as const;
export const SLACK_APPROVAL_VIEW_CALLBACK_ID = "pinet.approval.issue" as const;
export const DEFAULT_SLACK_REQUEST_FRESHNESS_MS = 5 * 60 * 1000;

export interface SlackV0RequestApprovalContext extends SlackBrokerApprovalContext {
  /** Exact, undecoded HTTP request bytes received from Slack. */
  readonly rawBody: Uint8Array;
  /** Exact X-Slack-Request-Timestamp header value. */
  readonly slackRequestTimestamp: string;
  /** Exact X-Slack-Signature header value. */
  readonly slackSignature: string;
}

export interface SlackV0ApprovalAuthenticatorConfig {
  readonly databasePath: string;
  /** Slack app signing secret. It is retained only in memory and is never persisted. */
  readonly signingSecret: string;
  readonly requestFreshnessMs?: number;
  readonly now?: () => Date;
}

interface ApprovalContextPayload {
  readonly interactionType: "block_actions" | "view_submission";
  readonly interactionId: string;
  readonly userId: string;
  readonly approvalId: string;
  readonly threadId: string;
  readonly envelopeDigest: string;
}

type ParsedJson =
  | null
  | boolean
  | number
  | string
  | readonly ParsedJson[]
  | { readonly [key: string]: ParsedJson };

function requireNonemptyString(value: ParsedJson | undefined, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`Slack approval context ${field} is invalid`);
  }
  return value;
}

function requireObject(
  value: ParsedJson | undefined,
  field: string,
): { readonly [key: string]: ParsedJson } {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Slack approval ${field} is invalid`);
  }
  return value as { readonly [key: string]: ParsedJson };
}

function parseBindingMetadata(encoded: string): {
  readonly approvalId: string;
  readonly threadId: string;
  readonly envelopeDigest: string;
} {
  let parsed: ParsedJson;
  try {
    parsed = JSON.parse(encoded) as ParsedJson;
  } catch {
    throw new Error("Slack approval binding metadata is not valid JSON");
  }
  const object = requireObject(parsed, "binding metadata");
  const expectedKeys = ["approvalId", "envelopeDigest", "threadId", "type"];
  const actualKeys = Object.keys(object).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Slack approval binding metadata has unknown or missing fields");
  }
  if (object.type !== SLACK_APPROVAL_CONTEXT_VERSION) {
    throw new Error("Slack approval context version is unsupported");
  }
  const result = {
    approvalId: requireNonemptyString(object.approvalId, "approvalId"),
    threadId: requireNonemptyString(object.threadId, "threadId"),
    envelopeDigest: requireNonemptyString(object.envelopeDigest, "envelopeDigest"),
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.approvalId)) {
    throw new Error("Slack approval context approvalId is invalid");
  }
  if (!/^\d{10,}\.\d{6}$/.test(result.threadId)) {
    throw new Error("Slack approval context threadId is invalid");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(result.envelopeDigest)) {
    throw new Error("Slack approval context envelopeDigest is invalid");
  }
  return result;
}

// agent-standards-ignore prefer-inline-single-use-helper: genuine Slack interactive payload parsing is an auditable trust boundary
function parseApprovalContext(rawBody: Uint8Array): ApprovalContextPayload {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    throw new Error("Slack approval request body is not valid UTF-8");
  }

  const form = new URLSearchParams(text);
  if ([...form.keys()].length !== 1 || !form.has("payload")) {
    throw new Error("Slack approval request must be a form containing only payload");
  }
  let parsed: ParsedJson;
  try {
    parsed = JSON.parse(form.get("payload") ?? "") as ParsedJson;
  } catch {
    throw new Error("Slack interactive payload is not valid JSON");
  }
  const payload = requireObject(parsed, "interactive payload");
  const user = requireObject(payload.user, "interactive user");
  const userId = requireNonemptyString(user.id, "user.id");

  if (payload.type === "block_actions") {
    const container = requireObject(payload.container, "block_actions container");
    if (container.type !== "message") {
      throw new Error("Slack approval block_actions container must be a message");
    }
    const messageTs = requireNonemptyString(container.message_ts, "container.message_ts");
    const channelId = requireNonemptyString(container.channel_id, "container.channel_id");
    const message =
      payload.message === undefined ? undefined : requireObject(payload.message, "message");
    const threadTsValue = container.thread_ts ?? message?.thread_ts ?? messageTs;
    const threadTs = requireNonemptyString(threadTsValue, "thread timestamp");
    if (
      !/^\d{10,}\.\d{6}$/.test(messageTs) ||
      !/^\d{10,}\.\d{6}$/.test(threadTs) ||
      !/^[CDG][A-Z0-9]+$/.test(channelId)
    ) {
      throw new Error("Slack approval message container identifiers are invalid");
    }
    if (!Array.isArray(payload.actions) || payload.actions.length !== 1) {
      throw new Error("Slack approval block_actions must contain exactly one action");
    }
    const action = requireObject(payload.actions[0], "block_actions action");
    if (action.type !== "button" || action.action_id !== SLACK_APPROVAL_ACTION_ID) {
      throw new Error("Slack approval action identifier is invalid");
    }
    const actionTs = requireNonemptyString(action.action_ts, "actions[0].action_ts");
    if (!/^\d{10,}\.\d{6}$/.test(actionTs)) {
      throw new Error("Slack approval action timestamp is invalid");
    }
    const metadata = parseBindingMetadata(requireNonemptyString(action.value, "actions[0].value"));
    if (threadTs !== metadata.threadId) {
      throw new Error("Slack approval action thread does not match its message container");
    }
    return {
      interactionType: "block_actions",
      interactionId: `${channelId}:${threadTs}:${messageTs}:${actionTs}:${SLACK_APPROVAL_ACTION_ID}`,
      userId,
      ...metadata,
    };
  }

  if (payload.type === "view_submission") {
    const view = requireObject(payload.view, "view_submission view");
    if (view.type !== "modal" || view.callback_id !== SLACK_APPROVAL_VIEW_CALLBACK_ID) {
      throw new Error("Slack approval view identifier is invalid");
    }
    const viewId = requireNonemptyString(view.id, "view.id");
    const viewHash = requireNonemptyString(view.hash, "view.hash");
    if (!/^V[A-Z0-9]+$/.test(viewId)) {
      throw new Error("Slack approval view ID is invalid");
    }
    const metadata = parseBindingMetadata(
      requireNonemptyString(view.private_metadata, "view.private_metadata"),
    );
    return {
      interactionType: "view_submission",
      interactionId: `${viewId}:${viewHash}:${SLACK_APPROVAL_VIEW_CALLBACK_ID}`,
      userId,
      ...metadata,
    };
  }

  throw new Error("Slack approval interaction type is unsupported");
}

/**
 * Production Slack request authenticator for Thomas-only approval actions.
 * It verifies Slack's v0 signature over the exact request bytes, enforces
 * freshness, narrowly parses bindings, and consumes request/context identities
 * in one durable SQLite transaction.
 */
export class SlackV0ApprovalContextAuthenticator implements SlackApprovalContextAuthenticator {
  private readonly db: DatabaseSync;
  private readonly signingSecret: Buffer;
  private readonly requestFreshnessMs: number;
  private readonly now: () => Date;

  constructor(config: SlackV0ApprovalAuthenticatorConfig) {
    if (!config.signingSecret) throw new Error("Slack signing secret is required");
    if (
      config.requestFreshnessMs !== undefined &&
      (!Number.isInteger(config.requestFreshnessMs) || config.requestFreshnessMs <= 0)
    ) {
      throw new Error("Slack request freshness must be a positive integer");
    }
    this.signingSecret = Buffer.from(config.signingSecret, "utf8");
    this.requestFreshnessMs = Math.min(
      config.requestFreshnessMs ?? DEFAULT_SLACK_REQUEST_FRESHNESS_MS,
      DEFAULT_SLACK_REQUEST_FRESHNESS_MS,
    );
    this.now = config.now ?? (() => new Date());
    this.db = new DatabaseSync(config.databasePath);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS slack_approval_context_consumptions (
        request_digest TEXT PRIMARY KEY,
        context_digest TEXT NOT NULL UNIQUE,
        consumed_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  authenticateAndConsume(context: SlackBrokerApprovalContext): AuthenticatedSlackApprovalContext {
    if (
      !("rawBody" in context) ||
      !(context.rawBody instanceof Uint8Array) ||
      !("slackRequestTimestamp" in context) ||
      typeof context.slackRequestTimestamp !== "string" ||
      !("slackSignature" in context) ||
      typeof context.slackSignature !== "string"
    ) {
      throw new Error("Slack approval request authentication data is required");
    }
    if (!/^\d+$/.test(context.slackRequestTimestamp)) {
      throw new Error("Slack request timestamp is invalid");
    }
    const timestampMs = Number(context.slackRequestTimestamp) * 1000;
    const now = this.now();
    if (
      !Number.isSafeInteger(timestampMs) ||
      Math.abs(now.getTime() - timestampMs) > this.requestFreshnessMs
    ) {
      throw new Error("Slack request timestamp is stale");
    }
    if (!/^v0=[a-f0-9]{64}$/.test(context.slackSignature)) {
      throw new Error("Slack request signature is invalid");
    }
    const rawBody = Buffer.from(context.rawBody);
    const base = Buffer.concat([
      Buffer.from(`v0:${context.slackRequestTimestamp}:`, "utf8"),
      rawBody,
    ]);
    const expected = createHmac("sha256", this.signingSecret).update(base).digest();
    const supplied = Buffer.from(context.slackSignature.slice(3), "hex");
    if (!timingSafeEqual(expected, supplied)) {
      throw new Error("Slack request signature is invalid");
    }

    const payload = parseApprovalContext(rawBody);
    if (payload.userId !== THOMAS_SLACK_USER_ID) {
      throw new Error("Slack approval context user is not authorized");
    }
    const requestDigest = createHash("sha256").update(base).digest("base64url");
    const contextDigest = createHash("sha256")
      .update(
        JSON.stringify({
          interactionType: payload.interactionType,
          interactionId: payload.interactionId,
          userId: payload.userId,
          approvalId: payload.approvalId,
          threadId: payload.threadId,
          envelopeDigest: payload.envelopeDigest,
        }),
      )
      .digest("base64url");

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO slack_approval_context_consumptions
           (request_digest, context_digest, consumed_at) VALUES (?, ?, ?)`,
        )
        .run(requestDigest, contextDigest, now.toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw new Error("Slack approval request or context has already been consumed", {
        cause: error,
      });
    }

    return Object.freeze({
      principal: THOMAS_SLACK_USER_ID,
      approvalId: payload.approvalId,
      threadId: payload.threadId,
      envelopeDigest: payload.envelopeDigest,
    });
  }

  close(): void {
    this.signingSecret.fill(0);
    this.db.close();
  }
}
