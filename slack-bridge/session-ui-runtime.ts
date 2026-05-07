import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const AUTO_DRAIN_INTERRUPT_SUPPRESSION_MS = 1_500;
const AUTO_DRAIN_IDLE_RETRY_MS = 250;

export type SessionUiStatusState = "ok" | "reconnecting" | "error" | "off";

export interface SessionUiRuntimeDeps {
  getAgentName: () => string;
  getAgentEmoji: () => string;
  getInboxLength: () => number;
  drainInbox: () => void;
}

export interface SessionUiRuntime {
  getExtensionContext: () => ExtensionContext | null;
  setExtCtx: (ctx: ExtensionContext) => void;
  updateBadge: () => void;
  setExtStatus: (ctx: ExtensionContext, state: SessionUiStatusState) => void;
  notePotentialInterruptInput: (data: string) => void;
  shouldSuppressAutomaticInboxDrain: (now?: number) => boolean;
  maybeDrainInboxIfIdle: (ctx?: ExtensionContext) => boolean;
  prepareForSessionStart: (ctx: ExtensionContext) => void;
  cleanupForSessionShutdown: () => void;
}

type SessionUiWithTerminalInput = ExtensionContext["ui"] & {
  onTerminalInput?: (
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ) => () => void;
};

export function createSessionUiRuntime(deps: SessionUiRuntimeDeps): SessionUiRuntime {
  let suppressAutoDrainUntil = 0;
  let terminalInputUnsubscribe: (() => void) | null = null;
  let deferredDrainTimer: ReturnType<typeof setTimeout> | null = null;
  let extCtx: ExtensionContext | null = null;

  function getExtensionContext(): ExtensionContext | null {
    return extCtx;
  }

  function setExtCtx(ctx: ExtensionContext): void {
    extCtx = ctx;
  }

  function updateBadge(): void {
    if (!extCtx?.hasUI) return;
    const t = extCtx.ui.theme;
    const n = deps.getInboxLength();
    const label =
      n > 0
        ? t.fg("accent", `${deps.getAgentEmoji()} ${deps.getAgentName()} ✦ ${n}`)
        : t.fg("accent", `${deps.getAgentEmoji()} ${deps.getAgentName()} ✦`);
    extCtx.ui.setStatus("slack-bridge", label);
  }

  function setExtStatus(ctx: ExtensionContext, state: SessionUiStatusState): void {
    if (!ctx.hasUI) return;
    extCtx = ctx;
    const t = ctx.ui.theme;
    if (state === "ok") {
      updateBadge();
      return;
    }
    const text =
      state === "reconnecting"
        ? t.fg("warning", `${deps.getAgentEmoji()} ${deps.getAgentName()} ⟳`)
        : state === "error"
          ? t.fg("error", `${deps.getAgentEmoji()} ${deps.getAgentName()} ✗`)
          : "";
    ctx.ui.setStatus("slack-bridge", text);
  }

  function notePotentialInterruptInput(data: string): void {
    if (data !== "\u001b") {
      return;
    }

    suppressAutoDrainUntil = Math.max(
      suppressAutoDrainUntil,
      Date.now() + AUTO_DRAIN_INTERRUPT_SUPPRESSION_MS,
    );
  }

  function shouldSuppressAutomaticInboxDrain(now = Date.now()): boolean {
    if (suppressAutoDrainUntil === 0) {
      return false;
    }
    if (now >= suppressAutoDrainUntil) {
      suppressAutoDrainUntil = 0;
      return false;
    }
    return true;
  }

  function clearDeferredDrainTimer(): void {
    if (!deferredDrainTimer) return;
    clearTimeout(deferredDrainTimer);
    deferredDrainTimer = null;
  }

  function scheduleDeferredDrain(ctx: ExtensionContext): void {
    extCtx = ctx;
    if (deferredDrainTimer) return;

    deferredDrainTimer = setTimeout(() => {
      deferredDrainTimer = null;
      if (deps.getInboxLength() === 0) return;
      const latestCtx = extCtx;
      if (!latestCtx) return;
      maybeDrainInboxIfIdle(latestCtx);
    }, AUTO_DRAIN_IDLE_RETRY_MS);
    deferredDrainTimer.unref?.();
  }

  function maybeDrainInboxIfIdle(ctx?: ExtensionContext): boolean {
    if (ctx) {
      extCtx = ctx;
    }

    const activeCtx = ctx ?? extCtx;
    if (!(activeCtx?.isIdle?.() ?? false)) {
      if (activeCtx && !shouldSuppressAutomaticInboxDrain() && deps.getInboxLength() > 0) {
        scheduleDeferredDrain(activeCtx);
      }
      return false;
    }
    if (shouldSuppressAutomaticInboxDrain()) {
      return false;
    }

    clearDeferredDrainTimer();
    deps.drainInbox();
    return true;
  }

  function prepareForSessionStart(ctx: ExtensionContext): void {
    suppressAutoDrainUntil = 0;
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = null;
    extCtx = ctx;

    const uiWithTerminalInput = ctx.ui as SessionUiWithTerminalInput;
    if (ctx.hasUI && typeof uiWithTerminalInput.onTerminalInput === "function") {
      terminalInputUnsubscribe = uiWithTerminalInput.onTerminalInput((data: string) => {
        notePotentialInterruptInput(data);
        return undefined;
      });
    }
  }

  function cleanupForSessionShutdown(): void {
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = null;
    clearDeferredDrainTimer();
    suppressAutoDrainUntil = 0;
  }

  return {
    getExtensionContext,
    setExtCtx,
    updateBadge,
    setExtStatus,
    notePotentialInterruptInput,
    shouldSuppressAutomaticInboxDrain,
    maybeDrainInboxIfIdle,
    prepareForSessionStart,
    cleanupForSessionShutdown,
  };
}
