import type { GoalLink } from "./domain.js";

export function parseLinkUrl(value: string): URL {
  if (
    Array.from(value.trim()).some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 32 || (code >= 127 && code <= 159);
    })
  )
    throw new Error("URL must not contain spaces or control characters");
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Only HTTP and HTTPS links are supported");
  if (url.username || url.password) throw new Error("URL must not contain credentials");
  return url;
}

export function isPullRequestUrl(value: string): boolean {
  const url = parseLinkUrl(value);
  // Path-based recognition also supports GitHub Enterprise and self-hosted GitLab.
  return (
    /^\/[^/]+\/[^/]+\/pull\/[1-9]\d*(?:\/|$)/u.test(url.pathname) ||
    /^\/.+\/-\/merge_requests\/[1-9]\d*(?:\/|$)/u.test(url.pathname) ||
    /^\/[^/]+\/[^/]+\/pull-requests\/[1-9]\d*(?:\/|$)/u.test(url.pathname)
  );
}

export function filterLinks(
  links: GoalLink[],
  query: string,
  prsOnly = false,
  goalId?: string,
): GoalLink[] {
  const needle = query.trim().toLowerCase();
  return links.filter(
    (link) =>
      (!goalId || link.goalId === goalId) &&
      (!prsOnly || isPullRequestUrl(link.url)) &&
      [link.title, link.url, link.description, link.goalName].some((text) =>
        text?.toLowerCase().includes(needle),
      ),
  );
}

export function linkBrowserCommand(
  value: string,
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  const url = parseLinkUrl(value).href;
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "linux":
      return { command: "xdg-open", args: [url] };
    case "win32":
      return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
    default:
      throw new Error(
        `Opening links is unsupported on ${platform}; open the displayed URL manually`,
      );
  }
}
