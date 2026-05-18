import type { InboxMessage } from "./helpers.js";

type SlackToolPolicyMessageRef = Pick<InboxMessage, "threadTs"> &
  Partial<Pick<InboxMessage, "channel">>;
import { evaluateSlackOriginCoreToolPolicy } from "./core-tool-guardrails.js";
import { evaluateSlackOriginRepoToolPolicy } from "./repo-tool-guardrails.js";
import { isBrokerForbiddenTool, type SecurityGuardrails } from "./guardrails.js";
import {
  consumePendingSlackToolPolicyTurn,
  deliverTrackedSlackFollowUpMessage as trackAndDeliverSlackFollowUpMessage,
  type PendingSlackToolPolicyTurn,
} from "./slack-turn-guardrails.js";

export interface SlackToolPolicyRuntimeDeps {
  getBrokerRole: () => "broker" | "follower" | null;
  getGuardrails: () => SecurityGuardrails;
  requireToolPolicy: (toolName: string, threadTs: string | undefined, action: string) => void;
  formatAction: (action: string) => string;
  formatError: (error: unknown) => string;
  deliverFollowUpMessage: (prompt: string) => boolean;
  beginThreadStatus?: (channel: string, threadTs: string, status: string) => Promise<void>;
  updateThreadStatus?: (channel: string, threadTs: string, status: string) => Promise<void>;
  clearThreadStatus?: (channel: string, threadTs: string) => Promise<void>;
}

export interface SlackToolPolicyRuntime {
  deliverTrackedSlackFollowUpMessage: (options: {
    prompt: string;
    messages: SlackToolPolicyMessageRef[];
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
    messages: SlackToolPolicyMessageRef[];
  }): boolean {
    return trackAndDeliverSlackFollowUpMessage({
      queue: pendingSlackToolPolicyTurns,
      prompt: options.prompt,
      messages: options.messages,
      deliver: deps.deliverFollowUpMessage,
    });
  }

  async function onInput(event: { source?: string; text: string }): Promise<void> {
    if (event.source !== "extension") {
      return;
    }

    nextSlackToolPolicyTurn = consumePendingSlackToolPolicyTurn(
      pendingSlackToolPolicyTurns,
      event.text,
    );
  }

  async function onTurnStart(): Promise<void> {
    activeSlackToolPolicyTurn = nextSlackToolPolicyTurn;
    nextSlackToolPolicyTurn = null;
    if (activeSlackToolPolicyTurn?.channel && activeSlackToolPolicyTurn.threadTs) {
      await deps
        .beginThreadStatus?.(
          activeSlackToolPolicyTurn.channel,
          activeSlackToolPolicyTurn.threadTs,
          "is thinking…",
        )
        .catch(() => {
          /* best effort */
        });
    }
  }

  async function onTurnEnd(): Promise<void> {
    const turn = activeSlackToolPolicyTurn;
    activeSlackToolPolicyTurn = null;
    if (turn?.channel && turn.threadTs) {
      await deps.clearThreadStatus?.(turn.channel, turn.threadTs).catch(() => {
        /* best effort */
      });
    }
  }

  async function onAgentEnd(): Promise<void> {
    const turn = activeSlackToolPolicyTurn;
    activeSlackToolPolicyTurn = null;
    if (turn?.channel && turn.threadTs) {
      await deps.clearThreadStatus?.(turn.channel, turn.threadTs).catch(() => {
        /* best effort */
      });
    }
  }

  async function onToolCall(event: {
    toolName: string;
    input: Record<string, unknown>;
  }): Promise<{ block: true; reason: string } | undefined> {
    if (activeSlackToolPolicyTurn?.channel && activeSlackToolPolicyTurn.threadTs) {
      await deps
        .updateThreadStatus?.(
          activeSlackToolPolicyTurn.channel,
          activeSlackToolPolicyTurn.threadTs,
          "Calling tool…",
        )
        .catch(() => {
          /* best effort */
        });
    }

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
