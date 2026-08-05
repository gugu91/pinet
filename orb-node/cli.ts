/**
 * `pinet-orb-node` CLI — launch Pinet mesh nodes in Amp orbs.
 *
 * Phase 1 supports one command: `up`, which starts a fresh orb thread whose
 * agent bootstraps a Pinet broker node (see bootstrap-prompt.ts). The command
 * shells out to the locally authenticated Amp CLI; run it from a checkout of
 * this repository so the orb thread is created on the right project.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildBrokerOrbBootstrapPrompt, DEFAULT_BROKER_SERVICE_NAME } from "./bootstrap-prompt.js";

export const AMP_MODES = ["low", "medium", "high", "ultra"] as const;
export type AmpMode = (typeof AMP_MODES)[number];

export interface OrbNodeCliArgs {
  help: boolean;
  command: "up" | null;
  dryRun: boolean;
  mode: AmpMode | null;
  ampCommand: string;
  serviceName: string;
}

export const ORB_NODE_USAGE = `Usage: pinet-orb-node up [options]

Launch a fresh Amp orb whose agent bootstraps a Pinet broker node: the
pinet-orb-node Amp plugin (webhook wake channel + keepAlive lease) plus a
supervised pi broker service. Run from a checkout of the pinet repository so
the orb is created on the right Amp project.

Options:
  --dry-run          Print the bootstrap prompt and the amp invocation, then exit
  --mode <mode>      Amp agent mode for the bootstrap turn (${AMP_MODES.join(", ")})
  --amp-command <c>  Amp CLI executable (default: amp)
  --service <name>   Broker service + tmux session name (default: ${DEFAULT_BROKER_SERVICE_NAME})
  -h, --help         Show this help
`;

export function parseOrbNodeCliArgs(argv: string[]): OrbNodeCliArgs {
  const args: OrbNodeCliArgs = {
    help: false,
    command: null,
    dryRun: false,
    mode: null,
    ampCommand: "amp",
    serviceName: DEFAULT_BROKER_SERVICE_NAME,
  };

  let i = 0;
  const takeValue = (flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`${flag} requires a value`);
    }
    i += 1;
    return value;
  };

  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "up" && args.command === null) {
      args.command = "up";
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--mode") {
      const value = takeValue("--mode");
      if (!AMP_MODES.includes(value as AmpMode)) {
        throw new Error(`--mode must be one of: ${AMP_MODES.join(", ")}`);
      }
      args.mode = value as AmpMode;
    } else if (arg === "--amp-command") {
      args.ampCommand = takeValue("--amp-command");
    } else if (arg === "--service") {
      args.serviceName = takeValue("--service");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

/**
 * Argv for the orb launch. `--no-archive-after-execute` is required: execute
 * mode otherwise archives the thread when the turn ends, which pauses the orb
 * immediately and kills the freshly started broker.
 */
export function buildAmpOrbLaunchArgs(input: { mode: AmpMode | null; prompt: string }): string[] {
  return [
    "--orb-execute",
    "--no-archive-after-execute",
    ...(input.mode !== null ? ["--mode", input.mode] : []),
    "-x",
    input.prompt,
  ];
}

export interface OrbNodeCliDeps {
  write: (text: string) => void;
  writeErr: (text: string) => void;
  launch: (command: string, args: string[]) => Promise<number>;
}

// agent-standards-ignore prefer-inline-single-use-helper: production default for the injected OrbNodeCliDeps.launch seam; inlining it into the default parameter would bury the only real side effect of this module
function launchWithInheritedStdio(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function runOrbNodeCli(
  argv: string[],
  deps: OrbNodeCliDeps = {
    write: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
    launch: launchWithInheritedStdio,
  },
): Promise<number> {
  let args: OrbNodeCliArgs;
  try {
    args = parseOrbNodeCliArgs(argv);
  } catch (err) {
    deps.writeErr(`${err instanceof Error ? err.message : String(err)}\n\n${ORB_NODE_USAGE}`);
    return 2;
  }

  if (args.help || args.command === null) {
    (args.help ? deps.write : deps.writeErr)(ORB_NODE_USAGE);
    return args.help ? 0 : 2;
  }

  const prompt = buildBrokerOrbBootstrapPrompt({ serviceName: args.serviceName });
  const launchArgs = buildAmpOrbLaunchArgs({ mode: args.mode, prompt });

  if (args.dryRun) {
    deps.write(`${args.ampCommand} ${launchArgs.slice(0, -2).join(" ")} -x <prompt>\n\n`);
    deps.write(`${prompt}\n`);
    return 0;
  }

  deps.write(`Launching broker orb via ${args.ampCommand} --orb-execute...\n`);
  try {
    return await deps.launch(args.ampCommand, launchArgs);
  } catch (err) {
    deps.writeErr(
      `Failed to run ${args.ampCommand}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

const entrypoint = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (entrypoint) {
  void (async () => {
    try {
      process.exitCode = await runOrbNodeCli(process.argv.slice(2));
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  })();
}
