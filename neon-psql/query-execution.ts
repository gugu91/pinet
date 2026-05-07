import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TruncationResult } from "@earendil-works/pi-coding-agent";

import { isReadOnlyQuery, type SourceValues } from "./helpers.js";

export interface PsqlExecutionState {
  port: number;
  endpoint: string;
  logPath: string;
  source: SourceValues;
}

export type OutputFormat = "table" | "csv" | "tsv";

export interface PsqlDetails {
  query: string;
  format: OutputFormat;
  tunnelPort: number;
  endpoint: string;
  logPath: string;
  configPath: string;
  streaming?: boolean;
  truncation?: TruncationResult;
  fullOutputPath?: string;
  outputPreview?: string;
}

export interface PsqlPartialUpdate {
  content?: { type: "text"; text: string }[];
  details?: PsqlDetails;
}

interface SpawnedPsqlStream {
  on(event: "data", listener: (chunk: Buffer) => void): void;
}

export interface SpawnedPsqlProcess {
  stdout: SpawnedPsqlStream;
  stderr: SpawnedPsqlStream;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface ExecutePsqlQueryOptions {
  psqlBin: string;
  configPath: string;
  query: string;
  format: OutputFormat;
  state: PsqlExecutionState;
  injectedEnv: Record<string, string>;
  signal?: AbortSignal;
  onUpdate?: (update: PsqlPartialUpdate) => void;
  processEnv?: NodeJS.ProcessEnv;
  spawnProcess?: (
    bin: string,
    args: string[],
    options: {
      env: NodeJS.ProcessEnv;
      stdio: ["ignore", "pipe", "pipe"];
    },
  ) => SpawnedPsqlProcess;
  truncateOutput: (
    text: string,
    options: { maxLines: number; maxBytes: number },
  ) => TruncationResult;
  writeFullOutput?: (output: string) => Promise<string>;
  formatBytes: (bytes: number) => string;
  maxOutputLines?: number;
  maxOutputBytes?: number;
}

export async function writePsqlFullOutput(output: string): Promise<string> {
  const path = join(tmpdir(), `pi-psql-${Date.now()}.txt`);
  await writeFile(path, output, "utf8");
  return path;
}

export async function executePsqlQuery(
  options: ExecutePsqlQueryOptions,
): Promise<{ text: string; details: PsqlDetails }> {
  const {
    psqlBin,
    configPath,
    query,
    format,
    state,
    injectedEnv,
    signal,
    onUpdate,
    processEnv = process.env,
    spawnProcess,
    truncateOutput,
    writeFullOutput = writePsqlFullOutput,
    formatBytes,
    maxOutputLines = 2000,
    maxOutputBytes = 50 * 1024,
  } = options;

  const spawnPsqlProcess =
    spawnProcess ??
    (spawn as (
      bin: string,
      args: string[],
      options: {
        env: NodeJS.ProcessEnv;
        stdio: ["ignore", "pipe", "pipe"];
      },
    ) => SpawnedPsqlProcess);

  if (!isReadOnlyQuery(query)) {
    throw new Error(
      "The psql extension only allows read-only queries and psql inspection meta-commands (e.g. SELECT, WITH, SHOW, EXPLAIN, VALUES, TABLE, \\d, \\dt).",
    );
  }

  const connection = injectedEnv.NEON_TUNNEL_DATABASE_URL;
  const args = [connection, "-v", "ON_ERROR_STOP=1", "-P", "pager=off"];
  if (format === "csv") args.push("--csv");
  if (format === "tsv") args.push("-A", "-F", "\t");
  args.push("-c", query);

  const details: PsqlDetails = {
    query,
    format,
    tunnelPort: state.port,
    endpoint: state.endpoint,
    logPath: state.logPath,
    configPath,
    streaming: true,
  };

  let stdout = "";
  let stderr = "";

  const pushPartial = (stage: string) => {
    if (!onUpdate) return;
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    const preview = combined
      ? truncateOutput(combined, { maxLines: 60, maxBytes: 6 * 1024 }).content
      : `${stage}...`;
    onUpdate({
      content: [{ type: "text", text: preview }],
      details: { ...details, outputPreview: preview, streaming: true },
    });
  };

  const child = spawnPsqlProcess(psqlBin, args, {
    env: {
      ...processEnv,
      ...injectedEnv,
      PGPASSWORD: state.source.password,
      PGAPPNAME: "pi-extension-psql",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const abort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    pushPartial("Running query");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    pushPartial("Running query");
  });

  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }

  if (signal?.aborted) throw new Error("psql query aborted");

  const combined = [stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)";
  if (exitCode !== 0) {
    throw new Error(combined);
  }

  const truncation = truncateOutput(combined, {
    maxLines: maxOutputLines,
    maxBytes: maxOutputBytes,
  });

  let text = truncation.content;
  if (truncation.truncated) {
    const fullOutputPath = await writeFullOutput(combined);
    details.truncation = truncation;
    details.fullOutputPath = fullOutputPath;
    text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatBytes(truncation.outputBytes)} of ${formatBytes(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
  }

  details.streaming = false;
  details.outputPreview = text;
  return { text, details };
}
