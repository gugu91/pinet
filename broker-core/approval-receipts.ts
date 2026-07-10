import { createHash, verify as verifySignature } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const APPROVAL_RECEIPT_VERSION = "shm-approval-receipt/v1" as const;
export const MAX_APPROVAL_TTL_MS = 5 * 60 * 1000;

export interface ApprovalEnvelope {
  accountId: string;
  threadId: string;
  draftId: string;
  draftFingerprint: string;
  attestation: string;
  payload: string;
  recipients: readonly string[];
  rendererBuild: string;
  screenshotDigests: readonly string[];
  sendId: string;
  delayMs: number;
  scheduledFor: string | null;
  action: string;
  provider: string;
}

export interface ApprovalClaims {
  version: typeof APPROVAL_RECEIPT_VERSION;
  approvalId: string;
  principal: string;
  issuedAt: string;
  expiresAt: string;
  envelope: ApprovalEnvelope;
}

export interface ApprovalReceipt {
  claims: ApprovalClaims;
  keyId: string;
  signature: string;
}

export interface ApprovalSigner {
  /** Semantic capability implemented outside the broker process. Never expose sign(bytes). */
  issueApproval(claims: ApprovalClaims): Promise<{ keyId: string; signature: string }>;
}

export interface CreateApprovalInput {
  principal: string;
  approvalId: string;
  ttlMs: number;
  envelope: ApprovalEnvelope;
}

export interface ApprovalStatus {
  approvalId: string;
  state: "active" | "cancelled" | "expired";
  issuedAt: string;
  expiresAt: string;
  cancelledAt: string | null;
  envelopeDigest: string;
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeJson(item)}`).join(",")}}`;
}

function canonicalize(value: object): string {
  return canonicalizeJson(JSON.parse(JSON.stringify(value)) as JsonValue);
}

export function serializeApprovalClaims(claims: ApprovalClaims): string {
  return canonicalize(claims);
}

export function digestApprovalEnvelope(envelope: ApprovalEnvelope): string {
  return createHash("sha256").update(canonicalize(envelope)).digest("base64url");
}

export function verifyApprovalReceipt(receipt: ApprovalReceipt, pinnedPublicKey: string): boolean {
  return verifySignature(
    null,
    Buffer.from(serializeApprovalClaims(receipt.claims)),
    pinnedPublicKey,
    Buffer.from(receipt.signature, "base64url"),
  );
}

export class ApprovalAuditStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_receipts (
        approval_id TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        send_id TEXT NOT NULL UNIQUE,
        draft_fingerprint TEXT NOT NULL UNIQUE,
        envelope_digest TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        cancelled_at TEXT,
        key_id TEXT NOT NULL,
        signature_digest TEXT NOT NULL
      ) STRICT;
    `);
  }

  record(receipt: ApprovalReceipt): void {
    const envelopeDigest = digestApprovalEnvelope(receipt.claims.envelope);
    const signatureDigest = createHash("sha256").update(receipt.signature).digest("base64url");
    this.db
      .prepare(
        `INSERT INTO approval_receipts
        (approval_id, principal, send_id, draft_fingerprint, envelope_digest, issued_at, expires_at, key_id, signature_digest)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.claims.approvalId,
        receipt.claims.principal,
        receipt.claims.envelope.sendId,
        receipt.claims.envelope.draftFingerprint,
        envelopeDigest,
        receipt.claims.issuedAt,
        receipt.claims.expiresAt,
        receipt.keyId,
        signatureDigest,
      );
  }

  status(approvalId: string, now: Date): ApprovalStatus | null {
    const row = this.db
      .prepare(
        `SELECT approval_id, envelope_digest, issued_at, expires_at, cancelled_at
        FROM approval_receipts WHERE approval_id = ?`,
      )
      .get(approvalId) as
      | {
          approval_id: string;
          envelope_digest: string;
          issued_at: string;
          expires_at: string;
          cancelled_at: string | null;
        }
      | undefined;
    if (!row) return null;
    const state = row.cancelled_at
      ? "cancelled"
      : Date.parse(row.expires_at) <= now.getTime()
        ? "expired"
        : "active";
    return {
      approvalId: row.approval_id,
      state,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      cancelledAt: row.cancelled_at,
      envelopeDigest: row.envelope_digest,
    };
  }

  cancel(approvalId: string, principal: string, now: Date): ApprovalStatus {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.status(approvalId, now);
      if (!existing) throw new Error("Approval not found");
      const owner = this.db
        .prepare("SELECT principal FROM approval_receipts WHERE approval_id = ?")
        .get(approvalId) as { principal: string };
      if (owner.principal !== principal) throw new Error("Approval principal mismatch");
      if (existing.state === "expired") throw new Error("Approval has expired");
      if (existing.state === "active") {
        this.db
          .prepare(
            "UPDATE approval_receipts SET cancelled_at = ? WHERE approval_id = ? AND cancelled_at IS NULL",
          )
          .run(now.toISOString(), approvalId);
      }
      this.db.exec("COMMIT");
      return this.status(approvalId, now) as ApprovalStatus;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

export class SlackApprovalIssuer {
  constructor(
    private readonly authorizedPrincipal: string,
    private readonly signer: ApprovalSigner,
    private readonly audit: ApprovalAuditStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: CreateApprovalInput): Promise<ApprovalReceipt> {
    this.assertPrincipal(input.principal);
    if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_APPROVAL_TTL_MS) {
      throw new Error(`ttlMs must be an integer between 1 and ${MAX_APPROVAL_TTL_MS}`);
    }
    this.validateEnvelope(input.envelope);
    const issuedAt = this.now();
    const claims: ApprovalClaims = Object.freeze({
      version: APPROVAL_RECEIPT_VERSION,
      approvalId: requireText(input.approvalId, "approvalId"),
      principal: input.principal,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + input.ttlMs).toISOString(),
      envelope: Object.freeze({ ...input.envelope }),
    });
    const signed = await this.signer.issueApproval(claims);
    const receipt = { claims, keyId: signed.keyId, signature: signed.signature };
    this.audit.record(receipt);
    return receipt;
  }

  status(approvalId: string, principal: string): ApprovalStatus | null {
    this.assertPrincipal(principal);
    return this.audit.status(requireText(approvalId, "approvalId"), this.now());
  }

  cancel(approvalId: string, principal: string): ApprovalStatus {
    this.assertPrincipal(principal);
    return this.audit.cancel(requireText(approvalId, "approvalId"), principal, this.now());
  }

  private assertPrincipal(principal: string): void {
    if (principal !== this.authorizedPrincipal)
      throw new Error("Slack principal is not authorized");
  }

  private validateEnvelope(envelope: ApprovalEnvelope): void {
    requireText(envelope.accountId, "accountId");
    requireText(envelope.threadId, "threadId");
    requireText(envelope.draftId, "draftId");
    requireText(envelope.draftFingerprint, "draftFingerprint");
    requireText(envelope.attestation, "attestation");
    requireText(envelope.payload, "payload");
    if (
      envelope.recipients.length === 0 ||
      envelope.recipients.some((recipient) => !recipient.trim())
    ) {
      throw new Error("recipients must contain at least one non-empty recipient");
    }
    requireText(envelope.rendererBuild, "rendererBuild");
    if (envelope.screenshotDigests.some((digest) => !digest.trim()))
      throw new Error("screenshotDigests contains an empty digest");
    requireText(envelope.sendId, "sendId");
    if (!Number.isInteger(envelope.delayMs) || envelope.delayMs < 0)
      throw new Error("delayMs must be a non-negative integer");
    if (envelope.scheduledFor !== null && !Number.isFinite(Date.parse(envelope.scheduledFor)))
      throw new Error("scheduledFor must be an ISO date or null");
    requireText(envelope.action, "action");
    requireText(envelope.provider, "provider");
  }
}
