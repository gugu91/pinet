import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import {
  CONFIG_ENV,
  SETTINGS_KEY,
  resolveBaseConfig,
  type RawCompactionWorkerConfig,
  type ResolvedBaseConfig,
} from "./helpers.js";

export interface LoadConfigOptions {
  cwd?: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}

function parseJsonFile(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${SETTINGS_KEY}] Failed to parse config ${filePath}: ${message}`);
    return null;
  }
}

function readSettingsConfig(
  settingsPath: string,
): { path: string; raw: RawCompactionWorkerConfig } | null {
  if (!fs.existsSync(settingsPath)) return null;
  const parsed = parseJsonFile(settingsPath);
  if (!parsed || typeof parsed !== "object") return null;
  const raw = (parsed as Record<string, unknown>)[SETTINGS_KEY];
  if (!raw || typeof raw !== "object") return null;
  return {
    path: `${settingsPath}#${SETTINGS_KEY}`,
    raw: raw as RawCompactionWorkerConfig,
  };
}

export function loadConfig(options: LoadConfigOptions = {}): ResolvedBaseConfig {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? join(os.homedir(), ".pi", "agent");
  const env = options.env ?? process.env;

  const explicitSettingsPath = env[CONFIG_ENV];
  if (explicitSettingsPath) {
    const explicit = readSettingsConfig(explicitSettingsPath);
    if (explicit) return resolveBaseConfig(explicit.raw, explicit.path);
  }

  const projectSettings = readSettingsConfig(join(cwd, ".pi", "settings.json"));
  if (projectSettings) return resolveBaseConfig(projectSettings.raw, projectSettings.path);

  const globalSettings = readSettingsConfig(join(agentDir, "settings.json"));
  if (globalSettings) return resolveBaseConfig(globalSettings.raw, globalSettings.path);

  return resolveBaseConfig(null, null);
}
