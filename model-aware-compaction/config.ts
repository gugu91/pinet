import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import type { CompactionRule } from "./helpers.js";

export const SETTINGS_KEY = "model-aware-compaction";
const DEFAULT_RULES: CompactionRule[] = [
  { model: "openai/gpt-5-mini", activeContextTokens: 100_000 },
  { model: "anthropic/claude-sonnet-4-6", activeContextTokens: 100_000 },
];

export interface ModelAwareCompactionConfig {
  enabled?: boolean;
  compactionModel?: string;
  rules?: Array<{ model?: string; activeContextTokens?: number; compactionModel?: string }>;
  customInstructions?: string;
  debug?: boolean;
}

export interface ResolvedConfig {
  enabled: boolean;
  compactionModel?: string;
  rules: CompactionRule[];
  customInstructions?: string;
  debug: boolean;
  sourcePath: string | null;
}

type SettingsJsonPrimitive = string | number | boolean | null;
type SettingsJsonValue = SettingsJsonPrimitive | SettingsJsonObject | SettingsJsonValue[];
type SettingsJsonObject = { [key: string]: SettingsJsonValue };

function parseSettings(path: string): ModelAwareCompactionConfig | null {
  if (!fs.existsSync(path)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as SettingsJsonValue;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed[SETTINGS_KEY];
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as ModelAwareCompactionConfig;
  } catch (error) {
    console.error(
      `[${SETTINGS_KEY}] Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export function resolveConfig(
  raw?: ModelAwareCompactionConfig | null,
  sourcePath: string | null = null,
): ResolvedConfig {
  const configured = Array.isArray(raw?.rules)
    ? raw.rules.flatMap((rule) => {
        const model = typeof rule.model === "string" ? rule.model.trim() : "";
        const tokens = rule.activeContextTokens;
        const compactionModel =
          typeof rule.compactionModel === "string" && rule.compactionModel.trim()
            ? rule.compactionModel.trim()
            : undefined;
        return model && typeof tokens === "number" && Number.isInteger(tokens) && tokens > 0
          ? [
              {
                model,
                activeContextTokens: tokens,
                ...(compactionModel ? { compactionModel } : {}),
              },
            ]
          : [];
      })
    : [];
  const customInstructions =
    typeof raw?.customInstructions === "string" && raw.customInstructions.trim()
      ? raw.customInstructions.trim()
      : undefined;
  const compactionModel =
    typeof raw?.compactionModel === "string" && raw.compactionModel.trim()
      ? raw.compactionModel.trim()
      : undefined;
  return {
    enabled: raw?.enabled === true,
    compactionModel,
    rules: configured.length > 0 ? configured : DEFAULT_RULES,
    customInstructions,
    debug: raw?.debug === true,
    sourcePath,
  };
}

export function loadConfig(
  cwd = process.cwd(),
  agentDir = join(os.homedir(), ".pi", "agent"),
): ResolvedConfig {
  const projectPath = join(cwd, ".pi", "settings.json");
  const globalPath = join(agentDir, "settings.json");
  const project = parseSettings(projectPath);
  if (project) return resolveConfig(project, `${projectPath}#${SETTINGS_KEY}`);
  const global = parseSettings(globalPath);
  if (global) return resolveConfig(global, `${globalPath}#${SETTINGS_KEY}`);
  return resolveConfig();
}
