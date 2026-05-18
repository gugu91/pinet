import type { InboxMessage } from "./helpers.js";

type SlackTurnMessageRef = Pick<InboxMessage, "threadTs"> & Partial<Pick<InboxMessage, "channel">>;

export interface PendingSlackToolPolicyTurn {
  prompt: string;
  threadTs: string | undefined;
  channel: string | undefined;
  threadCount: number;
}

export function buildPendingSlackToolPolicyTurn(
  prompt: string,
  messages: SlackTurnMessageRef[],
): PendingSlackToolPolicyTurn {
  const threadIds = [...new Set(messages.map((message) => message.threadTs).filter(Boolean))];
  const channels = [...new Set(messages.map((message) => message.channel).filter(Boolean))];
  return {
    prompt,
    threadTs: threadIds.length === 1 ? threadIds[0] : undefined,
    channel: channels.length === 1 ? channels[0] : undefined,
    threadCount: threadIds.length,
  };
}

export function enqueuePendingSlackToolPolicyTurn(
  queue: PendingSlackToolPolicyTurn[],
  prompt: string,
  messages: SlackTurnMessageRef[],
): PendingSlackToolPolicyTurn {
  const entry = buildPendingSlackToolPolicyTurn(prompt, messages);
  queue.push(entry);
  return entry;
}

export function consumePendingSlackToolPolicyTurn(
  queue: PendingSlackToolPolicyTurn[],
  text: string,
): PendingSlackToolPolicyTurn | null {
  const index = queue.findIndex((entry) => entry.prompt === text);
  if (index < 0) return null;
  const [entry] = queue.splice(index, 1);
  return entry ?? null;
}

export function removePendingSlackToolPolicyTurn(
  queue: PendingSlackToolPolicyTurn[],
  entry: PendingSlackToolPolicyTurn,
): void {
  const index = queue.indexOf(entry);
  if (index >= 0) {
    queue.splice(index, 1);
  }
}

export function deliverTrackedSlackFollowUpMessage(options: {
  queue: PendingSlackToolPolicyTurn[];
  prompt: string;
  messages: SlackTurnMessageRef[];
  deliver: (prompt: string) => boolean;
}): boolean {
  const entry = enqueuePendingSlackToolPolicyTurn(options.queue, options.prompt, options.messages);
  if (options.deliver(options.prompt)) {
    return true;
  }
  removePendingSlackToolPolicyTurn(options.queue, entry);
  return false;
}
