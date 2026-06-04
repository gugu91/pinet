import type {
  PinetLaneInfo,
  TaskAssignmentInfo,
  TaskAssignmentStatus,
  ThreadInfo,
} from "./broker/types.js";

export type GithubEventRelayStatus = Extract<TaskAssignmentStatus, "pr_open" | "pr_merged">;

export interface GithubEventRelayEvent {
  eventType: "github_pr_lifecycle";
  eventId: string;
  source: "task_assignment_poll";
  owner: string | null;
  repo: string | null;
  repoKey: string;
  issueNumber: number;
  prNumber: number;
  status: GithubEventRelayStatus;
  url: string | null;
  actorAgentId: string;
  occurredAt: string;
}

export interface GithubEventRelayTarget {
  threadId: string;
  source: "slack";
  channel: string;
}

export interface GithubEventRelayPayload {
  event: GithubEventRelayEvent;
  text: string;
  metadata: Record<string, unknown>;
  target: GithubEventRelayTarget;
}

function normalizeRepoPart(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function buildGithubRepoKey(input: { owner?: string | null; repo?: string | null }): string {
  const owner = normalizeRepoPart(input.owner);
  const repo = normalizeRepoPart(input.repo);
  return owner && repo ? `${owner}/${repo}`.toLowerCase() : "repo_unknown";
}

function buildPullRequestUrl(input: {
  owner: string | null;
  repo: string | null;
  prNumber: number;
}): string | null {
  return input.owner && input.repo
    ? `https://github.com/${input.owner}/${input.repo}/pull/${input.prNumber}`
    : null;
}

export function isGithubEventRelayStatus(
  status: TaskAssignmentStatus,
): status is GithubEventRelayStatus {
  return status === "pr_open" || status === "pr_merged";
}

export function buildGithubEventRelayEvent(
  assignment: Pick<TaskAssignmentInfo, "agentId" | "issueNumber" | "repoOwner" | "repoName"> & {
    nextStatus: TaskAssignmentStatus;
    nextPrNumber: number | null;
  },
  occurredAt: string,
): GithubEventRelayEvent | null {
  if (!isGithubEventRelayStatus(assignment.nextStatus) || assignment.nextPrNumber == null) {
    return null;
  }

  const owner = normalizeRepoPart(assignment.repoOwner);
  const repo = normalizeRepoPart(assignment.repoName);
  const repoKey = buildGithubRepoKey({ owner, repo });
  const prNumber = assignment.nextPrNumber;
  const status = assignment.nextStatus;

  return {
    eventType: "github_pr_lifecycle",
    eventId: `github:${repoKey}:issue:${assignment.issueNumber}:pr:${prNumber}:status:${status}`,
    source: "task_assignment_poll",
    owner,
    repo,
    repoKey,
    issueNumber: assignment.issueNumber,
    prNumber,
    status,
    url: buildPullRequestUrl({ owner, repo, prNumber }),
    actorAgentId: assignment.agentId,
    occurredAt,
  };
}

export function formatGithubEventRelayText(event: GithubEventRelayEvent): string {
  const repoPrefix = event.repoKey === "repo_unknown" ? "" : `${event.repoKey} `;
  const linkedPr = event.url ? `<${event.url}|PR #${event.prNumber}>` : `PR #${event.prNumber}`;
  if (event.status === "pr_merged") {
    return `GitHub relay: ${repoPrefix}${linkedPr} merged for issue #${event.issueNumber}.`;
  }
  return `GitHub relay: ${repoPrefix}${linkedPr} opened/ready for review for issue #${event.issueNumber}.`;
}

export function buildGithubEventRelayMetadata(
  event: GithubEventRelayEvent,
): Record<string, unknown> {
  return {
    githubEventRelay: event,
    github: {
      owner: event.owner,
      repo: event.repo,
      repoKey: event.repoKey,
      issueNumber: event.issueNumber,
      prNumber: event.prNumber,
      status: event.status,
      url: event.url,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getLaneGithubRepoKey(lane: Pick<PinetLaneInfo, "metadata">): string | null {
  const metadata = asRecord(lane.metadata);
  const github = asRecord(metadata?.github);
  const owner =
    normalizeRepoPart(github?.owner as string | null | undefined) ??
    normalizeRepoPart(metadata?.githubOwner as string | null | undefined);
  const repo =
    normalizeRepoPart(github?.repo as string | null | undefined) ??
    normalizeRepoPart(metadata?.githubRepo as string | null | undefined);
  return owner && repo ? buildGithubRepoKey({ owner, repo }) : null;
}

export function selectPinetLanesForGithubEventRelay(
  lanes: ReadonlyArray<PinetLaneInfo>,
  event: Pick<GithubEventRelayEvent, "issueNumber" | "repoKey">,
): PinetLaneInfo[] {
  const issueMatches = lanes.filter((lane) => lane.issueNumber === event.issueNumber);
  const exactMatches = issueMatches.filter((lane) => getLaneGithubRepoKey(lane) === event.repoKey);
  if (exactMatches.length > 0) {
    return exactMatches;
  }

  const unscopedMatches = issueMatches.filter((lane) => getLaneGithubRepoKey(lane) === null);
  return unscopedMatches.length === 1 ? unscopedMatches : [];
}

export function mergeGithubEventRelayMetadata(
  existing: Record<string, unknown> | null | undefined,
  event: GithubEventRelayEvent,
): Record<string, unknown> {
  const base = existing ? { ...existing } : {};
  return {
    ...base,
    githubEventRelay: event,
    github: {
      ...asRecord(base.github),
      owner: event.owner,
      repo: event.repo,
      repoKey: event.repoKey,
      issueNumber: event.issueNumber,
      prNumber: event.prNumber,
      status: event.status,
      url: event.url,
      updatedAt: event.occurredAt,
    },
  };
}

function hasSlackThreadContext(metadata: Record<string, unknown> | null | undefined): boolean {
  const context = asRecord(metadata?.slackThreadContext);
  return typeof context?.channelId === "string" && context.channelId.length > 0;
}

export function resolveSafeGithubEventRelayTarget(
  threadsById: (threadId: string) => ThreadInfo | null,
  event: GithubEventRelayEvent,
  lanes: ReadonlyArray<PinetLaneInfo>,
  assignmentThreadId: string,
): GithubEventRelayTarget | null {
  const laneThreadIds = selectPinetLanesForGithubEventRelay(lanes, event)
    .map((lane) => lane.threadId)
    .filter((threadId): threadId is string => typeof threadId === "string" && threadId.length > 0);
  const candidateThreadIds = [...new Set([...laneThreadIds, assignmentThreadId])];

  for (const threadId of candidateThreadIds) {
    const thread = threadsById(threadId);
    if (!thread || thread.source !== "slack" || !thread.channel) {
      continue;
    }
    if (thread.channel.startsWith("D") && !hasSlackThreadContext(thread.metadata)) {
      continue;
    }
    return { threadId, source: "slack", channel: thread.channel };
  }

  return null;
}

export function buildGithubEventRelayPayload(
  event: GithubEventRelayEvent,
  target: GithubEventRelayTarget,
): GithubEventRelayPayload {
  return {
    event,
    target,
    text: formatGithubEventRelayText(event),
    metadata: buildGithubEventRelayMetadata(event),
  };
}
