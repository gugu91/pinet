import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPinetCommands, type PinetCommandsDeps } from "./pinet-commands.js";

export interface CommandRegistrationRuntimeDeps {
  pinetCommands: PinetCommandsDeps;
}

export interface CommandRegistrationRuntime {
  register: (pi: ExtensionAPI) => void;
}

export function createCommandRegistrationRuntime(
  deps: CommandRegistrationRuntimeDeps,
): CommandRegistrationRuntime {
  function register(pi: ExtensionAPI): void {
    registerPinetCommands(pi, deps.pinetCommands);
  }

  return {
    register,
  };
}
