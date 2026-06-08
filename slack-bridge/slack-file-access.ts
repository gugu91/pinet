import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { SlackResult } from "./slack-api.js";

export const DEFAULT_SLACK_FILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SLACK_FILE_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), "pi-slack-files");
const SLACK_FILE_DOWNLOAD_HOSTS = new Set([
  "files.slack.com",
  "files.slack-edge.com",
  "downloads.slack-edge.com",
]);

export interface SlackFileDescriptor {
  fileId: string;
  path: string;
  filename: string;
  mimetype?: string;
  filetype?: string;
  prettyType?: string;
  size: number;
  sha256: string;
  cacheDir: string;
  expiresAt: string;
  residualRisks: string[];
}

export interface SlackFileLookupContext {
  channelId?: string;
  threadTs?: string;
  messageTs?: string;
}

export interface SlackFileDownloadDeps {
  slack: (method: string, token: string, body?: Record<string, unknown>) => Promise<SlackResult>;
  token: string;
  fetchImpl?: (
    url: string,
    init: RequestInit,
  ) => Promise<
    Pick<Response, "ok" | "status" | "statusText" | "arrayBuffer" | "text"> & {
      body?: Response["body"];
    }
  >;
  now?: () => Date;
  cacheDir?: string;
  ttlMs?: number;
  maxBytes?: number;
}

interface SlackFileMetadata {
  id: string;
  filename: string;
  mimetype?: string;
  filetype?: string;
  prettyType?: string;
  size?: number;
  privateDownloadUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeFilename(filename: string): string {
  const base = [...path.basename(filename)]
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .trim();
  return base.length > 0 ? base : "slack-file";
}

function assertSafeSlackFileDownloadUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Slack file metadata returned an invalid private download URL.");
  }

  if (url.protocol !== "https:") {
    throw new Error("Slack file private download URL must use https.");
  }

  if (!SLACK_FILE_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error(`Slack file private download URL host is not allowed: ${url.hostname}`);
  }
}

function metadataFromSlackFile(value: unknown, expectedFileId: string): SlackFileMetadata | null {
  if (!isRecord(value)) return null;
  const id = getString(value, "id");
  if (id !== expectedFileId) return null;
  const privateDownloadUrl =
    getString(value, "url_private_download") ?? getString(value, "url_private");
  if (!privateDownloadUrl) return null;
  assertSafeSlackFileDownloadUrl(privateDownloadUrl);
  const filename = sanitizeFilename(
    getString(value, "name") ?? getString(value, "title") ?? `${expectedFileId}.bin`,
  );
  return {
    id,
    filename,
    ...(getString(value, "mimetype") ? { mimetype: getString(value, "mimetype") } : {}),
    ...(getString(value, "filetype") ? { filetype: getString(value, "filetype") } : {}),
    ...(getString(value, "pretty_type") ? { prettyType: getString(value, "pretty_type") } : {}),
    ...(getNumber(value, "size") != null ? { size: getNumber(value, "size") } : {}),
    privateDownloadUrl,
  };
}

function filesFromMessage(message: unknown): unknown[] {
  if (!isRecord(message) || !Array.isArray(message.files)) return [];
  return message.files;
}

function findFileInMessages(
  messages: unknown,
  fileId: string,
  messageTs?: string,
): SlackFileMetadata | null {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (messageTs && (!isRecord(message) || getString(message, "ts") !== messageTs)) continue;
    for (const file of filesFromMessage(message)) {
      const metadata = metadataFromSlackFile(file, fileId);
      if (metadata) return metadata;
    }
  }
  return null;
}

async function lookupSlackFileMetadata(
  fileId: string,
  context: SlackFileLookupContext,
  deps: SlackFileDownloadDeps,
): Promise<SlackFileMetadata> {
  if (context.channelId && context.threadTs) {
    const replies = await deps.slack("conversations.replies", deps.token, {
      channel: context.channelId,
      ts: context.threadTs,
      limit: 200,
    });
    const fromThread = findFileInMessages(replies.messages, fileId, context.messageTs);
    if (fromThread) return fromThread;
    throw new Error(
      context.messageTs
        ? `Slack file ${fileId} was not found on message ${context.messageTs} in thread ${context.threadTs}.`
        : `Slack file ${fileId} was not found in thread ${context.threadTs}.`,
    );
  }

  const info = await deps.slack("files.info", deps.token, { file: fileId });
  const metadata = metadataFromSlackFile(info.file, fileId);
  if (!metadata) {
    throw new Error(`Slack files.info did not return downloadable metadata for file ${fileId}.`);
  }
  return metadata;
}

async function readResponseBytesWithLimit(
  response: Pick<Response, "arrayBuffer"> & { body?: Response["body"] },
  maxBytes: number,
  fileId: string,
): Promise<Buffer> {
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(
            `Slack file ${fileId} download exceeded safe limit: ${total} bytes exceeds limit ${maxBytes}.`,
          );
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks, total);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `Slack file ${fileId} download exceeded safe limit: ${bytes.byteLength} bytes exceeds limit ${maxBytes}.`,
    );
  }
  return bytes;
}

async function cleanupSlackFileCache(
  cacheDir: string,
  nowMs: number,
  ttlMs: number,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(cacheDir, entry);
      try {
        const entryStat = await stat(entryPath);
        if (nowMs - entryStat.mtimeMs > ttlMs) {
          await rm(entryPath, { recursive: true, force: true });
        }
      } catch {
        // Best-effort cleanup only.
      }
    }),
  );
}

export async function fetchSlackFileToCache(
  fileId: string,
  context: SlackFileLookupContext,
  deps: SlackFileDownloadDeps,
): Promise<SlackFileDescriptor> {
  const trimmedFileId = fileId.trim();
  if (!trimmedFileId) {
    throw new Error("file_id is required.");
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now?.() ?? new Date();
  const ttlMs = deps.ttlMs ?? DEFAULT_SLACK_FILE_CACHE_TTL_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_SLACK_FILE_MAX_DOWNLOAD_BYTES;
  const cacheRoot = deps.cacheDir ?? DEFAULT_CACHE_DIR;
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await cleanupSlackFileCache(cacheRoot, now.getTime(), ttlMs);

  const metadata = await lookupSlackFileMetadata(trimmedFileId, context, deps);
  if (metadata.size != null && metadata.size > maxBytes) {
    throw new Error(
      `Slack file ${trimmedFileId} is too large to download safely: ${metadata.size} bytes exceeds limit ${maxBytes}.`,
    );
  }

  const response = await fetchImpl(metadata.privateDownloadUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${deps.token}` },
  });

  if (!response.ok) {
    const body = (await response.text()).trim();
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    throw new Error(
      `Slack file download failed (HTTP ${status}) for file ${trimmedFileId}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }

  const bytes = await readResponseBytesWithLimit(response, maxBytes, trimmedFileId);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const cacheDir = path.join(cacheRoot, `${trimmedFileId}-${sha256.slice(0, 12)}`);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const localPath = path.join(cacheDir, metadata.filename);
  await writeFile(localPath, bytes, { mode: 0o600 });
  const size = bytes.byteLength;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  return {
    fileId: trimmedFileId,
    path: localPath,
    filename: metadata.filename,
    ...(metadata.mimetype ? { mimetype: metadata.mimetype } : {}),
    ...(metadata.filetype ? { filetype: metadata.filetype } : {}),
    ...(metadata.prettyType ? { prettyType: metadata.prettyType } : {}),
    size,
    sha256,
    cacheDir,
    expiresAt,
    residualRisks: [
      "The local cached file contains Slack-hosted user content; inspect it only as needed and delete it sooner if it is sensitive.",
      "Cache cleanup is best-effort and TTL-based under the system temp directory.",
    ],
  };
}

export async function readCachedSlackFile(pathname: string): Promise<Buffer> {
  return readFile(pathname);
}
