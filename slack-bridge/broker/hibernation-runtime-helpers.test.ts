import { describe, expect, it } from "vitest";
import {
  buildResumeLauncherScript,
  buildRuntimeSpecInput,
  buildWakeFenceEnv,
  deriveVcsIdentity,
  parseRssBytesFromPs,
  parseWakeFenceEnv,
  resumePathFromSessionRef,
  sessionResumeRefFromStableId,
  shellQuote,
  type SpawnAuthoredRuntimeFacts,
} from "./hibernation-runtime-helpers.js";

describe("deriveVcsIdentity", () => {
  it("parses scp-style github remotes", () => {
    expect(deriveVcsIdentity("git@github.com:gugu91/extensions.git")).toBe("gugu91/extensions");
    expect(deriveVcsIdentity("git@github.com:gugu91/extensions")).toBe("gugu91/extensions");
  });

  it("parses https and ssh URL remotes", () => {
    expect(deriveVcsIdentity("https://github.com/gugu91/extensions.git")).toBe("gugu91/extensions");
    expect(deriveVcsIdentity("https://github.com/gugu91/extensions/")).toBe("gugu91/extensions");
    expect(deriveVcsIdentity("ssh://git@github.com/gugu91/extensions.git")).toBe(
      "gugu91/extensions",
    );
    expect(deriveVcsIdentity("git://github.com/gugu91/extensions")).toBe("gugu91/extensions");
  });

  it("takes the final owner/repo of deeper paths (e.g. gitlab subgroups)", () => {
    expect(deriveVcsIdentity("https://gitlab.com/group/subgroup/repo.git")).toBe("subgroup/repo");
    expect(deriveVcsIdentity("git@gitlab.com:group/subgroup/repo.git")).toBe("subgroup/repo");
  });

  it("does NOT infer identity from a bare directory name (fails closed)", () => {
    expect(deriveVcsIdentity("extensions")).toBeNull();
    expect(deriveVcsIdentity("")).toBeNull();
    expect(deriveVcsIdentity("   ")).toBeNull();
    expect(deriveVcsIdentity(null)).toBeNull();
    expect(deriveVcsIdentity(undefined)).toBeNull();
  });

  it("returns identity from the remote, not the working directory path", () => {
    // Two different worktree dirs sharing a final segment resolve to the SAME
    // remote-derived identity — the security property the allowlist relies on.
    expect(deriveVcsIdentity("git@github.com:gugu91/extensions.git")).toBe(
      deriveVcsIdentity("https://github.com/gugu91/extensions"),
    );
  });
});

describe("parseRssBytesFromPs", () => {
  it("converts ps KiB output to bytes", () => {
    expect(parseRssBytesFromPs("  123456\n")).toBe(123456 * 1024);
    expect(parseRssBytesFromPs("RSS\n  2048\n")).toBe(2048 * 1024);
  });

  it("returns null when the process is gone / no numeric output", () => {
    expect(parseRssBytesFromPs("")).toBeNull();
    expect(parseRssBytesFromPs("   \n")).toBeNull();
    expect(parseRssBytesFromPs(null)).toBeNull();
    expect(parseRssBytesFromPs(undefined)).toBeNull();
  });
});

describe("session resume ref round-trip", () => {
  it("builds session:<path> from a session stable id and recovers the path", () => {
    const stableId = "myhost:session:/tmp/pi/sessions/agent-abc.jsonl";
    const ref = sessionResumeRefFromStableId(stableId);
    expect(ref).toBe("session:/tmp/pi/sessions/agent-abc.jsonl");
    expect(resumePathFromSessionRef(ref)).toBe("/tmp/pi/sessions/agent-abc.jsonl");
  });

  it("returns null for non-session stable ids (not resumable)", () => {
    expect(sessionResumeRefFromStableId("myhost:cwd:/repo/path")).toBeNull();
    expect(sessionResumeRefFromStableId("myhost:leaf:abc123")).toBeNull();
    expect(sessionResumeRefFromStableId(null)).toBeNull();
  });

  it("recovers nothing from a non-session ref", () => {
    expect(resumePathFromSessionRef("cwd:/repo/path")).toBeNull();
    expect(resumePathFromSessionRef("leaf:abc")).toBeNull();
    expect(resumePathFromSessionRef("session:")).toBeNull();
    expect(resumePathFromSessionRef("")).toBeNull();
    expect(resumePathFromSessionRef(null)).toBeNull();
  });

  it("produces a ref whose payload is never surfaced verbatim (kept redactable)", () => {
    // The ref carries a `session:` kind prefix so redactRuntimeSpec can emit
    // `session:#<fingerprint>` and never the raw path.
    const ref = sessionResumeRefFromStableId("h:session:/secret/path/x.jsonl");
    expect(ref?.startsWith("session:")).toBe(true);
  });
});

describe("wake fence env round-trip", () => {
  const fence = {
    wakeLeaseId: "lease-1",
    fenceToken: 7,
    reservedGeneration: 42,
    reservationNonce: "nonce-xyz",
  };

  it("builds env and parses it back to the same fence", () => {
    const env = buildWakeFenceEnv({ ...fence, correlationId: "corr-1" });
    expect(env.PINET_WAKE_LEASE_ID).toBe("lease-1");
    expect(env.PINET_WAKE_FENCE_TOKEN).toBe("7");
    expect(env.PINET_WAKE_RESERVED_GENERATION).toBe("42");
    expect(env.PINET_WAKE_RESERVATION_NONCE).toBe("nonce-xyz");
    expect(parseWakeFenceEnv(env)).toEqual(fence);
  });

  it("fails closed to null on a partial or garbled environment", () => {
    expect(parseWakeFenceEnv({})).toBeNull();
    expect(
      parseWakeFenceEnv({
        PINET_WAKE_LEASE_ID: "lease-1",
        PINET_WAKE_RESERVATION_NONCE: "nonce-xyz",
        PINET_WAKE_FENCE_TOKEN: "not-a-number",
        PINET_WAKE_RESERVED_GENERATION: "42",
      }),
    ).toBeNull();
    expect(
      parseWakeFenceEnv({
        PINET_WAKE_LEASE_ID: "",
        PINET_WAKE_RESERVATION_NONCE: "nonce",
        PINET_WAKE_FENCE_TOKEN: "1",
        PINET_WAKE_RESERVED_GENERATION: "1",
      }),
    ).toBeNull();
  });

  it("only accepts canonical positive decimal safe integers for the numeric fields", () => {
    const withNumbers = (token: string, generation: string) =>
      parseWakeFenceEnv({
        PINET_WAKE_LEASE_ID: "lease-1",
        PINET_WAKE_RESERVATION_NONCE: "nonce-xyz",
        PINET_WAKE_FENCE_TOKEN: token,
        PINET_WAKE_RESERVED_GENERATION: generation,
      });
    // Rejected: coercible-but-non-canonical forms Number.parseInt would accept.
    for (const bad of ["12abc", " 7", "7 ", "+7", "-7", "07", "0", "0x10", "7.0", "1e3", ""]) {
      expect(withNumbers(bad, "42")).toBeNull();
      expect(withNumbers("7", bad)).toBeNull();
    }
    // Rejected: beyond the safe-integer range.
    expect(withNumbers("9007199254740993", "42")).toBeNull();
    // Accepted: canonical positive decimals.
    expect(withNumbers("7", "42")).toEqual({
      wakeLeaseId: "lease-1",
      fenceToken: 7,
      reservedGeneration: 42,
      reservationNonce: "nonce-xyz",
    });
  });
});

describe("shellQuote", () => {
  it("wraps values and escapes embedded single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("with space")).toBe("'with space'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("buildResumeLauncherScript", () => {
  const base = {
    repoPath: "/repo/root",
    sessionPath: "/tmp/sessions/agent-abc.jsonl",
    extensionEntryPath: "/ext/index.js",
    inheritedEnv: { PI_SETTINGS_PATH: "/cfg/settings.json", ABSENT: undefined },
    pinetEnv: { PINET_SOCKET_PATH: "/sock", PINET_WAKE_LEASE_ID: "lease-1" },
    nickname: "Woken Worker",
  };

  it("resumes the exact session with pi --session and no startup prompt", () => {
    const script = buildResumeLauncherScript(base);
    expect(script).toContain("cd '/repo/root'");
    expect(script).toContain(
      "exec pi -e '/ext/index.js' --session '/tmp/sessions/agent-abc.jsonl'",
    );
    // No trailing free-text prompt argument after the session path.
    expect(script).not.toMatch(/--session '[^']*'\s+'/);
  });

  it("exports inherited env only when present, plus pinet + fence env", () => {
    const script = buildResumeLauncherScript(base);
    expect(script).toContain("export PI_SETTINGS_PATH='/cfg/settings.json'");
    expect(script).not.toContain("ABSENT");
    expect(script).toContain("export PINET_SOCKET_PATH='/sock'");
    expect(script).toContain("export PINET_WAKE_LEASE_ID='lease-1'");
    expect(script).toContain("export PI_NICKNAME='Woken Worker'");
  });

  it("starts with a strict bash shebang preamble", () => {
    const script = buildResumeLauncherScript(base);
    expect(script.startsWith("#!/bin/bash\nset -euo pipefail\n")).toBe(true);
  });

  it("self-deletes the secret-bearing launcher immediately before exec", () => {
    const script = buildResumeLauncherScript(base);
    const rmIndex = script.indexOf('rm -f -- "$0"');
    const execIndex = script.indexOf("exec pi -e");
    expect(rmIndex).toBeGreaterThan(0);
    // The self-delete must be the last statement before exec so the open fd
    // survives the unlink while no secret file lingers.
    expect(rmIndex).toBeLessThan(execIndex);
  });
});

describe("buildRuntimeSpecInput", () => {
  const facts: SpawnAuthoredRuntimeFacts = {
    agentId: "agent-1",
    stableId: "host.local:session:/sessions/worker.jsonl",
    brokerOwnerId: "broker-instance-9",
    cwd: "/repos/extensions/.worktrees/wt",
    repoRoot: "/repos/extensions/.worktrees/wt",
    worktreePath: "/repos/extensions/.worktrees/wt",
    tmuxSocket: "/tmp/pinet.sock",
    tmuxSession: "pinet-worker-1",
    tmuxTarget: "pinet-worker-1:0.0",
    extensionEntryPath: "/pkg/slack-bridge/index.ts",
    envAllowlist: ["PINET_SOCKET_PATH", "PI_SETTINGS_PATH", "PINET_SOCKET_PATH", ""],
    configFingerprint: "cfg#abc",
    expectedUser: "tmnexcade",
    launchSource: "subtree-broker-tmux",
    vcsIdentity: "gugu91/extensions",
  };

  it("composes a complete spec from broker-known facts", () => {
    const spec = buildRuntimeSpecInput(facts);
    expect(spec).not.toBeNull();
    expect(spec).toMatchObject({
      agentId: "agent-1",
      brokerOwnerId: "broker-instance-9",
      tmuxTarget: "pinet-worker-1:0.0",
      executable: "pi",
      sessionResumeRef: "session:/sessions/worker.jsonl",
      vcsIdentity: "gugu91/extensions",
      expectedHost: "host.local",
    });
    // argv mirrors the resume launch, with the path recovered from the ref only.
    expect(spec?.argv).toEqual([
      "-e",
      "/pkg/slack-bridge/index.ts",
      "--session",
      "/sessions/worker.jsonl",
    ]);
    // envAllowlist is de-duplicated and drops empties (names only).
    expect(spec?.envAllowlist).toEqual(["PINET_SOCKET_PATH", "PI_SETTINGS_PATH"]);
  });

  it("preserves the broker-derived vcsIdentity, including null (fail-closed authz)", () => {
    expect(buildRuntimeSpecInput({ ...facts, vcsIdentity: null })?.vcsIdentity).toBeNull();
  });

  it("returns null for a non-resumable identity (no session path)", () => {
    expect(buildRuntimeSpecInput({ ...facts, stableId: "host:cwd:/repos/x" })).toBeNull();
    expect(buildRuntimeSpecInput({ ...facts, stableId: "host:broker:/x" })).toBeNull();
    expect(buildRuntimeSpecInput({ ...facts, stableId: "not-a-stable-id" })).toBeNull();
  });

  it("fails closed when a required operational locator is missing", () => {
    expect(buildRuntimeSpecInput({ ...facts, tmuxTarget: "" })).toBeNull();
    expect(buildRuntimeSpecInput({ ...facts, tmuxSocket: "" })).toBeNull();
    expect(buildRuntimeSpecInput({ ...facts, tmuxSession: "" })).toBeNull();
    expect(buildRuntimeSpecInput({ ...facts, repoRoot: "" })).toBeNull();
  });

  it("defaults cwd/worktree to repoRoot and fills soft defaults", () => {
    const spec = buildRuntimeSpecInput({
      ...facts,
      cwd: "",
      worktreePath: "",
      configFingerprint: "",
      launchSource: "",
    });
    expect(spec?.cwd).toBe(facts.repoRoot);
    expect(spec?.worktreePath).toBe(facts.repoRoot);
    expect(spec?.configFingerprint).toBe("unknown");
    expect(spec?.launchSource).toBe("subtree-broker-tmux");
  });
});
