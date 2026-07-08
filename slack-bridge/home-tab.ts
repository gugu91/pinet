import type { BrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-dashboard.js";
import type { SlackBridgeRuntimeMode } from "./runtime-mode.js";

export type SlackBlock = Record<string, unknown>;
export type SlackSectionAccessory = Record<string, unknown>;
export type SlackHomeTabPublishResponse = Record<string, unknown>;

export interface SlackTextObject extends Record<string, unknown> {
  type: "plain_text" | "mrkdwn";
  text: string;
  emoji?: boolean;
}

export interface SlackHomeView {
  type: "home";
  blocks: SlackBlock[];
}

export interface SlackHomeTabPublishRequest extends Record<string, unknown> {
  user_id: string;
  view: SlackHomeView;
}

export interface PublishSlackHomeTabInput {
  slack: (
    method: string,
    token: string,
    body?: SlackHomeTabPublishRequest,
  ) => Promise<SlackHomeTabPublishResponse>;
  token: string;
  userId: string;
  view: SlackHomeView;
}

export interface StandalonePinetHomeTabInput {
  agentName: string;
  agentEmoji: string;
  connected: boolean;
  mode: SlackBridgeRuntimeMode;
  activeThreads: number;
  pendingInbox: number;
  currentBranch?: string | null;
  defaultChannel?: string | null;
}

const MAX_SECTION_TEXT_LENGTH = 2800;
const MAX_ROSTER_ENTRIES = 20;

function asNonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }

  return new Date(parsed)
    .toISOString()
    .replace("T", " ")
    .replace(".000", "")
    .replace(/:\d\dZ$/, "Z");
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "n/a";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = seconds / 60;
  return `${minutes.toFixed(minutes < 10 ? 1 : 0)}m`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function plainText(text: string): SlackTextObject {
  return {
    type: "plain_text",
    text: truncate(text, 150),
    emoji: true,
  };
}

function mrkdwn(text: string): SlackTextObject {
  return {
    type: "mrkdwn",
    text,
  };
}

function headerBlock(text: string): SlackBlock {
  return {
    type: "header",
    text: plainText(text),
  };
}

function contextBlock(lines: string[]): SlackBlock {
  return {
    type: "context",
    elements: lines.map((line) => mrkdwn(line)),
  };
}

function dividerBlock(): SlackBlock {
  return { type: "divider" };
}

function sectionBlock(options: {
  text?: string;
  fields?: string[];
  accessory?: SlackSectionAccessory;
}): SlackBlock {
  return {
    type: "section",
    ...(options.text ? { text: mrkdwn(options.text) } : {}),
    ...(options.fields && options.fields.length > 0
      ? { fields: options.fields.slice(0, 10).map((field) => mrkdwn(field)) }
      : {}),
    ...(options.accessory ? { accessory: options.accessory } : {}),
  };
}

function buildLineSections(lines: string[], emptyState: string): SlackBlock[] {
  if (lines.length === 0) {
    return [sectionBlock({ text: emptyState })];
  }

  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const candidate = current.length > 0 ? `${current}\n${line}` : line;
    if (candidate.length > MAX_SECTION_TEXT_LENGTH && current.length > 0) {
      chunks.push(current);
      current = line;
      continue;
    }

    if (line.length > MAX_SECTION_TEXT_LENGTH) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      chunks.push(truncate(line, MAX_SECTION_TEXT_LENGTH));
      continue;
    }

    current = candidate;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks.map((chunk) => sectionBlock({ text: chunk }));
}

function buildRosterBlocks(snapshot: BrokerControlPlaneDashboardSnapshot): SlackBlock[] {
  const visibleRoster = snapshot.roster.slice(0, MAX_ROSTER_ENTRIES);
  const blocks =
    visibleRoster.length > 0
      ? visibleRoster.map((row) =>
          sectionBlock({
            text: [
              `*${row.label}* · \`${row.role}\``,
              `Health: ${row.health} · Status: ${row.status}`,
              `Workload: ${row.workload}`,
              `Task: ${truncate(row.taskSummary, 120)}`,
              `Heartbeat: ${row.heartbeat}`,
              `Branch: ${row.branch} · Worktree: ${row.worktree}`,
            ].join("\n"),
          }),
        )
      : [sectionBlock({ text: "No agents are currently registered." })];

  if (snapshot.roster.length > visibleRoster.length) {
    blocks.push(
      contextBlock([
        `_Showing ${visibleRoster.length} of ${snapshot.roster.length} agents on the Home tab._`,
      ]),
    );
  }

  return blocks;
}

export function renderBrokerControlPlaneHomeTabView(
  snapshot: BrokerControlPlaneDashboardSnapshot,
): SlackHomeView {
  const anomalyLines =
    snapshot.anomalies.length > 0
      ? snapshot.anomalies.map((anomaly) => `• ${anomaly}`)
      : ["• Healthy ✅"];
  const maintenanceLines = snapshot.maintenanceAnomalies.map((anomaly) => `• ${anomaly}`);
  const snoozeLine = snapshot.ralphSnooze?.active
    ? `active until ${snapshot.ralphSnooze.until ?? "unknown"}${snapshot.ralphSnooze.reason ? ` — ${snapshot.ralphSnooze.reason}` : ""}`
    : `off${snapshot.ralphSnooze ? ` · ${snapshot.ralphSnooze.emptyCycleCount} empty cycles` : ""}`;
  const cycleLines = snapshot.recentCycles.map(
    (cycle) =>
      `• *${cycle.startedAt}* — ${cycle.duration} · ${cycle.agentCount} agents · backlog ${cycle.backlogCount} · ghosts ${cycle.ghostCount} · stuck ${cycle.stuckCount} · follow-up ${cycle.followUpDelivered ? "yes" : "no"}\n  ${cycle.anomalySummary}`,
  );

  const blocks: SlackBlock[] = [
    headerBlock("Pinet Broker Control Plane"),
    contextBlock([
      `_Updated ${formatTimestamp(snapshot.cycleStartedAt)} · cycle ${formatDuration(snapshot.cycleDurationMs)}_`,
    ]),
    sectionBlock({
      text: "This Home tab mirrors the broker control-plane dashboard with live mesh, task, and RALPH loop status.",
    }),
    dividerBlock(),
    headerBlock("Mesh summary"),
    sectionBlock({
      fields: [
        `*Main checkout*\n\`${snapshot.currentBranch ?? "unknown"}\``,
        `*Agents*\n${snapshot.liveAgents} live / ${snapshot.totalAgents} total`,
        `*Workers*\n${snapshot.workingWorkers} working · ${snapshot.idleWorkers} idle`,
        `*Backlog*\n${snapshot.pendingBacklogCount} pending · ${snapshot.assignedBacklogCount} assigned`,
        `*RALPH nudges*\n${snapshot.nudgesThisCycle} nudges · ${snapshot.idleDrainCandidates} idle drains`,
        `*RALPH snooze*\n${snoozeLine}`,
        `*Maintenance*\n${snapshot.reapedAgents} reaped · ${snapshot.repairedThreadClaims} repaired claims`,
      ],
    }),
    headerBlock("Active anomalies"),
    ...buildLineSections(anomalyLines, "Healthy ✅"),
    ...(maintenanceLines.length > 0
      ? [headerBlock("Maintenance anomalies"), ...buildLineSections(maintenanceLines, "None.")]
      : []),
    headerBlock("Agent roster"),
    ...buildRosterBlocks(snapshot),
    headerBlock("Task / PR status"),
    sectionBlock({
      fields: [
        `*Assigned*\n${snapshot.taskCounts.assigned}`,
        `*Branch pushed*\n${snapshot.taskCounts.branchPushed}`,
        `*Open PRs*\n${snapshot.taskCounts.openPrs}`,
        `*Merged PRs*\n${snapshot.taskCounts.mergedPrs}`,
        `*Closed PRs*\n${snapshot.taskCounts.closedPrs}`,
      ],
    }),
    headerBlock("Active tasks"),
    ...buildLineSections(
      snapshot.activeTasks.map((task) => `• ${task}`),
      "No active tracked tasks.",
    ),
    headerBlock("Recent outcomes"),
    ...buildLineSections(
      snapshot.recentOutcomes.map((task) => `• ${task}`),
      "No merged or closed PR outcomes tracked yet.",
    ),
    headerBlock("Lane metadata"),
    headerBlock("Active/managed lanes"),
    ...buildLineSections(
      snapshot.activeLanes.map((lane) => `• ${lane}`),
      "No active managed lanes tracked.",
    ),
    headerBlock("Detached/manual-supervision lanes"),
    ...buildLineSections(
      snapshot.detachedLanes.map((lane) => `• ${lane}`),
      "No detached lanes tracked.",
    ),
    headerBlock("Recent RALPH cycles"),
    ...buildLineSections(cycleLines, "No recorded RALPH cycles yet."),
    dividerBlock(),
    headerBlock("Quick actions"),
    sectionBlock({
      text: [
        "• Open a DM with Pinet in the *Messages* tab to assign or follow up on work.",
        "• Mention Pinet in a channel thread to route a task into the broker mesh.",
      ].join("\n"),
    }),
  ];

  return {
    type: "home",
    blocks,
  };
}

export function renderStandalonePinetHomeTabView(
  input: StandalonePinetHomeTabInput,
): SlackHomeView {
  const modeLabel = input.mode;
  const branch = asNonEmptyString(input.currentBranch) ?? "unknown";
  const defaultChannel = asNonEmptyString(input.defaultChannel) ?? "not configured";

  return {
    type: "home",
    blocks: [
      headerBlock("Pinet Home"),
      contextBlock([
        `${input.agentEmoji} *${input.agentName}* · ${input.connected ? "connected" : "disconnected"}`,
      ]),
      sectionBlock({
        text: "Pinet is available from Slack’s Home tab. When the broker mesh is running, this surface upgrades into the full control-plane dashboard.",
      }),
      dividerBlock(),
      headerBlock("Current runtime"),
      sectionBlock({
        fields: [
          `*Mode*\n${modeLabel}`,
          `*Connection*\n${input.connected ? "connected" : "disconnected"}`,
          `*Branch*\n\`${branch}\``,
          `*Active threads*\n${input.activeThreads}`,
          `*Pending inbox*\n${input.pendingInbox}`,
          `*Default channel*\n${defaultChannel}`,
        ],
      }),
      headerBlock("Getting started"),
      sectionBlock({
        text: [
          "• Open the *Messages* tab and start a conversation with Pinet.",
          "• Mention Pinet in a channel to continue work in-thread.",
          '• Use `runtimeMode: "single"` for local Slack-only mode, or `/pinet start` and `/pinet follow` for mesh runtimes.',
        ].join("\n"),
      }),
    ],
  };
}

export function buildSlackHomeTabPublishRequest(
  userId: string,
  view: SlackHomeView,
): SlackHomeTabPublishRequest {
  const normalizedUserId = asNonEmptyString(userId);
  if (!normalizedUserId) {
    throw new Error("Home tab publish requires a user ID.");
  }

  return {
    user_id: normalizedUserId,
    view,
  };
}

export async function publishSlackHomeTab(input: PublishSlackHomeTabInput): Promise<void> {
  await input.slack(
    "views.publish",
    input.token,
    buildSlackHomeTabPublishRequest(input.userId, input.view),
  );
}
