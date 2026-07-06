import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDefaultMeshSecretPath, getDefaultSocketPath } from "@pinet/broker-core/paths";

export interface WorkerConfig {
  /** Broker Unix socket path. Env override: PINET_SOCKET_PATH. */
  socketPath: string;
  /** Mesh shared-secret file. Null disables auth. */
  meshSecretPath: string | null;
  /** Explicit agent name; empty string lets the broker assign an identity. */
  name: string;
  emoji: string;
  /** Stable identity across restarts. */
  stableId: string;
  /** Default working directory for Claude Code task runs. */
  workdir: string;
  /** Claude Code executable. */
  claudeBin: string;
  /** Optional model override passed to claude CLI. */
  model: string | null;
  /** Hard timeout for a single task run. */
  taskTimeoutMs: number;
  /** Inbox poll interval. */
  pollIntervalMs: number;
  /** State directory (session map, logs). */
  stateDir: string;
}

export interface WorkerConfigOverrides {
  socketPath?: string;
  meshSecretPath?: string | null;
  name?: string;
  emoji?: string;
  stableId?: string;
  workdir?: string;
  claudeBin?: string;
  model?: string | null;
  taskTimeoutMs?: number;
  pollIntervalMs?: number;
  stateDir?: string;
}

export function getDefaultStateDir(): string {
  return path.join(os.homedir(), ".pi", "claude-code-worker");
}

export function getDefaultConfigPath(): string {
  return path.join(getDefaultStateDir(), "config.json");
}

/**
 * Locate the mesh secret file the local broker uses, without reading its
 * contents here: explicit override, then pi's slack-bridge settings, then the
 * default path, then null (auth disabled).
 */
export function resolveMeshSecretPath(explicit?: string | null): string | null {
  if (explicit === null) return null;
  if (explicit && explicit.trim()) return explicit.trim();

  const piSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(piSettingsPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const bridge = settings["slack-bridge"];
    if (bridge && typeof bridge === "object") {
      const configured = (bridge as Record<string, unknown>).meshSecretPath;
      if (typeof configured === "string" && configured.trim()) {
        return configured.trim();
      }
    }
  } catch {
    /* no pi settings — fall through */
  }

  const defaultPath = getDefaultMeshSecretPath();
  return fs.existsSync(defaultPath) ? defaultPath : null;
}

function readConfigFile(configPath: string): WorkerConfigOverrides {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as WorkerConfigOverrides;
  } catch {
    return {};
  }
}

/** Merge defaults, config file, and explicit overrides (pure; no filesystem reads). */
export function mergeConfig(
  defaults: WorkerConfig,
  ...layers: WorkerConfigOverrides[]
): WorkerConfig {
  const merged: WorkerConfig = { ...defaults };
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) {
        (merged as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  return merged;
}

export function resolveWorkerConfig(overrides: WorkerConfigOverrides = {}): WorkerConfig {
  const stateDir = overrides.stateDir ?? getDefaultStateDir();
  const fileOverrides = readConfigFile(path.join(stateDir, "config.json"));

  const defaults: WorkerConfig = {
    socketPath: process.env.PINET_SOCKET_PATH?.trim() || getDefaultSocketPath(),
    meshSecretPath: null,
    name: "",
    emoji: "",
    stableId: `claude-code-worker:${os.hostname()}`,
    workdir: process.cwd(),
    claudeBin: "claude",
    model: null,
    taskTimeoutMs: 30 * 60 * 1000,
    pollIntervalMs: 2000,
    stateDir,
  };

  const merged = mergeConfig(defaults, fileOverrides, overrides);
  merged.meshSecretPath = resolveMeshSecretPath(
    overrides.meshSecretPath !== undefined
      ? overrides.meshSecretPath
      : fileOverrides.meshSecretPath,
  );
  return merged;
}
