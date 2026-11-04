import type { InboxMessage } from "./helpers.js";

export interface BrokerDeliveryState {
  pendingInboxIds: Set<number>;
}

export function createBrokerDeliveryState(): BrokerDeliveryState {
  return {
    pendingInboxIds: new Set<number>(),
  };
}

export function resetBrokerDeliveryState(state: BrokerDeliveryState): void {
  state.pendingInboxIds.clear();
}

export function isBrokerInboxIdTracked(state: BrokerDeliveryState, inboxId: number): boolean {
  return state.pendingInboxIds.has(inboxId);
}

export function queueBrokerInboxIds(state: BrokerDeliveryState, inboxIds: Iterable<number>): void {
  for (const inboxId of inboxIds) {
    state.pendingInboxIds.add(inboxId);
  }
}

export function markBrokerInboxIdsHandled(
  state: BrokerDeliveryState,
  inboxIds: Iterable<number>,
): void {
  for (const inboxId of inboxIds) {
    state.pendingInboxIds.delete(inboxId);
  }
}

export function discardQueuedInboxMessages(
  inbox: InboxMessage[],
  origin: "broker" | "subtree",
  inboxIds?: number[],
): void {
  const ids = inboxIds ? new Set(inboxIds) : null;
  for (let index = inbox.length - 1; index >= 0; index--) {
    const message = inbox[index];
    if (
      (message.brokerInboxOrigin ?? "broker") === origin &&
      message.brokerInboxId != null &&
      (!ids || ids.has(message.brokerInboxId))
    )
      inbox.splice(index, 1);
  }
}

export function getBrokerInboxIds(messages: InboxMessage[]): number[] {
  return [
    ...new Set(
      messages.flatMap((message) =>
        message.brokerInboxId && message.brokerInboxOrigin !== "subtree"
          ? [message.brokerInboxId]
          : [],
      ),
    ),
  ];
}

export function getSubtreeInboxIds(messages: InboxMessage[]): number[] {
  return [
    ...new Set(
      messages.flatMap((message) =>
        message.brokerInboxId && message.brokerInboxOrigin === "subtree"
          ? [message.brokerInboxId]
          : [],
      ),
    ),
  ];
}
