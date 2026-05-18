import { describe, expect, it, vi } from "vitest";
import type { AgentInfo, TaskAssignmentInfo } from "./broker/types.js";
import {
  buildTaskAssignmentReport,
  extractTaskAssignmentsFromMessage,
  getPendingTaskAssignmentReport,
  hasTaskAssignmentStatusChange,
  normalizeTrackedTaskAssignments,
  resolveTaskAssignments,
  type CommandRunner,
} from "./task-assignments.js";

function makeAssignment(
  overrides: Partial<TaskAssignmentInfo> &
    Pick<TaskAssignmentInfo, "id" | "agentId" | "issueNumber">,
): TaskAssignmentInfo {
  return {
    id: overrides.id,
    agentId: overrides.agentId,
    issueNumber: overrides.issueNumber,
    branch: overrides.branch ?? null,
    prNumber: overrides.prNumber ?? null,
    status: overrides.status ?? "assigned",
    threadId: overrides.threadId ?? `a2a:broker:${overrides.agentId}`,
    sourceMessageId: overrides.sourceMessageId ?? null,
    repoOwner: overrides.repoOwner ?? null,
    repoName: overrides.repoName ?? null,
    repoRoot: overrides.repoRoot === undefined ? "/repo" : overrides.repoRoot,
    taskKind: overrides.taskKind ?? "implementation",
    createdAt: overrides.createdAt ?? "2026-04-02T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-02T10:00:00.000Z",
  };
}

function makeAgent(
  id: string,
  name: string,
  emoji: string,
): Pick<AgentInfo, "emoji" | "name"> & { id: string } {
  return { id, name, emoji };
}

describe("extractTaskAssignmentsFromMessage", () => {
  it("extracts the issue number and worktree branch from a broker task message", () => {
    const message = [
      "Issue #114 — RALPH loop should report worker task completion status to broker.",
      "Create a worktree: `git worktree add .worktrees/feat-114-v2 -b feat/ralph-completion-v2`.",
      "Create a PR targeting main.",
    ].join("\n");

    expect(extractTaskAssignmentsFromMessage(message)).toEqual([
      {
        issueNumber: 114,
        branch: "feat/ralph-completion-v2",
        repoOwner: null,
        repoName: null,
        taskKind: "implementation",
      },
    ]);
  });

  it("extracts the canonical issue from an issue/pr handoff and ignores historical status references", () => {
    const message = [
      "Status:",
      "- PR #291 closed in favor of issue #293",
      "- PR #292 is now the only remaining blocker",
      "",
      "Your lane:",
      "- Issue/PR: #287 / PR #292",
      "- Branch: `fix/pinet-follow-auth-method`",
    ].join("\n");

    expect(extractTaskAssignmentsFromMessage(message)).toEqual([
      {
        issueNumber: 287,
        branch: "fix/pinet-follow-auth-method",
        repoOwner: null,
        repoName: null,
        taskKind: "implementation",
      },
    ]);
  });

  it("ignores update and status-only messages that are not real assignments", () => {
    const message = [
      "Update: PR #272 is merged, issue #271 is closed, issue #273 is closed as absorbed, and PR #274 is closed as superseded.",
      "I also opened #275 for the separate purge-grace question.",
      "Please stand down and return idle/free.",
    ].join("\n");

    expect(extractTaskAssignmentsFromMessage(message)).toEqual([]);
  });

  it("does not treat issue-opened update bullets as assignments", () => {
    const message = [
      "Update from the thicket:",
      "- PR #272 merged",
      "- PR #274 closed as superseded",
      "- issue #275 opened to preserve the separate purge-grace idea",
      "No further action needed unless you want to acknowledge cleanup complete and return idle/free.",
    ].join("\n");

    expect(extractTaskAssignmentsFromMessage(message)).toEqual([]);
  });

  it("captures repo identity from GitHub issue URLs and classifies review-only work", () => {
    const message = [
      "Please do a read-only review of PR #292 against https://github.com/gugu91/extensions/issues/287.",
      "Do not mutate files; just report findings.",
    ].join("\n");

    expect(extractTaskAssignmentsFromMessage(message)).toEqual([
      {
        issueNumber: 287,
        branch: null,
        repoOwner: "gugu91",
        repoName: "extensions",
        taskKind: "review",
      },
    ]);
  });

  it("uses pull request URLs for repo context without tracking the PR number as an issue", () => {
    const message = [
      "Please do a read-only review of https://github.com/gugu91/extensions/pull/292.",
      "Issue: #287",
      "Do not mutate files; just report findings.",
    ].join("\n");

    expect(extractTaskAssignmentsFromMessage(message)).toEqual([
      {
        issueNumber: 287,
        branch: null,
        repoOwner: "gugu91",
        repoName: "extensions",
        taskKind: "review",
      },
    ]);
  });

  it("lets explicit implementation branch signals win over generic review wording", () => {
    const message = [
      "Please review the code, implement the fix, and open a PR.",
      "Issue: #418",
      "Branch: `fix/task-tracker-418`",
    ].join("\n");

    expect(extractTaskAssignmentsFromMessage(message)).toEqual([
      {
        issueNumber: 418,
        branch: "fix/task-tracker-418",
        repoOwner: null,
        repoName: null,
        taskKind: "implementation",
      },
    ]);
  });
});

describe("normalizeTrackedTaskAssignments", () => {
  it("keeps same-number assignments separate when only repo roots are known", () => {
    const normalized = normalizeTrackedTaskAssignments([
      makeAssignment({
        id: 2,
        agentId: "worker-2",
        issueNumber: 418,
        repoRoot: "/repos/two",
        updatedAt: "2026-04-02T10:01:00.000Z",
      }),
      makeAssignment({
        id: 1,
        agentId: "worker-1",
        issueNumber: 418,
        repoRoot: "/repos/one",
      }),
    ]);

    expect(normalized.map((assignment) => assignment.repoRoot)).toEqual([
      "/repos/two",
      "/repos/one",
    ]);
  });

  it("preserves captured repo identity when reparsing issue-only source messages", () => {
    const normalized = normalizeTrackedTaskAssignments(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-1",
          issueNumber: 418,
          branch: "fix/task-tracker-418",
          repoOwner: "gugu91",
          repoName: "extensions",
          sourceMessageId: 100,
        }),
      ],
      new Map([
        [
          100,
          [
            "Please implement the fix and open a PR.",
            "Issue: #418",
            "Branch: `fix/task-tracker-418`",
          ].join("\n"),
        ],
      ]),
    );

    expect(normalized).toEqual([
      expect.objectContaining({
        issueNumber: 418,
        repoOwner: "gugu91",
        repoName: "extensions",
        taskKind: "implementation",
      }),
    ]);
  });

  it("drops stale update rows and repairs the canonical issue and branch from the source message", () => {
    const assignments = [
      makeAssignment({
        id: 23,
        agentId: "worker-1",
        issueNumber: 293,
        branch: "fix/pinet-follow-auth-method",
        status: "pr_merged",
        prNumber: 292,
        sourceMessageId: 2146,
        updatedAt: "2026-04-08T12:20:26.626Z",
      }),
      makeAssignment({
        id: 22,
        agentId: "worker-1",
        issueNumber: 287,
        status: "assigned",
        sourceMessageId: 1822,
        updatedAt: "2026-04-08T10:30:48.213Z",
      }),
      makeAssignment({
        id: 17,
        agentId: "worker-3",
        issueNumber: 275,
        branch: "hygiene",
        status: "assigned",
        sourceMessageId: 1573,
        updatedAt: "2026-04-08T09:28:12.227Z",
      }),
      makeAssignment({
        id: 15,
        agentId: "worker-2",
        issueNumber: 271,
        status: "assigned",
        sourceMessageId: 1575,
        updatedAt: "2026-04-08T09:28:12.228Z",
      }),
    ];

    const normalized = normalizeTrackedTaskAssignments(
      assignments,
      new Map([
        [
          1822,
          [
            "Small add-on for your PR #289 read-only review.",
            "Please include one extra line in your verdict:",
            "- whether PR #289 likely also resolves issue #287",
          ].join("\n"),
        ],
        [
          2146,
          [
            "Status:",
            "- PR #291 closed in favor of issue #293",
            "- PR #292 is now the only remaining blocker",
            "",
            "Your lane:",
            "- Issue/PR: #287 / PR #292",
            "- Branch: `fix/pinet-follow-auth-method`",
          ].join("\n"),
        ],
        [
          1573,
          [
            "Update from the thicket:",
            "- PR #272 merged",
            "- PR #274 closed as superseded",
            "- issue #275 opened to preserve the separate purge-grace idea",
            "No further action needed unless you want to acknowledge cleanup complete and return idle/free.",
          ].join("\n"),
        ],
        [
          1575,
          [
            "Update: PR #272 is merged, issue #271 is closed, issue #273 is closed as absorbed, and PR #274 is closed as superseded.",
            "I also opened #275 for the separate purge-grace question.",
            "Please stand down and return idle/free.",
          ].join("\n"),
        ],
      ]),
    );

    expect(normalized).toEqual([
      expect.objectContaining({
        id: 23,
        issueNumber: 287,
        branch: "fix/pinet-follow-auth-method",
        prNumber: 292,
        status: "pr_merged",
      }),
    ]);
  });
});

describe("resolveTaskAssignments", () => {
  it("keeps assignments at no commits / no PR when nothing has happened", async () => {
    const runner: CommandRunner = vi.fn(async (file, args) => {
      if (
        file === "git" &&
        args.slice(0, 4).join(" ") === "rev-parse --verify --quiet origin/main"
      ) {
        return { stdout: "origin/main\n" };
      }
      throw new Error("missing ref");
    });

    const [assignment] = await resolveTaskAssignments(
      [makeAssignment({ id: 1, agentId: "worker-1", issueNumber: 114, branch: "feat/ralph" })],
      "/repo",
      runner,
    );

    expect(assignment.nextStatus).toBe("assigned");
    expect(assignment.nextPrNumber).toBeNull();
    expect(hasTaskAssignmentStatusChange(assignment)).toBe(false);
  });

  it("detects pushed commits before a PR exists", async () => {
    const runner: CommandRunner = vi.fn(async (file, args) => {
      if (
        file === "git" &&
        args.slice(0, 4).join(" ") === "rev-parse --verify --quiet origin/main"
      ) {
        return { stdout: "origin/main\n" };
      }
      if (file === "git" && args[0] === "rev-parse" && args.at(-1) === "feat/ralph") {
        return { stdout: "feat/ralph\n" };
      }
      if (file === "git" && args[0] === "rev-list") {
        return { stdout: "2\n" };
      }
      if (file === "gh") {
        return { stdout: "[]\n" };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    });

    const [assignment] = await resolveTaskAssignments(
      [makeAssignment({ id: 1, agentId: "worker-1", issueNumber: 114, branch: "feat/ralph" })],
      "/repo",
      runner,
    );

    expect(assignment.branchAheadCount).toBe(2);
    expect(assignment.nextStatus).toBe("branch_pushed");
    expect(assignment.nextPrNumber).toBeNull();
    expect(hasTaskAssignmentStatusChange(assignment)).toBe(true);
  });

  it("does not check branch progress from broker cwd when repo root is unavailable", async () => {
    const runner: CommandRunner = vi.fn(async (file, args) => {
      if (file === "gh") {
        return { stdout: "[]\n" };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    });

    const [assignment] = await resolveTaskAssignments(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-1",
          issueNumber: 114,
          branch: "feat/ralph",
          repoOwner: "gugu91",
          repoName: "extensions",
          repoRoot: null,
        }),
      ],
      "/broker/repo",
      runner,
    );

    expect(assignment.branchAheadCount).toBe(0);
    expect(assignment.nextStatus).toBe("assigned");
    expect(runner).not.toHaveBeenCalledWith(
      "git",
      expect.any(Array),
      expect.objectContaining({ cwd: "/broker/repo" }),
    );
  });

  it("checks branch progress from the captured repo root", async () => {
    const runner: CommandRunner = vi.fn(async (file, args, options) => {
      if (
        file === "git" &&
        args.slice(0, 4).join(" ") === "rev-parse --verify --quiet origin/main"
      ) {
        return { stdout: options.cwd === "/assigned/repo" ? "origin/main\n" : "" };
      }
      if (file === "git" && args[0] === "rev-parse" && args.at(-1) === "feat/ralph") {
        return { stdout: options.cwd === "/assigned/repo" ? "feat/ralph\n" : "" };
      }
      if (file === "git" && args[0] === "rev-list") {
        return { stdout: options.cwd === "/assigned/repo" ? "2\n" : "0\n" };
      }
      if (file === "gh") {
        return { stdout: "[]\n" };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    });

    const [assignment] = await resolveTaskAssignments(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-1",
          issueNumber: 114,
          branch: "feat/ralph",
          repoRoot: "/assigned/repo",
        }),
      ],
      "/broker/repo",
      runner,
    );

    expect(assignment.branchAheadCount).toBe(2);
    expect(assignment.nextStatus).toBe("branch_pushed");
  });

  it("detects open and merged PRs from GitHub", async () => {
    const runner: CommandRunner = vi.fn(async (file, args) => {
      if (
        file === "git" &&
        args.slice(0, 4).join(" ") === "rev-parse --verify --quiet origin/main"
      ) {
        return { stdout: "origin/main\n" };
      }
      if (file === "git" && args[0] === "rev-parse") {
        return { stdout: `${args.at(-1)}\n` };
      }
      if (file === "git" && args[0] === "rev-list") {
        return { stdout: "3\n" };
      }
      if (file === "gh" && args.includes("feat/open-pr")) {
        return {
          stdout: JSON.stringify([
            { number: 201, state: "OPEN", mergedAt: null, headRefName: "feat/open-pr" },
          ]),
        };
      }
      if (file === "gh" && args.includes("feat/merged-pr")) {
        return {
          stdout: JSON.stringify([
            {
              number: 202,
              state: "CLOSED",
              mergedAt: "2026-04-02T12:00:00.000Z",
              headRefName: "feat/merged-pr",
            },
          ]),
        };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    });

    const assignments = await resolveTaskAssignments(
      [
        makeAssignment({ id: 1, agentId: "worker-1", issueNumber: 114, branch: "feat/open-pr" }),
        makeAssignment({
          id: 2,
          agentId: "worker-2",
          issueNumber: 115,
          branch: "feat/merged-pr",
          status: "pr_open",
          prNumber: 202,
        }),
      ],
      "/repo",
      runner,
    );

    expect(assignments[0].nextStatus).toBe("pr_open");
    expect(assignments[0].nextPrNumber).toBe(201);
    expect(assignments[1].nextStatus).toBe("pr_merged");
    expect(assignments[1].nextPrNumber).toBe(202);
  });

  it("falls back to the stored PR number when the branch lookup returns nothing", async () => {
    const runner: CommandRunner = vi.fn(async (file, args) => {
      if (
        file === "git" &&
        args.slice(0, 4).join(" ") === "rev-parse --verify --quiet origin/main"
      ) {
        return { stdout: "origin/main\n" };
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]\n" };
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 202,
            state: "CLOSED",
            mergedAt: "2026-04-02T12:00:00.000Z",
            headRefName: "feat/merged-pr",
          }),
        };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    });

    const [assignment] = await resolveTaskAssignments(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-1",
          issueNumber: 114,
          branch: "feat/merged-pr",
          status: "pr_open",
          prNumber: 202,
        }),
      ],
      "/repo",
      runner,
    );

    expect(assignment.nextStatus).toBe("pr_merged");
    expect(assignment.nextPrNumber).toBe(202);
  });

  it("does not attach a historical merged PR to an open issue without prior PR linkage", async () => {
    const runner: CommandRunner = vi.fn(async (file, args) => {
      if (
        file === "git" &&
        args.slice(0, 4).join(" ") === "rev-parse --verify --quiet origin/main"
      ) {
        return { stdout: "origin/main\n" };
      }
      if (file === "git" && args[0] === "rev-parse") {
        return { stdout: `${args.at(-1)}\n` };
      }
      if (file === "git" && args[0] === "rev-list") {
        return { stdout: "0\n" };
      }
      if (file === "gh" && args[0] === "issue" && args[1] === "view") {
        return { stdout: JSON.stringify({ number: 287, state: "OPEN" }) };
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            {
              number: 292,
              state: "CLOSED",
              mergedAt: "2026-04-08T12:20:08.000Z",
              headRefName: "fix/pinet-follow-auth-method",
            },
          ]),
        };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    });

    const [assignment] = await resolveTaskAssignments(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-1",
          issueNumber: 287,
          branch: "fix/pinet-follow-auth-method",
          status: "assigned",
          prNumber: null,
        }),
      ],
      "/repo",
      runner,
    );

    expect(assignment.nextStatus).toBe("assigned");
    expect(assignment.nextPrNumber).toBeNull();
  });

  it("marks closed issues as hidden historical residue", async () => {
    const runner: CommandRunner = vi.fn(async (file, args) => {
      if (
        file === "git" &&
        args.slice(0, 4).join(" ") === "rev-parse --verify --quiet origin/main"
      ) {
        return { stdout: "origin/main\n" };
      }
      if (file === "gh" && args[0] === "issue" && args[1] === "view") {
        return { stdout: JSON.stringify({ number: 271, state: "CLOSED" }) };
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]\n" };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    });

    const [assignment] = await resolveTaskAssignments(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-1",
          issueNumber: 271,
          status: "assigned",
          repoOwner: "gugu91",
          repoName: "extensions",
        }),
      ],
      "/repo",
      runner,
    );

    expect(assignment.nextStatus).toBe("assigned");
    expect(assignment.nextPrNumber).toBeNull();
    expect(assignment.issueState).toBe("CLOSED");
    expect(hasTaskAssignmentStatusChange(assignment)).toBe(false);
  });

  it("resolves same-number issues against their captured repositories", async () => {
    const runner: CommandRunner = vi.fn(async (file, args) => {
      if (
        file === "git" &&
        args.slice(0, 4).join(" ") === "rev-parse --verify --quiet origin/main"
      ) {
        return { stdout: "origin/main\n" };
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]\n" };
      }
      if (file === "gh" && args[0] === "issue" && args[1] === "view") {
        const repo = args[args.indexOf("--repo") + 1];
        return {
          stdout: JSON.stringify({
            number: 747,
            state: repo === "gugu91/extensions" ? "CLOSED" : "OPEN",
          }),
        };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    });

    const assignments = await resolveTaskAssignments(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-1",
          issueNumber: 747,
          repoOwner: "gugu91",
          repoName: "extensions",
        }),
        makeAssignment({
          id: 2,
          agentId: "worker-2",
          issueNumber: 747,
          repoOwner: "Nexcade",
          repoName: "garage",
        }),
      ],
      "/repo",
      runner,
    );

    expect(assignments.map((assignment) => assignment.issueState)).toEqual(["CLOSED", "OPEN"]);
    expect(runner).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["issue", "view", "747", "--repo", "gugu91/extensions"]),
      expect.any(Object),
    );
    expect(runner).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["issue", "view", "747", "--repo", "Nexcade/garage"]),
      expect.any(Object),
    );
  });
});

describe("buildTaskAssignmentReport", () => {
  it("groups assignment summaries by worker", () => {
    const report = buildTaskAssignmentReport(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-1",
          issueNumber: 106,
          status: "pr_merged",
          prNumber: 109,
        }),
        makeAssignment({
          id: 2,
          agentId: "worker-2",
          issueNumber: 103,
          status: "assigned",
        }),
        makeAssignment({
          id: 3,
          agentId: "worker-2",
          issueNumber: 104,
          status: "branch_pushed",
          branch: "feat/worker-2",
        }),
      ],
      new Map([
        ["worker-1", makeAgent("worker-1", "Hyper Horse", "🐎")],
        ["worker-2", makeAgent("worker-2", "Frozen Raven", "🐦‍⬛")],
      ]),
    );

    expect(report).toBe(
      [
        "RALPH LOOP — WORKER STATUS:",
        "- 🐦‍⬛ Frozen Raven: #103 → no commits, no PR ⚠️; #104 → commits on feat/worker-2, no PR 👀",
      ].join("\n"),
    );
  });

  it("includes a timestamp when one is provided", () => {
    const report = buildTaskAssignmentReport(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-2",
          issueNumber: 103,
          status: "assigned",
        }),
      ],
      new Map([["worker-2", makeAgent("worker-2", "Frozen Raven", "🐦‍⬛")]]),
      "2026-04-02T14:10:00.000Z",
    );

    expect(report).toBe(
      [
        "RALPH LOOP — WORKER STATUS:",
        "Timestamp: 2026-04-02T14:10:00.000Z",
        "- 🐦‍⬛ Frozen Raven: #103 → no commits, no PR ⚠️",
      ].join("\n"),
    );
  });

  it("hides closed issues even when the stored status is still assigned", () => {
    const closedAssignment = {
      ...makeAssignment({
        id: 1,
        agentId: "worker-2",
        issueNumber: 271,
        status: "assigned",
      }),
      issueState: "CLOSED" as const,
    };

    const report = buildTaskAssignmentReport(
      [closedAssignment],
      new Map([["worker-2", makeAgent("worker-2", "Frozen Raven", "🐦‍⬛")]]),
    );

    expect(report).toBeNull();
  });

  it("does not describe review-only work as missing commits or PRs", () => {
    const report = buildTaskAssignmentReport(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-2",
          issueNumber: 287,
          status: "assigned",
          taskKind: "review",
        }),
      ],
      new Map([["worker-2", makeAgent("worker-2", "Frozen Raven", "🐦‍⬛")]]),
    );

    expect(report).toBe(
      [
        "RALPH LOOP — WORKER STATUS:",
        "- 🐦‍⬛ Frozen Raven: #287 → review task, no implementation PR expected",
      ].join("\n"),
    );
  });

  it("does not claim no commits when branch progress is unsafe to check", () => {
    const report = buildTaskAssignmentReport(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-2",
          issueNumber: 114,
          branch: "feat/ralph",
          repoOwner: "gugu91",
          repoName: "extensions",
          repoRoot: null,
          status: "assigned",
        }),
      ],
      new Map([["worker-2", makeAgent("worker-2", "Frozen Raven", "🐦‍⬛")]]),
    );

    expect(report).toBe(
      [
        "RALPH LOOP — WORKER STATUS:",
        "- 🐦‍⬛ Frozen Raven: #114 → no PR found for feat/ralph; commits not checked (repo root unavailable) ⚠️",
      ].join("\n"),
    );
  });
});

describe("getPendingTaskAssignmentReport", () => {
  const agentsById = new Map([
    ["worker-1", makeAgent("worker-1", "Hyper Horse", "🐎")],
    ["worker-2", makeAgent("worker-2", "Frozen Raven", "🐦‍⬛")],
  ]);

  it("queues an initial report for newly assigned tasks with no progress", () => {
    const report = getPendingTaskAssignmentReport(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-2",
          issueNumber: 103,
          status: "assigned",
        }),
      ],
      agentsById,
      "",
      "2026-04-02T14:10:00.000Z",
    );

    expect(report).toEqual({
      signature: [
        "RALPH LOOP — WORKER STATUS:",
        "- 🐦‍⬛ Frozen Raven: #103 → no commits, no PR ⚠️",
      ].join("\n"),
      message: [
        "RALPH LOOP — WORKER STATUS:",
        "Timestamp: 2026-04-02T14:10:00.000Z",
        "- 🐦‍⬛ Frozen Raven: #103 → no commits, no PR ⚠️",
      ].join("\n"),
    });
  });

  it("does not queue a recurring report for terminal merged assignments", () => {
    const report = getPendingTaskAssignmentReport(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-1",
          issueNumber: 106,
          status: "pr_merged",
          prNumber: 109,
        }),
      ],
      agentsById,
      "",
      "2026-04-02T14:10:00.000Z",
    );

    expect(report).toBeNull();
  });
});
