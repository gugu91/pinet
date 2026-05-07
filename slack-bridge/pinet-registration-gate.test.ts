import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPinetRegistrationGate } from "./pinet-registration-gate.js";

function createContext(
  options: {
    hasUI?: boolean;
    sessionFile?: string;
    leafId?: string;
    parentSession?: string;
  } = {},
): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI: options.hasUI ?? true,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
      },
      notify: () => undefined,
      setStatus: () => undefined,
    },
    sessionManager: {
      getEntries: () => [],
      getHeader: () =>
        options.parentSession === undefined ? null : { parentSession: options.parentSession },
      getLeafId: () => options.leafId ?? "leaf-123",
      getSessionFile: () => options.sessionFile,
    },
  } as unknown as ExtensionContext;
}

describe("createPinetRegistrationGate", () => {
  it("starts unblocked and allows registration for normal interactive sessions", () => {
    const gate = createPinetRegistrationGate({
      getArgv: () => [],
      getStdinIsTTY: () => true,
      getStdoutIsTTY: () => true,
    });
    const ctx = createContext({ hasUI: true, sessionFile: "/tmp/session.json", leafId: "leaf-1" });

    expect(gate.isBlocked()).toBe(false);
    expect(gate.evaluateSessionStart(ctx)).toBe(false);
    expect(gate.isBlocked()).toBe(false);
    expect(() => gate.assertCanRegister()).not.toThrow();
  });

  it("blocks likely local subagent sessions and reports the registration reason", () => {
    const gate = createPinetRegistrationGate({
      getArgv: () => ["--mode", "json"],
      getStdinIsTTY: () => false,
      getStdoutIsTTY: () => false,
    });
    const ctx = createContext({ hasUI: false, sessionFile: undefined, leafId: "leaf-ephemeral" });

    expect(gate.evaluateSessionStart(ctx)).toBe(true);
    expect(gate.isBlocked()).toBe(true);
    expect(gate.getBlockReason()).toBe(
      "Pinet is disabled in local subagent sessions to avoid polluting the agent mesh.",
    );
    expect(() => gate.assertCanRegister()).toThrow(gate.getBlockReason());
  });

  it("allows normal continued sessions even when the session has parent lineage", () => {
    const gate = createPinetRegistrationGate({
      getArgv: () => ["--continue"],
      getStdinIsTTY: () => false,
      getStdoutIsTTY: () => false,
    });
    const ctx = createContext({
      hasUI: true,
      sessionFile: "/tmp/session.json",
      leafId: "leaf-2",
      parentSession: "parent-session-id",
    });

    expect(gate.evaluateSessionStart(ctx)).toBe(false);
    expect(gate.isBlocked()).toBe(false);
    expect(() => gate.assertCanRegister()).not.toThrow();
  });

  it("blocks parented headless sessions when evaluating the block state", () => {
    const gate = createPinetRegistrationGate({
      getArgv: () => ["--mode", "rpc"],
      getStdinIsTTY: () => false,
      getStdoutIsTTY: () => false,
    });
    const ctx = createContext({
      hasUI: false,
      sessionFile: "/tmp/session.json",
      leafId: "leaf-2",
      parentSession: "parent-session-id",
    });

    expect(gate.evaluateSessionStart(ctx)).toBe(true);
    expect(gate.isBlocked()).toBe(true);
  });

  it("blocks continued sessions when they still look like parented headless subagents", () => {
    const gate = createPinetRegistrationGate({
      getArgv: () => ["--continue", "--mode", "rpc"],
      getStdinIsTTY: () => false,
      getStdoutIsTTY: () => false,
    });
    const ctx = createContext({
      hasUI: true,
      sessionFile: "/tmp/session.json",
      leafId: "leaf-2",
      parentSession: "parent-session-id",
    });

    expect(gate.evaluateSessionStart(ctx)).toBe(true);
    expect(gate.isBlocked()).toBe(true);
  });

  it("resets the blocked state on shutdown", () => {
    const gate = createPinetRegistrationGate({
      getArgv: () => ["--mode", "json"],
      getStdinIsTTY: () => false,
      getStdoutIsTTY: () => false,
    });
    const blockedCtx = createContext({
      hasUI: false,
      sessionFile: undefined,
      leafId: "leaf-ephemeral",
    });
    const normalCtx = createContext({
      hasUI: true,
      sessionFile: "/tmp/session.json",
      leafId: "leaf-3",
    });

    expect(gate.evaluateSessionStart(blockedCtx)).toBe(true);
    gate.reset();

    expect(gate.isBlocked()).toBe(false);
    expect(() => gate.assertCanRegister()).not.toThrow();
    expect(gate.evaluateSessionStart(normalCtx)).toBe(false);
  });
});
