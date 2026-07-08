export interface SlackPresenceDirectoryUser {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
  };
}

export interface SlackPresenceSnapshot {
  userId: string;
  userName: string;
  presence: string;
  dndEnabled: boolean;
  dndEndTs?: number;
  dndEndAt?: string;
  autoAway?: boolean;
  manualAway?: boolean;
  connectionCount?: number;
  lastActivity?: number;
  online?: boolean;
}

export type SlackPresenceTimestampValue = string | number | null | undefined;

export interface SlackDndInfoLike {
  dnd_enabled?: boolean | null;
  next_dnd_end_ts?: SlackPresenceTimestampValue;
  snooze_enabled?: boolean | null;
  snooze_endtime?: SlackPresenceTimestampValue;
}

export function stripSlackUserReference(value: string): string {
  const trimmed = value.trim();
  const mentionMatch = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mentionMatch?.[1]) {
    return mentionMatch[1];
  }
  return trimmed.replace(/^@/, "").trim();
}

export function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]{2,}$/i.test(stripSlackUserReference(value));
}

export function getBestSlackPresenceUserName(user: SlackPresenceDirectoryUser): string {
  const displayName = user.profile?.display_name?.trim();
  if (displayName) return displayName;

  const realName = user.real_name?.trim() ?? user.profile?.real_name?.trim();
  if (realName) return realName;

  const handle = user.name?.trim();
  if (handle) return handle;

  return user.id?.trim() || "unknown-user";
}

function normalizeLookupValue(value: string): string {
  return stripSlackUserReference(value).trim().toLowerCase();
}

export function findSlackPresenceDirectoryUser(
  users: SlackPresenceDirectoryUser[],
  identifier: string,
): SlackPresenceDirectoryUser | null {
  const normalized = normalizeLookupValue(identifier);
  if (!normalized) return null;

  for (const user of users) {
    if (user.deleted) continue;

    const candidates = [
      user.id,
      user.name,
      user.real_name,
      user.profile?.display_name,
      user.profile?.real_name,
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase());

    if (candidates.includes(normalized)) {
      return user;
    }
  }

  return null;
}

function parsePositiveTs(value: SlackPresenceTimestampValue): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

export function resolveSlackPresenceDndEndTs(dndInfo: SlackDndInfoLike): number | undefined {
  if (dndInfo.snooze_enabled === true) {
    return parsePositiveTs(dndInfo.snooze_endtime);
  }

  if (dndInfo.dnd_enabled === true) {
    return parsePositiveTs(dndInfo.next_dnd_end_ts);
  }

  return undefined;
}

export function formatSlackPresenceTimestamp(ts: number | undefined): string | undefined {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) {
    return undefined;
  }
  return new Date(ts * 1000).toISOString();
}

export function formatSlackPresenceLine(snapshot: SlackPresenceSnapshot): string {
  const segments = [`${snapshot.userName} (${snapshot.userId})`, `presence: ${snapshot.presence}`];

  if (snapshot.dndEnabled) {
    segments.push(
      snapshot.dndEndAt ? `DND: on until ${snapshot.dndEndAt}` : "DND: on (end time unknown)",
    );
  } else {
    segments.push("DND: off");
  }

  if (snapshot.online != null) {
    segments.push(`online: ${snapshot.online ? "yes" : "no"}`);
  }

  return segments.join(" | ");
}
