import { describe, expect, it, vi } from "vitest";
import type { DeliveredInboundMessageResult, InboundMessage } from "@pinet/broker-core/types";
import {
  buildPersistedInboundNotificationText,
  buildPinetReadPointer,
  persistDeliveredInboundMessage,
  type DeliveredInboundPersistenceStore,
} from "./broker-inbound-persistence.js";

const message: InboundMessage = {
  source: "slack",
  threadId: "123.456",
  channel: "C123",
  userId: "U1",
  text: "hello",
  timestamp: "123.456",
};

const delivered: DeliveredInboundMessageResult = {
  entry: {
    id: 7,
    agentId: "broker",
    messageId: 42,
    delivered: true,
    readAt: null,
    createdAt: "2026-04-28T00:00:00.000Z",
  },
  message: {
    id: 42,
    threadId: "123.456",
    source: "slack",
    direction: "inbound",
    sender: "U1",
    body: "hello",
    metadata: { channel: "C123", timestamp: "123.456" },
    createdAt: "2026-04-28T00:00:00.000Z",
    externalId: "C123:123.456",
    externalTs: "123.456",
  },
  freshDelivery: true,
};

describe("broker inbound persistence", () => {
  it("builds compact dispatcher read pointers for durable inbound mail", () => {
    expect(buildPinetReadPointer("123.456")).toBe(
      "pointer=pinet action=read args.thread_id=123.456 args.unread_only=true",
    );
    expect(buildPersistedInboundNotificationText(delivered.message)).toContain(
      "Durable slack mail stored as #42.",
    );
    expect(buildPersistedInboundNotificationText(delivered.message)).toContain(
      "pointer=pinet action=read args.thread_id=123.456 args.unread_only=true",
    );
  });

  it("persists delivered inbound mail through the store before notification", () => {
    const store: DeliveredInboundPersistenceStore = {
      queueDeliveredMessage: vi.fn(() => delivered),
    };

    const result = persistDeliveredInboundMessage(store, "broker", message);

    expect(store.queueDeliveredMessage).toHaveBeenCalledWith("broker", message);
    expect(result.result).toBe(delivered);
    expect(result.notificationText).toBe(
      "Durable slack mail stored as #42. pointer=pinet action=read args.thread_id=123.456 args.unread_only=true",
    );
  });
});
