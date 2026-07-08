import { buildSlackRequest } from "./helpers.js";
import type { SlackResult } from "./slack-api.js";

export type SlackScopeDiagnosticsSurface = "files" | "bookmarks" | "pins";

export type SlackScopeProbeBody = Record<string, unknown>;

interface SlackFileInfoScopeProbeBody extends SlackScopeProbeBody {
  file: string;
}

interface SlackCompleteUploadScopeProbeFile {
  id: string;
  title: string;
}

interface SlackCompleteUploadScopeProbeBody extends SlackScopeProbeBody {
  files: SlackCompleteUploadScopeProbeFile[];
  channel_id: string;
}

interface SlackChannelScopeProbeBody extends SlackScopeProbeBody {
  channel_id: string;
}

interface SlackBookmarkRemoveScopeProbeBody extends SlackChannelScopeProbeBody {
  bookmark_id: string;
}

interface SlackPinnedItemScopeProbeBody extends SlackScopeProbeBody {
  channel: string;
  timestamp?: string;
}

export type SlackScopeProbeRequestBody =
  | SlackFileInfoScopeProbeBody
  | SlackCompleteUploadScopeProbeBody
  | SlackChannelScopeProbeBody
  | SlackBookmarkRemoveScopeProbeBody
  | SlackPinnedItemScopeProbeBody;

interface SlackScopeProbe {
  key: string;
  surface: SlackScopeDiagnosticsSurface;
  method: string;
  body: SlackScopeProbeRequestBody;
  expectedScopes: string[];
  okErrors: string[];
}

export type SlackScopeDiagnosticsStatus =
  | "not_checked"
  | "pending"
  | "healthy"
  | "drift"
  | "unavailable";

export interface SlackScopeProbeResult {
  key: string;
  surface: SlackScopeDiagnosticsSurface;
  method: string;
  expectedScopes: string[];
  status: "ok" | "missing" | "unavailable";
  missingScopes: string[];
  error?: string;
  neededScopes?: string[];
  providedScopes?: string[];
}

export interface SlackScopeDiagnostics {
  status: SlackScopeDiagnosticsStatus;
  checkedAt: string | null;
  summary: string;
  surfaces: SlackScopeDiagnosticsSurface[];
  missingScopes: string[];
  results: SlackScopeProbeResult[];
  error?: string;
}

export interface DetectSlackScopeDiagnosticsOptions {
  token: string;
  fetchImpl?: typeof fetch;
  now?: () => string;
}

const SCOPE_DRIFT_PROBES: readonly SlackScopeProbe[] = [
  {
    key: "files_read",
    surface: "files",
    method: "files.info",
    body: { file: "F0000000000" },
    expectedScopes: ["files:read"],
    okErrors: ["file_not_found", "invalid_arguments", "channel_canvas_deleted"],
  },
  {
    key: "files_write",
    surface: "files",
    method: "files.completeUploadExternal",
    body: {
      files: [{ id: "F0000000000", title: "scope-drift-probe" }],
      channel_id: "C0000000000",
    },
    expectedScopes: ["files:write"],
    okErrors: ["file_not_found", "channel_not_found", "invalid_arguments"],
  },
  {
    key: "bookmarks_read",
    surface: "bookmarks",
    method: "bookmarks.list",
    body: { channel_id: "C0000000000" },
    expectedScopes: ["bookmarks:read"],
    okErrors: ["channel_not_found", "invalid_arguments"],
  },
  {
    key: "bookmarks_write",
    surface: "bookmarks",
    method: "bookmarks.remove",
    body: { channel_id: "C0000000000", bookmark_id: "Bk0000000000" },
    expectedScopes: ["bookmarks:write"],
    okErrors: ["channel_not_found", "not_found", "invalid_arguments"],
  },
  {
    key: "pins_read",
    surface: "pins",
    method: "pins.list",
    body: { channel: "C0000000000" },
    expectedScopes: ["pins:read"],
    okErrors: ["channel_not_found", "invalid_arguments"],
  },
  {
    key: "pins_write",
    surface: "pins",
    method: "pins.add",
    body: { channel: "C0000000000", timestamp: "0" },
    expectedScopes: ["pins:write"],
    okErrors: [
      "channel_not_found",
      "message_not_found",
      "file_not_found",
      "no_item",
      "invalid_arguments",
    ],
  },
];

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function normalizeScopeList(raw: unknown): string[] {
  if (typeof raw !== "string") {
    return [];
  }

  return uniqueSorted(
    raw
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
}

function summarizeUnavailableErrors(results: SlackScopeProbeResult[]): string | undefined {
  const errors = uniqueSorted(
    results
      .filter((result) => result.status === "unavailable")
      .map((result) => `${result.method}: ${result.error ?? "unknown"}`),
  );
  return errors[0];
}

function formatScopeList(scopes: string[]): string {
  return scopes.join(", ");
}

async function readSlackProbeResult(response: Response): Promise<SlackResult> {
  try {
    return (await response.json()) as SlackResult;
  } catch {
    return { ok: false, error: `http_${response.status}` };
  }
}

async function runSlackScopeProbe(
  probe: SlackScopeProbe,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SlackScopeProbeResult> {
  const { url, init } = buildSlackRequest(probe.method, token, probe.body);

  try {
    const response = await fetchImpl(url, init);
    if (response.status === 429) {
      return {
        key: probe.key,
        surface: probe.surface,
        method: probe.method,
        expectedScopes: probe.expectedScopes,
        status: "unavailable",
        missingScopes: [],
        error: "rate_limited",
      };
    }

    const payload = await readSlackProbeResult(response);
    if (payload.ok) {
      return {
        key: probe.key,
        surface: probe.surface,
        method: probe.method,
        expectedScopes: probe.expectedScopes,
        status: "ok",
        missingScopes: [],
      };
    }

    const error = typeof payload.error === "string" ? payload.error : `http_${response.status}`;
    if (probe.okErrors.includes(error)) {
      return {
        key: probe.key,
        surface: probe.surface,
        method: probe.method,
        expectedScopes: probe.expectedScopes,
        status: "ok",
        missingScopes: [],
      };
    }

    if (error === "missing_scope" || error === "not_allowed_token_type") {
      const neededScopes = normalizeScopeList(payload.needed);
      const providedScopes = normalizeScopeList(payload.provided);
      return {
        key: probe.key,
        surface: probe.surface,
        method: probe.method,
        expectedScopes: probe.expectedScopes,
        status: "missing",
        missingScopes: neededScopes.length > 0 ? neededScopes : probe.expectedScopes,
        error,
        ...(neededScopes.length > 0 ? { neededScopes } : {}),
        ...(providedScopes.length > 0 ? { providedScopes } : {}),
      };
    }

    return {
      key: probe.key,
      surface: probe.surface,
      method: probe.method,
      expectedScopes: probe.expectedScopes,
      status: "unavailable",
      missingScopes: [],
      error,
    };
  } catch (error) {
    return {
      key: probe.key,
      surface: probe.surface,
      method: probe.method,
      expectedScopes: probe.expectedScopes,
      status: "unavailable",
      missingScopes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createUncheckedSlackScopeDiagnostics(): SlackScopeDiagnostics {
  return {
    status: "not_checked",
    checkedAt: null,
    summary: "not checked",
    surfaces: [],
    missingScopes: [],
    results: [],
  };
}

export function createPendingSlackScopeDiagnostics(): SlackScopeDiagnostics {
  return {
    status: "pending",
    checkedAt: null,
    summary: "pending",
    surfaces: [],
    missingScopes: [],
    results: [],
  };
}

export async function detectSlackScopeDiagnostics(
  options: DetectSlackScopeDiagnosticsOptions,
): Promise<SlackScopeDiagnostics> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const checkedAt = now();
  const results = await Promise.all(
    SCOPE_DRIFT_PROBES.map((probe) => runSlackScopeProbe(probe, options.token, fetchImpl)),
  );

  const missingScopes = uniqueSorted(
    results.flatMap((result) => (result.status === "missing" ? result.missingScopes : [])),
  );
  const surfaces = uniqueSorted(
    results.flatMap((result) => (result.status === "missing" ? [result.surface] : [])),
  ) as SlackScopeDiagnosticsSurface[];

  if (missingScopes.length > 0) {
    return {
      status: "drift",
      checkedAt,
      summary: `scope drift — missing ${formatScopeList(missingScopes)}`,
      surfaces,
      missingScopes,
      results,
    };
  }

  const unavailableError = summarizeUnavailableErrors(results);
  if (unavailableError) {
    return {
      status: "unavailable",
      checkedAt,
      summary: `unavailable (${unavailableError})`,
      surfaces: [],
      missingScopes: [],
      results,
      error: unavailableError,
    };
  }

  return {
    status: "healthy",
    checkedAt,
    summary: "healthy",
    surfaces: [],
    missingScopes: [],
    results,
  };
}

export function formatSlackScopeDiagnosticsStatus(diagnostics: SlackScopeDiagnostics): string {
  return diagnostics.summary;
}

export function buildSlackScopeDriftWarning(diagnostics: SlackScopeDiagnostics): string | null {
  if (diagnostics.status !== "drift" || diagnostics.missingScopes.length === 0) {
    return null;
  }

  const surfaceSummary =
    diagnostics.surfaces.length > 0 ? diagnostics.surfaces.join(", ") : "files";
  return [
    `Slack scope drift detected: missing ${formatScopeList(diagnostics.missingScopes)}.`,
    `Affected Slack surfaces: ${surfaceSummary}.`,
    "Reinstall or reapply the current slack-bridge manifest scopes in Slack, then restart the bridge.",
  ].join(" ");
}
