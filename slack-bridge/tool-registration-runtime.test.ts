import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RegisterIMessageToolsDeps } from "./imessage-tools.js";
import type { RegisterPinetToolsDeps } from "./pinet-tools.js";
import type { RegisterSlackToolsDeps } from "./slack-tools.js";
import { createToolRegistrationRuntime } from "./tool-registration-runtime.js";

const registrationState = vi.hoisted(() => ({
  registerSlackTools: vi.fn(),
  registerPinetTools: vi.fn(),
  registerIMessageTools: vi.fn(),
}));

vi.mock("./slack-tools.js", () => ({
  registerSlackTools: registrationState.registerSlackTools,
}));

vi.mock("./pinet-tools.js", () => ({
  registerPinetTools: registrationState.registerPinetTools,
}));

vi.mock("./imessage-tools.js", () => ({
  registerIMessageTools: registrationState.registerIMessageTools,
}));

describe("createToolRegistrationRuntime", () => {
  beforeEach(() => {
    registrationState.registerSlackTools.mockReset();
    registrationState.registerPinetTools.mockReset();
    registrationState.registerIMessageTools.mockReset();
  });

  it("registers the pinned tool wiring in order with the provided deps", () => {
    const pi = { registerTool: vi.fn() } as unknown as ExtensionAPI;
    const slackTools = {} as RegisterSlackToolsDeps;
    const pinetTools = {} as RegisterPinetToolsDeps;
    const iMessageTools = {} as RegisterIMessageToolsDeps;
    const runtime = createToolRegistrationRuntime({
      slackTools,
      pinetTools,
      iMessageTools,
    });

    runtime.register(pi);

    expect(registrationState.registerSlackTools).toHaveBeenCalledTimes(1);
    expect(registrationState.registerSlackTools).toHaveBeenCalledWith(pi, slackTools);
    expect(registrationState.registerPinetTools).toHaveBeenCalledTimes(1);
    expect(registrationState.registerPinetTools).toHaveBeenCalledWith(pi, pinetTools);
    expect(registrationState.registerIMessageTools).toHaveBeenCalledTimes(1);
    expect(registrationState.registerIMessageTools).toHaveBeenCalledWith(pi, iMessageTools);

    expect(registrationState.registerSlackTools.mock.invocationCallOrder[0]).toBeLessThan(
      registrationState.registerPinetTools.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(registrationState.registerPinetTools.mock.invocationCallOrder[0]).toBeLessThan(
      registrationState.registerIMessageTools.mock.invocationCallOrder[0] ?? Infinity,
    );
  });
});
