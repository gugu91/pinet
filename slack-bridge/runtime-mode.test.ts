import { describe, expect, it } from "vitest";
import {
  isBrokerManagedFollowerLaunch,
  isPinetRuntimeMode,
  normalizeSlackBridgeRuntimeMode,
  resolveSlackBridgeStartupRuntimeMode,
} from "./runtime-mode.js";

describe("normalizeSlackBridgeRuntimeMode", () => {
  it("accepts the supported runtime modes", () => {
    expect(normalizeSlackBridgeRuntimeMode("off")).toBe("off");
    expect(normalizeSlackBridgeRuntimeMode("single")).toBe("single");
    expect(normalizeSlackBridgeRuntimeMode("broker")).toBe("broker");
    expect(normalizeSlackBridgeRuntimeMode("follower")).toBe("follower");
  });

  it("normalizes casing and whitespace", () => {
    expect(normalizeSlackBridgeRuntimeMode("  SINGLE ")).toBe("single");
  });

  it("rejects unsupported values", () => {
    expect(normalizeSlackBridgeRuntimeMode("standalone")).toBeNull();
    expect(normalizeSlackBridgeRuntimeMode(undefined)).toBeNull();
  });
});

describe("isPinetRuntimeMode", () => {
  it("identifies broker and follower as Pinet runtimes", () => {
    expect(isPinetRuntimeMode("broker")).toBe(true);
    expect(isPinetRuntimeMode("follower")).toBe(true);
    expect(isPinetRuntimeMode("single")).toBe(false);
    expect(isPinetRuntimeMode("off")).toBe(false);
  });
});

describe("isBrokerManagedFollowerLaunch", () => {
  it("detects broker-managed tmux follower launches", () => {
    expect(
      isBrokerManagedFollowerLaunch({
        PINET_BROKER_MANAGED: "1",
        PINET_LAUNCH_SOURCE: "broker-tmux",
      }),
    ).toBe(true);
  });

  it("does not treat other broker-managed metadata as the tmux follower path", () => {
    expect(
      isBrokerManagedFollowerLaunch({
        PINET_BROKER_MANAGED: "1",
        PINET_LAUNCH_SOURCE: "manual",
      }),
    ).toBe(false);
  });
});

describe("resolveSlackBridgeStartupRuntimeMode", () => {
  it("defaults to off", () => {
    expect(resolveSlackBridgeStartupRuntimeMode({})).toBe("off");
  });

  it("treats autoConnect as the legacy single-player alias", () => {
    expect(resolveSlackBridgeStartupRuntimeMode({ autoConnect: true })).toBe("single");
  });

  it("treats autoFollow as the legacy follower alias when a broker socket exists", () => {
    expect(
      resolveSlackBridgeStartupRuntimeMode({ autoFollow: true }, { brokerSocketExists: true }),
    ).toBe("follower");
  });

  it("keeps follower startup off when the broker socket is unavailable", () => {
    expect(
      resolveSlackBridgeStartupRuntimeMode({ autoFollow: true }, { brokerSocketExists: false }),
    ).toBe("off");
  });

  it("prefers explicit runtimeMode over legacy compatibility flags", () => {
    expect(
      resolveSlackBridgeStartupRuntimeMode(
        { runtimeMode: "single", autoFollow: true, autoConnect: true },
        { brokerSocketExists: true },
      ),
    ).toBe("single");
  });

  it("keeps explicit off truly off even when legacy auto flags are set", () => {
    expect(
      resolveSlackBridgeStartupRuntimeMode(
        { runtimeMode: "off", autoFollow: true, autoConnect: true },
        { brokerSocketExists: true },
      ),
    ).toBe("off");
  });

  it("allows explicit broker mode at startup", () => {
    expect(resolveSlackBridgeStartupRuntimeMode({ runtimeMode: "broker" })).toBe("broker");
  });

  it("keeps broker-managed follower launches off even when persistent settings request broker mode", () => {
    expect(
      resolveSlackBridgeStartupRuntimeMode(
        { runtimeMode: "broker" },
        { brokerSocketExists: true, brokerManagedFollowerLaunch: true },
      ),
    ).toBe("off");
  });

  it("keeps broker-managed follower launches off when legacy autoConnect would start single-player mode", () => {
    expect(
      resolveSlackBridgeStartupRuntimeMode(
        { autoConnect: true },
        { brokerSocketExists: true, brokerManagedFollowerLaunch: true },
      ),
    ).toBe("off");
  });

  it("still honors follower opt-in for broker-managed launches when a broker socket exists", () => {
    expect(
      resolveSlackBridgeStartupRuntimeMode(
        { runtimeMode: "follower" },
        { brokerSocketExists: true, brokerManagedFollowerLaunch: true },
      ),
    ).toBe("follower");
  });

  it("downgrades explicit follower mode to off when no broker socket exists", () => {
    expect(
      resolveSlackBridgeStartupRuntimeMode(
        { runtimeMode: "follower" },
        { brokerSocketExists: false },
      ),
    ).toBe("off");
  });
});
