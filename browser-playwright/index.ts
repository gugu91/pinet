import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  assessUrl,
  buildInstallInstructions,
  findPreferredChromiumExecutable,
  isLocalhostUrl,
  parseIntegerEnv,
  resolveNavigationSecurityOptions,
  resolveRouteSecurityOptions,
  resolveSecurityOptions,
  safeRequestPageId,
  sanitizeLabel,
  STORAGE_STATE_RELATIVE_DIR,
  truncateText,
  type SupportedBrowserEngine,
  buildBrowserTrustBoundaryNotes,
} from "./helpers.ts";
import { buildAgentBrowserModeResult } from "./agent-browser.ts";
import {
  BROWSER_ACTION_VALUES,
  BROWSER_BACKEND_VALUES,
  buildBrowserDiscovery,
  buildCapabilities,
  describeBrowserActions,
  formatBrowserResponseText,
  getBooleanArg,
  getNumberArg,
  getStringArg,
  normalizeBrowserOutputOptions,
  parseBrowserToolRequest,
  requireStringArg,
  type BrowserAction,
  type BrowserArtifactPayload,
  type BrowserJsonObject,
  type BrowserResultPayload,
  type BrowserToolEnvelope,
  type BrowserToolRequest,
} from "./protocol.ts";
import { loadStoredStorageState, type StorageStateSummary } from "./storage-state.ts";
import type {
  Browser,
  BrowserContext,
  BrowserType,
  ConsoleMessage,
  Locator,
  Page,
  Request,
  Route,
} from "playwright";

type PlaywrightModule = Record<BrowserEngine, BrowserType>;

type BrowserEngine = SupportedBrowserEngine;
type BrowserNewContextOptions = Exclude<Parameters<Browser["newContext"]>[0], undefined>;

type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";

type PageSummary = {
  page_id: string;
  url: string;
  title: string | null;
  is_active: boolean;
  closed: boolean;
  created_at: string;
  last_activity_at: string;
};

type ConsoleEntry = {
  timestamp: string;
  page_id: string;
  type: string;
  text: string;
};

type BlockedRequestEntry = {
  timestamp: string;
  page_id: string | null;
  url: string;
  resource_type: string;
  reason: string;
};

type NetworkSummary = {
  total_requests: number;
  blocked_requests: number;
  failed_requests: number;
};

type BrowserPageRecord = {
  id: string;
  page: Page;
  createdAt: string;
  lastActivityAt: string;
  trustedLocalhostMode: boolean;
};

type BrowserBinaryInfo = {
  source: "playwright" | "env" | "path" | "system";
  executable_path: string | null;
};

type BrowserSession = {
  id: string;
  browserEngine: BrowserEngine;
  browser: Browser;
  context: BrowserContext;
  createdAt: string;
  lastActivityAt: string;
  headless: boolean;
  pages: Map<string, BrowserPageRecord>;
  pageIds: WeakMap<Page, string>;
  activePageId: string | null;
  consoleEntries: ConsoleEntry[];
  blockedRequests: BlockedRequestEntry[];
  networkSummary: NetworkSummary;
  mountedStorageState: StorageStateSummary | null;
  browserBinary: BrowserBinaryInfo;
};

const INSTALL_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const WORKSPACE_ROOT = resolve(process.cwd());
const ARTIFACT_ROOT = resolve(WORKSPACE_ROOT, ".pi/artifacts/browser-playwright");

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;
const DEFAULT_IDLE_TIMEOUT_MS = parseIntegerEnv("BROWSER_PLAYWRIGHT_IDLE_TIMEOUT_MS", 15 * 60_000);
const SESSION_SWEEP_INTERVAL_MS = 60_000;
const MAX_CONSOLE_ENTRIES = 25;
const MAX_BLOCKED_REQUESTS = 25;
const MAX_SNAPSHOT_TEXT_CHARS = 6_000;
const MAX_COLLECTION_ITEMS = 10;

const WAIT_UNTIL_VALUES = ["load", "domcontentloaded", "networkidle", "commit"] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function relativeFromWorkspace(absolutePath: string): string {
  return relative(WORKSPACE_ROOT, absolutePath);
}

function storageStateSummaryPayload(summary: StorageStateSummary | null): BrowserJsonObject | null {
  if (!summary) return null;
  return {
    name: summary.name,
    path: summary.path,
    cookie_count: summary.cookie_count,
    origin_count: summary.origin_count,
  };
}

async function loadPlaywright(browserEngine: BrowserEngine): Promise<PlaywrightModule> {
  try {
    return await import("playwright");
  } catch (error) {
    throw new Error(
      buildInstallInstructions(
        "Playwright is not installed for `browser-playwright`.",
        true,
        browserEngine,
        INSTALL_ROOT,
      ),
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

function isMissingBrowserExecutableError(error: unknown): boolean {
  const message = asErrorMessage(error);
  return (
    message.includes("Executable doesn't exist") ||
    message.includes("browserType.launch") ||
    message.includes("Please run the following command")
  );
}

function isWaitUntil(value: string): value is WaitUntil {
  return WAIT_UNTIL_VALUES.includes(value as WaitUntil);
}

function normalizeWaitUntil(value: string | undefined): WaitUntil {
  if (!value) return "domcontentloaded";
  if (!isWaitUntil(value)) {
    throw new Error(
      `Unsupported wait_until value \`${value}\`. Use one of: ${WAIT_UNTIL_VALUES.join(", ")}.`,
    );
  }
  return value;
}

function getSecurityOptions(): { allowLocalhost: boolean; allowPrivateNetwork: boolean } {
  return resolveSecurityOptions();
}

function isTrustedLocalhostTarget(url: string): boolean {
  try {
    return isLocalhostUrl(url);
  } catch {
    return false;
  }
}

async function launchBrowser(
  browserType: BrowserType,
  browserEngine: BrowserEngine,
  headless: boolean,
): Promise<{ browser: Browser; browserBinary: BrowserBinaryInfo }> {
  const preferredChromiumExecutable =
    browserEngine === "chromium" ? await findPreferredChromiumExecutable() : null;
  let preferredLaunchError: unknown = null;

  if (preferredChromiumExecutable) {
    try {
      const browser = await browserType.launch({
        headless,
        executablePath: preferredChromiumExecutable.path,
      });
      return {
        browser,
        browserBinary: {
          source: preferredChromiumExecutable.source,
          executable_path: preferredChromiumExecutable.path,
        },
      };
    } catch (error) {
      preferredLaunchError = error;
    }
  }

  try {
    const browser = await browserType.launch({ headless });
    return {
      browser,
      browserBinary: {
        source: "playwright",
        executable_path: null,
      },
    };
  } catch (error) {
    if (isMissingBrowserExecutableError(error)) {
      const installInstructions = buildInstallInstructions(
        `Playwright is installed but ${browserEngine} browser binaries are missing.`,
        false,
        browserEngine,
        INSTALL_ROOT,
      );
      if (preferredChromiumExecutable && preferredLaunchError) {
        throw new Error(
          [
            installInstructions,
            "",
            `A preferred host Chromium executable was found at \`${preferredChromiumExecutable.path}\` but Playwright could not launch it: ${asErrorMessage(preferredLaunchError)}`,
          ].join("\n"),
        );
      }
      throw new Error(installInstructions);
    }

    if (preferredChromiumExecutable && preferredLaunchError) {
      throw new Error(
        [
          `Failed to launch the preferred host Chromium executable at \`${preferredChromiumExecutable.path}\`: ${asErrorMessage(preferredLaunchError)}`,
          `Playwright fallback launch also failed: ${asErrorMessage(error)}`,
        ].join("\n\n"),
      );
    }

    throw error;
  }
}

function recordConsoleEntry(session: BrowserSession, entry: ConsoleEntry): void {
  session.consoleEntries.push(entry);
  if (session.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
    session.consoleEntries.splice(0, session.consoleEntries.length - MAX_CONSOLE_ENTRIES);
  }
}

function recordBlockedRequest(session: BrowserSession, entry: BlockedRequestEntry): void {
  session.blockedRequests.push(entry);
  session.networkSummary.blocked_requests += 1;
  if (session.blockedRequests.length > MAX_BLOCKED_REQUESTS) {
    session.blockedRequests.splice(0, session.blockedRequests.length - MAX_BLOCKED_REQUESTS);
  }
}

function touchSession(session: BrowserSession): void {
  session.lastActivityAt = nowIso();
}

function touchPage(pageRecord: BrowserPageRecord): void {
  pageRecord.lastActivityAt = nowIso();
}

async function safeTitle(page: Page): Promise<string | null> {
  try {
    const title = await page.title();
    return title.length > 0 ? title : null;
  } catch {
    return null;
  }
}

function getPageRecord(session: BrowserSession, pageId: string): BrowserPageRecord {
  const pageRecord = session.pages.get(pageId);
  if (!pageRecord) {
    throw new Error(`Unknown page_id: ${pageId}`);
  }
  return pageRecord;
}

async function buildPageSummary(
  session: BrowserSession,
  pageRecord: BrowserPageRecord,
): Promise<PageSummary> {
  return {
    page_id: pageRecord.id,
    url: pageRecord.page.url(),
    title: await safeTitle(pageRecord.page),
    is_active: session.activePageId === pageRecord.id,
    closed: pageRecord.page.isClosed(),
    created_at: pageRecord.createdAt,
    last_activity_at: pageRecord.lastActivityAt,
  };
}

async function listPages(session: BrowserSession): Promise<PageSummary[]> {
  const summaries = await Promise.all(
    [...session.pages.values()].map((pageRecord) => buildPageSummary(session, pageRecord)),
  );
  return summaries.sort((left, right) => left.created_at.localeCompare(right.created_at));
}

function getSessionOrThrow(
  sessions: Map<string, BrowserSession>,
  sessionId: string,
): BrowserSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown session_id: ${sessionId}`);
  }
  touchSession(session);
  return session;
}

async function registerPage(session: BrowserSession, page: Page): Promise<BrowserPageRecord> {
  const existingPageId = session.pageIds.get(page);
  if (existingPageId) {
    return getPageRecord(session, existingPageId);
  }

  const pageRecord: BrowserPageRecord = {
    id: `page_${randomUUID()}`,
    page,
    createdAt: nowIso(),
    lastActivityAt: nowIso(),
    trustedLocalhostMode: false,
  };

  session.pageIds.set(page, pageRecord.id);
  session.pages.set(pageRecord.id, pageRecord);
  session.activePageId = pageRecord.id;
  touchSession(session);

  page.on("console", (message: ConsoleMessage) => {
    recordConsoleEntry(session, {
      timestamp: nowIso(),
      page_id: pageRecord.id,
      type: message.type(),
      text: truncateText(message.text(), 500, 12),
    });
  });

  page.on("pageerror", (error: Error) => {
    recordConsoleEntry(session, {
      timestamp: nowIso(),
      page_id: pageRecord.id,
      type: "pageerror",
      text: truncateText(error.message, 500, 12),
    });
  });

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      pageRecord.trustedLocalhostMode = isTrustedLocalhostTarget(frame.url());
      touchPage(pageRecord);
      touchSession(session);
      session.activePageId = pageRecord.id;
    }
  });

  page.on("requestfailed", () => {
    session.networkSummary.failed_requests += 1;
  });

  page.on("close", () => {
    session.pages.delete(pageRecord.id);
    if (session.activePageId === pageRecord.id) {
      session.activePageId = [...session.pages.keys()][0] ?? null;
    }
    touchSession(session);
  });

  return pageRecord;
}

async function createTrackedPage(session: BrowserSession): Promise<BrowserPageRecord> {
  const page = await session.context.newPage();
  return registerPage(session, page);
}

async function resolvePageRecord(
  session: BrowserSession,
  pageId: string | undefined,
  createIfMissing: boolean,
): Promise<BrowserPageRecord> {
  if (pageId) {
    const pageRecord = getPageRecord(session, pageId);
    touchPage(pageRecord);
    return pageRecord;
  }

  if (session.activePageId && session.pages.has(session.activePageId)) {
    const pageRecord = getPageRecord(session, session.activePageId);
    touchPage(pageRecord);
    return pageRecord;
  }

  const firstPage = session.pages.values().next().value as BrowserPageRecord | undefined;
  if (firstPage) {
    session.activePageId = firstPage.id;
    touchPage(firstPage);
    return firstPage;
  }

  if (!createIfMissing) {
    throw new Error(`Session ${session.id} has no open pages. Start a new tab or session.`);
  }

  return createTrackedPage(session);
}

function maybeLastBlockedRequest(session: BrowserSession, url: string): BlockedRequestEntry | null {
  const normalized = url.replace(/\/$/, "");
  for (let index = session.blockedRequests.length - 1; index >= 0; index -= 1) {
    const entry = session.blockedRequests[index];
    if (entry.url.replace(/\/$/, "") === normalized) {
      return entry;
    }
  }
  return null;
}

async function gotoWithSafety(
  session: BrowserSession,
  pageRecord: BrowserPageRecord,
  url: string,
  waitUntil: WaitUntil,
  timeoutMs: number,
): Promise<void> {
  const baseSecurityOptions = getSecurityOptions();
  const navigationSecurityOptions = resolveNavigationSecurityOptions(url, baseSecurityOptions);
  const trustedLocalhostMode = isTrustedLocalhostTarget(url);
  const decision = assessUrl(url, navigationSecurityOptions);
  if (!decision.allowed) {
    throw new Error([decision.reason, decision.hint].filter(Boolean).join("\n"));
  }

  pageRecord.trustedLocalhostMode = trustedLocalhostMode;

  try {
    await pageRecord.page.goto(url, { waitUntil, timeout: timeoutMs });
    session.activePageId = pageRecord.id;
    touchPage(pageRecord);
    touchSession(session);
  } catch (error) {
    pageRecord.trustedLocalhostMode = false;
    const blocked = maybeLastBlockedRequest(session, url);
    if (blocked) {
      throw new Error(blocked.reason);
    }
    throw error;
  }
}

async function waitForPossibleNavigation(
  page: Page,
  previousUrl: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await page.waitForURL((current) => current.toString() !== previousUrl, {
      timeout: Math.min(timeoutMs, 3_000),
    });
    return;
  } catch {
    // fall through
  }

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 3_000) });
  } catch {
    // best effort
  }
}

async function ensureArtifactsDir(): Promise<void> {
  await mkdir(ARTIFACT_ROOT, { recursive: true });
}

async function buildElementSummary(
  locator: Locator,
  attribute: string | undefined,
): Promise<BrowserJsonObject> {
  const summary: BrowserJsonObject = {};

  const text = truncateText(
    await locator.innerText().catch(async () => (await locator.textContent()) ?? ""),
  );
  if (text) {
    summary.text = text;
  }

  if (attribute) {
    summary.attribute = attribute;
    summary.value = (await locator.getAttribute(attribute)) ?? null;
    return summary;
  }

  const href = await locator.getAttribute("href").catch(() => null);
  const src = await locator.getAttribute("src").catch(() => null);
  const placeholder = await locator.getAttribute("placeholder").catch(() => null);
  const ariaLabel = await locator.getAttribute("aria-label").catch(() => null);
  const name = await locator.getAttribute("name").catch(() => null);
  const type = await locator.getAttribute("type").catch(() => null);
  const role = await locator.getAttribute("role").catch(() => null);
  const value = await locator.inputValue().catch(() => null);

  if (href) summary.href = href;
  if (src) summary.src = src;
  if (placeholder) summary.placeholder = placeholder;
  if (ariaLabel) summary.aria_label = ariaLabel;
  if (name) summary.name = name;
  if (type) summary.type = type;
  if (role) summary.role = role;
  if (value) summary.value = truncateText(value, 300, 6);

  return summary;
}

async function collectElements(
  locator: Locator,
  maxItems = MAX_COLLECTION_ITEMS,
  attribute?: string,
): Promise<{ count: number; items: BrowserJsonObject[]; truncated: boolean }> {
  const count = await locator.count();
  const items: BrowserJsonObject[] = [];
  const stopAt = Math.min(count, maxItems);
  for (let index = 0; index < stopAt; index += 1) {
    items.push(await buildElementSummary(locator.nth(index), attribute));
  }
  return { count, items, truncated: count > stopAt };
}

async function buildPageInspection(pageRecord: BrowserPageRecord): Promise<{
  title: string | null;
  url: string;
  text: string;
  headings: { count: number; items: BrowserJsonObject[]; truncated: boolean };
  links: { count: number; items: BrowserJsonObject[]; truncated: boolean };
  buttons: { count: number; items: BrowserJsonObject[]; truncated: boolean };
  fields: { count: number; items: BrowserJsonObject[]; truncated: boolean };
}> {
  const page = pageRecord.page;
  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  return {
    title: await safeTitle(page),
    url: page.url(),
    text: truncateText(bodyText, MAX_SNAPSHOT_TEXT_CHARS, 180),
    headings: await collectElements(page.locator("h1, h2, h3"), 8),
    links: await collectElements(page.locator("a[href]"), 10),
    buttons: await collectElements(
      page.locator("button, input[type='button'], input[type='submit']"),
      10,
    ),
    fields: await collectElements(page.locator("input, textarea, select"), 10),
  };
}

async function closeSession(session: BrowserSession): Promise<void> {
  try {
    await session.browser.close();
  } catch {
    // best effort
  }
}

export default function browserPlaywrightExtension(pi: ExtensionAPI) {
  const sessions = new Map<string, BrowserSession>();
  let cleanupTimer: NodeJS.Timeout | null = setInterval(() => {
    void cleanupExpiredSessions();
  }, SESSION_SWEEP_INTERVAL_MS);
  cleanupTimer.unref?.();

  async function cleanupExpiredSessions(): Promise<void> {
    if (DEFAULT_IDLE_TIMEOUT_MS <= 0) return;

    const now = Date.now();
    const expiredSessions = [...sessions.values()].filter((session) => {
      const idleFor = now - Date.parse(session.lastActivityAt);
      return idleFor >= DEFAULT_IDLE_TIMEOUT_MS;
    });

    for (const session of expiredSessions) {
      await closeSession(session);
      sessions.delete(session.id);
    }
  }

  function registerCommonHandlers(): void {
    pi.on("session_shutdown", async () => {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      await Promise.all([...sessions.values()].map((session) => closeSession(session)));
      sessions.clear();
    });
  }

  function respond(
    request: BrowserToolRequest,
    result: BrowserResultPayload,
    artifacts: BrowserArtifactPayload[] = [],
  ) {
    const envelope: BrowserToolEnvelope = {
      backend: request.backend,
      action: request.action,
      session_id:
        request.sessionId ??
        (typeof result.session_id === "string" ? (result.session_id as string) : null),
      page_id:
        request.pageId ?? (typeof result.page_id === "string" ? (result.page_id as string) : null),
      capabilities: buildCapabilities(request.backend),
      result,
      artifacts,
    };
    const output = normalizeBrowserOutputOptions(request.args);

    return {
      content: [{ type: "text" as const, text: formatBrowserResponseText(envelope, output) }],
      details: envelope,
    };
  }

  function requireSessionId(request: BrowserToolRequest): string {
    if (!request.sessionId) {
      throw new Error("browser action requires `session_id` for this operation.");
    }
    return request.sessionId;
  }

  function resolveBrowserEngine(value: string | undefined): BrowserEngine {
    if (!value || value === "chromium" || value === "firefox" || value === "webkit") {
      return (value ?? "chromium") as BrowserEngine;
    }
    throw new Error("browser start action only supports browser=chromium, firefox, or webkit.");
  }

  async function executeStart(request: BrowserToolRequest, signal: AbortSignal | undefined) {
    if (signal?.aborted) {
      throw new Error("Cancelled before starting a browser session.");
    }

    await cleanupExpiredSessions();
    await ensureArtifactsDir();

    const browserEngine = resolveBrowserEngine(getStringArg(request.args, "browser"));
    const playwright = await loadPlaywright(browserEngine);
    const browserType = playwright[browserEngine] as BrowserType;
    const headless = getBooleanArg(request.args, "headless") ?? true;
    const loadedStorageState = getStringArg(request.args, "storage_state_name")
      ? await loadStoredStorageState(getStringArg(request.args, "storage_state_name")!, {
          workspaceRoot: WORKSPACE_ROOT,
        })
      : null;

    const { browser, browserBinary } = await launchBrowser(browserType, browserEngine, headless);

    try {
      const viewportWidth = getNumberArg(request.args, "viewport_width");
      const viewportHeight = getNumberArg(request.args, "viewport_height");
      const contextOptions: BrowserNewContextOptions = {
        viewport:
          viewportWidth && viewportHeight
            ? { width: viewportWidth, height: viewportHeight }
            : { width: 1280, height: 800 },
      };
      if (loadedStorageState) {
        contextOptions.storageState =
          loadedStorageState.storageState as BrowserNewContextOptions["storageState"];
      }

      const context = await browser.newContext(contextOptions);

      const session: BrowserSession = {
        id: `browser_${randomUUID()}`,
        browserEngine,
        browser,
        context,
        createdAt: nowIso(),
        lastActivityAt: nowIso(),
        headless,
        pages: new Map(),
        pageIds: new WeakMap(),
        activePageId: null,
        consoleEntries: [],
        blockedRequests: [],
        networkSummary: {
          total_requests: 0,
          blocked_requests: 0,
          failed_requests: 0,
        },
        mountedStorageState: loadedStorageState?.summary ?? null,
        browserBinary,
      };

      await context.route("**/*", async (route: Route) => {
        const requestRecord: Request = route.request();
        session.networkSummary.total_requests += 1;
        const pageId = safeRequestPageId(
          requestRecord,
          (page) => session.pageIds.get(page) ?? null,
        );
        const pageRecord = pageId ? (session.pages.get(pageId) ?? null) : null;
        const decision = assessUrl(
          requestRecord.url(),
          resolveRouteSecurityOptions(getSecurityOptions(), {
            trustedLocalhostPage: pageRecord?.trustedLocalhostMode ?? false,
          }),
        );
        if (!decision.allowed) {
          recordBlockedRequest(session, {
            timestamp: nowIso(),
            page_id: pageId,
            url: requestRecord.url(),
            resource_type: requestRecord.resourceType(),
            reason: [decision.reason, decision.hint].filter(Boolean).join("\n"),
          });
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });

      context.on("page", (page) => {
        void registerPage(session, page);
      });

      const pageRecord = await createTrackedPage(session);
      sessions.set(session.id, session);

      const initialUrl = getStringArg(request.args, "url");
      if (initialUrl) {
        try {
          await gotoWithSafety(
            session,
            pageRecord,
            initialUrl,
            "domcontentloaded",
            DEFAULT_NAVIGATION_TIMEOUT_MS,
          );
        } catch (error) {
          sessions.delete(session.id);
          await closeSession(session);
          throw error;
        }
      }

      const pages = await listPages(session);
      const activePage = session.activePageId ? getPageRecord(session, session.activePageId) : null;
      return respond(request, {
        session_id: session.id,
        browser: session.browserEngine,
        headless: session.headless,
        created_at: session.createdAt,
        active_page_id: activePage?.id ?? null,
        pages,
        artifact_dir: relativeFromWorkspace(ARTIFACT_ROOT),
        storage_state_dir: STORAGE_STATE_RELATIVE_DIR,
        mounted_storage_state: storageStateSummaryPayload(session.mountedStorageState),
        browser_binary: session.browserBinary,
        safety: {
          ...getSecurityOptions(),
          localhost_direct_navigation: true,
          localhost_subrequests_require_trusted_page: true,
        },
        trust_boundary: buildBrowserTrustBoundaryNotes({
          mountedStorageStatePath: session.mountedStorageState?.path ?? null,
        }),
      });
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  async function executeInfo(request: BrowserToolRequest) {
    await cleanupExpiredSessions();
    const topic = getStringArg(request.args, "topic");
    if (!request.sessionId || topic) {
      return respond(request, buildBrowserDiscovery(topic));
    }

    const session = getSessionOrThrow(sessions, requireSessionId(request));
    const pages = await listPages(session);
    return respond(request, {
      session_id: session.id,
      browser: session.browserEngine,
      headless: session.headless,
      created_at: session.createdAt,
      last_activity_at: session.lastActivityAt,
      active_page_id: session.activePageId,
      page_count: pages.length,
      pages,
      mounted_storage_state: storageStateSummaryPayload(session.mountedStorageState),
      browser_binary: session.browserBinary,
      storage_state_dir: STORAGE_STATE_RELATIVE_DIR,
      network_summary: session.networkSummary,
      recent_console: session.consoleEntries,
      blocked_requests: session.blockedRequests,
      trust_boundary: buildBrowserTrustBoundaryNotes({
        mountedStorageStatePath: session.mountedStorageState?.path ?? null,
      }),
    });
  }

  async function executeNavigate(request: BrowserToolRequest, signal: AbortSignal | undefined) {
    if (signal?.aborted) throw new Error("Cancelled before navigation.");
    await cleanupExpiredSessions();
    const session = getSessionOrThrow(sessions, requireSessionId(request));
    const waitUntil = normalizeWaitUntil(getStringArg(request.args, "wait_until"));
    const timeoutMs = getNumberArg(request.args, "timeout_ms") ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    const pageRecord = getBooleanArg(request.args, "new_tab")
      ? await createTrackedPage(session)
      : await resolvePageRecord(session, request.pageId, true);

    await gotoWithSafety(
      session,
      pageRecord,
      requireStringArg(request.args, "url"),
      waitUntil,
      timeoutMs,
    );

    return respond(request, {
      session_id: session.id,
      page: await buildPageSummary(session, pageRecord),
    });
  }

  async function executeSnapshot(request: BrowserToolRequest) {
    await cleanupExpiredSessions();
    const session = getSessionOrThrow(sessions, requireSessionId(request));
    const pageRecord = await resolvePageRecord(session, request.pageId, false);
    const inspection = await buildPageInspection(pageRecord);

    return respond(request, {
      session_id: session.id,
      page_id: pageRecord.id,
      ...inspection,
    });
  }

  async function executeExtract(request: BrowserToolRequest) {
    await cleanupExpiredSessions();
    const session = getSessionOrThrow(sessions, requireSessionId(request));
    const pageRecord = await resolvePageRecord(session, request.pageId, false);
    const page = pageRecord.page;
    const maxItems = getNumberArg(request.args, "max_items") ?? 5;
    const selector = getStringArg(request.args, "selector");
    const attribute = getStringArg(request.args, "attribute");

    const result: {
      session_id: string;
      page_id: string;
      selector: string | null;
      attribute: string | null;
      url: string;
      title: string | null;
      text: string | null;
      match_count: number | null;
      items: BrowserJsonObject[];
      truncated: boolean;
    } = {
      session_id: session.id,
      page_id: pageRecord.id,
      selector: selector ?? null,
      attribute: attribute ?? null,
      url: page.url(),
      title: await safeTitle(page),
      text: null,
      match_count: null,
      items: [],
      truncated: false,
    };

    if (!selector) {
      const text = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      result.text = truncateText(text, MAX_SNAPSHOT_TEXT_CHARS, 180);
    } else {
      const extracted = await collectElements(page.locator(selector), maxItems, attribute);
      result.match_count = extracted.count;
      result.items = extracted.items;
      result.truncated = extracted.truncated;
    }

    return respond(request, result);
  }

  async function executeClick(request: BrowserToolRequest, signal: AbortSignal | undefined) {
    if (signal?.aborted) throw new Error("Cancelled before click.");
    await cleanupExpiredSessions();
    const session = getSessionOrThrow(sessions, requireSessionId(request));
    const pageRecord = await resolvePageRecord(session, request.pageId, false);
    const timeoutMs = getNumberArg(request.args, "timeout_ms") ?? DEFAULT_TIMEOUT_MS;
    const selector = requireStringArg(request.args, "selector");
    const page = pageRecord.page;
    const locator = page.locator(selector).first();
    const previousUrl = page.url();
    const blockedCountBefore = session.blockedRequests.length;

    await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
    if (getBooleanArg(request.args, "double_click")) {
      await locator.dblclick({ timeout: timeoutMs });
    } else {
      await locator.click({ timeout: timeoutMs });
    }
    await waitForPossibleNavigation(page, previousUrl, timeoutMs);

    const activePage = await resolvePageRecord(
      session,
      session.activePageId ?? pageRecord.id,
      false,
    );
    const blockedRequest =
      session.blockedRequests.length > blockedCountBefore
        ? session.blockedRequests[session.blockedRequests.length - 1]
        : null;
    return respond(request, {
      session_id: session.id,
      clicked_selector: selector,
      previous_url: previousUrl,
      active_page: await buildPageSummary(session, activePage),
      blocked_request: blockedRequest,
    });
  }

  async function executeFill(request: BrowserToolRequest, signal: AbortSignal | undefined) {
    if (signal?.aborted) throw new Error("Cancelled before fill.");
    await cleanupExpiredSessions();
    const session = getSessionOrThrow(sessions, requireSessionId(request));
    const pageRecord = await resolvePageRecord(session, request.pageId, false);
    const timeoutMs = getNumberArg(request.args, "timeout_ms") ?? DEFAULT_TIMEOUT_MS;
    const selector = requireStringArg(request.args, "selector");
    const value = requireStringArg(request.args, "value");
    const locator = pageRecord.page.locator(selector).first();

    await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
    await locator.fill(value, { timeout: timeoutMs });
    touchPage(pageRecord);

    return respond(request, {
      session_id: session.id,
      page_id: pageRecord.id,
      selector,
      value_length: value.length,
      url: pageRecord.page.url(),
      title: await safeTitle(pageRecord.page),
    });
  }

  async function executePress(request: BrowserToolRequest, signal: AbortSignal | undefined) {
    if (signal?.aborted) throw new Error("Cancelled before key press.");
    await cleanupExpiredSessions();
    const session = getSessionOrThrow(sessions, requireSessionId(request));
    const pageRecord = await resolvePageRecord(session, request.pageId, false);
    const timeoutMs = getNumberArg(request.args, "timeout_ms") ?? DEFAULT_TIMEOUT_MS;
    const previousUrl = pageRecord.page.url();
    const blockedCountBefore = session.blockedRequests.length;
    const key = requireStringArg(request.args, "key");
    const selector = getStringArg(request.args, "selector");

    if (selector) {
      const locator = pageRecord.page.locator(selector).first();
      await locator.press(key, { timeout: timeoutMs });
    } else {
      await pageRecord.page.keyboard.press(key);
    }

    await waitForPossibleNavigation(pageRecord.page, previousUrl, timeoutMs);
    touchPage(pageRecord);
    const blockedRequest =
      session.blockedRequests.length > blockedCountBefore
        ? session.blockedRequests[session.blockedRequests.length - 1]
        : null;
    return respond(request, {
      session_id: session.id,
      page_id: pageRecord.id,
      selector: selector ?? null,
      key,
      previous_url: previousUrl,
      url: pageRecord.page.url(),
      title: await safeTitle(pageRecord.page),
      blocked_request: blockedRequest,
    });
  }

  async function executeWait(request: BrowserToolRequest, signal: AbortSignal | undefined) {
    if (signal?.aborted) throw new Error("Cancelled before wait.");
    await cleanupExpiredSessions();
    const session = getSessionOrThrow(sessions, requireSessionId(request));
    const pageRecord = await resolvePageRecord(session, request.pageId, false);
    const page = pageRecord.page;
    const timeoutMs = getNumberArg(request.args, "timeout_ms") ?? DEFAULT_TIMEOUT_MS;
    const selector = getStringArg(request.args, "selector");
    const text = getStringArg(request.args, "text");
    const urlIncludes = getStringArg(request.args, "url_includes");
    const loadState = getStringArg(request.args, "load_state");
    const delayMs = getNumberArg(request.args, "delay_ms");
    let matched = "";

    if (selector) {
      await page.locator(selector).first().waitFor({ state: "visible", timeout: timeoutMs });
      matched = `selector:${selector}`;
    } else if (text) {
      await page.getByText(text, { exact: false }).first().waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
      matched = `text:${text}`;
    } else if (urlIncludes) {
      await page.waitForURL((current) => current.toString().includes(urlIncludes), {
        timeout: timeoutMs,
      });
      matched = `url_includes:${urlIncludes}`;
    } else if (loadState) {
      const normalized = normalizeWaitUntil(loadState);
      if (normalized === "commit") {
        await page.waitForURL(() => true, { timeout: timeoutMs, waitUntil: "commit" });
      } else {
        await page.waitForLoadState(normalized, { timeout: timeoutMs });
      }
      matched = `load_state:${loadState}`;
    } else if (delayMs) {
      await page.waitForTimeout(delayMs);
      matched = `delay_ms:${delayMs}`;
    } else {
      throw new Error(
        "wait action requires one of selector, text, url_includes, load_state, or delay_ms.",
      );
    }

    touchPage(pageRecord);
    return respond(request, {
      session_id: session.id,
      page_id: pageRecord.id,
      matched,
      url: page.url(),
      title: await safeTitle(page),
    });
  }

  async function executeScreenshot(request: BrowserToolRequest, signal: AbortSignal | undefined) {
    if (signal?.aborted) throw new Error("Cancelled before screenshot.");
    await cleanupExpiredSessions();
    await ensureArtifactsDir();
    const session = getSessionOrThrow(sessions, requireSessionId(request));
    const pageRecord = await resolvePageRecord(session, request.pageId, false);
    const page = pageRecord.page;
    const sessionArtifactDir = resolve(ARTIFACT_ROOT, session.id);
    await mkdir(sessionArtifactDir, { recursive: true });

    const timestamp = nowIso().replace(/[:.]/g, "-");
    const fileName = `${timestamp}-${sanitizeLabel(getStringArg(request.args, "label"))}.png`;
    const absolutePath = resolve(sessionArtifactDir, fileName);
    await page.screenshot({
      path: absolutePath,
      fullPage: getBooleanArg(request.args, "full_page") ?? false,
      type: "png",
    });
    touchPage(pageRecord);

    const artifactPath = relativeFromWorkspace(absolutePath);
    return respond(
      request,
      {
        session_id: session.id,
        page_id: pageRecord.id,
        path: artifactPath,
        url: page.url(),
        title: await safeTitle(page),
        timestamp: nowIso(),
        full_page: getBooleanArg(request.args, "full_page") ?? false,
      },
      [
        {
          kind: "screenshot",
          path: artifactPath,
        },
      ],
    );
  }

  async function executeTabs(request: BrowserToolRequest) {
    await cleanupExpiredSessions();
    const session = getSessionOrThrow(sessions, requireSessionId(request));
    const activatePageId = getStringArg(request.args, "activate_page_id");
    if (activatePageId) {
      getPageRecord(session, activatePageId);
      session.activePageId = activatePageId;
    }
    const pages = await listPages(session);
    return respond(request, {
      session_id: session.id,
      active_page_id: session.activePageId,
      page_count: pages.length,
      pages,
    });
  }

  async function executeClose(request: BrowserToolRequest) {
    await cleanupExpiredSessions();
    const session = getSessionOrThrow(sessions, requireSessionId(request));
    const closeSessionFlag = getBooleanArg(request.args, "close_session") ?? false;

    if (closeSessionFlag || !request.pageId) {
      await closeSession(session);
      sessions.delete(session.id);
      return respond(request, {
        session_id: session.id,
        closed: "session",
      });
    }

    const pageRecord = getPageRecord(session, request.pageId);
    await pageRecord.page.close();
    const remainingPages = await listPages(session);
    if (remainingPages.length === 0) {
      await closeSession(session);
      sessions.delete(session.id);
      return respond(request, {
        session_id: session.id,
        closed: "page",
        page_id: request.pageId,
        session_closed: true,
      });
    }

    return respond(request, {
      session_id: session.id,
      closed: "page",
      page_id: request.pageId,
      session_closed: false,
      active_page_id: session.activePageId,
      pages: remainingPages,
    });
  }

  async function executePlaywrightCommand(
    request: BrowserToolRequest,
    signal: AbortSignal | undefined,
  ) {
    switch (request.action) {
      case "start":
        return executeStart(request, signal);
      case "info":
        return executeInfo(request);
      case "navigate":
        return executeNavigate(request, signal);
      case "snapshot":
        return executeSnapshot(request);
      case "extract":
        return executeExtract(request);
      case "click":
        return executeClick(request, signal);
      case "fill":
        return executeFill(request, signal);
      case "press":
        return executePress(request, signal);
      case "wait":
        return executeWait(request, signal);
      case "screenshot":
        return executeScreenshot(request, signal);
      case "tabs":
        return executeTabs(request);
      case "close":
        return executeClose(request);
      default:
        throw new Error(
          `Unsupported playwright browser action \`${request.action}\`. Use one of: ${describeBrowserActions()}.`,
        );
    }
  }

  registerCommonHandlers();

  pi.registerTool({
    name: "browser",
    label: "Browser",
    description:
      "Playwright-first single browser tool. In this environment, use the browser tool without a backend override; the extension owns the runtime, proxy, socket, and session complexity behind one narrow interface.",
    promptSnippet:
      "Use the single browser tool for browsing in this environment. Defaults are compact CLI-style; pass args.format='json' or args.full=true for verbose details.",
    promptGuidelines: [
      "Prefer the single browser tool over many browser_* actions.",
      "Use action + args for action-specific fields; input_json is compatibility-only for older callers.",
      "Call browser with action='info' and no session_id for the action catalogue, or args.topic='<action>' for a compact action schema.",
      "Default visible output is terse CLI text; use args.format='json' (or args.f/args['-f']) or args.full=true (or args['--full']=true) for full envelope details.",
      "Omit backend for normal use here; Playwright is the supported local path in this Anthropic sandbox.",
      "Treat agent-browser as experimental and unavailable locally; daemon compatibility is not a supported path in this repo.",
      "Direct top-level localhost navigation is intentionally allowed for same-host local-app testing; treat it as local-power access, not a generic public-web sandbox.",
      "Only mount storage_state_name files when you intentionally trust that workspace-local auth material on the current host.",
    ],
    parameters: Type.Object({
      backend: Type.Optional(
        StringEnum(BROWSER_BACKEND_VALUES, {
          description:
            "Advanced/experimental backend override. Omit for the supported local Playwright path.",
        }),
      ),
      action: StringEnum(BROWSER_ACTION_VALUES, {
        description:
          "Typed browser action enum shared across backends: start, info, navigate, snapshot, extract, click, fill, press, wait, screenshot, tabs, close.",
      }),
      session_id: Type.Optional(
        Type.String({
          description:
            "Optional browser session_id for actions that operate on an existing session.",
        }),
      ),
      page_id: Type.Optional(
        Type.String({
          description: "Optional page_id for actions that target a specific page or tab.",
        }),
      ),
      args: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            "Preferred structured action payload. Use scalar fields such as url, selector, value, timeout_ms, label, full_page, or topic. Output controls: format='cli'|'json' (or f/'-f') and full=true (or '--full'). Call action='info' with args.topic='<action>' for help/schema discovery.",
        }),
      ),
      input_json: Type.Optional(
        Type.String({
          description:
            "Compatibility-only JSON string for older callers. Prefer args for new browser calls.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const request = parseBrowserToolRequest({
        backend: params.backend,
        action: params.action as BrowserAction,
        session_id: params.session_id,
        page_id: params.page_id,
        args: params.args,
        input_json: params.input_json,
      });

      if (request.backend === "agent-browser") {
        return buildAgentBrowserModeResult(request);
      }

      return executePlaywrightCommand(request, signal);
    },
  });
}
