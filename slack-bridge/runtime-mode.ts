import type { SlackBridgeSettings } from "./helpers.js";

export type SlackBridgeRuntimeMode = "off" | "single" | "broker" | "follower";

export function normalizeSlackBridgeRuntimeMode(
  value: string | null | undefined,
): SlackBridgeRuntimeMode | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "single" ||
    normalized === "broker" ||
    normalized === "follower"
  ) {
    return normalized;
  }
  return null;
}

export function isPinetRuntimeMode(mode: SlackBridgeRuntimeMode): boolean {
  return mode === "broker" || mode === "follower";
}

export interface ResolveSlackBridgeStartupRuntimeModeOptions {
  brokerSocketExists?: boolean;
  brokerManagedFollowerLaunch?: boolean;
}

export function isBrokerManagedFollowerLaunch(env = process.env): boolean {
  if (env.PINET_BROKER_MANAGED !== "1") return false;
  if (env.PINET_LAUNCH_SOURCE === "broker-tmux") return true;
  if (env.PINET_LAUNCH_SOURCE === "subtree-broker-tmux") return true;
  return Boolean(env.PINET_SOCKET_PATH?.trim());
}

export function resolveSlackBridgeStartupRuntimeMode(
  settings: Pick<SlackBridgeSettings, "runtimeMode" | "autoConnect" | "autoFollow">,
  options: ResolveSlackBridgeStartupRuntimeModeOptions = {},
): SlackBridgeRuntimeMode {
  const explicitMode = normalizeSlackBridgeRuntimeMode(settings.runtimeMode);
  const brokerSocketExists = options.brokerSocketExists ?? true;

  if (options.brokerManagedFollowerLaunch) {
    if (explicitMode === "follower" || (!explicitMode && settings.autoFollow)) {
      return brokerSocketExists ? "follower" : "off";
    }
    return "off";
  }

  if (explicitMode) {
    if (explicitMode === "follower" && !brokerSocketExists) {
      return "off";
    }
    return explicitMode;
  }

  if (settings.autoFollow) {
    return brokerSocketExists ? "follower" : "off";
  }

  if (settings.autoConnect) {
    return "single";
  }

  return "off";
}
