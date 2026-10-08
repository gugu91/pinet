import { describe, expect, it, vi } from "vitest";
import {
  createBrokerGhostReaper,
  decideGhostReapEligibility,
  isBrokerManagedAgent,
  type ProcessSnapshot,
} from "./ghost-reaper.js";
import type { AgentInfo } from "./types.js";

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "worker-1",
    stableId: "host:session:/tmp/worker-1",
    name: "Worker One",
    emoji: "🤖",
    pid: 12345,
    connectedAt: "2026-05-03T13:00:00.000Z",
    lastSeen: "2026-05-03T13:00:10.000Z",
    lastHeartbeat: "2026-05-03T13:00:10.000Z",
    metadata: {
      role: "worker",
      brokerManaged: true,
      brokerManagedBy: "broker-1",
      launchSource: "broker-tmux",
      tmuxSession: "extensions-worker-1",
      cwd: "/repo",
      branch: "main",
    },
    status: "idle",
    disconnectedAt: "2026-05-03T13:01:00.000Z",
    resumableUntil: null,
    idleSince: "2026-05-03T13:00:00.000Z",
    lastActivity: null,
    outboundCount: 0,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  return {
    pid: 12345,
    command: "node /opt/homebrew/bin/pi --some-runtime-flag",
    startedAt: "2026-05-03T12:59:59.000Z",
    ...overrides,
  };
}

describe("broker ghost reaper", () => {
  it("recognizes explicit broker-managed metadata", () => {
    expect(isBrokerManagedAgent(makeAgent())).toBe(true);
    expect(
      isBrokerManagedAgent(
        makeAgent({ metadata: { role: "worker", pinetBrokerManaged: { brokerManaged: true } } }),
      ),
    ).toBe(true);
    expect(isBrokerManagedAgent(makeAgent({ metadata: { role: "worker" } }))).toBe(false);
  });

  it.each([
    { stableId: "host:worker:credential-worker" },
    { metadata: { ...makeAgent().metadata, pinetWorkerPrincipal: { credentialId: "issued" } } },
  ])("never reaps credential principals even with forged management claims: %j", (overrides) => {
    const agent = makeAgent(overrides);
    expect(isBrokerManagedAgent(agent)).toBe(false);
    expect(decideGhostReapEligibility(agent, snapshot(), "broker-1")).toMatchObject({
      eligible: false,
      reason: "credential_principal",
    });
    const signalProcess = vi.fn();
    const reaper = createBrokerGhostReaper({
      inspectProcess: () => snapshot(),
      signalProcess,
      brokerAgentId: () => "broker-1",
    });
    expect(reaper.reapGhosts([agent]).signaledAgentIds).toEqual([]);
    expect(signalProcess).not.toHaveBeenCalled();
    reaper.dispose();
  });

  it("refuses ghosts without broker-managed ownership", () => {
    const decision = decideGhostReapEligibility(
      makeAgent({ metadata: { role: "worker" } }),
      snapshot(),
      "broker-1",
    );

    expect(decision).toEqual({
      eligible: false,
      agentId: "worker-1",
      pid: 12345,
      reason: "not_broker_managed",
    });
  });

  it("requires explicit current-broker ownership before reaping", () => {
    expect(decideGhostReapEligibility(makeAgent(), snapshot(), null)).toMatchObject({
      eligible: false,
      reason: "missing_broker_identity",
    });
    expect(
      decideGhostReapEligibility(
        makeAgent({ metadata: { role: "worker", brokerManaged: true } }),
        snapshot(),
        "broker-1",
      ),
    ).toMatchObject({ eligible: false, reason: "missing_broker_managed_by" });
  });

  it("refuses live agents and broker-role rows", () => {
    expect(
      decideGhostReapEligibility(makeAgent({ disconnectedAt: null }), snapshot(), "broker-1"),
    ).toMatchObject({ eligible: false, reason: "agent_not_disconnected" });
    expect(
      decideGhostReapEligibility(
        makeAgent({ metadata: { role: "broker", brokerManaged: true } }),
        snapshot(),
        "broker-1",
      ),
    ).toMatchObject({ eligible: false, reason: "broker_role" });
  });

  it("refuses missing processes, unexpected commands, and different broker ownership", () => {
    expect(decideGhostReapEligibility(makeAgent(), null, "broker-1")).toMatchObject({
      eligible: false,
      reason: "process_not_found",
    });
    expect(
      decideGhostReapEligibility(
        makeAgent(),
        snapshot({ command: "/usr/bin/python unrelated.py" }),
        "broker-1",
      ),
    ).toMatchObject({ eligible: false, reason: "unexpected_command" });
    expect(decideGhostReapEligibility(makeAgent(), snapshot(), "broker-2")).toMatchObject({
      eligible: false,
      reason: "managed_by_different_broker",
    });
  });

  it("refuses to signal when process start time cannot be proven", () => {
    expect(
      decideGhostReapEligibility(makeAgent(), snapshot({ startedAt: undefined }), "broker-1"),
    ).toMatchObject({ eligible: false, reason: "missing_process_start_time" });
    expect(
      decideGhostReapEligibility(makeAgent(), snapshot({ startedAt: "not-a-date" }), "broker-1"),
    ).toMatchObject({ eligible: false, reason: "missing_process_start_time" });
  });

  it("refuses likely PID reuse when process start is after registration", () => {
    const decision = decideGhostReapEligibility(
      makeAgent({ disconnectedAt: "2026-05-03T13:10:00.000Z" }),
      snapshot({ startedAt: "2026-05-03T13:05:00.000Z" }),
      "broker-1",
    );

    expect(decision).toMatchObject({ eligible: false, reason: "pid_reused_after_registration" });
  });

  it("refuses fast PID reuse when process start is after disconnect", () => {
    const decision = decideGhostReapEligibility(
      makeAgent({ disconnectedAt: "2026-05-03T13:00:10.000Z" }),
      snapshot({ startedAt: "2026-05-03T13:00:20.000Z" }),
      "broker-1",
    );

    expect(decision).toMatchObject({ eligible: false, reason: "pid_reused_after_disconnect" });
  });

  it("refuses same-second PID reuse ambiguity after disconnect", () => {
    const decision = decideGhostReapEligibility(
      makeAgent({
        connectedAt: "2026-05-03T12:59:00.000Z",
        disconnectedAt: "2026-05-03T13:00:10.500Z",
      }),
      snapshot({ startedAt: "2026-05-03T13:00:10.000Z" }),
      "broker-1",
    );

    expect(decision).toMatchObject({ eligible: false, reason: "pid_reused_after_disconnect" });
  });

  it("sends SIGTERM to eligible broker-managed ghosts and schedules bounded SIGKILL", () => {
    vi.useFakeTimers();
    const signals: Array<{ pid: number; signal: string }> = [];
    const inspectProcess = vi.fn(() => snapshot());
    const reaper = createBrokerGhostReaper(
      {
        inspectProcess,
        signalProcess: (pid, signal) => {
          signals.push({ pid, signal });
        },
        brokerAgentId: () => "broker-1",
      },
      { killAfterMs: 100 },
    );

    const result = reaper.reapGhosts([makeAgent()]);

    expect(result.signaledAgentIds).toEqual(["worker-1"]);
    expect(result.attempts).toEqual([{ agentId: "worker-1", pid: 12345, action: "sigterm" }]);
    expect(signals).toEqual([{ pid: 12345, signal: "SIGTERM" }]);

    vi.advanceTimersByTime(100);
    expect(signals).toEqual([
      { pid: 12345, signal: "SIGTERM" },
      { pid: 12345, signal: "SIGKILL" },
    ]);
    reaper.dispose();
    vi.useRealTimers();
  });

  it("skips bounded SIGKILL when the agent reconnects before the timer fires", () => {
    vi.useFakeTimers();
    const signals: Array<{ pid: number; signal: string }> = [];
    let latestAgent = makeAgent();
    const reaper = createBrokerGhostReaper(
      {
        inspectProcess: () => snapshot(),
        signalProcess: (pid, signal) => {
          signals.push({ pid, signal });
        },
        brokerAgentId: () => "broker-1",
        getAgentById: () => latestAgent,
      },
      { killAfterMs: 100 },
    );

    reaper.reapGhosts([latestAgent]);
    latestAgent = makeAgent({ disconnectedAt: null });
    vi.advanceTimersByTime(100);

    expect(signals).toEqual([{ pid: 12345, signal: "SIGTERM" }]);
    reaper.dispose();
    vi.useRealTimers();
  });

  it("does not send duplicate SIGTERM while bounded kill is pending", () => {
    vi.useFakeTimers();
    const signals: Array<{ pid: number; signal: string }> = [];
    const reaper = createBrokerGhostReaper(
      {
        inspectProcess: () => snapshot(),
        signalProcess: (pid, signal) => {
          signals.push({ pid, signal });
        },
        brokerAgentId: () => "broker-1",
      },
      { killAfterMs: 1_000 },
    );

    reaper.reapGhosts([makeAgent()]);
    const second = reaper.reapGhosts([makeAgent()]);

    expect(second.attempts).toEqual([
      { agentId: "worker-1", pid: 12345, action: "pending", reason: "bounded_kill_pending" },
    ]);
    expect(signals).toEqual([{ pid: 12345, signal: "SIGTERM" }]);
    reaper.dispose();
    vi.useRealTimers();
  });
});
