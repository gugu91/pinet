import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { displayGoalText, goalDisplayName } from "./dashboard.js";
import type { GoalLink, GoalStorage } from "./domain.js";
import { filterLinks, linkBrowserCommand, parseLinkUrl } from "./link-helpers.js";
import { LinkWindow, type LinkWindowAction } from "./link-window.js";

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
  const showLinks = async (
    ctx: ExtensionContext,
    prsOnly = false,
    goalId?: string,
  ): Promise<void> => {
    const scopeId = (
      ctx.sessionManager as ExtensionContext["sessionManager"] & { getSessionId(): string }
    ).getSessionId();
    let query = "";
    let error: string | undefined;
    while (true) {
      const links = filterLinks(await storage.listLinks(scopeId), "", prsOnly, goalId);
      const title = prsOnly ? "Pull requests" : goalId ? "Goal links" : "Links";
      if (ctx.mode !== "tui") {
        pi.sendMessage(
          {
            customType: "agent-goal.links",
            display: true,
            content: links.length
              ? links.map((link) => `${displayGoalText(link.title, 200)}\n${link.url}`).join("\n\n")
              : "No saved links.",
          },
          { triggerTurn: false },
        );
        return;
      }
      const action = await ctx.ui.custom<LinkWindowAction>(
        (tui, theme, _keys, done) =>
          new LinkWindow(links, title, theme, done, () => tui.requestRender(), query, error),
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
      if (!action || action.type === "close") return;
      query = action.query;
      try {
        if (action.type === "remove") await storage.deleteLink(scopeId, action.url);
        else {
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
