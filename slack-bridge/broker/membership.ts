import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentInfo } from "./types.js";

export interface WorkerCredential {
  credentialId: string;
  credentialSecret: string;
  hostId: string;
  workerId: string;
}

export interface WorkerPrincipal {
  credentialId: string;
  hostId: string;
  workerId: string;
}

interface CredentialRow {
  id: string;
  secret_hash: string;
  host_id: string;
  worker_id: string;
  revoked_at: string | null;
}

export function workerStableId(principal: Pick<WorkerPrincipal, "hostId" | "workerId">): string {
  return `${encodeURIComponent(principal.hostId)}:worker:${encodeURIComponent(principal.workerId)}`;
}

/** Broker-owned metadata binding: credential workers never authorize local process cleanup. */
export function bindWorkerPrincipal(
  principal: WorkerPrincipal,
  metadata: AgentInfo["metadata"] | undefined,
): NonNullable<AgentInfo["metadata"]> {
  const bound = { ...metadata };
  delete bound.pinetBrokerManaged;
  delete bound.brokerManagedBy;
  delete bound.brokerManagedAt;
  return {
    ...bound,
    role: "worker",
    brokerManaged: false,
    host: principal.hostId,
    hostId: principal.hostId,
    workerId: principal.workerId,
    pinetWorkerPrincipal: { ...principal },
    ...(bound.capabilities && typeof bound.capabilities === "object"
      ? { capabilities: { ...bound.capabilities, role: "worker" } }
      : {}),
  };
}

/** Broker-local durable authorization; bearer secrets and session tokens are never stored. */
export class WorkerMembership {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_credentials (
        id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL,
        host_id TEXT NOT NULL, worker_id TEXT NOT NULL,
        created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS worker_connections (
        stable_id TEXT PRIMARY KEY, credential_id TEXT NOT NULL,
        host_id TEXT NOT NULL, worker_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        connection_id TEXT NOT NULL, runtime_kind TEXT, runtime_handle TEXT,
        connected_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL, disconnected_at TEXT
      );
    `);
  }

  issue(hostId: string, workerId: string): WorkerCredential {
    if (!hostId.trim() || !workerId.trim()) throw new Error("hostId and workerId are required");
    const credentialId = randomUUID();
    const credentialSecret = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO worker_credentials VALUES (?, ?, ?, ?, ?, NULL)")
      .run(
        credentialId,
        createHash("sha256").update(credentialSecret).digest("hex"),
        hostId,
        workerId,
        new Date().toISOString(),
      );
    return { credentialId, credentialSecret, hostId, workerId };
  }

  authenticate(credentialId: string, credentialSecret: string): WorkerPrincipal | null {
    const row = this.db
      .prepare("SELECT * FROM worker_credentials WHERE id = ?")
      .get(credentialId) as CredentialRow | undefined;
    if (!row || row.revoked_at) return null;
    const actual = createHash("sha256").update(credentialSecret).digest();
    if (!timingSafeEqual(actual, Buffer.from(row.secret_hash, "hex"))) return null;
    return { credentialId: row.id, hostId: row.host_id, workerId: row.worker_id };
  }

  isActive(credentialId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT id FROM worker_credentials WHERE id = ? AND revoked_at IS NULL")
        .get(credentialId),
    );
  }

  revoke(credentialId: string): void {
    this.db
      .prepare("UPDATE worker_credentials SET revoked_at = ? WHERE id = ?")
      .run(new Date().toISOString(), credentialId);
  }

  revokeHost(hostId: string): void {
    this.db
      .prepare("UPDATE worker_credentials SET revoked_at = ? WHERE host_id = ?")
      .run(new Date().toISOString(), hostId);
  }

  connect(
    principal: WorkerPrincipal,
    agentId: string,
    connectionId: string,
    leaseMs: number,
    runtimeKind: string | null,
    runtimeHandle: string | null,
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO worker_connections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(stable_id) DO UPDATE SET credential_id=excluded.credential_id,
      agent_id=excluded.agent_id, connection_id=excluded.connection_id, runtime_kind=excluded.runtime_kind,
      runtime_handle=excluded.runtime_handle, connected_at=excluded.connected_at,
      lease_expires_at=excluded.lease_expires_at, disconnected_at=NULL`,
      )
      .run(
        workerStableId(principal),
        principal.credentialId,
        principal.hostId,
        principal.workerId,
        agentId,
        connectionId,
        runtimeKind,
        runtimeHandle,
        new Date(now).toISOString(),
        new Date(now + leaseMs).toISOString(),
      );
  }

  renew(connectionId: string, leaseMs: number): void {
    this.db
      .prepare(
        "UPDATE worker_connections SET lease_expires_at = ? WHERE connection_id = ? AND disconnected_at IS NULL",
      )
      .run(new Date(Date.now() + leaseMs).toISOString(), connectionId);
  }

  disconnect(connectionId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE worker_connections SET disconnected_at = ?, lease_expires_at = ? WHERE connection_id = ?",
      )
      .run(now, now, connectionId);
  }
}
