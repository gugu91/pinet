import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DatabaseSync } from "node:sqlite";
import { BrokerClient } from "./broker/client.js";
import * as brokerModule from "./broker/index.js";
import * as maintenanceModule from "./broker/maintenance.js";
import { BrokerDB } from "./broker/schema.js";
import { SlackAdapter } from "./broker/adapters/slack.js";
import * as imessageModule from "@gugu910/pi-imessage-bridge";
import slackBridge from "./index.js";

type ToolDefinition = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

type CommandDefinition = {
  description: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
};

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function stubIsTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): () => void {
  const target = stream as unknown as Record<string, unknown>;
  const hadOwnProperty = Object.prototype.hasOwnProperty.call(target, "isTTY");
  const previousValue = target.isTTY;

  Object.defineProperty(target, "isTTY", {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });

  return () => {
    if (hadOwnProperty) {
      Object.defineProperty(target, "isTTY", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: previousValue,
      });
      return;
    }

    Reflect.deleteProperty(target, "isTTY");
  };
}

describe("slack-bridge top-level shutdown", () => {
  const originalBotToken = process.env.SLACK_BOT_TOKEN;
  const originalAppToken = process.env.SLACK_APP_TOKEN;
  const originalHome = process.env.HOME;
  let testHome: string;

  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "slack-bridge-test-home-"));
    process.env.HOME = testHome;
    fs.mkdirSync(path.join(testHome, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(testHome, ".pi", "agent", "settings.json"),
      JSON.stringify({
        "slack-bridge": {
          allowAllWorkspaceUsers: true,
        },
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(testHome, { recursive: true, force: true });

    if (originalBotToken === undefined) {
      delete process.env.SLACK_BOT_TOKEN;
    } else {
      process.env.SLACK_BOT_TOKEN = originalBotToken;
    }

    if (originalAppToken === undefined) {
      delete process.env.SLACK_APP_TOKEN;
    } else {
      process.env.SLACK_APP_TOKEN = originalAppToken;
    }

    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("aborts in-flight top-level Slack calls during session shutdown", async () => {
    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn((definition: ToolDefinition) => {
        tools.set(definition.name, definition);
      }),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => false,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify,
        setStatus,
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "leaf",
        getSessionFile: () => "/tmp/slack-bridge-session.json",
      },
    } as unknown as ExtensionContext;

    const fetchSpy = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };

        if (signal?.aborted) {
          rejectAbort();
          return;
        }

        signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const slackDispatcher = tools.get("slack");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(slackDispatcher).toBeDefined();
    expect(tools.has("pinet")).toBe(true);
    expect(tools.has("pinet_message")).toBe(false);
    expect(tools.has("pinet_read")).toBe(false);
    expect(tools.has("pinet_free")).toBe(false);
    expect(tools.has("pinet_schedule")).toBe(false);
    expect(tools.has("pinet_agents")).toBe(false);
    expect(commands.has("pinet-start")).toBe(false);
    expect(commands.has("pinet-free")).toBe(false);
    expect(commands.has("pinet-skin")).toBe(false);

    await sessionStart?.({}, ctx);

    const pending = slackDispatcher!.execute("tool-call-1", {
      action: "create_channel",
      args: { name: "shutdown-test" },
    });

    await sessionShutdown?.({}, ctx);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(
      fetchSpy.mock.calls.some(
        (call) => String(call.at(0)) === "https://slack.com/api/conversations.create",
      ),
    ).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledTimes(2);
  });

  it("restores top-level Slack tools after an in-process broker reload", async () => {
    const dbPath = path.join(testHome, ".pi", "pinet-broker.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn((definition: ToolDefinition) => {
        tools.set(definition.name, definition);
      }),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
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
        getHeader: () => null,
        getLeafId: () => "broker-leaf",
        getSessionFile: () => "/tmp/slack-bridge-session.json",
      },
    } as unknown as ExtensionContext;

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/conversations.create")) {
        return new Response(
          JSON.stringify({ ok: true, channel: { id: "C123", name: "reload-test" } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const brokerRuntimes: Array<{
      db: BrokerDB;
      server: {
        setAgentRegistrationResolver: ReturnType<typeof vi.fn>;
        onAgentMessage: ReturnType<typeof vi.fn>;
        onAgentStatusChange: ReturnType<typeof vi.fn>;
      };
      stop: ReturnType<typeof vi.fn>;
    }> = [];
    let resolveReloadStarted: (() => void) | null = null;
    const reloadStarted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Broker reload did not start"));
      }, 1_000);
      resolveReloadStarted = () => {
        clearTimeout(timer);
        resolve();
      };
    });

    vi.spyOn(maintenanceModule, "runBrokerMaintenancePass").mockImplementation((db) => ({
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 0,
      nudgedAgentIds: [],
      pendingBacklogCount: db.getBacklogCount("pending"),
      anomalies: [],
    }));
    vi.spyOn(brokerModule, "startBroker").mockImplementation(async () => {
      const db = new BrokerDB(dbPath);
      db.initialize();
      const server = {
        setAgentRegistrationResolver: vi.fn(),
        onAgentMessage: vi.fn(),
        onAgentStatusChange: vi.fn(),
      };
      const stop = vi.fn(async () => {
        db.close();
      });
      brokerRuntimes.push({ db, server, stop });
      if (brokerRuntimes.length === 2) {
        resolveReloadStarted?.();
      }
      return {
        db,
        server,
        lock: {
          isLeader: () => true,
          release: vi.fn(),
        },
        adapters: [],
        addAdapter: vi.fn(),
        stop,
      } as unknown as Awaited<ReturnType<typeof brokerModule.startBroker>>;
    });
    vi.spyOn(SlackAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "getBotUserId").mockReturnValue("U_BOT");

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStart = commands.get("pinet");
    const slackDispatcher = tools.get("slack");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStart).toBeDefined();
    expect(slackDispatcher).toBeDefined();

    await sessionStart?.({}, ctx);
    await pinetStart?.handler("start", ctx);

    expect(brokerRuntimes).toHaveLength(1);
    brokerRuntimes[0]!.db.registerAgent("sender", "Sender", "📤", 202);
    brokerRuntimes[0]!.db.queueMessage("broker-leaf", {
      source: "agent",
      threadId: "a2a:sender:broker-leaf",
      channel: "",
      userId: "sender",
      text: "/reload",
      timestamp: "123.456",
      metadata: { a2a: true, kind: "pinet_control", command: "reload" },
    });

    const onAgentMessage = brokerRuntimes[0]!.server.onAgentMessage.mock.calls[0]?.[0] as
      | ((targetAgentId: string) => void)
      | undefined;
    expect(onAgentMessage).toBeDefined();
    if (!onAgentMessage) {
      throw new Error("Expected broker agent-message handler to be registered");
    }

    onAgentMessage("broker-leaf");
    await reloadStarted;
    await Promise.resolve();
    await Promise.resolve();

    const response = await slackDispatcher!.execute("tool-call-2", {
      action: "create_channel",
      args: { name: "reload-test" },
    });

    expect(response).toMatchObject({
      details: {
        status: "succeeded",
        data: { details: { id: "C123", name: "reload-test" } },
      },
    });
    expect(
      fetchSpy.mock.calls.some(
        (call) => String(call.at(0)) === "https://slack.com/api/conversations.create",
      ),
    ).toBe(true);

    await sessionShutdown?.({}, ctx);
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Operation rejected: shutdown in progress"),
      "error",
    );
  });

  it("reloads the active broker runtime when /pinet start runs twice", async () => {
    const dbPath = path.join(testHome, ".pi", "pinet-broker.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
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
        getHeader: () => null,
        getLeafId: () => "broker-reload-leaf",
        getSessionFile: () => "/tmp/slack-bridge-broker-reload-session.json",
      },
    } as unknown as ExtensionContext;

    const brokerRuntimes: Array<{
      db: BrokerDB;
      server: {
        setAgentRegistrationResolver: ReturnType<typeof vi.fn>;
        onAgentMessage: ReturnType<typeof vi.fn>;
        onAgentStatusChange: ReturnType<typeof vi.fn>;
      };
      stop: ReturnType<typeof vi.fn>;
    }> = [];

    vi.spyOn(maintenanceModule, "runBrokerMaintenancePass").mockImplementation((db) => ({
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 0,
      nudgedAgentIds: [],
      pendingBacklogCount: db.getBacklogCount("pending"),
      anomalies: [],
    }));
    const startBrokerSpy = vi.spyOn(brokerModule, "startBroker").mockImplementation(async () => {
      const db = new BrokerDB(dbPath);
      db.initialize();
      const server = {
        setAgentRegistrationResolver: vi.fn(),
        onAgentMessage: vi.fn(),
        onAgentStatusChange: vi.fn(),
      };
      const stop = vi.fn(async () => {
        db.close();
      });
      brokerRuntimes.push({ db, server, stop });
      return {
        db,
        server,
        lock: {
          isLeader: () => true,
          release: vi.fn(),
        },
        adapters: [],
        addAdapter: vi.fn(),
        stop,
      } as unknown as Awaited<ReturnType<typeof brokerModule.startBroker>>;
    });
    vi.spyOn(SlackAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "getBotUserId").mockReturnValue("U_BOT");

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStart = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStart).toBeDefined();

    await sessionStart?.({}, ctx);
    await pinetStart?.handler("start", ctx);
    await pinetStart?.handler("start", ctx);

    expect(startBrokerSpy).toHaveBeenCalledTimes(2);
    expect(brokerRuntimes).toHaveLength(2);
    expect(brokerRuntimes[0]?.stop).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "Pinet broker already running — reloading current runtime",
      "info",
    );
    expect(notify).not.toHaveBeenCalledWith("Pinet already running (broker)", "info");

    await sessionShutdown?.({}, ctx);
  });

  it("aborts the current turn before reloading broker runtime from /pinet start", async () => {
    const dbPath = path.join(testHome, ".pi", "pinet-broker.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const abort = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => false,
      abort,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify,
        setStatus,
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "broker-reload-busy-leaf",
        getSessionFile: () => "/tmp/slack-bridge-broker-reload-busy-session.json",
      },
    } as unknown as ExtensionContext;

    const brokerRuntimes: Array<{
      db: BrokerDB;
      server: {
        setAgentRegistrationResolver: ReturnType<typeof vi.fn>;
        onAgentMessage: ReturnType<typeof vi.fn>;
        onAgentStatusChange: ReturnType<typeof vi.fn>;
      };
      stop: ReturnType<typeof vi.fn>;
    }> = [];

    vi.spyOn(maintenanceModule, "runBrokerMaintenancePass").mockImplementation((db) => ({
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 0,
      nudgedAgentIds: [],
      pendingBacklogCount: db.getBacklogCount("pending"),
      anomalies: [],
    }));
    const startBrokerSpy = vi.spyOn(brokerModule, "startBroker").mockImplementation(async () => {
      const db = new BrokerDB(dbPath);
      db.initialize();
      const server = {
        setAgentRegistrationResolver: vi.fn(),
        onAgentMessage: vi.fn(),
        onAgentStatusChange: vi.fn(),
      };
      const stop = vi.fn(async () => {
        db.close();
      });
      brokerRuntimes.push({ db, server, stop });
      return {
        db,
        server,
        lock: {
          isLeader: () => true,
          release: vi.fn(),
        },
        adapters: [],
        addAdapter: vi.fn(),
        stop,
      } as unknown as Awaited<ReturnType<typeof brokerModule.startBroker>>;
    });
    vi.spyOn(SlackAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "getBotUserId").mockReturnValue("U_BOT");

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStart = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStart).toBeDefined();

    await sessionStart?.({}, ctx);
    await pinetStart?.handler("start", ctx);
    await pinetStart?.handler("start", ctx);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(startBrokerSpy).toHaveBeenCalledTimes(2);
    expect(brokerRuntimes).toHaveLength(2);
    expect(brokerRuntimes[0]?.stop).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "Pinet broker already running — reloading current runtime",
      "info",
    );

    await sessionShutdown?.({}, ctx);
  });

  it("restores the previous broker runtime if /pinet start reload fails", async () => {
    const dbPath = path.join(testHome, ".pi", "pinet-broker.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
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
        getHeader: () => null,
        getLeafId: () => "broker-reload-fail-leaf",
        getSessionFile: () => "/tmp/slack-bridge-broker-reload-fail-session.json",
      },
    } as unknown as ExtensionContext;

    const brokerRuntimes: Array<{
      db: BrokerDB;
      server: {
        setAgentRegistrationResolver: ReturnType<typeof vi.fn>;
        onAgentMessage: ReturnType<typeof vi.fn>;
        onAgentStatusChange: ReturnType<typeof vi.fn>;
      };
      stop: ReturnType<typeof vi.fn>;
    }> = [];
    let startAttempt = 0;

    vi.spyOn(maintenanceModule, "runBrokerMaintenancePass").mockImplementation((db) => ({
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 0,
      nudgedAgentIds: [],
      pendingBacklogCount: db.getBacklogCount("pending"),
      anomalies: [],
    }));
    const startBrokerSpy = vi.spyOn(brokerModule, "startBroker").mockImplementation(async () => {
      startAttempt += 1;
      if (startAttempt === 2) {
        throw new Error("refreshed start failed");
      }

      const db = new BrokerDB(dbPath);
      db.initialize();
      const server = {
        setAgentRegistrationResolver: vi.fn(),
        onAgentMessage: vi.fn(),
        onAgentStatusChange: vi.fn(),
      };
      const stop = vi.fn(async () => {
        db.close();
      });
      brokerRuntimes.push({ db, server, stop });
      return {
        db,
        server,
        lock: {
          isLeader: () => true,
          release: vi.fn(),
        },
        adapters: [],
        addAdapter: vi.fn(),
        stop,
      } as unknown as Awaited<ReturnType<typeof brokerModule.startBroker>>;
    });
    vi.spyOn(SlackAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "getBotUserId").mockReturnValue("U_BOT");

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStart = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStart).toBeDefined();

    await sessionStart?.({}, ctx);
    await pinetStart?.handler("start", ctx);
    notify.mockClear();
    setStatus.mockClear();

    await pinetStart?.handler("start", ctx);

    expect(startBrokerSpy).toHaveBeenCalledTimes(3);
    expect(brokerRuntimes).toHaveLength(2);
    expect(brokerRuntimes[0]?.stop).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "Pinet broker already running — reloading current runtime",
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      "Pinet broker reload failed: Reload failed: refreshed start failed. Restored the previous runtime.",
      "error",
    );
    expect(notify).not.toHaveBeenCalledWith("Pinet already running (broker)", "info");
    expect(setStatus).toHaveBeenCalled();

    await sessionShutdown?.({}, ctx);
    expect(brokerRuntimes[1]?.stop).toHaveBeenCalledTimes(1);
  });

  it("preserves the incoming system prompt prefix when broker guidance is appended at root runtime", async () => {
    const dbPath = path.join(testHome, ".pi", "pinet-broker.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => true,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "broker-prompt-layering-leaf",
        getSessionFile: () => "/tmp/slack-bridge-broker-prompt-layering-session.json",
      },
    } as unknown as ExtensionContext;

    vi.spyOn(maintenanceModule, "runBrokerMaintenancePass").mockImplementation((db) => ({
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 0,
      nudgedAgentIds: [],
      pendingBacklogCount: db.getBacklogCount("pending"),
      anomalies: [],
    }));
    const startBrokerSpy = vi.spyOn(brokerModule, "startBroker").mockImplementation(async () => {
      const db = new BrokerDB(dbPath);
      db.initialize();
      const server = {
        setAgentRegistrationResolver: vi.fn(),
        onAgentMessage: vi.fn(),
        onAgentStatusChange: vi.fn(),
      };
      const stop = vi.fn(async () => {
        db.close();
      });
      return {
        db,
        server,
        lock: {
          isLeader: () => true,
          release: vi.fn(),
        },
        adapters: [],
        addAdapter: vi.fn(),
        stop,
      } as unknown as Awaited<ReturnType<typeof brokerModule.startBroker>>;
    });
    vi.spyOn(SlackAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "getBotUserId").mockReturnValue("U_BOT");

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStart = commands.get("pinet");
    const beforeAgentStart = events.get("before_agent_start") as
      | ((
          event: { systemPrompt: string },
          ctx: ExtensionContext,
        ) => Promise<{ systemPrompt: string }>)
      | undefined;

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStart).toBeDefined();
    expect(beforeAgentStart).toBeDefined();

    await sessionStart?.({}, ctx);
    await pinetStart?.handler("start", ctx);
    expect(startBrokerSpy).toHaveBeenCalledTimes(1);

    const sentinelSystemPrompt = "SENTINEL ROOT PROMPT";
    const result = await beforeAgentStart?.({ systemPrompt: sentinelSystemPrompt }, ctx);
    const nextPrompt = result?.systemPrompt ?? "";

    expect(nextPrompt.startsWith(`${sentinelSystemPrompt}\n\n`)).toBe(true);
    expect(nextPrompt).toContain("First message in a new thread:");
    expect(nextPrompt).toContain("COMMUNICATION STYLE:");
    expect(nextPrompt).toContain("Reaction-triggered requests may appear");
    const brokerPolicyText = "the Pinet BROKER for a fully autonomous / unchained broker lane";
    expect(nextPrompt).toContain(brokerPolicyText);
    expect(nextPrompt).toContain("🚫 BROKER TOOL RESTRICTION:");
    expect(nextPrompt.indexOf("First message in a new thread:")).toBeGreaterThan(
      nextPrompt.indexOf(sentinelSystemPrompt),
    );
    expect(nextPrompt.indexOf("COMMUNICATION STYLE:")).toBeGreaterThan(
      nextPrompt.indexOf("First message in a new thread:"),
    );
    expect(nextPrompt.indexOf("Reaction-triggered requests may appear")).toBeGreaterThan(
      nextPrompt.indexOf("COMMUNICATION STYLE:"),
    );
    expect(nextPrompt.indexOf(brokerPolicyText)).toBeGreaterThan(
      nextPrompt.indexOf("Reaction-triggered requests may appear"),
    );
    expect(nextPrompt.indexOf("🚫 BROKER TOOL RESTRICTION:")).toBeGreaterThan(
      nextPrompt.indexOf(brokerPolicyText),
    );

    await sessionShutdown?.({}, ctx);
  });

  it("sends an iMessage through the broker adapter when enabled", async () => {
    const settingsPath = path.join(testHome, ".pi", "agent", "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        "slack-bridge": {
          allowAllWorkspaceUsers: true,
          imessage: { enabled: true },
        },
      }),
    );

    const dbPath = path.join(testHome, ".pi", "pinet-broker.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn((definition: ToolDefinition) => {
        tools.set(definition.name, definition);
      }),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
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
        getHeader: () => null,
        getLeafId: () => "broker-leaf",
        getSessionFile: () => "/tmp/slack-bridge-imessage-session.json",
      },
    } as unknown as ExtensionContext;

    const restartedDb = new BrokerDB(dbPath);
    restartedDb.initialize();
    const brokerStop = vi.fn(async () => {
      restartedDb.close();
    });
    const adapters: Array<{ name: string; send?: (msg: unknown) => Promise<unknown> }> = [];
    const server = {
      setAgentRegistrationResolver: vi.fn(),
      setOutboundMessageAdapters: vi.fn(),
      onAgentMessage: vi.fn(),
      onAgentStatusChange: vi.fn(),
    };
    const imessageSend = vi.fn(async () => undefined);
    const imessageAdapter = {
      name: "imessage" as const,
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      onInbound: vi.fn(),
      send: imessageSend,
    };

    vi.spyOn(maintenanceModule, "runBrokerMaintenancePass").mockImplementation(() => ({
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 0,
      nudgedAgentIds: [],
      pendingBacklogCount: restartedDb.getBacklogCount("pending"),
      anomalies: [],
    }));
    vi.spyOn(brokerModule, "startBroker").mockResolvedValue({
      db: restartedDb,
      server,
      lock: {
        isLeader: () => true,
        release: vi.fn(),
      },
      adapters,
      addAdapter: vi.fn((adapter) => {
        adapters.push(adapter as (typeof adapters)[number]);
      }),
      stop: brokerStop,
    } as unknown as Awaited<ReturnType<typeof brokerModule.startBroker>>);
    vi.spyOn(SlackAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "getBotUserId").mockReturnValue("U_BOT");
    vi.spyOn(imessageModule, "detectIMessageMvpEnvironment").mockReturnValue({
      platform: "darwin",
      homeDir: testHome,
      messagesDbPath: path.join(testHome, "Library", "Messages", "chat.db"),
      osascriptPath: imessageModule.APPLESCRIPT_BINARY_PATH,
      osascriptAvailable: true,
      messagesDbAvailable: false,
      canAttemptSend: true,
      canAttemptHistoryRead: false,
      readyForLocalMvp: false,
      blockers: ["missing_messages_db"],
    });
    vi.spyOn(imessageModule, "createIMessageAdapter").mockReturnValue(imessageAdapter);

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStart = commands.get("pinet");
    const imessageSendTool = tools.get("imessage_send");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStart).toBeDefined();
    expect(imessageSendTool).toBeDefined();

    await sessionStart?.({}, ctx);
    await pinetStart?.handler("start", ctx);

    const result = await imessageSendTool!.execute("tool-call-1", {
      to: "chat:alice",
      text: "hello from pi",
    });

    expect(server.setOutboundMessageAdapters).toHaveBeenCalledWith(adapters);
    expect(imessageAdapter.connect).toHaveBeenCalledTimes(1);
    expect(imessageSend).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "imessage:chat:alice",
        channel: "chat:alice",
        text: "hello from pi",
      }),
    );
    expect(result).toMatchObject({
      details: {
        threadId: "imessage:chat:alice",
        channel: "chat:alice",
        source: "imessage",
        adapter: "imessage",
      },
    });
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("iMessage send-first mode enabled"),
      "warning",
    );

    await sessionShutdown?.({}, ctx);
    expect(setStatus).toHaveBeenCalled();
  });

  it("warns when iMessage is enabled but send capability is unavailable", async () => {
    const settingsPath = path.join(testHome, ".pi", "agent", "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        "slack-bridge": {
          allowAllWorkspaceUsers: true,
          imessage: { enabled: true },
        },
      }),
    );

    const dbPath = path.join(testHome, ".pi", "pinet-broker.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => true,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify,
        setStatus: vi.fn(),
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "broker-leaf",
        getSessionFile: () => "/tmp/slack-bridge-imessage-warning-session.json",
      },
    } as unknown as ExtensionContext;

    const restartedDb = new BrokerDB(dbPath);
    restartedDb.initialize();
    const brokerStop = vi.fn(async () => {
      restartedDb.close();
    });
    const server = {
      setAgentRegistrationResolver: vi.fn(),
      setOutboundMessageAdapters: vi.fn(),
      onAgentMessage: vi.fn(),
      onAgentStatusChange: vi.fn(),
    };

    vi.spyOn(maintenanceModule, "runBrokerMaintenancePass").mockImplementation(() => ({
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 0,
      nudgedAgentIds: [],
      pendingBacklogCount: restartedDb.getBacklogCount("pending"),
      anomalies: [],
    }));
    vi.spyOn(brokerModule, "startBroker").mockResolvedValue({
      db: restartedDb,
      server,
      lock: {
        isLeader: () => true,
        release: vi.fn(),
      },
      adapters: [],
      addAdapter: vi.fn(),
      stop: brokerStop,
    } as unknown as Awaited<ReturnType<typeof brokerModule.startBroker>>);
    vi.spyOn(SlackAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "getBotUserId").mockReturnValue("U_BOT");
    vi.spyOn(imessageModule, "detectIMessageMvpEnvironment").mockReturnValue({
      platform: "linux",
      homeDir: "/home/goose",
      messagesDbPath: "/home/goose/Library/Messages/chat.db",
      osascriptPath: imessageModule.APPLESCRIPT_BINARY_PATH,
      osascriptAvailable: false,
      messagesDbAvailable: false,
      canAttemptSend: false,
      canAttemptHistoryRead: false,
      readyForLocalMvp: false,
      blockers: ["unsupported_platform"],
    });
    const createAdapterSpy = vi.spyOn(imessageModule, "createIMessageAdapter");

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStart = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStart).toBeDefined();

    await sessionStart?.({}, ctx);
    await pinetStart?.handler("start", ctx);

    expect(createAdapterSpy).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("iMessage adapter unavailable"),
      "warning",
    );

    await sessionShutdown?.({}, ctx);
  });

  it("does not auto-follow into the mesh for headless ephemeral subagent sessions", async () => {
    const settingsPath = `${process.env.HOME}/.pi/agent/settings.json`;
    fs.mkdirSync(`${process.env.HOME}/.pi/agent`, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ "slack-bridge": { autoFollow: true } }));

    const events = new Map<string, EventHandler>();
    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
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
        getHeader: () => null,
        getLeafId: () => "subagent-leaf",
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;

    const connectSpy = vi.spyOn(BrokerClient.prototype, "connect").mockResolvedValue(undefined);
    const registerSpy = vi.spyOn(BrokerClient.prototype, "register");

    slackBridge(pi);

    const restoreStdinIsTTY = stubIsTTY(process.stdin, false);
    const restoreStdoutIsTTY = stubIsTTY(process.stdout, false);
    try {
      await events.get("session_start")?.({}, ctx);
    } finally {
      restoreStdinIsTTY();
      restoreStdoutIsTTY();
    }

    expect(connectSpy).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalled();
  });

  function createFakeWebSocketClass() {
    return class FakeWebSocket {
      static OPEN = 1;
      static CLOSED = 3;
      static instances: FakeWebSocket[] = [];

      readonly url: string;
      readyState = 0;
      readonly close = vi.fn(() => {
        this.readyState = FakeWebSocket.CLOSED;
        this.emitEvent("close");
      });
      readonly send = vi.fn();
      private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

      constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.emitEvent("open");
        });
      }

      addEventListener(type: string, handler: (...args: unknown[]) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(handler);
        this.listeners.set(type, listeners);
      }

      emitEvent(type: string, ...args: unknown[]): void {
        for (const handler of this.listeners.get(type) ?? []) {
          handler(...args);
        }
      }
    };
  }

  it("keeps explicit off mode free of Slack Socket Mode ingress on session start", async () => {
    const settingsPath = `${process.env.HOME}/.pi/agent/settings.json`;
    fs.mkdirSync(`${process.env.HOME}/.pi/agent`, { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        "slack-bridge": { runtimeMode: "off", allowAllWorkspaceUsers: true },
      }),
    );

    const events = new Map<string, EventHandler>();
    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
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
        getHeader: () => null,
        getLeafId: () => "off-leaf",
        getSessionFile: () => "/tmp/slack-bridge-off-session.json",
      },
    } as unknown as ExtensionContext;

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const connectSpy = vi.spyOn(BrokerClient.prototype, "connect").mockResolvedValue(undefined);

    slackBridge(pi);

    await events.get("session_start")?.({}, ctx);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalled();
  });

  it("starts explicit single runtime mode on session start and reports it in /pinet status", async () => {
    const settingsPath = `${process.env.HOME}/.pi/agent/settings.json`;
    fs.mkdirSync(`${process.env.HOME}/.pi/agent`, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ "slack-bridge": { runtimeMode: "single" } }));

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();
    const FakeWebSocket = createFakeWebSocketClass();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
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
        getHeader: () => null,
        getLeafId: () => "single-leaf",
        getSessionFile: () => "/tmp/slack-bridge-single-session.json",
      },
    } as unknown as ExtensionContext;

    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, url: "wss://slack.example/socket" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStatus = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStatus).toBeDefined();

    await sessionStart?.({}, ctx);
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://slack.com/api/apps.connections.open",
      expect.any(Object),
    );
    expect(FakeWebSocket.instances).toHaveLength(1);

    await pinetStatus?.handler("status", ctx);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Mode: single"), "info");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Connection: connected"), "info");

    await sessionShutdown?.({}, ctx);
    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket).toBeDefined();
    if (!firstSocket) {
      throw new Error("Expected a single-mode websocket instance");
    }
    expect(firstSocket.close).toHaveBeenCalled();
  });

  it("warns on default-deny Slack access at startup and reports it in /pinet status", async () => {
    const originalAllowedUsersEnv = process.env.SLACK_ALLOWED_USERS;
    const originalAllowAllEnv = process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS;
    delete process.env.SLACK_ALLOWED_USERS;
    delete process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS;

    const settingsPath = `${process.env.HOME}/.pi/agent/settings.json`;
    fs.mkdirSync(`${process.env.HOME}/.pi/agent`, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ "slack-bridge": { runtimeMode: "single" } }));

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();
    const FakeWebSocket = createFakeWebSocketClass();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
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
        getHeader: () => null,
        getLeafId: () => "single-default-deny-leaf",
        getSessionFile: () => "/tmp/slack-bridge-single-default-deny-session.json",
      },
    } as unknown as ExtensionContext;

    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, url: "wss://slack.example/socket" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStatus = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStatus).toBeDefined();

    await sessionStart?.({}, ctx);
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://slack.com/api/apps.connections.open",
      expect.any(Object),
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Slack access is default-deny because no allowedUsers are configured.",
      ),
      "warning",
    );
    expect(
      notify.mock.calls.some(
        ([message, level]) =>
          level === "warning" &&
          String(message).includes("runtime guardrails are effectively empty"),
      ),
    ).toBe(false);

    await pinetStatus?.handler("status", ctx);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Allowed users: none (default deny; set allowedUsers or allowAllWorkspaceUsers: true)",
      ),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Guardrails: empty (warn-first posture; behavior unchanged)"),
      "info",
    );

    await sessionShutdown?.({}, ctx);
    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket).toBeDefined();
    if (!firstSocket) {
      throw new Error("Expected a default-deny single-mode websocket instance");
    }
    expect(firstSocket.close).toHaveBeenCalled();

    if (originalAllowedUsersEnv === undefined) {
      delete process.env.SLACK_ALLOWED_USERS;
    } else {
      process.env.SLACK_ALLOWED_USERS = originalAllowedUsersEnv;
    }
    if (originalAllowAllEnv === undefined) {
      delete process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS;
    } else {
      process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS = originalAllowAllEnv;
    }
  });

  it("warns when admitted users have effectively empty guardrails and reports the posture in /pinet status", async () => {
    const originalAllowedUsersEnv = process.env.SLACK_ALLOWED_USERS;
    const originalAllowAllEnv = process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS;
    delete process.env.SLACK_ALLOWED_USERS;
    delete process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS;

    const settingsPath = `${process.env.HOME}/.pi/agent/settings.json`;
    fs.mkdirSync(`${process.env.HOME}/.pi/agent`, { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        "slack-bridge": {
          runtimeMode: "single",
          allowedUsers: ["U_SENDER"],
        },
      }),
    );

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();
    const FakeWebSocket = createFakeWebSocketClass();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
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
        getHeader: () => null,
        getLeafId: () => "single-empty-guardrails-leaf",
        getSessionFile: () => "/tmp/slack-bridge-single-empty-guardrails-session.json",
      },
    } as unknown as ExtensionContext;

    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, url: "wss://slack.example/socket" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStatus = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStatus).toBeDefined();

    await sessionStart?.({}, ctx);
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://slack.com/api/apps.connections.open",
      expect.any(Object),
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("runtime guardrails are effectively empty"),
      "warning",
    );

    await pinetStatus?.handler("status", ctx);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Guardrails: empty (warn-first posture; behavior unchanged)"),
      "info",
    );

    await sessionShutdown?.({}, ctx);
    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket).toBeDefined();
    if (!firstSocket) {
      throw new Error("Expected a single-mode websocket instance");
    }
    expect(firstSocket.close).toHaveBeenCalled();

    if (originalAllowedUsersEnv === undefined) {
      delete process.env.SLACK_ALLOWED_USERS;
    } else {
      process.env.SLACK_ALLOWED_USERS = originalAllowedUsersEnv;
    }
    if (originalAllowAllEnv === undefined) {
      delete process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS;
    } else {
      process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS = originalAllowAllEnv;
    }
  });

  it("warns and reports status when live Slack scope drift is detected at startup", async () => {
    const settingsPath = `${process.env.HOME}/.pi/agent/settings.json`;
    fs.mkdirSync(`${process.env.HOME}/.pi/agent`, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ "slack-bridge": { runtimeMode: "single" } }));

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();
    const FakeWebSocket = createFakeWebSocketClass();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
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
        getHeader: () => null,
        getLeafId: () => "single-scope-drift-leaf",
        getSessionFile: () => "/tmp/slack-bridge-single-scope-drift-session.json",
      },
    } as unknown as ExtensionContext;

    const fetchSpy = vi.fn(async (input) => {
      const url = String(input);
      if (url === "https://slack.com/api/apps.connections.open") {
        return new Response(JSON.stringify({ ok: true, url: "wss://slack.example/socket" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://slack.com/api/files.info") {
        return new Response(
          JSON.stringify({ ok: false, error: "missing_scope", needed: "files:read" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url === "https://slack.com/api/files.completeUploadExternal") {
        return new Response(
          JSON.stringify({ ok: false, error: "missing_scope", needed: "files:write" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url === "https://slack.com/api/bookmarks.list") {
        return new Response(
          JSON.stringify({ ok: false, error: "missing_scope", needed: "bookmarks:read" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url === "https://slack.com/api/bookmarks.remove") {
        return new Response(
          JSON.stringify({ ok: false, error: "missing_scope", needed: "bookmarks:write" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url === "https://slack.com/api/pins.list") {
        return new Response(
          JSON.stringify({ ok: false, error: "missing_scope", needed: "pins:read" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url === "https://slack.com/api/pins.add") {
        return new Response(
          JSON.stringify({ ok: false, error: "missing_scope", needed: "pins:write" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStatus = commands.get("pinet");

    await sessionStart?.({}, ctx);
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "Slack scope drift detected: missing bookmarks:read, bookmarks:write, files:read, files:write, pins:read, pins:write.",
        ),
        "warning",
      );
    });
    await pinetStatus?.handler("status", ctx);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Slack scope drift detected: missing bookmarks:read, bookmarks:write, files:read, files:write, pins:read, pins:write.",
      ),
      "warning",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Slack tool health: scope drift — missing bookmarks:read, bookmarks:write, files:read, files:write, pins:read, pins:write",
      ),
      "info",
    );

    await sessionShutdown?.({}, ctx);
  });

  it("transitions from single runtime mode to broker mode without leaving the direct Slack socket open", async () => {
    const settingsPath = `${process.env.HOME}/.pi/agent/settings.json`;
    fs.mkdirSync(`${process.env.HOME}/.pi/agent`, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ "slack-bridge": { runtimeMode: "single" } }));

    const dbPath = path.join(testHome, ".pi", "pinet-broker.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();
    const FakeWebSocket = createFakeWebSocketClass();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
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
        getHeader: () => null,
        getLeafId: () => "broker-leaf",
        getSessionFile: () => "/tmp/slack-bridge-broker-runtime-session.json",
      },
    } as unknown as ExtensionContext;

    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, url: "wss://slack.example/socket" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    const restartedDb = new BrokerDB(dbPath);
    restartedDb.initialize();
    const brokerStop = vi.fn(async () => {
      restartedDb.close();
    });

    vi.spyOn(maintenanceModule, "runBrokerMaintenancePass").mockImplementation(() => ({
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 0,
      nudgedAgentIds: [],
      pendingBacklogCount: restartedDb.getBacklogCount("pending"),
      anomalies: [],
    }));
    vi.spyOn(brokerModule, "startBroker").mockResolvedValue({
      db: restartedDb,
      server: {
        setAgentRegistrationResolver: vi.fn(),
        onAgentMessage: vi.fn(),
        onAgentStatusChange: vi.fn(),
      },
      lock: {
        isLeader: () => true,
        release: vi.fn(),
      },
      adapters: [],
      addAdapter: vi.fn(),
      stop: brokerStop,
    } as unknown as Awaited<ReturnType<typeof brokerModule.startBroker>>);
    vi.spyOn(SlackAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "getBotUserId").mockReturnValue("U_BOT");

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStart = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStart).toBeDefined();

    await sessionStart?.({}, ctx);
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(1);

    await pinetStart?.handler("start", ctx);

    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket).toBeDefined();
    if (!firstSocket) {
      throw new Error("Expected a single-mode websocket instance");
    }
    expect(firstSocket.close).toHaveBeenCalled();
    expect(brokerModule.startBroker).toHaveBeenCalledTimes(1);
    expect(
      fetchSpy.mock.calls.some(
        (call) => String(call.at(0)) === "https://slack.com/api/apps.connections.open",
      ),
    ).toBe(true);

    await sessionShutdown?.({}, ctx);
  });

  it("drains queued single-mode Slack inbox work on agent_end even without Pinet enabled", async () => {
    const settingsPath = `${process.env.HOME}/.pi/agent/settings.json`;
    fs.mkdirSync(`${process.env.HOME}/.pi/agent`, { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ "slack-bridge": { runtimeMode: "single", allowedUsers: ["U_SENDER"] } }),
    );

    const events = new Map<string, EventHandler>();
    const FakeWebSocket = createFakeWebSocketClass();
    const sendUserMessage = vi.fn();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage,
    } as unknown as ExtensionAPI;

    let idle = false;
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => idle,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "single-drain-leaf",
        getSessionFile: () => "/tmp/slack-bridge-single-drain-session.json",
      },
    } as unknown as ExtensionContext;

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://slack.com/api/apps.connections.open") {
        return new Response(JSON.stringify({ ok: true, url: "wss://slack.example/socket" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://slack.com/api/conversations.replies") {
        return new Response(JSON.stringify({ ok: true, messages: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://slack.com/api/users.info") {
        return new Response(JSON.stringify({ ok: true, user: { real_name: "Sender" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://slack.com/api/reactions.add") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const agentEnd = events.get("agent_end");
    const sessionShutdown = events.get("session_shutdown");

    expect(sessionStart).toBeDefined();
    expect(agentEnd).toBeDefined();
    expect(sessionShutdown).toBeDefined();

    await sessionStart?.({}, ctx);
    await Promise.resolve();

    const socket = FakeWebSocket.instances[0] as unknown as {
      emitEvent: (type: string, ...args: unknown[]) => void;
    };
    socket.emitEvent("message", {
      data: JSON.stringify({
        envelope_id: "env-1",
        type: "events_api",
        payload: {
          event: {
            type: "message",
            channel: "D123",
            channel_type: "im",
            user: "U_SENDER",
            text: "hello from Slack inbox",
            ts: "100.1",
          },
        },
      }),
    });

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("https://slack.com/api/users.info", expect.any(Object));
    });
    expect(sendUserMessage).not.toHaveBeenCalled();

    idle = true;
    await agentEnd?.({ type: "agent_end", messages: [] }, ctx);

    await vi.waitFor(() => {
      expect(sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("hello from Slack inbox"),
      );
    });

    await sessionShutdown?.({}, ctx);
  });

  it("keeps single-mode Slack thread context local after ingress moves into SinglePlayerRuntime", async () => {
    const settingsPath = `${process.env.HOME}/.pi/agent/settings.json`;
    fs.mkdirSync(`${process.env.HOME}/.pi/agent`, { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ "slack-bridge": { runtimeMode: "single", allowedUsers: ["U_SENDER"] } }),
    );

    const tools = new Map<string, ToolDefinition>();
    const events = new Map<string, EventHandler>();
    const FakeWebSocket = createFakeWebSocketClass();
    const sendUserMessage = vi.fn();
    const appendEntry = vi.fn();

    const pi = {
      appendEntry,
      registerTool: vi.fn((definition: ToolDefinition) => {
        tools.set(definition.name, definition);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage,
    } as unknown as ExtensionAPI;

    const idle = false;
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => idle,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "single-thread-context-leaf",
        getSessionFile: () => "/tmp/slack-bridge-single-thread-context-session.json",
      },
    } as unknown as ExtensionContext;

    const fetchSpy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://slack.com/api/apps.connections.open") {
        return new Response(JSON.stringify({ ok: true, url: "wss://slack.example/socket" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://slack.com/api/conversations.replies") {
        return new Response(JSON.stringify({ ok: true, messages: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://slack.com/api/users.info") {
        return new Response(JSON.stringify({ ok: true, user: { real_name: "Sender" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://slack.com/api/reactions.add") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://slack.com/api/reactions.remove") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://slack.com/api/chat.postMessage") {
        return new Response(JSON.stringify({ ok: true, message: { ts: "300.1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const slackSend = tools.get("slack_send");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(slackSend).toBeDefined();

    await sessionStart?.({}, ctx);
    await Promise.resolve();

    const socket = FakeWebSocket.instances[0] as unknown as {
      emitEvent: (type: string, ...args: unknown[]) => void;
    };
    socket.emitEvent("message", {
      data: JSON.stringify({
        envelope_id: "env-1",
        type: "events_api",
        payload: {
          event: {
            type: "message",
            channel: "D123",
            channel_type: "im",
            user: "U_SENDER",
            text: "hello from the first direct thread",
            ts: "100.1",
          },
        },
      }),
    });

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("https://slack.com/api/users.info", expect.any(Object));
    });

    socket.emitEvent("message", {
      data: JSON.stringify({
        envelope_id: "env-2",
        type: "events_api",
        payload: {
          event: {
            type: "message",
            channel: "D999",
            channel_type: "im",
            user: "U_SENDER",
            text: "hello from a newer direct thread",
            ts: "200.1",
          },
        },
      }),
    });

    await slackSend!.execute("tool-1", {
      thread_ts: "100.1",
      text: "reply from the agent",
    });

    const chatPostMessageCall = fetchSpy.mock.calls.find(
      ([input]) => String(input) === "https://slack.com/api/chat.postMessage",
    );
    expect(chatPostMessageCall).toBeDefined();
    const chatPostMessageBody = JSON.parse(String(chatPostMessageCall?.[1]?.body ?? "{}")) as {
      channel?: string;
      metadata?: {
        event_payload?: { agent_owner?: string };
      };
      thread_ts?: string;
    };
    expect(chatPostMessageBody.channel).toBe("D123");
    expect(chatPostMessageBody.thread_ts).toBe("100.1");

    const reactionsRemoveCall = fetchSpy.mock.calls.find(
      ([input]) => String(input) === "https://slack.com/api/reactions.remove",
    );
    expect(reactionsRemoveCall).toBeDefined();
    const reactionsRemoveBody = JSON.parse(String(reactionsRemoveCall?.[1]?.body ?? "{}")) as {
      channel?: string;
      name?: string;
      timestamp?: string;
    };
    expect(reactionsRemoveBody).toMatchObject({
      channel: "D123",
      name: "eyes",
      timestamp: "100.1",
    });

    expect(sendUserMessage).not.toHaveBeenCalled();

    await sessionShutdown?.({}, ctx);

    const persistedState = appendEntry.mock.calls.at(-1)?.[1] as {
      threads?: Array<[string, { owner?: string }]>;
    };
    const firstThread = persistedState.threads?.find(([threadTs]) => threadTs === "100.1")?.[1];
    expect(firstThread?.owner).toBe(chatPostMessageBody.metadata?.event_payload?.agent_owner);
  });

  it("does not reschedule direct Slack reconnects after aborting a single-mode startup during broker transition", async () => {
    vi.useFakeTimers();

    const settingsPath = `${process.env.HOME}/.pi/agent/settings.json`;
    fs.mkdirSync(`${process.env.HOME}/.pi/agent`, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ "slack-bridge": { runtimeMode: "single" } }));

    const dbPath = path.join(testHome, ".pi", "pinet-broker.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => true,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "abort-single-startup-leaf",
        getSessionFile: () => "/tmp/slack-bridge-abort-single-startup-session.json",
      },
    } as unknown as ExtensionContext;

    const fetchSpy = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };

        if (signal?.aborted) {
          rejectAbort();
          return;
        }

        signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const restartedDb = new BrokerDB(dbPath);
    restartedDb.initialize();
    const brokerStop = vi.fn(async () => {
      restartedDb.close();
    });

    vi.spyOn(maintenanceModule, "runBrokerMaintenancePass").mockImplementation(() => ({
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 0,
      nudgedAgentIds: [],
      pendingBacklogCount: restartedDb.getBacklogCount("pending"),
      anomalies: [],
    }));
    vi.spyOn(brokerModule, "startBroker").mockResolvedValue({
      db: restartedDb,
      server: {
        setAgentRegistrationResolver: vi.fn(),
        onAgentMessage: vi.fn(),
        onAgentStatusChange: vi.fn(),
      },
      lock: {
        isLeader: () => true,
        release: vi.fn(),
      },
      adapters: [],
      addAdapter: vi.fn(),
      stop: brokerStop,
    } as unknown as Awaited<ReturnType<typeof brokerModule.startBroker>>);
    vi.spyOn(SlackAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "getBotUserId").mockReturnValue("U_BOT");

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStart = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStart).toBeDefined();

    try {
      const startup = sessionStart?.({}, ctx);
      await Promise.resolve();
      expect(
        fetchSpy.mock.calls.some(
          (call) => String(call.at(0)) === "https://slack.com/api/apps.connections.open",
        ),
      ).toBe(true);

      await pinetStart?.handler("start", ctx);
      await startup;

      await vi.advanceTimersByTimeAsync(5_001);
      expect(
        fetchSpy.mock.calls.some(
          (call) => String(call.at(0)) === "https://slack.com/api/apps.connections.open",
        ),
      ).toBe(true);
      expect(brokerModule.startBroker).toHaveBeenCalledTimes(1);

      await sessionShutdown?.({}, ctx);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("slack-bridge Pinet reconnect", () => {
  const originalBotToken = process.env.SLACK_BOT_TOKEN;
  const originalAppToken = process.env.SLACK_APP_TOKEN;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    process.env.HOME = "/tmp/slack-bridge-test-home";
  });

  afterEach(() => {
    if (originalBotToken === undefined) {
      delete process.env.SLACK_BOT_TOKEN;
    } else {
      process.env.SLACK_BOT_TOKEN = originalBotToken;
    }

    if (originalAppToken === undefined) {
      delete process.env.SLACK_APP_TOKEN;
    } else {
      process.env.SLACK_APP_TOKEN = originalAppToken;
    }

    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refreshes follower registration state after broker reconnect", async () => {
    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn((definition: ToolDefinition) => {
        tools.set(definition.name, definition);
      }),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => false,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify,
        setStatus,
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "leaf",
        getSessionFile: () => "/tmp/slack-bridge-session.json",
      },
    } as unknown as ExtensionContext;

    let disconnectHandler: (() => void) | null = null;
    let reconnectHandler: (() => void) | null = null;
    let followerConnected = false;
    const registerCalls: Array<{
      name: string;
      emoji: string;
      metadata?: Record<string, unknown>;
      stableId?: string;
    }> = [];

    vi.spyOn(BrokerClient.prototype, "connect").mockImplementation(async () => {
      followerConnected = true;
    });
    vi.spyOn(BrokerClient.prototype, "isConnected").mockImplementation(() => followerConnected);
    vi.spyOn(BrokerClient.prototype, "register").mockImplementation(async function (
      this: BrokerClient,
      name: string,
      emoji: string,
      metadata?: Record<string, unknown>,
      stableId?: string,
    ) {
      const result = {
        agentId: "worker-1",
        name,
        emoji,
        metadata: metadata ?? null,
      };
      (
        this as unknown as {
          registeredIdentity: typeof result | null;
          registrationSnapshot: {
            name: string;
            emoji: string;
            metadata?: Record<string, unknown>;
            stableId?: string;
          } | null;
        }
      ).registeredIdentity = result;
      (
        this as unknown as {
          registrationSnapshot: {
            name: string;
            emoji: string;
            metadata?: Record<string, unknown>;
            stableId?: string;
          } | null;
        }
      ).registrationSnapshot = {
        name,
        emoji,
        ...(metadata ? { metadata } : {}),
        ...(stableId ? { stableId } : {}),
      };
      registerCalls.push({ name, emoji, metadata, stableId });
      return result;
    });
    vi.spyOn(BrokerClient.prototype, "claimThread").mockResolvedValue({ claimed: true });
    vi.spyOn(BrokerClient.prototype, "pollInbox").mockResolvedValue([]);
    vi.spyOn(BrokerClient.prototype, "updateStatus").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "ackMessages").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnectGracefully").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "unregister").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onDisconnect").mockImplementation((handler) => {
      disconnectHandler = handler;
    });
    vi.spyOn(BrokerClient.prototype, "onReconnect").mockImplementation((handler) => {
      reconnectHandler = handler;
    });

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const follow = commands.get("pinet");
    const pinetStatus = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(follow).toBeDefined();
    expect(pinetStatus).toBeDefined();

    await sessionStart?.({}, ctx);
    await follow?.handler("follow", ctx);

    expect(registerCalls).toHaveLength(1);
    expect(disconnectHandler).toBeTypeOf("function");
    expect(reconnectHandler).toBeTypeOf("function");

    if (!disconnectHandler || !reconnectHandler) {
      throw new Error("Reconnect handlers were not registered");
    }

    const activeDisconnectHandler: () => void = disconnectHandler;
    const activeReconnectHandler: () => void = reconnectHandler;
    const runDisconnect = (): void => {
      followerConnected = false;
      activeDisconnectHandler();
    };
    const runReconnect = (): void => {
      followerConnected = true;
      activeReconnectHandler();
    };

    runDisconnect();

    notify.mockClear();
    await pinetStatus?.handler("status", ctx);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Connection: disconnected"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Runtime health: reconnecting — broker disconnected"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Next step: Wait for automatic reconnect. If it does not recover, run /pinet follow.",
      ),
      "info",
    );

    runReconnect();

    await vi.waitFor(() => {
      expect(registerCalls).toHaveLength(2);
    });

    expect(registerCalls[1]?.stableId).toBe(registerCalls[0]?.stableId);
    expect(registerCalls[1]?.metadata).toMatchObject({
      role: "worker",
      capabilities: expect.objectContaining({ role: "worker" }),
    });
    expect(notify).toHaveBeenCalledWith("Pinet broker reconnected", "info");

    notify.mockClear();
    await pinetStatus?.handler("status", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Connection: connected"), "info");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Runtime health: healthy"), "info");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Next step: None."), "info");

    await sessionShutdown?.({}, ctx);
    expect(setStatus).toHaveBeenCalled();
  });

  it("reports degraded follower diagnostics when reconnect registration refresh fails", async () => {
    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => false,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify,
        setStatus,
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "leaf",
        getSessionFile: () => "/tmp/slack-bridge-session.json",
      },
    } as unknown as ExtensionContext;

    let disconnectHandler: (() => void) | null = null;
    let reconnectHandler: (() => void) | null = null;
    let followerConnected = false;
    let registerAttempt = 0;

    vi.spyOn(BrokerClient.prototype, "connect").mockImplementation(async () => {
      followerConnected = true;
    });
    vi.spyOn(BrokerClient.prototype, "isConnected").mockImplementation(() => followerConnected);
    vi.spyOn(BrokerClient.prototype, "register").mockImplementation(async function (
      this: BrokerClient,
      name: string,
      emoji: string,
      metadata?: Record<string, unknown>,
      stableId?: string,
    ) {
      registerAttempt += 1;
      if (registerAttempt === 2) {
        throw new Error("refresh failed once");
      }

      const result = {
        agentId: "worker-1",
        name,
        emoji,
        metadata: metadata ?? null,
      };
      (
        this as unknown as {
          registeredIdentity: typeof result | null;
          registrationSnapshot: {
            name: string;
            emoji: string;
            metadata?: Record<string, unknown>;
            stableId?: string;
          } | null;
        }
      ).registeredIdentity = result;
      (
        this as unknown as {
          registrationSnapshot: {
            name: string;
            emoji: string;
            metadata?: Record<string, unknown>;
            stableId?: string;
          } | null;
        }
      ).registrationSnapshot = {
        name,
        emoji,
        ...(metadata ? { metadata } : {}),
        ...(stableId ? { stableId } : {}),
      };
      return result;
    });
    vi.spyOn(BrokerClient.prototype, "claimThread").mockResolvedValue({ claimed: true });
    vi.spyOn(BrokerClient.prototype, "pollInbox").mockResolvedValue([]);
    vi.spyOn(BrokerClient.prototype, "updateStatus").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "ackMessages").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnectGracefully").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "unregister").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onDisconnect").mockImplementation((handler) => {
      disconnectHandler = handler;
    });
    vi.spyOn(BrokerClient.prototype, "onReconnect").mockImplementation((handler) => {
      reconnectHandler = handler;
    });

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const follow = commands.get("pinet");
    const pinetStatus = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(follow).toBeDefined();
    expect(pinetStatus).toBeDefined();

    await sessionStart?.({}, ctx);
    await follow?.handler("follow", ctx);

    expect(registerAttempt).toBe(1);
    expect(disconnectHandler).toBeTypeOf("function");
    expect(reconnectHandler).toBeTypeOf("function");

    if (!disconnectHandler || !reconnectHandler) {
      throw new Error("Reconnect handlers were not registered");
    }

    notify.mockClear();
    const activeDisconnectHandler: () => void = disconnectHandler;
    const activeReconnectHandler: () => void = reconnectHandler;
    followerConnected = false;
    activeDisconnectHandler();
    followerConnected = true;
    activeReconnectHandler();

    await vi.waitFor(() => {
      expect(registerAttempt).toBe(2);
    });
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith("Pinet broker reconnected", "info");
    });

    notify.mockClear();
    await pinetStatus?.handler("status", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Mode: follower"), "info");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Connection: connected"), "info");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Runtime health: degraded — registration refresh failed after reconnect (refresh failed once)",
      ),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Next step: Follower kept the last registered identity. If status or ownership looks stale, run /pinet follow.",
      ),
      "info",
    );

    await sessionShutdown?.({}, ctx);
  });

  it("stops follower reconnect retries after a terminal name conflict and allows a clean retry", async () => {
    const originalNickname = process.env.PI_NICKNAME;
    process.env.PI_NICKNAME = "Reserved Crane";

    try {
      const tools = new Map<string, ToolDefinition>();
      const commands = new Map<string, CommandDefinition>();
      const events = new Map<string, EventHandler>();

      const pi = {
        appendEntry: vi.fn(),
        registerTool: vi.fn((definition: ToolDefinition) => {
          tools.set(definition.name, definition);
        }),
        registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
          commands.set(name, definition);
        }),
        on: vi.fn((eventName: string, handler: EventHandler) => {
          events.set(eventName, handler);
        }),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI;

      const setStatus = vi.fn();
      const notify = vi.fn();
      const ctx = {
        cwd: process.cwd(),
        hasUI: true,
        isIdle: () => false,
        ui: {
          theme: {
            fg: (_color: string, text: string) => text,
          },
          notify,
          setStatus,
        },
        sessionManager: {
          getEntries: () => [],
          getHeader: () => null,
          getLeafId: () => "leaf",
          getSessionFile: () => "/tmp/slack-bridge-session.json",
        },
      } as unknown as ExtensionContext;

      let disconnectHandler: (() => void) | null = null;
      let reconnectFailedHandler: ((error: Error) => void) | null = null;
      let followerConnected = false;
      const registerCalls: Array<{
        name: string;
        emoji: string;
        metadata?: Record<string, unknown>;
        stableId?: string;
      }> = [];

      const connect = vi.spyOn(BrokerClient.prototype, "connect").mockImplementation(async () => {
        followerConnected = true;
      });
      vi.spyOn(BrokerClient.prototype, "isConnected").mockImplementation(() => followerConnected);
      vi.spyOn(BrokerClient.prototype, "register").mockImplementation(async function (
        this: BrokerClient,
        name: string,
        emoji: string,
        metadata?: Record<string, unknown>,
        stableId?: string,
      ) {
        const result = {
          agentId: "worker-1",
          name,
          emoji,
          metadata: metadata ?? null,
        };
        (
          this as unknown as {
            registeredIdentity: typeof result | null;
            registrationSnapshot: {
              name: string;
              emoji: string;
              metadata?: Record<string, unknown>;
              stableId?: string;
            } | null;
          }
        ).registeredIdentity = result;
        (
          this as unknown as {
            registrationSnapshot: {
              name: string;
              emoji: string;
              metadata?: Record<string, unknown>;
              stableId?: string;
            } | null;
          }
        ).registrationSnapshot = {
          name,
          emoji,
          ...(metadata ? { metadata } : {}),
          ...(stableId ? { stableId } : {}),
        };
        registerCalls.push({ name, emoji, metadata, stableId });
        return result;
      });
      vi.spyOn(BrokerClient.prototype, "claimThread").mockResolvedValue({ claimed: true });
      vi.spyOn(BrokerClient.prototype, "pollInbox").mockResolvedValue([]);
      vi.spyOn(BrokerClient.prototype, "updateStatus").mockResolvedValue(undefined);
      vi.spyOn(BrokerClient.prototype, "ackMessages").mockResolvedValue(undefined);
      const disconnectGracefully = vi
        .spyOn(BrokerClient.prototype, "disconnectGracefully")
        .mockResolvedValue(undefined);
      vi.spyOn(BrokerClient.prototype, "unregister").mockResolvedValue(undefined);
      vi.spyOn(BrokerClient.prototype, "disconnect").mockImplementation(() => {
        /* mocked */
      });
      vi.spyOn(BrokerClient.prototype, "onDisconnect").mockImplementation((handler) => {
        disconnectHandler = handler;
      });
      vi.spyOn(BrokerClient.prototype, "onReconnect").mockImplementation(() => {
        /* mocked */
      });
      vi.spyOn(BrokerClient.prototype, "onReconnectFailed").mockImplementation((handler) => {
        reconnectFailedHandler = handler;
      });

      slackBridge(pi);

      const sessionStart = events.get("session_start");
      const sessionShutdown = events.get("session_shutdown");
      const follow = commands.get("pinet");
      const pinetStatus = commands.get("pinet");

      expect(sessionStart).toBeDefined();
      expect(sessionShutdown).toBeDefined();
      expect(follow).toBeDefined();
      expect(pinetStatus).toBeDefined();

      await sessionStart?.({}, ctx);
      await follow?.handler("follow", ctx);

      expect(registerCalls).toHaveLength(1);
      expect(registerCalls[0]?.name).toBe("Reserved Crane");
      expect(disconnectHandler).toBeTypeOf("function");
      expect(reconnectFailedHandler).toBeTypeOf("function");

      if (!disconnectHandler || !reconnectFailedHandler) {
        throw new Error("Reconnect handlers were not registered");
      }

      const activeDisconnectHandler: () => void = disconnectHandler;
      const activeReconnectFailedHandler: (error: Error) => void = reconnectFailedHandler;
      const runDisconnect = (): void => {
        followerConnected = false;
        activeDisconnectHandler();
      };

      runDisconnect();
      activeReconnectFailedHandler(
        new Error(
          'Agent name "Reserved Crane" is already reserved. Retry with a different name or leave the name empty so the broker can assign one.',
        ),
      );

      await vi.waitFor(() => {
        expect(disconnectGracefully).toHaveBeenCalledTimes(1);
      });

      await Promise.resolve();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(registerCalls).toHaveLength(1);

      expect(notify).toHaveBeenCalledWith("Pinet broker disconnected — reconnecting...", "warning");
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(
          'Pinet reconnect stopped: Agent name "Reserved Crane" is already reserved.',
        ),
        "error",
      );
      expect(setStatus).toHaveBeenCalledWith("slack-bridge", expect.stringContaining("✗"));

      notify.mockClear();
      await pinetStatus?.handler("status", ctx);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Mode: off"), "info");
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Connection: disconnected"),
        "info",
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(
          'Runtime health: error — automatic reconnect stopped (Agent name "Reserved Crane" is already reserved. Retry with a different name or leave the name empty so the broker can assign one.)',
        ),
        "info",
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "Next step: Fix the reported error, then run /pinet follow to retry.",
        ),
        "info",
      );

      await follow?.handler("follow", ctx);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(registerCalls).toHaveLength(2);
      expect(registerCalls[1]?.name).toBe("Reserved Crane");

      notify.mockClear();
      await pinetStatus?.handler("status", ctx);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Mode: follower"), "info");
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Connection: connected"), "info");
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Runtime health: healthy"),
        "info",
      );

      await sessionShutdown?.({}, ctx);
    } finally {
      if (originalNickname === undefined) {
        delete process.env.PI_NICKNAME;
      } else {
        process.env.PI_NICKNAME = originalNickname;
      }
    }
  });

  it("surfaces follower poll failures in /pinet status and clears them after recovery", async () => {
    vi.useFakeTimers();

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => false,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify,
        setStatus,
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "leaf",
        getSessionFile: () => "/tmp/slack-bridge-session.json",
      },
    } as unknown as ExtensionContext;

    let followerConnected = false;
    let pollAttempt = 0;
    vi.spyOn(BrokerClient.prototype, "connect").mockImplementation(async () => {
      followerConnected = true;
    });
    vi.spyOn(BrokerClient.prototype, "isConnected").mockImplementation(() => followerConnected);
    vi.spyOn(BrokerClient.prototype, "register").mockResolvedValue({
      agentId: "worker-1",
      name: "Agent",
      emoji: "🦙",
      metadata: { role: "worker", capabilities: { role: "worker" } },
    });
    vi.spyOn(BrokerClient.prototype, "claimThread").mockResolvedValue({ claimed: true });
    vi.spyOn(BrokerClient.prototype, "pollInbox").mockImplementation(async () => {
      pollAttempt += 1;
      if (pollAttempt === 1) {
        throw new Error("poll failed once");
      }
      return [];
    });
    vi.spyOn(BrokerClient.prototype, "updateStatus").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "ackMessages").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnectGracefully").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "unregister").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onDisconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onReconnect").mockImplementation(() => {
      /* mocked */
    });

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const follow = commands.get("pinet");
    const pinetStatus = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(follow).toBeDefined();
    expect(pinetStatus).toBeDefined();

    try {
      await sessionStart?.({}, ctx);
      await follow?.handler("follow", ctx);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(pollAttempt).toBe(1);

      notify.mockClear();
      await pinetStatus?.handler("status", ctx);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Mode: follower"), "info");
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Connection: connected"), "info");
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "Runtime health: degraded — inbox polling failed (poll failed once)",
        ),
        "info",
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "Next step: Watch the next poll cycle. If failures continue, inspect the broker and run /pinet follow.",
        ),
        "info",
      );

      await vi.advanceTimersByTimeAsync(2_000);
      expect(pollAttempt).toBe(2);

      notify.mockClear();
      await pinetStatus?.handler("status", ctx);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Runtime health: healthy"),
        "info",
      );
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Next step: None."), "info");

      await sessionShutdown?.({}, ctx);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps worker identities session-scoped across clean restarts in the same repo checkout", async () => {
    const registerCalls: Array<{ stableId?: string }> = [];

    vi.spyOn(BrokerClient.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "register").mockImplementation(
      async (
        _name: string,
        _emoji: string,
        _metadata?: Record<string, unknown>,
        stableId?: string,
      ) => {
        registerCalls.push({ stableId });
        return {
          agentId: "worker-1",
          name: "Agent",
          emoji: "🦙",
          metadata: { role: "worker", capabilities: { role: "worker" } },
        };
      },
    );
    vi.spyOn(BrokerClient.prototype, "claimThread").mockResolvedValue({ claimed: true });
    vi.spyOn(BrokerClient.prototype, "pollInbox").mockResolvedValue([]);
    vi.spyOn(BrokerClient.prototype, "updateStatus").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "ackMessages").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnectGracefully").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "unregister").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onDisconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onReconnect").mockImplementation(() => {
      /* mocked */
    });

    function buildFollowerRuntime(sessionFile: string, leafId: string) {
      const commands = new Map<string, CommandDefinition>();
      const events = new Map<string, EventHandler>();
      const pi = {
        appendEntry: vi.fn(),
        registerTool: vi.fn(),
        registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
          commands.set(name, definition);
        }),
        on: vi.fn((eventName: string, handler: EventHandler) => {
          events.set(eventName, handler);
        }),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI;

      const ctx = {
        cwd: process.cwd(),
        hasUI: true,
        isIdle: () => true,
        ui: {
          theme: {
            fg: (_color: string, text: string) => text,
          },
          notify: vi.fn(),
          setStatus: vi.fn(),
        },
        sessionManager: {
          getEntries: () => [],
          getHeader: () => null,
          getLeafId: () => leafId,
          getSessionFile: () => sessionFile,
        },
      } as unknown as ExtensionContext;

      slackBridge(pi);
      return {
        ctx,
        sessionStart: events.get("session_start"),
        sessionShutdown: events.get("session_shutdown"),
        follow: commands.get("pinet"),
      };
    }

    const first = buildFollowerRuntime("/tmp/slack-bridge-worker-a.json", "worker-leaf-a");
    expect(first.sessionStart).toBeDefined();
    expect(first.sessionShutdown).toBeDefined();
    expect(first.follow).toBeDefined();
    await first.sessionStart?.({}, first.ctx);
    await first.follow?.handler("follow", first.ctx);
    await first.sessionShutdown?.({}, first.ctx);

    const second = buildFollowerRuntime("/tmp/slack-bridge-worker-b.json", "worker-leaf-b");
    expect(second.sessionStart).toBeDefined();
    expect(second.sessionShutdown).toBeDefined();
    expect(second.follow).toBeDefined();
    await second.sessionStart?.({}, second.ctx);
    await second.follow?.handler("follow", second.ctx);
    await second.sessionShutdown?.({}, second.ctx);

    expect(registerCalls).toHaveLength(2);
    expect(registerCalls[0]?.stableId).toBeTruthy();
    expect(registerCalls[1]?.stableId).toBeTruthy();
    expect(registerCalls[0]?.stableId).not.toBe(registerCalls[1]?.stableId);
    expect(registerCalls[0]?.stableId).toContain(":session:");
    expect(registerCalls[1]?.stableId).toContain(":session:");
  });

  it("keeps broker identity stable across a top-level reload in the same session", async () => {
    const dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "slack-bridge-broker-reload-")),
      "pinet-broker.db",
    );
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const startedDbs: BrokerDB[] = [];
    vi.spyOn(maintenanceModule, "runBrokerMaintenancePass").mockImplementation((db) => ({
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 0,
      nudgedAgentIds: [],
      pendingBacklogCount: db.getBacklogCount("pending"),
      anomalies: [],
    }));
    vi.spyOn(brokerModule, "startBroker").mockImplementation(async () => {
      const db = new BrokerDB(dbPath);
      db.initialize();
      startedDbs.push(db);
      return {
        db,
        server: {
          setAgentRegistrationResolver: vi.fn(),
          onAgentMessage: vi.fn(),
          onAgentStatusChange: vi.fn(),
        },
        lock: {
          isLeader: () => true,
          release: vi.fn(),
        },
        adapters: [],
        addAdapter: vi.fn(),
        stop: vi.fn(async () => {
          db.close();
        }),
      } as unknown as Awaited<ReturnType<typeof brokerModule.startBroker>>;
    });
    vi.spyOn(SlackAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "getBotUserId").mockReturnValue("U_BOT");

    function readBrokerIdentity(db: BrokerDB) {
      const broker = db.getAllAgents().find((agent) => agent.metadata?.role === "broker");
      if (!broker) {
        throw new Error("Expected broker to be registered");
      }
      return {
        id: broker.id,
        stableId: broker.stableId ?? null,
        name: broker.name,
        emoji: broker.emoji,
      };
    }

    function buildBrokerRuntime(savedState: Record<string, unknown> | null) {
      const commands = new Map<string, CommandDefinition>();
      const events = new Map<string, EventHandler>();
      let persistedState: Record<string, unknown> | null = null;
      const pi = {
        appendEntry: vi.fn((customType: string, data: Record<string, unknown>) => {
          if (customType === "slack-bridge-state") {
            persistedState = data;
          }
        }),
        registerTool: vi.fn(),
        registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
          commands.set(name, definition);
        }),
        on: vi.fn((eventName: string, handler: EventHandler) => {
          events.set(eventName, handler);
        }),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI;

      const ctx = {
        cwd: process.cwd(),
        hasUI: true,
        isIdle: () => true,
        ui: {
          theme: {
            fg: (_color: string, text: string) => text,
          },
          notify: vi.fn(),
          setStatus: vi.fn(),
        },
        sessionManager: {
          getEntries: () =>
            savedState
              ? [{ type: "custom", customType: "slack-bridge-state", data: savedState }]
              : [],
          getHeader: () => null,
          getLeafId: () => "broker-reload-leaf",
          getSessionFile: () => "/tmp/slack-bridge-broker-reload-session.json",
        },
      } as unknown as ExtensionContext;

      slackBridge(pi);
      return {
        ctx,
        sessionStart: events.get("session_start"),
        sessionShutdown: events.get("session_shutdown"),
        pinetStart: commands.get("pinet"),
        getPersistedState: () => persistedState,
      };
    }

    const first = buildBrokerRuntime(null);
    expect(first.sessionStart).toBeDefined();
    expect(first.sessionShutdown).toBeDefined();
    expect(first.pinetStart).toBeDefined();
    await first.sessionStart?.({}, first.ctx);
    await first.pinetStart?.handler("start", first.ctx);
    const initialBrokerIdentity = readBrokerIdentity(startedDbs[0]!);
    await first.sessionShutdown?.({}, first.ctx);

    const persistedState = first.getPersistedState();
    expect(persistedState).toMatchObject({
      brokerStableId: initialBrokerIdentity.stableId,
      lastPinetRole: "broker",
    });

    const second = buildBrokerRuntime(persistedState);
    expect(second.sessionStart).toBeDefined();
    expect(second.sessionShutdown).toBeDefined();
    expect(second.pinetStart).toBeDefined();
    await second.sessionStart?.({}, second.ctx);
    await second.pinetStart?.handler("start", second.ctx);
    const reloadedBrokerIdentity = readBrokerIdentity(startedDbs[1]!);

    expect(reloadedBrokerIdentity).toEqual(initialBrokerIdentity);

    await second.sessionShutdown?.({}, second.ctx);
  });

  it("keeps broker identity stable across clean restarts in the same repo checkout", async () => {
    const dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "slack-bridge-broker-restart-")),
      "pinet-broker.db",
    );
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const startedDbs: BrokerDB[] = [];
    vi.spyOn(maintenanceModule, "runBrokerMaintenancePass").mockImplementation((db) => ({
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 0,
      nudgedAgentIds: [],
      pendingBacklogCount: db.getBacklogCount("pending"),
      anomalies: [],
    }));
    vi.spyOn(brokerModule, "startBroker").mockImplementation(async () => {
      const db = new BrokerDB(dbPath);
      db.initialize();
      startedDbs.push(db);
      return {
        db,
        server: {
          setAgentRegistrationResolver: vi.fn(),
          onAgentMessage: vi.fn(),
          onAgentStatusChange: vi.fn(),
        },
        lock: {
          isLeader: () => true,
          release: vi.fn(),
        },
        adapters: [],
        addAdapter: vi.fn(),
        stop: vi.fn(async () => {
          db.close();
        }),
      } as unknown as Awaited<ReturnType<typeof brokerModule.startBroker>>;
    });
    vi.spyOn(SlackAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "getBotUserId").mockReturnValue("U_BOT");

    function readBrokerIdentity(db: BrokerDB) {
      const broker = db.getAllAgents().find((agent) => agent.metadata?.role === "broker");
      if (!broker) {
        throw new Error("Expected broker to be registered");
      }
      return {
        id: broker.id,
        stableId: broker.stableId ?? null,
        name: broker.name,
        emoji: broker.emoji,
      };
    }

    function buildBrokerRuntime(sessionFile: string, leafId: string) {
      const commands = new Map<string, CommandDefinition>();
      const events = new Map<string, EventHandler>();
      const pi = {
        appendEntry: vi.fn(),
        registerTool: vi.fn(),
        registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
          commands.set(name, definition);
        }),
        on: vi.fn((eventName: string, handler: EventHandler) => {
          events.set(eventName, handler);
        }),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI;

      const ctx = {
        cwd: process.cwd(),
        hasUI: true,
        isIdle: () => true,
        ui: {
          theme: {
            fg: (_color: string, text: string) => text,
          },
          notify: vi.fn(),
          setStatus: vi.fn(),
        },
        sessionManager: {
          getEntries: () => [],
          getHeader: () => null,
          getLeafId: () => leafId,
          getSessionFile: () => sessionFile,
        },
      } as unknown as ExtensionContext;

      slackBridge(pi);
      return {
        ctx,
        sessionStart: events.get("session_start"),
        sessionShutdown: events.get("session_shutdown"),
        pinetStart: commands.get("pinet"),
      };
    }

    const first = buildBrokerRuntime(
      "/tmp/slack-bridge-broker-restart-a.json",
      "broker-restart-leaf-a",
    );
    expect(first.sessionStart).toBeDefined();
    expect(first.sessionShutdown).toBeDefined();
    expect(first.pinetStart).toBeDefined();
    await first.sessionStart?.({}, first.ctx);
    await first.pinetStart?.handler("start", first.ctx);
    const initialBrokerIdentity = readBrokerIdentity(startedDbs[0]!);
    await first.sessionShutdown?.({}, first.ctx);

    const second = buildBrokerRuntime(
      "/tmp/slack-bridge-broker-restart-b.json",
      "broker-restart-leaf-b",
    );
    expect(second.sessionStart).toBeDefined();
    expect(second.sessionShutdown).toBeDefined();
    expect(second.pinetStart).toBeDefined();
    await second.sessionStart?.({}, second.ctx);
    await second.pinetStart?.handler("start", second.ctx);
    const restartedBrokerIdentity = readBrokerIdentity(startedDbs[1]!);

    expect(restartedBrokerIdentity).toEqual(initialBrokerIdentity);

    await second.sessionShutdown?.({}, second.ctx);
  });

  it("does not reclaim restored source-less threads as slack on follow or reconnect", async () => {
    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => false,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify,
        setStatus,
      },
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "slack-bridge-state",
            data: {
              agentName: "Agent",
              agentEmoji: "🦙",
              agentStableId: "stable-worker",
              threads: [
                [
                  "t-imessage",
                  {
                    channelId: "chat:alice",
                    threadTs: "t-imessage",
                    userId: "alice",
                    owner: "Agent",
                  },
                ],
              ],
            },
          },
        ],
        getHeader: () => null,
        getLeafId: () => "leaf",
        getSessionFile: () => "/tmp/slack-bridge-session.json",
      },
    } as unknown as ExtensionContext;

    let reconnectHandler: (() => void) | null = null;
    const claimThread = vi.spyOn(BrokerClient.prototype, "claimThread").mockResolvedValue({
      claimed: true,
    });

    vi.spyOn(BrokerClient.prototype, "connect").mockResolvedValue(undefined);
    const register = vi.spyOn(BrokerClient.prototype, "register").mockResolvedValue({
      agentId: "worker-1",
      name: "Agent",
      emoji: "🦙",
      metadata: { role: "worker", capabilities: { role: "worker" } },
    });
    vi.spyOn(BrokerClient.prototype, "pollInbox").mockResolvedValue([]);
    vi.spyOn(BrokerClient.prototype, "updateStatus").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "ackMessages").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnectGracefully").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "unregister").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onDisconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onReconnect").mockImplementation((handler) => {
      reconnectHandler = handler;
    });

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const follow = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(follow).toBeDefined();

    await sessionStart?.({}, ctx);
    await follow?.handler("follow", ctx);

    expect(claimThread).not.toHaveBeenCalled();
    expect(reconnectHandler).toBeTypeOf("function");

    if (!reconnectHandler) {
      throw new Error("Reconnect handler was not registered");
    }

    const runReconnect: () => void = reconnectHandler;
    runReconnect();

    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledTimes(2);
      expect(claimThread).not.toHaveBeenCalled();
    });

    await sessionShutdown?.({}, ctx);
    expect(setStatus).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("following broker"), "info");
  });

  it("retries follower idle status sync after dispatcher free fails once so workers do not stay stuck working", async () => {
    vi.useFakeTimers();

    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();
    const sendUserMessage = vi.fn();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn((definition: ToolDefinition) => {
        tools.set(definition.name, definition);
      }),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage,
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
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
        getHeader: () => null,
        getLeafId: () => "leaf",
        getSessionFile: () => "/tmp/slack-bridge-session.json",
      },
    } as unknown as ExtensionContext;

    let pollCount = 0;
    let idleUpdateAttempts = 0;
    const updateStatus = vi
      .spyOn(BrokerClient.prototype, "updateStatus")
      .mockImplementation(async (status: "working" | "idle") => {
        if (status === "working") {
          return;
        }
        idleUpdateAttempts += 1;
        if (idleUpdateAttempts === 1) {
          throw new Error("status sync failed once");
        }
      });

    vi.spyOn(BrokerClient.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "register").mockResolvedValue({
      agentId: "worker-1",
      name: "Agent",
      emoji: "🦙",
      metadata: { role: "worker", capabilities: { role: "worker" } },
    });
    vi.spyOn(BrokerClient.prototype, "claimThread").mockResolvedValue({ claimed: true });
    vi.spyOn(BrokerClient.prototype, "pollInbox").mockImplementation(async () => {
      if (pollCount > 0) {
        pollCount += 1;
        return [];
      }
      pollCount += 1;
      return [
        {
          inboxId: 17,
          message: {
            id: 17,
            threadId: "100.1",
            source: "slack",
            direction: "inbound",
            sender: "U_SENDER",
            body: "hello from broker",
            createdAt: "100.1",
            metadata: { channel: "D123" },
          },
        },
      ];
    });
    vi.spyOn(BrokerClient.prototype, "ackMessages").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnectGracefully").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "unregister").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onDisconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onReconnect").mockImplementation(() => {
      /* mocked */
    });

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const follow = commands.get("pinet");
    const pinet = tools.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(follow).toBeDefined();
    expect(pinet).toBeDefined();

    try {
      await sessionStart?.({}, ctx);
      await follow?.handler("follow", ctx);

      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => {
        expect(sendUserMessage).toHaveBeenCalledWith(
          expect.stringContaining(
            "pointer=pinet action=read args.thread_id=100.1 args.unread_only=true",
          ),
        );
      });
      expect(sendUserMessage.mock.calls[0]?.[0]).not.toContain("hello from broker");
      expect(updateStatus.mock.calls.map(([status]) => status)).toEqual(["working"]);

      const failedFree = (await pinet!.execute("tool-call-1", {
        action: "free",
        args: {},
      })) as { details: { status: string; errors: Array<{ message: string }> } };
      expect(failedFree.details.status).toBe("failed");
      expect(failedFree.details.errors[0]?.message).toContain("status sync failed once");
      expect(updateStatus.mock.calls.map(([status]) => status)).toEqual(["working", "idle"]);

      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => {
        expect(updateStatus.mock.calls.map(([status]) => status)).toEqual([
          "working",
          "idle",
          "idle",
        ]);
      });

      await sessionShutdown?.({}, ctx);
      expect(setStatus).toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("following broker"), "info");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries follower idle status sync after agent_end auto-free fails once", async () => {
    vi.useFakeTimers();

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();
    const sendUserMessage = vi.fn();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage,
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
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
        getHeader: () => null,
        getLeafId: () => "leaf",
        getSessionFile: () => "/tmp/slack-bridge-session.json",
      },
    } as unknown as ExtensionContext;

    let pollCount = 0;
    let idleUpdateAttempts = 0;
    const updateStatus = vi
      .spyOn(BrokerClient.prototype, "updateStatus")
      .mockImplementation(async (status: "working" | "idle") => {
        if (status === "working") {
          return;
        }
        idleUpdateAttempts += 1;
        if (idleUpdateAttempts === 1) {
          throw new Error("status sync failed once");
        }
      });

    vi.spyOn(BrokerClient.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "register").mockResolvedValue({
      agentId: "worker-1",
      name: "Agent",
      emoji: "🦙",
      metadata: { role: "worker", capabilities: { role: "worker" } },
    });
    vi.spyOn(BrokerClient.prototype, "claimThread").mockResolvedValue({ claimed: true });
    vi.spyOn(BrokerClient.prototype, "pollInbox").mockImplementation(async () => {
      if (pollCount > 0) {
        pollCount += 1;
        return [];
      }
      pollCount += 1;
      return [
        {
          inboxId: 17,
          message: {
            id: 17,
            threadId: "100.1",
            source: "slack",
            direction: "inbound",
            sender: "U_SENDER",
            body: "hello from broker",
            createdAt: "100.1",
            metadata: { channel: "D123" },
          },
        },
      ];
    });
    vi.spyOn(BrokerClient.prototype, "ackMessages").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnectGracefully").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "unregister").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onDisconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onReconnect").mockImplementation(() => {
      /* mocked */
    });

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const follow = commands.get("pinet");
    const agentEnd = events.get("agent_end");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(follow).toBeDefined();
    expect(agentEnd).toBeDefined();

    try {
      await sessionStart?.({}, ctx);
      await follow?.handler("follow", ctx);

      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => {
        expect(sendUserMessage).toHaveBeenCalledWith(
          expect.stringContaining(
            "pointer=pinet action=read args.thread_id=100.1 args.unread_only=true",
          ),
        );
      });
      expect(sendUserMessage.mock.calls[0]?.[0]).not.toContain("hello from broker");
      expect(updateStatus.mock.calls.map(([status]) => status)).toEqual(["working"]);

      await agentEnd?.({ type: "agent_end", messages: [] }, ctx);
      expect(updateStatus.mock.calls.map(([status]) => status)).toEqual(["working", "idle"]);
      expect(notify).toHaveBeenCalledWith(
        "Pinet auto-free failed: status sync failed once",
        "warning",
      );

      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => {
        expect(updateStatus.mock.calls.map(([status]) => status)).toEqual([
          "working",
          "idle",
          "idle",
        ]);
      });

      await sessionShutdown?.({}, ctx);
      expect(setStatus).toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("following broker"), "info");
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses automatic inbox drain immediately after Escape so interrupts return control", async () => {
    vi.useFakeTimers();

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();
    const sendUserMessage = vi.fn();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage,
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    let idle = false;
    let terminalInputHandler:
      | ((data: string) => { consume?: boolean; data?: string } | undefined)
      | null = null;
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => idle,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify,
        setStatus,
        onTerminalInput: vi.fn(
          (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
            terminalInputHandler = handler;
            return () => {
              if (terminalInputHandler === handler) {
                terminalInputHandler = null;
              }
            };
          },
        ),
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "leaf",
        getSessionFile: () => "/tmp/slack-bridge-session.json",
      },
    } as unknown as ExtensionContext;

    let pollCount = 0;
    vi.spyOn(BrokerClient.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "register").mockResolvedValue({
      agentId: "worker-1",
      name: "Agent",
      emoji: "🦙",
      metadata: { role: "worker", capabilities: { role: "worker" } },
    });
    vi.spyOn(BrokerClient.prototype, "claimThread").mockResolvedValue({ claimed: true });
    vi.spyOn(BrokerClient.prototype, "pollInbox").mockImplementation(async () => {
      if (pollCount > 0) {
        pollCount += 1;
        return [];
      }
      pollCount += 1;
      return [
        {
          inboxId: 17,
          message: {
            id: 17,
            threadId: "100.1",
            source: "slack",
            direction: "inbound",
            sender: "U_SENDER",
            body: "hello from broker",
            createdAt: "100.1",
            metadata: { channel: "D123" },
          },
        },
      ];
    });
    vi.spyOn(BrokerClient.prototype, "updateStatus").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "ackMessages").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnectGracefully").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "unregister").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onDisconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onReconnect").mockImplementation(() => {
      /* mocked */
    });

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const agentEnd = events.get("agent_end");
    const follow = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(agentEnd).toBeDefined();
    expect(follow).toBeDefined();

    try {
      await sessionStart?.({}, ctx);
      await follow?.handler("follow", ctx);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(sendUserMessage).not.toHaveBeenCalled();
      const inputHandler = terminalInputHandler as unknown as
        | ((data: string) => { consume?: boolean; data?: string } | undefined)
        | undefined;
      expect(inputHandler).toBeTypeOf("function");
      expect(inputHandler?.("\u001b")).toBeUndefined();

      idle = true;
      await agentEnd?.({ type: "agent_end", messages: [] }, ctx);
      expect(sendUserMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_501);
      await agentEnd?.({ type: "agent_end", messages: [] }, ctx);

      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          "pointer=pinet action=read args.thread_id=100.1 args.unread_only=true",
        ),
      );
      expect(sendUserMessage.mock.calls[0]?.[0]).not.toContain("hello from broker");

      await sessionShutdown?.({}, ctx);
      expect(setStatus).toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("following broker"), "info");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends structured control envelopes for follower dispatcher send commands", async () => {
    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn((definition: ToolDefinition) => {
        tools.set(definition.name, definition);
      }),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => false,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "leaf",
        getSessionFile: () => "/tmp/slack-bridge-session.json",
      },
    } as unknown as ExtensionContext;

    const sendCalls: Array<{
      target: string;
      body: string;
      metadata?: Record<string, unknown>;
    }> = [];

    vi.spyOn(BrokerClient.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "register").mockResolvedValue({
      agentId: "worker-1",
      name: "Test Worker",
      emoji: "🐘",
      metadata: { role: "worker" },
    });
    vi.spyOn(BrokerClient.prototype, "sendAgentMessage").mockImplementation(
      async (target: string, body: string, metadata?: Record<string, unknown>) => {
        sendCalls.push({ target, body, metadata });
        return 17;
      },
    );
    vi.spyOn(BrokerClient.prototype, "disconnectGracefully").mockResolvedValue(undefined);

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const follow = commands.get("pinet");
    const pinet = tools.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(follow).toBeDefined();
    expect(pinet).toBeDefined();

    await sessionStart?.({}, ctx);
    await follow?.handler("follow", ctx);
    await pinet?.execute("tool-call-1", {
      action: "send",
      args: {
        to: "receiver-agent",
        message: "/reload",
      },
    });

    expect(sendCalls).toEqual([
      {
        target: "receiver-agent",
        body: '{"type":"pinet:control","action":"reload"}',
        metadata: { type: "pinet:control", action: "reload" },
      },
    ]);

    await sessionShutdown?.({}, ctx);
  });
});

describe("slack-bridge broker startup backlog recovery", () => {
  const originalBotToken = process.env.SLACK_BOT_TOKEN;
  const originalAppToken = process.env.SLACK_APP_TOKEN;
  const originalHome = process.env.HOME;
  let testHome: string;

  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "slack-bridge-broker-restart-"));
    process.env.HOME = testHome;
  });

  afterEach(() => {
    fs.rmSync(testHome, { recursive: true, force: true });

    if (originalBotToken === undefined) {
      delete process.env.SLACK_BOT_TOKEN;
    } else {
      process.env.SLACK_BOT_TOKEN = originalBotToken;
    }

    if (originalAppToken === undefined) {
      delete process.env.SLACK_APP_TOKEN;
    } else {
      process.env.SLACK_APP_TOKEN = originalAppToken;
    }

    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("recovers persisted broker-targeted backlog at startup even if the later maintenance pass is a no-op", async () => {
    const stableBrokerId = "stable-broker-id";
    const dbPath = path.join(testHome, ".pi", "pinet-broker.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const seededDb = new BrokerDB(dbPath);
    seededDb.initialize();
    seededDb.registerAgent(
      "broker-prev",
      "Previous Broker",
      "🦔",
      101,
      { role: "broker" },
      stableBrokerId,
    );
    seededDb.registerAgent("sender", "Sender", "📤", 202);
    seededDb.createThread("a2a:sender:broker-prev", "agent", "", "sender");
    seededDb.queueMessage("broker-prev", {
      source: "agent",
      threadId: "a2a:sender:broker-prev",
      channel: "",
      userId: "sender",
      text: "recover this after restart",
      timestamp: "123.456",
    });
    expect(seededDb.requeueUndeliveredMessages("broker-prev")).toBe(1);
    seededDb.close();

    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn((definition: ToolDefinition) => {
        tools.set(definition.name, definition);
      }),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => false,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify,
        setStatus,
      },
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "slack-bridge-state",
            data: { agentStableId: stableBrokerId },
          },
        ],
        getHeader: () => null,
        getLeafId: () => "broker-leaf",
        getSessionFile: () => "/tmp/slack-bridge-broker-session.json",
      },
    } as unknown as ExtensionContext;

    const restartedDb = new BrokerDB(dbPath);
    restartedDb.initialize();
    const brokerStop = vi.fn(async () => {
      restartedDb.close();
    });

    vi.spyOn(maintenanceModule, "runBrokerMaintenancePass").mockImplementation(() => ({
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 0,
      nudgedAgentIds: [],
      pendingBacklogCount: restartedDb.getBacklogCount("pending"),
      anomalies: [],
    }));
    vi.spyOn(brokerModule, "startBroker").mockResolvedValue({
      db: restartedDb,
      server: {
        setAgentRegistrationResolver: vi.fn(),
        onAgentMessage: vi.fn(),
        onAgentStatusChange: vi.fn(),
      },
      lock: {
        isLeader: () => true,
        release: vi.fn(),
      },
      adapters: [],
      addAdapter: vi.fn(),
      stop: brokerStop,
    } as unknown as Awaited<ReturnType<typeof brokerModule.startBroker>>);
    vi.spyOn(SlackAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "getBotUserId").mockReturnValue("U_BOT");

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStart = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStart).toBeDefined();

    await sessionStart?.({}, ctx);
    await pinetStart?.handler("start", ctx);

    const inspectDb = new DatabaseSync(dbPath);
    const backlog = inspectDb
      .prepare(
        `SELECT status, assigned_agent_id, attempt_count, last_attempt_at
           FROM unrouted_backlog
          WHERE preferred_agent_id = ?`,
      )
      .get("broker-prev") as
      | {
          status: string;
          assigned_agent_id: string | null;
          attempt_count: number;
          last_attempt_at: string | null;
        }
      | undefined;
    expect(backlog).toMatchObject({
      status: "assigned",
      assigned_agent_id: "broker-prev",
      attempt_count: 1,
    });
    expect(backlog?.last_attempt_at).toBeTruthy();

    const pendingInbox = inspectDb
      .prepare("SELECT COUNT(*) AS count FROM inbox WHERE agent_id = ? AND delivered = 0")
      .get("broker-prev") as { count: number };
    expect(pendingInbox.count).toBeGreaterThan(0);
    inspectDb.close();

    await sessionShutdown?.({}, ctx);
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Pinet broker failed"),
      "error",
    );
    expect(setStatus).toHaveBeenCalled();
  });

  it("recovers fresh broker-targeted pending backlog during inbox sync after startup", async () => {
    const stableBrokerId = "stable-broker-id";
    const dbPath = path.join(testHome, ".pi", "pinet-broker.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const seededDb = new BrokerDB(dbPath);
    seededDb.initialize();
    seededDb.registerAgent(
      "broker-prev",
      "Previous Broker",
      "🦔",
      101,
      { role: "broker" },
      stableBrokerId,
    );
    seededDb.close();

    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn((definition: ToolDefinition) => {
        tools.set(definition.name, definition);
      }),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => false,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify,
        setStatus,
      },
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "slack-bridge-state",
            data: { agentStableId: stableBrokerId },
          },
        ],
        getHeader: () => null,
        getLeafId: () => "broker-leaf",
        getSessionFile: () => "/tmp/slack-bridge-broker-session.json",
      },
    } as unknown as ExtensionContext;

    const restartedDb = new BrokerDB(dbPath);
    restartedDb.initialize();
    const brokerStop = vi.fn(async () => {
      restartedDb.close();
    });
    const brokerServer = {
      setAgentRegistrationResolver: vi.fn(),
      onAgentMessage: vi.fn(),
      onAgentStatusChange: vi.fn(),
    };

    vi.spyOn(maintenanceModule, "runBrokerMaintenancePass").mockImplementation(() => ({
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 0,
      nudgedAgentIds: [],
      pendingBacklogCount: restartedDb.getBacklogCount("pending"),
      anomalies: [],
    }));
    vi.spyOn(brokerModule, "startBroker").mockResolvedValue({
      db: restartedDb,
      server: brokerServer,
      lock: {
        isLeader: () => true,
        release: vi.fn(),
      },
      adapters: [],
      addAdapter: vi.fn(),
      stop: brokerStop,
    } as unknown as Awaited<ReturnType<typeof brokerModule.startBroker>>);
    vi.spyOn(SlackAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "getBotUserId").mockReturnValue("U_BOT");

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStart = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStart).toBeDefined();

    await sessionStart?.({}, ctx);
    await pinetStart?.handler("start", ctx);

    restartedDb.registerAgent("sender", "Sender", "📤", 202);
    restartedDb.createThread("a2a:sender:broker-prev", "agent", "", "sender");
    restartedDb.queueMessage("broker-prev", {
      source: "agent",
      threadId: "a2a:sender:broker-prev",
      channel: "",
      userId: "sender",
      text: "recover this without a maintenance rebound",
      timestamp: "123.456",
    });
    expect(restartedDb.requeueUndeliveredMessages("broker-prev")).toBe(1);

    const inspectPendingDb = new DatabaseSync(dbPath);
    const pendingBacklog = inspectPendingDb
      .prepare(
        `SELECT status, assigned_agent_id, attempt_count, last_attempt_at
           FROM unrouted_backlog
          WHERE preferred_agent_id = ?
          ORDER BY id DESC
          LIMIT 1`,
      )
      .get("broker-prev") as {
      status: string;
      assigned_agent_id: string | null;
      attempt_count: number;
      last_attempt_at: string | null;
    };
    expect(pendingBacklog).toMatchObject({
      status: "pending",
      assigned_agent_id: null,
      attempt_count: 0,
      last_attempt_at: null,
    });
    inspectPendingDb.close();

    const registeredAgentMessageHandler = brokerServer.onAgentMessage.mock.calls[0]?.[0] as
      | ((targetAgentId: string) => void)
      | undefined;
    expect(registeredAgentMessageHandler).toBeDefined();
    if (!registeredAgentMessageHandler) {
      throw new Error("Expected broker agent-message handler to be registered");
    }
    registeredAgentMessageHandler("broker-prev");

    const inspectRecoveredDb = new DatabaseSync(dbPath);
    const recoveredBacklog = inspectRecoveredDb
      .prepare(
        `SELECT status, assigned_agent_id, attempt_count, last_attempt_at
           FROM unrouted_backlog
          WHERE preferred_agent_id = ?
          ORDER BY id DESC
          LIMIT 1`,
      )
      .get("broker-prev") as {
      status: string;
      assigned_agent_id: string | null;
      attempt_count: number;
      last_attempt_at: string | null;
    };
    expect(recoveredBacklog).toMatchObject({
      status: "assigned",
      assigned_agent_id: "broker-prev",
      attempt_count: 1,
    });
    expect(recoveredBacklog.last_attempt_at).toBeTruthy();

    const pendingInbox = inspectRecoveredDb
      .prepare("SELECT COUNT(*) AS count FROM inbox WHERE agent_id = ? AND delivered = 0")
      .get("broker-prev") as { count: number };
    expect(pendingInbox.count).toBeGreaterThan(0);
    inspectRecoveredDb.close();

    await sessionShutdown?.({}, ctx);
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Pinet broker failed"),
      "error",
    );
    expect(setStatus).toHaveBeenCalled();
  });

  it("keeps exactly one live broker row and clears stranded broker-targeted pending backlog across startup and reload", async () => {
    const stableBrokerId = "stable-broker-id";
    const priorBrokerId = "broker-prev";
    const dbPath = path.join(testHome, ".pi", "pinet-broker.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const seededDb = new BrokerDB(dbPath);
    seededDb.initialize();
    seededDb.registerAgent(
      priorBrokerId,
      "Previous Broker",
      "🦔",
      101,
      { role: "broker" },
      stableBrokerId,
    );
    seededDb.registerAgent("sender", "Sender", "📤", 202);
    seededDb.createThread(`a2a:sender:${priorBrokerId}`, "agent", "", "sender");
    seededDb.queueMessage(priorBrokerId, {
      source: "agent",
      threadId: `a2a:sender:${priorBrokerId}`,
      channel: "",
      userId: "sender",
      text: "recover this through startup and reload",
      timestamp: "123.456",
    });
    expect(seededDb.requeueUndeliveredMessages(priorBrokerId)).toBe(1);
    seededDb.disconnectAgent(priorBrokerId);
    seededDb.close();

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => true,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify,
        setStatus,
      },
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "slack-bridge-state",
            data: {
              brokerStableId: stableBrokerId,
              lastPinetRole: "broker",
            },
          },
        ],
        getHeader: () => null,
        getLeafId: () => "broker-reload-leaf",
        getSessionFile: () => "/tmp/slack-bridge-broker-reload-session.json",
      },
    } as unknown as ExtensionContext;

    const brokerRuntimes: Array<{
      db: BrokerDB;
      stop: ReturnType<typeof vi.fn>;
    }> = [];

    const inspectHealthyBrokerState = () => {
      const inspectDb = new DatabaseSync(dbPath);
      const brokerRows = inspectDb
        .prepare("SELECT id, stable_id, metadata, disconnected_at FROM agents")
        .all() as Array<{
        id: string;
        stable_id: string | null;
        metadata: string | null;
        disconnected_at: string | null;
      }>;
      const liveBrokerRows = brokerRows.filter((row) => {
        const metadata = row.metadata
          ? (JSON.parse(row.metadata) as Record<string, unknown>)
          : null;
        return metadata?.role === "broker" && row.disconnected_at === null;
      });
      expect(liveBrokerRows).toHaveLength(1);
      expect(liveBrokerRows[0]).toMatchObject({
        id: priorBrokerId,
        stable_id: stableBrokerId,
        disconnected_at: null,
      });

      const recoveredBacklog = inspectDb
        .prepare(
          `SELECT status, assigned_agent_id
             FROM unrouted_backlog
            WHERE preferred_agent_id = ?
            ORDER BY id DESC
            LIMIT 1`,
        )
        .get(priorBrokerId) as {
        status: string;
        assigned_agent_id: string | null;
      };
      expect(recoveredBacklog).toMatchObject({
        status: "assigned",
        assigned_agent_id: priorBrokerId,
      });

      const strandedPending = inspectDb
        .prepare(
          `SELECT COUNT(*) AS count
             FROM unrouted_backlog backlog
             LEFT JOIN agents preferred ON preferred.id = backlog.preferred_agent_id
            WHERE backlog.status = 'pending'
              AND backlog.preferred_agent_id = ?
              AND (preferred.id IS NULL OR preferred.disconnected_at IS NOT NULL)`,
        )
        .get(priorBrokerId) as { count: number };
      expect(strandedPending.count).toBe(0);
      inspectDb.close();
    };

    vi.spyOn(maintenanceModule, "runBrokerMaintenancePass").mockImplementation((db) => ({
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 0,
      nudgedAgentIds: [],
      pendingBacklogCount: db.getBacklogCount("pending"),
      anomalies: [],
    }));
    const startBrokerSpy = vi.spyOn(brokerModule, "startBroker").mockImplementation(async () => {
      const db = new BrokerDB(dbPath);
      db.initialize();
      const stop = vi.fn(async () => {
        db.close();
      });
      brokerRuntimes.push({ db, stop });
      return {
        db,
        server: {
          setAgentRegistrationResolver: vi.fn(),
          onAgentMessage: vi.fn(),
          onAgentStatusChange: vi.fn(),
        },
        lock: {
          isLeader: () => true,
          release: vi.fn(),
        },
        adapters: [],
        addAdapter: vi.fn(),
        stop,
      } as unknown as Awaited<ReturnType<typeof brokerModule.startBroker>>;
    });
    vi.spyOn(SlackAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(SlackAdapter.prototype, "getBotUserId").mockReturnValue("U_BOT");

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const pinetStart = commands.get("pinet");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(pinetStart).toBeDefined();

    await sessionStart?.({}, ctx);
    await pinetStart?.handler("start", ctx);

    expect(startBrokerSpy).toHaveBeenCalledTimes(1);
    inspectHealthyBrokerState();

    await pinetStart?.handler("start", ctx);

    expect(startBrokerSpy).toHaveBeenCalledTimes(2);
    expect(brokerRuntimes).toHaveLength(2);
    expect(brokerRuntimes[0]?.stop).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "Pinet broker already running — reloading current runtime",
      "info",
    );
    inspectHealthyBrokerState();

    await sessionShutdown?.({}, ctx);
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Pinet broker failed"),
      "error",
    );
    expect(setStatus).toHaveBeenCalled();
  });
});
