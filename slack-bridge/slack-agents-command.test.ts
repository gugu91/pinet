import { describe, expect, it } from "vitest";
import {
  formatSlackAgentsDashboard,
  formatSlackAgentsUsage,
  isSlackAgentCommand,
  isSlackAgentsListCommand,
  resolveSlackAgentCommandNames,
  shouldIncludeSlackAgentsGhosts,
} from "./slack-agents-command.js";
import type { BrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-dashboard.js";

function createSnapshot(): BrokerControlPlaneDashboardSnapshot {
  return {
    cycleStartedAt: "2026-06-05T09:00:00.000Z",
    cycleDurationMs: 0,
    currentBranch: "main",
    ralphSnooze: null,
    totalAgents: 2,
    liveAgents: 1,
    brokerCount: 1,
    workerCount: 1,
    idleWorkers: 0,
    workingWorkers: 1,
    ghostAgents: 1,
    stuckAgents: 0,
    pendingBacklogCount: 2,
    nudgesThisCycle: 0,
    idleDrainCandidates: 0,
    assignedBacklogCount: 0,
    reapedAgents: 0,
    repairedThreadClaims: 0,
    maintenanceAnomalies: [],
    anomalies: [],
    taskCounts: { assigned: 1, branchPushed: 0, openPrs: 0, mergedPrs: 0, closedPrs: 0 },
    activeTasks: ["#805 assigned"],
    recentOutcomes: [],
    activeLanes: ["agents-command [active] lead agent-1 — Slack /pinet agents list command"],
    detachedLanes: [],
    roster: [
      {
        id: "agent-1",
        role: "worker",
        label: "🛡️ Cobalt Guard",
        status: "working",
        health: "healthy",
        workload: "1 inbox / 1 thread",
        taskSummary: "#805 assigned",
        heartbeat: "1s ago",
        branch: "feat/slack-agents-command",
        worktree: "~/extensions/.worktrees/agents-status-command",
      },
      {
        id: "agent-ghost",
        role: "worker",
        label: "👻 Ghost Worker",
        status: "offline",
        health: "ghost",
        workload: "none",
        taskSummary: "none",
        heartbeat: "10m ago",
        branch: "main",
        worktree: "~/extensions",
      },
    ],
    recentCycles: [],
  };
}

describe("Slack app-name agents list command helpers", () => {
  it("resolves command names from explicit settings or skin defaults", () => {
    expect(resolveSlackAgentCommandNames({})).toEqual(["/pinet"]);
    expect(resolveSlackAgentCommandNames({ skinTheme: "oathgate" })).toEqual(["/oathgate"]);
    expect(resolveSlackAgentCommandNames({ slackCommandName: "Oathgate" })).toEqual(["/oathgate"]);
    expect(
      resolveSlackAgentCommandNames({ slackCommandNames: ["/pinet", "oathgate", "bad name"] }),
    ).toEqual(["/pinet", "/oathgate"]);
  });

  it("recognizes configured Slack command names", () => {
    const commandNames = ["/pinet", "/oathgate"];
    expect(isSlackAgentCommand("/pinet", commandNames)).toBe(true);
    expect(isSlackAgentCommand(" /OATHGATE ", commandNames)).toBe(true);
    expect(isSlackAgentCommand("/agents", commandNames)).toBe(false);
  });

  it("recognizes app-name agents list text", () => {
    const commandNames = ["/pinet", "/oathgate"];
    expect(isSlackAgentsListCommand("/pinet", "agents list", commandNames)).toBe(true);
    expect(isSlackAgentsListCommand("/oathgate", "agents list all", commandNames)).toBe(true);
    expect(isSlackAgentsListCommand("/pinet", "agents", commandNames)).toBe(false);
    expect(isSlackAgentsListCommand("/agents", "all", commandNames)).toBe(false);
    expect(formatSlackAgentsUsage(["/oathgate"])).toBe("Usage: /oathgate agents list [all]");
  });

  it("parses all/ghost flags", () => {
    expect(shouldIncludeSlackAgentsGhosts("agents list all")).toBe(true);
    expect(shouldIncludeSlackAgentsGhosts("all")).toBe(true);
    expect(shouldIncludeSlackAgentsGhosts("--ghosts")).toBe(true);
    expect(shouldIncludeSlackAgentsGhosts("")).toBe(false);
  });

  it("formats broker roster and current lane data while hiding ghosts by default", () => {
    const output = formatSlackAgentsDashboard(createSnapshot(), false);

    expect(output).toContain("Pinet agents: 1 shown · 1 live · 1 workers · 1 working");
    expect(output).toContain("🛡️ Cobalt Guard · worker · working · healthy");
    expect(output).toContain("Task: #805 assigned");
    expect(output).toContain("Active lanes:");
    expect(output).not.toContain("Ghost Worker");
  });

  it("includes ghosts when requested", () => {
    expect(formatSlackAgentsDashboard(createSnapshot(), true)).toContain("Ghost Worker");
  });
});
