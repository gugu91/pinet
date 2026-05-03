import { describe, expect, it } from "vitest";
import {
  decideRuntimeAction,
  extractFileListDetails,
  resolveBaseConfig,
  resolveEffectivePolicy,
  validatePreparedRecord,
  type PreparedCompactionRecord,
} from "./helpers.js";

describe("compaction-worker policy resolution", () => {
  it("resolves default reserve threshold from model context window", () => {
    const base = resolveBaseConfig({ enabled: true, reserveTokens: 10_000 });
    const policy = resolveEffectivePolicy(base, {
      provider: "anthropic",
      id: "claude-sonnet",
      contextWindow: 200_000,
    });

    expect(policy.enabled).toBe(true);
    expect(policy.modelKey).toBe("anthropic/claude-sonnet");
    expect(policy.triggerAtTokens).toBe(190_000);
    expect(policy.keepRecentTokens).toBe(20_000);
  });

  it("uses glob profile overrides without resetting omitted default fields", () => {
    const base = resolveBaseConfig({
      enabled: true,
      keepRecentTokens: 33_000,
      summaryModels: ["google/gemini-2.5-flash"],
      profiles: {
        opus: {
          match: "anthropic/claude-opus-*",
          prepareAtPercent: 55,
          triggerAtPercent: 70,
          reserveTokens: 50_000,
        },
      },
    });

    const policy = resolveEffectivePolicy(base, {
      provider: "anthropic",
      id: "claude-opus-4",
      contextWindow: 1_000_000,
    });

    expect(policy.matchedProfile).toBe("opus");
    expect(policy.prepareAtTokens).toBe(550_000);
    expect(policy.triggerAtTokens).toBe(700_000);
    expect(policy.reserveTokens).toBe(50_000);
    expect(policy.keepRecentTokens).toBe(33_000);
    expect(policy.summaryModels).toEqual(["google/gemini-2.5-flash"]);
  });

  it("prefers exact and more specific profile matches over broad globs", () => {
    const base = resolveBaseConfig({
      enabled: true,
      profiles: {
        broad: {
          match: "anthropic/*",
          reserveTokens: 10_000,
        },
        opus: {
          match: "anthropic/claude-opus-*",
          reserveTokens: 60_000,
        },
        exact: {
          match: "anthropic/claude-opus-4",
          reserveTokens: 90_000,
        },
      },
    });

    const exactPolicy = resolveEffectivePolicy(base, {
      provider: "anthropic",
      id: "claude-opus-4",
      contextWindow: 1_000_000,
    });
    const specificGlobPolicy = resolveEffectivePolicy(base, {
      provider: "anthropic",
      id: "claude-opus-4-1",
      contextWindow: 1_000_000,
    });

    expect(exactPolicy.matchedProfile).toBe("exact");
    expect(exactPolicy.reserveTokens).toBe(90_000);
    expect(specificGlobPolicy.matchedProfile).toBe("opus");
    expect(specificGlobPolicy.reserveTokens).toBe(60_000);
  });
});

describe("compaction-worker runtime decisions", () => {
  const policy = resolveEffectivePolicy(
    resolveBaseConfig({
      enabled: true,
      prepareAtTokens: 100,
      triggerAtTokens: 200,
      cooldownMs: 10,
      builtinReserveTokens: 100,
      builtinSkipMarginPercent: 0,
    }),
    { provider: "test", id: "model", contextWindow: 1_000 },
  );

  it("starts prepare after the prepare threshold", () => {
    expect(
      decideRuntimeAction({
        usage: { tokens: 120, contextWindow: 1_000 },
        policy,
        prepared: undefined,
        inFlight: false,
        nowMs: 100,
      }),
    ).toEqual({ action: "prepare", reason: "prepare-threshold" });
  });

  it("honors an explicit zero built-in skip margin", () => {
    expect(policy.builtinSkipMarginPercent).toBe(0);
    expect(
      decideRuntimeAction({
        usage: { tokens: 880, contextWindow: 1_000 },
        policy,
        prepared: undefined,
        inFlight: false,
        nowMs: 100,
      }),
    ).toEqual({ action: "compact", reason: "trigger-threshold-live", usePrepared: false });
  });

  it("does not suppress large-context custom reserve triggers by default", () => {
    const largeContextPolicy = resolveEffectivePolicy(
      resolveBaseConfig({
        enabled: true,
        reserveTokens: 65_536,
        builtinReserveTokens: 16_384,
      }),
      { provider: "anthropic", id: "claude-opus-4", contextWindow: 1_000_000 },
    );

    expect(largeContextPolicy.builtinSkipMarginPercent).toBe(0);
    expect(largeContextPolicy.triggerAtTokens).toBe(934_464);
    expect(
      decideRuntimeAction({
        usage: { tokens: 934_464, contextWindow: 1_000_000 },
        policy: largeContextPolicy,
        prepared: undefined,
        inFlight: false,
        nowMs: 100,
      }),
    ).toEqual({ action: "compact", reason: "trigger-threshold-live", usePrepared: false });
  });

  it("applies cooldown only when the current runtime supplies a recent compaction time", () => {
    const input = {
      usage: { tokens: 220, contextWindow: 1_000 },
      policy,
      prepared: undefined,
      inFlight: false,
      nowMs: 100,
    };

    expect(decideRuntimeAction({ ...input, lastCompactAtMs: 95 })).toEqual({
      action: "none",
      reason: "cooldown",
    });
    expect(decideRuntimeAction(input)).toEqual({
      action: "compact",
      reason: "trigger-threshold-live",
      usePrepared: false,
    });
  });

  it("triggers live compaction at the trigger threshold without a ready summary", () => {
    expect(
      decideRuntimeAction({
        usage: { tokens: 220, contextWindow: 1_000 },
        policy,
        prepared: undefined,
        inFlight: false,
        nowMs: 100,
      }),
    ).toEqual({ action: "compact", reason: "trigger-threshold-live", usePrepared: false });
  });

  it("triggers prepared compaction at the trigger threshold with a ready summary", () => {
    const prepared: PreparedCompactionRecord = {
      schemaVersion: 1,
      status: "ready",
      jobId: "job",
      cwd: "/repo",
      modelKey: "test/model",
      policyHash: policy.policyHash,
      createdAt: new Date(0).toISOString(),
      summary: "summary",
    };

    expect(
      decideRuntimeAction({
        usage: { tokens: 220, contextWindow: 1_000 },
        policy,
        prepared,
        inFlight: false,
        nowMs: 100,
      }),
    ).toEqual({ action: "compact", reason: "trigger-threshold-ready", usePrepared: true });
  });
});

describe("compaction detail helpers", () => {
  it("extracts top-level file lists from worker details", () => {
    expect(
      extractFileListDetails({
        kind: "compaction-worker",
        readFiles: ["README.md"],
        modifiedFiles: ["compaction-worker/index.ts"],
      }),
    ).toEqual({ readFiles: ["README.md"], modifiedFiles: ["compaction-worker/index.ts"] });
  });

  it("can read nested legacy Pi detail payloads", () => {
    expect(
      extractFileListDetails({
        kind: "compaction-worker",
        details: {
          readFiles: ["old-read.ts"],
          modifiedFiles: ["old-edit.ts"],
        },
      }),
    ).toEqual({ readFiles: ["old-read.ts"], modifiedFiles: ["old-edit.ts"] });
  });
});

describe("prepared record validation", () => {
  const policy = resolveEffectivePolicy(
    resolveBaseConfig({ enabled: true, triggerAtTokens: 200, maxPreparedAgeMs: 60_000 }),
    { provider: "test", id: "model", contextWindow: 1_000 },
  );

  function readyRecord(
    overrides: Partial<PreparedCompactionRecord> = {},
  ): PreparedCompactionRecord {
    return {
      schemaVersion: 1,
      status: "ready",
      jobId: "job",
      sessionId: "session",
      sessionFile: "/tmp/session.jsonl",
      cwd: "/repo",
      modelKey: "test/model",
      policyHash: policy.policyHash,
      createdAt: new Date(1_000).toISOString(),
      firstKeptEntryId: "b",
      leafIdCovered: "c",
      previousCompactionId: "a",
      summary: "summary",
      ...overrides,
    };
  }

  const branchEntries = [
    { id: "a", type: "compaction" },
    { id: "b", type: "message" },
    { id: "c", type: "message" },
    { id: "d", type: "message" },
  ];

  it("accepts a ready record that covers an ancestor of the current branch", () => {
    expect(
      validatePreparedRecord(readyRecord(), {
        identity: { sessionId: "session", sessionFile: "/tmp/session.jsonl", cwd: "/repo" },
        policy,
        branchEntries,
        nowMs: 2_000,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects records for divergent branches", () => {
    expect(
      validatePreparedRecord(readyRecord({ leafIdCovered: "missing" }), {
        identity: { sessionId: "session", sessionFile: "/tmp/session.jsonl", cwd: "/repo" },
        policy,
        branchEntries,
        nowMs: 2_000,
      }),
    ).toEqual({ ok: false, reason: "covered-leaf-not-ancestor" });
  });

  it("rejects records after another compaction changed the boundary", () => {
    expect(
      validatePreparedRecord(readyRecord(), {
        identity: { sessionId: "session", sessionFile: "/tmp/session.jsonl", cwd: "/repo" },
        policy,
        branchEntries: [...branchEntries, { id: "e", type: "compaction" }],
        nowMs: 2_000,
      }),
    ).toEqual({ ok: false, reason: "compaction-boundary-changed" });
  });
});
