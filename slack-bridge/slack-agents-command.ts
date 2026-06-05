import type { BrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-dashboard.js";

export interface SlackAgentCommandSettings {
  skinTheme?: string | null;
  slackCommandName?: string | null;
  slackCommandNames?: string[] | null;
}

export interface SlackAgentsCommandInput {
  command: string;
  text: string;
  channelId: string;
  userId: string;
}

const DEFAULT_SLACK_COMMAND_NAME = "/pinet";
const OATHGATE_SLACK_COMMAND_NAME = "/oathgate";

export function normalizeSlackCommandName(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;
  const command = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return /^\/[a-z0-9_-]+$/.test(command) ? command : null;
}

function defaultSlackCommandNameForSkin(skinTheme: string | null | undefined): string {
  const normalized = skinTheme?.trim().toLowerCase();
  if (normalized === "oathgate" || normalized === "cosmere" || normalized === "cosmere-inspired") {
    return OATHGATE_SLACK_COMMAND_NAME;
  }
  return DEFAULT_SLACK_COMMAND_NAME;
}

export function resolveSlackAgentCommandNames(
  settings: SlackAgentCommandSettings,
  activeSkinTheme?: string | null,
): string[] {
  const configured = [
    ...(settings.slackCommandName ? [settings.slackCommandName] : []),
    ...(Array.isArray(settings.slackCommandNames) ? settings.slackCommandNames : []),
  ]
    .map(normalizeSlackCommandName)
    .filter((command): command is string => command !== null);

  const names =
    configured.length > 0
      ? configured
      : [defaultSlackCommandNameForSkin(activeSkinTheme ?? settings.skinTheme)];
  return [...new Set(names)];
}

export function formatSlackAgentsUsage(commandNames: string[]): string {
  return `Usage: ${commandNames[0] ?? DEFAULT_SLACK_COMMAND_NAME} agents list [all]`;
}

function parseSlackCommandTokens(text: string): string[] {
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function isSlackAgentCommand(command: string, commandNames: string[]): boolean {
  const normalized = normalizeSlackCommandName(command);
  return normalized !== null && commandNames.includes(normalized);
}

export function isSlackAgentsListCommand(
  command: string,
  text: string,
  commandNames: string[],
): boolean {
  if (!isSlackAgentCommand(command, commandNames)) return false;
  const [subject, action] = parseSlackCommandTokens(text);
  return subject === "agents" && action === "list";
}

export function shouldIncludeSlackAgentsGhosts(text: string): boolean {
  return parseSlackCommandTokens(text).some(
    (token) => token === "all" || token === "ghosts" || token === "--all" || token === "--ghosts",
  );
}

export function formatSlackAgentsDashboard(
  snapshot: BrokerControlPlaneDashboardSnapshot,
  includeGhosts: boolean,
): string {
  const rows = includeGhosts
    ? snapshot.roster
    : snapshot.roster.filter(
        (row) => !row.health.includes("ghost") && !row.health.includes("resumable"),
      );
  const visibleRows = rows.slice(0, 20);
  const headerParts = [
    `Pinet agents: ${visibleRows.length}${rows.length !== visibleRows.length ? ` of ${rows.length}` : ""} shown`,
    `${snapshot.liveAgents} live`,
    `${snapshot.workerCount} workers`,
    `${snapshot.workingWorkers} working`,
    `${snapshot.idleWorkers} idle`,
    `backlog ${snapshot.pendingBacklogCount}`,
  ];
  if (snapshot.ghostAgents > 0) {
    headerParts.push(`${snapshot.ghostAgents} ghost${snapshot.ghostAgents === 1 ? "" : "s"}`);
  }
  if (snapshot.stuckAgents > 0) {
    headerParts.push(`${snapshot.stuckAgents} stuck`);
  }

  const rosterLines = visibleRows.length
    ? visibleRows.flatMap((row) => [
        `${row.label} · ${row.role} · ${row.status} · ${row.health}`,
        `  Workload: ${row.workload}`,
        `  Task: ${row.taskSummary}`,
        `  Heartbeat: ${row.heartbeat}`,
        `  Branch: ${row.branch} · Worktree: ${row.worktree}`,
      ])
    : ["No agents are currently registered."];

  const activeLanes = snapshot.activeLanes.slice(0, 8);
  const detachedLanes = snapshot.detachedLanes.slice(0, 4);
  return [
    headerParts.join(" · "),
    rosterLines.join("\n"),
    activeLanes.length > 0
      ? ["Active lanes:", ...activeLanes.map((lane) => `• ${lane}`)].join("\n")
      : null,
    detachedLanes.length > 0
      ? ["Detached lanes:", ...detachedLanes.map((lane) => `• ${lane}`)].join("\n")
      : null,
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}
