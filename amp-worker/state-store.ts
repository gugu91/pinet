/**
 * Durable worker state: Pinet-thread → Amp-thread continuity plus per-message
 * processing phases so a restart never re-runs Amp for an already executed
 * assignment and never drops a reply.
 *
 * Phase machine per broker message ID:
 *
 *   (none) ──execute──▶ executed ──reply──▶ replied ──ack──▶ (removed)
 *
 * Every transition is committed copy-on-write: the next snapshot is written
 * to disk (temp file + fsync + rename + directory fsync) before the in-memory
 * maps are replaced, so a persistence failure never leaves memory ahead of
 * disk. The broker only stops redelivering after `inbox.ack`. Recovery rules
 * on redelivery:
 * - phase "executed": skip Amp, send the stored reply, ack.
 * - phase "replied": skip Amp and reply, ack only.
 * - no record: run Amp (at-least-once execution is the documented floor —
 *   Amp offers no idempotency handle for a crashed, unrecorded run).
 *
 * Loading is strict and fail-closed: any malformed mapping or job record in a
 * version-matched file aborts startup rather than risking a duplicate Amp
 * execution from a silently dropped record.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type AmpJobPhase = "executed" | "replied";

export type AmpJobOutcome = "ok" | "error" | "interrupted";

export interface AmpJobRecord {
  messageId: number;
  threadId: string;
  phase: AmpJobPhase;
  outcome: AmpJobOutcome;
  resultText: string | null;
  ampThreadId: string | null;
  updatedAt: string;
}

/** Boundary DTO for the JSON state file; strictly validated on load. */
interface AmpWorkerStateFileDto {
  version?: number;
  ampThreadsByPinetThread?: Record<string, string>;
  jobs?: Record<string, AmpJobRecord>;
}

const STATE_VERSION = 1;

function isNullableString(value: string | null | undefined): value is string | null {
  return value === null || typeof value === "string";
}

// agent-standards-ignore prefer-inline-single-use-helper: boundary parser for the durable state file; keeps strict fail-closed validation separate from store bookkeeping
function parseJobRecord(candidate: AmpJobRecord, context: string): AmpJobRecord {
  const valid =
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.messageId === "number" &&
    Number.isInteger(candidate.messageId) &&
    typeof candidate.threadId === "string" &&
    (candidate.phase === "executed" || candidate.phase === "replied") &&
    (candidate.outcome === "ok" ||
      candidate.outcome === "error" ||
      candidate.outcome === "interrupted") &&
    isNullableString(candidate.resultText) &&
    isNullableString(candidate.ampThreadId) &&
    typeof candidate.updatedAt === "string";
  if (!valid) {
    throw new Error(
      `Malformed job record for ${context}. Refusing to start rather than risk duplicate Amp executions; move the file aside to reset.`,
    );
  }
  return {
    messageId: candidate.messageId,
    threadId: candidate.threadId,
    phase: candidate.phase,
    outcome: candidate.outcome,
    resultText: candidate.resultText,
    ampThreadId: candidate.ampThreadId,
    updatedAt: candidate.updatedAt,
  };
}

export class AmpWorkerStateStore {
  private readonly filePath: string;
  private ampThreadsByPinetThread = new Map<string, string>();
  private jobs = new Map<number, AmpJobRecord>();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): void {
    this.removeStaleTempFiles();

    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf-8");
    } catch (err) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? (err as { code?: string }).code
          : null;
      if (code === "ENOENT") {
        return;
      }
      throw err;
    }

    const parsed = JSON.parse(text) as AmpWorkerStateFileDto;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      parsed.version !== STATE_VERSION
    ) {
      throw new Error(
        `Unsupported amp-worker state file at ${this.filePath}. Expected version ${STATE_VERSION}. Refusing to start rather than risk duplicate Amp executions; move the file aside to reset.`,
      );
    }

    // Both containers must be present plain objects. A null/array/missing
    // container would silently start empty and re-execute recorded jobs.
    for (const key of ["ampThreadsByPinetThread", "jobs"] as const) {
      const container = parsed[key];
      if (typeof container !== "object" || container === null || Array.isArray(container)) {
        throw new Error(
          `Malformed "${key}" container in amp-worker state file at ${this.filePath}. Refusing to start rather than risk duplicate Amp executions; move the file aside to reset.`,
        );
      }
    }

    const threads = new Map<string, string>();
    for (const [threadId, ampThreadId] of Object.entries(parsed.ampThreadsByPinetThread ?? {})) {
      if (typeof threadId !== "string" || typeof ampThreadId !== "string") {
        throw new Error(
          `Malformed thread mapping in amp-worker state file at ${this.filePath}. Refusing to start rather than risk forked Amp conversations; move the file aside to reset.`,
        );
      }
      threads.set(threadId, ampThreadId);
    }

    const jobs = new Map<number, AmpJobRecord>();
    for (const [key, candidate] of Object.entries(parsed.jobs ?? {})) {
      const record = parseJobRecord(candidate, `key "${key}" in ${this.filePath}`);
      if (String(record.messageId) !== key || jobs.has(record.messageId)) {
        throw new Error(
          `Inconsistent job key "${key}" in amp-worker state file at ${this.filePath}. Refusing to start rather than risk duplicate Amp executions; move the file aside to reset.`,
        );
      }
      jobs.set(record.messageId, record);
    }

    this.ampThreadsByPinetThread = threads;
    this.jobs = jobs;
  }

  getAmpThreadId(pinetThreadId: string): string | null {
    return this.ampThreadsByPinetThread.get(pinetThreadId) ?? null;
  }

  setAmpThreadId(pinetThreadId: string, ampThreadId: string): void {
    const threads = new Map(this.ampThreadsByPinetThread);
    threads.set(pinetThreadId, ampThreadId);
    this.commit(threads, this.jobs);
  }

  getJob(messageId: number): AmpJobRecord | null {
    return this.jobs.get(messageId) ?? null;
  }

  recordExecuted(input: {
    messageId: number;
    threadId: string;
    outcome: AmpJobOutcome;
    resultText: string | null;
    ampThreadId: string | null;
  }): void {
    const jobs = new Map(this.jobs);
    jobs.set(input.messageId, {
      messageId: input.messageId,
      threadId: input.threadId,
      phase: "executed",
      outcome: input.outcome,
      resultText: input.resultText,
      ampThreadId: input.ampThreadId,
      updatedAt: new Date().toISOString(),
    });
    this.commit(this.ampThreadsByPinetThread, jobs);
  }

  recordReplied(messageId: number): void {
    const job = this.jobs.get(messageId);
    if (!job) {
      throw new Error(`Cannot mark message ${messageId} replied: no executed record.`);
    }
    const jobs = new Map(this.jobs);
    jobs.set(messageId, { ...job, phase: "replied", updatedAt: new Date().toISOString() });
    this.commit(this.ampThreadsByPinetThread, jobs);
  }

  /** Remove a fully acked job; the broker will not redeliver it. */
  completeJob(messageId: number): void {
    if (!this.jobs.has(messageId)) return;
    const jobs = new Map(this.jobs);
    jobs.delete(messageId);
    this.commit(this.ampThreadsByPinetThread, jobs);
  }

  jobCount(): number {
    return this.jobs.size;
  }

  /**
   * A crash between temp-file write and rename leaves `<state>.tmp-<pid>`
   * behind. Stale temps are never read as state (loads target the final path
   * only); remove them at startup so they cannot accumulate or be confused
   * with the durable file by an operator.
   */
  private removeStaleTempFiles(): void {
    const directory = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.tmp-`;
    let siblings: string[];
    try {
      siblings = fs.readdirSync(directory);
    } catch {
      return; // No directory yet — nothing stale to clean.
    }
    for (const name of siblings) {
      if (!name.startsWith(prefix)) continue;
      try {
        fs.unlinkSync(path.join(directory, name));
      } catch {
        /* best-effort cleanup; a leftover temp file is harmless to correctness */
      }
    }
  }

  /**
   * Persist the next snapshot to disk first, then swap the in-memory maps.
   * On persistence failure the in-memory state stays at the last durable
   * snapshot, so callers never act on state that did not reach disk.
   */
  private commit(threads: Map<string, string>, jobs: Map<number, AmpJobRecord>): void {
    const snapshot: Required<AmpWorkerStateFileDto> = {
      version: STATE_VERSION,
      ampThreadsByPinetThread: Object.fromEntries(threads),
      jobs: Object.fromEntries(
        [...jobs.entries()].map(([messageId, record]) => [String(messageId), record]),
      ),
    };

    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    const fd = fs.openSync(tempPath, "w", 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(snapshot, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, this.filePath);
    try {
      const dirFd = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch (err) {
      // Only platforms/filesystems that genuinely do not support fsyncing a
      // directory are tolerated (the rename itself still succeeded; power-loss
      // durability of the rename is then the filesystem's default). Real IO
      // errors must propagate so memory does not advance past a failed commit.
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? (err as { code?: string }).code
          : null;
      if (
        code !== "EINVAL" &&
        code !== "ENOTSUP" &&
        code !== "ENOSYS" &&
        code !== "EISDIR" &&
        code !== "EPERM"
      ) {
        throw err;
      }
    }

    this.ampThreadsByPinetThread = threads;
    this.jobs = jobs;
  }
}
