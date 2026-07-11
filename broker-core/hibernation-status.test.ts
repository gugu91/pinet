import { describe, expect, it } from "vitest";
import {
  buildAgentLifecycleStatus,
  formatAgentLifecycleStatus,
  redactPathLikeTokens,
  redactRuntimeSpec,
  sanitizeOperatorReason,
  type AgentLifecycleStatusInput,
} from "./hibernation-status.js";
import type { AgentCheckpointReceipt, AgentRuntimeSpec, AgentWakeQueueEntry } from "./types.js";

function runtimeSpec(overrides: Partial<AgentRuntimeSpec> = {}): AgentRuntimeSpec {
  return {
    agentId: "agent-a",
    stableId: "stable-a",
    brokerOwnerId: "broker-1",
    cwd: "/Users/secret/work/extensions",
    repoRoot: "/Users/secret/work/extensions",
    worktreePath: "/Users/secret/work/extensions/.worktrees/x",
    tmuxSocket: "/private/tmp/tmux-501/pinet",
    tmuxSession: "pinet-agent-a",
    tmuxTarget: "pinet-agent-a:0.0",
    executable: "/opt/homebrew/bin/pi",
    argv: ["--model", "openai-codex/gpt-5.6-sol", "--secret-flag", "hunter2"],
    envAllowlist: ["PATH", "HOME", "PINET_MESH_SECRET"],
    sessionResumeRef: "session:1a2b3c4d5e6f",
    configFingerprint: "cfg-abc123",
    expectedHost: "mac-1",
    expectedUser: "secret",
    launchSource: "broker",
    createdAt: "2026-07-11T07:00:00.000Z",
    updatedAt: "2026-07-11T07:30:00.000Z",
    ...overrides,
  };
}

function baseInput(overrides: Partial<AgentLifecycleStatusInput> = {}): AgentLifecycleStatusInput {
  return {
    agent: {
      id: "agent-a",
      lifecycleState: "hibernated",
      lifecycleVersion: 4,
      runtimeGeneration: 7,
      hibernatePolicy: "auto",
      hibernatedAt: "2026-07-11T07:30:00.000Z",
      graceUntil: null,
      idleEligibleAt: null,
      hibernateReason: "idle_debounce",
      lastWakeReason: null,
    },
    now: Date.parse("2026-07-11T07:35:00.000Z"),
    ...overrides,
  };
}

describe("redactRuntimeSpec", () => {
  it("exposes only presence flags, counts, and opaque refs — never argv/env/paths", () => {
    const redacted = redactRuntimeSpec(runtimeSpec());
    expect(redacted.hasWorktree).toBe(true);
    expect(redacted.hasTmuxSession).toBe(true);
    expect(redacted.envAllowlistCount).toBe(3);
    expect(redacted.repo).toBe("extensions");
    // The ref is fingerprinted, not verbatim: kind prefix + non-reversible fp.
    expect(redacted.session.kind).toBe("session");
    expect(redacted.session.host).toBe("mac-1");
    expect(redacted.session.hasPath).toBe(false);
    expect(redacted.session.ref).toMatch(/^session:#[0-9a-f]{8}$/);
    expect(redacted.session.ref).not.toContain("1a2b3c4d5e6f");

    const serialized = JSON.stringify(redacted);
    // No raw argv values, env values, or filesystem/socket paths leak.
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("--secret-flag");
    expect(serialized).not.toContain("/Users/secret");
    expect(serialized).not.toContain("/private/tmp");
    expect(serialized).not.toContain("pinet-agent-a");
  });

  it("never surfaces a path-bearing session ref payload (cwd/leaf kinds)", () => {
    const redacted = redactRuntimeSpec(
      runtimeSpec({ sessionResumeRef: "cwd:/Users/secret/worktrees/agent-a" }),
    );
    expect(redacted.session.kind).toBe("cwd");
    expect(redacted.session.hasPath).toBe(true);
    expect(redacted.session.ref).toMatch(/^cwd:#[0-9a-f]{8}$/);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("/Users/secret");
    expect(serialized).not.toContain("worktrees");
  });

  it("marks unknown session kinds when the ref prefix is unrecognized", () => {
    const redacted = redactRuntimeSpec(runtimeSpec({ sessionResumeRef: "opaque-ref-no-colon" }));
    expect(redacted.session.kind).toBe("unknown");
    expect(redacted.session.ref).toMatch(/^unknown:#[0-9a-f]{8}$/);
  });

  it("reduces a Windows repo root to a path-free basename (never emits the drive path)", () => {
    const redacted = redactRuntimeSpec(runtimeSpec({ repoRoot: "C:\\Users\\alice\\secret-repo" }));
    expect(redacted.repo).toBe("secret-repo");
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("Users");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("C:");
  });
});

describe("buildAgentLifecycleStatus", () => {
  it("summarizes state, generation, checkpoint age, and redacted runtime-spec presence", () => {
    const checkpoint: AgentCheckpointReceipt = {
      agentId: "agent-a",
      runtimeGeneration: 7,
      correlationId: "corr-1",
      hibernateSafe: true,
      reason: null,
      sessionResumeRef: "session:1a2b3c4d5e6f",
      pendingInboxCount: 2,
      rssBytes: 1024,
      createdAt: "2026-07-11T07:30:00.000Z",
    };
    const status = buildAgentLifecycleStatus(
      baseInput({ latestCheckpoint: checkpoint, runtimeSpec: runtimeSpec() }),
    );
    expect(status.state).toBe("hibernated");
    expect(status.runtimeGeneration).toBe(7);
    expect(status.checkpoint.present).toBe(true);
    expect(status.checkpoint.hibernateSafe).toBe(true);
    expect(status.checkpoint.ageMs).toBe(5 * 60_000);
    expect(status.checkpoint.pendingInboxCount).toBe(2);
    expect(status.runtimeSpec?.hasWorktree).toBe(true);
    expect(status.runtimeSpec?.envAllowlistCount).toBe(3);
    expect(status.quarantined).toBe(false);
  });

  it("sanitizes free-form operator reasons (control-strip + length-bound)", () => {
    const noisy = `line-one\nline-two\ttab\u0007bell ${"x".repeat(200)}`;
    const status = buildAgentLifecycleStatus(
      baseInput({
        agent: {
          id: "agent-a",
          lifecycleState: "hibernated",
          lifecycleVersion: 4,
          runtimeGeneration: 7,
          hibernatePolicy: "manual",
          hibernatedAt: "2026-07-11T07:30:00.000Z",
          graceUntil: null,
          idleEligibleAt: null,
          hibernateReason: noisy,
          lastWakeReason: "   ",
        },
      }),
    );
    // Single-line, no control chars, length-bounded.
    expect(status.hibernateReason).not.toContain("\n");
    expect(status.hibernateReason).not.toContain("\t");
    expect(status.hibernateReason).not.toContain("\u0007");
    expect((status.hibernateReason ?? "").length).toBeLessThanOrEqual(120);
    // Whitespace-only reason collapses to null.
    expect(status.lastWakeReason).toBeNull();
  });

  it("reports 1-based wake queue position and reason within the ordered queue", () => {
    const queue: AgentWakeQueueEntry[] = [
      {
        id: 1,
        agentId: "agent-b",
        repoRoot: null,
        triggerKind: "direct_a2a",
        triggerMessageId: null,
        priority: 0,
        reason: "b work",
        correlationId: "c-b",
        status: "queued",
        attempt: 0,
        enqueuedAt: "2026-07-11T07:31:00.000Z",
        updatedAt: "2026-07-11T07:31:00.000Z",
      },
      {
        id: 2,
        agentId: "agent-a",
        repoRoot: null,
        triggerKind: "slack_thread",
        triggerMessageId: 42,
        priority: 5,
        reason: "slack reply",
        correlationId: "c-a",
        status: "queued",
        attempt: 1,
        enqueuedAt: "2026-07-11T07:32:00.000Z",
        updatedAt: "2026-07-11T07:32:00.000Z",
      },
    ];
    const status = buildAgentLifecycleStatus(baseInput({ orderedWakeQueue: queue }));
    expect(status.wake.queued).toBe(true);
    expect(status.wake.position).toBe(2);
    expect(status.wake.triggerKind).toBe("slack_thread");
    expect(status.wake.reason).toBe("slack reply");
    expect(status.wake.attempt).toBe(1);
  });

  it("surfaces bounded capacity with at-capacity flags", () => {
    const status = buildAgentLifecycleStatus(
      baseInput({
        capacity: {
          maxConcurrentWakes: 2,
          inflightWakes: 2,
          maxConcurrentWakesPerRepo: 1,
          inflightWakesForRepo: 0,
        },
      }),
    );
    expect(status.capacity?.global).toEqual({ inflight: 2, max: 2, atCapacity: true });
    expect(status.capacity?.repo).toEqual({ inflight: 0, max: 1, atCapacity: false });
  });

  it("surfaces the most recent non-accepted lifecycle outcome as the refusal cause", () => {
    const status = buildAgentLifecycleStatus(
      baseInput({
        recentEvents: [
          {
            id: 1,
            correlationId: "c1",
            agentId: "agent-a",
            fromState: "waking",
            toState: "waking",
            lifecycleVersion: 4,
            fenceToken: 9,
            reason: "wake",
            triggerSource: "manual",
            actor: "broker",
            outcome: "stale_fence",
            errorCode: "WAKE_FENCE_REJECTED",
            queueDepth: null,
            oldestQueueAgeMs: null,
            durationMs: null,
            rssBytesBefore: null,
            rssBytesAfter: null,
            createdAt: "2026-07-11T07:33:00.000Z",
          },
          {
            id: 2,
            correlationId: "c2",
            agentId: "agent-a",
            fromState: "idle",
            toState: "hibernated",
            lifecycleVersion: 4,
            fenceToken: null,
            reason: "idle",
            triggerSource: null,
            actor: "broker",
            outcome: "accepted",
            errorCode: null,
            queueDepth: null,
            oldestQueueAgeMs: null,
            durationMs: null,
            rssBytesBefore: null,
            rssBytesAfter: null,
            createdAt: "2026-07-11T07:30:00.000Z",
          },
        ],
      }),
    );
    expect(status.refusal).toEqual({
      reason: "WAKE_FENCE_REJECTED",
      outcome: "stale_fence",
      at: "2026-07-11T07:33:00.000Z",
    });
  });

  it("flags reap-candidate quarantine", () => {
    const status = buildAgentLifecycleStatus(
      baseInput({ agent: { ...baseInput().agent, lifecycleState: "reap-candidate" } }),
    );
    expect(status.quarantined).toBe(true);
  });
});

describe("formatAgentLifecycleStatus", () => {
  it("renders an operator-safe block without argv/env/paths", () => {
    const status = buildAgentLifecycleStatus(
      baseInput({
        runtimeSpec: runtimeSpec(),
        capacity: {
          maxConcurrentWakes: 2,
          inflightWakes: 1,
          maxConcurrentWakesPerRepo: 1,
          inflightWakesForRepo: 1,
        },
      }),
    );
    const text = formatAgentLifecycleStatus(status);
    expect(text).toContain("agent-a: hibernated");
    expect(text).toContain("gen 7");
    expect(text).toContain("runtime spec: present");
    expect(text).toContain("env_allow=3");
    expect(text).toContain("repo=extensions");
    expect(text).toContain("(at capacity)");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("/Users/secret");
    expect(text).not.toMatch(/prompt|token|secret/i);
  });

  it("flags a missing runtime spec for a durable hibernation state", () => {
    const status = buildAgentLifecycleStatus(baseInput({ runtimeSpec: null }));
    const text = formatAgentLifecycleStatus(status);
    expect(text).toContain("runtime spec: MISSING");
  });
});

describe("redactPathLikeTokens / sanitizeOperatorReason path redaction", () => {
  it("redacts absolute, home, relative, and Windows path tokens", () => {
    expect(redactPathLikeTokens("checkpoint failed at /Users/tm/secret/creds.json")).toBe(
      "checkpoint failed at <path>",
    );
    expect(redactPathLikeTokens("see ~/私/tokens and ./rel/path and ../up/one")).toBe(
      "see <path> and <path> and <path>",
    );
    expect(redactPathLikeTokens("failed under C:\\Users\\tm\\repo\\extensions")).toBe(
      "failed under <path>",
    );
    expect(redactPathLikeTokens("multi/segment/relative here")).toBe("<path> here");
    // Unix socket path.
    expect(redactPathLikeTokens("socket /private/tmp/tmux-501/default gone")).toBe(
      "socket <path> gone",
    );
  });

  it("preserves ordinary prose and single-slash words", () => {
    expect(redactPathLikeTokens("retry and/or wait")).toBe("retry and/or wait");
    expect(redactPathLikeTokens("plain english reason")).toBe("plain english reason");
  });

  it("redacts a file-like single-separator relative path but preserves extension-free prose", () => {
    // Single-separator tokens that carry a file extension are file-like paths.
    expect(redactPathLikeTokens("edited accounts/acme.md just now")).toBe("edited <path> just now");
    expect(redactPathLikeTokens("open src/index.ts")).toBe("open <path>");
    // Extension-free single-separator prose and dotted non-path words survive.
    expect(redactPathLikeTokens("either and/or both")).toBe("either and/or both");
    expect(redactPathLikeTokens("built with Node.js today")).toBe("built with Node.js today");
  });

  it("sanitizeOperatorReason strips control chars, collapses space, and redacts paths", () => {
    expect(sanitizeOperatorReason("stalled\n\tat /Users/tm/private/x")).toBe("stalled at <path>");
    expect(sanitizeOperatorReason("   ")).toBeNull();
    expect(sanitizeOperatorReason(null)).toBeNull();
  });
});
