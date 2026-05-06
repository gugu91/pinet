import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadSettings,
  resolvePinetMeshAuth,
  resolveAllowAllWorkspaceUsers,
  buildAllowlist,
  describeSlackUserAccess,
  getSlackUserAccessWarning,
  isUserAllowed,
  formatInboxMessages,
  formatPinetInboxMessages,
  isTerminalPinetStandDownMessage,
  parsePinetControlCommand,
  getPinetControlCommandFromText,
  buildPinetControlMetadata,
  buildPinetControlMessage,
  normalizeOutgoingPinetControlMessage,
  buildPinetSkinAssignment,
  buildPinetSkinPromptGuideline,
  buildPinetOwnerToken,
  extractPinetControlCommand,
  queuePinetRemoteControl,
  finishPinetRemoteControl,
  reloadPinetRuntimeSafely,
  getSqliteJournalMode,
  isSqliteWalEnabled,
  buildSqliteWalFallbackWarning,
  formatAgentList,
  shortenPath,
  buildAgentCapabilityTags,
  buildAgentDisplayInfo,
  buildSlackCompatibilityScope,
  extractAgentCapabilities,
  isAgentVisibleInMesh,
  filterAgentsForMeshVisibility,
  rankAgentsForRouting,
  evaluateRalphLoopCycle,
  rewriteRalphLoopGhostAnomalies,
  buildRalphLoopNudgeMessage,
  buildRalphLoopAnomalySignature,
  buildRalphLoopCycleNotifications,
  buildRalphLoopFollowUpMessage,
  buildRalphLoopStatusMessage,
  shouldDeliverRalphLoopFollowUp,
  DEFAULT_RALPH_LOOP_INTERVAL_MS,
  MAX_RALPH_LOOP_INTERVAL_MS,
  resolveRalphLoopIntervalMs,
  DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS,
  DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
  isRalphNudgeEntry,
  isAgentToAgentEntry,
  partitionFollowerInboxEntries,
  syncBrokerInboxEntries,
  buildBrokerProtocolGuardrailsPrompt,
  buildWorkerPromptGuidelines,
  buildIdentityReplyGuidelines,
  buildAgentPersonalityGuidelines,
  resolveAgentPersonality,
  resolvePersistedAgentIdentity,
  resolveRuntimeAgentIdentity,
  buildAgentStableId,
  resolveAgentStableId,
  buildBrokerStableId,
  resolveBrokerStableId,
  isLikelyLocalSubagentContext,
  buildSlackRequest,
  createAbortableOperationTracker,
  abortableDelay,
  stripBotMention,
  isChannelId,
  FORM_METHODS,
  generateAgentName,
  resolveAgentIdentity,
  alignAgentIdentityToRole,
  trackBrokerInboundThread,
  syncFollowerInboxEntries,
  resolveFollowerThreadChannel,
  isDirectMessageChannel,
  buildFollowerRuntimeDiagnostic,
  formatFollowerRuntimeDiagnosticHealth,
  formatFollowerRuntimeDiagnosticNextStep,
  getFollowerReconnectUiUpdate,
  agentOwnsThread,
  normalizeOwnedThreads,
  getFollowerOwnedThreadClaims,
  getFollowerOwnedThreadReclaims,
  type InboxMessage,
  type AgentDisplayInfo,
  type FollowerThreadState,
} from "./helpers.js";

type NudgeTestEntry = {
  inboxId: number;
  message: {
    threadId: string;
    sender: string;
    body: string;
    metadata: Record<string, unknown> | null;
  };
};

// ─── loadSettings ─────────────────────────────────────────

describe("loadSettings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty object for missing file", () => {
    const result = loadSettings(path.join(tmpDir, "nope.json"));
    expect(result).toEqual({});
  });

  it("returns empty object for invalid JSON", () => {
    const p = path.join(tmpDir, "bad.json");
    fs.writeFileSync(p, "not json{{{");
    expect(loadSettings(p)).toEqual({});
  });

  it("returns empty object when slack-bridge key is missing", () => {
    const p = path.join(tmpDir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ other: "stuff" }));
    expect(loadSettings(p)).toEqual({});
  });

  it("returns slack-bridge settings", () => {
    const p = path.join(tmpDir, "settings.json");
    const settings = {
      "slack-bridge": {
        botToken: "xoxb-test",
        appToken: "xapp-test",
        runtimeMode: "single",
        autoConnect: true,
        ralphLoopIntervalMs: 120000,
        allowedUsers: ["U123"],
        allowAllWorkspaceUsers: false,
        defaultChannel: "C456",
        logChannel: "#pinet-logs",
        logLevel: "verbose",
      },
    };
    fs.writeFileSync(p, JSON.stringify(settings));
    const result = loadSettings(p);
    expect(result.botToken).toBe("xoxb-test");
    expect(result.appToken).toBe("xapp-test");
    expect(result.runtimeMode).toBe("single");
    expect(result.autoConnect).toBe(true);
    expect(result.ralphLoopIntervalMs).toBe(120000);
    expect(result.allowedUsers).toEqual(["U123"]);
    expect(result.allowAllWorkspaceUsers).toBe(false);
    expect(result.defaultChannel).toBe("C456");
    expect(result.logChannel).toBe("#pinet-logs");
    expect(result.logLevel).toBe("verbose");
  });

  it("returns autoFollow setting", () => {
    const p = path.join(tmpDir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ "slack-bridge": { autoFollow: true } }));
    const result = loadSettings(p);
    expect(result.autoFollow).toBe(true);
  });

  it("returns autoFollow as undefined when not set", () => {
    const p = path.join(tmpDir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ "slack-bridge": { botToken: "xoxb-test" } }));
    const result = loadSettings(p);
    expect(result.autoFollow).toBeUndefined();
  });

  it("returns security settings", () => {
    const p = path.join(tmpDir, "settings.json");
    const settings = {
      "slack-bridge": {
        security: {
          readOnly: true,
          requireConfirmation: ["bash", "edit"],
          blockedTools: ["comment_wipe_all"],
        },
      },
    };
    fs.writeFileSync(p, JSON.stringify(settings));
    const result = loadSettings(p);
    expect(result.security).toEqual({
      readOnly: true,
      requireConfirmation: ["bash", "edit"],
      blockedTools: ["comment_wipe_all"],
    });
  });

  it("returns security as undefined when not set", () => {
    const p = path.join(tmpDir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ "slack-bridge": { botToken: "xoxb-test" } }));
    const result = loadSettings(p);
    expect(result.security).toBeUndefined();
  });

  it("returns suggested prompts", () => {
    const p = path.join(tmpDir, "settings.json");
    const settings = {
      "slack-bridge": {
        suggestedPrompts: [{ title: "Hi", message: "Hello!" }],
      },
    };
    fs.writeFileSync(p, JSON.stringify(settings));
    const result = loadSettings(p);
    expect(result.suggestedPrompts).toEqual([{ title: "Hi", message: "Hello!" }]);
  });

  it("returns activity log settings", () => {
    const p = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        "slack-bridge": {
          logChannel: "CLOGS",
          logLevel: "errors",
        },
      }),
    );
    const result = loadSettings(p);
    expect(result.logChannel).toBe("CLOGS");
    expect(result.logLevel).toBe("errors");
  });

  it("returns mesh auth settings", () => {
    const p = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        "slack-bridge": {
          meshSecret: "shared-secret",
          meshSecretPath: "/tmp/pinet.secret",
        },
      }),
    );
    const result = loadSettings(p);
    expect(result.meshSecret).toBe("shared-secret");
    expect(result.meshSecretPath).toBe("/tmp/pinet.secret");
  });

  it("loads settings files that still contain legacy control-plane canvas keys", () => {
    const p = path.join(tmpDir, "settings.json");
    const settings = {
      "slack-bridge": {
        defaultChannel: "ops-control",
        controlPlaneCanvasEnabled: true,
        controlPlaneCanvasId: "F123",
        controlPlaneCanvasChannel: "ops-control",
        controlPlaneCanvasTitle: "Mesh Status",
      },
    };
    fs.writeFileSync(p, JSON.stringify(settings));
    const result = loadSettings(p);
    expect(result.defaultChannel).toBe("ops-control");
  });
});

describe("resolvePinetMeshAuth", () => {
  it("returns nulls when no mesh auth is configured", () => {
    expect(resolvePinetMeshAuth({}, {})).toEqual({
      meshSecret: null,
      meshSecretPath: null,
    });
  });

  it("prefers settings over environment fallbacks", () => {
    expect(
      resolvePinetMeshAuth(
        { meshSecret: " from-settings ", meshSecretPath: "/settings/secret" },
        {
          ...process.env,
          PINET_MESH_SECRET: "from-env",
          PINET_MESH_SECRET_PATH: "/env/secret",
        },
      ),
    ).toEqual({
      meshSecret: "from-settings",
      meshSecretPath: null,
    });
  });

  it("falls back to environment when settings are unset", () => {
    expect(
      resolvePinetMeshAuth(
        {},
        {
          ...process.env,
          PINET_MESH_SECRET_PATH: " /env/secret ",
        },
      ),
    ).toEqual({
      meshSecret: null,
      meshSecretPath: "/env/secret",
    });
  });

  it("keeps settings meshSecretPath ahead of environment mesh auth", () => {
    expect(
      resolvePinetMeshAuth(
        { meshSecretPath: "/settings/secret" },
        {
          ...process.env,
          PINET_MESH_SECRET: " env-secret ",
          PINET_MESH_SECRET_PATH: "/env/secret",
        },
      ),
    ).toEqual({
      meshSecret: null,
      meshSecretPath: "/settings/secret",
    });
  });
});

// ─── Slack user access policy ────────────────────────────

describe("resolveAllowAllWorkspaceUsers", () => {
  it("defaults to false when unset", () => {
    expect(resolveAllowAllWorkspaceUsers({}, undefined)).toBe(false);
  });

  it("uses settings flag when present", () => {
    expect(resolveAllowAllWorkspaceUsers({ allowAllWorkspaceUsers: true }, undefined)).toBe(true);
    expect(resolveAllowAllWorkspaceUsers({ allowAllWorkspaceUsers: false }, "true")).toBe(false);
  });

  it("supports truthy env opt-in values", () => {
    expect(resolveAllowAllWorkspaceUsers({}, "true")).toBe(true);
    expect(resolveAllowAllWorkspaceUsers({}, "1")).toBe(true);
    expect(resolveAllowAllWorkspaceUsers({}, "yes")).toBe(true);
    expect(resolveAllowAllWorkspaceUsers({}, "on")).toBe(true);
  });
});

describe("buildAllowlist", () => {
  it("returns an empty set when no allowlist or explicit allow-all is configured", () => {
    expect(buildAllowlist({}, undefined, undefined)).toEqual(new Set());
  });

  it("returns an empty set for an empty allowedUsers array", () => {
    expect(buildAllowlist({ allowedUsers: [] }, undefined, undefined)).toEqual(new Set());
  });

  it("builds from settings.allowedUsers", () => {
    const result = buildAllowlist({ allowedUsers: ["U1", " U2 ", ""] }, undefined);
    expect(result).toEqual(new Set(["U1", "U2"]));
  });

  it("settings takes priority over env var", () => {
    const result = buildAllowlist({ allowedUsers: ["U1"] }, "U2,U3", "true");
    expect(result).toEqual(new Set(["U1"]));
  });

  it("falls back to env var when settings empty", () => {
    const result = buildAllowlist({}, "U2, U3 , U4", undefined);
    expect(result).toEqual(new Set(["U2", "U3", "U4"]));
  });

  it("returns null only for explicit allow-all opt-in", () => {
    expect(buildAllowlist({ allowAllWorkspaceUsers: true }, undefined, undefined)).toBeNull();
    expect(buildAllowlist({}, undefined, "true")).toBeNull();
  });

  it("trims and filters empty entries from env var", () => {
    const result = buildAllowlist({}, " U1 , , U2 , ", undefined);
    expect(result).toEqual(new Set(["U1", "U2"]));
  });
});

describe("describeSlackUserAccess", () => {
  it("describes default deny when the allowlist is empty", () => {
    expect(describeSlackUserAccess(new Set())).toBe(
      "Allowed users: none (default deny; set allowedUsers or allowAllWorkspaceUsers: true)",
    );
  });

  it("describes explicit allow-all mode", () => {
    expect(describeSlackUserAccess(null, { allowAllWorkspaceUsers: true })).toBe(
      "Allowed users: all (explicit allow-all enabled)",
    );
  });
});

describe("getSlackUserAccessWarning", () => {
  it("returns a startup warning for default deny mode", () => {
    expect(getSlackUserAccessWarning(new Set())).toContain(
      "Slack access is default-deny because no allowedUsers are configured.",
    );
  });

  it("returns null when access is explicitly configured", () => {
    expect(getSlackUserAccessWarning(new Set(["U1"]))).toBeNull();
    expect(getSlackUserAccessWarning(null)).toBeNull();
  });
});

// ─── isUserAllowed ────────────────────────────────────────

describe("isUserAllowed", () => {
  it("allows everyone when explicit allow-all mode is active", () => {
    expect(isUserAllowed(null, "U_ANYONE")).toBe(true);
  });

  it("rejects everyone when the allowlist is empty", () => {
    expect(isUserAllowed(new Set(), "U_ANYONE")).toBe(false);
  });

  it("allows user in the set", () => {
    expect(isUserAllowed(new Set(["U1", "U2"]), "U1")).toBe(true);
  });

  it("rejects user not in the set", () => {
    expect(isUserAllowed(new Set(["U1"]), "U_INTRUDER")).toBe(false);
  });
});

// ─── formatInboxMessages ──────────────────────────────────

describe("formatInboxMessages", () => {
  const names = new Map([["U1", "will"]]);

  it("formats a DM message", () => {
    const msgs: InboxMessage[] = [
      { channel: "D123", threadTs: "123.456", userId: "U1", text: "hello", timestamp: "123.456" },
    ];
    const result = formatInboxMessages(msgs, names);
    expect(result).toContain("[thread 123.456] will: hello");
    expect(result).toContain(
      "ACK briefly, do the work, report blockers immediately, report the outcome when done.",
    );
  });

  it("formats a channel mention", () => {
    const msgs: InboxMessage[] = [
      {
        channel: "C789",
        threadTs: "789.012",
        userId: "U1",
        text: "check this",
        timestamp: "789.012",
        isChannelMention: true,
      },
    ];
    const result = formatInboxMessages(msgs, names);
    expect(result).toContain("(channel mention in <#C789>)");
    expect(result).toContain("will: check this");
  });

  it("formats broker-backed Slack messages as Pinet read pointers without the body", () => {
    const msgs: InboxMessage[] = [
      {
        channel: "C789",
        threadTs: "789.012",
        userId: "U1",
        text: "secret Slack body",
        timestamp: "789.012",
        brokerInboxId: 13,
        isChannelMention: true,
      },
    ];

    const result = formatInboxMessages(msgs, names);
    expect(result).toContain("New Slack messages:");
    expect(result).toContain(
      "[thread 789.012] [fwup] (channel mention in <#C789>) will: inbox_id=13 pointer=pinet action=read args.thread_id=789.012 args.unread_only=true",
    );
    expect(result).toContain("Read pointer(s) before acting; reply/ACK only for actionable work.");
    expect(result).not.toContain("ACK briefly after reading, do the work");
    expect(result).not.toContain("secret Slack body");
  });

  it("formats mixed broker-backed Slack and Pinet messages as durable read pointers", () => {
    const msgs: InboxMessage[] = [
      {
        channel: "C789",
        threadTs: "789.012",
        userId: "U1",
        text: "secret Slack body",
        timestamp: "789.012",
        brokerInboxId: 13,
      },
      {
        channel: "",
        threadTs: "a2a:broker:worker",
        userId: "broker-id",
        text: "secret Pinet body",
        timestamp: "790.000",
        brokerInboxId: 17,
        metadata: { senderAgent: "Broker Bunny", a2a: true, pinetMailClass: "steering" },
      },
    ];

    const result = formatInboxMessages(msgs, names);
    expect(result).toContain("New Slack messages:");
    expect(result).toContain("New Pinet messages:");
    expect(result).toContain(
      "[thread 789.012] [fwup] will: inbox_id=13 pointer=pinet action=read args.thread_id=789.012 args.unread_only=true",
    );
    expect(result).toContain(
      "[thread a2a:broker:worker] [steering] broker-id (Broker Bunny): inbox_id=17 pointer=pinet action=read args.thread_id=a2a:broker:worker args.unread_only=true",
    );
    expect(result).not.toContain("secret Slack body");
    expect(result).not.toContain("secret Pinet body");
  });

  it("preserves compact Slack metadata on broker-backed pointer notifications", () => {
    const msgs: InboxMessage[] = [
      {
        channel: "C123",
        threadTs: "123.456",
        userId: "U1",
        text: "Alice mentioned you in a comment",
        timestamp: "123.789",
        brokerInboxId: 14,
        metadata: {
          slackFiles: [
            {
              id: "F_CANVAS_1",
              title: "Launch plan",
              permalink: "https://example.slack.com/docs/T/F_CANVAS_1",
            },
          ],
        },
      },
    ];

    const result = formatInboxMessages(msgs, names);
    expect(result).toContain(
      "will: inbox_id=14 pointer=pinet action=read args.thread_id=123.456 args.unread_only=true",
    );
    expect(result).toContain("[fwup]");
    expect(result).toContain('canvas={"canvasId":"F_CANVAS_1"');
    expect(result).not.toContain("Alice mentioned you in a comment");
  });

  it("suppresses reflex ack guidance for maintenance/context-only durable Slack pointer batches", () => {
    const msgs: InboxMessage[] = [
      {
        channel: "C123",
        threadTs: "123.456",
        userId: "U1",
        text: "background context only",
        timestamp: "123.789",
        brokerInboxId: 15,
        metadata: { pinetMailClass: "maintenance_context" },
      },
    ];

    const result = formatInboxMessages(msgs, names);
    expect(result).toContain(
      "[thread 123.456] [maintenance/context] will: inbox_id=15 pointer=pinet action=read args.thread_id=123.456 args.unread_only=true",
    );
    expect(result).toContain("Context-only pointer(s); read only if needed.");
    expect(result).not.toContain("ACK briefly after reading");
    expect(result).not.toContain("background context only");
  });

  it("keeps ack guidance when maintenance pointers are batched with inline Slack messages", () => {
    const msgs: InboxMessage[] = [
      {
        channel: "C123",
        threadTs: "123.456",
        userId: "U1",
        text: "background context only",
        timestamp: "123.789",
        brokerInboxId: 15,
        metadata: { pinetMailClass: "maintenance_context" },
      },
      {
        channel: "C123",
        threadTs: "123.999",
        userId: "U1",
        text: "please check this inline message",
        timestamp: "123.999",
      },
    ];

    const result = formatInboxMessages(msgs, names);
    expect(result).toContain("[maintenance/context]");
    expect(result).toContain("Read pointer(s) before acting; reply/ACK only for actionable work.");
    expect(result).toContain("will: please check this inline message");
    expect(result).not.toContain("background context only");
  });

  it("falls back to userId when name not in map", () => {
    const msgs: InboxMessage[] = [
      {
        channel: "D123",
        threadTs: "111.222",
        userId: "U_UNKNOWN",
        text: "hey",
        timestamp: "111.222",
      },
    ];
    const result = formatInboxMessages(msgs, new Map());
    expect(result).toContain("U_UNKNOWN: hey");
  });

  it("formats multiple messages", () => {
    const msgs: InboxMessage[] = [
      { channel: "D1", threadTs: "1.1", userId: "U1", text: "first", timestamp: "1.1" },
      { channel: "D2", threadTs: "2.2", userId: "U1", text: "second", timestamp: "2.2" },
    ];
    const result = formatInboxMessages(msgs, names);
    expect(result).toContain("will: first");
    expect(result).toContain("will: second");
  });

  it("includes compact metadata for block action inbox events", () => {
    const msgs: InboxMessage[] = [
      {
        channel: "C123",
        threadTs: "123.456",
        userId: "U1",
        text: 'Clicked Slack "Approve" (action_id: review.approve).',
        timestamp: "123.789",
        metadata: {
          kind: "slack_block_action",
          actionId: "review.approve",
          parsedValue: { decision: "approve" },
        },
      },
    ];
    const result = formatInboxMessages(msgs, names);
    expect(result).toContain('will: Clicked Slack "Approve" (action_id: review.approve).');
    expect(result).toContain('metadata={"kind":"slack_block_action","actionId":"review.approve"');
  });

  it("includes a compact canvas metadata suffix with a comment-read hint", () => {
    const msgs: InboxMessage[] = [
      {
        channel: "C123",
        threadTs: "123.456",
        userId: "U1",
        text: "Alice mentioned you in a comment",
        timestamp: "123.789",
        metadata: {
          slackFiles: [
            {
              id: "F_CANVAS_1",
              title: "Launch plan",
              permalink: "https://example.slack.com/docs/T/F_CANVAS_1",
            },
          ],
        },
      },
    ];

    const result = formatInboxMessages(msgs, names);
    expect(result).toContain("will: Alice mentioned you in a comment");
    expect(result).toContain('canvas={"canvasId":"F_CANVAS_1"');
    expect(result).toContain('"title":"Launch plan"');
    expect(result).toContain('"permalink":"https://example.slack.com/docs/T/F_CANVAS_1"');
    expect(result).toContain(
      '"toolHint":"slack action=canvas_comments_read args.canvas_id=F_CANVAS_1"',
    );
  });

  it("formats broker-side scheduled wake-ups as Pinet read pointers without the reminder body", () => {
    const msgs: InboxMessage[] = [
      {
        channel: "",
        threadTs: "wakeup:broker-1",
        userId: "scheduler",
        text: "/exit",
        timestamp: "2026-04-28T10:00:00.000Z",
        brokerInboxId: 77,
        metadata: {
          senderAgent: "Pinet Scheduler",
          scheduledWakeup: true,
          a2a: true,
          pinetMailClass: "fwup",
        },
      },
    ];

    const result = formatInboxMessages(msgs, names);
    expect(result).toContain("New Pinet messages:");
    expect(result).toContain(
      "[thread wakeup:broker-1] [fwup] scheduler (Pinet Scheduler): inbox_id=77 pointer=pinet action=read args.thread_id=wakeup:broker-1 args.unread_only=true",
    );
    expect(result).not.toContain("New Slack messages:");
    expect(result).not.toContain("scheduler: /exit");
  });

  it("keeps generic Slack file metadata out of the canvas-only suffix", () => {
    const msgs: InboxMessage[] = [
      {
        channel: "C123",
        threadTs: "123.456",
        userId: "U1",
        text: "See attached note",
        timestamp: "123.789",
        metadata: {
          slackFiles: [
            {
              id: "F123",
              title: "Incident notes",
              permalink: "https://files.example/incident.md",
            },
          ],
        },
      },
    ];

    const result = formatInboxMessages(msgs, names);
    expect(result).toContain("will: See attached note");
    expect(result).not.toContain("canvas_comments_read");
    expect(result).not.toContain(" | canvas=");
  });
});

describe("isTerminalPinetStandDownMessage", () => {
  it("detects explicit thread closeout instructions", () => {
    expect(
      isTerminalPinetStandDownMessage(
        "Hard stop on this thread now: no further acknowledgements are needed. Stay free and quiet unless I assign a new task here.",
      ),
    ).toBe(true);
  });

  it("does not misclassify a fresh task assignment as terminal", () => {
    expect(
      isTerminalPinetStandDownMessage(
        "New implementation lane for you — please ACK/work/ask/report back here. Issue: #299. Worktree setup: git worktree add ...",
      ),
    ).toBe(false);
  });
});

describe("formatPinetInboxMessages", () => {
  it("formats agent messages as compact steering pointers with reply guidance", () => {
    const result = formatPinetInboxMessages([
      {
        inboxId: 17,
        message: {
          threadId: "a2a:broker:worker",
          sender: "broker-id",
          body: "Take issue #175",
          metadata: { senderAgent: "Broker Bunny", a2a: true },
        },
      },
    ]);

    expect(result).toContain("New Pinet messages:");
    expect(result).toContain(
      "[thread a2a:broker:worker] [steering] broker-id (Broker Bunny): inbox_id=17 pointer=pinet action=read args.thread_id=a2a:broker:worker args.unread_only=true",
    );
    expect(result).not.toContain("Take issue #175");
    expect(result).toContain("Read pointer(s) before acting; reply via pinet action=send.");
    expect(result).not.toContain("ACK briefly after reading, do the work");
  });

  it("falls back to the sender id when no senderAgent metadata exists", () => {
    const result = formatPinetInboxMessages([
      {
        message: {
          threadId: "a2a:broker:worker",
          sender: "broker-id",
          body: "hello",
          metadata: { a2a: true },
        },
      },
    ]);

    expect(result).toContain(
      "[thread a2a:broker:worker] [fwup] broker-id: pointer=pinet action=read args.thread_id=a2a:broker:worker args.unread_only=true",
    );
    expect(result).not.toContain("broker-id: hello");
  });

  it("formats scheduled wake-ups as durable follow-up pointers without the reminder body", () => {
    const result = formatPinetInboxMessages([
      {
        inboxId: 42,
        message: {
          threadId: "wakeup:worker-1",
          sender: "scheduler",
          body: "Check whether PR #62 merged",
          metadata: {
            senderAgent: "Pinet Scheduler",
            scheduledWakeup: true,
            a2a: true,
            pinetMailClass: "fwup",
          },
        },
      },
    ]);

    expect(result).toContain("New Pinet messages:");
    expect(result).toContain(
      "[thread wakeup:worker-1] [fwup] scheduler (Pinet Scheduler): inbox_id=42 pointer=pinet action=read args.thread_id=wakeup:worker-1 args.unread_only=true",
    );
    expect(result).not.toContain("Check whether PR #62 merged");
    expect(result).toContain(
      "Read pointer(s) if follow-up is needed; reply via pinet action=send when needed.",
    );
  });

  it("marks terminal stand-down messages as maintenance/context and suppresses reflex ack guidance", () => {
    const result = formatPinetInboxMessages([
      {
        message: {
          threadId: "a2a:broker:worker",
          sender: "broker-id",
          body: "Hard stop on this thread now: no further acknowledgements are needed. Stay free and quiet unless I assign a new task here.",
          metadata: { senderAgent: "Broker Bunny", a2a: true },
        },
      },
    ]);

    expect(result).toContain("[maintenance/context]");
    expect(result).toContain("Context-only pointer(s); read only if needed.");
    expect(result).not.toContain("do NOT send another acknowledgement");
    expect(result).not.toContain("Hard stop on this thread");
    expect(result).not.toContain(
      "ACK briefly, do the work, report blockers immediately, report the outcome when done.",
    );
  });

  it("keeps steering reply guidance when a batch mixes context-only and actionable work", () => {
    const result = formatPinetInboxMessages([
      {
        message: {
          threadId: "a2a:broker:worker",
          sender: "broker-id",
          body: "No further replies are needed on this closed lane; stay free/quiet unless I assign a genuinely new task.",
          metadata: { senderAgent: "Broker Bunny", a2a: true },
        },
      },
      {
        message: {
          threadId: "a2a:broker:worker",
          sender: "broker-id",
          body: "New implementation lane for you — please ACK/work/ask/report back here. Issue: #299.",
          metadata: { senderAgent: "Broker Bunny", a2a: true },
        },
      },
    ]);

    expect(result).toContain("[maintenance/context]");
    expect(result).toContain("[steering]");
    expect(result).toContain(
      "Read pointer(s) before acting; reply via pinet action=send for steering/follow-up.",
    );
    expect(result).not.toContain("For [steering], ACK briefly after reading, do the work");
    expect(result).not.toContain(
      "do NOT acknowledge or reply unless you have a real blocker or materially new finding",
    );
  });
});

// ─── Pinet control messages ──────────────────────────────

describe("Pinet control helpers", () => {
  it("parses supported control commands", () => {
    expect(parsePinetControlCommand("interrupt")).toBe("interrupt");
    expect(parsePinetControlCommand("reload")).toBe("reload");
    expect(parsePinetControlCommand("exit")).toBe("exit");
    expect(parsePinetControlCommand("noop")).toBeNull();
  });

  it("detects control commands from structured JSON and legacy slash text", () => {
    expect(getPinetControlCommandFromText('{"type":"pinet:control","action":"reload"}')).toBe(
      "reload",
    );
    expect(getPinetControlCommandFromText("/interrupt")).toBe("interrupt");
    expect(getPinetControlCommandFromText("/reload")).toBe("reload");
    expect(getPinetControlCommandFromText(" /exit ")).toBe("exit");
    expect(getPinetControlCommandFromText('{"type":"pinet:control","action":"noop"}')).toBe(null);
    expect(getPinetControlCommandFromText("/exit now please")).toBeNull();
    expect(getPinetControlCommandFromText("please /reload")).toBeNull();
  });

  it("builds structured control metadata and body", () => {
    expect(buildPinetControlMetadata("reload")).toEqual({
      type: "pinet:control",
      action: "reload",
    });
    expect(buildPinetControlMessage("reload")).toBe('{"type":"pinet:control","action":"reload"}');
    expect(buildPinetControlMessage("interrupt")).toBe(
      '{"type":"pinet:control","action":"interrupt"}',
    );
  });

  it("normalizes outgoing control messages to the structured envelope", () => {
    expect(normalizeOutgoingPinetControlMessage("/reload")).toEqual({
      body: '{"type":"pinet:control","action":"reload"}',
      metadata: { type: "pinet:control", action: "reload" },
    });
    expect(
      normalizeOutgoingPinetControlMessage('{"type":"pinet:control","action":"exit"}', {
        custom: true,
      }),
    ).toEqual({
      body: '{"type":"pinet:control","action":"exit"}',
      metadata: { custom: true, type: "pinet:control", action: "exit" },
    });
    expect(normalizeOutgoingPinetControlMessage("hello")).toBeNull();
  });

  it("extracts structured control commands from a2a metadata", () => {
    expect(
      extractPinetControlCommand({
        threadId: "a2a:sender:target",
        body: "hello",
        metadata: { a2a: true, type: "pinet:control", action: "reload" },
      }),
    ).toBe("reload");
  });

  it("keeps backward compatibility for legacy metadata and slash commands", () => {
    expect(
      extractPinetControlCommand({
        threadId: "a2a:sender:target",
        body: "hello",
        metadata: { a2a: true, kind: "pinet_control", command: "reload" },
      }),
    ).toBe("reload");
    expect(
      extractPinetControlCommand({
        threadId: "a2a:sender:target",
        body: "/exit",
        metadata: { a2a: true },
      }),
    ).toBe("exit");
  });

  it("extracts structured control commands from a2a JSON message bodies", () => {
    expect(
      extractPinetControlCommand({
        threadId: "a2a:sender:target",
        body: '{"type":"pinet:control","action":"reload"}',
        metadata: { a2a: true },
      }),
    ).toBe("reload");
    expect(
      extractPinetControlCommand({
        threadId: "a2a:sender:target",
        body: '{"type":"pinet:control","action":"noop"}',
        metadata: { a2a: true },
      }),
    ).toBeNull();
  });

  it("extracts interrupt controls from explicit Slack reaction metadata only", () => {
    expect(
      extractPinetControlCommand({
        threadId: "123.456",
        body: '{"type":"pinet:control","action":"interrupt"}',
        metadata: {
          type: "pinet:control",
          action: "interrupt",
          reactionName: "octagonal_sign",
          reactionAction: "interrupt",
          slackReactionControl: true,
        },
      }),
    ).toBe("interrupt");
    expect(
      extractPinetControlCommand({
        threadId: "123.456",
        body: '{"type":"pinet:control","action":"interrupt"}',
        metadata: {
          type: "pinet:control",
          action: "interrupt",
          reactionName: "rotating_light",
          reactionAction: "interrupt",
          slackReactionControl: true,
        },
      }),
    ).toBe("interrupt");
    expect(
      extractPinetControlCommand({
        threadId: "123.456",
        body: '{"type":"pinet:control","action":"exit"}',
        metadata: {
          type: "pinet:control",
          action: "exit",
          reactionName: "octagonal_sign",
          reactionAction: "interrupt",
          slackReactionControl: true,
        },
      }),
    ).toBeNull();
  });

  it("does not treat scheduled wake-up mail bodies as remote-control commands", () => {
    expect(
      extractPinetControlCommand({
        threadId: "wakeup:worker-1",
        body: "/exit",
        metadata: { scheduledWakeup: true, a2a: true, senderAgent: "Pinet Scheduler" },
      }),
    ).toBeNull();
    expect(
      extractPinetControlCommand({
        threadId: "wakeup:worker-1",
        body: '{"type":"pinet:control","action":"reload"}',
        metadata: { scheduledWakeup: true, a2a: true, type: "pinet:control", action: "reload" },
      }),
    ).toBeNull();
  });

  it("ignores control commands from non-a2a messages", () => {
    expect(
      extractPinetControlCommand({
        threadId: "123.456",
        body: '{"type":"pinet:control","action":"reload"}',
        metadata: { channel: "D123" },
      }),
    ).toBeNull();
    expect(
      extractPinetControlCommand({
        threadId: "123.456",
        body: "/reload",
        metadata: { channel: "D123" },
      }),
    ).toBeNull();
  });

  it("starts the first control command immediately and marks it safe to ack", () => {
    expect(
      queuePinetRemoteControl({ currentCommand: null, queuedCommand: null }, "reload"),
    ).toMatchObject({
      currentCommand: "reload",
      queuedCommand: null,
      accepted: true,
      shouldStartNow: true,
      status: "start",
      scheduledCommand: "reload",
      ackDisposition: "immediate",
    });
  });

  it("queues a retry reload while reload is already running", () => {
    expect(
      queuePinetRemoteControl({ currentCommand: "reload", queuedCommand: null }, "reload"),
    ).toMatchObject({
      currentCommand: "reload",
      queuedCommand: "reload",
      accepted: true,
      shouldStartNow: false,
      status: "queued",
      scheduledCommand: "reload",
      ackDisposition: "on_start",
    });
  });

  it("prefers a queued exit over a queued reload", () => {
    expect(
      queuePinetRemoteControl({ currentCommand: "reload", queuedCommand: "reload" }, "exit"),
    ).toMatchObject({
      currentCommand: "reload",
      queuedCommand: "exit",
      accepted: true,
      shouldStartNow: false,
      status: "queued",
      scheduledCommand: "exit",
      ackDisposition: "on_start",
    });
  });

  it("treats an interrupt as covered when a stronger command is already running", () => {
    expect(
      queuePinetRemoteControl({ currentCommand: "reload", queuedCommand: null }, "interrupt"),
    ).toMatchObject({
      currentCommand: "reload",
      queuedCommand: null,
      accepted: true,
      shouldStartNow: false,
      status: "covered",
      scheduledCommand: "reload",
      ackDisposition: "immediate",
    });
  });

  it("treats later commands as covered once exit is already running", () => {
    expect(
      queuePinetRemoteControl({ currentCommand: "exit", queuedCommand: null }, "reload"),
    ).toMatchObject({
      currentCommand: "exit",
      queuedCommand: null,
      accepted: true,
      shouldStartNow: false,
      status: "covered",
      scheduledCommand: "exit",
      ackDisposition: "immediate",
    });
  });

  it("marks duplicate queued commands as deferred until the queued command starts", () => {
    expect(
      queuePinetRemoteControl({ currentCommand: "reload", queuedCommand: "reload" }, "reload"),
    ).toMatchObject({
      currentCommand: "reload",
      queuedCommand: "reload",
      accepted: true,
      shouldStartNow: false,
      status: "covered",
      scheduledCommand: "reload",
      ackDisposition: "on_start",
    });
  });

  it("promotes the queued command when the active control finishes", () => {
    expect(finishPinetRemoteControl({ currentCommand: "reload", queuedCommand: "exit" })).toEqual({
      currentCommand: "exit",
      queuedCommand: null,
      nextCommand: "exit",
    });
  });
});

// ─── Safe reload orchestration ───────────────────────────

describe("reloadPinetRuntimeSafely", () => {
  it("restores the snapshot when validation fails after refresh mutates live state", async () => {
    let activeConfig = "previous";
    const restoreState = vi.fn((snapshot: string) => {
      activeConfig = snapshot;
    });
    const stopRuntime = vi.fn(async () => {
      throw new Error("should not stop");
    });

    await expect(
      reloadPinetRuntimeSafely({
        getCurrentRole: () => "broker",
        snapshotState: () => activeConfig,
        restoreState,
        refreshState: () => {
          activeConfig = "refreshed";
        },
        validateRefreshedState: () => {
          throw new Error("bad config");
        },
        stopRuntime,
        startRuntime: async () => {
          throw new Error("should not start");
        },
      }),
    ).rejects.toThrow("bad config");

    expect(activeConfig).toBe("previous");
    expect(restoreState).toHaveBeenCalledWith("previous");
    expect(stopRuntime).not.toHaveBeenCalled();
  });

  it("restores the previous runtime when the refreshed runtime fails to start", async () => {
    let activeConfig = "previous";
    const starts: string[] = [];

    await expect(
      reloadPinetRuntimeSafely({
        getCurrentRole: () => "follower",
        snapshotState: () => activeConfig,
        restoreState: (snapshot) => {
          activeConfig = snapshot;
        },
        refreshState: () => {
          activeConfig = "refreshed";
        },
        validateRefreshedState: () => {},
        stopRuntime: async () => {},
        startRuntime: async (role) => {
          starts.push(`${role}:${activeConfig}`);
          if (activeConfig === "refreshed") {
            throw new Error("refreshed start failed");
          }
        },
      }),
    ).rejects.toThrow("Reload failed: refreshed start failed. Restored the previous runtime.");

    expect(starts).toEqual(["follower:refreshed", "follower:previous"]);
    expect(activeConfig).toBe("previous");
  });
});
// ─── SQLite journal mode helpers ─────────────────────────

describe("SQLite journal mode helpers", () => {
  it("parses the reported journal mode", () => {
    expect(getSqliteJournalMode({ journal_mode: "wal" })).toBe("wal");
    expect(getSqliteJournalMode({ journal_mode: "DELETE" })).toBe("delete");
    expect(getSqliteJournalMode({ journal_mode: null })).toBe("unknown");
    expect(getSqliteJournalMode(undefined)).toBe("unknown");
  });

  it("detects whether WAL is enabled", () => {
    expect(isSqliteWalEnabled({ journal_mode: "wal" })).toBe(true);
    expect(isSqliteWalEnabled({ journal_mode: "delete" })).toBe(false);
    expect(isSqliteWalEnabled(undefined)).toBe(false);
  });

  it("builds a helpful fallback warning", () => {
    expect(buildSqliteWalFallbackWarning("BrokerDB", { journal_mode: "delete" })).toBe(
      "[BrokerDB] SQLite WAL mode not available, using delete journal mode fallback",
    );
    expect(buildSqliteWalFallbackWarning("SqliteCommentStore", undefined)).toContain(
      "using unknown journal mode fallback",
    );
  });
});

// ─── buildSlackRequest ────────────────────────────────────

describe("buildSlackRequest", () => {
  it("uses JSON for write methods", () => {
    const { url, init } = buildSlackRequest("chat.postMessage", "xoxb-tok", {
      channel: "C1",
      text: "hi",
    });
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect((init.headers as Record<string, string>)["Content-Type"]).toContain("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ channel: "C1", text: "hi" });
  });

  it("uses form encoding for read methods", () => {
    const { url, init } = buildSlackRequest("conversations.history", "xoxb-tok", {
      channel: "C1",
      limit: 10,
    });
    expect(url).toBe("https://slack.com/api/conversations.history");
    expect((init.headers as Record<string, string>)["Content-Type"]).toContain(
      "application/x-www-form-urlencoded",
    );
    expect(init.body).toContain("channel=C1");
    expect(init.body).toContain("limit=10");
  });

  it("uses form encoding for Slack external file upload methods", () => {
    const uploadUrlRequest = buildSlackRequest("files.getUploadURLExternal", "xoxb-tok", {
      filename: "changes.diff",
      length: 42,
      snippet_type: "diff",
    });

    expect((uploadUrlRequest.init.headers as Record<string, string>)["Content-Type"]).toContain(
      "application/x-www-form-urlencoded",
    );
    expect(uploadUrlRequest.init.body).toContain("filename=changes.diff");
    expect(uploadUrlRequest.init.body).toContain("length=42");
    expect(uploadUrlRequest.init.body).toContain("snippet_type=diff");

    const completeUploadRequest = buildSlackRequest("files.completeUploadExternal", "xoxb-tok", {
      files: [{ id: "F123", title: "Latest diff" }],
      channel_id: "C123",
      thread_ts: "171234.5678",
    });

    expect(
      (completeUploadRequest.init.headers as Record<string, string>)["Content-Type"],
    ).toContain("application/x-www-form-urlencoded");
    expect(completeUploadRequest.init.body).toContain("channel_id=C123");
    expect(completeUploadRequest.init.body).toContain("thread_ts=171234.5678");
    const formBody = new URLSearchParams(String(completeUploadRequest.init.body));
    expect(formBody.get("files")).toBe('[{"id":"F123","title":"Latest diff"}]');
  });

  it("includes auth header", () => {
    const { init } = buildSlackRequest("auth.test", "xoxb-secret");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer xoxb-secret");
  });

  it("handles no body", () => {
    const { init } = buildSlackRequest("auth.test", "xoxb-tok");
    expect(init.body).toBeUndefined();
  });

  it("all FORM_METHODS use form encoding", () => {
    for (const method of FORM_METHODS) {
      const { init } = buildSlackRequest(method, "xoxb-tok", { key: "val" });
      expect((init.headers as Record<string, string>)["Content-Type"]).toContain(
        "application/x-www-form-urlencoded",
      );
    }
  });
});

// ─── abort / shutdown helpers ───────────────────────────

describe("abortableDelay", () => {
  it("rejects with AbortError when the signal is aborted", async () => {
    const controller = new AbortController();
    const pending = abortableDelay(1_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("createAbortableOperationTracker", () => {
  it("aborts pending operations and waits for them to settle", async () => {
    const tracker = createAbortableOperationTracker();
    const pending = tracker.run(async (signal) => {
      await abortableDelay(60_000, signal);
    });

    await tracker.abortAndWait();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(tracker.isAborting()).toBe(true);
  });

  it("rejects new operations after shutdown begins", async () => {
    const tracker = createAbortableOperationTracker();
    await tracker.abortAndWait();

    await expect(tracker.run(async () => Promise.resolve())).rejects.toThrow(
      "shutdown in progress",
    );
  });
});

// ─── stripBotMention ──────────────────────────────────────

describe("stripBotMention", () => {
  it("strips a single mention", () => {
    expect(stripBotMention("<@U_BOT> hello there", "U_BOT")).toBe("hello there");
  });

  it("strips multiple mentions", () => {
    expect(stripBotMention("<@U_BOT> hey <@U_BOT> again", "U_BOT")).toBe("hey again");
  });

  it("leaves text alone when no mention", () => {
    expect(stripBotMention("just text", "U_BOT")).toBe("just text");
  });

  it("handles mention at end", () => {
    expect(stripBotMention("hey <@U_BOT>", "U_BOT")).toBe("hey");
  });

  it("does not strip other users", () => {
    expect(stripBotMention("<@U_OTHER> hello", "U_BOT")).toBe("<@U_OTHER> hello");
  });
});

// ─── isChannelId ──────────────────────────────────────────

describe("isChannelId", () => {
  it("recognizes C-prefix channel IDs", () => {
    expect(isChannelId("C0APL58LB1R")).toBe(true);
  });

  it("recognizes G-prefix group IDs", () => {
    expect(isChannelId("G012ABCDE")).toBe(true);
  });

  it("recognizes D-prefix DM IDs", () => {
    expect(isChannelId("D0APMDC3GNR")).toBe(true);
  });

  it("rejects channel names", () => {
    expect(isChannelId("general")).toBe(false);
    expect(isChannelId("#general")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isChannelId("")).toBe(false);
  });
});

// ─── shortenPath ──────────────────────────────────────────

describe("shortenPath", () => {
  it("replaces homedir prefix with ~", () => {
    expect(shortenPath("/Users/alice/src/project", "/Users/alice")).toBe("~/src/project");
  });

  it("leaves path unchanged when homedir does not match", () => {
    expect(shortenPath("/opt/data/project", "/Users/alice")).toBe("/opt/data/project");
  });

  it("handles exact homedir match", () => {
    expect(shortenPath("/Users/alice", "/Users/alice")).toBe("~");
  });

  it("does not match partial directory names", () => {
    expect(shortenPath("/Users/alicewonder/src", "/Users/alice")).toBe("/Users/alicewonder/src");
  });
});

describe("Pinet skin helpers", () => {
  it("builds the default whimsical skin deterministically", () => {
    const assignment = buildPinetSkinAssignment({
      theme: "default",
      role: "worker",
      seed: "worker-a",
    });

    expect(assignment.theme).toBe("default");
    expect(assignment.name.split(" ")).toHaveLength(3);
    expect(assignment.emoji).toBeTruthy();
    expect(assignment.personality).toContain("Default whimsical worker skin");
  });

  it("uses the broker naming format for the default whimsical broker skin", () => {
    const worker = buildPinetSkinAssignment({
      theme: "default",
      role: "worker",
      seed: "shared-seed",
    });
    const broker = buildPinetSkinAssignment({
      theme: "default",
      role: "broker",
      seed: "shared-seed",
    });

    expect(broker.theme).toBe("default");
    expect(broker.name).toBe(`The Broker ${worker.name.split(" ").at(-1)}`);
    expect(broker.emoji).toBe(worker.emoji);
    expect(broker.personality).toContain("Default whimsical broker skin");
    expect(broker.statusVocabulary).toBeUndefined();
  });

  it("builds the foundation skin from curated role-specific characters and status vocabulary", () => {
    const broker = buildPinetSkinAssignment({
      theme: "foundation/space",
      role: "broker",
      seed: "broker-a",
    });
    const worker = buildPinetSkinAssignment({
      theme: "foundation/space",
      role: "worker",
      seed: "worker-a",
    });

    expect(broker.theme).toBe("foundation");
    expect(worker.theme).toBe("foundation");
    expect(broker.name).toMatch(
      /(Archive|Civic|Relay|Frontier|Vector|Prime|Concord|Vault|Signal|Ledger|Mandate|Chair|Coordinator|Keeper|Warden|Marshal|Regent|Speaker)/,
    );
    expect(worker.name).toMatch(
      /(Archive|Civic|Relay|Frontier|Vector|Concord|Vault|Signal|Ledger|Beacon|Orbit|Accord|Catalog|Gate|Evidence|Scout|Runner|Worker|Clerk|Hand)/,
    );
    expect(broker.name).not.toMatch(
      /^(Archive|Civic|Relay|Frontier|Vector|Prime|Concord|Vault) (Director|Warden|Speaker|Marshal|Archivist|Provost|Steward|Prime|Coordinator|Gatekeeper|Crisis Chair|Relay Chief|Concord Lead|Vault Keeper|Mission Clerk|Signal Regent) \w+$/,
    );
    expect(worker.name).not.toMatch(
      /^(Prime|Vault|Relay|Frontier|Crisis|Archive|Vector|Civic|Concord|Gate|Ledger|Beacon|Orbit|Accord|Catalog|Signal|Reserve|Horizon|Twelvefold|Long-Range) \w+ (Analyst|Envoy|Relay|Surveyor|Ratifier|Indexer|Archivist|Scout|Observer|Clerk|Mapper|Operator|Witness|Courier|Auditor|Signalist|Custodian|Field Scribe|Verifier|Pathfinder)$/,
    );
    expect(broker.name).not.toMatch(/Broker \w+$/);
    expect(worker.name).not.toMatch(/Badger|Otter|Crocodile|Beaver/);
    expect(["🏛️", "🛰️", "⚖️", "🗄️", "🧭", "📜", "🌌", "🔭", "📡", "📶", "📚", "🛡️"]).toContain(
      broker.emoji,
    );
    expect([
      "📡",
      "📚",
      "🔭",
      "🗂️",
      "🧭",
      "⚖️",
      "🛰️",
      "📍",
      "🏛️",
      "🌌",
      "📒",
      "🏙️",
      "🚨",
      "🔆",
      "🪐",
      "🤝",
      "🗃️",
      "📻",
      "🏕️",
      "🚪",
      "🔐",
      "📶",
      "➡️",
      "🕊️",
    ]).toContain(worker.emoji);
    expect(broker.personality).toContain("Presentation only");
    expect(worker.personality).toContain("Presentation only");
    expect(worker.statusVocabulary).toMatchObject({
      idle: "standing by",
      working: "on relay",
      ghost: "off grid",
    });
  });

  it("builds the Oathgate/Cosmere-inspired skin from curated fantasy-metal characters", () => {
    const broker = buildPinetSkinAssignment({
      theme: "oathgate",
      role: "broker",
      seed: "broker-a",
    });
    const worker = buildPinetSkinAssignment({
      theme: "cosmere-inspired",
      role: "worker",
      seed: "worker-a",
    });

    expect(broker.theme).toBe("cosmere");
    expect(worker.theme).toBe("cosmere");
    expect(broker.name).toMatch(
      /(Oath|Gate|Storm|Alloy|Ash|Mist|Forge|Copper|Silver|Bronze|Shard|Warden|Regent|Arbiter|Keeper|Oathspeaker|Spren)/,
    );
    expect(worker.name.split(" ").length).toBeLessThanOrEqual(3);
    expect(broker.name).not.toMatch(
      /^(Oathgate|Stormbound|Alloy|Ashen|Lantern|Bronze|Silver|Mistward) (Warden|Cartographer|Binder|Marshal|Keeper|Oathspeaker|Gatewright|Stormcaller|Forge Chair|Lampbearer|Alloy Regent|Ash Sentinel|Vow Steward|Mist Herald|Bronze Arbiter|Silver Captain) \w+$/,
    );
    expect(worker.name).not.toMatch(
      /^(Iron|Steel|Tin|Pewter|Bronze|Copper|Zinc|Brass|Ash|Mist|Storm|Forge|Gate|Oath|Lantern|Silver|Ember|Vow|Alloy|Glass) \w+ (Scribe|Runner|Scout|Forger|Hand|Keeper|Pathfinder|Witness|Quill|Marker|Blade|Lamplighter|Ledger|Smith|Ward|Binder|Seeker|Courier|Emberwright|Gatehand)$/,
    );
    expect(broker.name).not.toMatch(/Broker \w+$/);
    expect(worker.name).not.toMatch(/Badger|Otter|Crocodile|Beaver/);
    expect(broker.emoji).toBeTruthy();
    expect(worker.emoji).toBeTruthy();
    expect(broker.personality).toContain("Presentation only");
    expect(worker.personality).toContain("Presentation only");
    expect(worker.statusVocabulary).toMatchObject({
      idle: "holding oath",
      working: "invested",
      healthy: "stormlight bright",
    });
  });

  it("provides a large authored Cosmere identity pool without formulaic triples", () => {
    const oathgateWorkers = new Set<string>();

    for (let index = 0; index < 300; index += 1) {
      const assignment = buildPinetSkinAssignment({
        theme: "oathgate",
        role: "worker",
        seed: `worker-${index}`,
      });
      oathgateWorkers.add(assignment.name);
      expect(assignment.name.split(" ").length).toBeLessThanOrEqual(3);
      expect(assignment.name).not.toMatch(
        /^(Iron|Steel|Tin|Pewter|Bronze|Copper|Zinc|Brass|Ash|Mist|Storm|Forge|Gate|Oath|Lantern|Silver|Ember|Vow|Alloy|Glass) \w+ (Scribe|Runner|Scout|Forger|Hand|Keeper|Pathfinder|Witness|Quill|Marker|Blade|Lamplighter|Ledger|Smith|Ward|Binder|Seeker|Courier|Emberwright|Gatehand)$/,
      );
    }

    expect(oathgateWorkers.size).toBeGreaterThan(100);
  });

  it("builds a custom free-form skin with role-aware identity and bounded voice guidance", () => {
    const broker = buildPinetSkinAssignment({
      theme: "night's watch from ASOIAF",
      role: "broker",
      seed: "broker-a",
    });
    const worker = buildPinetSkinAssignment({
      theme: "night's watch from ASOIAF",
      role: "worker",
      seed: "worker-a",
    });

    expect(broker.theme).toBe("night's watch from ASOIAF");
    expect(broker.name).toMatch(/^The .+ of .+$/);
    expect(broker.name).not.toMatch(/Broker \w+$/);
    expect(broker.name).not.toBe(worker.name);
    expect(broker.personality).toContain("night's watch from ASOIAF");
    expect(worker.personality).toContain("night's watch from ASOIAF");
    expect(broker.personality).not.toBe(worker.personality);
    expect(broker.personality).toMatch(/mission control|guard role lines|blur roles/);
    expect(worker.personality).toMatch(/surface blockers|status visible|execution exact/);
    expect(broker.personality.match(/\./g)?.length ?? 0).toBeLessThanOrEqual(3);
    expect(worker.personality.match(/\./g)?.length ?? 0).toBeLessThanOrEqual(3);
    expect(broker.personality.length).toBeLessThanOrEqual(260);
    expect(worker.personality.length).toBeLessThanOrEqual(260);
  });

  it("makes contrasting custom themes sound materially different with the same seed", () => {
    const cyberpunk = buildPinetSkinAssignment({
      theme: "cyberpunk hackers",
      role: "worker",
      seed: "worker-a",
    });
    const missionControl = buildPinetSkinAssignment({
      theme: "apollo mission control",
      role: "worker",
      seed: "worker-a",
    });

    expect(cyberpunk.personality).not.toBe(missionControl.personality);
    expect(cyberpunk.personality).toContain("cyberpunk hackers");
    expect(missionControl.personality).toContain("apollo mission control");
    expect(cyberpunk.personality).toMatch(/terminal|neon|operator|technical/);
    expect(missionControl.personality).toMatch(/mission-control|telemetry|checklist|status-board/);
  });

  it("caps personality and prompt guideline length for long free-form themes", () => {
    const longTheme = `${'night\'s watch from "ASOIAF" + cyberpunk hackers + apollo mission control + deep sea salvage + '.repeat(4)}studio ghibli spirits`;
    const assignment = buildPinetSkinAssignment({
      theme: longTheme,
      role: "broker",
      seed: "broker-a",
    });
    const guideline = buildPinetSkinPromptGuideline(longTheme, assignment.personality);

    expect(assignment.personality.length).toBeLessThanOrEqual(260);
    expect(guideline).not.toBeNull();
    expect(guideline!.length).toBeLessThanOrEqual(460);
    expect(guideline).toContain("PINET SKIN (");
    expect(guideline).toContain("role boundaries");
  });

  it("syncBrokerInboxEntries separates direct broker control from regular inbox messages", () => {
    const result = syncBrokerInboxEntries([
      {
        inboxId: 11,
        message: {
          threadId: "a2a:sender:broker",
          sender: "sender-agent",
          body: "/reload",
          createdAt: "2026-04-01T00:00:00.000Z",
          metadata: { a2a: true, kind: "pinet_control", command: "reload" },
        },
      },
      {
        inboxId: 13,
        message: {
          threadId: "a2a:sender:broker",
          sender: "sender-agent",
          body: "plain broker report",
          createdAt: "2026-04-01T00:00:02.000Z",
          metadata: { a2a: true, senderAgent: "sender-agent" },
        },
      },
    ]);

    expect(result.controlEntries).toEqual([{ inboxId: 11, command: "reload" }]);

    expect(result.inboxMessages).toEqual([
      {
        channel: "",
        threadTs: "a2a:sender:broker",
        userId: "sender-agent",
        text: "plain broker report",
        timestamp: "2026-04-01T00:00:02.000Z",
        brokerInboxId: 13,
        metadata: { a2a: true, senderAgent: "sender-agent" },
      },
    ]);
  });

  it("builds a prompt guideline for active skin personalities", () => {
    const guideline = buildPinetSkinPromptGuideline(
      "the fellowship of the ring",
      "Sound like a warm but capable questing specialist.",
    );

    expect(guideline).toContain("the fellowship of the ring");
    expect(guideline).toContain("Keep it additive");
    expect(guideline).toContain("accuracy");
    expect(guideline).toContain("role boundaries");
    expect(guideline!.length).toBeLessThanOrEqual(460);
    expect(buildPinetSkinPromptGuideline(null, "persona")).toBeNull();
  });
});

// ─── buildBrokerProtocolGuardrailsPrompt ──────────────────────────────

describe("buildBrokerProtocolGuardrailsPrompt", () => {
  it("keeps only runtime-backed broker protocol restrictions hard-coded", () => {
    const prompt = buildBrokerProtocolGuardrailsPrompt();

    expect(prompt).toContain("BROKER PROTOCOL BOUNDARY");
    expect(prompt).toContain("Broker prompt MD can replace broker coordination policy");
    expect(prompt).toContain("Agent tool");
    expect(prompt).toContain("edit");
    expect(prompt).toContain("write");
    expect(prompt).toContain("runtime");
    expect(prompt).toContain("diagnostics must never echo private prompt file contents");
    expect(prompt).not.toContain("PRIORITIZED ISSUE GATE");
    expect(prompt).not.toContain("RALPH LOOP");
    expect(prompt).not.toContain("REPO-SCOPED DELEGATION");
  });
});

// ─── buildIdentityReplyGuidelines ─────────────────────────────

describe("buildWorkerPromptGuidelines", () => {
  it("includes Pinet delegation guidance for connected workers", () => {
    const guidelines = buildWorkerPromptGuidelines();
    const joined = guidelines.join(" ");
    expect(joined).toContain("HELPER / DELEGATION RULES");
    expect(joined).toContain("pinet action=agents");
    expect(joined).toContain("pinet action=send");
  });

  it("tells workers to prefer local subagents before connected-worker delegation", () => {
    const guidelines = buildWorkerPromptGuidelines();
    const joined = guidelines.join(" ");
    expect(joined).toContain("prefer configured local subagents/code-reviewer first");
    expect(joined).toContain("Do NOT bounce review ownership");
    expect(joined).toContain("no suitable local subagent is available");
  });

  it("requires delegated work to report status back through the thread", () => {
    const guidelines = buildWorkerPromptGuidelines();
    const joined = guidelines.join(" ");
    expect(joined).toContain("ACKs, blockers, status updates, and final results");
    expect(joined).toContain("ack/work/ask/report");
  });

  it("mirrors repo-scoped and prioritized-issue delegation rules for workers", () => {
    const guidelines = buildWorkerPromptGuidelines();
    const joined = guidelines.join(" ");
    expect(joined).toContain("pinet action=agents` with the target repo");
    expect(joined).toContain("same repo/worktree");
    expect(joined).toContain("maintainer priority/approval");
    expect(joined).toContain("maintainer approval");
    expect(joined).toContain("PM mode");
    expect(joined).toContain("pinet action=lanes");
    expect(joined).not.toContain("@gugu91");
  });

  it("tells workers to explicitly mark themselves idle/free when work is done", () => {
    const guidelines = buildWorkerPromptGuidelines();
    const joined = guidelines.join(" ");
    expect(joined).toContain("pinet action=free");
    expect(joined).toContain("/pinet free");
    expect(joined).toContain("idle/free");
  });

  it("tells workers not to acknowledge terminal broker stand-downs", () => {
    const guidelines = buildWorkerPromptGuidelines();
    const joined = guidelines.join(" ");
    expect(joined).toContain("no further replies are needed");
    expect(joined).toContain("hard stop");
    expect(joined).toContain("Do NOT send another acknowledgement");
    expect(joined).toContain("genuinely new task");
  });
});

// ─── buildIdentityReplyGuidelines ─────────────────────────────

describe("buildIdentityReplyGuidelines", () => {
  it("builds strict first-post and follow-up identity guidance", () => {
    const [first, followUp, bareRule] = buildIdentityReplyGuidelines(
      "🦅",
      "Sonic Eagle",
      "~/repo@my-host",
    );

    expect(first).toBe(
      "First message in a new thread: use exact format — '🦅 `Sonic Eagle` reporting from `~/repo@my-host`\\n\\n<message body>'",
    );
    expect(followUp).toBe(
      "Follow-up messages in the same thread: keep the same full identity prefix — '🦅 `Sonic Eagle` <message>'",
    );
    expect(bareRule).toContain("emoji-only");
  });
});

// ─── buildAgentPersonalityGuidelines / resolveAgentPersonality ─────────────

describe("resolveAgentPersonality", () => {
  it("blends adjective and animal traits for Rocket Dolphin", () => {
    expect(resolveAgentPersonality("Rocket Dolphin").traits).toEqual(
      expect.arrayContaining(["fast", "playful", "intelligent"]),
    );
  });

  it("handles quiet, patient, precise personalities like Silent Crocodile", () => {
    expect(resolveAgentPersonality("Silent Crocodile").traits).toEqual(
      expect.arrayContaining(["quiet", "patient", "precise"]),
    );
  });

  it("uses first and last words so generated color names still resolve", () => {
    expect(resolveAgentPersonality("Cosmic Azure Crane").traits).toEqual(
      expect.arrayContaining(["far-seeing", "thoughtful", "elegant"]),
    );
  });
});

describe("buildAgentPersonalityGuidelines", () => {
  it("turns the resolved traits into communication-only prompt guidance", () => {
    const joined = buildAgentPersonalityGuidelines("Silent Crocodile").join(" ");
    expect(joined).toContain("quiet");
    expect(joined).toContain("patient");
    expect(joined).toContain("precise");
    expect(joined).toContain("must NOT change task execution quality");
  });
});

// ─── buildAgentStableId ───────────────────────────────────

describe("buildAgentStableId", () => {
  it("prefers session file when available", () => {
    expect(buildAgentStableId("/tmp/pi/session.json", "macbook", "/repo", "leaf-1")).toBe(
      `macbook:session:${path.resolve("/tmp/pi/session.json")}`,
    );
  });

  it("falls back to leaf id when session file is missing", () => {
    expect(buildAgentStableId(undefined, "macbook", "/repo", "leaf-1")).toBe("macbook:leaf:leaf-1");
  });

  it("falls back to cwd when neither session file nor leaf id is available", () => {
    expect(buildAgentStableId(undefined, "macbook", "/repo")).toBe(
      `macbook:cwd:${path.resolve("/repo")}`,
    );
  });
});

describe("resolveAgentStableId", () => {
  it("prefers the persisted stable id across reloads", () => {
    expect(
      resolveAgentStableId(
        "persisted:agent:123",
        "/tmp/pi/changed-session.json",
        "macbook",
        "/repo",
        "leaf-2",
      ),
    ).toBe("persisted:agent:123");
  });

  it("falls back to buildAgentStableId when no persisted stable id exists", () => {
    expect(resolveAgentStableId(undefined, "/tmp/pi/session.json", "macbook", "/repo")).toBe(
      `macbook:session:${path.resolve("/tmp/pi/session.json")}`,
    );
  });
});

describe("buildBrokerStableId", () => {
  it("anchors broker stable ids to the repo checkout instead of the session file", () => {
    expect(buildBrokerStableId("macbook", "/repo")).toBe(`macbook:broker:${path.resolve("/repo")}`);
  });
});

describe("resolveBrokerStableId", () => {
  it("prefers the persisted broker stable id across reloads and restarts", () => {
    expect(resolveBrokerStableId("persisted:broker:123", "macbook", "/repo")).toBe(
      "persisted:broker:123",
    );
  });

  it("falls back to the repo-anchored broker stable id when none is persisted", () => {
    expect(resolveBrokerStableId(undefined, "macbook", "/repo")).toBe(
      `macbook:broker:${path.resolve("/repo")}`,
    );
  });
});

describe("isLikelyLocalSubagentContext", () => {
  it("does not treat parentSession lineage alone as a local subagent", () => {
    expect(
      isLikelyLocalSubagentContext({
        sessionHeader: { parentSession: "/tmp/pi/parent-session.jsonl" },
        argv: [],
        sessionFile: "/tmp/pi/continued-session.jsonl",
        leafId: "leaf-1",
        hasUI: true,
        stdinIsTTY: true,
        stdoutIsTTY: true,
      }),
    ).toBe(false);
  });

  it("does not classify normal continued sessions with parentSession lineage as subagents", () => {
    expect(
      isLikelyLocalSubagentContext({
        sessionHeader: { parentSession: "/tmp/pi/parent-session.jsonl" },
        argv: ["--continue"],
        sessionFile: "/tmp/pi/continued-session.jsonl",
        leafId: "leaf-continued",
        hasUI: true,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    ).toBe(false);
  });

  it("detects parented headless sessions as local subagents", () => {
    expect(
      isLikelyLocalSubagentContext({
        sessionHeader: { parentSession: "/tmp/pi/parent-session.jsonl" },
        argv: ["--mode", "rpc"],
        sessionFile: "/tmp/pi/subagent-session.jsonl",
        leafId: "leaf-subagent",
        hasUI: false,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    ).toBe(true);
  });

  it("still detects continued parented sessions when they are headless", () => {
    expect(
      isLikelyLocalSubagentContext({
        sessionHeader: { parentSession: "/tmp/pi/parent-session.jsonl" },
        argv: ["--continue"],
        sessionFile: "/tmp/pi/subagent-session.jsonl",
        leafId: "leaf-subagent",
        hasUI: false,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    ).toBe(true);

    expect(
      isLikelyLocalSubagentContext({
        sessionHeader: { parentSession: "/tmp/pi/parent-session.jsonl" },
        argv: ["--continue", "--mode", "rpc"],
        sessionFile: "/tmp/pi/subagent-session.jsonl",
        leafId: "leaf-subagent",
        hasUI: true,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    ).toBe(true);
  });

  it("detects headless no-session subagents from argv fallback", () => {
    expect(isLikelyLocalSubagentContext({ argv: ["--mode", "json", "-p", "--no-session"] })).toBe(
      true,
    );
    expect(isLikelyLocalSubagentContext({ argv: ["--mode", "rpc", "--no-session"] })).toBe(true);
  });

  it("does not classify regular interactive sessions as subagents", () => {
    expect(isLikelyLocalSubagentContext({ argv: [] })).toBe(false);
    expect(
      isLikelyLocalSubagentContext({ argv: ["--continue"], sessionHeader: { parentSession: "" } }),
    ).toBe(false);
  });

  it("detects ephemeral leaf sessions that run headless without a session file", () => {
    expect(
      isLikelyLocalSubagentContext({
        sessionFile: undefined,
        leafId: "leaf-123",
        argv: ["--mode", "rpc"],
        hasUI: true,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    ).toBe(true);

    expect(
      isLikelyLocalSubagentContext({
        sessionFile: undefined,
        leafId: "leaf-123",
        argv: [],
        hasUI: true,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    ).toBe(true);
  });

  it("does not classify interactive no-session leaf sessions as subagents", () => {
    expect(
      isLikelyLocalSubagentContext({
        sessionFile: undefined,
        leafId: "leaf-123",
        argv: ["--no-session"],
        hasUI: true,
        stdinIsTTY: true,
        stdoutIsTTY: true,
      }),
    ).toBe(false);
  });

  it("does not classify plain no-session interactive use as a subagent", () => {
    expect(isLikelyLocalSubagentContext({ argv: ["--no-session"] })).toBe(false);
  });
});

// ─── formatAgentList ──────────────────────────────────────

describe("formatAgentList", () => {
  const homedir = "/Users/alice";

  it("returns placeholder when no agents", () => {
    expect(formatAgentList([], homedir)).toBe("(no agents connected)");
  });

  it("formats a single agent with full metadata", () => {
    const agents: AgentDisplayInfo[] = [
      {
        emoji: "\u{1F9A6}",
        name: "Stellar Otter",
        id: "broker-97446",
        status: "working",
        metadata: { cwd: "/Users/alice/src/extensions", branch: "main", host: "macbook" },
      },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).toBe(
      "\u{1F9A6} Stellar Otter (broker-97446) \u2014 working\n   ~/src/extensions (main) @ macbook",
    );
  });

  it("includes pid when present", () => {
    const agents: AgentDisplayInfo[] = [
      {
        emoji: "\u{1F916}",
        name: "Bot",
        id: "abc",
        pid: 12345,
        status: "idle",
        metadata: null,
      },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).toBe("\u{1F916} Bot (abc) \u2014 idle pid:12345");
  });

  it("includes skin and persona summaries when present", () => {
    const agents: AgentDisplayInfo[] = [
      {
        emoji: "🕶️",
        name: "Chrome Hacker Cipher",
        id: "worker-1",
        status: "idle",
        metadata: {
          skinTheme: "cyberpunk hackers",
          personality: "Lean into the vibe of cyberpunk hackers with concise, stylish updates.",
        },
      },
    ];

    const result = formatAgentList(agents, homedir);
    expect(result).toContain("skin: cyberpunk hackers");
    expect(result).toContain("persona: Lean into the vibe of cyberpunk hackers");
  });

  it("omits pid when not present", () => {
    const agents: AgentDisplayInfo[] = [
      { emoji: "\u{1F916}", name: "Bot", id: "abc", status: "idle", metadata: null },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).not.toContain("pid:");
  });

  it("formats multiple agents", () => {
    const agents: AgentDisplayInfo[] = [
      {
        emoji: "\u{1F9A6}",
        name: "Stellar Otter",
        id: "broker-97446",
        status: "working",
        metadata: { cwd: "/Users/alice/src/extensions", branch: "main", host: "macbook" },
      },
      {
        emoji: "\u{1F43A}",
        name: "Crystal Wolf",
        id: "6e3e51ca",
        status: "idle",
        metadata: {
          cwd: "/Users/alice/src/extensions",
          branch: "feat/broker-reconnect",
          host: "macbook",
        },
      },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).toContain("\u{1F9A6} Stellar Otter (broker-97446) \u2014 working");
    expect(result).toContain("~/src/extensions (main) @ macbook");
    expect(result).toContain("\u{1F43A} Crystal Wolf (6e3e51ca) \u2014 idle");
    expect(result).toContain("~/src/extensions (feat/broker-reconnect) @ macbook");
  });

  it("handles agent with null metadata", () => {
    const agents: AgentDisplayInfo[] = [
      { emoji: "\u{1F916}", name: "Bot", id: "abc", status: "idle", metadata: null },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).toBe("\u{1F916} Bot (abc) \u2014 idle");
    expect(result).not.toContain("\n");
  });

  it("handles agent with empty metadata", () => {
    const agents: AgentDisplayInfo[] = [
      { emoji: "\u{1F916}", name: "Bot", id: "abc", status: "working", metadata: {} },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).toBe("\u{1F916} Bot (abc) \u2014 working");
  });

  it("handles partial metadata (only cwd)", () => {
    const agents: AgentDisplayInfo[] = [
      {
        emoji: "\u{1F916}",
        name: "Bot",
        id: "abc",
        status: "idle",
        metadata: { cwd: "/opt/project" },
      },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).toContain("/opt/project");
    expect(result).not.toContain("@");
  });

  it("shortens cwd using homedir", () => {
    const agents: AgentDisplayInfo[] = [
      {
        emoji: "\u{1F916}",
        name: "Bot",
        id: "abc",
        status: "idle",
        metadata: { cwd: "/Users/alice/work", branch: "dev", host: "srv" },
      },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).toContain("~/work (dev) @ srv");
  });

  it("keeps core status neutral while adding optional skin status vocabulary", () => {
    const agent = buildAgentDisplayInfo(
      {
        emoji: "🏛️",
        name: "The Director of Archive",
        id: "agent-1",
        status: "idle",
        lastHeartbeat: "2026-01-01T00:00:00.000Z",
        metadata: {
          skinTheme: "foundation",
          skinStatusVocabulary: {
            idle: "standing by",
            ghost: "off grid",
          },
        },
      },
      {
        now: Date.parse("2026-01-01T00:00:20.000Z"),
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    const result = formatAgentList([agent], homedir);
    expect(result).toContain(
      "The Director of Archive (agent-1) — idle (standing by) [ghost: off grid]",
    );
    expect(result).toContain("skin: foundation");
  });

  it("keeps default skin status display neutral even if old metadata carries vocabulary", () => {
    const agent = buildAgentDisplayInfo(
      {
        emoji: "🦫",
        name: "Prism Bronze Beaver",
        id: "agent-1",
        status: "idle",
        lastHeartbeat: "2026-01-01T00:00:00.000Z",
        metadata: {
          skinTheme: "default",
          skinStatusVocabulary: {
            idle: "standing by",
            ghost: "off grid",
          },
        },
      },
      {
        now: Date.parse("2026-01-01T00:00:20.000Z"),
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    const result = formatAgentList([agent], homedir);
    expect(result).toContain("Prism Bronze Beaver (agent-1) — idle [ghost]");
    expect(result).not.toContain("standing by");
    expect(result).not.toContain("off grid");
  });

  it("formats health, lease, and capability tags", () => {
    const agent = buildAgentDisplayInfo(
      {
        emoji: "🤖",
        name: "Visible Bot",
        id: "agent-1",
        status: "idle",
        lastHeartbeat: "2026-01-01T00:00:08.000Z",
        metadata: {
          cwd: "/Users/alice/src/extensions",
          branch: "main",
          host: "macbook",
          capabilities: {
            repo: "extensions",
            branch: "main",
            role: "worker",
            tools: ["test", "lint"],
          },
        },
      },
      {
        now: Date.parse("2026-01-01T00:00:20.000Z"),
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    const result = formatAgentList([agent], homedir);
    expect(result).toContain("Visible Bot (agent-1) — idle [stale]");
    expect(result).toContain("heartbeat 12s ago · lease in 3s");
    expect(result).toContain(
      "caps: role:worker, repo:extensions, branch:main, tool:test, tool:lint",
    );
  });
});

describe("buildAgentDisplayInfo", () => {
  it("passes pid through to display info", () => {
    const agent = buildAgentDisplayInfo(
      { emoji: "\u{1F916}", name: "Bot", id: "a1", pid: 42, status: "idle" },
      { now: Date.now() },
    );
    expect(agent.pid).toBe(42);
  });

  it("omits pid when not provided", () => {
    const agent = buildAgentDisplayInfo(
      { emoji: "\u{1F916}", name: "Bot", id: "a1", status: "idle" },
      { now: Date.now() },
    );
    expect(agent.pid).toBeUndefined();
  });

  it("marks a disconnected agent with resumable lease as resumable", () => {
    const agent = buildAgentDisplayInfo(
      {
        emoji: "🤖",
        name: "Resume Bot",
        id: "agent-2",
        status: "idle",
        lastHeartbeat: "2026-01-01T00:00:00.000Z",
        disconnectedAt: "2026-01-01T00:00:10.000Z",
        resumableUntil: "2026-01-01T00:00:25.000Z",
        metadata: { role: "worker" },
      },
      { now: Date.parse("2026-01-01T00:00:20.000Z") },
    );

    expect(agent.health).toBe("resumable");
    expect(agent.ghost).toBe(false);
    expect(agent.leaseSummary).toBe("lease in 5s");
  });

  it("marks expired agents as ghosts", () => {
    const agent = buildAgentDisplayInfo(
      {
        emoji: "👻",
        name: "Ghost Bot",
        id: "ghost-1",
        status: "idle",
        lastHeartbeat: "2026-01-01T00:00:00.000Z",
        metadata: { role: "worker" },
      },
      {
        now: Date.parse("2026-01-01T00:00:20.000Z"),
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    expect(agent.health).toBe("ghost");
    expect(agent.ghost).toBe(true);
    expect(agent.leaseSummary).toBe("lease expired 5s ago");
  });

  it("downgrades connected agents with stale heartbeats to stale when lastSeen is still fresh", () => {
    const agent = buildAgentDisplayInfo(
      {
        emoji: "🛰️",
        name: "Seen Bot",
        id: "seen-1",
        status: "idle",
        lastHeartbeat: "2026-01-01T00:00:00.000Z",
        lastSeen: "2026-01-01T00:00:18.000Z",
        metadata: { role: "worker" },
      },
      {
        now: Date.parse("2026-01-01T00:00:20.000Z"),
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    expect(agent.health).toBe("stale");
    expect(agent.ghost).toBe(false);
  });
});

describe("mesh visibility helpers", () => {
  it("keeps connected agents and only recently disconnected ghosts in the visible mesh", () => {
    const now = Date.parse("2026-01-01T00:01:00.000Z");
    const agents = [
      { id: "connected", disconnectedAt: null },
      { id: "recent-ghost", disconnectedAt: "2026-01-01T00:00:40.000Z" },
      { id: "stale-ghost", disconnectedAt: "2026-01-01T00:00:20.000Z" },
    ];

    expect(
      filterAgentsForMeshVisibility(agents, {
        now,
        includeGhosts: true,
        recentDisconnectWindowMs: 30_000,
      }).map((agent) => agent.id),
    ).toEqual(["connected", "recent-ghost"]);
  });

  it("can exclude ghost rows entirely when a surface wants connected agents only", () => {
    const now = Date.parse("2026-01-01T00:01:00.000Z");

    expect(
      isAgentVisibleInMesh(
        { disconnectedAt: "2026-01-01T00:00:50.000Z" },
        {
          now,
          includeGhosts: false,
          recentDisconnectWindowMs: 30_000,
        },
      ),
    ).toBe(false);
  });
});

describe("rankAgentsForRouting", () => {
  it("prefers healthy idle agents that match repo, branch, role, and tools", () => {
    const agents = [
      buildAgentDisplayInfo(
        {
          emoji: "🤖",
          name: "Best Bot",
          id: "best",
          status: "idle",
          lastHeartbeat: "2026-01-01T00:00:18.000Z",
          metadata: {
            repo: "extensions",
            branch: "main",
            role: "worker",
            capabilities: {
              repo: "extensions",
              branch: "main",
              role: "worker",
              tools: ["test", "lint"],
            },
          },
        },
        { now: Date.parse("2026-01-01T00:00:20.000Z") },
      ),
      buildAgentDisplayInfo(
        {
          emoji: "🛠️",
          name: "Busy Bot",
          id: "busy",
          status: "working",
          lastHeartbeat: "2026-01-01T00:00:19.000Z",
          metadata: {
            repo: "extensions",
            branch: "main",
            role: "worker",
            capabilities: {
              repo: "extensions",
              branch: "main",
              role: "worker",
              tools: ["lint"],
            },
          },
        },
        { now: Date.parse("2026-01-01T00:00:20.000Z") },
      ),
      buildAgentDisplayInfo(
        {
          emoji: "👻",
          name: "Ghost Bot",
          id: "ghost",
          status: "idle",
          lastHeartbeat: "2026-01-01T00:00:00.000Z",
          metadata: {
            repo: "extensions",
            branch: "main",
            role: "worker",
            capabilities: {
              repo: "extensions",
              branch: "main",
              role: "worker",
              tools: ["test", "lint"],
            },
          },
        },
        {
          now: Date.parse("2026-01-01T00:00:20.000Z"),
          heartbeatTimeoutMs: 15_000,
          heartbeatIntervalMs: 5_000,
        },
      ),
    ];

    const ranked = rankAgentsForRouting(agents, {
      repo: "extensions",
      branch: "main",
      role: "worker",
      requiredTools: ["test"],
      task: "run tests on extensions main",
    });

    expect(ranked[0]?.id).toBe("best");
    expect(ranked[ranked.length - 1]?.id).toBe("ghost");
    expect(ranked[0]?.routingReasons).toContain("repo:extensions");
    expect(ranked[0]?.routingReasons).toContain("tools:1/1");
  });
});

// ─── Ralph loop helpers ────────────────────────────────

describe("RALPH loop defaults", () => {
  it("runs the broker maintenance loop every five minutes by default", () => {
    expect(DEFAULT_RALPH_LOOP_INTERVAL_MS).toBe(5 * 60_000);
  });

  it("accepts a configured broker maintenance loop interval", () => {
    expect(resolveRalphLoopIntervalMs({ ralphLoopIntervalMs: 120_000 })).toBe(120_000);
  });

  it("falls back to the default for invalid configured intervals", () => {
    expect(resolveRalphLoopIntervalMs({ ralphLoopIntervalMs: 0 })).toBe(
      DEFAULT_RALPH_LOOP_INTERVAL_MS,
    );
    expect(resolveRalphLoopIntervalMs({ ralphLoopIntervalMs: Number.NaN })).toBe(
      DEFAULT_RALPH_LOOP_INTERVAL_MS,
    );
    expect(
      resolveRalphLoopIntervalMs({ ralphLoopIntervalMs: MAX_RALPH_LOOP_INTERVAL_MS + 1 }),
    ).toBe(DEFAULT_RALPH_LOOP_INTERVAL_MS);
  });
});

describe("evaluateRalphLoopCycle", () => {
  it("flags ghost agents, nudges idle agents with work, and reports self-repair anomalies", () => {
    const result = evaluateRalphLoopCycle(
      [
        {
          emoji: "🦎",
          name: "Idle Gecko",
          id: "idle-worker",
          status: "idle",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:00:00.000Z",
          pendingInboxCount: 2,
          ownedThreadCount: 1,
        },
        {
          emoji: "🦉",
          name: "Ready Owl",
          id: "ready-worker",
          status: "idle",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:01:20.000Z",
          lastHeartbeat: "2026-04-01T00:01:55.000Z",
          pendingInboxCount: 0,
          ownedThreadCount: 0,
        },
        {
          emoji: "👻",
          name: "Ghost Fox",
          id: "ghost-worker",
          status: "idle",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:00:00.000Z",
          lastHeartbeat: "2026-04-01T00:00:00.000Z",
          disconnectedAt: "2026-04-01T00:00:10.000Z",
          pendingInboxCount: 0,
          ownedThreadCount: 1,
        },
      ],
      {
        now: Date.parse("2026-04-01T00:02:00.000Z"),
        idleWithWorkThresholdMs: 60_000,
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
        pendingBacklogCount: 3,
        currentBranch: "feat/not-main",
        brokerHeartbeatActive: false,
        brokerMaintenanceActive: false,
      },
    );

    expect(result.ghostAgentIds).toEqual(["ghost-worker"]);
    expect(result.nudgeAgentIds).toEqual(["idle-worker"]);
    expect(result.idleDrainAgentIds).toEqual(["ready-worker"]);
    expect(result.anomalies).toContain("Idle Gecko idle with assigned work (2 inbox, 1 threads)");
    expect(result.anomalies).toContain("ghost agents detected: ghost-worker");
    expect(result.anomalies).toContain("pending backlog (3) with 1 idle worker");
    expect(result.anomalies).toContain("broker heartbeat timer is not running");
    expect(result.anomalies).toContain("broker maintenance timer is not running");
    expect(result.anomalies.some((item) => item.includes("expected `main`"))).toBe(true);
  });

  it("does not flag connected agents as ghosts when only the heartbeat is stale but lastSeen is fresh", () => {
    const result = evaluateRalphLoopCycle(
      [
        {
          emoji: "🛰️",
          name: "Seen Fox",
          id: "seen-worker",
          status: "idle",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:01:52.000Z",
          lastHeartbeat: "2026-04-01T00:01:40.000Z",
          pendingInboxCount: 0,
          ownedThreadCount: 0,
        },
      ],
      {
        now: Date.parse("2026-04-01T00:02:00.000Z"),
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    expect(result.ghostAgentIds).toEqual([]);
    expect(result.anomalies).toEqual([]);
  });

  it("skips the broker agent id when flagging idle agents with assigned work", () => {
    const result = evaluateRalphLoopCycle(
      [
        {
          emoji: "🦙",
          name: "Broker Llama",
          id: "broker-self",
          status: "idle",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:00:00.000Z",
          lastHeartbeat: "2026-04-01T00:01:55.000Z",
          pendingInboxCount: 4,
          ownedThreadCount: 2,
        },
        {
          emoji: "🦊",
          name: "Busy Fox",
          id: "worker-1",
          status: "idle",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:00:00.000Z",
          pendingInboxCount: 1,
          ownedThreadCount: 1,
        },
      ],
      {
        now: Date.parse("2026-04-01T00:02:00.000Z"),
        idleWithWorkThresholdMs: 60_000,
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
        brokerAgentId: "broker-self",
      },
    );

    expect(result.nudgeAgentIds).toEqual(["worker-1"]);
    expect(
      result.anomalies.some((item) => item.includes("Broker Llama idle with assigned work")),
    ).toBe(false);
    expect(result.anomalies).toContain("Busy Fox idle with assigned work (1 inbox, 1 threads)");
  });

  it("does not nudge healthy idle workers with assigned work when heartbeats are fresh", () => {
    const result = evaluateRalphLoopCycle(
      [
        {
          emoji: "🦫",
          name: "Quiet Beaver",
          id: "quiet-idle",
          status: "idle",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:00:00.000Z",
          lastHeartbeat: "2026-04-01T00:01:55.000Z",
          pendingInboxCount: 1,
          ownedThreadCount: 1,
        },
      ],
      {
        now: Date.parse("2026-04-01T00:02:00.000Z"),
        idleWithWorkThresholdMs: 60_000,
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    expect(result.nudgeAgentIds).toEqual([]);
    expect(result.anomalies).toEqual([]);
  });

  it("detects stuck agents when quiet activity crosses the threshold under queue pressure", () => {
    const now = Date.parse("2026-04-01T00:10:00.000Z");
    const result = evaluateRalphLoopCycle(
      [
        {
          emoji: "🐺",
          name: "Stuck Wolf",
          id: "stuck-worker",
          status: "working",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:09:55.000Z",
          lastHeartbeat: "2026-04-01T00:09:55.000Z",
          lastActivity: "2026-04-01T00:03:00.000Z", // 7 min ago
          pendingInboxCount: 1,
          ownedThreadCount: 1,
        },
        {
          emoji: "🦊",
          name: "Active Fox",
          id: "active-worker",
          status: "working",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:09:55.000Z",
          lastHeartbeat: "2026-04-01T00:09:55.000Z",
          lastActivity: "2026-04-01T00:09:30.000Z", // 30s ago
          pendingInboxCount: 1,
          ownedThreadCount: 0,
        },
      ],
      {
        now,
        stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    expect(result.stuckAgentIds).toEqual(["stuck-worker"]);
    expect(result.anomalies).toContain(
      "Stuck Wolf appears stuck (working with no activity beyond 5m threshold)",
    );
    // Active Fox should NOT be flagged as stuck
    expect(result.stuckAgentIds).not.toContain("active-worker");
  });

  it("does not flag healthy quiet workers as stuck when there is no queue pressure", () => {
    const result = evaluateRalphLoopCycle(
      [
        {
          emoji: "🐗",
          name: "Quiet Boar",
          id: "quiet-worker",
          status: "working",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:09:55.000Z",
          lastHeartbeat: "2026-04-01T00:09:55.000Z",
          lastActivity: "2026-04-01T00:03:00.000Z", // 7 min ago
          pendingInboxCount: 0,
          ownedThreadCount: 1,
        },
      ],
      {
        now: Date.parse("2026-04-01T00:10:00.000Z"),
        stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
        pendingBacklogCount: 0,
      },
    );

    expect(result.stuckAgentIds).toEqual([]);
    expect(result.anomalies).toEqual([]);
  });

  it("does not treat unrelated global backlog as pressure on a quiet claimed worker", () => {
    const result = evaluateRalphLoopCycle(
      [
        {
          emoji: "🐗",
          name: "Quiet Boar",
          id: "quiet-worker",
          status: "working",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:09:55.000Z",
          lastHeartbeat: "2026-04-01T00:09:55.000Z",
          lastActivity: "2026-04-01T00:03:00.000Z",
          pendingInboxCount: 0,
          ownedThreadCount: 1,
        },
        {
          emoji: "🦉",
          name: "Ready Owl",
          id: "ready-worker",
          status: "idle",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:09:55.000Z",
          lastHeartbeat: "2026-04-01T00:09:55.000Z",
          pendingInboxCount: 0,
          ownedThreadCount: 0,
        },
      ],
      {
        now: Date.parse("2026-04-01T00:10:00.000Z"),
        stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
        pendingBacklogCount: 2,
      },
    );

    expect(result.stuckAgentIds).toEqual([]);
    expect(result.idleDrainAgentIds).toEqual(["ready-worker"]);
    expect(result.anomalies).toContain("pending backlog (2) with 1 idle worker");
    expect(result.anomalies).not.toContain(
      "Quiet Boar appears stuck (working with no activity beyond 5m threshold)",
    );
  });

  it("keeps the stuck anomaly text stable across repeated quiet-pressure cycles", () => {
    const cycle1 = evaluateRalphLoopCycle(
      [
        {
          emoji: "🐺",
          name: "Stuck Wolf",
          id: "stuck-worker",
          status: "working",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:09:55.000Z",
          lastHeartbeat: "2026-04-01T00:09:55.000Z",
          lastActivity: "2026-04-01T00:03:00.000Z",
          pendingInboxCount: 1,
          ownedThreadCount: 1,
        },
      ],
      {
        now: Date.parse("2026-04-01T00:10:00.000Z"),
        stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );
    const cycle2 = evaluateRalphLoopCycle(
      [
        {
          emoji: "🐺",
          name: "Stuck Wolf",
          id: "stuck-worker",
          status: "working",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:10:55.000Z",
          lastHeartbeat: "2026-04-01T00:10:55.000Z",
          lastActivity: "2026-04-01T00:03:00.000Z",
          pendingInboxCount: 1,
          ownedThreadCount: 1,
        },
      ],
      {
        now: Date.parse("2026-04-01T00:11:00.000Z"),
        stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    expect(cycle1.anomalies).toEqual(cycle2.anomalies);
  });

  it("does not flag idle agents as stuck", () => {
    const result = evaluateRalphLoopCycle(
      [
        {
          emoji: "🦉",
          name: "Idle Owl",
          id: "idle-1",
          status: "idle",
          metadata: { role: "worker" },
          lastHeartbeat: "2026-04-01T00:09:55.000Z",
          lastActivity: "2026-04-01T00:01:00.000Z",
          pendingInboxCount: 0,
          ownedThreadCount: 0,
        },
      ],
      {
        now: Date.parse("2026-04-01T00:10:00.000Z"),
        stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    expect(result.stuckAgentIds).toEqual([]);
  });

  it("does not flag working agent without lastActivity as stuck", () => {
    const result = evaluateRalphLoopCycle(
      [
        {
          emoji: "🐼",
          name: "New Panda",
          id: "new-1",
          status: "working",
          metadata: { role: "worker" },
          lastHeartbeat: "2026-04-01T00:09:55.000Z",
          // no lastActivity — agent just started, hasn't reported activity yet
          pendingInboxCount: 1,
          ownedThreadCount: 0,
        },
      ],
      {
        now: Date.parse("2026-04-01T00:10:00.000Z"),
        stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    expect(result.stuckAgentIds).toEqual([]);
  });

  it("includes stuckAgentIds in result even when empty", () => {
    const result = evaluateRalphLoopCycle([], {
      now: Date.now(),
      heartbeatTimeoutMs: 15_000,
      heartbeatIntervalMs: 5_000,
    });
    expect(result.stuckAgentIds).toEqual([]);
  });
});

describe("rewriteRalphLoopGhostAnomalies", () => {
  const buildEvaluation = (ghostAgentIds: string[], anomalies: string[]) => ({
    ghostAgentIds,
    nudgeAgentIds: [],
    idleDrainAgentIds: [],
    stuckAgentIds: [],
    anomalies,
  });

  it("only surfaces ghost deltas while keeping non-ghost anomalies stable across cycles", () => {
    const cycle1 = rewriteRalphLoopGhostAnomalies(
      buildEvaluation(["ghost-1"], ["ghost agents detected: ghost-1"]),
    );
    expect(cycle1.evaluation.anomalies).toEqual(["NEW ghost agents detected: ghost-1"]);
    expect(cycle1.nextReportedGhostIds).toEqual(["ghost-1"]);

    const cycle2 = rewriteRalphLoopGhostAnomalies(
      buildEvaluation(["ghost-1"], ["ghost agents detected: ghost-1"]),
      cycle1.nextReportedGhostIds,
    );
    expect(cycle2.evaluation.anomalies).toEqual([]);
    expect(buildRalphLoopAnomalySignature(cycle2.evaluation)).toBe("");

    const cycle3 = rewriteRalphLoopGhostAnomalies(
      buildEvaluation(
        ["ghost-1"],
        ["ghost agents detected: ghost-1", "pending backlog (3) with 1 idle worker"],
      ),
      cycle2.nextReportedGhostIds,
    );
    expect(cycle3.evaluation.anomalies).toEqual(["pending backlog (3) with 1 idle worker"]);
    expect(cycle3.nonGhostAnomalies).toEqual(["pending backlog (3) with 1 idle worker"]);

    const cycle4 = rewriteRalphLoopGhostAnomalies(
      buildEvaluation([], []),
      cycle3.nextReportedGhostIds,
    );
    expect(cycle4.evaluation.anomalies).toEqual(["ghost agents cleared from registry: ghost-1"]);
    expect(cycle4.clearedGhostIds).toEqual(["ghost-1"]);
  });

  it("suppresses freshly reaped ghost ids until they survive a later cycle", () => {
    const cycle1 = rewriteRalphLoopGhostAnomalies(
      buildEvaluation(["ghost-1", "ghost-2"], ["ghost agents detected: ghost-1, ghost-2"]),
      [],
      { suppressedGhostIds: ["ghost-1"] },
    );

    expect(cycle1.evaluation.ghostAgentIds).toEqual(["ghost-2"]);
    expect(cycle1.evaluation.anomalies).toEqual(["NEW ghost agents detected: ghost-2"]);
    expect(cycle1.nextReportedGhostIds).toEqual(["ghost-2"]);

    const cycle2 = rewriteRalphLoopGhostAnomalies(
      buildEvaluation(["ghost-1", "ghost-2"], ["ghost agents detected: ghost-1, ghost-2"]),
      cycle1.nextReportedGhostIds,
    );

    expect(cycle2.evaluation.ghostAgentIds).toEqual(["ghost-1", "ghost-2"]);
    expect(cycle2.evaluation.anomalies).toEqual(["NEW ghost agents detected: ghost-1"]);
    expect(cycle2.nextReportedGhostIds).toEqual(["ghost-1", "ghost-2"]);
  });

  it("does not clear or re-announce a previously reported ghost when it is temporarily suppressed", () => {
    const cycle = rewriteRalphLoopGhostAnomalies(
      buildEvaluation(["ghost-1"], ["ghost agents detected: ghost-1"]),
      ["ghost-1"],
      { suppressedGhostIds: ["ghost-1"] },
    );

    expect(cycle.evaluation.ghostAgentIds).toEqual([]);
    expect(cycle.evaluation.anomalies).toEqual([]);
    expect(cycle.clearedGhostIds).toEqual([]);
    expect(cycle.nextReportedGhostIds).toEqual(["ghost-1"]);
  });
});

describe("buildRalphLoopNudgeMessage", () => {
  it("formats pending inbox and claimed thread counts", () => {
    expect(buildRalphLoopNudgeMessage(2, 1)).toContain("2 inbox items and 1 claimed thread");
  });

  it("includes the cycle timestamp when provided", () => {
    expect(buildRalphLoopNudgeMessage(2, 1, "2026-04-02T14:10:00.000Z")).toContain(
      "RALPH LOOP nudge (2026-04-02T14:10:00.000Z):",
    );
  });
});

describe("buildRalphLoopAnomalySignature", () => {
  it("joins anomalies into a stable dedupe signature", () => {
    expect(
      buildRalphLoopAnomalySignature({
        ghostAgentIds: ["ghost-1"],
        nudgeAgentIds: ["idle-1"],
        idleDrainAgentIds: ["ready-1"],
        stuckAgentIds: [],
        anomalies: [
          "ghost agents detected: ghost-1",
          "Idle Gecko idle with assigned work (2 inbox, 1 threads)",
        ],
      }),
    ).toBe(
      "ghost agents detected: ghost-1|Idle Gecko idle with assigned work (2 inbox, 1 threads)",
    );
  });
});

describe("shouldDeliverRalphLoopFollowUp", () => {
  it("delivers new actionable findings", () => {
    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "ghost agents detected: ghost-1",
      }),
    ).toBe(true);
  });

  it("does not resend the same signature again after cooldown without new evidence", () => {
    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "ghost agents detected: ghost-1",
        lastDeliveredSignature: "ghost agents detected: ghost-1",
        lastDeliveredAt: 10_000,
        now: 10_000 + DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS,
      }),
    ).toBe(false);
  });

  it("allows a changed signature after cooldown", () => {
    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "ghost agents detected: ghost-2",
        lastDeliveredSignature: "ghost agents detected: ghost-1",
        lastDeliveredAt: 10_000,
        now: 10_000 + DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS,
      }),
    ).toBe(true);
  });

  it("does not send while a Ralph prompt is already pending", () => {
    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "ghost agents detected: ghost-1",
        pending: true,
      }),
    ).toBe(false);
  });

  it("does not send while the broker is busy", () => {
    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "ghost agents detected: ghost-1",
        idle: false,
      }),
    ).toBe(false);
  });

  it("throttles repeated Ralph follow-ups during cooldown", () => {
    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "ghost agents detected: ghost-1",
        lastDeliveredSignature: "ghost agents detected: ghost-0",
        lastDeliveredAt: 10_000,
        now: 10_000 + DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS - 1,
      }),
    ).toBe(false);
  });

  it("keeps cooldown active across a transient clean cycle", () => {
    const deliveredAt = 10_000;

    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "",
        lastDeliveredAt: deliveredAt,
        now: deliveredAt + 15_000,
      }),
    ).toBe(false);

    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "ghost agents detected: ghost-1",
        lastDeliveredSignature: "ghost agents detected: ghost-1",
        lastDeliveredAt: deliveredAt,
        now: deliveredAt + DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS - 1,
      }),
    ).toBe(false);
  });
});

describe("buildRalphLoopStatusMessage", () => {
  it("formats inline Ralph notifications with the captured cycle timestamp", () => {
    expect(
      buildRalphLoopStatusMessage(
        "ghost agents detected: ghost-1; Idle Gecko idle with assigned work",
        "2026-04-02T14:10:00.000Z",
      ),
    ).toBe(
      "RALPH loop (2026-04-02T14:10:00.000Z): ghost agents detected: ghost-1; Idle Gecko idle with assigned work",
    );
  });
});

describe("buildRalphLoopCycleNotifications", () => {
  it("threads the captured cycle timestamp through follow-up and inline status output", () => {
    expect(
      buildRalphLoopCycleNotifications(
        {
          ghostAgentIds: ["ghost-1"],
          nudgeAgentIds: ["idle-1"],
          idleDrainAgentIds: ["ready-1"],
          stuckAgentIds: [],
          anomalies: [
            "ghost agents detected: ghost-1",
            "Idle Gecko idle with assigned work (2 inbox, 1 threads)",
          ],
        },
        "2026-04-02T14:10:00.000Z",
      ),
    ).toEqual({
      followUpPrompt: [
        "RALPH LOOP CYCLE:",
        "Timestamp: 2026-04-02T14:10:00.000Z",
        "- ghost agents detected: ghost-1",
        "- Idle Gecko idle with assigned work (2 inbox, 1 threads)",
        "",
        "Take action: reap ghosts, nudge idle workers, reassign stalled work, drain backlog, maintain momentum, and repair broker anomalies.",
      ].join("\n"),
      anomalyStatus:
        "RALPH loop (2026-04-02T14:10:00.000Z): ghost agents detected: ghost-1; Idle Gecko idle with assigned work (2 inbox, 1 threads)",
      recoveryStatus: "RALPH loop (2026-04-02T14:10:00.000Z): health recovered",
    });
  });
});

describe("buildRalphLoopFollowUpMessage", () => {
  it("formats actionable anomalies into a broker follow-up prompt", () => {
    expect(
      buildRalphLoopFollowUpMessage(
        {
          ghostAgentIds: ["ghost-1"],
          nudgeAgentIds: ["idle-1"],
          idleDrainAgentIds: ["ready-1"],
          stuckAgentIds: [],
          anomalies: [
            "ghost agents detected: ghost-1",
            "Idle Gecko idle with assigned work (2 inbox, 1 threads)",
            "main checkout is on `feat/not-main`, expected `main`",
          ],
        },
        "2026-04-02T14:10:00.000Z",
      ),
    ).toBe(
      [
        "RALPH LOOP CYCLE:",
        "Timestamp: 2026-04-02T14:10:00.000Z",
        "- ghost agents detected: ghost-1",
        "- Idle Gecko idle with assigned work (2 inbox, 1 threads)",
        "- main checkout is on `feat/not-main`, expected `main`",
        "",
        "Take action: reap ghosts, nudge idle workers, reassign stalled work, drain backlog, maintain momentum, and repair broker anomalies.",
      ].join("\n"),
    );
  });

  it("returns null when there is nothing actionable", () => {
    expect(
      buildRalphLoopFollowUpMessage(
        {
          ghostAgentIds: [],
          nudgeAgentIds: [],
          idleDrainAgentIds: [],
          stuckAgentIds: [],
          anomalies: [],
        },
        "2026-04-02T14:10:00.000Z",
      ),
    ).toBeNull();
  });
});

// ─── resolvePersistedAgentIdentity / resolveAgentIdentity ───────────────────────────

describe("resolvePersistedAgentIdentity", () => {
  it("prefers persisted identity from session state", () => {
    const result = resolvePersistedAgentIdentity(
      { agentName: "Config Bot", agentEmoji: "🤖" },
      "Restored Gecko",
      "🦎",
      "env-nick",
    );
    expect(result).toEqual({ name: "Restored Gecko", emoji: "🦎" });
  });

  it("falls back to generated/config identity when persisted identity is incomplete", () => {
    const result = resolvePersistedAgentIdentity(
      { agentName: "Config Bot", agentEmoji: "🤖" },
      "Half",
      undefined,
    );
    expect(result).toEqual({ name: "Config Bot", emoji: "🤖" });
  });
});

describe("resolveAgentIdentity", () => {
  it("returns settings name/emoji when both are configured", () => {
    const result = resolveAgentIdentity({ agentName: "Config Bot", agentEmoji: "🤖" });
    expect(result).toEqual({ name: "Config Bot", emoji: "🤖" });
  });

  it("settings take priority over env nickname", () => {
    const result = resolveAgentIdentity({ agentName: "Config Bot", agentEmoji: "🤖" }, "env-nick");
    expect(result).toEqual({ name: "Config Bot", emoji: "🤖" });
  });

  it("derives the same generated identity for the same seed", () => {
    const first = resolveAgentIdentity({}, undefined, "/tmp/pi/session-a.json");
    const second = resolveAgentIdentity({}, undefined, "/tmp/pi/session-a.json");
    expect(first).toEqual(second);
  });

  it("derives different generated identities for different seeds", () => {
    const first = resolveAgentIdentity({}, undefined, "/tmp/pi/session-a.json");
    const second = resolveAgentIdentity({}, undefined, "/tmp/pi/session-b.json");
    expect(second.name).not.toBe(first.name);
  });

  it("falls back to env var PI_NICKNAME with deterministic emoji when seeded", () => {
    const first = resolveAgentIdentity({}, "my-agent", "/tmp/pi/session-a.json");
    const second = resolveAgentIdentity({}, "my-agent", "/tmp/pi/session-a.json");
    expect(first.name).toBe("my-agent");
    expect(first.emoji).toBe(second.emoji);
  });

  it("generates a worker name when nothing else is available", () => {
    const result = resolveAgentIdentity({});
    expect(typeof result.name).toBe("string");
    expect(result.name.length).toBeGreaterThan(0);
    expect(result.name).toMatch(/^\w+ \w+ \w+$/); // "Adjective Color Animal"
    expect(typeof result.emoji).toBe("string");
  });

  it("generates a broker name when requested", () => {
    const result = resolveAgentIdentity({}, undefined, "/tmp/pi/session-a.json", "broker");
    expect(result.name).toMatch(/^The Broker \w+$/);
    expect(typeof result.emoji).toBe("string");
  });

  it("keeps the same animal and emoji across worker and broker generated names", () => {
    const worker = generateAgentName("/tmp/pi/session-a.json");
    const broker = generateAgentName("/tmp/pi/session-a.json", "broker");
    expect(broker.name).toBe(`The Broker ${worker.name.split(" ").at(-1)}`);
    expect(broker.emoji).toBe(worker.emoji);
  });

  it("ignores settings when only agentName is set (no emoji)", () => {
    const result = resolveAgentIdentity(
      { agentName: "Half Config" },
      undefined,
      "/tmp/pi/session-a.json",
    );
    // Should fall through to generated name since agentEmoji is missing
    expect(result.name).not.toBe("Half Config");
  });

  it("ignores settings when only agentEmoji is set (no name)", () => {
    const result = resolveAgentIdentity({ agentEmoji: "🤖" }, undefined, "/tmp/pi/session-a.json");
    // Should fall through to generated name since agentName is missing
    expect(result.emoji).not.toBe("🤖");
  });
});

describe("alignAgentIdentityToRole", () => {
  it("switches generated identities to the broker format", () => {
    const seed = "/tmp/pi/session-a.json";
    const workerIdentity = resolveAgentIdentity({}, undefined, seed, "worker");

    expect(alignAgentIdentityToRole(workerIdentity, {}, undefined, seed, "broker")).toEqual(
      resolveAgentIdentity({}, undefined, seed, "broker"),
    );
  });

  it("preserves custom renamed identities when the role changes", () => {
    const currentIdentity = { name: "Custom Bot", emoji: "🤖" };

    expect(
      alignAgentIdentityToRole(currentIdentity, {}, undefined, "/tmp/pi/session-a.json", "broker"),
    ).toEqual(currentIdentity);
  });
});

describe("resolveRuntimeAgentIdentity", () => {
  it("preserves custom runtime names when no explicit config overrides exist", () => {
    const currentIdentity = { name: "Custom Bot", emoji: "🤖" };

    expect(
      resolveRuntimeAgentIdentity(
        currentIdentity,
        {},
        undefined,
        "/tmp/pi/session-a.json",
        "broker",
      ),
    ).toEqual(currentIdentity);
  });

  it("still honors explicit configured identities", () => {
    expect(
      resolveRuntimeAgentIdentity(
        { name: "Custom Bot", emoji: "🤖" },
        { agentName: "Config Bot", agentEmoji: "🛠️" },
        undefined,
        "/tmp/pi/session-a.json",
        "broker",
      ),
    ).toEqual({ name: "Config Bot", emoji: "🛠️" });
  });
});

// ─── trackBrokerInboundThread ─────────────────────────────

describe("trackBrokerInboundThread", () => {
  it("adds a new thread to the map for a channel mention", () => {
    const threads = new Map<string, FollowerThreadState>();
    trackBrokerInboundThread(
      threads,
      {
        threadId: "1234.5678",
        channel: "C0APL58LB1R",
        userId: "U_ALICE",
        source: "imessage",
      },
      "TestAgent",
    );
    expect(threads.get("1234.5678")).toEqual({
      channelId: "C0APL58LB1R",
      threadTs: "1234.5678",
      userId: "U_ALICE",
      source: "imessage",
      owner: "TestAgent",
    });
  });

  it("does not overwrite an existing thread entry", () => {
    const threads = new Map<string, FollowerThreadState>([
      [
        "1234.5678",
        { channelId: "C0APL58LB1R", threadTs: "1234.5678", userId: "U_ORIGINAL", owner: "First" },
      ],
    ]);
    trackBrokerInboundThread(
      threads,
      { threadId: "1234.5678", channel: "C_OTHER", userId: "U_NEW" },
      "Second",
    );
    expect(threads.get("1234.5678")?.userId).toBe("U_ORIGINAL");
    expect(threads.get("1234.5678")?.owner).toBe("First");
  });

  it("backfills source onto an existing cached thread without replacing ownership", () => {
    const threads = new Map<string, FollowerThreadState>([
      [
        "1234.5678",
        { channelId: "C0APL58LB1R", threadTs: "1234.5678", userId: "U_ORIGINAL", owner: "First" },
      ],
    ]);

    trackBrokerInboundThread(
      threads,
      { threadId: "1234.5678", channel: "C0APL58LB1R", userId: "U_NEW", source: "imessage" },
      "Second",
    );

    expect(threads.get("1234.5678")).toEqual({
      channelId: "C0APL58LB1R",
      threadTs: "1234.5678",
      userId: "U_ORIGINAL",
      source: "imessage",
      owner: "First",
    });
  });

  it("is a no-op when threadId is empty", () => {
    const threads = new Map<string, FollowerThreadState>();
    trackBrokerInboundThread(threads, { threadId: "", channel: "C123", userId: "U1" });
    expect(threads.size).toBe(0);
  });

  it("is a no-op when channel is empty", () => {
    const threads = new Map<string, FollowerThreadState>();
    trackBrokerInboundThread(threads, { threadId: "1.1", channel: "", userId: "U1" });
    expect(threads.size).toBe(0);
  });

  it("defaults userId to empty string when undefined", () => {
    const threads = new Map<string, FollowerThreadState>();
    trackBrokerInboundThread(threads, { threadId: "1.1", channel: "C1" });
    expect(threads.get("1.1")?.userId).toBe("");
  });
});

// ─── isDirectMessageChannel ───────────────────────────────

describe("isDirectMessageChannel", () => {
  it("recognizes DM channel IDs", () => {
    expect(isDirectMessageChannel("D0APMDC3GNR")).toBe(true);
  });

  it("rejects public channel IDs", () => {
    expect(isDirectMessageChannel("C0APL58LB1R")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isDirectMessageChannel("")).toBe(false);
  });
});

// ─── syncFollowerInboxEntries ─────────────────────────────

describe("syncFollowerInboxEntries", () => {
  it("produces thread updates and inbox messages", () => {
    const threads = new Map<string, FollowerThreadState>();
    const result = syncFollowerInboxEntries(
      [
        {
          inboxId: 17,
          message: {
            threadId: "100.1",
            source: "whatsapp",
            sender: "U_SENDER",
            body: "hello",
            createdAt: "100.1",
            metadata: { channel: "C_CHAN" },
          },
        },
      ],
      threads,
      "MyAgent",
      null,
    );
    expect(result.inboxMessages).toHaveLength(1);
    expect(result.inboxMessages[0].channel).toBe("C_CHAN");
    expect(result.inboxMessages[0].brokerInboxId).toBe(17);
    expect(result.threadUpdates).toHaveLength(1);
    expect(result.threadUpdates[0].channelId).toBe("C_CHAN");
    expect(result.threadUpdates[0].source).toBe("whatsapp");
    expect(result.changed).toBe(true);
  });

  it("updates lastDmChannel for DM messages", () => {
    const threads = new Map<string, FollowerThreadState>();
    const result = syncFollowerInboxEntries(
      [
        {
          message: {
            threadId: "200.1",
            sender: "U1",
            body: "dm",
            createdAt: "200.1",
            metadata: { channel: "D0ABC123" },
          },
        },
      ],
      threads,
      "Agent",
      null,
    );
    expect(result.lastDmChannel).toBe("D0ABC123");
  });

  it("returns changed=false when thread already exists with same data", () => {
    const threads = new Map<string, FollowerThreadState>([
      ["300.1", { channelId: "C1", threadTs: "300.1", userId: "U1", owner: "Agent" }],
    ]);
    const result = syncFollowerInboxEntries(
      [
        {
          message: {
            threadId: "300.1",
            sender: "U1",
            body: "repeat",
            createdAt: "300.1",
            metadata: { channel: "C1" },
          },
        },
      ],
      threads,
      "Agent",
      null,
    );
    expect(result.changed).toBe(false);
  });

  it("preserves structured metadata and restores first-class scope on synced inbox messages", () => {
    const threads = new Map<string, FollowerThreadState>();
    const scope = buildSlackCompatibilityScope({ teamId: "T_ACTION", channelId: "C_ACTION" });
    const result = syncFollowerInboxEntries(
      [
        {
          inboxId: 29,
          message: {
            threadId: "400.1",
            sender: "U_ACTION",
            body: 'Clicked Slack "Approve" (action_id: review.approve).',
            createdAt: "400.2",
            metadata: {
              channel: "C_ACTION",
              kind: "slack_block_action",
              actionId: "review.approve",
              scope,
            },
          },
        },
      ],
      threads,
      "Agent",
      null,
    );

    expect(result.inboxMessages[0]).toMatchObject({
      channel: "C_ACTION",
      brokerInboxId: 29,
      scope,
      metadata: {
        channel: "C_ACTION",
        kind: "slack_block_action",
        actionId: "review.approve",
        scope,
      },
    });
  });
});

// ─── resolveFollowerThreadChannel ─────────────────────────

describe("resolveFollowerThreadChannel", () => {
  it("prefers the resolver result over a stale local channel cache", async () => {
    const resolveThread = vi.fn(async (threadTs: string) => {
      expect(threadTs).toBe("1234.5678");
      return "C999";
    });

    await expect(
      resolveFollowerThreadChannel(
        "1234.5678",
        { channelId: "C123", threadTs: "1234.5678", userId: "U1", owner: "Bot" },
        resolveThread,
      ),
    ).resolves.toEqual({
      channelId: "C999",
      changed: true,
      threadUpdate: {
        channelId: "C999",
        threadTs: "1234.5678",
        userId: "U1",
        owner: "Bot",
      },
    });
    expect(resolveThread).toHaveBeenCalledWith("1234.5678");
  });

  it("returns the resolver result without a cache update when it matches local state", async () => {
    const resolveThread = vi.fn(async () => "C123");

    await expect(
      resolveFollowerThreadChannel(
        "1234.5678",
        { channelId: "C123", threadTs: "1234.5678", userId: "U1", owner: "Bot" },
        resolveThread,
      ),
    ).resolves.toEqual({ channelId: "C123", changed: false });
    expect(resolveThread).toHaveBeenCalledWith("1234.5678");
  });

  it("asks the resolver for the channel when there is no local thread cache", async () => {
    const result = await resolveFollowerThreadChannel("1234.5678", undefined, async (threadTs) => {
      expect(threadTs).toBe("1234.5678");
      return "C999";
    });

    expect(result).toEqual({
      channelId: "C999",
      changed: true,
      threadUpdate: {
        channelId: "C999",
        threadTs: "1234.5678",
        userId: "",
        owner: undefined,
      },
    });
  });

  it("returns null when the resolver cannot find the thread, even if local cache exists", async () => {
    await expect(
      resolveFollowerThreadChannel(
        "1234.5678",
        { channelId: "C123", threadTs: "1234.5678", userId: "U1", owner: "Bot" },
        async () => null,
      ),
    ).resolves.toEqual({
      channelId: null,
      changed: false,
    });
  });

  it("returns null when the resolver throws", async () => {
    await expect(
      resolveFollowerThreadChannel("1234.5678", undefined, async () => {
        throw new Error("broker offline");
      }),
    ).resolves.toEqual({ channelId: null, changed: false });
  });

  it("falls back to the local cache when no resolver is available", async () => {
    await expect(
      resolveFollowerThreadChannel("1234.5678", {
        channelId: "C123",
        threadTs: "1234.5678",
        userId: "U1",
        owner: "Bot",
      }),
    ).resolves.toEqual({
      channelId: "C123",
      changed: false,
    });
  });

  it("returns null when no resolver or local cache is available", async () => {
    await expect(resolveFollowerThreadChannel("1234.5678", undefined)).resolves.toEqual({
      channelId: null,
      changed: false,
    });
  });
});

// ─── follower runtime diagnostics ─────────────────────────

describe("buildFollowerRuntimeDiagnostic", () => {
  it("builds disconnect diagnostics", () => {
    const diagnostic = buildFollowerRuntimeDiagnostic("broker_disconnect");

    expect(diagnostic).toEqual({
      kind: "broker_disconnect",
      state: "reconnecting",
      reason: "broker disconnected",
      nextStep: "Wait for automatic reconnect. If it does not recover, run /pinet follow.",
    });
    expect(formatFollowerRuntimeDiagnosticHealth(diagnostic)).toBe(
      "reconnecting — broker disconnected",
    );
    expect(formatFollowerRuntimeDiagnosticNextStep(diagnostic)).toBe(
      "Wait for automatic reconnect. If it does not recover, run /pinet follow.",
    );
  });

  it("builds poll failure diagnostics", () => {
    const diagnostic = buildFollowerRuntimeDiagnostic("poll_failure", {
      connected: true,
      detail: "Request timed out: pollInbox",
    });

    expect(diagnostic).toEqual({
      kind: "poll_failure",
      state: "degraded",
      reason: "inbox polling failed",
      detail: "Request timed out: pollInbox",
      nextStep:
        "Watch the next poll cycle. If failures continue, inspect the broker and run /pinet follow.",
    });
    expect(formatFollowerRuntimeDiagnosticHealth(diagnostic)).toBe(
      "degraded — inbox polling failed (Request timed out: pollInbox)",
    );
  });

  it("builds registration refresh failure diagnostics", () => {
    const diagnostic = buildFollowerRuntimeDiagnostic("registration_refresh_failure", {
      detail: "refresh failed once",
    });

    expect(diagnostic).toEqual({
      kind: "registration_refresh_failure",
      state: "degraded",
      reason: "registration refresh failed after reconnect",
      detail: "refresh failed once",
      nextStep:
        "Follower kept the last registered identity. If status or ownership looks stale, run /pinet follow.",
    });
    expect(formatFollowerRuntimeDiagnosticHealth(diagnostic)).toBe(
      "degraded — registration refresh failed after reconnect (refresh failed once)",
    );
  });

  it("builds reconnect stopped diagnostics and healthy fallbacks", () => {
    const diagnostic = buildFollowerRuntimeDiagnostic("reconnect_stopped", {
      detail: 'Agent name "Reserved Crane" is already reserved.',
    });

    expect(diagnostic).toEqual({
      kind: "reconnect_stopped",
      state: "error",
      reason: "automatic reconnect stopped",
      detail: 'Agent name "Reserved Crane" is already reserved.',
      nextStep: "Fix the reported error, then run /pinet follow to retry.",
    });
    expect(formatFollowerRuntimeDiagnosticHealth(diagnostic)).toBe(
      'error — automatic reconnect stopped (Agent name "Reserved Crane" is already reserved.)',
    );
    expect(formatFollowerRuntimeDiagnosticHealth(null)).toBe("healthy");
    expect(formatFollowerRuntimeDiagnosticNextStep(null)).toBe("None.");
  });
});

// ─── getFollowerReconnectUiUpdate ─────────────────────────

describe("getFollowerReconnectUiUpdate", () => {
  it("notifies on first disconnect", () => {
    const result = getFollowerReconnectUiUpdate("disconnect", false);
    expect(result.nextWasDisconnected).toBe(true);
    expect(result.notify?.level).toBe("warning");
  });

  it("suppresses notification on repeated disconnect", () => {
    const result = getFollowerReconnectUiUpdate("disconnect", true);
    expect(result.nextWasDisconnected).toBe(true);
    expect(result.notify).toBeUndefined();
  });

  it("notifies on reconnect after disconnect", () => {
    const result = getFollowerReconnectUiUpdate("reconnect", true);
    expect(result.nextWasDisconnected).toBe(false);
    expect(result.notify?.level).toBe("info");
  });

  it("suppresses notification on reconnect when not disconnected", () => {
    const result = getFollowerReconnectUiUpdate("reconnect", false);
    expect(result.nextWasDisconnected).toBe(false);
    expect(result.notify).toBeUndefined();
  });
});

// ─── getFollowerOwnedThreadClaims ────────────────────────

describe("agentOwnsThread", () => {
  it("matches the current name, stable owner token, or any remembered alias", () => {
    const ownerToken = buildPinetOwnerToken("host:session:/tmp/agent");
    expect(agentOwnsThread("Solar Falcon", "Solar Falcon", ["Old Falcon"], ownerToken)).toBe(true);
    expect(agentOwnsThread("Old Falcon", "Solar Falcon", ["Old Falcon"], ownerToken)).toBe(true);
    expect(agentOwnsThread(ownerToken, "Solar Falcon", ["Old Falcon"], ownerToken)).toBe(true);
    expect(agentOwnsThread("Other Falcon", "Solar Falcon", ["Old Falcon"], ownerToken)).toBe(false);
  });

  it("normalizes legacy owned threads onto the stable owner token", () => {
    const ownerToken = buildPinetOwnerToken("host:session:/tmp/agent");
    const threads = [{ owner: "Old Falcon" }, { owner: ownerToken }, { owner: "Other Falcon" }];

    expect(normalizeOwnedThreads(threads, "Solar Falcon", ownerToken, ["Old Falcon"])).toBe(true);
    expect(threads).toEqual([
      { owner: ownerToken },
      { owner: ownerToken },
      { owner: "Other Falcon" },
    ]);
  });
});

describe("getFollowerOwnedThreadClaims", () => {
  it("returns only threads owned by the agent", () => {
    const threads = new Map<string, FollowerThreadState>([
      ["t-1", { threadTs: "t-1", channelId: "C1", userId: "U1", owner: "Sonic Gecko" }],
      ["t-2", { threadTs: "t-2", channelId: "C2", userId: "U2", owner: "Other Agent" }],
    ]);

    expect(getFollowerOwnedThreadClaims(threads, "Sonic Gecko")).toEqual([
      { threadTs: "t-1", channelId: "C1" },
    ]);
  });

  it("preserves thread source for owned-thread reclaim", () => {
    const threads = new Map<string, FollowerThreadState>([
      [
        "t-1",
        {
          threadTs: "t-1",
          channelId: "chat:alice",
          userId: "alice",
          source: "imessage",
          owner: "Sonic Gecko",
        },
      ],
    ]);

    expect(getFollowerOwnedThreadClaims(threads, "Sonic Gecko")).toEqual([
      { threadTs: "t-1", channelId: "chat:alice", source: "imessage" },
    ]);
  });

  it("only returns sourceful owned threads for reconnect reclaim", () => {
    const threads = new Map<string, FollowerThreadState>([
      ["t-1", { threadTs: "t-1", channelId: "C1", userId: "U1", owner: "Sonic Gecko" }],
      [
        "t-2",
        {
          threadTs: "t-2",
          channelId: "chat:alice",
          userId: "alice",
          source: "imessage",
          owner: "Sonic Gecko",
        },
      ],
    ]);

    expect(getFollowerOwnedThreadReclaims(threads, "Sonic Gecko")).toEqual([
      { threadTs: "t-2", channelId: "chat:alice", source: "imessage" },
    ]);
  });

  it("ignores incomplete thread records", () => {
    const threads = new Map<string, FollowerThreadState>([
      ["t-1", { threadTs: "t-1", channelId: "", userId: "U1", owner: "Sonic Gecko" }],
      ["t-2", { threadTs: "", channelId: "C2", userId: "U2", owner: "Sonic Gecko" }],
    ]);

    expect(getFollowerOwnedThreadClaims(threads, "Sonic Gecko")).toEqual([]);
  });

  it("treats remembered aliases as owned threads after a skin change", () => {
    const ownerToken = buildPinetOwnerToken("host:session:/tmp/gecko");
    const threads = new Map<string, FollowerThreadState>([
      ["t-1", { threadTs: "t-1", channelId: "C1", userId: "U1", owner: "Old Gecko" }],
      ["t-2", { threadTs: "t-2", channelId: "C2", userId: "U2", owner: ownerToken }],
      ["t-3", { threadTs: "t-3", channelId: "C3", userId: "U3", owner: "Other Agent" }],
    ]);

    expect(getFollowerOwnedThreadClaims(threads, "Solar Gecko", ["Old Gecko"], ownerToken)).toEqual(
      [
        { threadTs: "t-1", channelId: "C1" },
        { threadTs: "t-2", channelId: "C2" },
      ],
    );
  });
});

// ─── Follower nudge partition (#102) ──────────────────────

describe("isRalphNudgeEntry", () => {
  it("returns true for entries with ralph_loop_nudge kind", () => {
    const entry: NudgeTestEntry = {
      inboxId: 1,
      message: {
        threadId: "a2a:broker:worker",
        sender: "broker-id",
        body: "RALPH LOOP nudge: you appear idle",
        metadata: { kind: "ralph_loop_nudge", targetAgentId: "worker-id" },
      },
    };
    expect(isRalphNudgeEntry(entry)).toBe(true);
  });

  it("returns false for regular messages", () => {
    const entry: NudgeTestEntry = {
      inboxId: 2,
      message: {
        threadId: "t-1",
        sender: "U123",
        body: "hello",
        metadata: { channel: "C456" },
      },
    };
    expect(isRalphNudgeEntry(entry)).toBe(false);
  });

  it("returns false for entries with null metadata", () => {
    const entry: NudgeTestEntry = {
      inboxId: 3,
      message: {
        threadId: "t-2",
        sender: "U456",
        body: "test",
        metadata: null,
      },
    };
    expect(isRalphNudgeEntry(entry)).toBe(false);
  });
});

describe("isAgentToAgentEntry", () => {
  it("returns true for a2a thread ids", () => {
    const entry: NudgeTestEntry = {
      inboxId: 1,
      message: {
        threadId: "a2a:broker:worker",
        sender: "broker",
        body: "do work",
        metadata: null,
      },
    };

    expect(isAgentToAgentEntry(entry)).toBe(true);
  });

  it("returns true when a2a metadata is set", () => {
    const entry: NudgeTestEntry = {
      inboxId: 2,
      message: {
        threadId: "thread-1",
        sender: "broker",
        body: "do work",
        metadata: { a2a: true },
      },
    };

    expect(isAgentToAgentEntry(entry)).toBe(true);
  });

  it("returns false for regular slack threads", () => {
    const entry: NudgeTestEntry = {
      inboxId: 3,
      message: {
        threadId: "1712073599.123456",
        sender: "U123",
        body: "hello",
        metadata: { channel: "C456" },
      },
    };

    expect(isAgentToAgentEntry(entry)).toBe(false);
  });
});

describe("partitionFollowerInboxEntries", () => {
  it("separates nudges, agent messages, and regular slack messages", () => {
    const entries: NudgeTestEntry[] = [
      {
        inboxId: 1,
        message: {
          threadId: "a2a:broker:worker",
          sender: "broker",
          body: "RALPH LOOP nudge",
          metadata: { kind: "ralph_loop_nudge" },
        },
      },
      {
        inboxId: 2,
        message: {
          threadId: "1712073599.123456",
          sender: "U123",
          body: "hello",
          metadata: { channel: "C456" },
        },
      },
      {
        inboxId: 3,
        message: {
          threadId: "a2a:broker:worker",
          sender: "broker",
          body: "please take #175",
          metadata: { a2a: true, senderAgent: "Broker Bunny" },
        },
      },
      {
        inboxId: 4,
        message: {
          threadId: "wakeup:worker",
          sender: "scheduler",
          body: "check queue",
          metadata: { scheduledWakeup: true, senderAgent: "Pinet Scheduler" },
        },
      },
    ];

    const result = partitionFollowerInboxEntries(entries);
    expect(result.nudges).toHaveLength(1);
    expect(result.agentMessages).toHaveLength(2);
    expect(result.regular).toHaveLength(1);
    expect(result.nudges[0].inboxId).toBe(1);
    expect(result.agentMessages.map((entry) => entry.inboxId)).toEqual([3, 4]);
    expect(result.regular[0].inboxId).toBe(2);
  });

  it("returns empty arrays when no entries", () => {
    const result = partitionFollowerInboxEntries([]);
    expect(result.nudges).toEqual([]);
    expect(result.agentMessages).toEqual([]);
    expect(result.regular).toEqual([]);
  });

  it("puts all entries in regular when no nudges or agent messages", () => {
    const entries: NudgeTestEntry[] = [
      {
        inboxId: 1,
        message: {
          threadId: "t-1",
          sender: "U1",
          body: "msg",
          metadata: null,
        },
      },
    ];
    const result = partitionFollowerInboxEntries(entries);
    expect(result.nudges).toEqual([]);
    expect(result.agentMessages).toEqual([]);
    expect(result.regular).toHaveLength(1);
  });
});

// ─── buildAgentDisplayInfo observability fields (#103) ────────

describe("buildAgentDisplayInfo observability fields", () => {
  const now = Date.parse("2026-04-01T00:10:00.000Z");

  it("includes idleSince and formats idle duration", () => {
    const info = buildAgentDisplayInfo(
      {
        emoji: "🦉",
        name: "Idle Owl",
        id: "owl-1",
        status: "idle",
        lastHeartbeat: "2026-04-01T00:09:55.000Z",
        idleSince: "2026-04-01T00:05:00.000Z", // 5 min ago
      },
      { now },
    );

    expect(info.idleSince).toBe("2026-04-01T00:05:00.000Z");
    expect(info.idleDuration).toBe("5m ago");
    expect(info.stuck).toBe(false);
  });

  it("includes lastActivity and formats activity age", () => {
    const info = buildAgentDisplayInfo(
      {
        emoji: "🐺",
        name: "Working Wolf",
        id: "wolf-1",
        status: "working",
        lastHeartbeat: "2026-04-01T00:09:55.000Z",
        lastActivity: "2026-04-01T00:08:00.000Z", // 2 min ago
      },
      { now },
    );

    expect(info.lastActivity).toBe("2026-04-01T00:08:00.000Z");
    expect(info.lastActivityAge).toBe("2m ago");
    expect(info.stuck).toBe(false);
  });

  it("handles null idleSince and lastActivity", () => {
    const info = buildAgentDisplayInfo(
      {
        emoji: "🐼",
        name: "New Panda",
        id: "panda-1",
        status: "idle",
        lastHeartbeat: "2026-04-01T00:09:55.000Z",
      },
      { now },
    );

    expect(info.idleSince).toBeNull();
    expect(info.lastActivity).toBeNull();
    expect(info.idleDuration).toBeNull();
    expect(info.lastActivityAge).toBeNull();
  });
});

describe("scope compatibility helpers", () => {
  it("builds a compatibility scope without inventing a workspace id for an unknown team", () => {
    expect(
      buildSlackCompatibilityScope({
        teamId: "",
        channelId: "C123",
      }),
    ).toEqual({
      workspace: {
        provider: "slack",
        source: "compatibility",
        compatibilityKey: "default",
        channelId: "C123",
      },
      instance: {
        source: "compatibility",
        compatibilityKey: "default",
      },
    });
  });

  it("extracts scoped capabilities and derives scope tags", () => {
    const capabilities = extractAgentCapabilities({
      capabilities: {
        repo: "extensions",
        role: "worker",
        scope: buildSlackCompatibilityScope({ teamId: "T123", channelId: "C123" }),
      },
    });

    expect(capabilities.scope).toEqual({
      workspace: {
        provider: "slack",
        source: "compatibility",
        compatibilityKey: "default",
        workspaceId: "T123",
        channelId: "C123",
      },
      instance: {
        source: "compatibility",
        compatibilityKey: "default",
      },
    });
    expect(buildAgentCapabilityTags(capabilities)).toEqual(
      expect.arrayContaining(["scope-provider:slack", "scope:default", "workspace:T123"]),
    );
  });
});
