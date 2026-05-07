import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSessionUiRuntime, type SessionUiRuntimeDeps } from "./session-ui-runtime.js";

function createContext(
  options: {
    hasUI?: boolean;
    idle?: boolean;
    onTerminalInput?: (
      handler: (data: string) => { consume?: boolean; data?: string } | undefined,
    ) => () => void;
  } = {},
) {
  const setStatus = vi.fn();
  const notify = vi.fn();
  const ctx = {
    cwd: process.cwd(),
    hasUI: options.hasUI ?? true,
    isIdle: () => options.idle ?? true,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
      },
      notify,
      setStatus,
      ...(options.onTerminalInput ? { onTerminalInput: options.onTerminalInput } : {}),
    },
    sessionManager: {
      getEntries: () => [],
      getHeader: () => null,
      getLeafId: () => "leaf-123",
      getSessionFile: () => "/tmp/session-ui-runtime.json",
    },
  } as unknown as ExtensionContext;

  return { ctx, setStatus, notify };
}

function createDeps(overrides: Partial<SessionUiRuntimeDeps> = {}) {
  const drainInbox = vi.fn();

  const deps: SessionUiRuntimeDeps = {
    getAgentName: () => "Cobalt Olive Crane",
    getAgentEmoji: () => "🦩",
    getInboxLength: () => 0,
    drainInbox,
    ...overrides,
  };

  return { deps, drainInbox };
}

describe("createSessionUiRuntime", () => {
  it("updates the unread badge using the cached extension context", () => {
    const { deps } = createDeps({
      getInboxLength: () => 3,
    });
    const runtime = createSessionUiRuntime(deps);
    const { ctx, setStatus } = createContext();

    runtime.setExtCtx(ctx);
    runtime.updateBadge();

    expect(setStatus).toHaveBeenCalledWith("slack-bridge", "🦩 Cobalt Olive Crane ✦ 3");
  });

  it("renders reconnecting/error/off states and delegates ok back through the badge", () => {
    const { deps } = createDeps({
      getInboxLength: () => 2,
    });
    const runtime = createSessionUiRuntime(deps);
    const { ctx, setStatus } = createContext();

    runtime.setExtStatus(ctx, "reconnecting");
    runtime.setExtStatus(ctx, "error");
    runtime.setExtStatus(ctx, "off");
    runtime.setExtStatus(ctx, "ok");

    expect(setStatus).toHaveBeenNthCalledWith(1, "slack-bridge", "🦩 Cobalt Olive Crane ⟳");
    expect(setStatus).toHaveBeenNthCalledWith(2, "slack-bridge", "🦩 Cobalt Olive Crane ✗");
    expect(setStatus).toHaveBeenNthCalledWith(3, "slack-bridge", "");
    expect(setStatus).toHaveBeenNthCalledWith(4, "slack-bridge", "🦩 Cobalt Olive Crane ✦ 2");
  });

  it("gates idle inbox draining while Escape suppression is active", () => {
    const { deps, drainInbox } = createDeps();
    const runtime = createSessionUiRuntime(deps);
    const { ctx } = createContext({ idle: true });

    expect(runtime.maybeDrainInboxIfIdle(ctx)).toBe(true);
    expect(drainInbox).toHaveBeenCalledTimes(1);

    runtime.notePotentialInterruptInput("\u001b");
    expect(runtime.shouldSuppressAutomaticInboxDrain(Date.now())).toBe(true);
    expect(runtime.maybeDrainInboxIfIdle(ctx)).toBe(false);
    expect(drainInbox).toHaveBeenCalledTimes(1);

    expect(runtime.shouldSuppressAutomaticInboxDrain(Date.now() + 1_600)).toBe(false);
    expect(runtime.maybeDrainInboxIfIdle(ctx)).toBe(true);
    expect(drainInbox).toHaveBeenCalledTimes(2);
  });

  it("schedules an inbox drain retry until the session is truly idle", async () => {
    vi.useFakeTimers();
    try {
      let idle = false;
      const { deps, drainInbox } = createDeps({ getInboxLength: () => 1 });
      const runtime = createSessionUiRuntime(deps);
      const { ctx } = createContext({ idle: false });
      (ctx as unknown as { isIdle: () => boolean }).isIdle = () => idle;

      expect(runtime.maybeDrainInboxIfIdle(ctx)).toBe(false);
      expect(drainInbox).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(249);
      expect(drainInbox).not.toHaveBeenCalled();

      idle = true;
      await vi.advanceTimersByTimeAsync(1);
      expect(drainInbox).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds terminal input on session start and cleans it up on shutdown", () => {
    const unsubscribe = vi.fn();
    let terminalHandler:
      | ((data: string) => { consume?: boolean; data?: string } | undefined)
      | undefined;
    const onTerminalInput = vi.fn(
      (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
        terminalHandler = handler;
        return unsubscribe;
      },
    );
    const { deps, drainInbox } = createDeps();
    const runtime = createSessionUiRuntime(deps);
    const { ctx } = createContext({ idle: true, onTerminalInput });

    runtime.prepareForSessionStart(ctx);
    expect(runtime.getExtensionContext()).toBe(ctx);
    expect(onTerminalInput).toHaveBeenCalledTimes(1);
    expect(terminalHandler?.("\u001b")).toBeUndefined();
    expect(runtime.maybeDrainInboxIfIdle(ctx)).toBe(false);
    expect(drainInbox).not.toHaveBeenCalled();

    runtime.cleanupForSessionShutdown();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(runtime.shouldSuppressAutomaticInboxDrain(Date.now())).toBe(false);
    expect(runtime.maybeDrainInboxIfIdle(ctx)).toBe(true);
    expect(drainInbox).toHaveBeenCalledTimes(1);
  });

  it("exposes the latest extension context through the explicit setter", () => {
    const { deps } = createDeps();
    const runtime = createSessionUiRuntime(deps);
    const first = createContext().ctx;
    const second = createContext({ hasUI: false }).ctx;

    runtime.setExtCtx(first);
    expect(runtime.getExtensionContext()).toBe(first);

    runtime.setExtCtx(second);
    expect(runtime.getExtensionContext()).toBe(second);
  });
});
