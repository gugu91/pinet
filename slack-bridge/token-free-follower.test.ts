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
function loadExtension(
  root: string,
  options: { joinFile?: string; follow?: boolean; headless?: boolean } = {},
) {
  const events = new Map<string, Handler>();
  const commands = new Map<string, CommandDefinition>();
  const tools = new Map<string, ToolDefinition>();
  let activeTools = ["read", "slack", "pinet"];
  const pi = {
    registerFlag: vi.fn(),
    getFlag: (name: string) =>
      name === "pinet-join"
        ? options.joinFile
        : name === "pinet-follow"
          ? options.follow
          : undefined,
    registerCommand: (name: string, definition: CommandDefinition) =>
      commands.set(name, definition),
    registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
    registerMessageRenderer: vi.fn(),
    on: (name: string, fn: Handler) => events.set(name, fn),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
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
  return { pi, events, commands, tools, notify, context };
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

it("rejoins the broker after /reload in the mode it was running", async () => {
  const { root, db } = await startBroker();
  const connectedAgents = () => db.getAgents().filter((agent) => !agent.disconnectedAt).length;

  const before = loadExtension(root);
  await before.events.get("session_start")!({ reason: "startup" }, before.context);
  await before.commands.get("pinet")!.handler("follow", before.context);
  await expect.poll(connectedAgents, { timeout: 10_000 }).toBe(1);
  await before.events.get("session_shutdown")!({ reason: "reload" }, before.context);
  expect(connectedAgents()).toBe(0);

  // Settings alone would start this token-free session with Pinet off.
  const after = loadExtension(root);
  await after.events.get("session_start")!({ reason: "reload" }, after.context);
  await expect.poll(connectedAgents, { timeout: 10_000 }).toBe(1);
  expect(after.pi.getActiveTools()).toEqual(expect.arrayContaining(["pinet", "slack"]));
}, 20_000);

it("makes worker-key tools ready for an immediate task, even when headless", async () => {
  const { root, socket, db, slackCalls } = await startBroker();
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
  expect(worker.pi.getActiveTools()).toEqual(expect.arrayContaining(["pinet", "slack"]));
  expect(db.getAgents()).toHaveLength(1);
  expect(db.getAgents()[0]).toMatchObject({
    stableId: "studio:worker:w1",
    metadata: { role: "worker", pinetWorker: { hostId: "studio", workerId: "w1" } },
  });
  await worker.tools.get("slack")!.execute!(
    "first-task",
    {
      action: "react",
      args: { emoji: "eyes", timestamp: "1712345678.000100", channel: "C0TEST" },
    },
    undefined,
    undefined,
    worker.context,
  );
  expect(slackCalls).toEqual([
    {
      method: "reactions.add",
      params: { channel: "C0TEST", timestamp: "1712345678.000100", name: "eyes" },
    },
  ]);
}, 20_000);

it("follows from --pinet-follow in this process only, ready for an immediate task", async () => {
  const { root, db, slackCalls } = await startBroker();
  const settingsPath = path.join(root, ".pi", "agent", "settings.json");
  const settingsBefore = fs.readFileSync(settingsPath, "utf8");

  const follower = loadExtension(root, { follow: true });
  await follower.events.get("session_start")!({}, follower.context);
  expect(follower.pi.getActiveTools()).toEqual(expect.arrayContaining(["pinet", "slack"]));
  expect(db.getAgents()).toHaveLength(1);
  await follower.tools.get("slack")!.execute!(
    "first-task",
    {
      action: "react",
      args: { emoji: "eyes", timestamp: "1712345678.000100", channel: "C0TEST" },
    },
    undefined,
    undefined,
    follower.context,
  );
  expect(slackCalls).toHaveLength(1);
  expect(fs.readFileSync(settingsPath, "utf8")).toBe(settingsBefore);
}, 20_000);

it("keeps --pinet-follow visibly off when there is no broker socket", async () => {
  const { root, db } = await startBroker();
  const missingSocket = path.join(root, "missing", "pinet.sock");
  vi.stubEnv("PINET_SOCKET_PATH", missingSocket);

  const follower = loadExtension(root, { follow: true });
  await follower.events.get("session_start")!({}, follower.context);
  expect(follower.notify).toHaveBeenCalledWith(
    expect.stringContaining(`--pinet-follow found no broker socket at ${missingSocket}`),
    "warning",
  );
  expect(follower.pi.getActiveTools()).toEqual(["read"]);
  expect(db.getAgents()).toHaveLength(0);
}, 20_000);

it("keeps --pinet-follow visibly off when the broker rejects its login", async () => {
  const { root, db } = await startBroker();
  vi.stubEnv("PINET_MESH_SECRET", "wrong-secret");

  const follower = loadExtension(root, { follow: true });
  await follower.events.get("session_start")!({}, follower.context);
  expect(follower.notify).toHaveBeenCalledWith(
    expect.stringContaining("Pinet could not join the broker"),
    "warning",
  );
  expect(follower.pi.getActiveTools()).toEqual(["read"]);
  expect(db.getAgents()).toHaveLength(0);
}, 20_000);

/** A worker machine may have its own Slack app, for example the owner's personal workspace. */
function giveWorkerItsOwnSlackApp(root: string) {
  fs.writeFileSync(
    path.join(root, ".pi", "agent", "settings.json"),
    JSON.stringify({
      "slack-bridge": {
        runtimeMode: "broker",
        allowAllWorkspaceUsers: true,
        botToken: "xoxb-other-workspace",
        appToken: "xapp-other-workspace",
      },
    }),
  );
  return vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("direct Slack call"));
}

it("sends a worker's Slack calls through its broker, never with local Slack tokens", async () => {
  const { root, socket, db, slackCalls } = await startBroker();
  const directSlack = giveWorkerItsOwnSlackApp(root);
  const { key } = db.workerKeys.issue({ hostId: "laptop", workerId: "w1" });
  const joinFile = path.join(root, "w1.join.json");
  writeJoinFile(joinFile, { socket, key });

  const worker = loadExtension(root, { joinFile });
  await worker.events.get("session_start")!({}, worker.context);
  await worker.tools.get("slack")!.execute!(
    "call-1",
    {
      action: "react",
      args: { emoji: "eyes", timestamp: "1712345678.000100", channel: "C0TEST" },
    },
    undefined,
    undefined,
    worker.context,
  );
  expect(slackCalls).toEqual([
    {
      method: "reactions.add",
      params: { channel: "C0TEST", timestamp: "1712345678.000100", name: "eyes" },
    },
  ]);
  expect(directSlack).not.toHaveBeenCalled();
}, 20_000);

it("does not let a rejected worker start a broker with local Slack tokens", async () => {
  const { root, socket, db } = await startBroker();
  const directSlack = giveWorkerItsOwnSlackApp(root);
  const { key } = db.workerKeys.issue({ hostId: "laptop", workerId: "w1" });
  const joinFile = path.join(root, "w1.join.json");
  writeJoinFile(joinFile, { socket, key });
  fs.chmodSync(joinFile, 0o644);

  const worker = loadExtension(root, { joinFile });
  await worker.events.get("session_start")!({}, worker.context);
  await worker.commands.get("pinet")!.handler("start", worker.context);
  expect(worker.notify).toHaveBeenLastCalledWith(
    expect.stringContaining("needs SLACK_BOT_TOKEN"),
    "error",
  );
  expect(directSlack).not.toHaveBeenCalled();
}, 20_000);

it.each([null, {}, { version: 1, socket: 42, key: "key" }])(
  "rejects malformed join data %j without falling back to mesh auth",
  async (data) => {
    const { root, socket, db } = await startBroker();
    const joinFile = path.join(root, "invalid.join.json");
    fs.writeFileSync(joinFile, JSON.stringify(data), { mode: 0o600 });
    const worker = loadExtension(root, { joinFile });
    await worker.events.get("session_start")!({}, worker.context);
    expect(worker.notify).toHaveBeenCalledWith(expect.stringContaining("must contain"), "error");

    await worker.commands.get("pinet")!.handler("follow", worker.context);
    expect(db.getAgents()).toHaveLength(0);
    expect(worker.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Pinet follow failed:"),
      "error",
    );

    const { key } = db.workerKeys.issue({ hostId: "studio", workerId: "w1" });
    fs.writeFileSync(joinFile, JSON.stringify({ version: 1, socket, key }));
    await worker.commands.get("pinet")!.handler("follow", worker.context);
    expect(db.getAgents()).toMatchObject([{ stableId: "studio:worker:w1" }]);
  },
);
