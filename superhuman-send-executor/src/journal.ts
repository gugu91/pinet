import { DatabaseSync } from "node:sqlite";
import type { ExecutionStatus } from "./contracts.js";

export class Journal {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
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
      UPDATE executions
      SET state='unknown', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), error_code='interrupted_after_claim'
      WHERE state='claimed';
    `);
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
    this.#db
      .prepare(
        "UPDATE executions SET state=?,updated_at=?,provider_message_id=?,error_code=? WHERE receipt_id=? AND state='claimed'",
      )
      .run(state, now, providerMessageId, errorCode, receiptId);
    const result = this.status(receiptId);
    if (!result) throw new Error("missing_claim");
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
