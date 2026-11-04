import { describe, expect, it } from "vitest";
import {
  createBrokerDeliveryState,
  discardQueuedInboxMessages,
  getBrokerInboxIds,
  isBrokerInboxIdTracked,
  markBrokerInboxIdsHandled,
  queueBrokerInboxIds,
  resetBrokerDeliveryState,
} from "./broker-delivery.js";

describe("broker delivery state", () => {
  it("tracks broker inbox ids until they are handled", () => {
    const state = createBrokerDeliveryState();

    queueBrokerInboxIds(state, [101, 102]);
    expect(isBrokerInboxIdTracked(state, 101)).toBe(true);
    expect(isBrokerInboxIdTracked(state, 102)).toBe(true);

    markBrokerInboxIdsHandled(state, [101]);
    expect(isBrokerInboxIdTracked(state, 101)).toBe(false);
    expect(isBrokerInboxIdTracked(state, 102)).toBe(true);
  });

  it("deduplicates broker inbox ids extracted from pending messages", () => {
    expect(
      getBrokerInboxIds([
        {
          channel: "",
          threadTs: "a2a:1",
          userId: "broker",
          text: "one",
          timestamp: "2026-04-02T14:05:00.000Z",
          brokerInboxId: 201,
        },
        {
          channel: "",
          threadTs: "a2a:1",
          userId: "broker",
          text: "two",
          timestamp: "2026-04-02T14:05:01.000Z",
          brokerInboxId: 201,
        },
        {
          channel: "C1",
          threadTs: "1712073599.123456",
          userId: "U1",
          text: "human",
          timestamp: "2026-04-02T14:05:02.000Z",
        },
      ]),
    ).toEqual([201]);
  });

  it("resets broker delivery state", () => {
    const state = createBrokerDeliveryState();

    queueBrokerInboxIds(state, [301]);
    resetBrokerDeliveryState(state);

    expect(isBrokerInboxIdTracked(state, 301)).toBe(false);
  });

  it.each(["broker", "subtree"] as const)(
    "discards read pointers only in the %s database",
    (origin) => {
      const base = {
        channel: "",
        threadTs: "a2a:test",
        userId: "worker",
        text: "pointer",
        timestamp: "now",
      };
      const broker = { ...base, brokerInboxId: 1 };
      const subtree = { ...base, brokerInboxId: 1, brokerInboxOrigin: "subtree" as const };
      const unread = { ...base, brokerInboxId: 2 };
      const inbox = [broker, subtree, unread, base];
      discardQueuedInboxMessages(inbox, origin, []);
      expect(inbox).toHaveLength(4);
      discardQueuedInboxMessages(inbox, origin, [1]);
      expect(inbox).toEqual([origin === "broker" ? subtree : broker, unread, base]);
    },
  );
});
