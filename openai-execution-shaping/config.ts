import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

export const SETTINGS_KEY = "openai-execution-shaping";
const DEFAULT_PROVIDER_IDS = ["openai", "openai-codex"] as const;
const DEFAULT_MODEL_REGEX = "^gpt-5";
const DEFAULT_MAX_AUTO_CONTINUES = 1;

export interface OpenAIExecutionShapingConfig {
  enabled?: boolean;
  providers?: string[];
  modelRegex?: string;
  promptOverlay?: {
    enabled?: boolean;
  };
  autoContinue?: {
    enabled?: boolean;
    maxTurns?: number;
  };
  debug?: boolean;
}

export interface ResolvedOpenAIExecutionShapingConfig {
  enabled: boolean;
  providers: string[];
  providerSet: ReadonlySet<string>;
  modelRegexSource: string;
  modelRegex: RegExp;
  promptOverlayEnabled: boolean;
  autoContinueEnabled: boolean;
  maxAutoContinueTurns: number;
  debug: boolean;
  sourcePath: string | null;
}

export interface LoadConfigOptions {
  cwd?: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}

type SettingsJsonPrimitive = string | number | boolean | null;
type SettingsJsonValue = SettingsJsonPrimitive | SettingsJsonObject | SettingsJsonValue[];
type SettingsJsonObject = { [key: string]: SettingsJsonValue };

function parseJsonFile(filePath: string): SettingsJsonValue | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as SettingsJsonValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${SETTINGS_KEY}] Failed to parse config ${filePath}: ${message}`);
    return null;
  }
}

function readSettingsConfig(
  settingsPath: string,
): { path: string; raw: OpenAIExecutionShapingConfig } | null {
  if (!fs.existsSync(settingsPath)) return null;
  const parsed = parseJsonFile(settingsPath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const raw = parsed[SETTINGS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  return {
    path: `${settingsPath}#${SETTINGS_KEY}`,
    raw: raw as OpenAIExecutionShapingConfig,
  };
}

function normalizeProviders(rawProviders: string[] | undefined): {
  providers: string[];
  providerSet: ReadonlySet<string>;
} {
  const providers = Array.isArray(rawProviders)
    ? rawProviders
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0)
    : [...DEFAULT_PROVIDER_IDS];

  const effectiveProviders = providers.length > 0 ? providers : [...DEFAULT_PROVIDER_IDS];
  return {
    providers: effectiveProviders,
    providerSet: new Set(effectiveProviders.map((provider) => provider.toLowerCase())),
  };
}

export function resolveConfig(
  raw: OpenAIExecutionShapingConfig | null | undefined,
  sourcePath: string | null = null,
): ResolvedOpenAIExecutionShapingConfig {
  const { providers, providerSet } = normalizeProviders(raw?.providers);

  const modelRegexSource =
    typeof raw?.modelRegex === "string" && raw.modelRegex.trim().length > 0
      ? raw.modelRegex.trim()
      : DEFAULT_MODEL_REGEX;

  let modelRegex: RegExp;
  try {
    modelRegex = new RegExp(modelRegexSource, "i");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[${SETTINGS_KEY}] Invalid modelRegex ${JSON.stringify(modelRegexSource)} in ${sourcePath ?? "config"}: ${message}`,
    );
    modelRegex = new RegExp(DEFAULT_MODEL_REGEX, "i");
  }

  const maxAutoContinueTurns = Math.max(
    0,
    Math.min(
      5,
      typeof raw?.autoContinue?.maxTurns === "number" && Number.isFinite(raw.autoContinue.maxTurns)
        ? Math.floor(raw.autoContinue.maxTurns)
        : DEFAULT_MAX_AUTO_CONTINUES,
    ),
  );

  return {
    enabled: raw?.enabled === true,
    providers,
    providerSet,
    modelRegexSource,
    modelRegex,
    promptOverlayEnabled: raw?.promptOverlay?.enabled ?? true,
    autoContinueEnabled: raw?.autoContinue?.enabled ?? true,
    maxAutoContinueTurns,
    debug: raw?.debug === true,
    sourcePath,
  };
}

export function loadConfig(options: LoadConfigOptions = {}): ResolvedOpenAIExecutionShapingConfig {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? join(os.homedir(), ".pi", "agent");
  const env = options.env ?? process.env;

  const explicitSettingsPath = env.PI_OPENAI_EXECUTION_SHAPING_SETTINGS;
  if (explicitSettingsPath) {
    const explicit = readSettingsConfig(explicitSettingsPath);
    if (explicit) {
      return resolveConfig(explicit.raw, explicit.path);
    }
  }

  const projectSettings = readSettingsConfig(join(cwd, ".pi", "settings.json"));
  if (projectSettings) {
    return resolveConfig(projectSettings.raw, projectSettings.path);
  }

  const globalSettings = readSettingsConfig(join(agentDir, "settings.json"));
  if (globalSettings) {
    return resolveConfig(globalSettings.raw, globalSettings.path);
  }

  return resolveConfig(null, null);
}
