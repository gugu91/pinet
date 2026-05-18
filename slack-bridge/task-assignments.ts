import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentInfo,
  TaskAssignmentInfo,
  TaskAssignmentKind,
  TaskAssignmentStatus,
} from "./broker/types.js";

const execFileAsync = promisify(execFile);

export type CommandResult = { stdout?: string | Buffer };
export type CommandRunner = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: "utf-8" },
) => Promise<CommandResult>;

export interface ParsedTaskAssignment {
  issueNumber: number;
  branch: string | null;
  repoOwner: string | null;
  repoName: string | null;
  taskKind: TaskAssignmentKind;
}

export interface PullRequestSnapshot {
  number: number;
  state: string;
  mergedAt: string | null;
  headRefName: string;
}

export interface IssueSnapshot {
  number: number;
  state: string;
}

export interface ResolvedTaskAssignment extends TaskAssignmentInfo {
  nextStatus: TaskAssignmentStatus;
  nextPrNumber: number | null;
  branchAheadCount: number;
  issueState: "OPEN" | "CLOSED" | null;
}

const WORKTREE_BRANCH_REGEX = /\bgit\s+worktree\s+add\b[^\n]*?\s-b\s+([^\s`"',;]+)/i;
const CHECKOUT_BRANCH_REGEX = /\bgit\s+(?:checkout|switch)\s+-[cb]\s+([^\s`"',;]+)/i;
const EXPLICIT_BRANCH_LABEL_REGEX =
  /\bbranch(?:\s+to\s+work\s+on|\s+name)?\s*:\s*[`"']?([A-Za-z0-9._/-]+)\b/i;
const ISSUE_PR_LINE_REGEX = /(?:^|\n)\s*(?:[-*]\s*)?issue\/pr\s*:\s*#(\d+)\b/gi;
const ISSUE_LINE_REGEX = /(?:^|\n)\s*(?:[-*]\s*)?issue\s*:\s*#(\d+)\b/gi;
const ISSUE_HEADING_REGEX = /(?:^|\n)\s*(?:[-*]\s*)?issue\s+#(\d+)(?=\s*(?:[—–:-]|$))/gi;
const TASK_ISSUE_REGEX = /(?:^|\n)\s*(?:[-*]\s*)?task\s*:\s*[^\n#]*\bissue\s*#(\d+)\b/gi;
const NEW_TASK_ISSUE_REGEX =
  /(?:^|\n)\s*(?:[-*]\s*)?new(?:\s+[a-z-]+){0,3}\s+task\b[^\n#]*\bissue\s*#(\d+)\b/gi;
const FOLLOW_UP_TASK_ISSUE_REGEX =
  /(?:^|\n)\s*(?:[-*]\s*)?follow-up\s+task(?:\s+from)?\s+issue\s*#(\d+)\b/gi;
const GITHUB_REPO_URL_REGEX =
  /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)\b/gi;
const GITHUB_REPO_ISSUE_URL_REGEX =
  /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)\b/gi;
const REPO_LABEL_REGEX =
  /(?:^|\n)\s*(?:[-*]\s*)?(?:repo|repository)\s*:\s*(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/i;
const READ_ONLY_REVIEW_REGEX =
  /\b(?:read-only|do not mutate|do not edit|review-only|review only|second-pass|second pass|code review)\b/i;
const REVIEW_TASK_REGEX = /\b(?:review|code review)\b/i;
const QA_ONLY_TASK_REGEX =
  /\b(?:qa-only|qa only|test-only|test only|verify-only|verify only|validation-only|validation only)\b/i;
const QA_TASK_REGEX = /\b(?:qa|test|verify|validation|visual verify|visual verification)\b/i;
const MERGE_TASK_REGEX = /\bmerge\s+pr\s*#?\d+|\bmerge-only\b|\bmerge only\b/i;
const INTERACTIVE_TASK_REGEX = /\b(?:interactive-session|human-gated|manual|browser session)\b/i;
const IMPLEMENTATION_TASK_REGEX =
  /\b(?:implementation lane|implement|fix|build|change|patch|create a pr|open a pr|branch|worktree)\b/i;

async function runCommand(
  file: string,
  args: string[],
  cwd: string,
  runner: CommandRunner,
): Promise<string | undefined> {
  try {
    const result = await runner(file, args, { cwd, encoding: "utf-8" });
    const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString();
    const trimmed = stdout?.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function runJsonCommand<T>(
  file: string,
  args: string[],
  cwd: string,
  runner: CommandRunner,
): Promise<T | undefined> {
  const stdout = await runCommand(file, args, cwd, runner);
  if (!stdout) {
    return undefined;
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    return undefined;
  }
}

function normalizeMessageForTaskParsing(message: string): string {
  return message.replace(/\r\n/g, "\n").replace(/[`*_]/g, "");
}

function parseBranch(message: string): string | null {
  const normalized = normalizeMessageForTaskParsing(message);
  const match =
    normalized.match(WORKTREE_BRANCH_REGEX) ??
    normalized.match(CHECKOUT_BRANCH_REGEX) ??
    normalized.match(EXPLICIT_BRANCH_LABEL_REGEX);
  const branch = match?.[1]?.trim().replace(/[.,;:]+$/, "");
  return branch ? branch : null;
}

function parseIssueNumbers(message: string): number[] {
  const normalized = normalizeMessageForTaskParsing(message);
  const issueNumbers = new Set<number>();

  for (const regex of [
    ISSUE_PR_LINE_REGEX,
    ISSUE_LINE_REGEX,
    ISSUE_HEADING_REGEX,
    TASK_ISSUE_REGEX,
    NEW_TASK_ISSUE_REGEX,
    FOLLOW_UP_TASK_ISSUE_REGEX,
  ]) {
    for (const match of normalized.matchAll(regex)) {
      const issueNumber = Number(match[1]);
      if (Number.isFinite(issueNumber)) {
        issueNumbers.add(issueNumber);
      }
    }
  }

  for (const match of normalized.matchAll(GITHUB_REPO_ISSUE_URL_REGEX)) {
    const issueNumber = Number(match[3]);
    if (Number.isFinite(issueNumber)) {
      issueNumbers.add(issueNumber);
    }
  }

  return [...issueNumbers].sort((left, right) => left - right);
}

function parseRepo(
  message: string,
  issueNumber: number,
): Pick<ParsedTaskAssignment, "repoOwner" | "repoName"> {
  const normalized = normalizeMessageForTaskParsing(message);
  for (const match of normalized.matchAll(GITHUB_REPO_ISSUE_URL_REGEX)) {
    if (Number(match[3]) === issueNumber) {
      return { repoOwner: match[1] ?? null, repoName: match[2] ?? null };
    }
  }

  const repoMatch = normalized.match(REPO_LABEL_REGEX);
  if (repoMatch) {
    return { repoOwner: repoMatch[1] ?? null, repoName: repoMatch[2] ?? null };
  }

  const urlRepos = new Map<string, { repoOwner: string; repoName: string }>();
  for (const match of normalized.matchAll(GITHUB_REPO_URL_REGEX)) {
    if (match[1] && match[2]) {
      urlRepos.set(`${match[1].toLowerCase()}/${match[2].toLowerCase()}`, {
        repoOwner: match[1],
        repoName: match[2],
      });
    }
  }
  if (urlRepos.size === 1) {
    return [...urlRepos.values()][0] ?? { repoOwner: null, repoName: null };
  }

  return { repoOwner: null, repoName: null };
}

function parseTaskKind(message: string, branch: string | null): TaskAssignmentKind {
  const normalized = normalizeMessageForTaskParsing(message);
  if (MERGE_TASK_REGEX.test(normalized)) return "merge";
  if (INTERACTIVE_TASK_REGEX.test(normalized)) return "interactive";
  if (READ_ONLY_REVIEW_REGEX.test(normalized)) return "review";
  if (QA_ONLY_TASK_REGEX.test(normalized)) return "qa";
  if (branch || IMPLEMENTATION_TASK_REGEX.test(normalized)) return "implementation";
  if (REVIEW_TASK_REGEX.test(normalized)) return "review";
  if (QA_TASK_REGEX.test(normalized)) return "qa";
  return "unknown";
}

export function extractTaskAssignmentsFromMessage(message: string): ParsedTaskAssignment[] {
  const branch = parseBranch(message);
  const taskKind = parseTaskKind(message, branch);
  return parseIssueNumbers(message).map((issueNumber) => ({
    issueNumber,
    branch,
    ...parseRepo(message, issueNumber),
    taskKind,
  }));
}

function compareTaskAssignmentRecency(left: TaskAssignmentInfo, right: TaskAssignmentInfo): number {
  const updatedAt = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updatedAt !== 0) {
    return updatedAt;
  }
  const createdAt = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (createdAt !== 0) {
    return createdAt;
  }
  return right.id - left.id;
}

function canonicalizeTaskAssignmentFromSourceMessage(
  assignment: TaskAssignmentInfo,
  sourceMessagesById: ReadonlyMap<number, string>,
): TaskAssignmentInfo | null {
  if (assignment.sourceMessageId == null) {
    return assignment;
  }

  const sourceMessage = sourceMessagesById.get(assignment.sourceMessageId);
  if (!sourceMessage) {
    return assignment;
  }

  const parsedAssignments = extractTaskAssignmentsFromMessage(sourceMessage);
  if (parsedAssignments.length === 0) {
    return null;
  }

  const matchingAssignment = parsedAssignments.find(
    (candidate) => candidate.issueNumber === assignment.issueNumber,
  );
  if (matchingAssignment) {
    return {
      ...assignment,
      branch: matchingAssignment.branch,
      repoOwner: matchingAssignment.repoOwner ?? assignment.repoOwner,
      repoName: matchingAssignment.repoName ?? assignment.repoName,
      taskKind: matchingAssignment.taskKind,
    };
  }

  if (parsedAssignments.length === 1) {
    const [canonicalAssignment] = parsedAssignments;
    return {
      ...assignment,
      issueNumber: canonicalAssignment.issueNumber,
      branch: canonicalAssignment.branch,
      repoOwner: canonicalAssignment.repoOwner ?? assignment.repoOwner,
      repoName: canonicalAssignment.repoName ?? assignment.repoName,
      taskKind: canonicalAssignment.taskKind,
    };
  }

  return null;
}

export function normalizeTrackedTaskAssignments(
  assignments: TaskAssignmentInfo[],
  sourceMessagesById: ReadonlyMap<number, string> = new Map(),
): TaskAssignmentInfo[] {
  const canonicalAssignments = assignments
    .map((assignment) =>
      canonicalizeTaskAssignmentFromSourceMessage(assignment, sourceMessagesById),
    )
    .filter((assignment): assignment is TaskAssignmentInfo => assignment != null)
    .sort(compareTaskAssignmentRecency);

  const visibleAssignments: TaskAssignmentInfo[] = [];
  const seenIssueKeys = new Set<string>();
  for (const assignment of canonicalAssignments) {
    const repoKey =
      assignment.repoOwner && assignment.repoName
        ? `${assignment.repoOwner.toLowerCase()}/${assignment.repoName.toLowerCase()}`
        : assignment.repoRoot
          ? `root:${assignment.repoRoot}`
          : "repo_unknown";
    const issueKey = `${repoKey}#${assignment.issueNumber}`;
    if (seenIssueKeys.has(issueKey)) {
      continue;
    }
    seenIssueKeys.add(issueKey);
    visibleAssignments.push(assignment);
  }

  return visibleAssignments;
}

function normalizePullRequests(prs: PullRequestSnapshot[] | undefined): PullRequestSnapshot[] {
  if (!Array.isArray(prs)) {
    return [];
  }

  return prs.filter(
    (pr): pr is PullRequestSnapshot =>
      typeof pr?.number === "number" &&
      typeof pr?.state === "string" &&
      typeof pr?.headRefName === "string",
  );
}

function chooseBestPullRequest(prs: PullRequestSnapshot[]): PullRequestSnapshot | null {
  if (prs.length === 0) {
    return null;
  }

  const score = (pr: PullRequestSnapshot): number => {
    if (pr.mergedAt) return 3;
    if (pr.state.toUpperCase() === "OPEN") return 2;
    return 1;
  };

  return (
    [...prs].sort((left, right) => {
      const byScore = score(right) - score(left);
      if (byScore !== 0) return byScore;
      const leftMergedAt = left.mergedAt ? Date.parse(left.mergedAt) : 0;
      const rightMergedAt = right.mergedAt ? Date.parse(right.mergedAt) : 0;
      if (rightMergedAt !== leftMergedAt) return rightMergedAt - leftMergedAt;
      return right.number - left.number;
    })[0] ?? null
  );
}

async function resolveBaseRef(cwd: string, runner: CommandRunner): Promise<string | null> {
  for (const ref of ["origin/main", "main"]) {
    const resolved = await runCommand(
      "git",
      ["rev-parse", "--verify", "--quiet", ref],
      cwd,
      runner,
    );
    if (resolved) {
      return ref;
    }
  }
  return null;
}

async function getBranchAheadCount(
  branch: string | null,
  baseRef: string | null,
  cwd: string,
  runner: CommandRunner,
): Promise<number> {
  if (!branch || !baseRef) {
    return 0;
  }

  let maxAheadCount = 0;
  const refs = [...new Set([branch, `origin/${branch}`])];
  for (const ref of refs) {
    const resolved = await runCommand(
      "git",
      ["rev-parse", "--verify", "--quiet", ref],
      cwd,
      runner,
    );
    if (!resolved) {
      continue;
    }

    const count = await runCommand(
      "git",
      ["rev-list", "--count", `${baseRef}..${ref}`],
      cwd,
      runner,
    );
    const aheadCount = Number.parseInt(count ?? "0", 10);
    if (Number.isFinite(aheadCount) && aheadCount > maxAheadCount) {
      maxAheadCount = aheadCount;
    }
  }

  return maxAheadCount;
}

function getRepoArg(assignment: Pick<TaskAssignmentInfo, "repoOwner" | "repoName">): string[] {
  return assignment.repoOwner && assignment.repoName
    ? ["--repo", `${assignment.repoOwner}/${assignment.repoName}`]
    : [];
}

async function getPullRequestForBranch(
  assignment: Pick<TaskAssignmentInfo, "branch" | "repoOwner" | "repoName">,
  cwd: string,
  runner: CommandRunner,
): Promise<PullRequestSnapshot | null | undefined> {
  if (!assignment.branch) {
    return null;
  }

  const rawPrs = await runJsonCommand<PullRequestSnapshot[]>(
    "gh",
    [
      "pr",
      "list",
      ...getRepoArg(assignment),
      "--head",
      assignment.branch,
      "--state",
      "all",
      "--json",
      "number,state,mergedAt,headRefName",
    ],
    cwd,
    runner,
  );
  if (rawPrs === undefined) {
    return undefined;
  }

  const prs = normalizePullRequests(rawPrs);
  return chooseBestPullRequest(prs);
}

async function getPullRequestByNumber(
  prNumber: number,
  assignment: Pick<TaskAssignmentInfo, "repoOwner" | "repoName">,
  cwd: string,
  runner: CommandRunner,
): Promise<PullRequestSnapshot | null | undefined> {
  const pr = await runJsonCommand<PullRequestSnapshot>(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      ...getRepoArg(assignment),
      "--json",
      "number,state,mergedAt,headRefName",
    ],
    cwd,
    runner,
  );
  if (pr === undefined) {
    return undefined;
  }
  return normalizePullRequests([pr])[0] ?? null;
}

async function getIssueByNumber(
  assignment: Pick<TaskAssignmentInfo, "issueNumber" | "repoOwner" | "repoName">,
  cwd: string,
  runner: CommandRunner,
): Promise<IssueSnapshot | null | undefined> {
  if (!assignment.repoOwner || !assignment.repoName) {
    return null;
  }

  const issue = await runJsonCommand<IssueSnapshot>(
    "gh",
    [
      "issue",
      "view",
      String(assignment.issueNumber),
      ...getRepoArg(assignment),
      "--json",
      "number,state",
    ],
    cwd,
    runner,
  );
  if (issue === undefined) {
    return undefined;
  }
  if (issue && typeof issue.number === "number" && typeof issue.state === "string") {
    return issue;
  }
  return null;
}

function normalizeIssueState(
  issue: IssueSnapshot | null | undefined,
): ResolvedTaskAssignment["issueState"] {
  const state = issue?.state?.toUpperCase();
  if (state === "OPEN" || state === "CLOSED") {
    return state;
  }
  return null;
}

function hasTrackedPullRequestLink(
  assignment: Pick<TaskAssignmentInfo, "status" | "prNumber">,
  pr: PullRequestSnapshot,
): boolean {
  return (
    assignment.prNumber === pr.number ||
    assignment.status === "pr_open" ||
    assignment.status === "pr_merged" ||
    assignment.status === "pr_closed"
  );
}

function resolveTaskStatus(
  assignment: TaskAssignmentInfo,
  branchAheadCount: number,
  pr: PullRequestSnapshot | null | undefined,
): Pick<ResolvedTaskAssignment, "nextStatus" | "nextPrNumber"> {
  if (pr === undefined && assignment.status.startsWith("pr_")) {
    return { nextStatus: assignment.status, nextPrNumber: assignment.prNumber };
  }
  if (pr?.state.toUpperCase() === "OPEN") {
    return { nextStatus: "pr_open", nextPrNumber: pr.number };
  }
  if (pr?.mergedAt) {
    if (hasTrackedPullRequestLink(assignment, pr)) {
      return { nextStatus: "pr_merged", nextPrNumber: pr.number };
    }
    if (branchAheadCount > 0) {
      return { nextStatus: "branch_pushed", nextPrNumber: null };
    }
    return { nextStatus: "assigned", nextPrNumber: null };
  }
  if (pr) {
    if (hasTrackedPullRequestLink(assignment, pr)) {
      return { nextStatus: "pr_closed", nextPrNumber: pr.number };
    }
    if (branchAheadCount > 0) {
      return { nextStatus: "branch_pushed", nextPrNumber: null };
    }
    return { nextStatus: "assigned", nextPrNumber: null };
  }
  if (branchAheadCount > 0) {
    return { nextStatus: "branch_pushed", nextPrNumber: null };
  }
  return { nextStatus: "assigned", nextPrNumber: null };
}

export async function resolveTaskAssignments(
  assignments: TaskAssignmentInfo[],
  cwd = process.cwd(),
  runner: CommandRunner = execFileAsync as CommandRunner,
): Promise<ResolvedTaskAssignment[]> {
  if (assignments.length === 0) {
    return [];
  }

  const baseRefCache = new Map<string, Promise<string | null>>();
  const resolveBaseRefForCwd = (repoCwd: string): Promise<string | null> => {
    const cached = baseRefCache.get(repoCwd);
    if (cached) return cached;
    const promise = resolveBaseRef(repoCwd, runner);
    baseRefCache.set(repoCwd, promise);
    return promise;
  };
  const branchProgressCache = new Map<
    string,
    Promise<{ branchAheadCount: number; pr: PullRequestSnapshot | null | undefined }>
  >();
  const pullRequestByNumberCache = new Map<
    string,
    Promise<PullRequestSnapshot | null | undefined>
  >();
  const issueByNumberCache = new Map<string, Promise<IssueSnapshot | null | undefined>>();

  const resolveBranchProgress = (
    assignment: TaskAssignmentInfo,
  ): Promise<{ branchAheadCount: number; pr: PullRequestSnapshot | null | undefined }> => {
    const repoCwd =
      assignment.repoRoot ?? (assignment.repoOwner && assignment.repoName ? null : null);
    const commandCwd = repoCwd ?? cwd;
    const cacheKey = `${assignment.repoOwner ?? ""}/${assignment.repoName ?? ""}:${repoCwd ?? "repo_root_unavailable"}:${assignment.branch ?? ""}`;
    const cached = branchProgressCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const canResolveRemotePr =
      repoCwd != null || (assignment.repoOwner != null && assignment.repoName != null);
    const branchAheadCountPromise = repoCwd
      ? resolveBaseRefForCwd(repoCwd).then((baseRef) =>
          getBranchAheadCount(assignment.branch, baseRef, repoCwd, runner),
        )
      : Promise.resolve(0);
    const promise = Promise.all([
      branchAheadCountPromise,
      canResolveRemotePr ? getPullRequestForBranch(assignment, commandCwd, runner) : null,
    ]).then(([branchAheadCount, pr]) => ({ branchAheadCount, pr }));
    branchProgressCache.set(cacheKey, promise);
    return promise;
  };

  const resolvePullRequestByNumber = (
    prNumber: number,
    assignment: TaskAssignmentInfo,
    repoCwd: string,
  ): Promise<PullRequestSnapshot | null | undefined> => {
    const cacheKey = `${assignment.repoOwner ?? ""}/${assignment.repoName ?? ""}:${repoCwd}#${prNumber}`;
    const cached = pullRequestByNumberCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const promise = getPullRequestByNumber(prNumber, assignment, repoCwd, runner);
    pullRequestByNumberCache.set(cacheKey, promise);
    return promise;
  };

  const resolveIssueByNumber = (
    assignment: TaskAssignmentInfo,
  ): Promise<IssueSnapshot | null | undefined> => {
    const cacheKey = `${assignment.repoOwner ?? ""}/${assignment.repoName ?? ""}#${assignment.issueNumber}`;
    const cached = issueByNumberCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const promise = getIssueByNumber(assignment, cwd, runner);
    issueByNumberCache.set(cacheKey, promise);
    return promise;
  };

  return Promise.all(
    assignments.map(async (assignment) => {
      const { branchAheadCount, pr } = await resolveBranchProgress(assignment);
      const canResolveStoredPr =
        assignment.repoRoot != null ||
        (assignment.repoOwner != null && assignment.repoName != null);
      const resolvedPr =
        pr == null && assignment.prNumber != null && canResolveStoredPr
          ? await resolvePullRequestByNumber(
              assignment.prNumber,
              assignment,
              assignment.repoRoot ?? cwd,
            )
          : pr;
      const issueState = normalizeIssueState(await resolveIssueByNumber(assignment));
      const { nextStatus, nextPrNumber } = resolveTaskStatus(
        assignment,
        branchAheadCount,
        resolvedPr,
      );
      return {
        ...assignment,
        nextStatus,
        nextPrNumber,
        branchAheadCount,
        issueState,
      };
    }),
  );
}

export function hasTaskAssignmentStatusChange(assignment: ResolvedTaskAssignment): boolean {
  return (
    assignment.status !== assignment.nextStatus || assignment.prNumber !== assignment.nextPrNumber
  );
}

function formatTaskProgressFragment(
  assignment: Pick<
    TaskAssignmentInfo,
    | "issueNumber"
    | "branch"
    | "status"
    | "prNumber"
    | "taskKind"
    | "repoOwner"
    | "repoName"
    | "repoRoot"
  >,
): string {
  if (assignment.taskKind !== "implementation") {
    return `#${assignment.issueNumber} → ${assignment.taskKind} task, no implementation PR expected`;
  }

  switch (assignment.status) {
    case "pr_merged":
      return `#${assignment.issueNumber} → PR #${assignment.prNumber ?? "?"} MERGED ✅`;
    case "pr_open":
      return `#${assignment.issueNumber} → PR #${assignment.prNumber ?? "?"} OPEN 🔄`;
    case "pr_closed":
      return `#${assignment.issueNumber} → PR #${assignment.prNumber ?? "?"} CLOSED ⚠️`;
    case "branch_pushed":
      return `#${assignment.issueNumber} → commits on ${assignment.branch ?? "tracked branch"}, no PR 👀`;
    case "assigned":
    default:
      if (!assignment.repoOwner && !assignment.repoName && !assignment.repoRoot) {
        return `#${assignment.issueNumber} → repo unknown; progress not checked ⚠️`;
      }
      if (
        assignment.branch &&
        assignment.repoOwner &&
        assignment.repoName &&
        !assignment.repoRoot
      ) {
        return `#${assignment.issueNumber} → no PR found for ${assignment.branch}; commits not checked (repo root unavailable) ⚠️`;
      }
      return `#${assignment.issueNumber} → no commits, no PR ⚠️`;
  }
}

function getVisibleTaskAssignmentReportEntries<
  T extends Pick<
    TaskAssignmentInfo,
    | "agentId"
    | "issueNumber"
    | "branch"
    | "status"
    | "prNumber"
    | "taskKind"
    | "repoOwner"
    | "repoName"
    | "repoRoot"
  > & {
    issueState?: ResolvedTaskAssignment["issueState"];
  },
>(assignments: T[]): T[] {
  return assignments.filter(
    (assignment) =>
      assignment.issueState !== "CLOSED" &&
      assignment.status !== "pr_merged" &&
      assignment.status !== "pr_closed",
  );
}

function formatAgentLabel(
  agentId: string,
  agentsById: ReadonlyMap<string, Pick<AgentInfo, "emoji" | "name">>,
): string {
  const agent = agentsById.get(agentId);
  if (!agent) {
    return agentId;
  }
  return `${agent.emoji} ${agent.name}`.trim();
}

function getAgentSortKey(
  agentId: string,
  agentsById: ReadonlyMap<string, Pick<AgentInfo, "emoji" | "name">>,
): string {
  const agent = agentsById.get(agentId);
  return agent?.name ?? agentId;
}

type ReportableTaskAssignment = Pick<
  TaskAssignmentInfo,
  | "agentId"
  | "issueNumber"
  | "branch"
  | "status"
  | "prNumber"
  | "taskKind"
  | "repoOwner"
  | "repoName"
  | "repoRoot"
> & {
  issueState?: ResolvedTaskAssignment["issueState"];
};

export function buildTaskAssignmentReport(
  assignments: ReportableTaskAssignment[],
  agentsById: ReadonlyMap<string, Pick<AgentInfo, "emoji" | "name">>,
  cycleStartedAt?: string,
): string | null {
  const visibleAssignments = getVisibleTaskAssignmentReportEntries(assignments);
  if (visibleAssignments.length === 0) {
    return null;
  }

  const grouped = new Map<string, ReportableTaskAssignment[]>();
  for (const assignment of visibleAssignments) {
    const bucket = grouped.get(assignment.agentId);
    if (bucket) {
      bucket.push(assignment);
    } else {
      grouped.set(assignment.agentId, [assignment]);
    }
  }

  const lines = [...grouped.entries()]
    .sort(([leftAgentId], [rightAgentId]) => {
      const leftLabel = getAgentSortKey(leftAgentId, agentsById);
      const rightLabel = getAgentSortKey(rightAgentId, agentsById);
      return leftLabel.localeCompare(rightLabel);
    })
    .map(([agentId, agentAssignments]) => {
      const summary = [...agentAssignments]
        .sort((left, right) => left.issueNumber - right.issueNumber)
        .map((assignment) => formatTaskProgressFragment(assignment))
        .join("; ");
      return `- ${formatAgentLabel(agentId, agentsById)}: ${summary}`;
    });

  const header = cycleStartedAt
    ? ["RALPH LOOP — WORKER STATUS:", `Timestamp: ${cycleStartedAt}`]
    : ["RALPH LOOP — WORKER STATUS:"];
  return [...header, ...lines].join("\n");
}

export interface PendingTaskAssignmentReport {
  message: string;
  signature: string;
}

export function getPendingTaskAssignmentReport(
  assignments: ReportableTaskAssignment[],
  agentsById: ReadonlyMap<string, Pick<AgentInfo, "emoji" | "name">>,
  lastDeliveredSignature: string,
  cycleStartedAt?: string,
): PendingTaskAssignmentReport | null {
  const signature = buildTaskAssignmentReport(assignments, agentsById);
  if (!signature || signature === lastDeliveredSignature) {
    return null;
  }

  const message = buildTaskAssignmentReport(assignments, agentsById, cycleStartedAt);
  if (!message) {
    return null;
  }

  return { message, signature };
}
