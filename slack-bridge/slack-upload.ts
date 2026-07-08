import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SlackResult } from "./slack-api.js";

const FILETYPE_ALIASES: Record<string, string> = {
  cjs: "javascript",
  htm: "html",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  md: "markdown",
  py: "python",
  rb: "ruby",
  sh: "shell",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
  zsh: "shell",
};

const DEFAULT_SNIPPET_TYPE = "text";
const MAX_SNIPPET_BYTES = 1_000_000;

export interface SlackUploadParams {
  content?: string;
  path?: string;
  filename?: string;
  filetype?: string;
  title?: string;
}

export interface PreparedSlackUpload {
  bytes: Buffer;
  byteLength: number;
  filename: string;
  title: string;
  filetype?: string;
  snippetType?: string;
  source: "content" | "path";
  resolvedPath?: string;
}

export interface SlackUploadMetadataPayload extends Record<string, unknown> {
  filename: string;
  length: number;
  snippet_type?: string;
}

export interface SlackCompleteUploadFilePayload {
  id: string;
  title: string;
}

export interface SlackCompleteUploadPayload extends Record<string, unknown> {
  files: SlackCompleteUploadFilePayload[];
  channel_id: string;
  thread_ts?: string;
  initial_comment?: string;
}

export type SlackUploadApiBody = SlackUploadMetadataPayload | SlackCompleteUploadPayload;

export interface SlackUploadDeps {
  slack: (method: string, token: string, body?: SlackUploadApiBody) => Promise<SlackResult>;
  token: string;
  fetchImpl?: (
    url: string,
    init: RequestInit,
  ) => Promise<Pick<Response, "ok" | "status" | "statusText" | "text">>;
}

export interface PerformSlackUploadOptions extends SlackUploadDeps {
  upload: PreparedSlackUpload;
  channelId: string;
  threadTs?: string;
  initialComment?: string;
}

export interface PerformSlackUploadsOptions extends SlackUploadDeps {
  uploads: readonly PreparedSlackUpload[];
  channelId: string;
  threadTs?: string;
  initialComment?: string;
}

export interface CompletedSlackUpload {
  fileId: string;
  response: SlackResult;
}

export interface CompletedSlackUploads {
  fileIds: string[];
  response: SlackResult;
}

interface PrepareSlackUploadFs {
  readFileImpl?: typeof readFile;
  realpathImpl?: typeof realpath;
  statImpl?: typeof stat;
}

export function inferSlackUploadFiletype(
  filename: string | undefined,
  explicitFiletype?: string,
): string | undefined {
  const raw = (explicitFiletype ?? path.extname(filename ?? "").slice(1)).trim().toLowerCase();
  if (!raw) return undefined;
  return FILETYPE_ALIASES[raw] ?? raw;
}

export function chooseSlackSnippetType(upload: {
  source: "content" | "path";
  byteLength: number;
  filename: string;
  filetype?: string;
}): string | undefined {
  if (upload.source !== "content") return undefined;
  if (upload.byteLength > MAX_SNIPPET_BYTES) return undefined;
  return normalizeSnippetType(inferSlackUploadFiletype(upload.filename, upload.filetype));
}

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function normalizeSnippetType(filetype: string | undefined): string {
  return filetype?.trim().toLowerCase() || DEFAULT_SNIPPET_TYPE;
}

function buildUploadMetadataPayload(
  upload: PreparedSlackUpload,
  includeSnippetType: boolean,
): SlackUploadMetadataPayload {
  return {
    filename: upload.filename,
    length: upload.byteLength,
    ...(includeSnippetType && upload.snippetType ? { snippet_type: upload.snippetType } : {}),
  };
}

function isInvalidUploadMetadataError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const lower = error.message.toLowerCase();
  return lower.includes("files.getuploadurlexternal") && lower.includes("invalid_arguments");
}

function formatUploadMetadataRetryError(
  upload: PreparedSlackUpload,
  retryError: unknown,
  originalError: unknown,
): Error {
  return new Error(
    `Slack files.getUploadURLExternal: invalid_arguments after retry without snippet_type; Slack rejected upload metadata for filename=${JSON.stringify(upload.filename)} byte_length=${upload.byteLength}. retry_error=${formatUploadError(retryError)}; original_error=${formatUploadError(originalError)}`,
  );
}

function getUploadHost(uploadUrl: string): string {
  try {
    return new URL(uploadUrl).hostname || "<unknown>";
  } catch {
    return "<unknown>";
  }
}

function formatUploadError(error: unknown): string {
  if (error instanceof Error) {
    if (typeof error.cause === "string") {
      return `${error.message}; cause: ${error.cause}`;
    }

    if (error.cause instanceof Error) {
      const cause = [
        error.cause.message,
        (error.cause as { code?: unknown }).code,
        error.cause.name,
      ]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join("; ");
      return cause ? `${error.message}; cause: ${cause}` : error.message;
    }

    return error.message;
  }

  return String(error);
}

function isLikelyProxyOrFirewallFailure(responseText: string, headers?: Headers): boolean {
  const headerText = [
    headers?.get("x-proxy-error"),
    headers?.get("x-proxy-status"),
    headers?.get("via"),
    headers?.get("server"),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const combined = `${responseText} ${headerText}`.toLowerCase();

  return /(blocked-by-allowlist|possible outbound proxy|blocked by proxy|proxy-firewall|firewall)/.test(
    combined,
  );
}
export async function resolveSlackUploadPath(
  inputPath: string,
  cwd: string,
  tmpdir: string,
  fsDeps: PrepareSlackUploadFs = {},
): Promise<string> {
  const { realpathImpl = realpath, statImpl = stat } = fsDeps;
  const requestedPath = inputPath.trim();
  if (!requestedPath) {
    throw new Error("path is required when uploading from a local file.");
  }

  const candidate = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(cwd, requestedPath);

  const [resolvedCandidate, resolvedCwd, resolvedTmpdir] = await Promise.all([
    realpathImpl(candidate),
    realpathImpl(cwd),
    realpathImpl(tmpdir),
  ]);

  if (
    !isWithinRoot(resolvedCandidate, resolvedCwd) &&
    !isWithinRoot(resolvedCandidate, resolvedTmpdir)
  ) {
    throw new Error(
      "For safety, the slack dispatcher upload action only allows local file paths inside the current working directory or the system temp directory. For other files, read the content explicitly and upload it via the content parameter.",
    );
  }

  const fileStats = await statImpl(resolvedCandidate);
  if (!fileStats.isFile()) {
    throw new Error(`Local upload path is not a file: ${requestedPath}`);
  }

  return resolvedCandidate;
}

export async function prepareSlackUpload(
  params: SlackUploadParams,
  cwd: string,
  tmpdir: string,
  fsDeps: PrepareSlackUploadFs = {},
): Promise<PreparedSlackUpload> {
  const { readFileImpl = readFile } = fsDeps;
  const hasContent = typeof params.content === "string";
  const hasPath = typeof params.path === "string" && params.path.trim().length > 0;

  if (hasContent === hasPath) {
    throw new Error("Provide exactly one of content or path.");
  }

  let bytes: Buffer;
  let filename = params.filename?.trim();
  let resolvedPath: string | undefined;
  let source: PreparedSlackUpload["source"];

  if (hasContent) {
    if (!filename) {
      throw new Error("filename is required when uploading inline content.");
    }
    bytes = Buffer.from(params.content ?? "", "utf8");
    source = "content";
  } else {
    resolvedPath = await resolveSlackUploadPath(params.path!, cwd, tmpdir, fsDeps);
    bytes = await readFileImpl(resolvedPath);
    filename = filename || path.basename(resolvedPath);
    source = "path";
  }

  const sanitizedFilename = filename?.trim();
  if (!sanitizedFilename) {
    throw new Error("filename is required.");
  }

  const filetype = inferSlackUploadFiletype(sanitizedFilename, params.filetype);
  const title = params.title?.trim() || sanitizedFilename;

  return {
    bytes,
    byteLength: bytes.byteLength,
    filename: sanitizedFilename,
    title,
    filetype,
    snippetType: chooseSlackSnippetType({
      source,
      byteLength: bytes.byteLength,
      filename: sanitizedFilename,
      filetype,
    }),
    source,
    ...(resolvedPath ? { resolvedPath } : {}),
  };
}

async function reserveAndUploadSlackFile(
  upload: PreparedSlackUpload,
  slack: SlackUploadDeps["slack"],
  token: string,
  fetchImpl: NonNullable<SlackUploadDeps["fetchImpl"]>,
): Promise<{ fileId: string; title: string }> {
  let getUploadResponse: SlackResult;
  try {
    getUploadResponse = await slack(
      "files.getUploadURLExternal",
      token,
      buildUploadMetadataPayload(upload, true),
    );
  } catch (error) {
    if (upload.snippetType && isInvalidUploadMetadataError(error)) {
      try {
        getUploadResponse = await slack(
          "files.getUploadURLExternal",
          token,
          buildUploadMetadataPayload(upload, false),
        );
      } catch (retryError) {
        if (isInvalidUploadMetadataError(retryError)) {
          throw formatUploadMetadataRetryError(upload, retryError, error);
        }
        throw retryError;
      }
    } else {
      throw error;
    }
  }

  const uploadUrl =
    typeof getUploadResponse.upload_url === "string" ? getUploadResponse.upload_url : null;
  const uploadHost = uploadUrl ? getUploadHost(uploadUrl) : "<unknown>";
  const fileId = typeof getUploadResponse.file_id === "string" ? getUploadResponse.file_id : null;
  if (!uploadUrl || !fileId) {
    throw new Error("Slack files.getUploadURLExternal did not return an upload URL and file ID.");
  }

  const rawBody = new Uint8Array(upload.bytes.byteLength);
  rawBody.set(upload.bytes);

  type RawUploadResponse = Pick<Response, "ok" | "status" | "statusText" | "text"> & {
    headers?: Headers;
  };
  let rawUploadResponse: RawUploadResponse;
  try {
    rawUploadResponse = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Length": String(upload.byteLength),
        "Content-Type":
          upload.source === "content" ? "text/plain; charset=utf-8" : "application/octet-stream",
      },
      body: new Blob([rawBody]),
    });
  } catch (error) {
    throw new Error(
      `Slack raw upload failed (transport): ${formatUploadError(error)}; host=${uploadHost}; filename=${upload.filename} byte_length=${upload.byteLength}`,
    );
  }

  if (!rawUploadResponse.ok) {
    const details = (await rawUploadResponse.text()).trim();
    const statusText = rawUploadResponse.statusText;
    const statusTextForHeader = statusText ? ` ${statusText}` : "";
    const withDetails =
      details.length > 0 ? `${statusText ? `${statusText}: ` : ""}${details}` : "";
    const rawUploadResponseHeaders =
      rawUploadResponse.headers instanceof Headers ? rawUploadResponse.headers : undefined;
    const isProxyOrFirewallFailure = isLikelyProxyOrFirewallFailure(
      details,
      rawUploadResponseHeaders,
    );
    const hint = isProxyOrFirewallFailure ? " [possible outbound proxy/firewall block]" : "";
    throw new Error(
      `Slack raw upload failed (HTTP ${rawUploadResponse.status}${statusTextForHeader})${withDetails ? ` ${withDetails}` : ""}${hint}; host=${uploadHost}; filename=${upload.filename} byte_length=${upload.byteLength}`,
    );
  }

  return { fileId, title: upload.title };
}

export async function performSlackUploads({
  uploads,
  channelId,
  threadTs,
  initialComment,
  slack,
  token,
  fetchImpl = fetch,
}: PerformSlackUploadsOptions): Promise<CompletedSlackUploads> {
  if (uploads.length === 0) {
    throw new Error("At least one upload is required.");
  }

  const files: Array<{ fileId: string; title: string }> = [];
  for (const upload of uploads) {
    files.push(await reserveAndUploadSlackFile(upload, slack, token, fetchImpl));
  }

  const response = await slack("files.completeUploadExternal", token, {
    files: files.map((file) => ({ id: file.fileId, title: file.title })),
    channel_id: channelId,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(initialComment ? { initial_comment: initialComment } : {}),
  });

  return { fileIds: files.map((file) => file.fileId), response };
}

export async function performSlackUpload({
  upload,
  channelId,
  threadTs,
  initialComment,
  slack,
  token,
  fetchImpl = fetch,
}: PerformSlackUploadOptions): Promise<CompletedSlackUpload> {
  const { fileIds, response } = await performSlackUploads({
    uploads: [upload],
    channelId,
    ...(threadTs ? { threadTs } : {}),
    ...(initialComment ? { initialComment } : {}),
    slack,
    token,
    fetchImpl,
  });
  const fileId = fileIds[0];
  if (!fileId) {
    throw new Error("Slack upload did not return a file ID.");
  }
  return { fileId, response };
}
