// ─── Security Guardrails ─────────────────────────────────

export interface SecurityGuardrails {
  readOnly?: boolean; // Block all write operations from Slack triggers
  requireConfirmation?: string[]; // Tool name patterns (glob) requiring approval
  blockedTools?: string[]; // Tools completely blocked from Slack triggers
}

/** Well-known read-only tools that are always safe */
export const READ_ONLY_TOOLS = new Set([
  "read",
  "rg",
  "slack",
  "slack_inbox",
  "slack_send",
  "slack:help",
  "slack:read",
  "slack:read_channel",
  "slack:export",
  "slack:presence",
  "slack:canvas_comments_read",
  "slack:confirm_action",
  "pinet:agents",
  "pinet:read",
  "memory_read",
  "memory_search",
  "memory_list",
  "memory_check",
]);

/** Well-known write tools (used when readOnly mode is active) */
export const WRITE_TOOLS = new Set([
  "bash",
  "edit",
  "write",
  "comment_add",
  "comment_wipe_all",
  "memory_write",
  "memory_sync",
  "memory_init",
  "slack:create_channel",
  "slack:project_create",
  "slack:post_channel",
  "slack:delete",
  "slack:upload",
  "slack:schedule",
  "slack:pin",
  "slack:bookmark",
  "slack:react",
  "slack:canvas_create",
  "slack:canvas_update",
  "slack:modal_open",
  "slack:modal_push",
  "slack:modal_update",
  "pinet:schedule",
  "pinet:send",
  "pinet:snooze",
  "pinet:free",
  "pinet:ports",
  "pinet:reload",
  "pinet:exit",
  "pinet:hibernate",
  "pinet:wake",
]);

/**
 * Match a tool name against glob patterns (supports `*` wildcard).
 * Slack and Pinet dispatcher actions use `<namespace>:<action>` names; legacy
 * `<namespace>_<action>` guardrail patterns still match during migration. Pinet
 * direct tools are no longer registered, but keeping alias matching prevents old
 * security configs from silently failing open.
 * Returns true if the tool name matches any of the patterns.
 */
export function matchesToolPattern(toolName: string, patterns: string[]): boolean {
  const candidates = new Set([toolName]);
  if (toolName.startsWith("slack:")) {
    candidates.add(`slack_${toolName.slice("slack:".length)}`);
  } else if (toolName.startsWith("slack_")) {
    candidates.add(`slack:${toolName.slice("slack_".length)}`);
  }

  if (toolName.startsWith("pinet:")) {
    candidates.add(`pinet_${toolName.slice("pinet:".length)}`);
  } else if (toolName.startsWith("pinet_")) {
    candidates.add(`pinet:${toolName.slice("pinet_".length)}`);
  }
  if (toolName === "pinet_message" || toolName === "pinet:send" || toolName === "pinet_send") {
    candidates.add("pinet_message");
    candidates.add("pinet:send");
    candidates.add("pinet_send");
  }

  for (const pattern of patterns) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const re = new RegExp(`^${escaped}$`);
    for (const candidate of candidates) {
      if (re.test(candidate)) return true;
    }
  }
  return false;
}

/**
 * Check if a tool is blocked by the guardrails.
 * Returns true if:
 * - tool matches any blockedTools pattern
 * - guardrails.readOnly is true AND tool is in WRITE_TOOLS
 */
export function isToolBlocked(toolName: string, guardrails: SecurityGuardrails): boolean {
  if (guardrails.blockedTools?.length && matchesToolPattern(toolName, guardrails.blockedTools)) {
    return true;
  }

  if (!guardrails.readOnly) {
    return false;
  }

  const readOnlyCandidates = new Set([toolName]);
  if (toolName.startsWith("slack:")) {
    readOnlyCandidates.add(`slack_${toolName.slice("slack:".length)}`);
  } else if (toolName.startsWith("slack_")) {
    readOnlyCandidates.add(`slack:${toolName.slice("slack_".length)}`);
  }

  if (toolName.startsWith("pinet:")) {
    readOnlyCandidates.add(`pinet_${toolName.slice("pinet:".length)}`);
  } else if (toolName.startsWith("pinet_")) {
    readOnlyCandidates.add(`pinet:${toolName.slice("pinet_".length)}`);
  }
  if (toolName === "pinet_message" || toolName === "pinet:send" || toolName === "pinet_send") {
    readOnlyCandidates.add("pinet_message");
    readOnlyCandidates.add("pinet:send");
    readOnlyCandidates.add("pinet_send");
  }

  for (const candidate of readOnlyCandidates) {
    if (WRITE_TOOLS.has(candidate)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a tool needs confirmation.
 * Returns true if tool matches any requireConfirmation pattern.
 * Returns false if tool is already blocked (blocked takes priority).
 */
export function toolNeedsConfirmation(toolName: string, guardrails: SecurityGuardrails): boolean {
  if (isToolBlocked(toolName, guardrails)) return false;
  if (
    guardrails.requireConfirmation?.length &&
    matchesToolPattern(toolName, guardrails.requireConfirmation)
  ) {
    return true;
  }
  return false;
}

/**
 * Build security instructions to prepend to Slack-triggered messages.
 * Returns a clear, structured prompt with active guardrails.
 * Returns empty string if no guardrails are active.
 */
export function hasEffectivelyEmptyRuntimeGuardrails(
  guardrails: SecurityGuardrails | null | undefined,
): boolean {
  return (
    guardrails?.readOnly !== true &&
    (guardrails?.blockedTools?.length ?? 0) === 0 &&
    (guardrails?.requireConfirmation?.length ?? 0) === 0
  );
}

export function formatRuntimeGuardrailsPosture(
  guardrails: SecurityGuardrails | null | undefined,
): string {
  if (hasEffectivelyEmptyRuntimeGuardrails(guardrails)) {
    return "empty (warn-first posture; behavior unchanged)";
  }

  const sections: string[] = [];
  if (guardrails?.readOnly === true) {
    sections.push("readOnly");
  }
  const blockedCount = guardrails?.blockedTools?.length ?? 0;
  if (blockedCount > 0) {
    sections.push(`blockedTools:${blockedCount}`);
  }
  const confirmationCount = guardrails?.requireConfirmation?.length ?? 0;
  if (confirmationCount > 0) {
    sections.push(`requireConfirmation:${confirmationCount}`);
  }

  return sections.length > 0 ? `configured (${sections.join(", ")})` : "configured";
}

export function getEmptyRuntimeGuardrailsWarning(
  guardrails: SecurityGuardrails | null | undefined,
): string | null {
  if (!hasEffectivelyEmptyRuntimeGuardrails(guardrails)) {
    return null;
  }

  return [
    "Slack/Pinet access is enabled for admitted users, but runtime guardrails are effectively empty.",
    "Configure slack-bridge.security.readOnly, security.blockedTools, or security.requireConfirmation if you want runtime restrictions for Slack-triggered turns.",
    "This warning is visibility-only; current runtime behavior is unchanged.",
  ].join(" ");
}

export function buildSecurityPrompt(guardrails: SecurityGuardrails): string {
  const sections: string[] = [];

  const hasReadOnly = guardrails.readOnly === true;
  const hasBlocked = (guardrails.blockedTools?.length ?? 0) > 0;
  const hasConfirmation = (guardrails.requireConfirmation?.length ?? 0) > 0;

  if (hasEffectivelyEmptyRuntimeGuardrails(guardrails)) return "";

  sections.push("⚠️ SECURITY GUARDRAILS — Slack-triggered action restrictions:");

  if (hasReadOnly) {
    const allowed = [...READ_ONLY_TOOLS].join(", ");
    sections.push(
      [
        "🔒 READ-ONLY MODE is active.",
        `You MUST NOT use any write tools (${[...WRITE_TOOLS].join(", ")}).`,
        `Only these tools are allowed: ${allowed}.`,
        "If a request requires writing files or modifying state, explain that read-only mode is active and the action cannot be performed via Slack.",
      ].join("\n"),
    );
  }

  if (hasBlocked) {
    sections.push(
      [
        "🚫 BLOCKED TOOLS:",
        `The following tool patterns are completely blocked: ${guardrails.blockedTools!.join(", ")}.`,
        "Do NOT use any tool matching these patterns. If a request requires a blocked tool, inform the user it is not available via Slack.",
      ].join("\n"),
    );
  }

  if (hasConfirmation) {
    sections.push(
      [
        "✋ CONFIRMATION REQUIRED:",
        `Before using tools matching these patterns: [${guardrails.requireConfirmation!.join(", ")}], you MUST first call slack with action "confirm_action" and args containing thread_ts, the exact action string required by the guarded tool, and the tool name (for dispatcher actions, use slack:<action> or pinet:<action>).`,
        "Wait for the user's response via slack_inbox. Only proceed if the user approves. If denied, inform the user and skip the action.",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

// ─── Broker Role Guardrails ──────────────────────────────

/**
 * Tools that the broker agent must NEVER use.
 * The broker is infrastructure — it coordinates, not codes.
 * Spawning local subagents (Agent) is forbidden because they
 * have no Slack/Pinet connectivity and can't be monitored.
 * Direct file mutation tools are also blocked so the runtime
 * enforces the coordination-only role even if prompt guidance drifts.
 */
export const BROKER_FORBIDDEN_TOOLS = new Set(["Agent", "edit", "write"]);

/**
 * Check if a tool is forbidden for the broker role.
 * Returns true if the broker must not use this tool.
 */
export function isBrokerForbiddenTool(toolName: string): boolean {
  return BROKER_FORBIDDEN_TOOLS.has(toolName);
}

/**
 * Build a prompt snippet describing broker tool restrictions.
 * Injected into the system prompt when the broker role is active.
 */
export function buildBrokerToolGuardrailsPrompt(): string {
  const forbidden = [...BROKER_FORBIDDEN_TOOLS].join(", ");
  return [
    "🚫 BROKER TOOL RESTRICTION:",
    `The following tools are BLOCKED for the broker role: ${forbidden}.`,
    "The Agent tool (including code-reviewer and other local subagents) spawns local workers with no Slack/Pinet connectivity — they can't be monitored, can't own threads, and can't coordinate with humans.",
    "The edit and write tools are blocked because the broker is coordination infrastructure, not an implementation worker.",
    "Use pinet action=send to delegate coding or review work to connected Pinet agents instead.",
  ].join("\n");
}

/**
 * Parse whether a user message is approving a confirmation request.
 * Case-insensitive, trimmed.
 */
export function isConfirmationApproval(text: string): boolean {
  const APPROVALS = new Set([
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
  ]);
  return APPROVALS.has(text.trim().toLowerCase());
}

/**
 * Parse whether a user message is rejecting a confirmation request.
 * Case-insensitive, trimmed.
 */
export function isConfirmationRejection(text: string): boolean {
  const REJECTIONS = new Set([
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
  ]);
  return REJECTIONS.has(text.trim().toLowerCase());
}
