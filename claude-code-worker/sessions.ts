import * as fs from "node:fs";
import * as path from "node:path";

export interface SessionEntry {
  sessionId: string;
  updatedAt: string;
}

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Prune entries older than maxAgeMs (pure). */
export function pruneSessions(
  sessions: Record<string, SessionEntry>,
  now: number,
  maxAgeMs = SESSION_MAX_AGE_MS,
): Record<string, SessionEntry> {
  const pruned: Record<string, SessionEntry> = {};
  for (const [threadId, entry] of Object.entries(sessions)) {
    const updated = Date.parse(entry.updatedAt);
    if (Number.isFinite(updated) && now - updated <= maxAgeMs) {
      pruned[threadId] = entry;
    }
  }
  return pruned;
}

/**
 * Persistent threadId → Claude Code session-id map, so follow-up messages on a
 * thread resume the same Claude session (`claude --resume`).
 */
export class SessionStore {
  private readonly filePath: string;
  private sessions: Record<string, SessionEntry> = {};

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "sessions.json");
    this.load();
  }

  get(threadId: string): string | null {
    return this.sessions[threadId]?.sessionId ?? null;
  }

  set(threadId: string, sessionId: string): void {
    this.sessions[threadId] = { sessionId, updatedAt: new Date().toISOString() };
    this.save();
  }

  delete(threadId: string): void {
    if (!(threadId in this.sessions)) return;
    delete this.sessions[threadId];
    this.save();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Record<
        string,
        SessionEntry
      >;
      this.sessions = pruneSessions(raw, Date.now());
    } catch {
      this.sessions = {};
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.sessions, null, 2), "utf-8");
    fs.renameSync(tmpPath, this.filePath);
  }
}
