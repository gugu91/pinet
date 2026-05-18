import type { PinetReadResult } from "@gugu910/pi-pinet-core/pinet-read-formatting";

export type ConsumePinetConfirmationReply = (
  threadTs: string,
  text: string,
) => { approved: boolean } | null;

export function consumePinetReadConfirmationReplies(
  result: PinetReadResult,
  consumeReply: ConsumePinetConfirmationReply,
): PinetReadResult {
  if (result.markedReadIds.length === 0) return result;

  const markedReadIds = new Set(result.markedReadIds);

  return {
    ...result,
    messages: result.messages.map((item) => {
      if (
        !markedReadIds.has(item.inboxId) ||
        item.message.source !== "slack" ||
        item.message.direction !== "inbound"
      ) {
        return item;
      }

      const confirmationResult = consumeReply(item.message.threadId, item.message.body);
      if (confirmationResult === null) return item;

      const suffix = confirmationResult.approved
        ? "✅ User approved security confirmation request in this thread."
        : "❌ User denied security confirmation request in this thread.";

      return {
        ...item,
        message: {
          ...item.message,
          body: `${item.message.body}\n\n${suffix}`,
        },
      };
    }),
  };
}
