/**
 * CLI/config boundary for the Amp worker.
 *
 * Transport rules (fail closed):
 * - Unix socket (default) or loopback plain TCP for local brokers.
 * - Any remote broker requires TLS with an explicit trust anchor (CA file
 *   and/or pinned server-certificate SHA-256) — enforced again by
 *   BrokerClient.
 * - The mesh secret is read from a file or the PINET_MESH_SECRET environment
 *   variable, never from argv (argv leaks into the process table).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDefaultMeshSecretPath, getPinetConfigDir } from "@pinet/broker-core/paths";
import type { BrokerClientTlsOptions } from "@pinet/broker-core/tls";
import { AMP_MODES, parseAmpMode, type AmpMode } from "./amp-runner.js";

export interface AmpWorkerCliArgs {
  help: boolean;
  socketPath: string | null;
  host: string | null;
  port: number | null;
  tlsCaPath: string | null;
  tlsPin: string | null;
  tlsServername: string | null;
  tlsKeyPath: string | null;
  tlsCertPath: string | null;
  meshSecretPath: string | null;
  name: string | null;
  emoji: string | null;
  stableId: string | null;
  mode: AmpMode;
  ampCommand: string;
  cwd: string | null;
  stateFilePath: string | null;
  pollIntervalMs: number;
  orbAudience: string | null;
}

export type AmpWorkerConnectTarget =
  | { kind: "socket"; path: string }
  | { kind: "tcp"; host: string; port: number }
  | { kind: "tls"; host: string; port: number; tls: BrokerClientTlsOptions };

export interface AmpWorkerConfig {
  connect: AmpWorkerConnectTarget;
  meshSecret: string | null;
  meshSecretPath: string | null;
  name: string;
  emoji: string;
  stableId: string;
  mode: AmpMode;
  ampCommand: string;
  cwd: string;
  stateFilePath: string;
  pollIntervalMs: number;
  orbAudience: string | null;
}

export const DEFAULT_POLL_INTERVAL_MS = 2000;

export const AMP_WORKER_USAGE = `Usage: pinet-amp-worker [options]

Run an Amp harness worker on the Pinet mesh. The worker registers with the
broker, executes inbox assignments as Amp thread turns, replies through the
broker, and acks only after the reply is durable.

Broker endpoint (choose one):
  --socket <path>          Unix socket (default: ~/.pi/pinet.sock)
  --host <host> --port <n> TCP. Loopback may be plaintext; any remote host
                           requires the TLS options below.

TLS (required for non-loopback brokers; provide at least one trust anchor):
  --tls-ca <file>          PEM CA bundle for chain + hostname verification
  --tls-pin <sha256>       Pinned server-certificate SHA-256 fingerprint
  --tls-servername <name>  SNI/hostname override when dialing by IP
  --tls-key <file>         Client private key (mTLS, optional)
  --tls-cert <file>        Client certificate (mTLS, optional)

Authentication:
  --mesh-secret-file <file> Mesh shared-secret file
                            (default: ~/.pi/pinet.secret if present; the
                            PINET_MESH_SECRET environment variable wins)

Identity & execution:
  --name <name>            Agent name (default: amp-<hostname>)
  --emoji <emoji>          Agent emoji (default: ⚡)
  --stable-id <id>         Stable identity for reconnect/claim recovery
  --mode <mode>            Amp agent mode: ${AMP_MODES.join(" | ")} (default: medium)
  --amp-command <cmd>      Amp CLI executable (default: amp)
  --cwd <dir>              Working directory Amp runs in (default: current)
  --state-file <file>      Durable state file
                           (default: ~/.pi/amp-worker/<stable-id>.state.json)
  --poll-interval-ms <n>   Broker inbox poll interval (default: ${DEFAULT_POLL_INTERVAL_MS})
  --orb-audience <aud>     Capture Amp orb OIDC identity claims with this
                           audience and attach them to registration metadata
  --help                   Show this help
`;

export function parseAmpWorkerArgs(argv: readonly string[]): AmpWorkerCliArgs {
  const args: AmpWorkerCliArgs = {
    help: false,
    socketPath: null,
    host: null,
    port: null,
    tlsCaPath: null,
    tlsPin: null,
    tlsServername: null,
    tlsKeyPath: null,
    tlsCertPath: null,
    meshSecretPath: null,
    name: null,
    emoji: null,
    stableId: null,
    mode: "medium",
    ampCommand: "amp",
    cwd: null,
    stateFilePath: null,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    orbAudience: null,
  };

  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}.`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--socket":
        args.socketPath = takeValue(flag, index);
        index += 1;
        break;
      case "--host":
        args.host = takeValue(flag, index);
        index += 1;
        break;
      case "--port": {
        const raw = takeValue(flag, index);
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`Invalid --port value "${raw}".`);
        }
        args.port = port;
        index += 1;
        break;
      }
      case "--tls-ca":
        args.tlsCaPath = takeValue(flag, index);
        index += 1;
        break;
      case "--tls-pin":
        args.tlsPin = takeValue(flag, index);
        index += 1;
        break;
      case "--tls-servername":
        args.tlsServername = takeValue(flag, index);
        index += 1;
        break;
      case "--tls-key":
        args.tlsKeyPath = takeValue(flag, index);
        index += 1;
        break;
      case "--tls-cert":
        args.tlsCertPath = takeValue(flag, index);
        index += 1;
        break;
      case "--mesh-secret-file":
        args.meshSecretPath = takeValue(flag, index);
        index += 1;
        break;
      case "--name":
        args.name = takeValue(flag, index);
        index += 1;
        break;
      case "--emoji":
        args.emoji = takeValue(flag, index);
        index += 1;
        break;
      case "--stable-id":
        args.stableId = takeValue(flag, index);
        index += 1;
        break;
      case "--mode":
        args.mode = parseAmpMode(takeValue(flag, index));
        index += 1;
        break;
      case "--amp-command":
        args.ampCommand = takeValue(flag, index);
        index += 1;
        break;
      case "--cwd":
        args.cwd = takeValue(flag, index);
        index += 1;
        break;
      case "--state-file":
        args.stateFilePath = takeValue(flag, index);
        index += 1;
        break;
      case "--poll-interval-ms": {
        const raw = takeValue(flag, index);
        const interval = Number(raw);
        if (!Number.isInteger(interval) || interval < 100) {
          throw new Error(`Invalid --poll-interval-ms value "${raw}" (minimum 100).`);
        }
        args.pollIntervalMs = interval;
        index += 1;
        break;
      }
      case "--orb-audience":
        args.orbAudience = takeValue(flag, index);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}. Run with --help for usage.`);
    }
  }

  if (args.socketPath && (args.host || args.port !== null)) {
    throw new Error("Use either --socket or --host/--port, not both.");
  }
  if ((args.host === null) !== (args.port === null)) {
    throw new Error("--host and --port must be provided together.");
  }
  const hasTlsFlag =
    args.tlsCaPath !== null ||
    args.tlsPin !== null ||
    args.tlsServername !== null ||
    args.tlsKeyPath !== null ||
    args.tlsCertPath !== null;
  if (hasTlsFlag && args.host === null) {
    throw new Error("TLS options require --host/--port.");
  }

  return args;
}

export interface AmpWorkerConfigEnv {
  PINET_MESH_SECRET?: string;
}

export function resolveAmpWorkerConfig(
  args: AmpWorkerCliArgs,
  env: AmpWorkerConfigEnv = {},
): AmpWorkerConfig {
  const cwd = path.resolve(args.cwd ?? process.cwd());

  let connect: AmpWorkerConnectTarget;
  if (args.host !== null && args.port !== null) {
    const wantsTls =
      args.tlsCaPath !== null ||
      args.tlsPin !== null ||
      args.tlsServername !== null ||
      args.tlsKeyPath !== null ||
      args.tlsCertPath !== null;
    if (wantsTls) {
      const tls: BrokerClientTlsOptions = {
        ...(args.tlsCaPath ? { ca: fs.readFileSync(args.tlsCaPath, "utf-8") } : {}),
        ...(args.tlsPin ? { pinnedCertSha256: args.tlsPin } : {}),
        ...(args.tlsServername ? { servername: args.tlsServername } : {}),
        ...(args.tlsKeyPath ? { key: fs.readFileSync(args.tlsKeyPath, "utf-8") } : {}),
        ...(args.tlsCertPath ? { cert: fs.readFileSync(args.tlsCertPath, "utf-8") } : {}),
      };
      connect = { kind: "tls", host: args.host, port: args.port, tls };
    } else {
      connect = { kind: "tcp", host: args.host, port: args.port };
    }
  } else {
    connect = {
      kind: "socket",
      path: args.socketPath ?? path.join(getPinetConfigDir(), "pinet.sock"),
    };
  }

  const envSecret = env.PINET_MESH_SECRET?.trim();
  const meshSecret = envSecret && envSecret.length > 0 ? envSecret : null;
  let meshSecretPath: string | null = null;
  if (!meshSecret) {
    if (args.meshSecretPath) {
      meshSecretPath = args.meshSecretPath;
    } else if (fs.existsSync(getDefaultMeshSecretPath())) {
      meshSecretPath = getDefaultMeshSecretPath();
    }
  }

  const hostname = os.hostname();
  const name = args.name?.trim() || `amp-${hostname}`;
  const stableId = args.stableId?.trim() || `amp-worker:${hostname}:${sanitizePathSegment(cwd)}`;
  const stateFilePath =
    args.stateFilePath ??
    path.join(getPinetConfigDir(), "amp-worker", `${sanitizePathSegment(stableId)}.state.json`);

  return {
    connect,
    meshSecret,
    meshSecretPath,
    name,
    emoji: args.emoji?.trim() || "⚡",
    stableId,
    mode: args.mode,
    ampCommand: args.ampCommand,
    cwd,
    stateFilePath,
    pollIntervalMs: args.pollIntervalMs,
    orbAudience: args.orbAudience,
  };
}

function sanitizePathSegment(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "default"
  );
}
