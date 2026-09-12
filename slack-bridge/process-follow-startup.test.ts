import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BrokerClient } from "./broker/client.js";
import * as brokerModule from "./broker/index.js";
import slackBridgeExtension from "./index.js";

type ExtensionEventHandler = Parameters<ExtensionAPI["on"]>[1];

function createStartupHarness() {
  const events = new Map<string, ExtensionEventHandler>();
  const activeTools = new Set([
    "read",
    "slack",
    "slack_inbox",
    "slack_send",
    "pinet",
    "imessage_send",
  ]);
  const registerFlag = vi.fn();
  const setActiveTools = vi.fn((toolNames: string[]) => {
    activeTools.clear();
    for (const toolName of toolNames) activeTools.add(toolName);
  });
  const pi: ExtensionAPI = {
    on: vi.fn((eventName, handler) => {
      events.set(eventName, handler);
    }),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerFlag,
    getFlag: vi.fn((name) => name === "pinet-follow"),
    registerMessageRenderer: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools,
  };
  const notify = vi.fn();
  const setStatus = vi.fn();
  const ctx: ExtensionContext = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
      },
      notify,
      setStatus,
    },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => "process-follow-leaf",
      getSessionFile: () => "/tmp/process-follow-session.json",
    },
  };

  return { activeTools, ctx, events, notify, pi, registerFlag, setStatus };
}

function restoreEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function requireEvent(
  events: ReadonlyMap<string, ExtensionEventHandler>,
  eventName: string,
): ExtensionEventHandler {
  const handler = events.get(eventName);
  if (!handler) throw new Error(`Missing ${eventName} handler`);
  return handler;
}

function stubFollowerClient(registration: "success" | "failure") {
  const connect = vi.spyOn(BrokerClient.prototype, "connect").mockResolvedValue(undefined);
  const register = vi.spyOn(BrokerClient.prototype, "register").mockImplementation(async () => {
    if (registration === "failure") {
      throw new Error("mesh authentication rejected");
    }
    return {
      agentId: "process-follower",
      name: "Process Follower",
      emoji: "🐻",
      metadata: null,
    };
  });
  vi.spyOn(BrokerClient.prototype, "isConnected").mockReturnValue(true);
  vi.spyOn(BrokerClient.prototype, "claimThread").mockResolvedValue({ claimed: true });
  vi.spyOn(BrokerClient.prototype, "pollInbox").mockResolvedValue([]);
  vi.spyOn(BrokerClient.prototype, "updateStatus").mockResolvedValue(undefined);
  vi.spyOn(BrokerClient.prototype, "ackMessages").mockResolvedValue(undefined);
  vi.spyOn(BrokerClient.prototype, "disconnectGracefully").mockResolvedValue(undefined);
  vi.spyOn(BrokerClient.prototype, "unregister").mockResolvedValue(undefined);
  vi.spyOn(BrokerClient.prototype, "disconnect").mockImplementation(() => {});
  vi.spyOn(BrokerClient.prototype, "onDisconnect").mockImplementation(() => {});
  vi.spyOn(BrokerClient.prototype, "onReconnect").mockImplementation(() => {});
  vi.spyOn(BrokerClient.prototype, "onReconnectFailed").mockImplementation(() => {});

  return { connect, register };
}

describe("--pinet-follow process startup", () => {
  const originalHome = process.env.HOME;
  const originalBotToken = process.env.SLACK_BOT_TOKEN;
  const originalAppToken = process.env.SLACK_APP_TOKEN;
  const originalSocketPath = process.env.PINET_SOCKET_PATH;
  let testHome: string;

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-follow-startup-"));
    process.env.HOME = testHome;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    delete process.env.PINET_SOCKET_PATH;
    fs.mkdirSync(path.join(testHome, ".pi", "agent"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testHome, { recursive: true, force: true });
    vi.restoreAllMocks();

    restoreEnvironmentValue("HOME", originalHome);
    restoreEnvironmentValue("SLACK_BOT_TOKEN", originalBotToken);
    restoreEnvironmentValue("SLACK_APP_TOKEN", originalAppToken);
    restoreEnvironmentValue("PINET_SOCKET_PATH", originalSocketPath);
  });

  it("overrides persistent broker mode, registers as follower, and activates brokered tools", async () => {
    const settingsPath = path.join(testHome, ".pi", "agent", "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ "slack-bridge": { runtimeMode: "broker", allowAllWorkspaceUsers: true } }),
    );
    const customSocketPath = path.join(testHome, "broker", "pinet.sock");
    fs.mkdirSync(path.dirname(customSocketPath), { recursive: true });
    fs.writeFileSync(customSocketPath, "");
    process.env.PINET_SOCKET_PATH = customSocketPath;

    const follower = stubFollowerClient("success");
    const startBroker = vi.spyOn(brokerModule, "startBroker");
    const harness = createStartupHarness();

    slackBridgeExtension(harness.pi);
    await requireEvent(harness.events, "session_start")({}, harness.ctx);

    expect(harness.registerFlag).toHaveBeenCalledWith("pinet-follow", {
      description: expect.stringContaining("without changing persistent settings"),
      type: "boolean",
    });
    expect(follower.connect).toHaveBeenCalledOnce();
    expect(follower.register).toHaveBeenCalledOnce();
    expect(startBroker).not.toHaveBeenCalled();
    expect(harness.activeTools).toEqual(
      new Set(["read", "slack", "slack_inbox", "slack_send", "pinet", "imessage_send"]),
    );
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({
      "slack-bridge": { runtimeMode: "broker", allowAllWorkspaceUsers: true },
    });

    await requireEvent(harness.events, "session_shutdown")({}, harness.ctx);
  });

  it("does not require local Slack tokens before connecting to the broker as a process follower", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    fs.writeFileSync(
      path.join(testHome, ".pi", "agent", "settings.json"),
      JSON.stringify({ "slack-bridge": { runtimeMode: "broker", allowAllWorkspaceUsers: true } }),
    );
    const customSocketPath = path.join(testHome, "broker", "pinet.sock");
    fs.mkdirSync(path.dirname(customSocketPath), { recursive: true });
    fs.writeFileSync(customSocketPath, "");
    process.env.PINET_SOCKET_PATH = customSocketPath;

    const follower = stubFollowerClient("success");
    const startBroker = vi.spyOn(brokerModule, "startBroker");
    const harness = createStartupHarness();

    slackBridgeExtension(harness.pi);
    await requireEvent(harness.events, "session_start")({}, harness.ctx);

    expect(follower.connect).toHaveBeenCalledOnce();
    expect(follower.register).toHaveBeenCalledOnce();
    expect(startBroker).not.toHaveBeenCalled();
    expect(harness.activeTools).toEqual(
      new Set(["read", "slack", "slack_inbox", "slack_send", "pinet", "imessage_send"]),
    );

    await requireEvent(harness.events, "session_shutdown")({}, harness.ctx);
  });

  it("stays visibly off without a broker socket and never attempts broker or Slack access", async () => {
    fs.writeFileSync(
      path.join(testHome, ".pi", "agent", "settings.json"),
      JSON.stringify({ "slack-bridge": { runtimeMode: "broker", allowAllWorkspaceUsers: true } }),
    );
    const missingSocketPath = path.join(testHome, "missing", "pinet.sock");
    process.env.PINET_SOCKET_PATH = missingSocketPath;

    const connect = vi.spyOn(BrokerClient.prototype, "connect");
    const startBroker = vi.spyOn(brokerModule, "startBroker");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createStartupHarness();

    slackBridgeExtension(harness.pi);
    await requireEvent(harness.events, "session_start")({}, harness.ctx);

    expect(connect).not.toHaveBeenCalled();
    expect(startBroker).not.toHaveBeenCalled();
    expect(harness.activeTools).toEqual(new Set(["read"]));
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining(`could not find a broker socket at ${missingSocketPath}`),
      "warning",
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Continuing with Slack/Pinet/iMessage communication tools off"),
    );
  });

  it("stays visibly off when broker authentication or registration fails", async () => {
    fs.writeFileSync(
      path.join(testHome, ".pi", "agent", "settings.json"),
      JSON.stringify({ "slack-bridge": { runtimeMode: "single", allowAllWorkspaceUsers: true } }),
    );
    const customSocketPath = path.join(testHome, "broker", "pinet.sock");
    fs.mkdirSync(path.dirname(customSocketPath), { recursive: true });
    fs.writeFileSync(customSocketPath, "");
    process.env.PINET_SOCKET_PATH = customSocketPath;

    const follower = stubFollowerClient("failure");
    const startBroker = vi.spyOn(brokerModule, "startBroker");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createStartupHarness();

    slackBridgeExtension(harness.pi);
    await requireEvent(harness.events, "session_start")({}, harness.ctx);

    expect(follower.connect).toHaveBeenCalledOnce();
    expect(follower.register).toHaveBeenCalledOnce();
    expect(startBroker).not.toHaveBeenCalled();
    expect(harness.activeTools).toEqual(new Set(["read"]));
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining("mesh authentication rejected"),
      "warning",
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Verify the broker, mesh authentication, and PINET_SOCKET_PATH"),
    );
  });
});
