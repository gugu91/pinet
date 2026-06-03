import { execFileSync } from "node:child_process";

export type TmuxSessionPresenceStatus = "attached" | "detached" | "unknown";

export interface TmuxClientSnapshot {
  session: string;
  activityAtMs: number | null;
  controlMode: boolean;
}

export interface TmuxSessionSnapshot {
  session: string;
  attachedClientCount: number;
}

export interface TmuxSessionPresenceInfo {
  session: string;
  status: TmuxSessionPresenceStatus;
  attachedClientCount: number;
  interactiveClientCount: number;
  controlClientCount: number;
  recentInteractiveClientCount: number;
  latestClientActivityAt?: string;
  latestInteractiveClientActivityAt?: string;
  probedAt: string;
  error?: string;
}

export interface InspectTmuxPresenceDeps {
  execFileSync?: typeof execFileSync;
  now?: () => number;
}

export interface BrokerManagedTmuxPresenceTarget {
  id?: string;
  session: string;
  pid: number;
}

export const DEFAULT_RECENT_TMUX_CLIENT_ACTIVITY_MS = 5 * 60 * 1000;

const LIST_SESSIONS_FORMAT = "#{session_name}\t#{session_attached}";
const LIST_CLIENTS_FORMAT = "#{client_session}\t#{client_activity}\t#{client_control_mode}";
const LIST_PANES_FORMAT = "#{pane_pid}";

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (value == null || value.trim().length === 0) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function parseEpochSecondsMs(value: string | undefined): number | null {
  const parsed = parseNonNegativeInteger(value);
  return parsed == null ? null : parsed * 1000;
}

function parseTmuxBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function parseTmuxListSessions(output: string): TmuxSessionSnapshot[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [session, attached] = line.split("\t");
      if (!session || session.trim().length === 0) return [];
      const attachedClientCount = parseNonNegativeInteger(attached);
      if (attachedClientCount == null) return [];
      return [{ session, attachedClientCount }];
    });
}

export function parseTmuxListClients(output: string): TmuxClientSnapshot[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [session, activity, controlMode] = line.split("\t");
      if (!session || session.trim().length === 0) return [];
      return [
        {
          session,
          activityAtMs: parseEpochSecondsMs(activity),
          controlMode: parseTmuxBoolean(controlMode),
        },
      ];
    });
}

export function parseTmuxPanePids(output: string): number[] {
  return output
    .split(/\r?\n/u)
    .map((line) => parseNonNegativeInteger(line.trim()))
    .filter((pid): pid is number => pid != null && pid > 1);
}

export function summarizeTmuxSessionPresence(
  sessionNames: Iterable<string>,
  sessions: TmuxSessionSnapshot[],
  clients: TmuxClientSnapshot[],
  nowMs: number,
  recentActivityMs = DEFAULT_RECENT_TMUX_CLIENT_ACTIVITY_MS,
): Map<string, TmuxSessionPresenceInfo> {
  const probedAt = new Date(nowMs).toISOString();
  const allowedSessions = new Set(
    Array.from(sessionNames)
      .map((session) => session.trim())
      .filter((session) => session.length > 0),
  );
  const sessionsByName = new Map(sessions.map((session) => [session.session, session]));
  const clientsBySession = new Map<string, TmuxClientSnapshot[]>();

  for (const client of clients) {
    if (!allowedSessions.has(client.session)) continue;
    const existing = clientsBySession.get(client.session) ?? [];
    existing.push(client);
    clientsBySession.set(client.session, existing);
  }

  const result = new Map<string, TmuxSessionPresenceInfo>();
  for (const session of allowedSessions) {
    const snapshot = sessionsByName.get(session);
    if (!snapshot) {
      result.set(session, {
        session,
        status: "unknown",
        attachedClientCount: 0,
        interactiveClientCount: 0,
        controlClientCount: 0,
        recentInteractiveClientCount: 0,
        probedAt,
        error: "tmux_session_not_found",
      });
      continue;
    }

    const sessionClients = clientsBySession.get(session) ?? [];
    const interactiveClients = sessionClients.filter((client) => !client.controlMode);
    const controlClientCount = sessionClients.length - interactiveClients.length;
    const recentInteractiveClientCount = interactiveClients.filter(
      (client) => client.activityAtMs != null && nowMs - client.activityAtMs <= recentActivityMs,
    ).length;
    const latestClientActivityMs = Math.max(
      ...sessionClients.map((client) => client.activityAtMs ?? Number.NEGATIVE_INFINITY),
    );
    const latestInteractiveClientActivityMs = Math.max(
      ...interactiveClients.map((client) => client.activityAtMs ?? Number.NEGATIVE_INFINITY),
    );
    const attachedClientCount = Math.max(snapshot.attachedClientCount, sessionClients.length);

    result.set(session, {
      session,
      status: attachedClientCount > 0 ? "attached" : "detached",
      attachedClientCount,
      interactiveClientCount: interactiveClients.length,
      controlClientCount,
      recentInteractiveClientCount,
      ...(Number.isFinite(latestClientActivityMs)
        ? { latestClientActivityAt: new Date(latestClientActivityMs).toISOString() }
        : {}),
      ...(Number.isFinite(latestInteractiveClientActivityMs)
        ? {
            latestInteractiveClientActivityAt: new Date(
              latestInteractiveClientActivityMs,
            ).toISOString(),
          }
        : {}),
      probedAt,
    });
  }

  return result;
}

function buildUnknownPresenceInfo(
  session: string,
  nowMs: number,
  error: string,
): TmuxSessionPresenceInfo {
  return {
    session,
    status: "unknown",
    attachedClientCount: 0,
    interactiveClientCount: 0,
    controlClientCount: 0,
    recentInteractiveClientCount: 0,
    probedAt: new Date(nowMs).toISOString(),
    error,
  };
}

function buildUnknownPresence(
  sessionNames: Iterable<string>,
  nowMs: number,
  error: string,
): Map<string, TmuxSessionPresenceInfo> {
  return new Map(
    Array.from(sessionNames)
      .map((session) => session.trim())
      .filter((session) => session.length > 0)
      .map((session) => [session, buildUnknownPresenceInfo(session, nowMs, error)]),
  );
}

function normalizeSessionNames(sessionNames: Iterable<string>): string[] {
  return Array.from(
    new Set(
      Array.from(sessionNames)
        .map((session) => session.trim())
        .filter((session) => session.length > 0),
    ),
  );
}

function inspectAllowedTmuxSessions(
  allowedSessions: string[],
  deps: InspectTmuxPresenceDeps,
  verifiedPidsBySession?: Map<string, Set<number>>,
): Map<string, TmuxSessionPresenceInfo> {
  const nowMs = deps.now?.() ?? Date.now();
  if (allowedSessions.length === 0) return new Map();

  const exec = deps.execFileSync ?? execFileSync;
  const sessions: TmuxSessionSnapshot[] = [];
  const clients: TmuxClientSnapshot[] = [];
  const unverifiedSessions = new Set<string>();
  let failedSessionProbeCount = 0;

  for (const session of allowedSessions) {
    const verifiedPids = verifiedPidsBySession?.get(session);
    if (verifiedPids) {
      let panePids: number[];
      try {
        const panesOutput = exec("tmux", ["list-panes", "-t", session, "-F", LIST_PANES_FORMAT], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }) as string;
        panePids = parseTmuxPanePids(panesOutput);
      } catch {
        unverifiedSessions.add(session);
        continue;
      }
      if (!panePids.some((pid) => verifiedPids.has(pid))) {
        unverifiedSessions.add(session);
        continue;
      }
    }

    try {
      const sessionOutput = exec(
        "tmux",
        ["display-message", "-p", "-t", session, LIST_SESSIONS_FORMAT],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ) as string;
      sessions.push(...parseTmuxListSessions(sessionOutput));
    } catch {
      failedSessionProbeCount += 1;
      continue;
    }

    try {
      const clientsOutput = exec(
        "tmux",
        ["list-clients", "-t", session, "-F", LIST_CLIENTS_FORMAT],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ) as string;
      clients.push(...parseTmuxListClients(clientsOutput));
    } catch {
      // A session can exist with no attached clients; that is a detached session, not a failure.
    }
  }

  if (failedSessionProbeCount === allowedSessions.length && unverifiedSessions.size === 0) {
    return buildUnknownPresence(allowedSessions, nowMs, "tmux_probe_failed");
  }

  const result = summarizeTmuxSessionPresence(allowedSessions, sessions, clients, nowMs);
  const unverified = buildUnknownPresence(
    unverifiedSessions,
    nowMs,
    "tmux_session_not_verified_for_agent_pid",
  );
  for (const [session, presence] of unverified) {
    result.set(session, presence);
  }
  return result;
}

export function inspectTmuxSessionPresence(
  sessionNames: Iterable<string>,
  deps: InspectTmuxPresenceDeps = {},
): Map<string, TmuxSessionPresenceInfo> {
  return inspectAllowedTmuxSessions(normalizeSessionNames(sessionNames), deps);
}

export function inspectBrokerManagedTmuxSessionPresence(
  targets: Iterable<BrokerManagedTmuxPresenceTarget>,
  deps: InspectTmuxPresenceDeps = {},
): Map<string, TmuxSessionPresenceInfo> {
  const nowMs = deps.now?.() ?? Date.now();
  const exec = deps.execFileSync ?? execFileSync;
  const result = new Map<string, TmuxSessionPresenceInfo>();
  const verifiedKeysBySession = new Map<string, string[]>();
  const panePidsBySession = new Map<string, number[] | null>();

  for (const target of targets) {
    const session = target.session.trim();
    const key = target.id?.trim() || session;
    if (!session || !key || !Number.isInteger(target.pid) || target.pid <= 1) continue;

    let panePids = panePidsBySession.get(session);
    if (panePids === undefined) {
      try {
        const panesOutput = exec("tmux", ["list-panes", "-t", session, "-F", LIST_PANES_FORMAT], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }) as string;
        panePids = parseTmuxPanePids(panesOutput);
      } catch {
        panePids = null;
      }
      panePidsBySession.set(session, panePids);
    }

    if (panePids === null) {
      result.set(key, buildUnknownPresenceInfo(session, nowMs, "tmux_probe_failed"));
      continue;
    }

    if (!panePids.includes(target.pid)) {
      result.set(
        key,
        buildUnknownPresenceInfo(session, nowMs, "tmux_session_not_verified_for_agent_pid"),
      );
      continue;
    }

    const verifiedKeys = verifiedKeysBySession.get(session) ?? [];
    verifiedKeys.push(key);
    verifiedKeysBySession.set(session, verifiedKeys);
  }

  const verifiedPresenceBySession = inspectAllowedTmuxSessions([...verifiedKeysBySession.keys()], {
    ...deps,
    now: () => nowMs,
  });
  for (const [session, keys] of verifiedKeysBySession) {
    const presence =
      verifiedPresenceBySession.get(session) ??
      buildUnknownPresenceInfo(session, nowMs, "tmux_session_not_found");
    for (const key of keys) {
      result.set(key, presence);
    }
  }

  return result;
}
