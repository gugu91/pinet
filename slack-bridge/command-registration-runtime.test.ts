import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PinetCommandsDeps } from "./pinet-commands.js";
import { createCommandRegistrationRuntime } from "./command-registration-runtime.js";

const registrationState = vi.hoisted(() => ({
  registerPinetCommands: vi.fn(),
}));

vi.mock("./pinet-commands.js", () => ({
  registerPinetCommands: registrationState.registerPinetCommands,
}));

describe("createCommandRegistrationRuntime", () => {
  beforeEach(() => {
    registrationState.registerPinetCommands.mockReset();
  });

  it("registers the pinned command wiring with the provided deps", () => {
    const pi = { registerCommand: vi.fn() } as unknown as ExtensionAPI;
    const pinetCommands = {} as PinetCommandsDeps;
    const runtime = createCommandRegistrationRuntime({
      pinetCommands,
    });

    runtime.register(pi);

    expect(registrationState.registerPinetCommands).toHaveBeenCalledTimes(1);
    expect(registrationState.registerPinetCommands).toHaveBeenCalledWith(pi, pinetCommands);
  });
});
