import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { digestApprovalEnvelope, type ApprovalReceipt } from "@pinet/broker-core/approval-receipts";
import type { ExecutionStatus } from "./contracts.js";

export class Journal {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS executions(
        receipt_id TEXT PRIMARY KEY,
        receipt_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('claimed','sent','failed','unknown')),
        updated_at TEXT NOT NULL,
        provider_message_id TEXT,
        error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_transitions(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_id TEXT NOT NULL,
        receipt_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        at TEXT NOT NULL,
        error_code TEXT
      );
      CREATE TRIGGER IF NOT EXISTS execution_audit_insert AFTER INSERT ON executions BEGIN
        INSERT INTO audit_transitions(receipt_id,receipt_hash,state,at,error_code)
        VALUES(NEW.receipt_id,NEW.receipt_hash,NEW.state,NEW.updated_at,NEW.error_code);
      END;
      CREATE TRIGGER IF NOT EXISTS execution_audit_update AFTER UPDATE OF state ON executions BEGIN
        INSERT INTO audit_transitions(receipt_id,receipt_hash,state,at,error_code)
        VALUES(NEW.receipt_id,NEW.receipt_hash,NEW.state,NEW.updated_at,NEW.error_code);
      END;
    `);
  }
  recoverInterruptedClaims(): void {
    this.#db
      .prepare(
        "UPDATE executions SET state='unknown', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), error_code='interrupted_after_claim' WHERE state='claimed'",
      )
      .run();
  }
  consumeAndClaim(
    receipt: ApprovalReceipt,
    receiptHash: string,
    now: string,
  ): { readonly inserted: boolean; readonly status: ExecutionStatus } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.entry(receipt.claims.approvalId);
      if (prior) {
        if (prior.receiptHash !== receiptHash) throw new Error("receipt_id_conflict");
        this.#db.exec("COMMIT");
        return { inserted: false, status: prior.status };
      }
      const signatureDigest = createHash("sha256").update(receipt.signature).digest("base64url");
      const consumed = this.#db
        .prepare(
          `
        UPDATE approval_receipts SET consumed_at = ?
        WHERE approval_id = ? AND principal = ? AND send_id = ? AND draft_id = ?
          AND draft_fingerprint = ? AND envelope_digest = ? AND issued_at = ? AND expires_at = ?
          AND key_id = ? AND signature_digest = ? AND record_state = 'issued'
          AND cancelled_at IS NULL AND consumed_at IS NULL AND expires_at > ?
      `,
        )
        .run(
          now,
          receipt.claims.approvalId,
          receipt.claims.principal,
          receipt.claims.envelope.sendId,
          receipt.claims.envelope.draftId,
          receipt.claims.envelope.draftFingerprint,
          digestApprovalEnvelope(receipt.claims.envelope),
          receipt.claims.issuedAt,
          receipt.claims.expiresAt,
          receipt.claims.keyId,
          signatureDigest,
          now,
        );
      if (consumed.changes !== 1) throw new Error("approval_not_active");
      this.#db
        .prepare(
          "INSERT INTO executions(receipt_id,receipt_hash,state,updated_at) VALUES(?,?,'claimed',?)",
        )
        .run(receipt.claims.approvalId, receiptHash, now);
      this.#db.exec("COMMIT");
      return {
        inserted: true,
        status: { receiptId: receipt.claims.approvalId, state: "claimed", updatedAt: now },
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  claim(
    receiptId: string,
    receiptHash: string,
    now: string,
  ): { readonly inserted: boolean; readonly status: ExecutionStatus } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          "INSERT INTO executions(receipt_id,receipt_hash,state,updated_at) VALUES(?,?,'claimed',?)",
        )
        .run(receiptId, receiptHash, now);
      this.#db.exec("COMMIT");
      return { inserted: true, status: { receiptId, state: "claimed", updatedAt: now } };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      const prior = this.entry(receiptId);
      if (prior) {
        if (prior.receiptHash !== receiptHash) throw new Error("receipt_id_conflict");
        return { inserted: false, status: prior.status };
      }
      throw error;
    }
  }
  finish(
    receiptId: string,
    state: "sent" | "failed" | "unknown",
    now: string,
    detail?: string,
  ): ExecutionStatus {
    const providerMessageId = state === "sent" ? (detail ?? null) : null;
    const errorCode = state === "sent" ? null : (detail ?? null);
    const update = this.#db
      .prepare(
        "UPDATE executions SET state=?,updated_at=?,provider_message_id=?,error_code=? WHERE receipt_id=? AND state='claimed'",
      )
      .run(state, now, providerMessageId, errorCode, receiptId);
    const result = this.status(receiptId);
    if (!result) throw new Error("missing_claim");
    if (update.changes !== 1 && result.state !== state)
      throw new Error("invalid_execution_transition");
    return result;
  }
  entry(
    receiptId: string,
  ): { readonly receiptHash: string; readonly status: ExecutionStatus } | undefined {
    const row = this.#db
      .prepare(
        "SELECT receipt_id,receipt_hash,state,updated_at,provider_message_id,error_code FROM executions WHERE receipt_id=?",
      )
      .get(receiptId) as
      | {
          receipt_id: string;
          receipt_hash: string;
          state: ExecutionStatus["state"];
          updated_at: string;
          provider_message_id: string | null;
          error_code: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      receiptHash: row.receipt_hash,
      status: {
        receiptId: row.receipt_id,
        state: row.state,
        updatedAt: row.updated_at,
        ...(row.provider_message_id ? { providerMessageId: row.provider_message_id } : {}),
        ...(row.error_code ? { errorCode: row.error_code } : {}),
      },
    };
  }
  status(receiptId: string): ExecutionStatus | undefined {
    return this.entry(receiptId)?.status;
  }
  auditStates(receiptId: string): readonly string[] {
    const rows = this.#db
      .prepare("SELECT state FROM audit_transitions WHERE receipt_id=? ORDER BY sequence")
      .all(receiptId) as { state: string }[];
    return rows.map((row) => row.state);
  }
}
