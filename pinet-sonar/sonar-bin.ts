#!/usr/bin/env node
/**
 * pinet-sonar CLI.
 *
 * One read-only sweep of the Pinet broker database, rendered as a
 * self-contained HTML datasheet (or raw JSON with --json).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getDefaultBrokerDbPath, readMeshSnapshot } from "./snapshot.ts";
import { renderSonarHtml } from "./render.ts";

export interface SonarCliOptions {
  dbPath: string;
  outPath: string;
  json: boolean;
  open: boolean;
  help: boolean;
}

export type SonarCliParseResult = { options: SonarCliOptions } | { error: string };

export function getDefaultSweepOutputPath(): string {
  return path.join(os.homedir(), ".pi", "pinet-sonar.html");
}

export const SONAR_USAGE = `Usage: pinet-sonar [options]

One read-only sweep of the Pinet broker database, rendered as a
self-contained HTML datasheet.

Options:
  --db <path>    Broker database to sweep (default: ~/.pi/pinet-broker.db)
  --out <path>   Where to write the HTML sweep (default: ~/.pi/pinet-sonar.html)
  --json         Print the snapshot as JSON to stdout instead of writing HTML
  --open         Open the HTML sweep after writing it (macOS "open")
  -h, --help     Show this help
`;

export function parseSonarArgs(argv: string[]): SonarCliParseResult {
  const options: SonarCliOptions = {
    dbPath: getDefaultBrokerDbPath(),
    outPath: getDefaultSweepOutputPath(),
    json: false,
    open: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--db":
      case "--out": {
        const value = argv[i + 1];
        if (!value || value.startsWith("--")) {
          return { error: `${arg} requires a path argument` };
        }
        if (arg === "--db") {
          options.dbPath = value;
        } else {
          options.outPath = value;
        }
        i += 1;
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "--open":
        options.open = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        return { error: `Unknown argument: ${arg ?? ""}` };
    }
  }

  return { options };
}

export interface SonarCliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  openPath: (target: string) => void;
}

export function runSonarCli(options: SonarCliOptions, io: SonarCliIo): number {
  if (options.help) {
    io.stdout(SONAR_USAGE);
    return 0;
  }

  if (!fs.existsSync(options.dbPath)) {
    io.stderr(`pinet-sonar: broker database not found at ${options.dbPath}`);
    io.stderr("Is the Pinet broker set up on this machine? Try --db <path>.");
    return 1;
  }

  const snapshot = readMeshSnapshot({ dbPath: options.dbPath });

  if (options.json) {
    io.stdout(JSON.stringify(snapshot, null, 2));
    return 0;
  }

  fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
  fs.writeFileSync(options.outPath, renderSonarHtml(snapshot));
  io.stdout(
    `Swept ${snapshot.totals.agents} agents, ${snapshot.totals.threads} threads, ` +
      `${snapshot.totals.messages} messages, ${snapshot.totals.lanes} lanes → ${options.outPath}`,
  );

  if (options.open) {
    io.openPath(options.outPath);
  }
  return 0;
}

export function openDetached(target: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [target], { detached: true, stdio: "ignore" });
  child.on("error", () => {
    // Opening is best effort; the sweep file path was already printed.
  });
  child.unref();
}

let runAsMain = false;
const mainEntry = process.argv[1];
if (mainEntry) {
  try {
    runAsMain = fs.realpathSync(mainEntry) === fileURLToPath(import.meta.url);
  } catch {
    runAsMain = false;
  }
}

if (runAsMain) {
  const parsed = parseSonarArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`pinet-sonar: ${parsed.error}`);
    console.error(SONAR_USAGE);
    process.exitCode = 2;
  } else {
    process.exitCode = runSonarCli(parsed.options, {
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
      openPath: openDetached,
    });
  }
}
