import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  SlackV0ApprovalContextAuthenticator,
  SlackV0RequestApprovalContext,
} from "./slack-approval-authenticator.js";

export const APPROVAL_RECEIPT_VERSION = "shm-approval-receipt/v1" as const;
export const MAX_APPROVAL_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_SIGNER_TIMEOUT_MS = 15_000;
export const DEFAULT_RESERVATION_LEASE_MS = 30_000;
export const THOMAS_SLACK_USER_ID = "U0AF5S3LQ5C" as const;

export interface ApprovalRecipients {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
}

export interface ApprovalEnvelope {
  readonly accountId: string;
  readonly threadId: string;
  readonly draftId: string;
  readonly draftFingerprint: string;
  readonly attestation: string;
  readonly payload: string;
  readonly recipients: ApprovalRecipients;
  readonly rendererBuild: string;
  readonly screenshotDigests: readonly string[];
  readonly sendId: string;
  readonly delayMs: number;
  readonly scheduledFor: string | null;
  readonly action: string;
  readonly provider: string;
}

export interface ApprovalClaims {
  readonly version: typeof APPROVAL_RECEIPT_VERSION;
  readonly keyId: string;
  readonly approvalId: string;
  readonly principal: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly envelope: ApprovalEnvelope;
}

export interface ApprovalReceipt {
  readonly claims: ApprovalClaims;
  readonly signature: string;
}

/**
 * A narrow capability implemented by the separately authenticated signer.
 * It deliberately has no generic sign(bytes) method and no key fallback.
 */
export interface ApprovalSignerRequest {
  /** Stable across stale-reservation recovery; the signer must deduplicate it. */
  readonly operationId: string;
  /** The signer must stop work and reject when this signal is aborted. */
  readonly signal: AbortSignal;
}

/**
 * The only signer failure that permits the issuer to release a reservation.
 * Signer adapters may throw this only when the identified operation was
 * definitively rejected before any signing work or durable signer result.
 */
export class ApprovalSignerPreSignRejection extends Error {
  readonly operationId: string;

  constructor(operationId: string, message = "Approval signer rejected before signing") {
    super(message);
    this.name = "ApprovalSignerPreSignRejection";
    this.operationId = operationId;
  }
}

export interface ApprovalSigner {
  readonly keyId: string;
  /**
   * The external signer must provide durable idempotency/single-flight by
   * operationId, returning the same signature for an already completed call.
   */
  issueApproval(
    claims: ApprovalClaims,
    request: ApprovalSignerRequest,
  ): Promise<{ readonly signature: string }>;
}

/** Transport data passed through unchanged to the configured authenticator. */
export interface SlackBrokerApprovalContext {
  readonly authenticationHandle?: string;
}

/**
 * Trusted, request-bound authorization produced by the Slack/broker ingress.
 * Every field comes from the authenticated ingress record, never from the caller.
 */
export interface AuthenticatedSlackApprovalContext {
  readonly principal: string;
  readonly approvalId: string;
  readonly threadId: string;
  readonly envelopeDigest: string;
}

/**
 * Trusted adapter capability. Implementations must authenticate provenance and
 * atomically consume the opaque handle before returning its request bindings.
 */
export interface SlackApprovalContextAuthenticator {
  authenticateAndConsume(context: SlackBrokerApprovalContext): AuthenticatedSlackApprovalContext;
}

export interface CreateApprovalInput {
  readonly approvalId: string;
  readonly ttlMs: number;
  readonly envelope: ApprovalEnvelope;
}

export interface ExpectedApproval {
  readonly approvalId: string;
  readonly envelope: ApprovalEnvelope;
}

/** Pinned deployment trust object. Callers never supply a public key per receipt. */
export interface PinnedApprovalSignatureVerifier {
  readonly keyId: string;
  verify(canonicalClaims: string, signature: string): boolean;
}

export interface ApprovalStatus {
  readonly approvalId: string;
  readonly state: "active" | "cancelled" | "expired" | "consumed";
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly cancelledAt: string | null;
  readonly consumedAt: string | null;
  readonly envelopeDigest: string;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

interface ApprovalAuditRow {
  approval_id: string;
  principal: string;
  send_id: string;
  draft_id: string;
  draft_fingerprint: string;
  envelope_digest: string;
  issued_at: string;
  expires_at: string;
  cancelled_at: string | null;
  consumed_at: string | null;
  key_id: string;
  signature_digest: string;
  reservation_token: string;
  lease_token: string;
  lease_expires_at: string;
  record_state: "pending" | "issued";
}

interface ApprovalReservation {
  readonly operationId: string;
  readonly leaseToken: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SlackApprovalIssuerOptions {
  readonly signerTimeoutMs?: number;
  readonly reservationLeaseMs?: number;
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

function requireSha256Digest(value: string, field: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${field} must be a lowercase hexadecimal SHA-256 digest`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${field} has unknown or missing fields`);
  }
}

function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  const keys = Object.keys(value).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalizeJson((value as { readonly [key: string]: JsonValue })[key] as JsonValue)}`,
    )
    .join(",")}}`;
}

// agent-standards-ignore prefer-inline-single-use-helper: explicit canonical wire schema is a cross-process protocol seam
function claimsJson(claims: ApprovalClaims): JsonValue {
  return {
    version: claims.version,
    keyId: claims.keyId,
    approvalId: claims.approvalId,
    principal: claims.principal,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    envelope: envelopeJson(claims.envelope),
  };
}

function envelopeJson(envelope: ApprovalEnvelope): JsonValue {
  return {
    accountId: envelope.accountId,
    threadId: envelope.threadId,
    draftId: envelope.draftId,
    draftFingerprint: envelope.draftFingerprint,
    attestation: envelope.attestation,
    payload: envelope.payload,
    recipients: {
      to: envelope.recipients.to,
      cc: envelope.recipients.cc,
      bcc: envelope.recipients.bcc,
    },
    rendererBuild: envelope.rendererBuild,
    screenshotDigests: envelope.screenshotDigests,
    sendId: envelope.sendId,
    delayMs: envelope.delayMs,
    scheduledFor: envelope.scheduledFor,
    action: envelope.action,
    provider: envelope.provider,
  };
}

function immutableEnvelope(envelope: ApprovalEnvelope): ApprovalEnvelope {
  const recipients = Object.freeze({
    to: Object.freeze([...envelope.recipients.to]),
    cc: Object.freeze([...envelope.recipients.cc]),
    bcc: Object.freeze([...envelope.recipients.bcc]),
  });
  return Object.freeze({
    accountId: envelope.accountId,
    threadId: envelope.threadId,
    draftId: envelope.draftId,
    draftFingerprint: envelope.draftFingerprint,
    attestation: envelope.attestation,
    payload: envelope.payload,
    recipients,
    rendererBuild: envelope.rendererBuild,
    screenshotDigests: Object.freeze([...envelope.screenshotDigests]),
    sendId: envelope.sendId,
    delayMs: envelope.delayMs,
    scheduledFor: envelope.scheduledFor,
    action: envelope.action,
    provider: envelope.provider,
  });
}

// agent-standards-ignore prefer-inline-single-use-helper: deep-copy/freeze is an issuance security boundary
function immutableClaims(claims: ApprovalClaims): ApprovalClaims {
  return Object.freeze({
    version: claims.version,
    keyId: claims.keyId,
    approvalId: claims.approvalId,
    principal: claims.principal,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    envelope: immutableEnvelope(claims.envelope),
  });
}

function assertIsoInstant(value: string, field: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO instant`);
  }
  return milliseconds;
}

function validateEnvelope(envelope: ApprovalEnvelope): void {
  assertExactKeys(
    envelope,
    [
      "accountId",
      "threadId",
      "draftId",
      "draftFingerprint",
      "attestation",
      "payload",
      "recipients",
      "rendererBuild",
      "screenshotDigests",
      "sendId",
      "delayMs",
      "scheduledFor",
      "action",
      "provider",
    ],
    "envelope",
  );
  assertExactKeys(envelope.recipients, ["to", "cc", "bcc"], "recipients");
  requireText(envelope.accountId, "accountId");
  requireText(envelope.threadId, "threadId");
  requireText(envelope.draftId, "draftId");
  requireSha256Digest(envelope.draftFingerprint, "draftFingerprint");
  requireSha256Digest(envelope.attestation, "attestation");
  requireText(envelope.payload, "payload");
  const allRecipients = [
    ...envelope.recipients.to,
    ...envelope.recipients.cc,
    ...envelope.recipients.bcc,
  ];
  if (allRecipients.length === 0 || allRecipients.some((recipient) => !recipient.trim())) {
    throw new Error("To/Cc/Bcc must contain at least one recipient and no empty recipients");
  }
  requireText(envelope.rendererBuild, "rendererBuild");
  if (envelope.screenshotDigests.length === 0) {
    throw new Error("screenshotDigests must contain at least one digest");
  }
  envelope.screenshotDigests.forEach((digest, index) =>
    requireSha256Digest(digest, `screenshotDigests[${index}]`),
  );
  requireText(envelope.sendId, "sendId");
  if (!Number.isInteger(envelope.delayMs) || envelope.delayMs < 0) {
    throw new Error("delayMs must be a non-negative integer");
  }
  if (envelope.scheduledFor !== null) assertIsoInstant(envelope.scheduledFor, "scheduledFor");
  requireText(envelope.action, "action");
  requireText(envelope.provider, "provider");
}

// agent-standards-ignore prefer-inline-single-use-helper: exact receipt parsing is the verifier trust boundary
function assertReceiptShape(receipt: ApprovalReceipt): void {
  assertExactKeys(receipt, ["claims", "signature"], "receipt");
  assertExactKeys(
    receipt.claims,
    ["version", "keyId", "approvalId", "principal", "issuedAt", "expiresAt", "envelope"],
    "claims",
  );
  validateEnvelope(receipt.claims.envelope);
  requireText(receipt.signature, "signature");
}

// agent-standards-ignore prefer-inline-single-use-helper: exhaustive delivery matching is a reviewable semantic boundary
function assertExactExpected(receipt: ApprovalReceipt, expected: ExpectedApproval): void {
  if (receipt.claims.approvalId !== expected.approvalId) {
    throw new Error("Approval approvalId mismatch");
  }
  const fields: ReadonlyArray<keyof Omit<ApprovalEnvelope, "recipients">> = [
    "accountId",
    "threadId",
    "draftId",
    "draftFingerprint",
    "attestation",
    "payload",
    "rendererBuild",
    "screenshotDigests",
    "sendId",
    "delayMs",
    "scheduledFor",
    "action",
    "provider",
  ];
  for (const field of fields) {
    if (
      canonicalizeJson(receipt.claims.envelope[field] as JsonValue) !==
      canonicalizeJson(expected.envelope[field] as JsonValue)
    ) {
      throw new Error(`Approval ${field} mismatch`);
    }
  }
  for (const kind of ["to", "cc", "bcc"] as const) {
    if (
      canonicalizeJson(receipt.claims.envelope.recipients[kind]) !==
      canonicalizeJson(expected.envelope.recipients[kind])
    ) {
      throw new Error(`Approval recipients.${kind} mismatch`);
    }
  }
}

export function serializeApprovalClaims(claims: ApprovalClaims): string {
  return canonicalizeJson(claimsJson(claims));
}

export function digestApprovalEnvelope(envelope: ApprovalEnvelope): string {
  return createHash("sha256")
    .update(canonicalizeJson(envelopeJson(envelope)))
    .digest("base64url");
}

export class ApprovalAuditStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_receipts (
        approval_id TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        send_id TEXT NOT NULL UNIQUE,
        draft_id TEXT NOT NULL UNIQUE,
        draft_fingerprint TEXT NOT NULL UNIQUE,
        envelope_digest TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        cancelled_at TEXT,
        consumed_at TEXT,
        key_id TEXT NOT NULL,
        signature_digest TEXT NOT NULL,
        reservation_token TEXT NOT NULL UNIQUE,
        lease_token TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        record_state TEXT NOT NULL CHECK(record_state IN ('pending', 'issued'))
      ) STRICT;
    `);
    const columns = this.db.prepare("PRAGMA table_info(approval_receipts)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "lease_token")) {
      this.db.exec("ALTER TABLE approval_receipts ADD COLUMN lease_token TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some((column) => column.name === "lease_expires_at")) {
      this.db.exec(
        "ALTER TABLE approval_receipts ADD COLUMN lease_expires_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
      );
    }
  }

  reserveOrRecover(claims: ApprovalClaims, now: Date, leaseMs: number): ApprovalReservation {
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const envelopeDigest = digestApprovalEnvelope(claims.envelope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          `SELECT * FROM approval_receipts WHERE approval_id = ? OR send_id = ? OR draft_id = ?
           OR draft_fingerprint = ? OR envelope_digest = ? LIMIT 1`,
        )
        .get(
          claims.approvalId,
          claims.envelope.sendId,
          claims.envelope.draftId,
          claims.envelope.draftFingerprint,
          envelopeDigest,
        ) as ApprovalAuditRow | undefined;
      if (existing) {
        const sameIdentity =
          existing.approval_id === claims.approvalId &&
          existing.principal === claims.principal &&
          existing.send_id === claims.envelope.sendId &&
          existing.draft_id === claims.envelope.draftId &&
          existing.draft_fingerprint === claims.envelope.draftFingerprint &&
          existing.envelope_digest === envelopeDigest &&
          existing.key_id === claims.keyId &&
          Date.parse(existing.expires_at) - Date.parse(existing.issued_at) ===
            Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt);
        if (
          existing.record_state !== "pending" ||
          !sameIdentity ||
          Date.parse(existing.lease_expires_at) > now.getTime()
        ) {
          throw new Error("Approval identity is already reserved");
        }
        if (Date.parse(existing.expires_at) <= now.getTime()) {
          this.db
            .prepare(
              "DELETE FROM approval_receipts WHERE approval_id = ? AND record_state = 'pending'",
            )
            .run(existing.approval_id);
        } else {
          const result = this.db
            .prepare(
              `UPDATE approval_receipts SET lease_token = ?, lease_expires_at = ?
               WHERE approval_id = ? AND record_state = 'pending' AND lease_expires_at <= ?`,
            )
            .run(
              leaseToken,
              new Date(now.getTime() + leaseMs).toISOString(),
              existing.approval_id,
              now.toISOString(),
            );
          if (result.changes !== 1) throw new Error("Approval reservation recovery race lost");
          this.db.exec("COMMIT");
          return Object.freeze({
            operationId: existing.reservation_token,
            leaseToken,
            issuedAt: existing.issued_at,
            expiresAt: existing.expires_at,
          });
        }
      }
      this.db
        .prepare(
          `INSERT INTO approval_receipts
          (approval_id, principal, send_id, draft_id, draft_fingerprint, envelope_digest,
           issued_at, expires_at, key_id, signature_digest, reservation_token, lease_token,
           lease_expires_at, record_state)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 'pending')`,
        )
        .run(
          claims.approvalId,
          claims.principal,
          claims.envelope.sendId,
          claims.envelope.draftId,
          claims.envelope.draftFingerprint,
          envelopeDigest,
          claims.issuedAt,
          claims.expiresAt,
          claims.keyId,
          operationId,
          leaseToken,
          new Date(now.getTime() + leaseMs).toISOString(),
        );
      this.db.exec("COMMIT");
      return Object.freeze({
        operationId,
        leaseToken,
        issuedAt: claims.issuedAt,
        expiresAt: claims.expiresAt,
      });
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof Error && error.message.startsWith("Approval ")) throw error;
      throw new Error("Approval identity is already reserved", { cause: error });
    }
  }

  finalize(receipt: ApprovalReceipt, reservation: ApprovalReservation): void {
    const signatureDigest = createHash("sha256").update(receipt.signature).digest("base64url");
    const result = this.db
      .prepare(
        `UPDATE approval_receipts SET signature_digest = ?, record_state = 'issued'
         WHERE approval_id = ? AND reservation_token = ? AND lease_token = ?
           AND record_state = 'pending'`,
      )
      .run(
        signatureDigest,
        receipt.claims.approvalId,
        reservation.operationId,
        reservation.leaseToken,
      );
    if (result.changes !== 1) throw new Error("Approval reservation was lost before finalization");
  }

  releasePreSignRejectedReservation(approvalId: string, reservation: ApprovalReservation): void {
    this.db
      .prepare(
        `DELETE FROM approval_receipts WHERE approval_id = ? AND reservation_token = ?
         AND lease_token = ? AND record_state = 'pending'`,
      )
      .run(approvalId, reservation.operationId, reservation.leaseToken);
  }

  status(approvalId: string, now: Date): ApprovalStatus | null {
    const row = this.db
      .prepare(
        `SELECT * FROM approval_receipts
         WHERE approval_id = ? AND record_state = 'issued'`,
      )
      .get(approvalId) as ApprovalAuditRow | undefined;
    if (!row) return null;
    const state = row.cancelled_at
      ? "cancelled"
      : row.consumed_at
        ? "consumed"
        : Date.parse(row.expires_at) <= now.getTime()
          ? "expired"
          : "active";
    return Object.freeze({
      approvalId: row.approval_id,
      state,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      cancelledAt: row.cancelled_at,
      consumedAt: row.consumed_at,
      envelopeDigest: row.envelope_digest,
    });
  }

  cancel(approvalId: string, principal: string, now: Date): ApprovalStatus {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.getIssuedRow(approvalId);
      if (!row) throw new Error("Approval not found");
      if (row.principal !== principal) throw new Error("Approval principal mismatch");
      if (row.consumed_at) throw new Error("Approval has already been consumed");
      if (Date.parse(row.expires_at) <= now.getTime()) throw new Error("Approval has expired");
      if (!row.cancelled_at) {
        this.db
          .prepare("UPDATE approval_receipts SET cancelled_at = ? WHERE approval_id = ?")
          .run(now.toISOString(), approvalId);
      }
      this.db.exec("COMMIT");
      return this.status(approvalId, now) as ApprovalStatus;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  consume(receipt: ApprovalReceipt, now: Date): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.getIssuedRow(receipt.claims.approvalId);
      if (!row) throw new Error("Approval is not an issued reservation");
      const signatureDigest = createHash("sha256").update(receipt.signature).digest("base64url");
      if (
        row.principal !== receipt.claims.principal ||
        row.send_id !== receipt.claims.envelope.sendId ||
        row.draft_id !== receipt.claims.envelope.draftId ||
        row.draft_fingerprint !== receipt.claims.envelope.draftFingerprint ||
        row.envelope_digest !== digestApprovalEnvelope(receipt.claims.envelope) ||
        row.issued_at !== receipt.claims.issuedAt ||
        row.expires_at !== receipt.claims.expiresAt ||
        row.key_id !== receipt.claims.keyId ||
        row.signature_digest !== signatureDigest
      ) {
        throw new Error("Approval does not match its audit reservation");
      }
      if (row.cancelled_at) throw new Error("Approval has been cancelled");
      if (row.consumed_at) throw new Error("Approval has already been consumed");
      if (Date.parse(row.expires_at) <= now.getTime()) throw new Error("Approval has expired");
      const result = this.db
        .prepare(
          `UPDATE approval_receipts SET consumed_at = ?
           WHERE approval_id = ? AND consumed_at IS NULL AND cancelled_at IS NULL`,
        )
        .run(now.toISOString(), receipt.claims.approvalId);
      if (result.changes !== 1) throw new Error("Approval consumption race lost");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private getIssuedRow(approvalId: string): ApprovalAuditRow | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM approval_receipts WHERE approval_id = ? AND record_state = 'issued'",
        )
        .get(approvalId) as ApprovalAuditRow | undefined) ?? null
    );
  }
}

export class SlackApprovalIssuer {
  private readonly signerTimeoutMs: number;
  private readonly reservationLeaseMs: number;

  constructor(
    private readonly contextAuthenticator: SlackV0ApprovalContextAuthenticator,
    private readonly signer: ApprovalSigner,
    private readonly audit: ApprovalAuditStore,
    private readonly now: () => Date = () => new Date(),
    options: SlackApprovalIssuerOptions = {},
  ) {
    requireText(signer.keyId, "signer.keyId");
    this.signerTimeoutMs = options.signerTimeoutMs ?? DEFAULT_SIGNER_TIMEOUT_MS;
    this.reservationLeaseMs = options.reservationLeaseMs ?? DEFAULT_RESERVATION_LEASE_MS;
    if (!Number.isInteger(this.signerTimeoutMs) || this.signerTimeoutMs <= 0) {
      throw new Error("signerTimeoutMs must be a positive integer");
    }
    if (
      !Number.isInteger(this.reservationLeaseMs) ||
      this.reservationLeaseMs <= this.signerTimeoutMs
    ) {
      throw new Error("reservationLeaseMs must be an integer greater than signerTimeoutMs");
    }
  }

  async create(
    context: SlackV0RequestApprovalContext,
    input: CreateApprovalInput,
  ): Promise<ApprovalReceipt> {
    if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_APPROVAL_TTL_MS) {
      throw new Error(`ttlMs must be an integer between 1 and ${MAX_APPROVAL_TTL_MS}`);
    }
    validateEnvelope(input.envelope);
    const approvalId = requireText(input.approvalId, "approvalId");
    const envelope = immutableEnvelope(input.envelope);
    const envelopeDigest = digestApprovalEnvelope(envelope);
    const authenticated = this.authenticateAndConsume(context);
    if (approvalId !== authenticated.approvalId) {
      throw new Error("Approval ID does not match authenticated Slack context");
    }
    if (envelope.threadId !== authenticated.threadId) {
      throw new Error("Approval thread does not match authenticated Slack context");
    }
    if (envelopeDigest !== authenticated.envelopeDigest) {
      throw new Error("Approval envelope does not match authenticated Slack context");
    }
    const issuedAt = this.now();
    const proposedClaims = immutableClaims({
      version: APPROVAL_RECEIPT_VERSION,
      keyId: this.signer.keyId,
      approvalId,
      principal: authenticated.principal,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + input.ttlMs).toISOString(),
      envelope,
    });
    const reservation = this.audit.reserveOrRecover(
      proposedClaims,
      issuedAt,
      this.reservationLeaseMs,
    );
    const claims = immutableClaims({
      ...proposedClaims,
      issuedAt: reservation.issuedAt,
      expiresAt: reservation.expiresAt,
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const signed = await Promise.race([
        this.signer.issueApproval(claims, {
          operationId: reservation.operationId,
          signal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Approval signer timed out"));
          }, this.signerTimeoutMs);
        }),
      ]);
      const receipt = Object.freeze({
        claims,
        signature: requireText(signed.signature, "signature"),
      });
      this.audit.finalize(receipt, reservation);
      return receipt;
    } catch (error) {
      if (
        error instanceof ApprovalSignerPreSignRejection &&
        error.operationId === reservation.operationId
      ) {
        this.audit.releasePreSignRejectedReservation(claims.approvalId, reservation);
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  status(context: SlackV0RequestApprovalContext, approvalIdInput: string): ApprovalStatus | null {
    const approvalId = requireText(approvalIdInput, "approvalId");
    const authenticated = this.authenticateAndConsume(context);
    this.assertAuthenticatedApprovalId(authenticated, approvalId);
    const status = this.audit.status(approvalId, this.now());
    if (status && status.envelopeDigest !== authenticated.envelopeDigest) {
      throw new Error("Approval envelope does not match authenticated Slack context");
    }
    return status;
  }

  cancel(context: SlackV0RequestApprovalContext, approvalIdInput: string): ApprovalStatus {
    const approvalId = requireText(approvalIdInput, "approvalId");
    const authenticated = this.authenticateAndConsume(context);
    this.assertAuthenticatedApprovalId(authenticated, approvalId);
    const status = this.audit.status(approvalId, this.now());
    if (status && status.envelopeDigest !== authenticated.envelopeDigest) {
      throw new Error("Approval envelope does not match authenticated Slack context");
    }
    return this.audit.cancel(approvalId, authenticated.principal, this.now());
  }

  private authenticateAndConsume(
    context: SlackV0RequestApprovalContext,
  ): AuthenticatedSlackApprovalContext {
    const authenticated = this.contextAuthenticator.authenticateAndConsume(context);
    if (authenticated.principal !== THOMAS_SLACK_USER_ID) {
      throw new Error("Authenticated Slack principal is not authorized");
    }
    requireText(authenticated.approvalId, "authenticated Slack approvalId");
    requireText(authenticated.threadId, "authenticated Slack threadId");
    requireText(authenticated.envelopeDigest, "authenticated Slack envelopeDigest");
    return authenticated;
  }

  private assertAuthenticatedApprovalId(
    authenticated: AuthenticatedSlackApprovalContext,
    approvalId: string,
  ): void {
    if (approvalId !== authenticated.approvalId) {
      throw new Error("Approval ID does not match authenticated Slack context");
    }
  }
}

/** Complete semantic verifier and atomic one-time consumer for executor use. */
export class ApprovalReceiptVerifier {
  constructor(
    private readonly expectedPrincipal: string,
    private readonly pinnedVerifier: PinnedApprovalSignatureVerifier,
    private readonly audit: ApprovalAuditStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    requireText(expectedPrincipal, "expectedPrincipal");
    requireText(pinnedVerifier.keyId, "pinnedVerifier.keyId");
  }

  verifyAndConsume(receipt: ApprovalReceipt, expectedInput: ExpectedApproval): void {
    assertReceiptShape(receipt);
    const expected = Object.freeze({
      approvalId: requireText(expectedInput.approvalId, "expected approvalId"),
      envelope: immutableEnvelope(expectedInput.envelope),
    });
    validateEnvelope(expected.envelope);
    if (receipt.claims.version !== APPROVAL_RECEIPT_VERSION) {
      throw new Error("Unsupported approval receipt version");
    }
    if (receipt.claims.keyId !== this.pinnedVerifier.keyId) {
      throw new Error("Approval keyId does not match pinned verifier");
    }
    if (receipt.claims.principal !== this.expectedPrincipal) {
      throw new Error("Approval principal mismatch");
    }
    const issuedAt = assertIsoInstant(receipt.claims.issuedAt, "issuedAt");
    const expiresAt = assertIsoInstant(receipt.claims.expiresAt, "expiresAt");
    const now = this.now();
    if (issuedAt > now.getTime()) throw new Error("Approval was issued in the future");
    if (expiresAt <= now.getTime()) throw new Error("Approval has expired");
    if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_APPROVAL_TTL_MS) {
      throw new Error("Approval lifetime is invalid");
    }
    assertExactExpected(receipt, expected);
    if (!this.pinnedVerifier.verify(serializeApprovalClaims(receipt.claims), receipt.signature)) {
      throw new Error("Approval signature is invalid");
    }
    this.audit.consume(receipt, now);
  }
}
