#!/usr/bin/env node
import { resolveWorkerConfig } from "./config.js";
import type { WorkerConfigOverrides } from "./config.js";
import { ClaudeCodeWorker } from "./worker.js";

function parseArgs(argv: string[]): WorkerConfigOverrides {
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
        console.log(
          [
            "pinet-claude-worker — join the local Pinet mesh as a headless Claude Code worker",
            "",
            "Options:",
            "  --name <name>            explicit agent name (default: broker assigns one)",
            "  --emoji <emoji>          agent emoji (with --name)",
            "  --workdir <path>         working directory for task runs (default: cwd)",
            "  --socket <path>          broker socket (default: ~/.pi/pinet.sock)",
            "  --model <model>          model override for claude CLI",
            "  --stable-id <id>         stable identity across restarts",
            "  --state-dir <path>       state dir (default: ~/.pi/claude-code-worker)",
            "  --claude-bin <path>      claude executable (default: claude)",
            "  --task-timeout-mins <n>  per-task timeout (default: 30)",
            "",
            "Config file: <state-dir>/config.json with the same keys as WorkerConfig.",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return overrides;
}

async function main(): Promise<void> {
  const config = resolveWorkerConfig(parseArgs(process.argv.slice(2)));
  const worker = new ClaudeCodeWorker(config);

  const stop = (signal: string) => {
    void worker.shutdown(`received ${signal}`).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await worker.start();
}

main().catch((err: unknown) => {
  console.error(`[claude-code-worker] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
