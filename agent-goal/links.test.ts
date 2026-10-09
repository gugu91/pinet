import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGoal, GoalLink, GoalStorage } from "./domain.js";
import { MemoryGoalStorage } from "./memory-storage.js";
import { SqliteGoalStorage } from "./sqlite-storage.js";
import { filterLinks, isPullRequestUrl, linkBrowserCommand, parseLinkUrl } from "./link-helpers.js";
import { LinkWindow, type LinkWindowAction } from "./link-window.js";
import { registerGoalLinks } from "./links.js";

const goal: AgentGoal = {
  id: "g1",
  scopeId: "s1",
  name: "Ship it",
  objective: "ship",
  status: "active",
  budget: {},
  usage: { iterations: 0, tokens: 0 },
  version: 1,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const link: GoalLink = {
  scopeId: "s1",
  url: "https://github.com/org/repo/pull/123",
  title: "Reconnect fix",
  description: "Ready for review",
  goalId: "g1",
  goalName: "Ship it",
  updatedAt: "2026-01-01",
};
const preview: GoalLink = {
  ...link,
  url: "https://preview.example.com/",
  title: "Preview",
  goalId: "g2",
  goalName: "Preview goal",
};
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as object as Theme;
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("link URLs", () => {
  it("normalizes HTTP URLs and rejects unsafe protocols, credentials, and controls", () => {
    expect(parseLinkUrl(" https://EXAMPLE.com:443 ").href).toBe("https://example.com/");
    for (const url of [
      "javascript:alert(1)",
      "file:///tmp/a",
      "ftp://example.com",
      "https://user:pass@example.com",
      "https://example.com/a\nb",
      "https://example.com/a b",
      "not a URL",
    ])
      expect(() => parseLinkUrl(url)).toThrow();
  });
  it("recognizes PR paths, including Enterprise, GitLab and Bitbucket, not lookalikes", () => {
    for (const url of [
      link.url,
      "https://git.company/org/repo/pull/4/files",
      "https://gitlab.com/group/sub/repo/-/merge_requests/2",
      "https://bitbucket.org/org/repo/pull-requests/2",
    ])
      expect(isPullRequestUrl(url)).toBe(true);
    for (const path of [
      "/org/repo/issues/123",
      "/org/repo/pull/12oops",
      "/org/repo/pull/0",
      "/org/repo/pull/new",
    ])
      expect(isPullRequestUrl(`https://github.com${path}`)).toBe(false);
  });
  it("filters by PR, goal, and case-insensitive metadata", () => {
    expect(filterLinks([link, preview], "REVIEW", true, "g1")).toEqual([link]);
    expect(filterLinks([link, preview], "preview goal")).toEqual([preview]);
    expect(filterLinks([link, preview], "github.com")).toEqual([link]);
    expect(filterLinks([link, preview], "", true, "g2")).toEqual([]);
  });
  it("passes URLs as arguments, never shell commands", () => {
    const url = "https://example.com/?x=$(touch%20/tmp/oops)&y=1";
    expect(linkBrowserCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(linkBrowserCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
    expect(linkBrowserCommand(url, "win32")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
    expect(() => linkBrowserCommand("file:///tmp/a", "darwin")).toThrow();
    expect(() => linkBrowserCommand(url, "aix")).toThrow("unsupported");
  });
});

for (const adapter of ["memory", "sqlite"] as const) {
  describe(`${adapter} link persistence`, () => {
    it("upserts, isolates sessions, survives goal deletion/replacement, and removes explicitly", async () => {
      const directory = mkdtempSync(join(tmpdir(), "goal-links-"));
      directories.push(directory);
      const path = join(directory, "goals.sqlite");
      let storage: GoalStorage =
        adapter === "memory" ? new MemoryGoalStorage() : new SqliteGoalStorage(path);
      try {
        await storage.create(goal);
        await storage.upsertLink(link);
        await storage.upsertLink({ ...link, scopeId: "s2" });
        await storage.upsertLink({ ...link, title: "Updated", updatedAt: "2026-01-02" });
        expect(await storage.listLinks("s1")).toEqual([
          { ...link, title: "Updated", updatedAt: "2026-01-02" },
        ]);
        expect(await storage.delete("s1", "g1", 1)).toBe("deleted");
        await storage.create({ ...goal, id: "new-goal" });
        if (adapter === "sqlite") {
          storage.close();
          storage = new SqliteGoalStorage(path);
        }
        expect(await storage.listLinks("s1")).toEqual([
          expect.objectContaining({ goalId: "g1", title: "Updated" }),
        ]);
        await storage.deleteLink("s1", link.url);
        expect(await storage.listLinks("s1")).toEqual([]);
        expect(await storage.listLinks("s2")).toEqual(
          [link].map((entry) => ({ ...entry, scopeId: "s2" })),
        );
      } finally {
        storage.close();
      }
    });
  });
}

describe("link overlay", () => {
  it("searches descriptions and goal names and opens only on Enter", () => {
    const done = vi.fn();
    const window = new LinkWindow([link, preview], "Links", theme, done, vi.fn());
    window.focused = true;
    expect(window.focused).toBe(true);
    window.handleInput("preview goal");
    expect(done).not.toHaveBeenCalled();
    expect(window.render(66).join("\n")).toContain("preview.example.com");
    window.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ type: "open", url: preview.url, query: "preview goal" });
  });
  it("navigates, confirms removal, cancels confirmation and closes", () => {
    const done = vi.fn();
    const window = new LinkWindow([link, preview], "Links", theme, done, vi.fn());
    window.handleInput("\u001b[B");
    window.handleInput("\u0004");
    expect(window.render(66).join("\n")).toContain("Enter remove saved link");
    expect(done).not.toHaveBeenCalled();
    window.handleInput("\u001b");
    expect(done).not.toHaveBeenCalled();
    window.handleInput("\u0004");
    window.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ type: "remove", url: preview.url, query: "" });
    window.handleInput("\u001b");
    expect(done).toHaveBeenLastCalledWith({ type: "close" });
  });
  it("handles empty results, resizing, wide text, and strips metadata terminal escapes", () => {
    const done = vi.fn();
    const window = new LinkWindow(
      [
        {
          ...link,
          title: "界🐘".repeat(80) + "\u001b[31m",
          description: "hello\u001b[2J",
          goalName: "界".repeat(80),
        },
      ],
      "Links",
      theme,
      done,
      vi.fn(),
    );
    for (const width of [1, 7, 8, 20, 36, 66, 100]) {
      const lines = window.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).not.toContain("\u001b[2J");
    }
    window.handleInput("does-not-exist");
    window.handleInput("\r");
    expect(done).not.toHaveBeenCalled();
    expect(window.render(66).join("\n")).not.toContain("github.com");
  });
});

describe("link tool and commands", () => {
  it("attaches without a goal, associates current goal, normalizes duplicates and does not open a browser", async () => {
    const tools = new Map<string, ToolDefinition>();
    const exec = vi.fn();
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      registerCommand: vi.fn(),
      exec,
    } as object as ExtensionAPI;
    const storage = new MemoryGoalStorage();
    registerGoalLinks(pi, storage);
    const tool = tools.get("attach_link")!;
    if (!tool.execute) throw new Error("attach_link must execute");
    const ctx = { sessionManager: { getSessionId: () => "s1" } } as object as ExtensionContext;
    await tool.execute(
      "1",
      { url: "https://EXAMPLE.com:443", title: " A link " },
      new AbortController().signal,
      undefined,
      ctx,
    );
    expect(await storage.listLinks("s1")).toEqual([
      expect.objectContaining({ url: "https://example.com/", title: "A link", goalId: undefined }),
    ]);
    await storage.create(goal);
    await tool.execute(
      "2",
      { url: "https://example.com/", title: "Updated" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    expect(await storage.listLinks("s1")).toEqual([
      expect.objectContaining({ title: "Updated", goalId: "g1", goalName: "Ship it" }),
    ]);
    await expect(
      tool.execute(
        "3",
        { url: "javascript:alert(1)", title: "bad" },
        new AbortController().signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow();
    await expect(
      tool.execute(
        "4",
        { url: link.url, title: " " },
        new AbortController().signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("title");
    expect(exec).not.toHaveBeenCalled();
  });

  it("lists PRs in headless mode without custom UI or browser execution", async () => {
    const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
    const exec = vi.fn();
    const pi = {
      registerTool: vi.fn(),
      registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
        commands.set(name, command),
      sendMessage: vi.fn(),
      exec,
    } as object as ExtensionAPI;
    const storage = new MemoryGoalStorage();
    await storage.upsertLink(link);
    await storage.upsertLink(preview);
    registerGoalLinks(pi, storage);
    const ctx = {
      mode: "rpc",
      sessionManager: { getSessionId: () => "s1" },
      ui: { custom: vi.fn() },
    } as object as ExtensionCommandContext;
    await commands.get("pr")!.handler("", ctx);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: `Reconnect fix\n${link.url}` }),
      { triggerTurn: false },
    );
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["tui", "rpc", "print"] as const)(
    "supports legacy %s contexts without mode",
    async (mode) => {
      const pi = {
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
        sendMessage: vi.fn(),
      } as object as ExtensionAPI;
      const storage = new MemoryGoalStorage();
      await storage.upsertLink(link);
      const show = registerGoalLinks(pi, storage);
      const custom = vi.fn(
        async (
          factory: (
            tui: { requestRender(): void },
            theme: Theme,
            keys: object,
            done: (action: LinkWindowAction) => void,
          ) => LinkWindow,
        ) => {
          if (mode === "rpc") return undefined;
          let action: LinkWindowAction | undefined;
          const window = factory({ requestRender: vi.fn() }, theme, {}, (value) => {
            action = value;
          });
          expect(window.render(66).join("\n")).toContain("Reconnect fix");
          window.handleInput("\u001b");
          return action;
        },
      );
      await show({
        hasUI: mode !== "print",
        sessionManager: { getSessionId: () => "s1" },
        ui: { custom },
      } as object as ExtensionContext);
      expect(custom).toHaveBeenCalledTimes(mode === "print" ? 0 : 1);
      if (mode === "tui") expect(pi.sendMessage).not.toHaveBeenCalled();
      else
        expect(pi.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ content: `Reconnect fix\n${link.url}` }),
          { triggerTurn: false },
        );
    },
  );

  it("filters current-goal links, surfaces opener failure, and removes only selected URL", async () => {
    const storage = new MemoryGoalStorage();
    await storage.upsertLink(link);
    await storage.upsertLink(preview);
    const exec = vi.fn().mockResolvedValue({ code: 1, stderr: "No browser available" });
    const pi = { registerTool: vi.fn(), registerCommand: vi.fn(), exec } as object as ExtensionAPI;
    const show = registerGoalLinks(pi, storage);
    let pass = 0;
    const custom = vi.fn(
      async (
        factory: (
          tui: { requestRender(): void },
          theme: Theme,
          keys: object,
          done: (action: LinkWindowAction) => void,
        ) => LinkWindow,
      ) => {
        let action: LinkWindowAction | undefined;
        const window = factory({ requestRender: vi.fn() }, theme, {}, (value) => {
          action = value;
        });
        const output = window.render(66).join("\n");
        expect(output).not.toContain("preview.example.com");
        if (pass === 0) window.handleInput("\r");
        else if (pass === 1) {
          expect(output).toContain("No browser available");
          window.handleInput("\u0004");
          window.handleInput("\r");
        } else window.handleInput("\u001b");
        pass += 1;
        return action;
      },
    );
    await show(
      {
        mode: "tui",
        sessionManager: { getSessionId: () => "s1" },
        ui: { custom },
      } as object as ExtensionContext,
      false,
      "g1",
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([link.url]), {
      timeout: 10_000,
    });
    expect(await storage.listLinks("s1")).toEqual([preview]);
  });
});
