import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalLink, GoalStorage } from "./domain.js";
import { MemoryGoalStorage } from "./memory-storage.js";
import { SqliteGoalStorage } from "./sqlite-storage.js";
import { registerGoalLinks } from "./links.js";
import type { LinkWindow, LinkWindowAction } from "./link-window.js";

const pr: GoalLink = {
  scopeId: "session",
  url: "https://github.com/org/repo/pull/1",
  title: "PR",
  updatedAt: "2026-01-01",
  goalId: "goal-1",
};
const doc: GoalLink = { ...pr, url: "https://example.com/", title: "Docs", goalId: "goal-2" };
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function harness(storage: GoalStorage) {
  const tools = new Map<string, ToolDefinition>();
  let start: (event: object, ctx: ExtensionContext) => Promise<void> = async () => {};
  const setStatus = vi.fn();
  const terminal = { rows: 24 };
  const pi = {
    on(_name: string, handler: typeof start) {
      start = handler;
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
  } as object as ExtensionAPI;
  const custom = vi.fn(
    async (
      factory: (
        tui: { terminal: { rows: number }; requestRender(): void },
        theme: Theme,
        keys: object,
        done: (action: LinkWindowAction) => void,
      ) => LinkWindow,
    ) => {
      let action: LinkWindowAction | undefined;
      const window = factory(
        { terminal, requestRender: vi.fn() },
        {
          fg: (_color: string, value: string) => value,
          bold: (value: string) => value,
        } as object as Theme,
        {},
        (value) => {
          action = value;
        },
      );
      window.render(66);
      window.handleInput("\u001b");
      return action;
    },
  );
  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "session" },
    ui: { setStatus, custom },
  } as object as ExtensionContext;
  const show = registerGoalLinks(pi, storage);
  return {
    ctx,
    terminal,
    custom,
    setStatus,
    show,
    pi,
    start: (context = ctx) => start({}, context),
    attach: (url = pr.url, title = pr.title) =>
      tools.get("attach_link")!.execute!(
        "call",
        { url, title },
        new AbortController().signal,
        undefined,
        ctx,
      ),
  };
}

describe("unseen link footer", () => {
  it("shows a compact count without a goal, clears after viewing, and ignores reattachments", async () => {
    const storage = new MemoryGoalStorage();
    const h = harness(storage);
    await h.start();
    expect(h.setStatus).toHaveBeenLastCalledWith("agent-goal.links", undefined);
    await h.attach();
    expect(h.setStatus).toHaveBeenLastCalledWith("agent-goal.links", "🔗 1");
    await h.attach(doc.url, doc.title);
    expect(h.setStatus).toHaveBeenLastCalledWith("agent-goal.links", "🔗 2");
    await h.show(h.ctx);
    expect(h.setStatus).toHaveBeenLastCalledWith("agent-goal.links", undefined);
    await h.attach();
    await h.attach(pr.url, "Updated context");
    expect(h.setStatus).toHaveBeenLastCalledWith("agent-goal.links", undefined);
  });

  it.each(["pr", "goal"])("marks only the %s picker listing as seen", async (filter) => {
    const storage = new MemoryGoalStorage();
    await storage.upsertLink(pr);
    await storage.upsertLink(doc);
    const h = harness(storage);
    await h.show(h.ctx, filter === "pr", filter === "goal" ? "goal-1" : undefined);
    const links = await storage.listLinks("session");
    expect(links.find((link) => link.url === pr.url)!.seenAt).toBeDefined();
    expect(links.find((link) => link.url === doc.url)!.seenAt).toBeUndefined();
    expect(h.setStatus).toHaveBeenLastCalledWith("agent-goal.links", "🔗 1");
  });

  it("leaves links attached while the picker is open unseen", async () => {
    const storage = new MemoryGoalStorage();
    await storage.upsertLink(pr);
    const h = harness(storage);
    const render = h.custom.getMockImplementation()!;
    h.custom.mockImplementation(async (factory) => {
      const action = await render(factory);
      await storage.upsertLink(doc);
      return action;
    });
    await h.show(h.ctx);
    expect(h.setStatus).toHaveBeenLastCalledWith("agent-goal.links", "🔗 1");
    expect(
      (await storage.listLinks("session")).find((link) => link.url === doc.url)!.seenAt,
    ).toBeUndefined();
  });

  it("does not mark links seen when a tiny pane cannot show the listing", async () => {
    const storage = new MemoryGoalStorage();
    await storage.upsertLink(pr);
    const h = harness(storage);
    h.terminal.rows = 8;
    await h.show(h.ctx);
    expect(h.setStatus).toHaveBeenLastCalledWith("agent-goal.links", "🔗 1");
    expect((await storage.listLinks("session"))[0]!.seenAt).toBeUndefined();
  });

  it("marks headless listings seen and restores counts on session changes", async () => {
    const storage = new MemoryGoalStorage();
    await storage.upsertLink(pr);
    await storage.upsertLink(doc);
    const h = harness(storage);
    await h.show({ ...h.ctx, mode: "rpc" }, true);
    expect(h.pi.sendMessage).toHaveBeenCalled();
    await h.start();
    expect(h.setStatus).toHaveBeenLastCalledWith("agent-goal.links", "🔗 1");
    await h.start({
      ...h.ctx,
      sessionManager: { getSessionId: () => "other" },
    } as object as ExtensionContext);
    expect(h.setStatus).toHaveBeenLastCalledWith("agent-goal.links", undefined);
  });
});

for (const adapter of ["memory", "sqlite"] as const) {
  it(`${adapter} preserves read state on upsert/restart and scopes acknowledgements to listed URLs`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "unseen-links-"));
    directories.push(directory);
    const path = join(directory, "goals.sqlite");
    let storage: GoalStorage =
      adapter === "memory" ? new MemoryGoalStorage() : new SqliteGoalStorage(path);
    try {
      await storage.upsertLink(pr);
      await storage.upsertLink(doc);
      await storage.upsertLink({ ...pr, scopeId: "other" });
      await storage.markLinksSeen("session", [pr.url], "2026-01-02");
      await storage.upsertLink({ ...pr, title: "Updated", updatedAt: "2026-01-03" });
      if (adapter === "sqlite") {
        storage.close();
        storage = new SqliteGoalStorage(path);
      }
      const links = await storage.listLinks("session");
      expect(links.find((link) => link.url === pr.url)!.seenAt).toBe("2026-01-02");
      expect(links.find((link) => link.url === doc.url)!.seenAt).toBeUndefined();
      expect((await storage.listLinks("other"))[0]!.seenAt).toBeUndefined();
      await storage.deleteLink("session", pr.url);
      await storage.upsertLink(pr);
      expect(
        (await storage.listLinks("session")).find((link) => link.url === pr.url)!.seenAt,
      ).toBeUndefined();
    } finally {
      storage.close();
    }
  });
}

it("migrates links saved before read-state support without losing them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "unseen-migration-"));
  directories.push(directory);
  const path = join(directory, "goals.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE agent_goal_links (scope_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT, goal_id TEXT, goal_name TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(scope_id, url));`);
  db.prepare("INSERT INTO agent_goal_links(scope_id,url,title,updated_at) VALUES (?,?,?,?)").run(
    pr.scopeId,
    pr.url,
    pr.title,
    pr.updatedAt,
  );
  db.close();
  const storage = new SqliteGoalStorage(path);
  try {
    expect(await storage.listLinks("session")).toEqual([
      expect.objectContaining({ url: pr.url, seenAt: undefined }),
    ]);
    await storage.markLinksSeen("session", [pr.url], "2026-01-02");
    expect((await storage.listLinks("session"))[0]!.seenAt).toBe("2026-01-02");
  } finally {
    storage.close();
  }
});
