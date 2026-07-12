// Pure, side-effect-free helpers for the live hibernation runtime adapters.
//
// These back the real `HibernationProcessController` / `HibernationTmuxController`
// (which shell out to `ps`, `kill`, `git`, and `tmux`) and the worker-side wake
// fence ingestion. Keeping the string/parse logic pure makes the security- and
// correctness-critical pieces (VCS identity derivation, wake-fence env parsing,
// resume-launcher construction) unit-testable without spawning processes.

import type { AgentRuntimeSpecInput } from "@pinet/broker-core/types";

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
 * Parse a canonical positive decimal safe integer, or null. Unlike
 * `Number.parseInt`, which silently coerces `"12abc"`→12, `" 12"`→12, `"+12"`→12
 * and accepts leading-zero forms, this accepts ONLY a bare run of decimal digits
 * with no sign, no leading zero, no surrounding whitespace, and a value within
 * the safe-integer range. A garbled or hostile fence value therefore fails
 * closed to an ordinary (fence-free) registration rather than silently
 * round-tripping a corrupted generation/token.
 */
function parseCanonicalPositiveInt(raw: string | undefined): number | null {
  if (raw == null || !/^[1-9][0-9]*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Parse a wake fence from a woken worker's environment (the boundary between the
 * respawn launcher and the follower's register RPC). Returns null unless ALL
 * required fields are present and well-formed — the numeric fence token and
 * reserved generation must be canonical positive decimal safe integers — so a
 * partial/garbled environment fails closed to an ordinary (fence-free)
 * registration rather than a malformed fenced one.
 */
export function parseWakeFenceEnv(env: Record<string, string | undefined>): WakeFence | null {
  const wakeLeaseId = env.PINET_WAKE_LEASE_ID?.trim();
  const reservationNonce = env.PINET_WAKE_RESERVATION_NONCE?.trim();
  const fenceToken = parseCanonicalPositiveInt(env.PINET_WAKE_FENCE_TOKEN);
  const reservedGeneration = parseCanonicalPositiveInt(env.PINET_WAKE_RESERVED_GENERATION);
  if (!wakeLeaseId || !reservationNonce) return null;
  if (fenceToken == null || reservedGeneration == null) return null;
  return { wakeLeaseId, fenceToken, reservedGeneration, reservationNonce };
}

/**
 * The broker-KNOWN, spawn-authored facts that compose a durable runtime spec.
 *
 * Every operational field here (the tmux socket/session/target the broker will
 * later kill and respawn into, the repo/cwd it runs `ps`/`kill`/`git` against)
 * MUST come from the broker's own spawn record — NEVER from worker-reported
 * registration metadata. A worker that could name another worker's tmux pane
 * would otherwise get the broker to checkpoint/kill/respawn THAT pane on its
 * behalf. The only field the worker's identity contributes is its stable id
 * (which embeds its own session path); authorization uses solely the
 * broker-derived {@link vcsIdentity}.
 */
export interface SpawnAuthoredRuntimeFacts {
  agentId: string;
  stableId: string;
  brokerOwnerId: string;
  cwd: string;
  repoRoot: string;
  worktreePath: string;
  tmuxSocket: string;
  tmuxSession: string;
  tmuxTarget: string;
  extensionEntryPath: string;
  /** Environment variable NAMES (never values) the launcher exports. */
  envAllowlist: string[];
  configFingerprint: string;
  expectedUser: string;
  launchSource: string;
  /** Broker-derived from the runtime's git remote — the ONLY authz identity. */
  vcsIdentity: string | null;
}

/**
 * Compose a durable {@link AgentRuntimeSpecInput} from broker-known spawn facts.
 *
 * Fails closed (returns null) when the identity is not a resumable Pi session
 * (`sessionResumeRef` cannot be derived) or any operational locator the broker
 * must act on (tmux socket/session/target, repo root) is missing — a spec that
 * could not be safely hibernated/woken is never recorded. `expectedHost` is
 * taken from the stable id's host prefix; `argv` mirrors the resume launch
 * (`pi -e <entry> --session <path>`) for provenance; the resume path itself is
 * only ever recovered from the redaction-safe `sessionResumeRef`.
 */
export function buildRuntimeSpecInput(
  facts: SpawnAuthoredRuntimeFacts,
): AgentRuntimeSpecInput | null {
  const sessionResumeRef = sessionResumeRefFromStableId(facts.stableId);
  if (!sessionResumeRef) return null;
  const resumePath = resumePathFromSessionRef(sessionResumeRef);
  if (!resumePath) return null;
  if (!facts.tmuxSocket || !facts.tmuxSession || !facts.tmuxTarget || !facts.repoRoot) return null;

  const expectedHost = parsePinetStableId(facts.stableId)?.host ?? "";
  const envAllowlist = Array.from(new Set(facts.envAllowlist.filter((name) => name.length > 0)));

  return {
    agentId: facts.agentId,
    stableId: facts.stableId,
    brokerOwnerId: facts.brokerOwnerId,
    cwd: facts.cwd || facts.repoRoot,
    repoRoot: facts.repoRoot,
    worktreePath: facts.worktreePath || facts.repoRoot,
    tmuxSocket: facts.tmuxSocket,
    tmuxSession: facts.tmuxSession,
    tmuxTarget: facts.tmuxTarget,
    executable: "pi",
    argv: ["-e", facts.extensionEntryPath, "--session", resumePath],
    envAllowlist,
    sessionResumeRef,
    configFingerprint: facts.configFingerprint || "unknown",
    expectedHost,
    expectedUser: facts.expectedUser,
    launchSource: facts.launchSource || "subtree-broker-tmux",
    vcsIdentity: facts.vcsIdentity,
  };
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
 *
 * The script is secret-bearing (it exports mesh/Slack credential VALUES), so it
 * removes its own file (`rm -f -- "$0"`) immediately before `exec`. The launcher
 * fd stays open across the unlink (POSIX keeps the inode until the fd closes),
 * so `exec pi` still runs, but no secret-bearing file lingers on the happy path.
 * The broker separately unlinks on the failure path (where the script never
 * ran) and materializes launchers only in a private, owner-only directory.
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
  // Self-delete the secret-bearing launcher before exec; the open fd survives the
  // unlink so `exec pi` still runs from the now-unnamed inode.
  lines.push(`rm -f -- "$0"`);
  lines.push(
    `exec pi -e ${shellQuote(input.extensionEntryPath)} --session ${shellQuote(input.sessionPath)}`,
  );
  lines.push("");
  return lines.join("\n");
}
