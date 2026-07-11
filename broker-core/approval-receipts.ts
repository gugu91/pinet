import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const APPROVAL_RECEIPT_VERSION = "shm-approval-receipt/v1" as const;
export const MAX_APPROVAL_TTL_MS = 5 * 60 * 1000;

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
export interface ApprovalSigner {
  readonly keyId: string;
  issueApproval(claims: ApprovalClaims): Promise<{ readonly signature: string }>;
}

/** Opaque transport data passed through from the Slack/broker ingress boundary. */
export interface SlackBrokerApprovalContext {
  readonly authenticationHandle: string;
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
  record_state: "pending" | "issued";
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
        record_state TEXT NOT NULL CHECK(record_state IN ('pending', 'issued'))
      ) STRICT;
    `);
  }

  reserve(claims: ApprovalClaims): string {
    const token = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO approval_receipts
          (approval_id, principal, send_id, draft_id, draft_fingerprint, envelope_digest,
           issued_at, expires_at, key_id, signature_digest, reservation_token, record_state)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 'pending')`,
        )
        .run(
          claims.approvalId,
          claims.principal,
          claims.envelope.sendId,
          claims.envelope.draftId,
          claims.envelope.draftFingerprint,
          digestApprovalEnvelope(claims.envelope),
          claims.issuedAt,
          claims.expiresAt,
          claims.keyId,
          token,
        );
      this.db.exec("COMMIT");
      return token;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw new Error("Approval identity is already reserved", { cause: error });
    }
  }

  finalize(receipt: ApprovalReceipt, reservationToken: string): void {
    const signatureDigest = createHash("sha256").update(receipt.signature).digest("base64url");
    const result = this.db
      .prepare(
        `UPDATE approval_receipts SET signature_digest = ?, record_state = 'issued'
         WHERE approval_id = ? AND reservation_token = ? AND record_state = 'pending'`,
      )
      .run(signatureDigest, receipt.claims.approvalId, reservationToken);
    if (result.changes !== 1) throw new Error("Approval reservation was lost before finalization");
  }

  releaseFailedReservation(approvalId: string, reservationToken: string): void {
    this.db
      .prepare(
        `DELETE FROM approval_receipts
         WHERE approval_id = ? AND reservation_token = ? AND record_state = 'pending'`,
      )
      .run(approvalId, reservationToken);
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
  constructor(
    private readonly authorizedPrincipal: string,
    private readonly contextAuthenticator: SlackApprovalContextAuthenticator,
    private readonly signer: ApprovalSigner,
    private readonly audit: ApprovalAuditStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    requireText(authorizedPrincipal, "authorizedPrincipal");
    requireText(signer.keyId, "signer.keyId");
  }

  async create(
    context: SlackBrokerApprovalContext,
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
    const claims = immutableClaims({
      version: APPROVAL_RECEIPT_VERSION,
      keyId: this.signer.keyId,
      approvalId,
      principal: authenticated.principal,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + input.ttlMs).toISOString(),
      envelope,
    });
    const reservationToken = this.audit.reserve(claims);
    try {
      const signed = await this.signer.issueApproval(claims);
      const receipt = Object.freeze({
        claims,
        signature: requireText(signed.signature, "signature"),
      });
      this.audit.finalize(receipt, reservationToken);
      return receipt;
    } catch (error) {
      this.audit.releaseFailedReservation(claims.approvalId, reservationToken);
      throw error;
    }
  }

  status(context: SlackBrokerApprovalContext, approvalIdInput: string): ApprovalStatus | null {
    const approvalId = requireText(approvalIdInput, "approvalId");
    const authenticated = this.authenticateAndConsume(context);
    this.assertAuthenticatedApprovalId(authenticated, approvalId);
    const status = this.audit.status(approvalId, this.now());
    if (status && status.envelopeDigest !== authenticated.envelopeDigest) {
      throw new Error("Approval envelope does not match authenticated Slack context");
    }
    return status;
  }

  cancel(context: SlackBrokerApprovalContext, approvalIdInput: string): ApprovalStatus {
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
    context: SlackBrokerApprovalContext,
  ): AuthenticatedSlackApprovalContext {
    const authenticated = this.contextAuthenticator.authenticateAndConsume(context);
    if (authenticated.principal !== this.authorizedPrincipal) {
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
