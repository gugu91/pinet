import * as fs from "node:fs";
import { BrokerDB } from "./schema.js";
import { loadOrCreateMeshSecret } from "./auth.js";
import { BrokerSocketServer } from "./socket-server.js";
import type { ListenTarget } from "./socket-server.js";
import { assertLoopbackTcpHost } from "./raw-tcp-loopback.js";
import { LeaderLock } from "./leader.js";
import { BrokerLockConflictError, classifyBrokerLockConflict } from "./lock-conflict.js";
import { getDefaultSocketPath } from "./paths.js";
import type { MessageAdapter } from "./types.js";

export { BrokerDB } from "./schema.js";
export { BrokerSocketServer } from "./socket-server.js";
export {
  LeaderLock,
  inspectBrokerLock,
  readBrokerLockOwner,
  getProcessStartTime,
} from "./leader.js";
export type { BrokerLockInspection, BrokerLockOwner, BrokerLockProbes } from "./leader.js";
export {
  BrokerLockConflictError,
  classifyBrokerLockConflict,
  formatBrokerLockConflictMessage,
  probeBrokerSocket,
  replaceBrokerOwner,
  requestBrokerShutdown,
} from "./lock-conflict.js";
export type {
  BrokerLockConflict,
  BrokerLockConflictClassification,
  BrokerShutdownRequestResult,
  BrokerSocketProbeResult,
  ReplaceBrokerOwnerOptions,
  ReplaceBrokerOwnerOutcome,
  ReplaceBrokerOwnerResult,
} from "./lock-conflict.js";
export type { ListenTarget } from "./socket-server.js";
export type { AgentMessageCallback, AgentRegistrationResolver } from "./socket-server.js";
export type {
  AgentInfo,
  ThreadInfo,
  ScheduledWakeupInfo,
  ScheduledWakeupDelivery,
  BrokerMessage,
  InboxEntry,
  InboundMessage,
  OutboundMessage,
  AdapterCapabilityRequest,
  AdapterCapabilityResult,
  MessageAdapter,
  JsonRpcRequest,
  JsonRpcResponse,
  TaskAssignmentInfo,
  TaskAssignmentStatus,
} from "./types.js";

// ─── Broker orchestrator ─────────────────────────────────

export interface BrokerOptions {
  dbPath?: string;
  /** Unix socket path (shorthand for { type: "unix", path }) */
  socketPath?: string;
  /** Full listen target — overrides socketPath when provided */
  listenTarget?: ListenTarget;
  lockPath?: string;
  meshSecret?: string;
  meshSecretPath?: string;
  /**
   * Runs after DB initialization but BEFORE the socket server begins listening
   * (i.e. before any client can connect or register). Use for startup
   * reconciliation — e.g. stranded-wake recovery — that must deterministically
   * complete before an incoming registration can race it. If it throws, the
   * broker is torn down (DB closed, lock released) and the error propagates so a
   * failed reconciliation never leaves a half-open, already-listening broker.
   */
  beforeListen?: (ctx: { db: BrokerDB }) => void | Promise<void>;
}

export interface Broker {
  db: BrokerDB;
  server: BrokerSocketServer;
  lock: LeaderLock;
  adapters: MessageAdapter[];
  addAdapter(adapter: MessageAdapter): void;
  removeAdapters(adapters: readonly MessageAdapter[]): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start the broker: acquire leader lock, initialize SQLite, start the Unix socket server.
 * Only one broker may run at a time — enforced by a PID lock file.
 *
 * Throws if another broker process already holds the lock.
 */
export async function startBroker(options: BrokerOptions = {}): Promise<Broker> {
  // Resolve listen target: explicit target > socketPath > default
  const target: ListenTarget = options.listenTarget ?? {
    type: "unix" as const,
    path: options.socketPath ?? getDefaultSocketPath(),
  };
  if (target.type === "tcp") {
    assertLoopbackTcpHost(target.host, "broker listen target");
  }

  // ── Leader lock: prevent split-brain (issue #119) ────
  // On conflict, classify the lock owner (issue #951) so callers can offer a
  // real recovery path instead of a generic failure.
  const lock = new LeaderLock(options.lockPath);
  if (!lock.tryAcquire()) {
    const conflict = await classifyBrokerLockConflict({
      lockPath: lock.getLockPath(),
      target,
    });
    // The owner may have died between the acquire attempt and classification
    // — retry once when the conflict became reclaimable.
    if (conflict.kind === "reclaimable" && lock.tryAcquire()) {
      // Raced a dying owner; we now hold the lock.
    } else if (conflict.kind === "conflict") {
      throw new BrokerLockConflictError({
        classification: conflict.classification,
        owner: conflict.owner,
        probe: conflict.probe,
      });
    } else {
      throw new Error(
        "Another pinet broker is already running. Only one broker may be active at a time.",
      );
    }
  }

  const db = new BrokerDB(options.dbPath);
  try {
    db.initialize();
  } catch (err) {
    lock.release();
    throw err;
  }

  // Clean up stale socket file (Unix only)
  if (target.type === "unix") {
    try {
      const stat = fs.statSync(target.path);
      if (stat.isSocket()) fs.unlinkSync(target.path);
    } catch {
      /* doesn't exist — fine */
    }
  }

  const meshSecret = options.meshSecret?.trim() || null;
  const meshSecretPath = options.meshSecretPath?.trim() || null;
  const resolvedMeshSecret =
    meshSecret || (meshSecretPath ? loadOrCreateMeshSecret(meshSecretPath) : null);

  let server: BrokerSocketServer;
  try {
    server = new BrokerSocketServer(db, target, {
      ...(resolvedMeshSecret ? { meshSecret: resolvedMeshSecret } : {}),
    });
  } catch (err) {
    db.close();
    lock.release();
    throw err;
  }

  // Run startup reconciliation strictly BEFORE the socket opens, so nothing can
  // connect/register until it completes. A failure here must not leave a
  // half-open broker: tear down before rethrowing (the server has not started).
  if (options.beforeListen) {
    try {
      await options.beforeListen({ db });
    } catch (err) {
      db.close();
      lock.release();
      throw err;
    }
  }

  try {
    await server.start();
  } catch (err) {
    db.close();
    lock.release();
    throw err;
  }

  const adapters: MessageAdapter[] = [];

  const broker: Broker = {
    db,
    server,
    lock,
    adapters,

    addAdapter(adapter: MessageAdapter): void {
      adapters.push(adapter);
      server.setOutboundMessageAdapters(adapters);
    },

    async removeAdapters(removedAdapters: readonly MessageAdapter[]): Promise<void> {
      const removed = new Set(removedAdapters);
      const retained = adapters.filter((adapter) => !removed.has(adapter));
      adapters.length = 0;
      adapters.push(...retained);
      server.setOutboundMessageAdapters(adapters);

      const disconnectErrors: Error[] = [];
      for (const adapter of removedAdapters) {
        try {
          await adapter.disconnect();
        } catch (error) {
          disconnectErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (disconnectErrors.length > 0) {
        throw new AggregateError(disconnectErrors, "Failed to disconnect broker adapters");
      }
    },

    async stop(): Promise<void> {
      try {
        await this.removeAdapters([...adapters]);
      } finally {
        try {
          await server.stop();
        } finally {
          try {
            db.close();
          } finally {
            lock.release();
          }
        }
      }
    },
  };

  return broker;
}
