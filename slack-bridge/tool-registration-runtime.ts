import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerIMessageTools, type RegisterIMessageToolsDeps } from "./imessage-tools.js";
import { registerPinetTools, type RegisterPinetToolsDeps } from "./pinet-tools.js";
import { registerSlackTools, type RegisterSlackToolsDeps } from "./slack-tools.js";

export interface ToolRegistrationRuntimeDeps {
  slackTools: RegisterSlackToolsDeps;
  pinetTools: RegisterPinetToolsDeps;
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
    registerIMessageTools(pi, deps.iMessageTools);
  }

  return {
    register,
  };
}
