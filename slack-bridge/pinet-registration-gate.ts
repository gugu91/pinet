import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isLikelyLocalSubagentContext } from "./helpers.js";

const PINET_REGISTRATION_BLOCK_REASON =
  "Pinet is disabled in local subagent sessions to avoid polluting the agent mesh.";

type SessionHeaderAccessor = ExtensionContext["sessionManager"] & {
  getHeader?: () => { parentSession?: string } | null;
};

export interface PinetRegistrationGateDeps {
  getArgv?: () => string[];
  getStdinIsTTY?: () => boolean | undefined;
  getStdoutIsTTY?: () => boolean | undefined;
}

export interface PinetRegistrationGate {
  isBlocked: () => boolean;
  getBlockReason: () => string;
  evaluateSessionStart: (ctx: ExtensionContext) => boolean;
  assertCanRegister: () => void;
  reset: () => void;
}

export function createPinetRegistrationGate(
  deps: PinetRegistrationGateDeps = {},
): PinetRegistrationGate {
  const getArgv = deps.getArgv ?? (() => process.argv.slice(2));
  const getStdinIsTTY = deps.getStdinIsTTY ?? (() => process.stdin.isTTY);
  const getStdoutIsTTY = deps.getStdoutIsTTY ?? (() => process.stdout.isTTY);

  let pinetRegistrationBlocked = false;

  function isBlocked(): boolean {
    return pinetRegistrationBlocked;
  }

  function getBlockReason(): string {
    return PINET_REGISTRATION_BLOCK_REASON;
  }

  function evaluateSessionStart(ctx: ExtensionContext): boolean {
    const sessionHeader = (ctx.sessionManager as SessionHeaderAccessor).getHeader?.();
    pinetRegistrationBlocked = isLikelyLocalSubagentContext({
      sessionHeader,
      sessionFile: ctx.sessionManager.getSessionFile(),
      leafId: ctx.sessionManager.getLeafId(),
      argv: getArgv(),
      hasUI: ctx.hasUI,
      stdinIsTTY: getStdinIsTTY(),
      stdoutIsTTY: getStdoutIsTTY(),
    });
    return pinetRegistrationBlocked;
  }

  function assertCanRegister(): void {
    if (pinetRegistrationBlocked) {
      throw new Error(getBlockReason());
    }
  }

  function reset(): void {
    pinetRegistrationBlocked = false;
  }

  return {
    isBlocked,
    getBlockReason,
    evaluateSessionStart,
    assertCanRegister,
    reset,
  };
}
