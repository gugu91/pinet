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
import { writeJoinFile } from "./join-file.js";

type Handler = (event: object, ctx: ExtensionContext) => Promise<void>;

const MESH_SECRET = "test-mesh-secret";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A real broker socket with a recording Slack adapter, and a HOME without Slack tokens. */
async function startBroker() {
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
  vi.stubEnv("PINET_MESH_SECRET", MESH_SECRET);

  const db = new BrokerDB(":memory:");
  db.initialize();
  const server = new BrokerSocketServer(db, socket, { meshSecret: MESH_SECRET });
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
  cleanups.push(async () => {
    await server.stop();
    db.close();
    fs.rmSync(root, { force: true, recursive: true });
  });
  return { root, socket, db, slackCalls };
}

/** Loads the extension as pi would; a headless session looks like a subagent to Pinet's guard. */
function loadExtension(root: string, options: { joinFile?: string; headless?: boolean } = {}) {
  const events = new Map<string, Handler>();
  const commands = new Map<string, CommandDefinition>();
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerFlag: vi.fn(),
    getFlag: (name: string) => (name === "pinet-join" ? options.joinFile : undefined),
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
    hasUI: !options.headless,
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
      getSessionFile: () => (options.headless ? undefined : path.join(root, "session.jsonl")),
    },
  } as ExtensionContext;
  extension(pi);
  cleanups.push(async () => {
    await events.get("session_shutdown")?.({}, context);
  });
  return { events, commands, tools, notify, context };
}

it("joins a real broker without Slack tokens and calls Slack through the broker", async () => {
  const { root, db, slackCalls } = await startBroker();
  const { events, commands, tools, notify, context } = loadExtension(root);

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
}, 20_000);

it("follows at startup under the worker key from --pinet-join, even when headless", async () => {
  const { root, socket, db } = await startBroker();
  const { key } = db.workerKeys.issue({ hostId: "studio", workerId: "w1" });
  const looseFile = path.join(root, "loose.join.json");
  writeJoinFile(looseFile, { socket, key });
  fs.chmodSync(looseFile, 0o644);

  const rejected = loadExtension(root, { joinFile: looseFile, headless: true });
  await rejected.events.get("session_start")!({}, rejected.context);
  expect(rejected.notify).toHaveBeenCalledWith(expect.stringContaining("chmod 600"), "error");
  expect(db.getAgents()).toHaveLength(0);

  const joinFile = path.join(root, "w1.join.json");
  writeJoinFile(joinFile, { socket, key });
  const worker = loadExtension(root, { joinFile, headless: true });
  await worker.events.get("session_start")!({}, worker.context);
  await expect.poll(() => db.getAgents().length, { timeout: 10_000 }).toBe(1);
  expect(db.getAgents()[0]).toMatchObject({
    stableId: "studio:worker:w1",
    metadata: { role: "worker", pinetWorker: { hostId: "studio", workerId: "w1" } },
  });
}, 20_000);
