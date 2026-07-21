import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AmpWorkerStateStore } from "./state-store.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "amp-worker-state-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function statePath(): string {
  return path.join(tempDir, "nested", "worker.state.json");
}

describe("AmpWorkerStateStore", () => {
  it("starts empty when the state file does not exist", () => {
    const store = new AmpWorkerStateStore(statePath());
    store.load();
    expect(store.jobCount()).toBe(0);
    expect(store.getAmpThreadId("thread-1")).toBeNull();
  });

  it("persists thread mappings and job phases across restarts", () => {
    const file = statePath();
    const store = new AmpWorkerStateStore(file);
    store.load();
    store.setAmpThreadId("pinet-thread", "T-abc12345");
    store.recordExecuted({
      messageId: 7,
      threadId: "pinet-thread",
      outcome: "ok",
      resultText: "done",
      ampThreadId: "T-abc12345",
    });

    const reloaded = new AmpWorkerStateStore(file);
    reloaded.load();
    expect(reloaded.getAmpThreadId("pinet-thread")).toBe("T-abc12345");
    expect(reloaded.getJob(7)).toMatchObject({
      messageId: 7,
      threadId: "pinet-thread",
      phase: "executed",
      outcome: "ok",
      resultText: "done",
      ampThreadId: "T-abc12345",
    });
  });

  it("advances executed → replied and removes completed jobs", () => {
    const file = statePath();
    const store = new AmpWorkerStateStore(file);
    store.load();
    store.recordExecuted({
      messageId: 3,
      threadId: "t",
      outcome: "ok",
      resultText: "r",
      ampThreadId: null,
    });
    store.recordReplied(3);

    const reloaded = new AmpWorkerStateStore(file);
    reloaded.load();
    expect(reloaded.getJob(3)?.phase).toBe("replied");

    reloaded.completeJob(3);
    const final = new AmpWorkerStateStore(file);
    final.load();
    expect(final.getJob(3)).toBeNull();
    expect(final.jobCount()).toBe(0);
  });

  it("refuses to mark an unknown job replied", () => {
    const store = new AmpWorkerStateStore(statePath());
    store.load();
    expect(() => store.recordReplied(42)).toThrow(/no executed record/);
  });

  it("fails closed on an unsupported state file version", () => {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 99, jobs: {} }));

    const store = new AmpWorkerStateStore(file);
    expect(() => store.load()).toThrow(/Unsupported amp-worker state file/);
  });

  it("fails closed when a version-matched file has missing, null, or array containers", () => {
    const cases = [
      { version: 1, jobs: {} }, // ampThreadsByPinetThread missing
      { version: 1, ampThreadsByPinetThread: {} }, // jobs missing
      { version: 1, ampThreadsByPinetThread: null, jobs: {} },
      { version: 1, ampThreadsByPinetThread: {}, jobs: null },
      { version: 1, ampThreadsByPinetThread: [], jobs: {} },
      { version: 1, ampThreadsByPinetThread: {}, jobs: [] },
    ];
    for (const [index, snapshot] of cases.entries()) {
      const file = path.join(tempDir, `containers-${index}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(snapshot));

      const store = new AmpWorkerStateStore(file);
      expect(() => store.load(), `case ${index}`).toThrow(/Malformed .* container/);
    }
  });

  it("fails closed when the root is an array instead of a snapshot object", () => {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([{ version: 1 }]));

    const store = new AmpWorkerStateStore(file);
    expect(() => store.load()).toThrow(/Unsupported amp-worker state file/);
  });

  it("fails closed on malformed JSON rather than silently resetting", () => {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");

    const store = new AmpWorkerStateStore(file);
    expect(() => store.load()).toThrow();
  });

  it("fails closed on a malformed thread mapping instead of silently dropping it", () => {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        ampThreadsByPinetThread: { good: "T-abc12345", bad: 42 },
        jobs: {},
      }),
    );

    const store = new AmpWorkerStateStore(file);
    expect(() => store.load()).toThrow(/Malformed thread mapping/);
  });

  it("fails closed on a malformed job record instead of risking re-execution", () => {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        ampThreadsByPinetThread: {},
        jobs: {
          "2": { messageId: 2, threadId: "t", phase: "bogus-phase" },
        },
      }),
    );

    const store = new AmpWorkerStateStore(file);
    expect(() => store.load()).toThrow(/Malformed job record/);
  });

  it("fails closed when a job key does not match its record's messageId", () => {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        ampThreadsByPinetThread: {},
        jobs: {
          "9": {
            messageId: 1,
            threadId: "t",
            phase: "executed",
            outcome: "ok",
            resultText: null,
            ampThreadId: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const store = new AmpWorkerStateStore(file);
    expect(() => store.load()).toThrow(/Inconsistent job key/);
  });

  it("writes atomically (no temp file left behind, valid JSON on disk)", () => {
    const file = statePath();
    const store = new AmpWorkerStateStore(file);
    store.load();
    store.setAmpThreadId("a", "T-abc12345");

    const siblings = fs.readdirSync(path.dirname(file));
    expect(siblings).toEqual(["worker.state.json"]);
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { version: number };
    expect(parsed.version).toBe(1);
  });

  it("removes stale temp files from a previous crash on load", () => {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp-99999`, "half-written snapshot");
    fs.writeFileSync(path.join(path.dirname(file), "unrelated.txt"), "keep me");

    const store = new AmpWorkerStateStore(file);
    store.load();

    const siblings = fs.readdirSync(path.dirname(file)).sort();
    expect(siblings).toEqual(["unrelated.txt"]);
    expect(store.jobCount()).toBe(0);
  });

  it("keeps memory at the last durable snapshot when persistence fails", () => {
    const file = statePath();
    const store = new AmpWorkerStateStore(file);
    store.load();
    store.recordExecuted({
      messageId: 1,
      threadId: "t",
      outcome: "ok",
      resultText: "first",
      ampThreadId: null,
    });

    // Make the state directory unwritable so the temp-file write fails.
    const directory = path.dirname(file);
    fs.chmodSync(directory, 0o500);
    try {
      expect(() => store.setAmpThreadId("t", "T-abc12345")).toThrow();
      expect(() => store.recordReplied(1)).toThrow();
    } finally {
      fs.chmodSync(directory, 0o700);
    }

    // In-memory state must not have advanced past what reached disk.
    expect(store.getAmpThreadId("t")).toBeNull();
    expect(store.getJob(1)?.phase).toBe("executed");
    const onDisk = new AmpWorkerStateStore(file);
    onDisk.load();
    expect(onDisk.getAmpThreadId("t")).toBeNull();
    expect(onDisk.getJob(1)?.phase).toBe("executed");

    // Once the fault clears, the same transition commits cleanly.
    store.recordReplied(1);
    const recovered = new AmpWorkerStateStore(file);
    recovered.load();
    expect(recovered.getJob(1)?.phase).toBe("replied");
  });

  it("keeps the previous durable file intact when a commit fails mid-write", () => {
    const file = statePath();
    const store = new AmpWorkerStateStore(file);
    store.load();
    store.setAmpThreadId("t", "T-abc12345");
    const before = fs.readFileSync(file, "utf-8");

    const directory = path.dirname(file);
    fs.chmodSync(directory, 0o500);
    try {
      expect(() => store.setAmpThreadId("t2", "T-def67890")).toThrow();
    } finally {
      fs.chmodSync(directory, 0o700);
    }

    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });
});
