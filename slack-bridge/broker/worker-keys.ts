import * as crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Broker-assigned worker identity. Labels are slugs, so the stable ID always parses with kind "worker". */
export interface WorkerIdentity {
  hostId: string;
  workerId: string;
}

/** The identity a live key authenticates as. */
export interface WorkerKeyPrincipal extends WorkerIdentity {
  keyId: string;
}

export interface WorkerKeyRecord extends WorkerKeyPrincipal {
  createdAt: string;
  revokedAt: string | null;
}

type WorkerKeyRow = {
  id: string;
  host_id: string;
  worker_id: string;
  secret_sha256: string;
  created_at: string;
  revoked_at: string | null;
};

const LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;
// 12-byte hex ID, then a 32-byte base64url secret (which may itself contain "_").
const KEY = /^pnw_([0-9a-f]{24})_([A-Za-z0-9_-]{43})$/;

export function workerStableId({ hostId, workerId }: WorkerIdentity): string {
  return `${hostId}:worker:${workerId}`;
}

export function parseWorkerIdentity(hostId: string, workerId: string): WorkerIdentity {
  if (!LABEL.test(hostId) || !LABEL.test(workerId))
    throw new Error("hostId and workerId must be 1-63 characters of a-z, 0-9 and '-'.");
  return { hostId, workerId };
}

const sha256 = (secret: string) => crypto.createHash("sha256").update(secret).digest();

/** One live key per worker identity; issuing again rotates. Only secret hashes are stored. */
export class WorkerKeys {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_keys (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        secret_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS worker_keys_live
        ON worker_keys(host_id, worker_id) WHERE revoked_at IS NULL;
    `);
  }

  /** Revokes the identity's previous key and returns the new key. The key is never retrievable again. */
  issue(identity: WorkerIdentity): { keyId: string; key: string } {
    const keyId = crypto.randomBytes(12).toString("hex");
    const secret = crypto.randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.revokeLive(identity, now);
      this.db
        .prepare("INSERT INTO worker_keys VALUES (?, ?, ?, ?, ?, NULL)")
        .run(keyId, identity.hostId, identity.workerId, sha256(secret).toString("hex"), now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { keyId, key: `pnw_${keyId}_${secret}` };
  }

  verify(key: string): WorkerKeyPrincipal | null {
    const match = KEY.exec(key);
    if (!match) return null;
    const [, keyId, secret] = match;
    const row = this.db
      .prepare("SELECT * FROM worker_keys WHERE id = ? AND revoked_at IS NULL")
      .get(keyId) as WorkerKeyRow | undefined;
    if (!row || !crypto.timingSafeEqual(Buffer.from(row.secret_sha256, "hex"), sha256(secret)))
      return null;
    return { keyId, hostId: row.host_id, workerId: row.worker_id };
  }

  /** Returns whether the identity had a live key. */
  revoke(identity: WorkerIdentity): boolean {
    return this.revokeLive(identity, new Date().toISOString()) > 0;
  }

  hasLiveKeys(): boolean {
    return (
      this.db.prepare("SELECT 1 FROM worker_keys WHERE revoked_at IS NULL LIMIT 1").get() != null
    );
  }

  list(): WorkerKeyRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM worker_keys ORDER BY host_id, worker_id, created_at")
      .all() as WorkerKeyRow[];
    return rows.map((row) => ({
      keyId: row.id,
      hostId: row.host_id,
      workerId: row.worker_id,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    }));
  }

  private revokeLive(identity: WorkerIdentity, now: string): number {
    return Number(
      this.db
        .prepare(
          "UPDATE worker_keys SET revoked_at = ? WHERE host_id = ? AND worker_id = ? AND revoked_at IS NULL",
        )
        .run(now, identity.hostId, identity.workerId).changes,
    );
  }
}
