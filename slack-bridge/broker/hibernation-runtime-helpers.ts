// Pure, side-effect-free helpers for the live hibernation runtime adapters.
//
// These back the real `HibernationProcessController` / `HibernationTmuxController`
// (which shell out to `ps`, `kill`, `git`, and `tmux`) and the worker-side wake
// fence ingestion. Keeping the string/parse logic pure makes the security- and
// correctness-critical pieces (VCS identity derivation, wake-fence env parsing,
// resume-launcher construction) unit-testable without spawning processes.

import { parsePinetStableId } from "../pinet-session-formatting.js";

/** Single-quote a value for safe embedding in a POSIX shell launcher script. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Derive a canonical `owner/repo` VCS identity from a git remote URL. Supports
 * scp-style (`git@github.com:owner/repo.git`), URL (`https://host/owner/repo`,
 * `ssh://git@host/owner/repo`, `git://host/owner/repo`), and bare `owner/repo`
 * forms. Returns null when no `owner/repo` can be derived.
 *
 * This is the ONLY identity the repo allowlist authorizes against, and it is
 * derived from the runtime's actual git REMOTE — never from filesystem directory
 * names — so distinct roots that merely share their final path segments (or a
 * worktree vs. its clone) never collapse onto, or diverge from, one authorization
 * identity.
 */
export function deriveVcsIdentity(remoteUrl: string | null | undefined): string | null {
  const raw = remoteUrl?.trim();
  if (!raw) return null;
  // Normalize: drop a trailing `.git` and any trailing slashes.
  const normalized = raw.replace(/\.git$/i, "").replace(/\/+$/, "");

  let pathPart: string | null = null;
  const scp = /^[^@\s/]+@[^:\s/]+:(.+)$/.exec(normalized); // git@host:owner/repo
  const url = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(normalized); // scheme://host/owner/repo
  if (scp) {
    pathPart = scp[1];
  } else if (url) {
    pathPart = url[1];
  } else if (normalized.includes("/") && !normalized.includes(":")) {
    pathPart = normalized; // bare owner/repo (or deeper path)
  }
  if (!pathPart) return null;

  const segments = pathPart.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[segments.length - 2];
  const repo = segments[segments.length - 1];
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

/**
 * Parse resident set size (bytes) from `ps -o rss= -p <pid>` output. macOS/Linux
 * `ps` reports RSS in kibibytes; returns null when no numeric value is present
 * (e.g. the process already exited).
 */
export function parseRssBytesFromPs(psOutput: string | null | undefined): number | null {
  const match = /\d+/.exec(psOutput ?? "");
  if (!match) return null;
  const kib = Number.parseInt(match[0], 10);
  return Number.isFinite(kib) ? kib * 1024 : null;
}

/**
 * Build the broker-resolvable, redaction-safe session resume reference for a
 * worker from its stable id. A worker's stable id embeds the absolute path to
 * its Pi session `.jsonl` (`<host>:session:<path>`); the resume ref is stored as
 * `session:<path>` so `redactRuntimeSpec` digests it to `session:#<fingerprint>`
 * on every operator/JSON surface while the broker can still recover the path to
 * respawn `pi --session <path>`. Returns null for stable ids without a session
 * path (e.g. `cwd:`/`leaf:` kinds), which are not resumable.
 */
export function sessionResumeRefFromStableId(stableId: string | null | undefined): string | null {
  const parsed = parsePinetStableId(stableId);
  // Only the `session` kind carries a resumable Pi session `.jsonl`; `cwd`/`leaf`
  // stable ids also expose a filesystem locator but have no resumable session.
  if (!parsed || parsed.kind !== "session" || !parsed.hasPath) return null;
  return `session:${parsed.locator}`;
}

/** Recover the absolute session `.jsonl` path from a `session:<path>` resume ref. */
export function resumePathFromSessionRef(
  sessionResumeRef: string | null | undefined,
): string | null {
  const ref = sessionResumeRef?.trim();
  if (!ref) return null;
  const separator = ref.indexOf(":");
  if (separator <= 0) return null;
  if (ref.slice(0, separator) !== "session") return null;
  const path = ref.slice(separator + 1).trim();
  return path.length > 0 ? path : null;
}

/** The broker-issued wake fence a respawned runtime must echo back to register. */
export interface WakeFence {
  wakeLeaseId: string;
  fenceToken: number;
  reservedGeneration: number;
  reservationNonce: string;
}

export interface WakeFenceEnvInput extends WakeFence {
  correlationId: string;
}

/**
 * Environment variables the respawn launcher exports so the woken runtime can
 * present its single-use wake fence on registration. Ordinary (non-wake) spawns
 * never set these, so ordinary registration stays fence-free and backward
 * compatible.
 */
export function buildWakeFenceEnv(input: WakeFenceEnvInput): Record<string, string> {
  return {
    PINET_WAKE_LEASE_ID: input.wakeLeaseId,
    PINET_WAKE_FENCE_TOKEN: String(input.fenceToken),
    PINET_WAKE_RESERVED_GENERATION: String(input.reservedGeneration),
    PINET_WAKE_RESERVATION_NONCE: input.reservationNonce,
    PINET_WAKE_CORRELATION_ID: input.correlationId,
  };
}

/**
 * Parse a wake fence from a woken worker's environment (the boundary between the
 * respawn launcher and the follower's register RPC). Returns null unless ALL
 * required fields are present and well-formed, so a partial/garbled environment
 * fails closed to an ordinary (fence-free) registration rather than a malformed
 * fenced one.
 */
export function parseWakeFenceEnv(env: Record<string, string | undefined>): WakeFence | null {
  const wakeLeaseId = env.PINET_WAKE_LEASE_ID?.trim();
  const reservationNonce = env.PINET_WAKE_RESERVATION_NONCE?.trim();
  const fenceToken = Number.parseInt(env.PINET_WAKE_FENCE_TOKEN ?? "", 10);
  const reservedGeneration = Number.parseInt(env.PINET_WAKE_RESERVED_GENERATION ?? "", 10);
  if (!wakeLeaseId || !reservationNonce) return null;
  if (!Number.isInteger(fenceToken) || !Number.isInteger(reservedGeneration)) return null;
  return { wakeLeaseId, fenceToken, reservedGeneration, reservationNonce };
}

export interface ResumeLauncherInput {
  repoPath: string;
  /** Absolute path to the Pi session `.jsonl` to resume. */
  sessionPath: string;
  extensionEntryPath: string;
  /** Inherited env keys to re-export if present in the broker environment. */
  inheritedEnv: Record<string, string | undefined>;
  /** PINET_* launch env plus the wake-fence env for this attempt. */
  pinetEnv: Record<string, string>;
  nickname: string;
}

/**
 * Build the launcher script a wake attempt runs via `tmux respawn-pane` to bring
 * back the fenced runtime. It re-establishes the repo cwd and launch environment,
 * exports the wake fence, and resumes the exact session with `pi --session
 * <path>` (no startup prompt — the session already carries the worker's context;
 * injecting a prompt would append a spurious user turn). The woken Pi therefore
 * re-registers under the SAME stable id (same session path) and presents the
 * fence for atomic generation acceptance.
 */
export function buildResumeLauncherScript(input: ResumeLauncherInput): string {
  const lines: string[] = ["#!/bin/bash", "set -euo pipefail", `cd ${shellQuote(input.repoPath)}`];
  for (const [key, value] of Object.entries(input.inheritedEnv)) {
    if (value !== undefined && value !== "") lines.push(`export ${key}=${shellQuote(value)}`);
  }
  for (const [key, value] of Object.entries(input.pinetEnv)) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  lines.push(`export PI_NICKNAME=${shellQuote(input.nickname)}`);
  lines.push(
    `exec pi -e ${shellQuote(input.extensionEntryPath)} --session ${shellQuote(input.sessionPath)}`,
  );
  lines.push("");
  return lines.join("\n");
}
