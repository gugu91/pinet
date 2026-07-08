export const BROWSER_BACKEND_VALUES = ["playwright", "agent-browser"] as const;
export type BrowserBackend = (typeof BROWSER_BACKEND_VALUES)[number];

export const BROWSER_ACTION_VALUES = [
  "start",
  "info",
  "navigate",
  "snapshot",
  "extract",
  "click",
  "fill",
  "press",
  "wait",
  "screenshot",
  "tabs",
  "close",
] as const;
export type BrowserAction = (typeof BROWSER_ACTION_VALUES)[number];

export type BrowserScalar = string | number | boolean | null;
export type BrowserJsonValue = BrowserScalar | BrowserJsonObject | BrowserJsonValue[];
export interface BrowserJsonObject {
  [key: string]: BrowserJsonValue;
}
export type BrowserArgs = Record<string, BrowserScalar>;
export type BrowserArgsInput = BrowserJsonObject;
export type BrowserResultPayload = BrowserJsonObject;
export type BrowserArtifactPayload = BrowserJsonObject;

export type BrowserToolInput = {
  backend?: BrowserBackend;
  action: BrowserAction;
  session_id?: string;
  page_id?: string;
  args?: BrowserArgsInput;
  input_json?: string;
};

export type BrowserToolRequest = {
  backend: BrowserBackend;
  action: BrowserAction;
  sessionId?: string;
  pageId?: string;
  args: BrowserArgs;
};

export type BrowserCapabilities = {
  backend: BrowserBackend;
  available: boolean;
  supported_actions: BrowserAction[];
  notes?: string[];
};

export type BrowserToolEnvelope = {
  backend: BrowserBackend;
  action: BrowserAction;
  session_id: string | null;
  page_id: string | null;
  capabilities: BrowserCapabilities;
  result: BrowserResultPayload;
  artifacts: BrowserArtifactPayload[];
};

export type BrowserOutputOptions = {
  format: "cli" | "json";
  full: boolean;
};

type BrowserActionSchema = {
  description: string;
  requires_session_id?: boolean;
  optional_session_id?: boolean;
  requires_page_id?: boolean;
  args?: {
    required?: string[];
    optional?: string[];
  };
  example: BrowserJsonObject;
};

const BROWSER_ACTION_SCHEMAS: Record<BrowserAction, BrowserActionSchema> = {
  start: {
    description: "Start a Playwright browser session and optionally open an initial URL.",
    args: {
      optional: [
        "url",
        "browser",
        "headless",
        "viewport_width",
        "viewport_height",
        "storage_state_name",
      ],
    },
    example: { action: "start", args: { url: "https://example.com" } },
  },
  info: {
    description:
      "Return session diagnostics when session_id is provided, or return the compact browser action catalogue/schema when no session_id is provided.",
    optional_session_id: true,
    args: { optional: ["topic"] },
    example: { action: "info", args: { topic: "schema" } },
  },
  navigate: {
    description: "Navigate the active page, or a new tab, to a URL.",
    requires_session_id: true,
    args: { required: ["url"], optional: ["new_tab", "wait_until", "timeout_ms"] },
    example: {
      action: "navigate",
      session_id: "browser_123",
      args: { url: "https://example.com/docs", new_tab: true },
    },
  },
  snapshot: {
    description: "Capture a compact text/metadata snapshot of the current page.",
    requires_session_id: true,
    example: { action: "snapshot", session_id: "browser_123" },
  },
  extract: {
    description:
      "Extract body text when no selector is provided, or extract text/attributes from matching page elements.",
    requires_session_id: true,
    args: { optional: ["selector", "attribute", "max_items"] },
    example: { action: "extract", session_id: "browser_123", args: { selector: "h1" } },
  },
  click: {
    description: "Click an element matched by selector.",
    requires_session_id: true,
    args: { required: ["selector"], optional: ["timeout_ms", "double_click"] },
    example: { action: "click", session_id: "browser_123", args: { selector: "button" } },
  },
  fill: {
    description: "Fill an input-like element matched by selector.",
    requires_session_id: true,
    args: { required: ["selector", "value"], optional: ["timeout_ms"] },
    example: {
      action: "fill",
      session_id: "browser_123",
      args: { selector: "input[name='q']", value: "Playwright docs" },
    },
  },
  press: {
    description: "Send a keyboard key press, optionally scoped to an element.",
    requires_session_id: true,
    args: { required: ["key"], optional: ["selector", "timeout_ms"] },
    example: { action: "press", session_id: "browser_123", args: { key: "Enter" } },
  },
  wait: {
    description: "Wait for selector, text, URL substring, load state, or explicit delay.",
    requires_session_id: true,
    args: {
      optional: ["selector", "text", "url_includes", "load_state", "delay_ms", "timeout_ms"],
    },
    example: { action: "wait", session_id: "browser_123", args: { text: "Loaded" } },
  },
  screenshot: {
    description: "Capture a screenshot artifact for the active or selected page.",
    requires_session_id: true,
    args: { optional: ["label", "full_page"] },
    example: {
      action: "screenshot",
      session_id: "browser_123",
      args: { label: "search-results", full_page: true },
    },
  },
  tabs: {
    description: "List pages/tabs and optionally activate a page by id.",
    requires_session_id: true,
    args: { optional: ["activate_page_id"] },
    example: { action: "tabs", session_id: "browser_123" },
  },
  close: {
    description:
      "Close the selected page when page_id is provided, or close the entire browser session.",
    requires_session_id: true,
    args: { optional: ["close_session"] },
    example: { action: "close", session_id: "browser_123", args: { close_session: true } },
  },
};

function parseInputJson(raw: string | undefined): BrowserArgs {
  if (!raw) return {};

  let parsed: BrowserJsonValue;
  try {
    parsed = JSON.parse(raw) as BrowserJsonValue;
  } catch (error) {
    throw new Error(
      `input_json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseArgsObject(parsed, "input_json");
}

function parseArgsObject(
  raw: BrowserArgsInput | BrowserJsonValue | undefined,
  source: "args" | "input_json",
): BrowserArgs {
  if (raw === undefined) return {};
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source} must be a JSON object.`);
  }

  const result: BrowserArgs = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
      continue;
    }
    throw new Error(`${source} field \`${key}\` must be a string, number, boolean, or null.`);
  }
  return result;
}

function mergeArgs(preferredArgs: BrowserArgs, compatibilityArgs: BrowserArgs): BrowserArgs {
  const merged: BrowserArgs = { ...compatibilityArgs };
  for (const [key, value] of Object.entries(preferredArgs)) {
    const compatibilityValue = compatibilityArgs[key];
    if (compatibilityValue !== undefined && !Object.is(compatibilityValue, value)) {
      throw new Error(
        `Conflicting browser input for \`${key}\`: args.${key} and input_json.${key} differ. Use one value.`,
      );
    }
    merged[key] = value;
  }
  return merged;
}

function applyTopLevelId(
  args: BrowserArgs,
  topLevelValue: string | undefined,
  key: "session_id" | "page_id",
): void {
  if (!topLevelValue) return;
  const nestedValue = args[key];
  if (nestedValue !== undefined && nestedValue !== topLevelValue) {
    throw new Error(
      `Conflicting browser input for \`${key}\`: top-level ${key} is authoritative and differs from the nested args/input_json value.`,
    );
  }
  args[key] = topLevelValue;
}

function stringFrom(value: BrowserScalar | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isBrowserAction(value: string): value is BrowserAction {
  return BROWSER_ACTION_VALUES.includes(value as BrowserAction);
}

export function parseBrowserToolRequest(input: BrowserToolInput): BrowserToolRequest {
  const compatibilityArgs = parseInputJson(input.input_json);
  const preferredArgs = parseArgsObject(input.args, "args");
  const args = mergeArgs(preferredArgs, compatibilityArgs);

  applyTopLevelId(args, input.session_id, "session_id");
  applyTopLevelId(args, input.page_id, "page_id");

  return {
    backend: input.backend ?? "playwright",
    action: input.action,
    sessionId: stringFrom(args.session_id),
    pageId: stringFrom(args.page_id),
    args,
  };
}

export function getStringArg(args: BrowserArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function requireStringArg(args: BrowserArgs, key: string): string {
  const value = getStringArg(args, key);
  if (!value) {
    throw new Error(`browser action requires string field \`${key}\` in args.`);
  }
  return value;
}

export function getBooleanArg(args: BrowserArgs, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

export function getNumberArg(args: BrowserArgs, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

export function normalizeBrowserOutputOptions(args: BrowserArgs): BrowserOutputOptions {
  const rawFormat = args.format ?? args.f ?? args["-f"];
  const format = rawFormat == null ? "cli" : String(rawFormat).trim().toLowerCase();
  if (format !== "cli" && format !== "json") {
    throw new Error('browser output format must be "cli" or "json".');
  }

  const rawFull = args.full ?? args["--full"];
  if (rawFull != null && typeof rawFull !== "boolean") {
    throw new Error("browser output full must be a boolean when provided.");
  }

  return { format, full: rawFull === true };
}

function compactTruncate(value: string, maxLength = 900): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 18)).trimEnd()}… [truncated]`;
}

function recordValue(record: BrowserJsonObject, key: string): BrowserJsonObject | null {
  const value = record[key];
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as BrowserJsonObject)
    : null;
}

function arrayValue(record: BrowserJsonObject, key: string): BrowserJsonValue[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function stringValue(record: BrowserJsonObject | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(record: BrowserJsonObject | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" ? value : null;
}

function booleanValue(record: BrowserJsonObject | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function countFromCollection(record: BrowserJsonObject, key: string): number | null {
  const collection = recordValue(record, key);
  return numberValue(collection, "count");
}

function formatMaybeTitle(title: string | null): string {
  return title ? `; title=${JSON.stringify(compactTruncate(title, 120))}` : "";
}

function formatPageSummary(page: BrowserJsonObject | null): string {
  if (!page) return "page=unknown";
  const pageId = stringValue(page, "page_id") ?? "unknown";
  const url = stringValue(page, "url");
  const title = stringValue(page, "title");
  return `page=${pageId}${url ? `; url=${compactTruncate(url, 180)}` : ""}${formatMaybeTitle(title)}`;
}

function formatItemPreview(items: BrowserJsonValue[], maxItems = 5): string {
  const lines = items
    .slice(0, maxItems)
    .map((item) => {
      if (item == null || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as BrowserJsonObject;
      const text = stringValue(record, "text") ?? stringValue(record, "name") ?? null;
      const href = stringValue(record, "href");
      const value = text ?? href;
      return value ? `- ${compactTruncate(value.replace(/\s+/g, " ").trim(), 180)}` : null;
    })
    .filter((line): line is string => Boolean(line));
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

function formatBrowserCompactText(envelope: BrowserToolEnvelope): string {
  const result = envelope.result;
  const blockedStatus = stringValue(result, "status") === "blocked";
  const unavailable = booleanValue(result, "available") === false;
  if (blockedStatus || unavailable) {
    const reason = stringValue(result, "reason");
    return `Browser ${envelope.backend} unavailable${reason ? `: ${compactTruncate(reason, 220)}` : "."}`;
  }

  const sessionId = stringValue(result, "session_id") ?? envelope.session_id;
  const pageId = stringValue(result, "page_id") ?? envelope.page_id;

  switch (envelope.action) {
    case "start": {
      const pages = arrayValue(result, "pages");
      const activePageId = stringValue(result, "active_page_id") ?? "none";
      const headless = booleanValue(result, "headless");
      return `Browser started: session=${sessionId ?? "unknown"}; active=${activePageId}; pages=${pages.length}${headless == null ? "" : `; headless=${headless}`}.`;
    }
    case "info": {
      const actions = arrayValue(result, "actions");
      if (actions.length > 0 && !sessionId) {
        const names = actions
          .map((action) =>
            action != null && typeof action === "object" && !Array.isArray(action)
              ? stringValue(action as BrowserJsonObject, "action")
              : null,
          )
          .filter((action): action is string => Boolean(action));
        return `Browser actions: ${names.join(", ")}. Use action='info' args.topic='<action|schema>'; args.format='json' for full details.`;
      }
      const network = recordValue(result, "network_summary");
      const blocked = numberValue(network, "blocked_requests") ?? 0;
      const failed = numberValue(network, "failed_requests") ?? 0;
      return `Browser info: session=${sessionId ?? "unknown"}; pages=${numberValue(result, "page_count") ?? arrayValue(result, "pages").length}; active=${stringValue(result, "active_page_id") ?? "none"}; blocked=${blocked}; failed=${failed}.`;
    }
    case "navigate":
      return `Browser navigated: ${formatPageSummary(recordValue(result, "page"))}.`;
    case "snapshot": {
      const title = stringValue(result, "title");
      const url = stringValue(result, "url");
      const text = stringValue(result, "text");
      const counts = [
        ["headings", countFromCollection(result, "headings")],
        ["links", countFromCollection(result, "links")],
        ["buttons", countFromCollection(result, "buttons")],
        ["fields", countFromCollection(result, "fields")],
      ]
        .filter((entry): entry is [string, number] => typeof entry[1] === "number")
        .map(([name, count]) => `${name}=${count}`)
        .join("; ");
      const header = `Browser snapshot: page=${pageId ?? "unknown"}${url ? `; url=${compactTruncate(url, 180)}` : ""}${formatMaybeTitle(title)}${counts ? `; ${counts}` : ""}.`;
      return text ? `${header}\n${compactTruncate(text.replace(/\n{3,}/g, "\n\n"))}` : header;
    }
    case "extract": {
      const selector = stringValue(result, "selector");
      const text = stringValue(result, "text");
      const items = arrayValue(result, "items");
      const matchCount = numberValue(result, "match_count");
      const truncated = booleanValue(result, "truncated") === true ? "; truncated=true" : "";
      const header = selector
        ? `Browser extract: selector=${JSON.stringify(selector)}; matches=${matchCount ?? "unknown"}; items=${items.length}${truncated}.`
        : `Browser extract: body text${stringValue(result, "url") ? `; url=${compactTruncate(stringValue(result, "url")!, 180)}` : ""}.`;
      if (!selector && text)
        return `${header}\n${compactTruncate(text.replace(/\n{3,}/g, "\n\n"))}`;
      return `${header}${formatItemPreview(items)}`;
    }
    case "click": {
      const blocked = recordValue(result, "blocked_request") ? "; blocked_request=true" : "";
      return `Browser clicked: selector=${JSON.stringify(stringValue(result, "clicked_selector") ?? "")}; ${formatPageSummary(recordValue(result, "active_page"))}${blocked}.`;
    }
    case "fill":
      return `Browser filled: selector=${JSON.stringify(stringValue(result, "selector") ?? "")}; value_length=${numberValue(result, "value_length") ?? 0}; page=${pageId ?? "unknown"}.`;
    case "press": {
      const blocked = recordValue(result, "blocked_request") ? "; blocked_request=true" : "";
      return `Browser pressed: key=${JSON.stringify(stringValue(result, "key") ?? "")}; page=${pageId ?? "unknown"}${stringValue(result, "url") ? `; url=${compactTruncate(stringValue(result, "url")!, 180)}` : ""}${blocked}.`;
    }
    case "wait":
      return `Browser wait matched: ${stringValue(result, "matched") ?? "unknown"}; page=${pageId ?? "unknown"}${stringValue(result, "url") ? `; url=${compactTruncate(stringValue(result, "url")!, 180)}` : ""}.`;
    case "screenshot":
      return `Browser screenshot: path=${stringValue(result, "path") ?? "unknown"}; page=${pageId ?? "unknown"}; full_page=${booleanValue(result, "full_page") === true}.`;
    case "tabs": {
      const pages = arrayValue(result, "pages");
      const pagePreview = pages
        .slice(0, 5)
        .map((page) =>
          page != null && typeof page === "object" && !Array.isArray(page)
            ? stringValue(page as BrowserJsonObject, "page_id")
            : null,
        )
        .filter((id): id is string => Boolean(id));
      return `Browser tabs: pages=${numberValue(result, "page_count") ?? pages.length}; active=${stringValue(result, "active_page_id") ?? "none"}${pagePreview.length > 0 ? `; ids=${pagePreview.join(",")}` : ""}.`;
    }
    case "close":
      return `Browser closed: ${stringValue(result, "closed") ?? "target"}${pageId ? `; page=${pageId}` : ""}${booleanValue(result, "session_closed") === true ? "; session_closed=true" : ""}.`;
    default:
      return `Browser ${envelope.action}: ok.`;
  }
}

export function formatBrowserResponseText(
  envelope: BrowserToolEnvelope,
  options: BrowserOutputOptions,
): string {
  if (options.format === "json" || options.full) {
    return JSON.stringify(envelope, null, 2);
  }
  return formatBrowserCompactText(envelope);
}

export function buildCapabilities(backend: BrowserBackend): BrowserCapabilities {
  if (backend === "playwright") {
    return {
      backend,
      available: true,
      supported_actions: [...BROWSER_ACTION_VALUES],
      notes: [
        "Playwright is the supported local browsing path in this Anthropic sandbox.",
        "Use action='info' without a session_id for compact action help/schema discovery.",
        "Artifacts and storage state stay rooted in the active workspace.",
      ],
    };
  }

  return {
    backend,
    available: false,
    supported_actions: [],
    notes: [
      "agent-browser is scaffolded behind the same one-tool contract but is unavailable locally.",
      "Local daemon compatibility is a non-goal here; any truthful future support is remote/optional executor mode unless upstream ships a real embeddable SDK.",
    ],
  };
}

export function buildBrowserDiscovery(topic: string | undefined): BrowserJsonObject {
  const normalizedTopic = topic?.trim().toLowerCase();
  const actionSummaries = BROWSER_ACTION_VALUES.map((action) => ({
    action,
    description: BROWSER_ACTION_SCHEMAS[action].description,
    requires_session_id: BROWSER_ACTION_SCHEMAS[action].requires_session_id ?? false,
  }));

  const base = {
    tool: "browser",
    contract: {
      preferred_shape: "browser({ action, args?, session_id?, page_id?, backend? })",
      args: "Preferred structured carrier for action-specific scalar fields.",
      output:
        "Defaults to compact CLI text. Use args.format='json' (or args.f/args['-f']) for the structured envelope, or args.full=true (or args['--full']=true) for verbose visible output.",
      input_json: "Compatibility-only JSON string carrier; do not use for new calls.",
      backend: "Omit for normal local use; Playwright is the supported local path.",
      top_level_ids: "Top-level session_id/page_id are authoritative; conflicting nested IDs fail.",
    },
    discovery: {
      catalog: { action: "info" },
      all_schemas: { action: "info", args: { topic: "schema" } },
      action_schema: { action: "info", args: { topic: "navigate" } },
    },
  };

  if (!normalizedTopic || normalizedTopic === "help" || normalizedTopic === "actions") {
    return {
      ...base,
      actions: actionSummaries,
    };
  }

  if (normalizedTopic === "schema" || normalizedTopic === "schemas") {
    return {
      ...base,
      actions: actionSummaries,
      schemas: BROWSER_ACTION_SCHEMAS,
    };
  }

  if (isBrowserAction(normalizedTopic)) {
    return {
      ...base,
      action: normalizedTopic,
      schema: BROWSER_ACTION_SCHEMAS[normalizedTopic],
    };
  }

  throw new Error(
    `Unsupported browser info topic \`${topic}\`. Use help, schema, or one of: ${describeBrowserActions()}.`,
  );
}

export function describeBrowserActions(): string {
  return BROWSER_ACTION_VALUES.join(", ");
}
