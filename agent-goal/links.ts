import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { displayGoalText, goalDisplayName } from "./dashboard.js";
import type { GoalLink, GoalStorage } from "./domain.js";
import { filterLinks, linkBrowserCommand, parseLinkUrl } from "./link-helpers.js";
import { LinkWindow, LinkWindowState, type LinkWindowAction } from "./link-window.js";

interface LinkAPI extends ExtensionAPI {
  exec(
    command: string,
    args: string[],
    options?: { timeout?: number },
  ): Promise<{ code: number; stderr: string }>;
  sendMessage(
    message: { customType: string; display: boolean; content: string },
    options?: { triggerTurn: boolean },
  ): void;
}

export function registerGoalLinks(
  rawPi: ExtensionAPI,
  storage: GoalStorage,
): (ctx: ExtensionContext, prsOnly?: boolean, goalId?: string) => Promise<void> {
  const pi = rawPi as LinkAPI;
  let statusGeneration = 0;
  const refreshStatus = async (ctx: ExtensionContext): Promise<void> => {
    const generation = ++statusGeneration;
    if (!ctx.hasUI) return;
    const scopeId = (
      ctx.sessionManager as ExtensionContext["sessionManager"] & { getSessionId(): string }
    ).getSessionId();
    const unseen = (await storage.listLinks(scopeId)).filter((link) => !link.seenAt).length;
    if (generation === statusGeneration)
      ctx.ui.setStatus("agent-goal.links", unseen ? `🔗 ${unseen}` : undefined);
  };
  const markSeen = async (ctx: ExtensionContext, urls: string[]): Promise<void> => {
    const scopeId = (
      ctx.sessionManager as ExtensionContext["sessionManager"] & { getSessionId(): string }
    ).getSessionId();
    await storage.markLinksSeen(scopeId, urls, new Date().toISOString());
    await refreshStatus(ctx);
  };
  pi.on("session_start", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  const showLinks = async (
    ctx: ExtensionContext,
    prsOnly = false,
    goalId?: string,
  ): Promise<void> => {
    const scopeId = (
      ctx.sessionManager as ExtensionContext["sessionManager"] & { getSessionId(): string }
    ).getSessionId();
    let query = "";
    const state = new LinkWindowState();
    let error: string | undefined;
    while (true) {
      const links = filterLinks(await storage.listLinks(scopeId), "", prsOnly, goalId);
      const title = prsOnly ? "Pull requests" : goalId ? "Goal links" : "Links";
      const listing = {
        customType: "agent-goal.links",
        display: true,
        content: links.length
          ? links.map((link) => `${displayGoalText(link.title, 200)}\n${link.url}`).join("\n\n")
          : "No saved links.",
      };
      if (ctx.mode === undefined ? !ctx.hasUI : ctx.mode !== "tui") {
        pi.sendMessage(listing, { triggerTurn: false });
        await markSeen(
          ctx,
          links.map((link) => link.url),
        );
        return;
      }
      // Older Pi versions have no mode field; RPC custom() does not invoke its factory.
      let openedWindow = false;
      const action = await ctx.ui.custom<LinkWindowAction>(
        (tui, theme, _keys, done) => {
          openedWindow = true;
          return new LinkWindow(
            links,
            title,
            theme,
            done,
            () => tui.requestRender(),
            query,
            error,
            state,
            () => Math.min(tui.terminal.rows - 2, Math.floor(tui.terminal.rows * 0.8)),
          );
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: 66,
            minWidth: 36,
            maxHeight: "80%",
            margin: 1,
          },
        },
      );
      if (!openedWindow) pi.sendMessage(listing, { triggerTurn: false });
      await markSeen(ctx, openedWindow ? [...state.viewedUrls] : links.map((link) => link.url));
      state.viewedUrls.clear();
      if (!action || action.type === "close") return;
      query = action.query;
      try {
        if (action.type === "remove") {
          await storage.deleteLink(scopeId, action.url);
          await refreshStatus(ctx);
        } else {
          const { command, args } = linkBrowserCommand(action.url, process.platform);
          const result = await pi.exec(command, args, { timeout: 10_000 });
          if (result.code !== 0)
            throw new Error(result.stderr || `Browser opener exited ${result.code}`);
        }
        error = undefined;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
  };

  pi.registerTool({
    name: "attach_link",
    label: "Attach link",
    description:
      "Save a useful URL for this session’s /link picker (/pr for pull requests). Survives goal completion.",
    promptSnippet: "Save useful PRs, previews, and references for quick user access.",
    promptGuidelines: [
      "Attach PRs you deliver and useful URLs with concise titles; do not collect every URL. Links do not replace outcome reporting or prove goal completion.",
    ],
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP(S) URL." },
        title: { type: "string", description: "Short descriptive title." },
        description: { type: "string", description: "Optional context, not live remote status." },
      },
      required: ["url", "title"],
      additionalProperties: false,
    },
    async execute(_id, rawParams, _signal, _update, ctx) {
      const params = rawParams as { url: string; title: string; description?: string };
      const url = parseLinkUrl(params.url).href;
      const title = params.title.trim();
      if (!title) throw new Error("A link title is required");
      const scopeId = (
        ctx.sessionManager as ExtensionContext["sessionManager"] & { getSessionId(): string }
      ).getSessionId();
      const goal = await storage.get(scopeId);
      const link: GoalLink = {
        scopeId,
        url,
        title,
        description: params.description?.trim() || undefined,
        goalId: goal?.id,
        goalName: goal ? goalDisplayName(goal) : undefined,
        updatedAt: new Date().toISOString(),
      };
      await storage.upsertLink(link);
      await refreshStatus(ctx);
      return {
        content: [
          { type: "text", text: `Saved ${title}. Available in /link and, for pull requests, /pr.` },
        ],
        details: { link },
      };
    },
  });
  for (const name of ["link", "pr"] as const) {
    pi.registerCommand(name, {
      description:
        name === "pr"
          ? "Browse and open saved pull requests"
          : "Browse, open, and remove saved links",
      handler: async (_args, ctx) => {
        await showLinks(ctx, name === "pr");
      },
    });
  }
  return showLinks;
}
