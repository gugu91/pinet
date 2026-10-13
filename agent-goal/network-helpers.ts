import { connect } from "node:net";
import type { GoalProgressMessage } from "./progress.js";

export interface GoalNetworkTarget {
  hostname: string;
  port: number;
}

export function hasGoalNetworkFailure(messages: GoalProgressMessage[]): boolean {
  const message = [...messages].reverse().find((entry) => entry.role === "assistant");
  if (message?.stopReason !== "error" || !message.errorMessage) return false;
  const error = message.errorMessage;
  if (
    /\b(?:401|403|429)\b|unauthorized|forbidden|quota|billing|rate[_ -]?limit|authentication|authorization|oauth|invalid[_ -]?(?:api[_ -]?)?key|aborted|aborterror|cancelled|canceled|ECANCELED/i.test(
      error,
    )
  )
    return false;
  return /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b|fetch failed|socket hang up|network (?:error|request failed)|connection (?:reset|refused|timed out)/i.test(
    error,
  );
}

export function parseGoalNetworkTarget(baseUrl: string | undefined): GoalNetworkTarget | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return {
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    };
  } catch {
    return undefined;
  }
}

export function probeGoalNetwork(target: GoalNetworkTarget, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = connect({ host: target.hostname, port: target.port });
    const finish = (reachable: boolean): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      socket.destroy();
      resolve(reachable);
    };
    const cancel = (): void => finish(false);
    signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => finish(false), 4_000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
