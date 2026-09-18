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

/**
 * Raw settings.json shape. `compactionModel` is typed as any JSON value because a
 * malformed value must be seen at this boundary and turned into a fail-closed entry.
 */
export interface ModelAwareCompactionConfig {
  enabled?: boolean;
  compactionModel?: CompactionModelSetting | SettingsJsonValue;
  rules?: Array<{
    model?: string;
    activeContextTokens?: number;
    compactionModel?: CompactionModelSetting | SettingsJsonValue;
  }>;
  customInstructions?: string;
  debug?: boolean;
}

export const MAX_CHAIN_LENGTH = 3;

/**
 * Marker for a chain entry that was not a string in settings. It is matched
 * explicitly by the compaction hook (not by failing to parse), because a
 * stringified object such as `{"a/b":1}` would otherwise look like a selector.
 */
const INVALID_ENTRY_PREFIX = "<invalid ";
export function isInvalidChainEntry(entry: string): boolean {
  return entry.startsWith(INVALID_ENTRY_PREFIX);
}

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

/** loadConfig runs on every settled turn; each distinct configuration problem is reported once. */
const reportedDiagnostics = new Set<string>();

/**
 * Normalize a selector or chain into the ordered entries the extension will try.
 *
 * Every entry is user-named, so fallback never routes context anywhere the
 * configuration does not list. Malformed values are kept as entries rather than
 * dropped: a number, object, or boolean becomes a string that cannot parse as a
 * selector, which makes the compaction fail closed naming it, instead of quietly
 * skipping to the next entry or to another chain. `undefined`/`null` mean unset.
 */
function selectorChain(value: SettingsJsonValue | undefined): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const entries = Array.isArray(value) ? value : [value];
  const chain = entries
    .map((entry) =>
      typeof entry === "string" ? entry.trim() : `<invalid ${JSON.stringify(entry)}>`,
    )
    .filter((entry, index, all) => entry !== "" && all.indexOf(entry) === index);
  if (chain.length > MAX_CHAIN_LENGTH) {
    const message = `compactionModel lists ${chain.length} selectors; only the first ${MAX_CHAIN_LENGTH} are used`;
    if (!reportedDiagnostics.has(message)) {
      reportedDiagnostics.add(message);
      console.error(`[${SETTINGS_KEY}] ${message}`);
    }
  }
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
        // A rule chain that is present — even empty or malformed — overrides the
        // global chain for its models; only an absent key inherits it.
        const compactionModels = selectorChain(rule.compactionModel);
        return model && typeof tokens === "number" && Number.isInteger(tokens) && tokens > 0
          ? [
              {
                model,
                activeContextTokens: tokens,
                ...(compactionModels ? { compactionModels } : {}),
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
    compactionModels: selectorChain(raw?.compactionModel) ?? [],
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
