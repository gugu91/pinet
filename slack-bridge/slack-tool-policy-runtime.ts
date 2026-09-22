import type { MessageStartEvent } from "@earendil-works/pi-coding-agent";
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
  deliverFollowUpMessage: (prompt: string, options?: { fromSettle?: boolean }) => boolean;
  beginThreadStatus?: (channel: string, threadTs: string, status: string) => Promise<void>;
  updateThreadStatus?: (channel: string, threadTs: string, status: string) => Promise<void>;
  clearThreadStatus?: (channel: string, threadTs: string) => Promise<void>;
}

export interface SlackToolPolicyRuntime {
  deliverTrackedSlackFollowUpMessage: (options: {
    prompt: string;
    messages: SlackToolPolicyMessageRef[];
    fromSettle?: boolean;
  }) => boolean;
  onTurnStart: () => Promise<void>;
  onMessageStart: (event: MessageStartEvent) => Promise<void>;
  onTurnEnd: () => Promise<void>;
  onAgentEnd: () => Promise<void>;
  onAgentSettled: () => Promise<void>;
  onToolCall: (event: {
    toolName: string;
    input: Record<string, unknown>;
  }) => Promise<{ block: true; reason: string } | undefined>;
}

export function createSlackToolPolicyRuntime(
  deps: SlackToolPolicyRuntimeDeps,
): SlackToolPolicyRuntime {
  const pendingSlackToolPolicyTurns: PendingSlackToolPolicyTurn[] = [];
  const visibleThreadStatuses = new Map<
    string,
    { channel: string; threadTs: string; generation: number }
  >();
  let activeSlackToolPolicyTurn: PendingSlackToolPolicyTurn | null = null;
  let statusGeneration = 0;

  function deliverTrackedSlackFollowUpMessage(options: {
    prompt: string;
    messages: SlackToolPolicyMessageRef[];
    fromSettle?: boolean;
  }): boolean {
    return trackAndDeliverSlackFollowUpMessage({
      queue: pendingSlackToolPolicyTurns,
      prompt: options.prompt,
      messages: options.messages,
      deliver: (prompt) =>
        options.fromSettle
          ? deps.deliverFollowUpMessage(prompt, { fromSettle: true })
          : deps.deliverFollowUpMessage(prompt),
    });
  }

  async function onTurnStart(): Promise<void> {
    activeSlackToolPolicyTurn = null;
  }

  async function onMessageStart(event: MessageStartEvent): Promise<void> {
    if (event.message.role !== "user") {
      return;
    }

    const content = event.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("");
    activeSlackToolPolicyTurn = consumePendingSlackToolPolicyTurn(
      pendingSlackToolPolicyTurns,
      text,
    );
    if (activeSlackToolPolicyTurn?.channel && activeSlackToolPolicyTurn.threadTs) {
      const { channel, threadTs } = activeSlackToolPolicyTurn;
      statusGeneration += 1;
      visibleThreadStatuses.set(`${channel}:${threadTs}`, {
        channel,
        threadTs,
        generation: statusGeneration,
      });
      await deps.beginThreadStatus?.(channel, threadTs, "is thinking…").catch(() => {
        /* best effort */
      });
    }
  }

  async function onTurnEnd(): Promise<void> {
    activeSlackToolPolicyTurn = null;
  }

  async function onAgentEnd(): Promise<void> {
    activeSlackToolPolicyTurn = null;
  }

  async function onAgentSettled(): Promise<void> {
    activeSlackToolPolicyTurn = null;
    const settledGeneration = statusGeneration;
    const settlingStatuses = [...visibleThreadStatuses.entries()].filter(
      ([, status]) => status.generation <= settledGeneration,
    );
    for (const [key, status] of settlingStatuses) {
      if (visibleThreadStatuses.get(key)?.generation !== status.generation) continue;
      await deps.clearThreadStatus?.(status.channel, status.threadTs).catch(() => {
        /* best effort */
      });
      if (visibleThreadStatuses.get(key)?.generation === status.generation) {
        visibleThreadStatuses.delete(key);
      }
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
    onTurnStart,
    onMessageStart,
    onTurnEnd,
    onAgentEnd,
    onAgentSettled,
    onToolCall,
  };
}
