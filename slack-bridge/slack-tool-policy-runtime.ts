import type { InboxMessage } from "./helpers.js";
import { evaluateSlackOriginCoreToolPolicy } from "./core-tool-guardrails.js";
import { evaluateSlackOriginRepoToolPolicy } from "./repo-tool-guardrails.js";
import { isBrokerForbiddenTool, type SecurityGuardrails } from "./guardrails.js";
import {
  consumePendingSlackToolPolicyTurn,
  enqueuePendingSlackToolPolicyTurn,
  removePendingSlackToolPolicyTurn,
  type PendingSlackToolPolicyTurn,
} from "./slack-turn-guardrails.js";

export interface SlackToolPolicyRuntimeDeps {
  getBrokerRole: () => "broker" | "follower" | null;
  getGuardrails: () => SecurityGuardrails;
  requireToolPolicy: (toolName: string, threadTs: string | undefined, action: string) => void;
  formatAction: (action: string) => string;
  formatError: (error: unknown) => string;
  deliverFollowUpMessage: (prompt: string) => boolean;
}

export interface SlackToolPolicyRuntime {
  deliverTrackedSlackFollowUpMessage: (options: {
    prompt: string;
    messages: Pick<InboxMessage, "threadTs">[];
  }) => boolean;
  onInput: (event: { source?: string; text: string }) => Promise<void>;
  onTurnStart: () => Promise<void>;
  onTurnEnd: () => Promise<void>;
  onAgentEnd: () => Promise<void>;
  onToolCall: (event: {
    toolName: string;
    input: Record<string, unknown>;
  }) => Promise<{ block: true; reason: string } | undefined>;
}

export function createSlackToolPolicyRuntime(
  deps: SlackToolPolicyRuntimeDeps,
): SlackToolPolicyRuntime {
  const pendingSlackToolPolicyTurns: PendingSlackToolPolicyTurn[] = [];
  let nextSlackToolPolicyTurn: PendingSlackToolPolicyTurn | null = null;
  let activeSlackToolPolicyTurn: PendingSlackToolPolicyTurn | null = null;

  function deliverTrackedSlackFollowUpMessage(options: {
    prompt: string;
    messages: Pick<InboxMessage, "threadTs">[];
  }): boolean {
    const entry = enqueuePendingSlackToolPolicyTurn(
      pendingSlackToolPolicyTurns,
      options.prompt,
      options.messages,
    );

    if (deps.deliverFollowUpMessage(options.prompt)) {
      removePendingSlackToolPolicyTurn(pendingSlackToolPolicyTurns, entry);
      nextSlackToolPolicyTurn = entry;
      return true;
    }

    removePendingSlackToolPolicyTurn(pendingSlackToolPolicyTurns, entry);
    return false;
  }

  async function onInput(event: { source?: string; text: string }): Promise<void> {
    if (event.source !== "extension") {
      return;
    }

    const consumedTurn = consumePendingSlackToolPolicyTurn(pendingSlackToolPolicyTurns, event.text);
    if (consumedTurn) {
      nextSlackToolPolicyTurn = consumedTurn;
    }
  }

  async function onTurnStart(): Promise<void> {
    activeSlackToolPolicyTurn = nextSlackToolPolicyTurn;
    nextSlackToolPolicyTurn = null;
  }

  async function onTurnEnd(): Promise<void> {
    activeSlackToolPolicyTurn = null;
  }

  async function onAgentEnd(): Promise<void> {
    activeSlackToolPolicyTurn = null;
  }

  async function onToolCall(event: {
    toolName: string;
    input: Record<string, unknown>;
  }): Promise<{ block: true; reason: string } | undefined> {
    if (deps.getBrokerRole() === "broker" && isBrokerForbiddenTool(event.toolName)) {
      return {
        block: true,
        reason: `Tool "${event.toolName}" is forbidden for the broker role. The broker coordinates — it does not code. Use pinet action=send to delegate to a connected worker instead.`,
      };
    }

    const corePolicy = evaluateSlackOriginCoreToolPolicy({
      turn: activeSlackToolPolicyTurn,
      toolName: event.toolName,
      input: event.input,
      guardrails: deps.getGuardrails(),
      requireToolPolicy: deps.requireToolPolicy,
      formatAction: deps.formatAction,
      formatError: deps.formatError,
    });
    if (corePolicy) {
      return corePolicy;
    }

    return evaluateSlackOriginRepoToolPolicy({
      turn: activeSlackToolPolicyTurn,
      toolName: event.toolName,
      input: event.input,
      guardrails: deps.getGuardrails(),
      requireToolPolicy: deps.requireToolPolicy,
      formatAction: deps.formatAction,
      formatError: deps.formatError,
    });
  }

  return {
    deliverTrackedSlackFollowUpMessage,
    onInput,
    onTurnStart,
    onTurnEnd,
    onAgentEnd,
    onToolCall,
  };
}
