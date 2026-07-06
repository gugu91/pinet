#!/usr/bin/env node
import { resolveWorkerConfig } from "./config.js";
import type { WorkerConfigOverrides } from "./config.js";
import { runMcpServer } from "./mcp-server.js";
import { runWaiter, DEFAULT_WAIT_TIMEOUT_MS } from "./waiter.js";
import { ClaudeCodeWorker } from "./worker.js";

const HELP = [
  "pinet-claude-worker — Claude Code on the Pinet mesh",
  "",
  "Usage:",
  "  pinet-claude-worker [options]           run the headless worker daemon",
  "  pinet-claude-worker mcp [options]       run the follower-bridge MCP server (stdio)",
  "  pinet-claude-worker wait --socket <p>   block until the bridge has pending messages",
  "",
  "Worker/mcp options:",
  "  --name <name>            explicit agent name (default: broker assigns one)",
  "  --emoji <emoji>          agent emoji (with --name)",
  "  --workdir <path>         working directory for task runs (default: cwd)",
  "  --socket <path>          broker socket (default: ~/.pi/pinet.sock)",
  "  --model <model>          model override for claude CLI (worker only)",
  "  --stable-id <id>         stable identity across restarts (worker only)",
  "  --state-dir <path>       state dir (default: ~/.pi/claude-code-worker)",
  "  --claude-bin <path>      claude executable (default: claude; worker only)",
  "  --task-timeout-mins <n>  per-task timeout (default: 30; worker only)",
  "",
  "Wait options:",
  "  --socket <path>          the bridge's waiter socket (from pinet_follow)",
  "  --timeout-mins <n>       give up after n minutes (default: 50)",
  "",
  "Config file: <state-dir>/config.json with the same keys as WorkerConfig.",
].join("\n");

function parseWorkerArgs(argv: string[]): WorkerConfigOverrides {
  const overrides: WorkerConfigOverrides = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--name":
        overrides.name = next();
        break;
      case "--emoji":
        overrides.emoji = next();
        break;
      case "--workdir":
        overrides.workdir = next();
        break;
      case "--socket":
        overrides.socketPath = next();
        break;
      case "--model":
        overrides.model = next();
        break;
      case "--stable-id":
        overrides.stableId = next();
        break;
      case "--state-dir":
        overrides.stateDir = next();
        break;
      case "--claude-bin":
        overrides.claudeBin = next();
        break;
      case "--task-timeout-mins":
        overrides.taskTimeoutMs = Number(next()) * 60 * 1000;
        break;
      case "--help":
        console.log(HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return overrides;
}

async function runWaitCommand(argv: string[]): Promise<void> {
  let socketPath: string | null = null;
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--socket":
        socketPath = next();
        break;
      case "--timeout-mins":
        timeoutMs = Number(next()) * 60 * 1000;
        break;
      case "--help":
        console.log(HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!socketPath) throw new Error("wait requires --socket <path> (from pinet_follow)");

  const outcome = await runWaiter({ socketPath, timeoutMs });
  console.log(outcome.text);
  process.exit(outcome.exitCode);
}

async function runWorkerCommand(argv: string[]): Promise<void> {
  const config = resolveWorkerConfig(parseWorkerArgs(argv));
  const worker = new ClaudeCodeWorker(config);

  const stop = (signal: string) => {
    void worker.shutdown(`received ${signal}`).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await worker.start();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "mcp") {
    const config = resolveWorkerConfig(parseWorkerArgs(argv.slice(1)));
    await runMcpServer(config);
    return;
  }
  if (command === "wait") {
    await runWaitCommand(argv.slice(1));
    return;
  }
  await runWorkerCommand(argv);
}

main().catch((err: unknown) => {
  console.error(`[claude-code-worker] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
