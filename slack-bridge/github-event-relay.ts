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
  return `GitHub relay: ${repoPrefix}${linkedPr} opened for issue #${event.issueNumber}.`;
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

function isTerminalLaneForVisibleRelay(lane: Pick<PinetLaneInfo, "state">): boolean {
  return lane.state === "done" || lane.state === "cancelled" || lane.state === "detached";
}

function getVisibleRelayLaneRank(lane: Pick<PinetLaneInfo, "state">): number {
  return isTerminalLaneForVisibleRelay(lane) ? 2 : 0;
}

function getSafeGithubEventRelayTarget(
  threadsById: (threadId: string) => ThreadInfo | null,
  threadId: string | null | undefined,
): GithubEventRelayTarget | null {
  if (!threadId) return null;
  const thread = threadsById(threadId);
  if (!thread || thread.source !== "slack" || !thread.channel) {
    return null;
  }
  if (thread.channel.startsWith("D") && !hasSlackThreadContext(thread.metadata)) {
    return null;
  }
  return { threadId, source: "slack", channel: thread.channel };
}

export function resolveSafeGithubEventRelayTarget(
  threadsById: (threadId: string) => ThreadInfo | null,
  event: GithubEventRelayEvent,
  lanes: ReadonlyArray<PinetLaneInfo>,
  assignmentThreadId: string,
): GithubEventRelayTarget | null {
  const candidatesByThreadId = new Map<string, { target: GithubEventRelayTarget; rank: number }>();
  const addCandidate = (threadId: string | null | undefined, rank: number): void => {
    const target = getSafeGithubEventRelayTarget(threadsById, threadId);
    if (!target) return;

    const existing = candidatesByThreadId.get(target.threadId);
    if (!existing || rank < existing.rank) {
      candidatesByThreadId.set(target.threadId, { target, rank });
    }
  };

  for (const lane of selectPinetLanesForGithubEventRelay(lanes, event)) {
    addCandidate(lane.threadId, getVisibleRelayLaneRank(lane));
  }
  addCandidate(assignmentThreadId, 1);

  const candidates = [...candidatesByThreadId.values()];
  if (candidates.length === 0) return null;

  const bestRank = Math.min(...candidates.map((candidate) => candidate.rank));
  const bestCandidates = candidates.filter((candidate) => candidate.rank === bestRank);
  return bestCandidates.length === 1 ? bestCandidates[0]!.target : null;
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
