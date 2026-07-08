import * as crypto from "node:crypto";
import * as path from "node:path";
import type {
  AgentSessionKind,
  AgentSessionSearchInfo,
  AgentSessionSummary,
} from "./broker/types.js";

export interface ParsedPinetStableId {
  host: string | null;
  kind: AgentSessionKind;
  locator: string;
  hasPath: boolean;
}

export type PinetSessionFullDetails = AgentSessionSearchInfo & {
  session: AgentSessionSummary | null;
  jsonlPath?: string;
};

export interface PinetSessionCompactDetails {
  agentId: string;
  agentName: string;
  emoji: string;
  pid: number;
  status: AgentSessionSearchInfo["status"];
  health: "disconnected" | "live";
  session: string | null;
  sessionKind: AgentSessionKind | null;
  host: string | null;
  repo: string | null;
  branch: string | null;
  tmuxSession: string | null;
  lastSeen: string;
  disconnectedAt: string | null;
  relatedThreadIds: string[];
  matchedBy: string[];
}

function stableIdDigest(stableId: string): string {
  return crypto.createHash("sha256").update(stableId).digest("hex").slice(0, 12);
}

export function parsePinetStableId(
  stableId: string | null | undefined,
): ParsedPinetStableId | null {
  const value = stableId?.trim();
  if (!value) return null;

  const firstColon = value.indexOf(":");
  const secondColon = firstColon >= 0 ? value.indexOf(":", firstColon + 1) : -1;
  if (firstColon < 0 || secondColon < 0) {
    return { host: null, kind: "unknown", locator: value, hasPath: false };
  }

  const host = value.slice(0, firstColon) || null;
  const rawKind = value.slice(firstColon + 1, secondColon);
  const locator = value.slice(secondColon + 1);
  const kind: AgentSessionKind =
    rawKind === "session" || rawKind === "leaf" || rawKind === "cwd" || rawKind === "broker"
      ? rawKind
      : "unknown";
  return {
    host,
    kind,
    locator,
    hasPath: locator.startsWith("/") && (kind === "session" || kind === "cwd" || kind === "broker"),
  };
}

export function summarizePinetStableId(
  stableId: string | null | undefined,
): AgentSessionSummary | null {
  const value = stableId?.trim();
  if (!value) return null;
  const parsed = parsePinetStableId(value);
  const kind = parsed?.kind ?? "unknown";
  return {
    kind,
    ref: `${kind}:${stableIdDigest(value)}`,
    host: parsed?.host ?? null,
    hasPath: parsed?.hasPath ?? false,
  };
}

export function getPinetSessionPath(stableId: string | null | undefined): string | null {
  const parsed = parsePinetStableId(stableId);
  if (!parsed?.hasPath) return null;
  return parsed.locator;
}

export function getPinetSessionFilename(stableId: string | null | undefined): string | null {
  const sessionPath = getPinetSessionPath(stableId);
  return sessionPath ? path.basename(sessionPath) : null;
}

export function buildPinetSessionFullDetails(
  session: AgentSessionSearchInfo,
): PinetSessionFullDetails {
  const summary = summarizePinetStableId(session.stableId);
  const sessionPath = getPinetSessionPath(session.stableId);
  return {
    ...session,
    session: summary,
    ...(sessionPath ? { jsonlPath: sessionPath } : {}),
  };
}

export function buildPinetSessionCompactDetails(
  session: AgentSessionSearchInfo,
): PinetSessionCompactDetails {
  const summary = summarizePinetStableId(session.stableId);
  return {
    agentId: session.agentId,
    agentName: session.agentName,
    emoji: session.emoji,
    pid: session.pid,
    status: session.status,
    health: session.disconnectedAt ? "disconnected" : "live",
    session: summary?.ref ?? null,
    sessionKind: summary?.kind ?? null,
    host: summary?.host ?? null,
    repo: session.repo,
    branch: session.branch,
    tmuxSession: session.tmuxSession,
    lastSeen: session.lastSeen,
    disconnectedAt: session.disconnectedAt,
    relatedThreadIds: session.relatedThreadIds.slice(0, 5),
    matchedBy: session.matchedBy,
  };
}
