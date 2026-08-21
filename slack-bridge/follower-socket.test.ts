import { describe, expect, it } from "vitest";
import { DEFAULT_SOCKET_PATH } from "./broker/client.js";
import { resolveFollowerBrokerSocketPath } from "./follower-socket.js";

describe("resolveFollowerBrokerSocketPath", () => {
  it("uses the default broker socket when no process override is configured", () => {
    expect(resolveFollowerBrokerSocketPath({})).toBe(DEFAULT_SOCKET_PATH);
    expect(resolveFollowerBrokerSocketPath({ PINET_SOCKET_PATH: "   " })).toBe(DEFAULT_SOCKET_PATH);
  });

  it("normalizes the process-scoped broker socket override", () => {
    expect(
      resolveFollowerBrokerSocketPath({ PINET_SOCKET_PATH: "  /tmp/pinet-custom.sock  " }),
    ).toBe("/tmp/pinet-custom.sock");
  });
});
