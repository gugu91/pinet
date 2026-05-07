import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  buildInjectedValues as computeInjectedValues,
  deriveEndpoint,
  needsSsl,
  type SourceValues,
} from "./helpers.js";
import { executePsqlQuery, type OutputFormat, type PsqlDetails } from "./query-execution.js";
import { runPsqlQueryWithTunnel } from "./query-runner.js";
import { resolvePsqlBin } from "./psql-bin.js";
import { loadConfig, type ResolvedConfig } from "./settings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = basename(__dirname) === "dist" ? dirname(__dirname) : __dirname;
const TUNNEL_SCRIPT = join(EXTENSION_ROOT, "neon_socks_tunnel.py");
const PYTHON_SHIM_DIR = join(EXTENSION_ROOT, "python");

const SANDBOX_RUNTIME_ENTRY = join(
  getAgentDir(),
  "extensions",
  "sandbox",
  "node_modules",
  "@anthropic-ai",
  "sandbox-runtime",
  "dist",
  "index.js",
);

interface TunnelState {
  child: ChildProcess;
  port: number;
  endpoint: string;
  logPath: string;
  startedAt: number;
  source: SourceValues;
  requiresSsl: boolean;
}

const PsqlParams = Type.Object({
  query: Type.String({
    description: "SQL query or psql meta-command to run. Read-only inspection only.",
  }),
  format: Type.Optional(
    StringEnum(["table", "csv", "tsv"] as const, {
      description: "Output format. Defaults to table.",
    }),
  ),
});

type SandboxManagerLike = {
  getSocksProxyPort: () => number | undefined;
};

let tunnel: TunnelState | null = null;
let tunnelPromise: Promise<TunnelState> | null = null;
let injectedEnvBackup = new Map<string, string | undefined>();
let warnedBashTunnelUnavailable = false;
let sandboxManagerPromise: Promise<SandboxManagerLike | null> | null = null;

function readRuntimeEnv(envName: string): string | undefined {
  if (injectedEnvBackup.has(envName)) return injectedEnvBackup.get(envName);
  return process.env[envName];
}

function requireSourceEnv(config: ResolvedConfig): SourceValues {
  const read = (envName: string): string => {
    const value = readRuntimeEnv(envName);
    if (!value) throw new Error(`${envName} is required by ${config.path}`);
    return value;
  };

  return {
    host: read(config.sourceEnv.host),
    port: read(config.sourceEnv.port),
    user: read(config.sourceEnv.user),
    password: read(config.sourceEnv.password),
    database: read(config.sourceEnv.database),
  };
}

function buildInjectedValues(config: ResolvedConfig, state: TunnelState): Record<string, string> {
  return computeInjectedValues(config, state, {
    env: process.env,
    pythonShimDir: PYTHON_SHIM_DIR,
    readEnv: readRuntimeEnv,
  });
}

function applyInjectedEnvToProcess(config: ResolvedConfig, state: TunnelState): void {
  for (const [key, value] of Object.entries(buildInjectedValues(config, state))) {
    if (!injectedEnvBackup.has(key)) {
      injectedEnvBackup.set(key, process.env[key]);
    }
    process.env[key] = value;
  }
}

function restoreInjectedEnv(): void {
  for (const [key, value] of injectedEnvBackup.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  injectedEnvBackup = new Map();
}

function clearTunnelState(childPid?: number): void {
  if (childPid !== undefined && tunnel?.child.pid !== childPid) return;
  tunnel = null;
  tunnelPromise = null;
  restoreInjectedEnv();
}

async function appendTunnelLog(logPath: string, chunk: Buffer): Promise<void> {
  await appendFile(logPath, chunk);
}

async function reservePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve a local tunnel port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const net = await import("node:net");
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          lastError = error;
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    `Timed out waiting for Neon tunnel on 127.0.0.1:${port}${lastError ? ` (${String(lastError)})` : ""}`,
  );
}

function tunnelAlive(): boolean {
  return !!tunnel && !tunnel.child.killed && tunnel.child.exitCode == null;
}

async function getSandboxManager(): Promise<SandboxManagerLike | null> {
  if (sandboxManagerPromise) return sandboxManagerPromise;

  sandboxManagerPromise = (async () => {
    try {
      if (!fs.existsSync(SANDBOX_RUNTIME_ENTRY)) return null;
      const module = (await import(pathToFileURL(SANDBOX_RUNTIME_ENTRY).href)) as {
        SandboxManager?: SandboxManagerLike;
      };
      return module.SandboxManager ?? null;
    } catch {
      return null;
    }
  })();

  return sandboxManagerPromise;
}

async function getProxyUrl(): Promise<string | null> {
  const envProxy =
    process.env.ALL_PROXY ??
    process.env.all_proxy ??
    process.env.SOCKS_PROXY ??
    process.env.socks_proxy;
  if (envProxy) return envProxy;

  const sandboxManager = await getSandboxManager();
  const socksPort = sandboxManager?.getSocksProxyPort();
  if (socksPort) return `socks5h://localhost:${socksPort}`;
  return null;
}

async function setTunnelStatus(ctx: ExtensionContext | undefined, text?: string): Promise<void> {
  if (!ctx?.hasUI) return;
  ctx.ui.setStatus("neon-psql", text ? ctx.ui.theme.fg("accent", text) : undefined);
}

async function ensureTunnel(config: ResolvedConfig, ctx?: ExtensionContext): Promise<TunnelState> {
  if (tunnelAlive()) return tunnel as TunnelState;
  if (tunnelPromise) return tunnelPromise;

  tunnelPromise = (async () => {
    const proxyUrl = await getProxyUrl();
    if (!proxyUrl) {
      throw new Error("Sandbox SOCKS proxy is unavailable, so the Neon tunnel cannot start.");
    }

    const source = requireSourceEnv(config);
    await mkdir(join(process.cwd(), ".pi"), { recursive: true });
    const port = await reservePort();
    const endpoint = deriveEndpoint(source.host);
    await writeFile(config.logPath, "", "utf8");
    await setTunnelStatus(ctx, `psql tunnel starting on 127.0.0.1:${port}`);

    const child = spawn("python", [TUNNEL_SCRIPT], {
      env: {
        ...process.env,
        ALL_PROXY: proxyUrl,
        TUNNEL_HOST: "127.0.0.1",
        TUNNEL_PORT: String(port),
        [config.sourceEnv.host]: source.host,
        [config.sourceEnv.port]: source.port,
        [config.sourceEnv.user]: source.user,
        [config.sourceEnv.password]: source.password,
        [config.sourceEnv.database]: source.database,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", async (chunk: Buffer) => {
      await appendTunnelLog(config.logPath, chunk);
    });
    child.stderr.on("data", async (chunk: Buffer) => {
      await appendTunnelLog(config.logPath, chunk);
    });
    child.once("exit", () => {
      if (tunnel?.child.pid === child.pid) tunnel = null;
      tunnelPromise = null;
    });
    child.once("error", () => {
      if (tunnel?.child.pid === child.pid) tunnel = null;
      tunnelPromise = null;
    });

    await waitForPort(port, 10_000);

    tunnel = {
      child,
      port,
      endpoint,
      logPath: config.logPath,
      startedAt: Date.now(),
      source,
      requiresSsl: needsSsl(source.host),
    };

    await setTunnelStatus(ctx, `psql tunnel 127.0.0.1:${port}`);
    return tunnel as TunnelState;
  })();

  try {
    return await tunnelPromise!;
  } finally {
    tunnelPromise = null;
  }
}

async function stopTunnel(ctx?: ExtensionContext): Promise<void> {
  const childPid = tunnel?.child.pid;
  if (tunnelAlive()) {
    tunnel?.child.kill();
  }
  clearTunnelState(childPid);
  await setTunnelStatus(ctx, undefined);
}

async function prepareBashTunnel(config: ResolvedConfig, ctx: ExtensionContext): Promise<void> {
  try {
    const state = await ensureTunnel(config, ctx);
    applyInjectedEnvToProcess(config, state);
    warnedBashTunnelUnavailable = false;
  } catch (error) {
    restoreInjectedEnv();
    await setTunnelStatus(ctx, undefined);
    if (!warnedBashTunnelUnavailable && ctx.hasUI) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`neon-psql: running bash without DB tunnel (${message})`, "warning");
      warnedBashTunnelUnavailable = true;
    }
  }
}

function renderPreview(
  text: string,
  expanded: boolean,
  theme: { fg: (...args: unknown[]) => string },
): string {
  const lines = text.trim() ? text.trim().split("\n") : ["(no output)"];
  const shown = expanded ? lines.slice(0, 80) : lines.slice(0, 8);
  let result = shown.map((line) => theme.fg("muted", line)).join("\n");
  if (!expanded && lines.length > shown.length) {
    result += `\n${theme.fg("dim", `... ${lines.length - shown.length} more lines`)}`;
  }
  return result;
}

async function runPsqlQuery(
  config: ResolvedConfig,
  query: string,
  format: OutputFormat,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: (update: {
    content?: { type: "text"; text: string }[];
    details?: PsqlDetails;
  }) => void,
): Promise<{ text: string; details: PsqlDetails }> {
  return runPsqlQueryWithTunnel(config, query, format, ctx, signal, onUpdate, {
    ensureTunnel,
    buildInjectedValues,
    resolvePsqlBin,
    executePsqlQuery,
    truncateOutput: truncateHead,
    formatBytes: formatSize,
    maxOutputLines: DEFAULT_MAX_LINES,
    maxOutputBytes: DEFAULT_MAX_BYTES,
  });
}

function redactValue(key: string, value: string): string {
  if (key.toLowerCase().includes("password")) return "***";
  return value.replace(/:\/\/([^:@/]+):([^@/]+)@/g, "://$1:***@");
}

function formatInjectedEnv(config: ResolvedConfig, state: TunnelState): string {
  const injected = buildInjectedValues(config, state);
  const lines = [
    `config: ${config.path}`,
    `source: ${state.source.host}:${state.source.port}/${state.source.database}`,
    `tunnel: 127.0.0.1:${state.port}`,
    `endpoint: ${state.endpoint || "(none)"}`,
    `log: ${state.logPath}`,
    "",
    "Injected env:",
  ];
  for (const key of Object.keys(injected).sort()) {
    lines.push(`${key}=${redactValue(key, injected[key])}`);
  }
  return lines.join("\n");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig({ extensionDir: EXTENSION_ROOT });
  if (!config) return;

  if (config.injectIntoBash) {
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "bash") return;
      await prepareBashTunnel(config, ctx);
    });

    pi.on("user_bash", async (_event, ctx) => {
      await prepareBashTunnel(config, ctx);
      return undefined;
    });
  }

  pi.registerTool({
    name: "psql",
    label: "psql",
    description:
      "Run read-only Postgres queries or psql inspection meta-commands against the configured database. Starts the local tunnel automatically and streams query output.",
    promptSnippet:
      "Run read-only Postgres queries through the configured tunnel and stream results.",
    promptGuidelines: [
      "Use this tool for database inspection instead of manual connection setup.",
      "Prefer SELECT / WITH / SHOW / EXPLAIN / VALUES / TABLE queries or psql meta-commands like \\d and \\dt.",
    ],
    parameters: PsqlParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const format = params.format ?? "table";
      const { text, details } = await runPsqlQuery(
        config,
        params.query,
        format,
        ctx,
        signal,
        onUpdate,
      );
      return {
        content: [{ type: "text", text }],
        details,
      };
    },
    renderCall(args, theme) {
      const firstLine = String(args.query).trim().split("\n")[0] ?? "";
      const preview = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
      let text =
        theme.fg("toolTitle", theme.bold("psql ")) + theme.fg("accent", preview || "(empty query)");
      if (args.format && args.format !== "table") text += " " + theme.fg("dim", `(${args.format})`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as PsqlDetails | undefined;
      const preview =
        details?.outputPreview ??
        (result.content[0]?.type === "text" ? result.content[0].text : "");
      if (isPartial) {
        const header = theme.fg(
          "warning",
          `Running via tunnel 127.0.0.1:${details?.tunnelPort ?? "?"}`,
        );
        return new Text(`${header}\n${renderPreview(preview, false, theme)}`, 0, 0);
      }

      let text = theme.fg("success", `✓ psql via 127.0.0.1:${details?.tunnelPort ?? "?"}`);
      if (details?.truncation?.truncated) text += " " + theme.fg("warning", "(truncated)");
      text += `\n${renderPreview(preview, expanded, theme)}`;
      if (expanded && details?.fullOutputPath)
        text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
      if (expanded && details?.logPath)
        text += `\n${theme.fg("dim", `Tunnel log: ${details.logPath}`)}`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("psql", {
    description: "Run a read-only psql query directly: /psql <query>",
    handler: async (args, ctx) => {
      try {
        const query = args.trim();
        if (!query) {
          ctx.ui.notify("Usage: /psql <query>", "warning");
          return;
        }
        const { text, details } = await runPsqlQuery(config, query, "table", ctx);
        pi.sendMessage({
          customType: "psql-command",
          content: text,
          display: true,
          details,
        });
      } catch (error: unknown) {
        ctx.ui.notify(`psql error: ${getErrorMessage(error)}`, "error");
      }
    },
  });

  pi.registerCommand("psql-tunnel", {
    description: "Inspect or manage the tunnel: /psql-tunnel [status|start|stop|log|env]",
    handler: async (args, ctx) => {
      try {
        const action = args.trim() || "status";
        switch (action) {
          case "status": {
            if (!tunnelAlive()) {
              ctx.ui.notify(`Tunnel is not running (config: ${config.path})`, "info");
              return;
            }
            ctx.ui.notify(
              `Tunnel: 127.0.0.1:${tunnel?.port} -> ${tunnel?.source.host}:${tunnel?.source.port} (${config.path})`,
              "info",
            );
            return;
          }
          case "start": {
            const state = await ensureTunnel(config, ctx);
            ctx.ui.notify(`Started tunnel on 127.0.0.1:${state.port}`, "info");
            return;
          }
          case "stop": {
            await stopTunnel(ctx);
            ctx.ui.notify("Stopped tunnel", "info");
            return;
          }
          case "log": {
            try {
              const log = await readFile(config.logPath, "utf8");
              const lines = log.trim().split("\n").slice(-20).join("\n") || "(log empty)";
              pi.sendMessage({
                customType: "psql-tunnel-log",
                content: lines,
                display: true,
                details: { path: config.logPath, timestamp: Date.now() },
              });
              return;
            } catch {
              ctx.ui.notify(`No tunnel log at ${config.logPath}`, "warning");
              return;
            }
          }
          case "env": {
            const state = await ensureTunnel(config, ctx);
            pi.sendMessage({
              customType: "psql-tunnel-env",
              content: formatInjectedEnv(config, state),
              display: true,
              details: { path: config.path },
            });
            return;
          }
          default:
            ctx.ui.notify("Usage: /psql-tunnel [status|start|stop|log|env]", "warning");
            return;
        }
      } catch (error: unknown) {
        ctx.ui.notify(`psql tunnel error: ${getErrorMessage(error)}`, "error");
      }
    },
  });

  pi.registerMessageRenderer("psql-command", (message, { expanded }, theme) => {
    const details = message.details as PsqlDetails | undefined;
    const query = details?.query ?? "(unknown query)";
    let text = theme.fg("accent", "[/psql] ") + theme.fg("toolTitle", query);
    text += `\n${renderPreview(message.content, expanded, theme)}`;
    if (expanded && details?.logPath)
      text += `\n${theme.fg("dim", `Tunnel log: ${details.logPath}`)}`;
    return new Text(text, 0, 0);
  });

  pi.registerMessageRenderer("psql-tunnel-log", (message, _options, theme) => {
    const details = message.details as { path?: string } | undefined;
    let text = theme.fg("accent", "[psql tunnel log]");
    if (details?.path) text += ` ${theme.fg("dim", details.path)}`;
    text += `\n${theme.fg("muted", message.content)}`;
    return new Text(text, 0, 0);
  });

  pi.registerMessageRenderer("psql-tunnel-env", (message, _options, theme) => {
    return new Text(theme.fg("muted", message.content), 0, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (tunnelAlive()) {
      await setTunnelStatus(ctx, `psql tunnel 127.0.0.1:${tunnel?.port}`);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await stopTunnel(ctx);
  });
}
