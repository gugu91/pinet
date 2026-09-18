import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import type { CompactionRule } from "./helpers.js";

export const SETTINGS_KEY = "model-aware-compaction";
const DEFAULT_RULES: CompactionRule[] = [
  { model: "openai/gpt-5-mini", activeContextTokens: 100_000 },
  { model: "anthropic/claude-sonnet-4-6", activeContextTokens: 100_000 },
];

/** A selector or an ordered fallback chain of up to MAX_CHAIN_LENGTH selectors. */
export type CompactionModelSetting = string | string[];

export interface ModelAwareCompactionConfig {
  enabled?: boolean;
  compactionModel?: CompactionModelSetting;
  rules?: Array<{
    model?: string;
    activeContextTokens?: number;
    compactionModel?: CompactionModelSetting;
  }>;
  customInstructions?: string;
  debug?: boolean;
}

export const MAX_CHAIN_LENGTH = 3;

export interface ResolvedConfig {
  enabled: boolean;
  /** Ordered fallback chain; empty when no global compaction model is configured. */
  compactionModels: string[];
  rules: CompactionRule[];
  customInstructions?: string;
  debug: boolean;
  sourcePath: string | null;
}

type SettingsJsonPrimitive = string | number | boolean | null;
type SettingsJsonValue = SettingsJsonPrimitive | SettingsJsonObject | SettingsJsonValue[];
type SettingsJsonObject = { [key: string]: SettingsJsonValue };

/**
 * Normalize a selector or chain: trimmed, non-empty, de-duplicated, first
 * MAX_CHAIN_LENGTH entries. Every entry is user-named, so fallback never routes
 * context anywhere the configuration does not list.
 */
function selectorChain(value: CompactionModelSetting | undefined): string[] {
  const entries = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const chain = entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry, index, all) => entry !== "" && all.indexOf(entry) === index);
  if (chain.length > MAX_CHAIN_LENGTH)
    console.error(
      `[${SETTINGS_KEY}] compactionModel lists ${chain.length} selectors; only the first ${MAX_CHAIN_LENGTH} are used`,
    );
  return chain.slice(0, MAX_CHAIN_LENGTH);
}

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
        const compactionModels = selectorChain(rule.compactionModel);
        return model && typeof tokens === "number" && Number.isInteger(tokens) && tokens > 0
          ? [
              {
                model,
                activeContextTokens: tokens,
                ...(compactionModels.length > 0 ? { compactionModels } : {}),
              },
            ]
          : [];
      })
    : [];
  const customInstructions =
    typeof raw?.customInstructions === "string" && raw.customInstructions.trim()
      ? raw.customInstructions.trim()
      : undefined;
  return {
    enabled: raw?.enabled === true,
    compactionModels: selectorChain(raw?.compactionModel),
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
