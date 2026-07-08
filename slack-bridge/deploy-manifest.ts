import * as fs from "node:fs";
import * as path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolveSlackAgentCommandNames } from "./slack-agents-command.js";

export interface SlackBridgeSettings {
  appId?: string;
  appToken?: string;
  appConfigToken?: string;
  skinTheme?: string;
  slackCommandName?: string;
  slackCommandNames?: string[];
}

const execFile = promisify(execFileCallback);

export interface ManifestScopeChanges {
  addedBotScopes: string[];
  removedBotScopes: string[];
  addedUserScopes: string[];
  removedUserScopes: string[];
}

export interface ResolvedDeployConfig {
  manifestPath: string;
  appId?: string;
  appConfigToken?: string;
  appToken?: string;
  settings: SlackBridgeSettings;
}

export interface DeployResult {
  appId: string;
  scopeChanges: ManifestScopeChanges;
}

interface SlackErrorDetail {
  message?: string;
  pointer?: string;
}

type SlackManifestPrimitive = string | number | boolean | null;
export type SlackManifestValue =
  | SlackManifestPrimitive
  | SlackManifestObject
  | SlackManifestValue[];
export interface SlackManifestObject {
  [key: string]: SlackManifestValue;
}

type SlackApiRequestBody = SlackManifestObject;

interface SlackMethodPayload {
  ok?: boolean;
  error?: string;
  errors?: SlackErrorDetail[];
  app_id?: string;
  manifest?: SlackManifestObject;
}

class SlackMethodError extends Error {
  readonly method: string;
  readonly slackError: string;
  readonly details: SlackErrorDetail[];

  constructor(method: string, slackError: string, details: SlackErrorDetail[] = []) {
    const detailMessage = details
      .map((detail) => {
        const pointer = detail.pointer ? `${detail.pointer}: ` : "";
        return `- ${pointer}${detail.message ?? "unknown error"}`;
      })
      .join("\n");
    super(
      detailMessage
        ? `Slack ${method}: ${slackError}\n${detailMessage}`
        : `Slack ${method}: ${slackError}`,
    );
    this.name = "SlackMethodError";
    this.method = method;
    this.slackError = slackError;
    this.details = details;
  }
}

function loadSettings(settingsPath?: string): SlackBridgeSettings {
  const resolvedPath =
    settingsPath ??
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".pi", "agent", "settings.json");
  try {
    const content = fs.readFileSync(resolvedPath, "utf-8");
    const parsed = JSON.parse(content) as SlackManifestObject;
    return ((parsed["slack-bridge"] as SlackManifestObject | undefined) ??
      {}) as SlackBridgeSettings;
  } catch {
    return {};
  }
}

function buildSlackRequest(
  method: string,
  token: string,
  body?: SlackApiRequestBody,
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  let serialized: string | undefined;
  if (body) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    serialized = JSON.stringify(body);
  }

  return {
    url: `https://slack.com/api/${method}`,
    init: {
      method: "POST",
      headers,
      ...(serialized ? { body: serialized } : {}),
    },
  };
}

function asManifestObject(value: SlackManifestValue | undefined): SlackManifestObject | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as SlackManifestObject)
    : null;
}

function readScopeList(
  manifest: SlackManifestObject | null | undefined,
  scopeType: "bot" | "user",
): string[] {
  const oauthConfig = asManifestObject(manifest?.oauth_config);
  const scopes = asManifestObject(oauthConfig?.scopes);
  const raw = scopes?.[scopeType];
  if (!Array.isArray(raw)) {
    return [];
  }

  return [
    ...new Set(raw.filter((item): item is string => typeof item === "string" && item.length > 0)),
  ].sort();
}

export function diffManifestScopes(
  beforeManifest: SlackManifestObject | null | undefined,
  afterManifest: SlackManifestObject | null | undefined,
): ManifestScopeChanges {
  const beforeBot = new Set(readScopeList(beforeManifest, "bot"));
  const afterBot = new Set(readScopeList(afterManifest, "bot"));
  const beforeUser = new Set(readScopeList(beforeManifest, "user"));
  const afterUser = new Set(readScopeList(afterManifest, "user"));

  const diff = (next: Set<string>, prev: Set<string>): string[] =>
    [...next].filter((scope) => !prev.has(scope)).sort();

  return {
    addedBotScopes: diff(afterBot, beforeBot),
    removedBotScopes: diff(beforeBot, afterBot),
    addedUserScopes: diff(afterUser, beforeUser),
    removedUserScopes: diff(beforeUser, afterUser),
  };
}

export function formatScopeChangeSummary(changes: ManifestScopeChanges): string[] {
  const lines: string[] = [];

  if (changes.addedBotScopes.length > 0) {
    lines.push(`Bot scopes added: ${changes.addedBotScopes.join(", ")}`);
  }
  if (changes.removedBotScopes.length > 0) {
    lines.push(`Bot scopes removed: ${changes.removedBotScopes.join(", ")}`);
  }
  if (changes.addedUserScopes.length > 0) {
    lines.push(`User scopes added: ${changes.addedUserScopes.join(", ")}`);
  }
  if (changes.removedUserScopes.length > 0) {
    lines.push(`User scopes removed: ${changes.removedUserScopes.join(", ")}`);
  }

  return lines.length > 0 ? lines : ["No scope changes."];
}

export function resolveDeployConfig(
  settings: SlackBridgeSettings,
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): ResolvedDeployConfig {
  return {
    manifestPath: path.join(cwd, "slack-bridge", "manifest.yaml"),
    appId: settings.appId ?? env.SLACK_APP_ID,
    appConfigToken: settings.appConfigToken ?? env.SLACK_APP_CONFIG_TOKEN ?? env.SLACK_CONFIG_TOKEN,
    appToken: settings.appToken ?? env.SLACK_APP_TOKEN,
    settings,
  };
}

export function getDeployConfigError(config: ResolvedDeployConfig): string | null {
  if (!fs.existsSync(config.manifestPath)) {
    return `Slack manifest not found at ${config.manifestPath}`;
  }

  const messages: string[] = [];
  if (!config.appId) {
    messages.push(
      "Missing Slack app ID. Set slack-bridge.appId in ~/.pi/agent/settings.json or SLACK_APP_ID.",
    );
  }
  if (!config.appConfigToken) {
    const appTokenNote = config.appToken
      ? " Note: slack-bridge.appToken / SLACK_APP_TOKEN is a Socket Mode xapp token and cannot be used with apps.manifest.update."
      : "";
    messages.push(
      "Missing Slack app configuration token. Set slack-bridge.appConfigToken in ~/.pi/agent/settings.json or SLACK_APP_CONFIG_TOKEN (or SLACK_CONFIG_TOKEN)." +
        appTokenNote,
    );
  }

  return messages.length > 0 ? messages.join(" ") : null;
}

export function applyConfiguredSlashCommands(
  manifest: SlackManifestObject,
  settings: SlackBridgeSettings,
): SlackManifestObject {
  const commandNames = resolveSlackAgentCommandNames(settings);
  const features = asManifestObject(manifest.features) ?? {};
  const oauthConfig = asManifestObject(manifest.oauth_config) ?? {};
  const scopes = asManifestObject(oauthConfig.scopes) ?? {};
  const botScopes = readScopeList(manifest, "bot");
  const nextBotScopes = botScopes.includes("commands") ? botScopes : [...botScopes, "commands"];

  return {
    ...manifest,
    features: {
      ...features,
      slash_commands: commandNames.map((command) => ({
        command,
        description: "Show the Pinet broker roster and current work",
        usage_hint: "agents list [all]",
        should_escape: false,
      })),
    },
    oauth_config: {
      ...oauthConfig,
      scopes: {
        ...scopes,
        bot: nextBotScopes,
      },
    },
  };
}

async function parseManifestYaml(manifestPath: string): Promise<SlackManifestObject> {
  try {
    const program = [
      "require 'yaml'",
      "require 'json'",
      "data = YAML.load_file(ARGV[0])",
      "puts JSON.generate(data)",
    ].join("; ");
    const { stdout } = await execFile("ruby", ["-e", program, manifestPath]);
    return JSON.parse(stdout) as SlackManifestObject;
  } catch (error) {
    throw new Error(
      `Failed to parse ${manifestPath} via Ruby YAML parser. Ensure Ruby is installed and the manifest is valid YAML. ${String(error)}`,
    );
  }
}

async function callSlackMethod(
  method: string,
  token: string,
  body?: SlackApiRequestBody,
): Promise<SlackMethodPayload> {
  const { url, init } = buildSlackRequest(method, token, body);
  const response = await fetch(url, init);
  const payload = (await response.json()) as SlackMethodPayload;

  if (!response.ok || payload.ok !== true) {
    throw new SlackMethodError(
      method,
      payload.error ?? `http_${response.status}`,
      payload.errors ?? [],
    );
  }

  return payload;
}

async function exportRemoteManifest(
  appId: string,
  token: string,
): Promise<SlackManifestObject | undefined> {
  const payload = await callSlackMethod("apps.manifest.export", token, { app_id: appId });
  return payload.manifest;
}

async function validateManifest(manifest: SlackManifestObject, token: string): Promise<void> {
  await callSlackMethod("apps.manifest.validate", token, {
    manifest: JSON.stringify(manifest),
  });
}

async function updateManifest(
  appId: string,
  manifest: SlackManifestObject,
  token: string,
): Promise<void> {
  await callSlackMethod("apps.manifest.update", token, {
    app_id: appId,
    manifest: JSON.stringify(manifest),
  });
}

export async function deploySlackManifest(config: ResolvedDeployConfig): Promise<DeployResult> {
  const configError = getDeployConfigError(config);
  if (configError) {
    throw new Error(configError);
  }

  const appId = config.appId as string;
  const appConfigToken = config.appConfigToken as string;
  const manifest = applyConfiguredSlashCommands(
    await parseManifestYaml(config.manifestPath),
    config.settings,
  );
  const previousManifest = await exportRemoteManifest(appId, appConfigToken);

  await validateManifest(manifest, appConfigToken);
  await updateManifest(appId, manifest, appConfigToken);

  const updatedManifest = await exportRemoteManifest(appId, appConfigToken);
  return {
    appId,
    scopeChanges: diffManifestScopes(previousManifest, updatedManifest),
  };
}

export async function run(): Promise<void> {
  const settingsPath = process.env.PI_SETTINGS_PATH;
  const settings = loadSettings(settingsPath);
  const config = resolveDeployConfig(settings, process.env);
  const result = await deploySlackManifest(config);

  console.log(`Updated Slack app ${result.appId} from ${config.manifestPath}`);
  for (const line of formatScopeChangeSummary(result.scopeChanges)) {
    console.log(line);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
