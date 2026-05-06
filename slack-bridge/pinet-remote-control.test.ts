import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createPinetRemoteControl,
  type PinetRemoteControlDeps,
  type PinetRuntimeControlContext,
} from "./pinet-remote-control.js";

function createDeps(overrides: Partial<PinetRemoteControlDeps> = {}) {
  const flushDeferredRemoteControlAcks = vi.fn();
  const reloadPinetRuntime = vi.fn(async () => {
    /* noop */
  });

  const deps: PinetRemoteControlDeps = {
    flushDeferredRemoteControlAcks,
    reloadPinetRuntime,
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides,
  };

  return {
    deps,
    flushDeferredRemoteControlAcks,
    reloadPinetRuntime,
  };
}

function createCtx(
  options: {
    idle?: boolean;
    shutdown?: () => void;
    abort?: () => void;
  } = {},
) {
  const notify = vi.fn();
  const abort = options.abort ?? vi.fn();
  const shutdown = options.shutdown;
  const ctx = {
    isIdle: () => options.idle ?? true,
    ui: {
      notify,
    },
  } as unknown as PinetRuntimeControlContext;

  ctx.abort = abort;
  if (shutdown) {
    ctx.shutdown = shutdown;
  }

  return {
    ctx: ctx as ExtensionContext,
    notify,
    abort,
  };
}

async function settleRemoteControl(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createPinetRemoteControl", () => {
  it("starts the first remote-control command immediately without warning", () => {
    const { deps } = createDeps();
    const pinetRemoteControl = createPinetRemoteControl(deps);
    const { ctx, notify } = createCtx();

    const result = pinetRemoteControl.requestRemoteControl("reload", ctx);

    expect(result).toMatchObject({
      currentCommand: "reload",
      queuedCommand: null,
      shouldStartNow: true,
      status: "start",
      scheduledCommand: "reload",
      ackDisposition: "immediate",
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("warns when commands are queued or already covered", () => {
    const { deps } = createDeps();
    const pinetRemoteControl = createPinetRemoteControl(deps);
    const { ctx, notify } = createCtx();

    pinetRemoteControl.requestRemoteControl("reload", ctx);
    const queued = pinetRemoteControl.requestRemoteControl("exit", ctx);
    const covered = pinetRemoteControl.requestRemoteControl("reload", ctx);

    expect(queued).toMatchObject({
      currentCommand: "reload",
      queuedCommand: "exit",
      shouldStartNow: false,
      status: "queued",
      scheduledCommand: "exit",
      ackDisposition: "on_start",
    });
    expect(covered).toMatchObject({
      currentCommand: "reload",
      queuedCommand: "exit",
      shouldStartNow: false,
      status: "covered",
      scheduledCommand: "exit",
      ackDisposition: "on_start",
    });
    expect(notify).toHaveBeenNthCalledWith(1, "Pinet remote control queued: /exit", "warning");
    expect(notify).toHaveBeenNthCalledWith(
      2,
      "Pinet remote control already scheduled — keeping /exit",
      "warning",
    );
  });

  it("flushes deferred acks and aborts busy work for interrupt without reloading or exiting", async () => {
    const { deps, flushDeferredRemoteControlAcks, reloadPinetRuntime } = createDeps();
    const shutdown = vi.fn();
    const pinetRemoteControl = createPinetRemoteControl(deps);
    const { ctx, notify, abort } = createCtx({ idle: false, shutdown });

    pinetRemoteControl.requestRemoteControl("interrupt", ctx);
    pinetRemoteControl.runRemoteControl("interrupt", ctx);
    await settleRemoteControl();

    expect(flushDeferredRemoteControlAcks).toHaveBeenCalledWith("interrupt");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(reloadPinetRuntime).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Pinet remote control requested: /interrupt", "warning");
  });

  it("flushes deferred acks, aborts busy work, and reloads the runtime", async () => {
    const { deps, flushDeferredRemoteControlAcks, reloadPinetRuntime } = createDeps();
    const pinetRemoteControl = createPinetRemoteControl(deps);
    const { ctx, notify, abort } = createCtx({ idle: false });

    pinetRemoteControl.requestRemoteControl("reload", ctx);
    pinetRemoteControl.runRemoteControl("reload", ctx);
    await settleRemoteControl();

    expect(flushDeferredRemoteControlAcks).toHaveBeenCalledTimes(1);
    expect(flushDeferredRemoteControlAcks).toHaveBeenCalledWith("reload");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(reloadPinetRuntime).toHaveBeenCalledTimes(1);
    expect(reloadPinetRuntime).toHaveBeenCalledWith(ctx);
    expect(notify).toHaveBeenCalledWith("Pinet remote control requested: /reload", "warning");
  });

  it("continues with a queued command after the active command finishes", async () => {
    const { deps, flushDeferredRemoteControlAcks, reloadPinetRuntime } = createDeps();
    const shutdown = vi.fn();
    const pinetRemoteControl = createPinetRemoteControl(deps);
    const { ctx, notify, abort } = createCtx({ idle: true, shutdown });

    pinetRemoteControl.requestRemoteControl("reload", ctx);
    pinetRemoteControl.requestRemoteControl("exit", ctx);
    pinetRemoteControl.runRemoteControl("reload", ctx);
    await settleRemoteControl();

    expect(flushDeferredRemoteControlAcks).toHaveBeenNthCalledWith(1, "reload");
    expect(flushDeferredRemoteControlAcks).toHaveBeenNthCalledWith(2, "exit");
    expect(reloadPinetRuntime).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
    expect(notify).toHaveBeenNthCalledWith(1, "Pinet remote control queued: /exit", "warning");
    expect(notify).toHaveBeenNthCalledWith(2, "Pinet remote control requested: /reload", "warning");
    expect(notify).toHaveBeenNthCalledWith(
      3,
      "Pinet remote control continuing with queued /exit",
      "warning",
    );
    expect(notify).toHaveBeenNthCalledWith(4, "Pinet remote control requested: /exit", "warning");
  });

  it("reports remote-control failures and resets cleanly", async () => {
    const { deps, flushDeferredRemoteControlAcks } = createDeps();
    const pinetRemoteControl = createPinetRemoteControl(deps);
    const { ctx, notify } = createCtx();

    pinetRemoteControl.requestRemoteControl("exit", ctx);
    pinetRemoteControl.runRemoteControl("exit", ctx);
    await settleRemoteControl();

    expect(flushDeferredRemoteControlAcks).toHaveBeenCalledWith("exit");
    expect(notify).toHaveBeenNthCalledWith(1, "Pinet remote control requested: /exit", "warning");
    expect(notify).toHaveBeenNthCalledWith(
      2,
      "Pinet remote control failed: Shutdown is not available in this extension context.",
      "error",
    );

    pinetRemoteControl.resetRemoteControlState();
    const restarted = pinetRemoteControl.requestRemoteControl("reload", ctx);
    expect(restarted).toMatchObject({
      currentCommand: "reload",
      queuedCommand: null,
      shouldStartNow: true,
      status: "start",
      scheduledCommand: "reload",
    });
  });
});
