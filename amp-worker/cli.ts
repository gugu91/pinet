/**
 * `pinet-amp-worker` CLI entry point.
 *
 * Wires config → BrokerClient (unix socket / loopback TCP / TLS) → AmpRunner →
 * durable state store → AmpWorker, builds first-class registration metadata
 * (harness, capabilities, host/repo/orb identity), and handles process
 * signals for graceful shutdown.
 */

import { spawnSync } from "node:child_process";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { TransportJsonObject } from "@pinet/transport-core";
import { BrokerClient } from "@pinet/pinet-core/broker-client";
import { AmpRunner, type AmpMode } from "./amp-runner.js";
import { buildAmpWorkerCapabilities, AMP_WORKER_ADAPTER } from "./capabilities.js";
import {
  AMP_WORKER_USAGE,
  parseAmpWorkerArgs,
  resolveAmpWorkerConfig,
  type AmpWorkerConfig,
} from "./config.js";
import { captureAmpOrbIdentity, type AmpOrbIdentity } from "./orb-identity.js";
import { AmpWorkerStateStore } from "./state-store.js";
import { AmpWorker } from "./worker.js";

export const AMP_WORKER_VERSION = "0.2.4";

interface GitContext {
  repo: string | null;
  repoRoot: string | null;
  branch: string | null;
}

// agent-standards-ignore prefer-inline-single-use-helper: re-invoked by metadataProvider on every registration/reload so branch identity stays fresh; inlining would bury three git subprocess calls inside metadata assembly
function probeGit(cwd: string): GitContext {
  const run = (args: string[]): string | null => {
    const result = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 5000 });
    if (result.error || result.status !== 0) return null;
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  };
  return {
    repo: run(["config", "--get", "remote.origin.url"]),
    repoRoot: run(["rev-parse", "--show-toplevel"]),
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
  };
}

// agent-standards-ignore prefer-inline-single-use-helper: version probe is a real seam — it shells out to the Amp CLI and tests stub it independently of metadata assembly
function probeAmpVersion(ampCommand: string, cwd: string): string | null {
  const result = spawnSync(ampCommand, ["--version"], { cwd, encoding: "utf-8", timeout: 15000 });
  if (result.error || result.status !== 0) return null;
  const version = result.stdout.trim().split("\n")[0]?.trim();
  return version && version.length > 0 ? version : null;
}

export function buildAmpWorkerRegistrationMetadata(input: {
  config: AmpWorkerConfig;
  mode: AmpMode;
  ampVersion: string | null;
  git: GitContext;
  orbIdentity: AmpOrbIdentity | null;
}): TransportJsonObject {
  const { config, git, orbIdentity } = input;
  const capabilities = buildAmpWorkerCapabilities({
    adapterVersion: AMP_WORKER_VERSION,
    mode: input.mode,
  });

  return {
    role: "worker",
    harness: "amp",
    adapter: AMP_WORKER_ADAPTER,
    adapterVersion: AMP_WORKER_VERSION,
    protocol: "pinet-broker/jsonrpc2",
    runtime: `node/${process.versions.node}`,
    ...(input.ampVersion ? { ampVersion: input.ampVersion } : {}),
    mode: input.mode,
    host: os.hostname(),
    platform: `${os.platform()}/${os.arch()}`,
    transport: config.connect.kind,
    cwd: config.cwd,
    ...(git.repo ? { repo: git.repo } : {}),
    ...(git.repoRoot ? { repoRoot: git.repoRoot } : {}),
    ...(git.branch ? { branch: git.branch } : {}),
    ...(orbIdentity
      ? {
          executor: "orb",
          orb: {
            issuer: orbIdentity.issuer,
            audience: orbIdentity.audience,
            ...(orbIdentity.ampThreadId ? { ampThreadId: orbIdentity.ampThreadId } : {}),
            ...(orbIdentity.workspaceId ? { workspaceId: orbIdentity.workspaceId } : {}),
            ...(orbIdentity.projectId ? { projectId: orbIdentity.projectId } : {}),
          },
        }
      : { executor: "local" }),
    capabilities,
    startedAt: new Date().toISOString(),
    tags: [
      "role:worker",
      "harness:amp",
      `mode:${input.mode}`,
      `executor:${orbIdentity ? "orb" : "local"}`,
      ...(git.repo ? [`repo:${git.repo}`] : []),
      ...(git.branch ? [`branch:${git.branch}`] : []),
    ],
  };
}

export async function runAmpWorkerCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let config: AmpWorkerConfig;
  try {
    const args = parseAmpWorkerArgs(argv);
    if (args.help) {
      process.stdout.write(AMP_WORKER_USAGE);
      return 0;
    }
    config = resolveAmpWorkerConfig(args, { PINET_MESH_SECRET: env.PINET_MESH_SECRET });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const runner = new AmpRunner({
    ampCommand: config.ampCommand,
    cwd: config.cwd,
    mode: config.mode,
  });

  const orbIdentity = config.orbAudience
    ? captureAmpOrbIdentity(config.ampCommand, config.orbAudience, config.cwd)
    : null;
  if (config.orbAudience && !orbIdentity) {
    process.stderr.write(
      "warning: --orb-audience was set but no orb identity token could be minted (not inside an Amp orb?). Continuing as a local worker.\n",
    );
  }

  const ampVersion = probeAmpVersion(config.ampCommand, config.cwd);
  // Re-probe git on every call so a reload control refreshes branch state.
  const metadataProvider = (): TransportJsonObject =>
    buildAmpWorkerRegistrationMetadata({
      config,
      mode: config.mode,
      ampVersion,
      git: probeGit(config.cwd),
      orbIdentity,
    });

  const client = new BrokerClient({
    ...(config.connect.kind === "socket"
      ? { path: config.connect.path }
      : config.connect.kind === "tcp"
        ? { host: config.connect.host, port: config.connect.port }
        : { host: config.connect.host, port: config.connect.port, tls: config.connect.tls }),
    ...(config.meshSecret ? { meshSecret: config.meshSecret } : {}),
    ...(config.meshSecretPath ? { meshSecretPath: config.meshSecretPath } : {}),
  });

  const worker = new AmpWorker({
    client,
    runner,
    store: new AmpWorkerStateStore(config.stateFilePath),
    name: config.name,
    emoji: config.emoji,
    stableId: config.stableId,
    metadataProvider,
    pollIntervalMs: config.pollIntervalMs,
    log: (line) => {
      process.stderr.write(`[pinet-amp-worker] ${line}\n`);
    },
  });

  const onSignal = (): void => {
    process.stderr.write("[pinet-amp-worker] shutdown requested\n");
    worker.requestStop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await worker.start();
    return 0;
  } catch (err) {
    process.stderr.write(
      `[pinet-amp-worker] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

const entrypoint = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (entrypoint) {
  void (async () => {
    try {
      process.exitCode = await runAmpWorkerCli(process.argv.slice(2));
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  })();
}
