import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BrokerDB } from "@pinet/broker-core";
import {
  SONAR_USAGE,
  getDefaultSweepOutputPath,
  parseSonarArgs,
  runSonarCli,
  type SonarCliIo,
} from "./sonar-bin.ts";
import { getDefaultBrokerDbPath } from "./snapshot.ts";

function collectIo(): { io: SonarCliIo; out: string[]; err: string[]; opened: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  return {
    io: {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      openPath: (target) => opened.push(target),
    },
    out,
    err,
    opened,
  };
}

describe("parseSonarArgs", () => {
  it("defaults to the broker database and the default sweep path", () => {
    const parsed = parseSonarArgs([]);
    expect(parsed).toEqual({
      options: {
        dbPath: getDefaultBrokerDbPath(),
        outPath: getDefaultSweepOutputPath(),
        json: false,
        open: false,
        help: false,
      },
    });
  });

  it("accepts --db, --out, --json, --open, and --help", () => {
    const parsed = parseSonarArgs([
      "--db",
      "/tmp/x.db",
      "--out",
      "/tmp/x.html",
      "--json",
      "--open",
      "--help",
    ]);
    expect(parsed).toEqual({
      options: {
        dbPath: "/tmp/x.db",
        outPath: "/tmp/x.html",
        json: true,
        open: true,
        help: true,
      },
    });
  });

  it("rejects flags missing their path argument", () => {
    expect(parseSonarArgs(["--db"])).toEqual({ error: "--db requires a path argument" });
    expect(parseSonarArgs(["--out", "--json"])).toEqual({
      error: "--out requires a path argument",
    });
  });

  it("rejects unknown arguments", () => {
    expect(parseSonarArgs(["--frobnicate"])).toEqual({ error: "Unknown argument: --frobnicate" });
  });
});

describe("runSonarCli", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function createEmptyBrokerDb(): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-sonar-cli-test-"));
    const dbPath = path.join(tempDir, "broker.db");
    const broker = new BrokerDB(dbPath);
    broker.initialize();
    broker.close();
    return dbPath;
  }

  it("prints usage for --help", () => {
    const { io, out } = collectIo();
    const code = runSonarCli(
      {
        dbPath: "/nonexistent",
        outPath: "/nonexistent.html",
        json: false,
        open: false,
        help: true,
      },
      io,
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toBe(SONAR_USAGE);
  });

  it("fails cleanly when the broker database is missing", () => {
    const { io, err } = collectIo();
    const code = runSonarCli(
      {
        dbPath: "/definitely/not/a/broker.db",
        outPath: "/tmp/x.html",
        json: false,
        open: false,
        help: false,
      },
      io,
    );
    expect(code).toBe(1);
    expect(err[0]).toContain("broker database not found");
  });

  it("writes the HTML sweep and opens it when asked", () => {
    const dbPath = createEmptyBrokerDb();
    const outPath = path.join(path.dirname(dbPath), "nested", "sweep.html");
    const { io, out, opened } = collectIo();

    const code = runSonarCli({ dbPath, outPath, json: false, open: true, help: false }, io);

    expect(code).toBe(0);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.readFileSync(outPath, "utf8")).toContain("Pinet mesh — sonar sweep");
    expect(out[0]).toContain(outPath);
    expect(opened).toEqual([outPath]);
  });

  it("prints JSON to stdout with --json", () => {
    const dbPath = createEmptyBrokerDb();
    const { io, out, opened } = collectIo();

    const code = runSonarCli(
      { dbPath, outPath: "/tmp/unused.html", json: true, open: false, help: false },
      io,
    );

    expect(code).toBe(0);
    const snapshot = JSON.parse(out.join("\n")) as { totals: { agents: number } };
    expect(snapshot.totals.agents).toBe(0);
    expect(opened).toEqual([]);
  });
});
