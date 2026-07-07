import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ICommentStore,
  CommentAddInput,
  CommentListInput,
  CommentListResult,
  CommentListAllInput,
  CommentListAllResult,
  CommentWipeResult,
  CommentRecord,
  CommentActorType,
  CommentContext,
} from "./comments.js";
import {
  normalizeThreadId,
  normalizeActorType,
  normalizeActorId,
  normalizeContext,
  normalizeLimit,
  resolveThreadId,
  createCommentId,
} from "./comments.js";

interface CommentRow {
  id: string;
  thread_id: string;
  actor_type: string;
  actor_id: string;
  created_at: string;
  body: string;
  body_path: string;
  context_file: string | null;
  context_start_line: number | null;
  context_end_line: number | null;
}

interface CountRow {
  cnt: number;
}

interface SqliteJournalModeResult {
  journal_mode?: string | null;
}

type SqliteRow = Record<string, unknown>;

function readSqliteRow(value: unknown, label: string): SqliteRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected SQLite ${label} row to be an object`);
  }
  return value as SqliteRow;
}

function readStringColumn(row: SqliteRow, key: string, label: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite ${label}.${key} to be a string`);
  }
  return value;
}

function readNullableNumberColumn(row: SqliteRow, key: string, label: string): number | null {
  const value = row[key];
  if (value == null) return null;
  if (typeof value !== "number") {
    throw new Error(`Expected SQLite ${label}.${key} to be a number or null`);
  }
  return value;
}

function readCountRow(value: unknown): CountRow {
  const row = readSqliteRow(value, "count");
  const cnt = row.cnt;
  if (typeof cnt !== "number") {
    throw new Error("Expected SQLite count row cnt to be a number");
  }
  return { cnt };
}

// agent-standards-ignore prefer-inline-single-use-helper: semantic row-mapper seam for the SQLite comments table.
function readCommentRow(value: unknown): CommentRow {
  const row = readSqliteRow(value, "comment");
  const contextFile = row.context_file;
  if (contextFile != null && typeof contextFile !== "string") {
    throw new Error("Expected SQLite comment.context_file to be a string or null");
  }

  return {
    id: readStringColumn(row, "id", "comment"),
    thread_id: readStringColumn(row, "thread_id", "comment"),
    actor_type: readStringColumn(row, "actor_type", "comment"),
    actor_id: readStringColumn(row, "actor_id", "comment"),
    created_at: readStringColumn(row, "created_at", "comment"),
    body: readStringColumn(row, "body", "comment"),
    body_path: readStringColumn(row, "body_path", "comment"),
    context_file: contextFile ?? null,
    context_start_line: readNullableNumberColumn(row, "context_start_line", "comment"),
    context_end_line: readNullableNumberColumn(row, "context_end_line", "comment"),
  };
}

function readCommentRows(values: unknown): CommentRow[] {
  if (!Array.isArray(values)) {
    throw new Error("Expected SQLite comment rows to be an array");
  }
  return values.map(readCommentRow);
}

function getSqliteJournalMode(result?: SqliteJournalModeResult): string {
  const mode = result?.journal_mode?.trim().toLowerCase();
  return mode && mode.length > 0 ? mode : "unknown";
}

function rowToCommentRecord(row: CommentRow): CommentRecord {
  const context: CommentContext | undefined =
    row.context_file != null
      ? {
          file: row.context_file,
          ...(row.context_start_line != null ? { startLine: row.context_start_line } : {}),
          ...(row.context_end_line != null ? { endLine: row.context_end_line } : {}),
        }
      : undefined;

  return {
    id: row.id,
    threadId: row.thread_id,
    actorType: row.actor_type as CommentActorType,
    actorId: row.actor_id,
    createdAt: row.created_at,
    context,
    bodyPath: row.body_path,
    body: row.body,
  };
}

export class SqliteCommentStore implements ICommentStore {
  private readonly dbPath: string;
  private readonly legacyDir: string;
  private db: DatabaseSync | null = null;

  constructor(repoRoot: string) {
    this.dbPath = path.join(repoRoot, ".pi", "picomms.db");
    this.legacyDir = path.join(repoRoot, ".pi", "a2a", "comments");
  }

  initialize(): void {
    if (this.db) return;

    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(this.dbPath, { timeout: 5000 });

    const journalMode = this.db.prepare("PRAGMA journal_mode=WAL").get() as
      | SqliteJournalModeResult
      | undefined;
    if (getSqliteJournalMode(journalMode) !== "wal") {
      console.warn(
        `[SqliteCommentStore] SQLite WAL mode not available, using ${getSqliteJournalMode(journalMode)} journal mode fallback`,
      );
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY NOT NULL,
        thread_id TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        body TEXT NOT NULL,
        body_path TEXT NOT NULL,
        context_file TEXT,
        context_start_line INTEGER,
        context_end_line INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_comments_thread_created
        ON comments(thread_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_comments_created
        ON comments(created_at, id);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT
      );
    `);

    this.migrateFromJson();
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async addComment(input: CommentAddInput): Promise<CommentRecord> {
    const db = this.getDb();

    const body = input.body.trim();
    if (!body) {
      throw new Error("Comment body cannot be empty");
    }

    const context = normalizeContext(input.context);
    const threadId = resolveThreadId(input.threadId, context);
    const actorType = normalizeActorType(input.actorType);
    const actorId = normalizeActorId(input.actorId, actorType);
    const createdAt = new Date().toISOString();
    const id = createCommentId();
    const bodyPath = path.posix.join("items", `${id}.md`);

    db.prepare(
      `INSERT INTO comments
         (id, thread_id, actor_type, actor_id, created_at, body, body_path,
          context_file, context_start_line, context_end_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      threadId,
      actorType,
      actorId,
      createdAt,
      body,
      bodyPath,
      context?.file ?? null,
      context?.startLine ?? null,
      context?.endLine ?? null,
    );

    return {
      id,
      threadId,
      actorType,
      actorId,
      createdAt,
      context,
      bodyPath,
      body,
    };
  }

  listComments(input: CommentListInput = {}): CommentListResult {
    const db = this.getDb();
    const threadId = normalizeThreadId(input.threadId);
    const limit = normalizeLimit(input.limit);

    const countRow = readCountRow(
      db.prepare("SELECT COUNT(*) as cnt FROM comments WHERE thread_id = ?").get(threadId),
    );
    const total = countRow.cnt;

    let rows: CommentRow[];
    if (limit != null) {
      rows = readCommentRows(
        db
          .prepare(
            `SELECT * FROM (
            SELECT * FROM comments WHERE thread_id = ?
            ORDER BY created_at DESC, id DESC LIMIT ?
          ) ORDER BY created_at ASC, id ASC`,
          )
          .all(threadId, limit),
      );
    } else {
      rows = readCommentRows(
        db
          .prepare("SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at ASC, id ASC")
          .all(threadId),
      );
    }

    return {
      threadId,
      total,
      comments: rows.map(rowToCommentRecord),
    };
  }

  listAllComments(input: CommentListAllInput = {}): CommentListAllResult {
    const db = this.getDb();
    const limit = normalizeLimit(input.limit);

    const countRow = readCountRow(db.prepare("SELECT COUNT(*) as cnt FROM comments").get());
    const total = countRow.cnt;

    let rows: CommentRow[];
    if (limit != null) {
      rows = readCommentRows(
        db
          .prepare(
            `SELECT * FROM (
            SELECT * FROM comments ORDER BY created_at DESC, id DESC LIMIT ?
          ) ORDER BY created_at ASC, id ASC`,
          )
          .all(limit),
      );
    } else {
      rows = readCommentRows(
        db.prepare("SELECT * FROM comments ORDER BY created_at ASC, id ASC").all(),
      );
    }

    return {
      total,
      comments: rows.map(rowToCommentRecord),
    };
  }

  async wipeAllComments(): Promise<CommentWipeResult> {
    const db = this.getDb();

    const countRow = readCountRow(db.prepare("SELECT COUNT(*) as cnt FROM comments").get());
    const removed = countRow.cnt;

    db.exec("DELETE FROM comments");

    return { removed, remaining: 0 };
  }

  getThreadSummary(threadId?: string): {
    threadId: string;
    total: number;
    latestId: string | null;
  } {
    const db = this.getDb();
    const normalizedThreadId = normalizeThreadId(threadId);

    const countRow = readCountRow(
      db
        .prepare("SELECT COUNT(*) as cnt FROM comments WHERE thread_id = ?")
        .get(normalizedThreadId),
    );
    const total = countRow.cnt;

    const latestRowValue = db
      .prepare(
        "SELECT id FROM comments WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(normalizedThreadId);
    const latestId = latestRowValue
      ? readStringColumn(
          readSqliteRow(latestRowValue, "latest comment id"),
          "id",
          "latest comment id",
        )
      : null;

    return {
      threadId: normalizedThreadId,
      total,
      latestId,
    };
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("Database not initialized");
    }
    return this.db;
  }

  private migrateFromJson(): void {
    const db = this.getDb();

    const migrated = db.prepare("SELECT value FROM meta WHERE key = ?").get("migrated_from_json");
    if (migrated) return;

    const indexPath = path.join(this.legacyDir, "index.json");
    if (!fs.existsSync(indexPath)) {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        "migrated_from_json",
        "1",
      );
      return;
    }

    try {
      const indexText = fs.readFileSync(indexPath, "utf-8");
      const index = JSON.parse(indexText) as {
        comments?: Array<{
          id?: string;
          threadId?: string;
          actorType?: string;
          actorId?: string;
          createdAt?: string;
          bodyPath?: string;
          context?: {
            file?: string;
            startLine?: number;
            endLine?: number;
          };
        }>;
      };

      db.exec("BEGIN");
      try {
        if (index && Array.isArray(index.comments)) {
          const insert = db.prepare(
            `INSERT OR IGNORE INTO comments
               (id, thread_id, actor_type, actor_id, created_at, body, body_path,
                context_file, context_start_line, context_end_line)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );

          for (const meta of index.comments) {
            if (!meta || typeof meta.id !== "string") continue;
            if (!meta.bodyPath) continue;

            const bodyFile = path.resolve(this.legacyDir, meta.bodyPath);
            let body: string;
            try {
              body = fs.readFileSync(bodyFile, "utf-8").replace(/\r\n/g, "\n").replace(/\n$/, "");
            } catch {
              continue;
            }

            insert.run(
              meta.id,
              meta.threadId ?? "global",
              meta.actorType ?? "agent",
              meta.actorId ?? "pi",
              meta.createdAt ?? new Date().toISOString(),
              body,
              meta.bodyPath,
              meta.context?.file ?? null,
              meta.context?.startLine ?? null,
              meta.context?.endLine ?? null,
            );
          }
        }

        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
          "migrated_from_json",
          "1",
        );
        db.exec("COMMIT");
      } catch (txErr) {
        db.exec("ROLLBACK");
        throw txErr;
      }
    } catch (error) {
      console.error("[picomms] JSON\u2192SQLite migration failed:", error);
    }
  }
}
