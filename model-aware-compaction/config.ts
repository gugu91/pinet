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
  rules?: Array<{ model?: string; activeContextTokens?: number }>;
  customInstructions?: string;
  debug?: boolean;
}

export interface ResolvedConfig {
  enabled: boolean;
  rules: CompactionRule[];
  customInstructions?: string;
  debug: boolean;
  sourcePath: string | null;
}

type SettingsJsonPrimitive = string | number | boolean | null;
type SettingsJsonValue = SettingsJsonPrimitive | SettingsJsonObject | SettingsJsonValue[];
type SettingsJsonObject = { [key: string]: SettingsJsonValue };

function parseSettings(
  path: string,
): { raw: ModelAwareCompactionConfig; sourcePath: string } | null {
  if (!fs.existsSync(path)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as SettingsJsonValue;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed[SETTINGS_KEY];
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return { raw: value as ModelAwareCompactionConfig, sourcePath: `${path}#${SETTINGS_KEY}` };
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
        return model && typeof tokens === "number" && Number.isInteger(tokens) && tokens > 0
          ? [{ model, activeContextTokens: tokens }]
          : [];
      })
    : [];
  const customInstructions =
    typeof raw?.customInstructions === "string" && raw.customInstructions.trim()
      ? raw.customInstructions.trim()
      : undefined;
  return {
    enabled: raw?.enabled === true,
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
  const project = parseSettings(join(cwd, ".pi", "settings.json"));
  if (project) return resolveConfig(project.raw, project.sourcePath);
  const global = parseSettings(join(agentDir, "settings.json"));
  if (global) return resolveConfig(global.raw, global.sourcePath);
  return resolveConfig();
}
