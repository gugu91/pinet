import type { SlackBridgeSettings } from "./helpers.js";

export interface ResolvedHibernationSettings {
  enabled: boolean;
  /** Phase B live-runtime activation gate (default false; ANDed with `enabled`). */
  activateRuntimeAdapters: boolean;
  mode: "observe" | "manual" | "auto";
  allowedRepos: string[];
  graceMs: number;
  idleDebounceMs: number;
  handshakeTimeoutMs: number;
  wakeLeaseMs: number;
  maxConcurrentWakes: number;
  maxConcurrentWakesPerRepo: number;
}

export function resolveHibernationSettings(
  settings: Pick<SlackBridgeSettings, "hibernation">,
): ResolvedHibernationSettings {
  const value = settings.hibernation;
  return {
    enabled: value?.enabled === true,
    activateRuntimeAdapters: value?.activateRuntimeAdapters === true,
    mode: value?.mode ?? "observe",
    allowedRepos: [...(value?.allowedRepos ?? [])],
    graceMs: value?.graceMs ?? 60 * 60_000,
    idleDebounceMs: value?.idleDebounceMs ?? 2 * 60_000,
    handshakeTimeoutMs: value?.handshakeTimeoutMs ?? 30_000,
    wakeLeaseMs: value?.wakeLeaseMs ?? 90_000,
    maxConcurrentWakes: value?.maxConcurrentWakes ?? 2,
    maxConcurrentWakesPerRepo: value?.maxConcurrentWakesPerRepo ?? 1,
  };
}
