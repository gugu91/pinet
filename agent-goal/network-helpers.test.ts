import { once } from "node:events";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
  hasGoalNetworkFailure,
  parseGoalNetworkTarget,
  probeGoalNetwork,
} from "./network-helpers.js";

describe("goal network failure boundary", () => {
  it.each([
    "fetch failed",
    "ECONNRESET",
    "EAI_AGAIN",
    "ENETUNREACH",
    "connection refused",
    "socket hang up",
  ])("accepts exhausted connectivity failure %s", (errorMessage) => {
    expect(hasGoalNetworkFailure([{ role: "assistant", stopReason: "error", errorMessage }])).toBe(
      true,
    );
  });
  it.each([
    "401 unauthorized: fetch failed",
    "403 forbidden: ECONNRESET",
    "429 rate limit: fetch failed",
    "billing quota: ENETUNREACH",
    "invalid API key: fetch failed",
    "500 Internal Server Error",
    "model unavailable",
    "request aborted",
    "AbortError: fetch failed",
    "ECANCELED: ECONNRESET",
    "insufficient_quota: fetch failed",
    "rate_limit_exceeded: ECONNRESET",
    "OAuth authentication failed: fetch failed",
  ])("does not retry %s", (errorMessage) => {
    expect(hasGoalNetworkFailure([{ role: "assistant", stopReason: "error", errorMessage }])).toBe(
      false,
    );
  });
  it("uses only the last assistant and requires an error stop", () => {
    const failure = { role: "assistant", stopReason: "error", errorMessage: "fetch failed" };
    expect(hasGoalNetworkFailure([failure, { role: "assistant", stopReason: "stop" }])).toBe(false);
    expect(hasGoalNetworkFailure([{ ...failure, stopReason: "aborted" }])).toBe(false);
    expect(hasGoalNetworkFailure([{ ...failure, role: "toolResult" }])).toBe(false);
  });
  it("parses only configured HTTP endpoints, without exposing credentials or paths", () => {
    expect(parseGoalNetworkTarget("https://user:secret@example.com/v1?api_key=secret")).toEqual({
      hostname: "example.com",
      port: 443,
    });
    expect(parseGoalNetworkTarget("http://[::1]:11434/v1")).toEqual({
      hostname: "::1",
      port: 11434,
    });
    expect(parseGoalNetworkTarget("file:///tmp/key")).toBeUndefined();
    expect(parseGoalNetworkTarget("not a URL")).toBeUndefined();
    expect(parseGoalNetworkTarget(undefined)).toBeUndefined();
  });
  it("probes only TCP reachability and obeys cancellation", async () => {
    const server = createServer((socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const target = { hostname: "127.0.0.1", port: address.port };
    try {
      expect(await probeGoalNetwork(target, new AbortController().signal)).toBe(true);
      expect(await probeGoalNetwork(target, AbortSignal.abort())).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect(await probeGoalNetwork(target, new AbortController().signal)).toBe(false);
  });
});
