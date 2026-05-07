import { describe, expect, it } from "vitest";
import { buildOathgateAgentSummaries, buildOathgateModalView } from "./oathgate.js";
import type { OathgateAgentInput } from "./oathgate.js";

function makeAgent(overrides: Partial<OathgateAgentInput> = {}): OathgateAgentInput {
  return {
    id: "agent-1",
    stableId: "/raw/session/path/should-not-show",
    name: "Fearspren",
    emoji: "😱",
    pid: 1234,
    connectedAt: "2026-05-07T10:00:00.000Z",
    lastSeen: "2026-05-07T10:00:00.000Z",
    lastHeartbeat: "2026-05-07T10:00:00.000Z",
    metadata: {
      cwd: "/Users/will/extensions/.worktrees/oathgate-agent-picker/slack-bridge",
      repoRoot: "/Users/will/extensions",
      repo: "extensions",
      branch: "fix/oathgate-agent-picker-734",
      rawSecret: "do-not-show",
      capabilities: {
        role: "worker",
        repo: "extensions",
        repoRoot: "/Users/will/extensions",
        branch: "fix/oathgate-agent-picker-734",
      },
    },
    status: "idle",
    disconnectedAt: null,
    resumableUntil: null,
    idleSince: "2026-05-07T09:59:00.000Z",
    lastActivity: "2026-05-07T09:58:00.000Z",
    pendingInboxCount: 2,
    ownedThreadCount: 1,
    ...overrides,
  };
}

describe("oathgate", () => {
  it("builds safe agent summaries without raw stable ids or absolute cwd", () => {
    const summaries = buildOathgateAgentSummaries({
      now: Date.parse("2026-05-07T10:00:00.000Z"),
      homedir: "/Users/will",
      agents: [makeAgent()],
      lanes: [
        {
          laneId: "oathgate-agent-picker",
          name: "Oathgate picker",
          task: null,
          issueNumber: 734,
          prNumber: null,
          threadId: "1778062718.438539",
          ownerAgentId: "agent-1",
          implementationLeadAgentId: null,
          pmMode: false,
          state: "active",
          summary: "raw details should not be needed",
          metadata: { worktree: "/Users/will/extensions/.worktrees/oathgate-agent-picker" },
          createdAt: "2026-05-07T09:00:00.000Z",
          updatedAt: "2026-05-07T09:59:00.000Z",
          lastActivityAt: "2026-05-07T09:59:00.000Z",
          participants: [],
        },
      ],
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      copyText: "Fearspren",
      repo: "extensions",
      branch: "fix/oathgate-agent-picker-734",
      worktreeHint: ".worktrees/oathgate-agent-picker/slack-bridge",
      workload: "2 inbox / 1 thread",
      lane: "Oathgate picker [active] (#734)",
    });
    expect(JSON.stringify(summaries)).not.toContain("/Users/will/extensions");
    expect(JSON.stringify(summaries)).not.toContain("stable");
    expect(JSON.stringify(summaries)).not.toContain("do-not-show");
  });

  it("renders a modal with copyable agent names and no composer", () => {
    const summaries = buildOathgateAgentSummaries({
      now: Date.parse("2026-05-07T10:00:00.000Z"),
      homedir: "/Users/will",
      agents: [makeAgent()],
    });
    const view = buildOathgateModalView({ agents: summaries });
    const rendered = JSON.stringify(view);

    expect(view.callback_id).toBe("oathgate.agent_picker");
    expect(rendered).toContain("Pick an agent name to copy/paste into chat");
    expect(rendered).toContain("`Fearspren`");
    expect(rendered).toContain("static_select");
    expect(rendered).not.toContain("plain_text_input");
  });
});
