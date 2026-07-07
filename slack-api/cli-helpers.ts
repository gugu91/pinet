import type { WebClient } from "@slack/web-api";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

type SlackApiMethod = (input?: JsonObject) => Promise<JsonValue>;
type SlackClientMember =
  | SlackMethodContainer
  | SlackApiMethod
  | string
  | number
  | boolean
  | null
  | undefined;

type SlackMethodContainer = {
  [memberName: string]: SlackClientMember;
};

function slackMethodContainerFor(client: WebClient): SlackMethodContainer {
  return client as object as SlackMethodContainer;
}

function isSlackMethodContainer(value: SlackClientMember): value is SlackMethodContainer {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Discover callable Slack Web API methods by walking the WebClient prototype chain.
 * Returns dot-notated method names like "chat.postMessage", "conversations.list", etc.
 */
export function discoverMethods(client: WebClient): string[] {
  const methods: string[] = [];
  const root = slackMethodContainerFor(client);

  for (const namespace of Object.keys(root)) {
    const member = root[namespace];
    if (!isSlackMethodContainer(member)) continue;
    // Skip private/internal properties and known non-API namespaces
    if (namespace.startsWith("_") || namespace === "token" || namespace === "slackApiUrl") continue;

    for (const key of Object.keys(member)) {
      if (typeof member[key] === "function") {
        methods.push(`${namespace}.${key}`);
      }
    }
  }

  // Also check for top-level methods (e.g. api.test)
  return methods.sort();
}

/**
 * Resolve a dot-notated method name to a callable function on the WebClient.
 */
export function resolveMethod(client: WebClient, methodName: string): SlackApiMethod | null {
  const parts = methodName.split(".");
  if (parts.length < 2) return null;

  let target: SlackClientMember = slackMethodContainerFor(client);
  for (const part of parts) {
    if (!isSlackMethodContainer(target)) return null;
    target = target[part];
  }

  return typeof target === "function" ? target : null;
}

export function parseCliValue(raw: string): JsonValue {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed) as JsonValue;
  return raw;
}

export function parseKeyValueArg(entry: string): { key: string; value: JsonValue } {
  const separatorIndex = entry.indexOf("=");
  if (separatorIndex <= 0) {
    throw new Error(`Expected KEY=VALUE, received: ${entry}`);
  }
  const key = entry.slice(0, separatorIndex).trim();
  if (!key) {
    throw new Error(`Expected KEY=VALUE, received: ${entry}`);
  }
  return { key, value: parseCliValue(entry.slice(separatorIndex + 1)) };
}

export function parseJsonObject(raw: string): JsonObject {
  const value = JSON.parse(raw) as JsonValue;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value;
}

export function mergeInput(
  base: JsonObject,
  entries: ReadonlyArray<{ key: string; value: JsonValue }>,
): JsonObject {
  const merged: JsonObject = { ...base };
  for (const entry of entries) {
    merged[entry.key] = entry.value;
  }
  return merged;
}
