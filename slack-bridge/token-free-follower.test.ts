import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  CommandDefinition,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import extension from "./index.js";
import { BrokerDB } from "./broker/schema.js";
import { BrokerSocketServer } from "./broker/socket-server.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Handler = (event: object, ctx: ExtensionContext) => Promise<void>;

it("joins a real broker without Slack tokens and calls Slack through the broker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-token-free-"));
  const socket = path.join(root, "broker.sock");
  fs.mkdirSync(path.join(root, ".pi", "agent"), { recursive: true });
  // runtimeMode "broker" mirrors a shared settings.json; without tokens it must not start a broker.
  fs.writeFileSync(
    path.join(root, ".pi", "agent", "settings.json"),
    JSON.stringify({ "slack-bridge": { runtimeMode: "broker", allowAllWorkspaceUsers: true } }),
  );
  vi.stubEnv("HOME", root);
  vi.stubEnv("SLACK_BOT_TOKEN", undefined);
  vi.stubEnv("SLACK_APP_TOKEN", undefined);
  vi.stubEnv("PINET_SOCKET_PATH", socket);
  vi.stubEnv("PINET_MESH_SECRET", "test-mesh-secret");

  const db = new BrokerDB(":memory:");
  db.initialize();
  const server = new BrokerSocketServer(db, socket, { meshSecret: "test-mesh-secret" });
  const slackCalls: object[] = [];
  server.setOutboundMessageAdapters([
    {
      name: "slack",
      send: vi.fn(),
      invokeCapability: async ({ params }) => {
        slackCalls.push(params);
        return { result: { ok: true } };
      },
    },
  ]);
  await server.start();

  const events = new Map<string, Handler>();
  const commands = new Map<string, CommandDefinition>();
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerCommand: (name: string, definition: CommandDefinition) =>
      commands.set(name, definition),
    registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
    registerMessageRenderer: vi.fn(),
    on: (name: string, fn: Handler) => events.set(name, fn),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    getActiveTools: () => ["read", "slack", "pinet"],
    setActiveTools: vi.fn(),
    getSessionName: () => undefined,
  } as ExtensionAPI;
  const notify = vi.fn();
  const context = {
    cwd: root,
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify,
      onTerminalInput: vi.fn(),
      setStatus: vi.fn(),
      select: vi.fn(),
      custom: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
    },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => "token-free-test",
      getSessionFile: () => path.join(root, "session.jsonl"),
    },
  } as ExtensionContext;

  try {
    extension(pi);
    expect(commands.has("pinet")).toBe(true);
    await events.get("session_start")!({}, context);
    expect(db.getAgents()).toHaveLength(0);

    await commands.get("pinet")!.handler("follow", context);
    await expect.poll(() => db.getAgents().length, { timeout: 10_000 }).toBe(1);

    await tools.get("slack")!.execute!(
      "call-1",
      {
        action: "react",
        args: { emoji: "eyes", timestamp: "1712345678.000100", channel: "C0TEST" },
      },
      undefined,
      undefined,
      context,
    );
    expect(slackCalls).toContainEqual({
      method: "reactions.add",
      params: { channel: "C0TEST", timestamp: "1712345678.000100", name: "eyes" },
    });

    // Asking a token-less follower to become broker fails before it leaves the mesh.
    await commands.get("pinet")!.handler("start", context);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("needs SLACK_BOT_TOKEN"), "error");
    expect(db.getAgents()[0].disconnectedAt).toBeFalsy();
  } finally {
    await events.get("session_shutdown")?.({}, context);
    await server.stop();
    db.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
}, 20_000);
