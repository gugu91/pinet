import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerIMessageTools, type RegisterIMessageToolsDeps } from "./imessage-tools.js";
import {
  registerPinetA2ACompatTools,
  type RegisterPinetA2ACompatToolsDeps,
} from "./pinet-a2a-compat.js";
import { registerPinetTools, type RegisterPinetToolsDeps } from "./pinet-tools.js";
import { registerSlackTools, type RegisterSlackToolsDeps } from "./slack-tools.js";

export interface ToolRegistrationRuntimeDeps {
  slackTools: RegisterSlackToolsDeps;
  pinetTools: RegisterPinetToolsDeps;
  pinetA2ACompatTools: RegisterPinetA2ACompatToolsDeps;
  iMessageTools: RegisterIMessageToolsDeps;
}

export interface ToolRegistrationRuntime {
  register: (pi: ExtensionAPI) => void;
}

export function createToolRegistrationRuntime(
  deps: ToolRegistrationRuntimeDeps,
): ToolRegistrationRuntime {
  function register(pi: ExtensionAPI): void {
    registerSlackTools(pi, deps.slackTools);
    registerPinetTools(pi, deps.pinetTools);
    registerPinetA2ACompatTools(pi, deps.pinetA2ACompatTools);
    registerIMessageTools(pi, deps.iMessageTools);
  }

  return {
    register,
  };
}
