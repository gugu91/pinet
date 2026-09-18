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

  it("registers each tool family with the provided deps", () => {
    const pi = { registerTool: vi.fn() } as unknown as ExtensionAPI;
    const slackTools = {} as RegisterSlackToolsDeps;
    const pinetTools = {} as RegisterPinetToolsDeps;
    const iMessageTools = {} as RegisterIMessageToolsDeps;
    const runtime = createToolRegistrationRuntime({
      slackTools,
      pinetTools,
      iMessageTools,
      buildPromptGuidelines: async () => [],
    });

    runtime.register(pi);

    expect(registrationState.registerSlackTools).toHaveBeenCalledTimes(1);
    expect(registrationState.registerSlackTools).toHaveBeenCalledWith(pi, slackTools);
    expect(registrationState.registerPinetTools).toHaveBeenCalledTimes(1);
    expect(registrationState.registerPinetTools).toHaveBeenCalledWith(pi, pinetTools);
    expect(registrationState.registerIMessageTools).toHaveBeenCalledTimes(1);
    expect(registrationState.registerIMessageTools).toHaveBeenCalledWith(pi, iMessageTools);
  });

  it.each([
    {
      mode: "off" as const,
      expectedTools: ["read"],
      expectedPinetGuidance: null,
      expectedSlackGuidance: null,
    },
    {
      mode: "single" as const,
      expectedTools: ["read", "slack", "slack_inbox", "slack_send"],
      expectedPinetGuidance: null,
      expectedSlackGuidance: ["RUNTIME GUIDANCE"],
    },
    {
      mode: "follower" as const,
      expectedTools: ["read", "slack", "slack_inbox", "slack_send", "pinet", "imessage_send"],
      expectedPinetGuidance: ["RUNTIME GUIDANCE"],
      expectedSlackGuidance: [],
    },
    {
      mode: "broker" as const,
      expectedTools: ["read", "slack", "slack_inbox", "slack_send", "pinet", "imessage_send"],
      expectedPinetGuidance: ["RUNTIME GUIDANCE"],
      expectedSlackGuidance: [],
    },
  ])("keeps only the tools and durable guidance for $mode mode", async (testCase) => {
    const setActiveTools = vi.fn();
    const pi: ExtensionAPI = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(() => undefined),
      registerMessageRenderer: vi.fn(),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
      getActiveTools: vi.fn(() => [
        "read",
        "slack",
        "slack_inbox",
        "slack_send",
        "pinet",
        "imessage_send",
      ]),
      setActiveTools,
    };
    const runtime = createToolRegistrationRuntime({
      slackTools: {} as RegisterSlackToolsDeps,
      pinetTools: {} as RegisterPinetToolsDeps,
      iMessageTools: {} as RegisterIMessageToolsDeps,
      buildPromptGuidelines: async () => ["RUNTIME GUIDANCE"],
    });

    await runtime.sync(pi, testCase.mode);

    expect(setActiveTools).toHaveBeenCalledWith(testCase.expectedTools);
    if (testCase.expectedSlackGuidance) {
      expect(registrationState.registerSlackTools).toHaveBeenCalledWith(
        pi,
        expect.objectContaining({
          additionalSendPromptGuidelines: testCase.expectedSlackGuidance,
        }),
      );
    } else {
      expect(registrationState.registerSlackTools).not.toHaveBeenCalled();
    }
    if (testCase.expectedPinetGuidance) {
      expect(registrationState.registerPinetTools).toHaveBeenCalledWith(
        pi,
        expect.objectContaining({ promptGuidelines: testCase.expectedPinetGuidance }),
      );
    } else {
      expect(registrationState.registerPinetTools).not.toHaveBeenCalled();
    }
    expect(registrationState.registerIMessageTools).not.toHaveBeenCalled();
  });
});
