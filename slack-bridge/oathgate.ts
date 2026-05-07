import * as path from "node:path";
import { buildAgentDisplayInfo, filterAgentsForMeshVisibility } from "./helpers.js";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from "./broker/socket-server.js";
import { HEARTBEAT_INTERVAL_MS } from "./broker/client.js";
import type { AgentInfo, PinetLaneInfo } from "./broker/types.js";

export interface OathgateAgentInput extends AgentInfo {
  pendingInboxCount?: number;
  ownedThreadCount?: number;
}

export interface OathgateAgentSummary {
  agentId: string;
  copyText: string;
  label: string;
  status: "working" | "idle";
  health: string;
  role: string;
  repo: string | null;
  branch: string | null;
  worktreeHint: string | null;
  activity: string;
  workload: string;
  lane: string | null;
}

export interface BuildOathgateAgentSummariesInput {
  agents: OathgateAgentInput[];
  lanes?: PinetLaneInfo[];
  now?: number;
  homedir?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function stripControlChars(value: string): string {
  return [...value]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeCodeSpan(value: string): string {
  return stripControlChars(value).replace(/`/g, "'");
}

function plainText(
  value: string,
  maxLength = 75,
): { type: "plain_text"; text: string; emoji: true } {
  return {
    type: "plain_text",
    text: truncateText(stripControlChars(value), maxLength),
    emoji: true,
  };
}

function mrkdwnText(value: string): { type: "mrkdwn"; text: string } {
  return { type: "mrkdwn", text: value };
}

function pathHintFromMetadata(
  metadata: Record<string, unknown> | null,
  homedir: string,
): string | null {
  const cwd = asString(metadata?.cwd);
  if (!cwd) return null;

  const repoRoot =
    asString(metadata?.repoRoot) ?? asString(asRecord(metadata?.capabilities)?.repoRoot);
  if (repoRoot) {
    const relative = path.relative(repoRoot, cwd);
    if (relative === "") return "repo root";
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return truncateText(relative, 48);
    }
  }

  const normalizedHome = homedir.endsWith(path.sep) ? homedir : `${homedir}${path.sep}`;
  if (cwd.startsWith(normalizedHome)) {
    const relativeHome = cwd.slice(normalizedHome.length);
    const worktreeIndex = relativeHome.split(path.sep).indexOf(".worktrees");
    if (worktreeIndex >= 0) {
      const parts = relativeHome.split(path.sep).slice(worktreeIndex, worktreeIndex + 2);
      return truncateText(parts.join("/"), 48);
    }
  }

  const base = path.basename(cwd);
  return base ? truncateText(base, 48) : null;
}

function laneMatchesAgent(lane: PinetLaneInfo, agentId: string): boolean {
  return (
    lane.ownerAgentId === agentId ||
    lane.implementationLeadAgentId === agentId ||
    lane.participants.some((participant) => participant.agentId === agentId)
  );
}

function formatLane(lane: PinetLaneInfo): string {
  const refs = [
    lane.issueNumber != null ? `#${lane.issueNumber}` : null,
    lane.prNumber != null ? `PR #${lane.prNumber}` : null,
  ].filter((ref): ref is string => Boolean(ref));
  const name = lane.name ?? lane.laneId;
  return truncateText(`${name} [${lane.state}]${refs.length ? ` (${refs.join(" · ")})` : ""}`, 72);
}

function getRole(metadata: Record<string, unknown> | null): string {
  const capabilities = asRecord(metadata?.capabilities);
  return asString(capabilities?.role) ?? asString(metadata?.role) ?? "worker";
}

function getRepo(metadata: Record<string, unknown> | null): string | null {
  const capabilities = asRecord(metadata?.capabilities);
  return asString(capabilities?.repo) ?? asString(metadata?.repo);
}

function getBranch(metadata: Record<string, unknown> | null): string | null {
  const capabilities = asRecord(metadata?.capabilities);
  return asString(capabilities?.branch) ?? asString(metadata?.branch);
}

function summarizeWorkload(agent: OathgateAgentInput): string {
  const parts = [
    `${agent.pendingInboxCount ?? 0} inbox`,
    `${agent.ownedThreadCount ?? 0} thread${agent.ownedThreadCount === 1 ? "" : "s"}`,
  ];
  return parts.join(" / ");
}

export function buildOathgateAgentSummaries(
  input: BuildOathgateAgentSummariesInput,
): OathgateAgentSummary[] {
  const now = input.now ?? Date.now();
  const homedir = input.homedir ?? process.env.HOME ?? "";
  const visibleAgents = filterAgentsForMeshVisibility(input.agents, {
    now,
    includeGhosts: true,
    recentDisconnectWindowMs: DEFAULT_HEARTBEAT_TIMEOUT_MS * 2,
  });
  const activeLanes = (input.lanes ?? []).filter(
    (lane) => lane.state !== "done" && lane.state !== "cancelled" && lane.state !== "detached",
  );

  return visibleAgents
    .map((agent) => {
      const display = buildAgentDisplayInfo(agent, {
        now,
        heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      });
      const metadata = asRecord(agent.metadata);
      const matchingLane = [...activeLanes]
        .filter((lane) => laneMatchesAgent(lane, agent.id))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
      const repo = getRepo(metadata);
      const branch = getBranch(metadata);
      const role = getRole(metadata);
      const health = display.health ?? "unknown";
      return {
        agentId: agent.id,
        copyText: agent.name,
        label: `${agent.emoji} ${agent.name}`,
        status: agent.status,
        health,
        role,
        repo,
        branch,
        worktreeHint: pathHintFromMetadata(metadata, homedir),
        activity: display.lastActivityAge
          ? `last active ${display.lastActivityAge}`
          : "activity n/a",
        workload: summarizeWorkload(agent),
        lane: matchingLane ? formatLane(matchingLane) : null,
      } satisfies OathgateAgentSummary;
    })
    .sort((left, right) => {
      const leftGhost = left.health === "ghost" ? 1 : 0;
      const rightGhost = right.health === "ghost" ? 1 : 0;
      if (leftGhost !== rightGhost) return leftGhost - rightGhost;
      if (left.status !== right.status) return left.status === "idle" ? -1 : 1;
      return left.copyText.localeCompare(right.copyText);
    });
}

function formatAgentDescription(agent: OathgateAgentSummary): string {
  const location = [agent.repo, agent.branch]
    .filter((part): part is string => Boolean(part))
    .join("/");
  return [agent.status, agent.health, location || agent.role, agent.worktreeHint]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function formatAgentListLine(agent: OathgateAgentSummary): string {
  const context = [
    `${agent.status}/${agent.health}`,
    agent.repo,
    agent.branch,
    agent.worktreeHint ? `cwd:${agent.worktreeHint}` : null,
    agent.lane,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return `• \`${escapeCodeSpan(agent.copyText)}\` — ${context || agent.role}`;
}

export function buildOathgateModalView(input: {
  agents: OathgateAgentSummary[];
  commandText?: string | null;
}): Record<string, unknown> {
  const visibleAgents = input.agents.slice(0, 100);
  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: mrkdwnText(
        "Pick an agent name to copy/paste into chat. `/oathgate` v1 only shows safe routing context; it does not send or route messages for you.",
      ),
    },
  ];

  if (visibleAgents.length > 0) {
    blocks.push({
      type: "section",
      text: mrkdwnText("Use the picker to inspect agents, then copy the name from the list below."),
      accessory: {
        type: "static_select",
        action_id: "oathgate_agent_select",
        placeholder: plainText("Select an agent"),
        options: visibleAgents.map((agent) => ({
          text: plainText(agent.label),
          value: agent.agentId,
          description: plainText(formatAgentDescription(agent)),
        })),
      },
    });
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: mrkdwnText(visibleAgents.slice(0, 12).map(formatAgentListLine).join("\n")),
    });
    if (input.agents.length > 12) {
      blocks.push({
        type: "context",
        elements: [
          mrkdwnText(
            `Showing 12 of ${input.agents.length} agents in the copy list; use the picker for the rest.`,
          ),
        ],
      });
    }
  } else {
    blocks.push({
      type: "section",
      text: mrkdwnText(
        "No visible Pinet agents are available right now. Start the broker mesh with `/pinet start`, then try `/oathgate` again.",
      ),
    });
  }

  return {
    type: "modal",
    callback_id: "oathgate.agent_picker",
    title: plainText("Oathgate", 24),
    close: plainText("Close", 24),
    private_metadata: JSON.stringify({ workflow: "oathgate.agent_picker" }),
    blocks,
  };
}
