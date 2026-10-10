import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "./index.js";
import { BrokerDB } from "./broker/schema.js";
import { BrokerSocketServer } from "./broker/socket-server.js";
import { writeJoinProfile } from "./join-profile.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("registers slash commands without Slack credentials and joins a real broker from an explicit profile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-tokenless-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("SLACK_BOT_TOKEN", undefined);
  vi.stubEnv("SLACK_APP_TOKEN", undefined);
  vi.stubEnv("PINET_JOIN_PROFILE", undefined);
  const db = new BrokerDB(":memory:");
  db.initialize();
  const socket = path.join(root, "broker.sock");
  const server = new BrokerSocketServer(db, socket, { meshSecret: "legacy-local" });
  await server.start();
  const profile = path.join(root, "worker.json");
  writeJoinProfile(profile, {
    version: 1,
    ...db.membership.issue("test-host", "test-worker"),
    endpoint: { path: socket },
    repos: [process.cwd()],
    capabilities: ["test"],
  });
  const events = new Map<string, (event: object, ctx: ExtensionContext) => Promise<void>>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
  >();
  const pi = {
    registerFlag: vi.fn(),
    getFlag: () => profile,
    registerCommand: (
      name: string,
      definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) => commands.set(name, definition),
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: (name: string, fn: (event: object, ctx: ExtensionContext) => Promise<void>) =>
      events.set(name, fn),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    getActiveTools: () => ["read", "bash"],
    setActiveTools: vi.fn(),
  } as ExtensionAPI;
  const context = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      select: vi.fn(),
      custom: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
    },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => "test",
      getSessionFile: () => undefined,
      getHeader: () => ({ parentSession: "test-parent" }),
    },
  } as ExtensionContext;
  try {
    extension(pi);
    expect(commands.has("pinet")).toBe(true);
    await events.get("session_start")!({}, context);
    await expect.poll(() => db.getAgents().length, { timeout: 15_000 }).toBe(1);
    expect(db.getAgents()[0].metadata).toMatchObject({
      role: "worker",
      hostId: "test-host",
      workerId: "test-worker",
      hostReport: { runtimes: expect.arrayContaining(["shell"]) },
    });
    await commands.get("pinet")!.handler("reload", context);
    expect(db.getAgents()).toHaveLength(1);
  } finally {
    await events.get("session_shutdown")?.({}, context);
    await server.stop();
    db.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
}, 20_000);
