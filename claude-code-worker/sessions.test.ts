import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_MAX_AGE_MS, SessionStore, pruneSessions } from "./sessions.js";

describe("pruneSessions", () => {
  it("drops entries older than the max age and keeps fresh ones", () => {
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const fresh = new Date(now - 1000).toISOString();
    const stale = new Date(now - SESSION_MAX_AGE_MS - 1000).toISOString();
    const pruned = pruneSessions(
      {
        keep: { sessionId: "a", updatedAt: fresh },
        drop: { sessionId: "b", updatedAt: stale },
        invalid: { sessionId: "c", updatedAt: "not-a-date" },
      },
      now,
    );
    expect(Object.keys(pruned)).toEqual(["keep"]);
  });
});

describe("SessionStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-sessions-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists and reloads thread session mappings", () => {
    const store = new SessionStore(dir);
    expect(store.get("t1")).toBe(null);
    store.set("t1", "session-1");

    const reloaded = new SessionStore(dir);
    expect(reloaded.get("t1")).toBe("session-1");
  });

  it("deletes mappings", () => {
    const store = new SessionStore(dir);
    store.set("t1", "session-1");
    store.delete("t1");
    expect(new SessionStore(dir).get("t1")).toBe(null);
  });
});
