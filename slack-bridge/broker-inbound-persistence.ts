import type {
  BrokerMessage,
  DeliveredInboundMessageResult,
  InboundMessage,
} from "@pinet/broker-core/types";

export interface DeliveredInboundPersistenceStore {
  queueDeliveredMessage(agentId: string, message: InboundMessage): DeliveredInboundMessageResult;
}

export interface PersistedInboundNotification {
  result: DeliveredInboundMessageResult;
  notificationText: string;
}

export function buildPinetReadPointer(threadId: string): string {
  const trimmed = threadId.trim();
  const parts = [
    "pointer=pinet action=read",
    trimmed ? `args.thread_id=${trimmed}` : null,
    "args.unread_only=true",
  ].filter((part): part is string => Boolean(part));
  return parts.join(" ");
}

export function buildPersistedInboundNotificationText(message: BrokerMessage): string {
  return [
    `Durable ${message.source} mail stored as #${message.id}.`,
    buildPinetReadPointer(message.threadId),
  ].join(" ");
}

export function persistDeliveredInboundMessage(
  store: DeliveredInboundPersistenceStore,
  agentId: string,
  message: InboundMessage,
): PersistedInboundNotification {
  const result = store.queueDeliveredMessage(agentId, message);
  return {
    result,
    notificationText: buildPersistedInboundNotificationText(result.message),
  };
}
