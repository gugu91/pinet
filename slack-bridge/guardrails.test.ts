import { describe, it, expect } from "vitest";
import {
  matchesToolPattern,
  isToolBlocked,
  toolNeedsConfirmation,
  buildSecurityPrompt,
  getEmptyRuntimeGuardrailsWarning,
  hasEffectivelyEmptyRuntimeGuardrails,
  formatRuntimeGuardrailsPosture,
  isConfirmationApproval,
  isConfirmationRejection,
  isBrokerForbiddenTool,
  buildBrokerToolGuardrailsPrompt,
  BROKER_FORBIDDEN_TOOLS,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  type SecurityGuardrails,
} from "./guardrails.js";

// ─── matchesToolPattern ───────────────────────────────────

describe("matchesToolPattern", () => {
  it("matches exact tool name", () => {
    expect(matchesToolPattern("bash", ["bash"])).toBe(true);
  });

  it("matches with wildcard *", () => {
    expect(matchesToolPattern("slack_send", ["slack_*"])).toBe(true);
    expect(matchesToolPattern("slack:read_channel", ["slack:*"])).toBe(true);
  });

  it("matches against multiple patterns", () => {
    expect(matchesToolPattern("edit", ["bash", "edit", "write"])).toBe(true);
  });

  it("returns false when no match", () => {
    expect(matchesToolPattern("read", ["bash", "edit"])).toBe(false);
  });

  it("returns false for empty patterns array", () => {
    expect(matchesToolPattern("bash", [])).toBe(false);
  });

  it("handles pattern with special regex chars", () => {
    expect(matchesToolPattern("foo.bar", ["foo.bar"])).toBe(true);
    expect(matchesToolPattern("fooXbar", ["foo.bar"])).toBe(false);
  });

  it("wildcard matches entire name", () => {
    expect(matchesToolPattern("anything", ["*"])).toBe(true);
  });

  it("partial wildcard at start", () => {
    expect(matchesToolPattern("memory_read", ["*_read"])).toBe(true);
    expect(matchesToolPattern("memory_write", ["*_read"])).toBe(false);
  });

  it("wildcard in the middle", () => {
    expect(matchesToolPattern("slack:read_channel", ["slack:*_channel"])).toBe(true);
    expect(matchesToolPattern("slack_send", ["slack:*_channel"])).toBe(false);
  });

  it("matches legacy Slack underscore patterns against dispatcher action names", () => {
    expect(matchesToolPattern("slack:canvas_update", ["slack_canvas_*"])).toBe(true);
    expect(matchesToolPattern("slack:upload", ["slack_upload"])).toBe(true);
  });

  it("matches legacy Pinet underscore guardrail patterns against dispatcher action names", () => {
    expect(matchesToolPattern("pinet:send", ["pinet_send"])).toBe(true);
    expect(matchesToolPattern("pinet_read", ["pinet:read"])).toBe(true);
  });

  it("treats former pinet_message policies as send guardrail aliases", () => {
    expect(matchesToolPattern("pinet:send", ["pinet_message"])).toBe(true);
    expect(matchesToolPattern("pinet:send", ["pinet_send"])).toBe(true);
    expect(matchesToolPattern("pinet_message", ["pinet:send"])).toBe(true);
  });
});

// ─── isToolBlocked ────────────────────────────────────────

describe("isToolBlocked", () => {
  it("blocks tool matching blockedTools pattern", () => {
    const g: SecurityGuardrails = { blockedTools: ["bash", "comment_*"] };
    expect(isToolBlocked("bash", g)).toBe(true);
    expect(isToolBlocked("comment_add", g)).toBe(true);
    expect(isToolBlocked("comment_wipe_all", g)).toBe(true);
  });

  it("blocks write tool when readOnly is true", () => {
    const g: SecurityGuardrails = { readOnly: true };
    for (const tool of WRITE_TOOLS) {
      expect(isToolBlocked(tool, g)).toBe(true);
    }
  });

  it("does not block read-only tool even in readOnly mode", () => {
    const g: SecurityGuardrails = { readOnly: true };
    for (const tool of READ_ONLY_TOOLS) {
      expect(isToolBlocked(tool, g)).toBe(false);
    }
  });

  it("does not block when no guardrails configured", () => {
    expect(isToolBlocked("bash", {})).toBe(false);
    expect(isToolBlocked("edit", {})).toBe(false);
  });

  it("does not block tool not in any pattern", () => {
    const g: SecurityGuardrails = { blockedTools: ["bash"] };
    expect(isToolBlocked("edit", g)).toBe(false);
  });

  it("classifies Slack dispatcher mutation actions as write-only", () => {
    expect(WRITE_TOOLS.has("slack:create_channel")).toBe(true);
    expect(WRITE_TOOLS.has("slack:project_create")).toBe(true);
    expect(WRITE_TOOLS.has("slack:post_channel")).toBe(true);
    expect(WRITE_TOOLS.has("slack:delete")).toBe(true);
    expect(WRITE_TOOLS.has("slack:upload")).toBe(true);
    expect(WRITE_TOOLS.has("slack:schedule")).toBe(true);
    expect(WRITE_TOOLS.has("slack:pin")).toBe(true);
    expect(WRITE_TOOLS.has("slack:bookmark")).toBe(true);
    expect(WRITE_TOOLS.has("slack:react")).toBe(true);
    expect(WRITE_TOOLS.has("slack:modal_open")).toBe(true);
    expect(WRITE_TOOLS.has("slack:modal_push")).toBe(true);
    expect(WRITE_TOOLS.has("slack:modal_update")).toBe(true);
    expect(READ_ONLY_TOOLS.has("slack:export")).toBe(true);
    expect(READ_ONLY_TOOLS.has("slack:presence")).toBe(true);
    expect(READ_ONLY_TOOLS.has("slack:canvas_comments_read")).toBe(true);
    expect(READ_ONLY_TOOLS.has("slack:create_channel")).toBe(false);
    expect(READ_ONLY_TOOLS.has("slack:post_channel")).toBe(false);
    expect(READ_ONLY_TOOLS.has("slack:delete")).toBe(false);
    expect(READ_ONLY_TOOLS.has("slack:upload")).toBe(false);
    expect(READ_ONLY_TOOLS.has("slack:schedule")).toBe(false);
    expect(READ_ONLY_TOOLS.has("slack:pin")).toBe(false);
    expect(READ_ONLY_TOOLS.has("slack:bookmark")).toBe(false);
    expect(READ_ONLY_TOOLS.has("slack:react")).toBe(false);
    expect(READ_ONLY_TOOLS.has("slack:modal_open")).toBe(false);
    expect(READ_ONLY_TOOLS.has("slack:modal_push")).toBe(false);
    expect(READ_ONLY_TOOLS.has("slack:modal_update")).toBe(false);
    expect(WRITE_TOOLS.has("slack:presence")).toBe(false);
  });

  it("classifies Pinet dispatcher actions as read/write appropriately", () => {
    expect(WRITE_TOOLS.has("pinet:send")).toBe(true);
    expect(WRITE_TOOLS.has("pinet:schedule")).toBe(true);
    expect(WRITE_TOOLS.has("pinet:snooze")).toBe(true);
    expect(WRITE_TOOLS.has("pinet:free")).toBe(true);
    expect(WRITE_TOOLS.has("pinet:ports")).toBe(true);
    expect(WRITE_TOOLS.has("pinet:reload")).toBe(true);
    expect(WRITE_TOOLS.has("pinet:exit")).toBe(true);
    expect(WRITE_TOOLS.has("pinet:skin")).toBe(false);
    expect(WRITE_TOOLS.has("pinet_message")).toBe(false);
    expect(READ_ONLY_TOOLS.has("pinet:read")).toBe(true);
    expect(READ_ONLY_TOOLS.has("pinet:agents")).toBe(true);
    expect(WRITE_TOOLS.has("pinet:read")).toBe(false);
    expect(WRITE_TOOLS.has("pinet:agents")).toBe(false);
    expect(READ_ONLY_TOOLS.has("pinet:send")).toBe(false);
    expect(READ_ONLY_TOOLS.has("pinet:schedule")).toBe(false);
    expect(READ_ONLY_TOOLS.has("pinet:snooze")).toBe(false);
    expect(READ_ONLY_TOOLS.has("pinet:free")).toBe(false);
    expect(READ_ONLY_TOOLS.has("pinet:ports")).toBe(false);
    expect(READ_ONLY_TOOLS.has("pinet:reload")).toBe(false);
    expect(READ_ONLY_TOOLS.has("pinet:exit")).toBe(false);
    expect(READ_ONLY_TOOLS.has("pinet:skin")).toBe(false);
    expect(READ_ONLY_TOOLS.has("pinet_message")).toBe(false);
  });

  it("classifies Pinet dispatcher and legacy policy names for readOnly checks", () => {
    const g: SecurityGuardrails = { readOnly: true };
    expect(isToolBlocked("pinet:send", g)).toBe(true);
    expect(isToolBlocked("pinet:snooze", g)).toBe(true);
    expect(isToolBlocked("pinet_snooze", g)).toBe(true);
    expect(isToolBlocked("pinet:ports", g)).toBe(true);
    expect(isToolBlocked("pinet:reload", g)).toBe(true);
    expect(isToolBlocked("pinet:exit", g)).toBe(true);
    expect(isToolBlocked("pinet:skin", g)).toBe(false);
    expect(isToolBlocked("pinet_message", g)).toBe(true);
    expect(isToolBlocked("pinet_send", g)).toBe(true);
    expect(isToolBlocked("pinet:read", g)).toBe(false);
    expect(isToolBlocked("pinet_read", g)).toBe(false);
  });

  it("combines readOnly and blockedTools", () => {
    const g: SecurityGuardrails = { readOnly: true, blockedTools: ["slack_create_channel"] };
    expect(isToolBlocked("bash", g)).toBe(true); // write tool + readOnly
    expect(isToolBlocked("slack:create_channel", g)).toBe(true); // explicit block via legacy pattern
    expect(isToolBlocked("slack_create_channel", g)).toBe(true); // legacy spelling still maps
    expect(isToolBlocked("read", g)).toBe(false); // read-only tool
  });

  it("applies legacy send blocks to dispatcher send", () => {
    expect(isToolBlocked("pinet:send", { blockedTools: ["pinet_send"] })).toBe(true);
    expect(isToolBlocked("pinet:send", { blockedTools: ["pinet_message"] })).toBe(true);
  });
});

// ─── toolNeedsConfirmation ────────────────────────────────

describe("toolNeedsConfirmation", () => {
  it("returns true when tool matches requireConfirmation pattern", () => {
    const g: SecurityGuardrails = { requireConfirmation: ["bash", "edit"] };
    expect(toolNeedsConfirmation("bash", g)).toBe(true);
    expect(toolNeedsConfirmation("edit", g)).toBe(true);
  });

  it("returns true with wildcard pattern", () => {
    const g: SecurityGuardrails = { requireConfirmation: ["memory_*"] };
    expect(toolNeedsConfirmation("memory_write", g)).toBe(true);
    expect(toolNeedsConfirmation("memory_sync", g)).toBe(true);
  });

  it("applies legacy send confirmation policies to dispatcher send", () => {
    expect(toolNeedsConfirmation("pinet:send", { requireConfirmation: ["pinet_send"] })).toBe(true);
    expect(toolNeedsConfirmation("pinet:send", { requireConfirmation: ["pinet_message"] })).toBe(
      true,
    );
  });

  it("returns false when tool does not match", () => {
    const g: SecurityGuardrails = { requireConfirmation: ["bash"] };
    expect(toolNeedsConfirmation("read", g)).toBe(false);
  });

  it("returns false when tool is already blocked (blocked takes priority)", () => {
    const g: SecurityGuardrails = {
      blockedTools: ["bash"],
      requireConfirmation: ["bash"],
    };
    expect(toolNeedsConfirmation("bash", g)).toBe(false);
  });

  it("returns false when tool is blocked by readOnly", () => {
    const g: SecurityGuardrails = {
      readOnly: true,
      requireConfirmation: ["bash"],
    };
    expect(toolNeedsConfirmation("bash", g)).toBe(false);
  });

  it("returns false when no guardrails configured", () => {
    expect(toolNeedsConfirmation("bash", {})).toBe(false);
  });

  it("returns false with empty requireConfirmation array", () => {
    const g: SecurityGuardrails = { requireConfirmation: [] };
    expect(toolNeedsConfirmation("bash", g)).toBe(false);
  });
});

// ─── runtime guardrail posture helpers ────────────────────

describe("hasEffectivelyEmptyRuntimeGuardrails", () => {
  it("treats an empty guardrail config as effectively empty", () => {
    expect(hasEffectivelyEmptyRuntimeGuardrails({})).toBe(true);
    expect(hasEffectivelyEmptyRuntimeGuardrails({ readOnly: false })).toBe(true);
    expect(
      hasEffectivelyEmptyRuntimeGuardrails({ blockedTools: [], requireConfirmation: [] }),
    ).toBe(true);
  });

  it("returns false when readOnly is enabled", () => {
    expect(hasEffectivelyEmptyRuntimeGuardrails({ readOnly: true })).toBe(false);
  });

  it("returns false when blocked tools are configured", () => {
    expect(hasEffectivelyEmptyRuntimeGuardrails({ blockedTools: ["bash"] })).toBe(false);
  });

  it("returns false when confirmations are configured", () => {
    expect(hasEffectivelyEmptyRuntimeGuardrails({ requireConfirmation: ["bash"] })).toBe(false);
  });
});

describe("formatRuntimeGuardrailsPosture", () => {
  it("formats the empty guardrail posture", () => {
    expect(formatRuntimeGuardrailsPosture({})).toBe(
      "empty (warn-first posture; behavior unchanged)",
    );
  });

  it("formats configured guardrails with a concise summary", () => {
    expect(
      formatRuntimeGuardrailsPosture({
        readOnly: true,
        blockedTools: ["bash"],
        requireConfirmation: ["edit", "write"],
      }),
    ).toBe("configured (readOnly, blockedTools:1, requireConfirmation:2)");
  });
});

describe("getEmptyRuntimeGuardrailsWarning", () => {
  it("returns a warning only when guardrails are effectively empty", () => {
    expect(getEmptyRuntimeGuardrailsWarning({})).toContain("effectively empty");
    expect(getEmptyRuntimeGuardrailsWarning({ blockedTools: ["bash"] })).toBeNull();
  });
});

// ─── buildSecurityPrompt ──────────────────────────────────

describe("buildSecurityPrompt", () => {
  it("returns empty string when no guardrails are active", () => {
    expect(buildSecurityPrompt({})).toBe("");
  });

  it("returns empty string for default values", () => {
    expect(buildSecurityPrompt({ readOnly: false })).toBe("");
  });

  it("returns empty for empty arrays", () => {
    expect(buildSecurityPrompt({ blockedTools: [], requireConfirmation: [] })).toBe("");
  });

  it("includes read-only instructions when readOnly is true", () => {
    const prompt = buildSecurityPrompt({ readOnly: true });
    expect(prompt).toContain("READ-ONLY MODE");
    expect(prompt).toContain("bash");
    expect(prompt).toContain("edit");
    expect(prompt).toContain("write");
    // Should mention allowed tools
    expect(prompt).toContain("read");
    expect(prompt).toContain("slack_send");
  });

  it("includes blocked tools section", () => {
    const prompt = buildSecurityPrompt({ blockedTools: ["bash", "comment_*"] });
    expect(prompt).toContain("BLOCKED TOOLS");
    expect(prompt).toContain("bash");
    expect(prompt).toContain("comment_*");
  });

  it("includes confirmation section", () => {
    const prompt = buildSecurityPrompt({ requireConfirmation: ["bash", "edit"] });
    expect(prompt).toContain("CONFIRMATION REQUIRED");
    expect(prompt).toContain("bash");
    expect(prompt).toContain("edit");
    expect(prompt).toContain('action "confirm_action"');
  });

  it("includes all sections when all guardrails are active", () => {
    const prompt = buildSecurityPrompt({
      readOnly: true,
      blockedTools: ["comment_wipe_all"],
      requireConfirmation: ["slack:create_channel"],
    });
    expect(prompt).toContain("READ-ONLY MODE");
    expect(prompt).toContain("BLOCKED TOOLS");
    expect(prompt).toContain("CONFIRMATION REQUIRED");
    expect(prompt).toContain("SECURITY GUARDRAILS");
  });

  it("includes SECURITY GUARDRAILS header", () => {
    const prompt = buildSecurityPrompt({ readOnly: true });
    expect(prompt).toContain("SECURITY GUARDRAILS");
  });
});

// ─── isConfirmationApproval ───────────────────────────────

describe("isConfirmationApproval", () => {
  const approvals = [
    "yes",
    "approve",
    "approved",
    "confirm",
    "confirmed",
    "go ahead",
    "proceed",
    "y",
    "ok",
    "\u{1F44D}",
  ];

  for (const word of approvals) {
    it(`recognizes "${word}" as approval`, () => {
      expect(isConfirmationApproval(word)).toBe(true);
    });
  }

  it("is case-insensitive", () => {
    expect(isConfirmationApproval("YES")).toBe(true);
    expect(isConfirmationApproval("Approve")).toBe(true);
    expect(isConfirmationApproval("Go Ahead")).toBe(true);
  });

  it("trims whitespace", () => {
    expect(isConfirmationApproval("  yes  ")).toBe(true);
    expect(isConfirmationApproval("\tok\n")).toBe(true);
  });

  it("rejects rejections", () => {
    expect(isConfirmationApproval("no")).toBe(false);
    expect(isConfirmationApproval("deny")).toBe(false);
    expect(isConfirmationApproval("cancel")).toBe(false);
  });

  it("rejects random text", () => {
    expect(isConfirmationApproval("maybe")).toBe(false);
    expect(isConfirmationApproval("let me think")).toBe(false);
    expect(isConfirmationApproval("")).toBe(false);
  });
});

// ─── Broker role guardrails ───────────────────────────────

describe("BROKER_FORBIDDEN_TOOLS", () => {
  it("blocks the direct implementation tools", () => {
    expect(BROKER_FORBIDDEN_TOOLS.has("Agent")).toBe(true);
    expect(BROKER_FORBIDDEN_TOOLS.has("edit")).toBe(true);
    expect(BROKER_FORBIDDEN_TOOLS.has("write")).toBe(true);
  });
});

describe("isBrokerForbiddenTool", () => {
  it("returns true for the direct implementation tools", () => {
    expect(isBrokerForbiddenTool("Agent")).toBe(true);
    expect(isBrokerForbiddenTool("edit")).toBe(true);
    expect(isBrokerForbiddenTool("write")).toBe(true);
  });

  it("returns false for allowed tools", () => {
    expect(isBrokerForbiddenTool("pinet")).toBe(false);
    expect(isBrokerForbiddenTool("slack_send")).toBe(false);
    expect(isBrokerForbiddenTool("read")).toBe(false);
    expect(isBrokerForbiddenTool("bash")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(isBrokerForbiddenTool("agent")).toBe(false);
    expect(isBrokerForbiddenTool("AGENT")).toBe(false);
  });
});

describe("buildBrokerToolGuardrailsPrompt", () => {
  it("mentions the blocked broker tools", () => {
    const prompt = buildBrokerToolGuardrailsPrompt();
    expect(prompt).toContain("Agent");
    expect(prompt).toContain("edit");
    expect(prompt).toContain("write");
    expect(prompt).toContain("BLOCKED");
  });

  it("recommends dispatcher send as the alternative", () => {
    const prompt = buildBrokerToolGuardrailsPrompt();
    expect(prompt).toContain("pinet action=send");
  });

  it("explains why local subagents and file mutation tools are forbidden", () => {
    const prompt = buildBrokerToolGuardrailsPrompt();
    expect(prompt).toContain("no Slack/Pinet connectivity");
    expect(prompt).toContain("coordination infrastructure");
    expect(prompt).toContain("code-reviewer");
  });
});

// ─── isConfirmationRejection ──────────────────────────────

describe("isConfirmationRejection", () => {
  const rejections = [
    "no",
    "deny",
    "denied",
    "reject",
    "rejected",
    "cancel",
    "abort",
    "stop",
    "n",
    "\u{1F44E}",
  ];

  for (const word of rejections) {
    it(`recognizes "${word}" as rejection`, () => {
      expect(isConfirmationRejection(word)).toBe(true);
    });
  }

  it("is case-insensitive", () => {
    expect(isConfirmationRejection("NO")).toBe(true);
    expect(isConfirmationRejection("Cancel")).toBe(true);
    expect(isConfirmationRejection("ABORT")).toBe(true);
  });

  it("trims whitespace", () => {
    expect(isConfirmationRejection("  no  ")).toBe(true);
    expect(isConfirmationRejection("\tstop\n")).toBe(true);
  });

  it("rejects approvals", () => {
    expect(isConfirmationRejection("yes")).toBe(false);
    expect(isConfirmationRejection("approve")).toBe(false);
    expect(isConfirmationRejection("ok")).toBe(false);
  });

  it("rejects random text", () => {
    expect(isConfirmationRejection("maybe")).toBe(false);
    expect(isConfirmationRejection("not sure")).toBe(false);
    expect(isConfirmationRejection("")).toBe(false);
  });
});
