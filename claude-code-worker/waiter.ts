import * as net from "node:net";
import { splitJsonRpcLines } from "./broker-client.js";

/**
 * The waiter: connects to a follower bridge's per-session socket and blocks
 * until mesh messages are pending (or exit/timeout). Run in the background by
 * the Claude Code session — its exit is what wakes the conversation. Holds no
 * mesh state; the bridge owns everything.
 */

export const DEFAULT_WAIT_TIMEOUT_MS = 50 * 60 * 1000;

export interface WaiterOutcome {
  kind: "messages" | "exit" | "timeout" | "bridge-gone";
  text: string;
  exitCode: number;
}

export function interpretWaiterResponse(line: string): WaiterOutcome {
  let response: { pending?: number; summaries?: string[]; exit?: boolean };
  try {
    response = JSON.parse(line) as typeof response;
  } catch {
    return {
      kind: "bridge-gone",
      text: "PINET_BRIDGE_ERROR: unreadable response from the follower bridge; do not re-arm.",
      exitCode: 1,
    };
  }
  if (response.exit) {
    return {
      kind: "exit",
      text: "PINET_EXIT: the bridge has left the mesh. Do not re-arm the waiter.",
      exitCode: 0,
    };
  }
  const pending = response.pending ?? 0;
  const summaries = (response.summaries ?? []).map((s) => `  - ${s}`).join("\n");
  return {
    kind: "messages",
    text:
      `PINET_MESSAGES: ${pending} mesh message(s) pending — call pinet_read, handle them, ` +
      `reply with pinet_send, then re-arm this waiter.` +
      (summaries ? `\n${summaries}` : ""),
    exitCode: 0,
  };
}

export function runWaiter(options: {
  socketPath: string;
  timeoutMs?: number;
}): Promise<WaiterOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

  return new Promise<WaiterOutcome>((resolve) => {
    let settled = false;
    let buffer = "";
    const socket = net.createConnection({ path: options.socketPath });

    const finish = (outcome: WaiterOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      finish({
        kind: "timeout",
        text: "PINET_WAIT_TIMEOUT: no mesh messages arrived. Re-arm the waiter to keep following.",
        exitCode: 0,
      });
    }, timeoutMs);
    timer.unref?.();

    socket.on("connect", () => {
      socket.write(JSON.stringify({ method: "wait" }) + "\n");
    });

    socket.on("data", (chunk: Buffer) => {
      const { lines, rest } = splitJsonRpcLines(buffer + chunk.toString("utf-8"));
      buffer = rest;
      if (lines.length > 0) {
        finish(interpretWaiterResponse(lines[0]));
      }
    });

    const gone = () =>
      finish({
        kind: "bridge-gone",
        text:
          "PINET_BRIDGE_GONE: the follower bridge socket closed without a response " +
          "(session bridge stopped?). Do not re-arm; call pinet_follow to rejoin.",
        exitCode: 1,
      });
    socket.on("error", gone);
    socket.on("close", () => {
      if (!settled) gone();
    });
  });
}
