import { DatabaseSync } from "node:sqlite";
import type { ExecutionStatus } from "./contracts.js";

export class Journal {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS executions(receipt_id TEXT PRIMARY KEY, receipt_hash TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('claimed','sent','failed','unknown')), updated_at TEXT NOT NULL, provider_message_id TEXT, error_code TEXT); UPDATE executions SET state='unknown', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), error_code='interrupted_after_claim' WHERE state='claimed';",
    );
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
      const prior = this.status(receiptId);
      if (prior) return { inserted: false, status: prior };
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
  status(receiptId: string): ExecutionStatus | undefined {
    const row = this.#db
      .prepare(
        "SELECT receipt_id,state,updated_at,provider_message_id,error_code FROM executions WHERE receipt_id=?",
      )
      .get(receiptId) as
      | {
          receipt_id: string;
          state: ExecutionStatus["state"];
          updated_at: string;
          provider_message_id: string | null;
          error_code: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      receiptId: row.receipt_id,
      state: row.state,
      updatedAt: row.updated_at,
      ...(row.provider_message_id ? { providerMessageId: row.provider_message_id } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    };
  }
}
