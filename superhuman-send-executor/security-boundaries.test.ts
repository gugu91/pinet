import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlAudit } from "./src/audit.js";
import { Journal } from "./src/journal.js";
import { parseExecuteRequest, parseJson, parseSendResult, parseTrustPolicy } from "./src/parse.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("strict external boundaries", () => {
  it("rejects extra request fields and malformed helper success", () => {
    expect(() => parseExecuteRequest(parseJson('{"receipt":{},"url":"x"}'))).toThrow(
      "invalid_request_fields",
    );
    expect(() => parseSendResult(parseJson("{}"))).toThrow("invalid_send_result_fields");
  });
  it("rejects noncanonical or oversized receipt primitives before verification", () => {
    const oversized = JSON.stringify({
      receipt: { claims: { version: "x".repeat(65) }, signature: "x" },
    });
    expect(() => parseExecuteRequest(parseJson(oversized))).toThrow();
  });
  it("requires a bounded caller group and one or two pinned roots", () => {
    expect(() =>
      parseTrustPolicy(
        parseJson(
          JSON.stringify({
            expectedPrincipal: "u",
            brokerCoreVersion: "0.2.4",
            callerGid: 0,
            approvalAuditPath: "/fixed",
            pinnedIssuerKeys: [],
          }),
        ),
      ),
    ).toThrow("invalid_caller_gid");
  });
  it("serializes claims across independent OS processes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "process-race-"));
    dirs.push(dir);
    const path = join(dir, "journal.db");
    new Journal(path);
    const worker = join(process.cwd(), "scripts/journal-race-worker.mjs");
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        execFileAsync(process.execPath, [worker, path, "receipt-1", "hash-1"], {
          encoding: "utf8",
        }),
      ),
    );
    expect(results.filter((result) => result.stdout.trim() === "inserted")).toHaveLength(1);
    expect(results.filter((result) => result.stdout.trim() === "existing")).toHaveLength(7);
  });
  it("recovers a SIGKILL-interrupted process claim as unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signal-race-"));
    dirs.push(dir);
    const path = join(dir, "journal.db");
    new Journal(path);
    const worker = join(process.cwd(), "scripts/journal-race-worker.mjs");
    const child = spawn(process.execPath, [worker, path, "receipt-signal", "hash-signal", "wait"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    const restarted = new Journal(path);
    restarted.recoverInterruptedClaims();
    expect(restarted.status("receipt-signal")?.state).toBe("unknown");
  });
  it("writes a bounded body-free JSONL mirror schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    dirs.push(dir);
    const path = join(dir, "audit.jsonl");
    new JsonlAudit(path).write({
      receiptId: "receipt-1",
      receiptHash: "a".repeat(64),
      state: "sent",
      at: "2026-06-01T00:00:00Z",
    });
    const record: object = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(record).sort()).toEqual(["at", "receiptHash", "receiptId", "state"]);
    expect(readFileSync(path, "utf8")).not.toContain("body");
  });
});
