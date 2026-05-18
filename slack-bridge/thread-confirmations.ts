import type { ConfirmationRequest, ThreadConfirmationState } from "./helpers.js";
import {
  DEFAULT_CONFIRMATION_REQUEST_TTL_MS,
  confirmationRequestMatches,
  consumeMatchingConfirmationRequest,
  isThreadConfirmationStateEmpty,
  normalizeThreadConfirmationState,
  registerThreadConfirmationRequest,
} from "./helpers.js";
import {
  isConfirmationApproval,
  isConfirmationRejection,
  isToolBlocked,
  toolNeedsConfirmation,
  type SecurityGuardrails,
} from "./guardrails.js";

export interface RegisterConfirmationRequestResult {
  status: "created" | "refreshed" | "conflict";
  conflict?: ConfirmationRequest;
}

export interface ThreadConfirmationPolicy {
  formatAction: (action: string) => string;
  registerRequest: (
    threadTs: string,
    tool: string,
    action: string,
  ) => RegisterConfirmationRequestResult;
  consumeReply: (
    threadTs: string,
    text: string,
    options?: { receivedAt?: string | number | Date },
  ) => { approved: boolean } | null;
  requireToolPolicy: (toolName: string, threadTs: string | undefined, action: string) => void;
}

export interface CreateThreadConfirmationPolicyDeps {
  getGuardrails: () => SecurityGuardrails;
  now?: () => number;
  ttlMs?: number;
}

export function createThreadConfirmationPolicy(
  deps: CreateThreadConfirmationPolicyDeps,
): ThreadConfirmationPolicy {
  const threadConfirmationStates = new Map<string, ThreadConfirmationState>();
  const getNow = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_CONFIRMATION_REQUEST_TTL_MS;

  function storeThreadConfirmationState(
    threadTs: string,
    state: ThreadConfirmationState,
    now = getNow(),
  ): ThreadConfirmationState | null {
    const normalized = normalizeThreadConfirmationState(state, now, ttlMs);

    if (isThreadConfirmationStateEmpty(normalized)) {
      threadConfirmationStates.delete(threadTs);
      return null;
    }

    threadConfirmationStates.set(threadTs, normalized);
    return normalized;
  }

  function sweepThreadConfirmationStates(now = getNow()): void {
    for (const [threadTs, state] of threadConfirmationStates) {
      storeThreadConfirmationState(threadTs, state, now);
    }
  }

  function getThreadConfirmationState(threadTs: string): ThreadConfirmationState {
    sweepThreadConfirmationStates();

    let state = threadConfirmationStates.get(threadTs);
    if (!state) {
      state = { pending: [], approved: [], rejected: [] };
      threadConfirmationStates.set(threadTs, state);
    }
    return state;
  }

  function cleanupThreadConfirmationState(threadTs: string): void {
    const state = threadConfirmationStates.get(threadTs);
    if (!state) return;
    storeThreadConfirmationState(threadTs, state);
  }

  function formatAction(action: string): string {
    return JSON.stringify(action);
  }

  function registerRequest(
    threadTs: string,
    tool: string,
    action: string,
  ): RegisterConfirmationRequestResult {
    const now = getNow();
    const result = registerThreadConfirmationRequest(
      getThreadConfirmationState(threadTs),
      {
        toolPattern: tool,
        action,
        requestedAt: now,
      },
      now,
    );
    storeThreadConfirmationState(threadTs, result.state, now);
    return {
      status: result.status,
      conflict: result.conflict,
    };
  }

  function consumeReply(
    threadTs: string,
    text: string,
    options: { receivedAt?: string | number | Date } = {},
  ): { approved: boolean } | null {
    sweepThreadConfirmationStates();
    const state = threadConfirmationStates.get(threadTs);
    if (!state || state.pending.length === 0) return null;

    const trimmed = text.trim();
    const isApproval = isConfirmationApproval(trimmed);
    const isRejection = isConfirmationRejection(trimmed);
    if (!isApproval && !isRejection) return null;

    const request = state.pending[0];
    if (!request) return null;

    if (options.receivedAt !== undefined) {
      const receivedAtMs =
        options.receivedAt instanceof Date
          ? options.receivedAt.getTime()
          : typeof options.receivedAt === "number"
            ? options.receivedAt
            : Date.parse(options.receivedAt);
      if (!Number.isFinite(receivedAtMs) || receivedAtMs < request.requestedAt) {
        return null;
      }
    }

    state.pending.shift();

    if (isApproval) {
      state.approved.push(request);
      cleanupThreadConfirmationState(threadTs);
      return { approved: true };
    }

    state.rejected.push(request);
    cleanupThreadConfirmationState(threadTs);
    return { approved: false };
  }

  function getConfirmationDecision(
    threadTs: string,
    toolName: string,
    action: string,
  ): boolean | null {
    sweepThreadConfirmationStates();
    const state = threadConfirmationStates.get(threadTs);
    if (!state) return null;

    const approved = consumeMatchingConfirmationRequest(state.approved, toolName, action);
    if (approved) {
      cleanupThreadConfirmationState(threadTs);
      return true;
    }

    const rejected = consumeMatchingConfirmationRequest(state.rejected, toolName, action);
    if (rejected) {
      cleanupThreadConfirmationState(threadTs);
      return false;
    }

    return null;
  }

  function requireToolPolicy(toolName: string, threadTs: string | undefined, action: string): void {
    const guardrails = deps.getGuardrails();
    if (isToolBlocked(toolName, guardrails)) {
      throw new Error(`Tool "${toolName}" is blocked by Slack security guardrails.`);
    }

    if (!toolNeedsConfirmation(toolName, guardrails)) {
      return;
    }

    const quotedAction = formatAction(action);
    if (!threadTs) {
      throw new Error(
        `Tool "${toolName}" requires confirmation for action ${quotedAction}. Include a thread_ts and call slack with action "confirm_action" before executing this tool.`,
      );
    }

    const decision = getConfirmationDecision(threadTs, toolName, action);
    if (decision === true) return;
    if (decision === false) {
      throw new Error(
        `Tool "${toolName}" was denied by Slack user confirmation for action ${quotedAction}.`,
      );
    }

    sweepThreadConfirmationStates();
    const state = threadConfirmationStates.get(threadTs);
    const pendingMatch =
      state?.pending.find((request) => confirmationRequestMatches(request, toolName, action)) ??
      null;
    if (pendingMatch) {
      throw new Error(
        `Tool "${toolName}" requires confirmation for action ${quotedAction}. A matching confirmation request is already pending in thread ${threadTs}; wait for the user's approval first.`,
      );
    }

    const pendingConflict = state?.pending[0];
    if (pendingConflict) {
      throw new Error(
        `Thread ${threadTs} already has a pending confirmation for tool "${pendingConflict.toolPattern}" and action ${formatAction(pendingConflict.action)}. Wait for a reply or expiry before requesting another action in the same thread.`,
      );
    }

    throw new Error(
      `Tool "${toolName}" requires confirmation for action ${quotedAction}. Call slack with action "confirm_action" in thread ${threadTs} using tool "${toolName}" and action ${quotedAction}, then wait for the user's approval first.`,
    );
  }

  return {
    formatAction,
    registerRequest,
    consumeReply,
    requireToolPolicy,
  };
}
