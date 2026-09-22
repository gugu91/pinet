import { describe, expect, it, vi } from "vitest";
import { createFollowerDeliveryState } from "./follower-delivery.js";
import { formatInboxMessages, type InboxMessage } from "./helpers.js";
import { createInboxDrainRuntime, type InboxDrainRuntimeDeps } from "./inbox-drain-runtime.js";

function createMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    channel: "C123",
    threadTs: "100.1",
    userId: "U123",
    text: "hello",
    timestamp: "100.2",
    ...overrides,
  };
}

function createDeps(overrides: Partial<InboxDrainRuntimeDeps> = {}) {
  const inbox: InboxMessage[] = [];
  const sendUserMessage = vi.fn();
  const updateBadge = vi.fn();
  const reportStatus = vi.fn(async () => {});
  const userNames = new Map<string, string>([["U123", "Ada"]]);
  const deliverTrackedSlackFollowUpMessage = vi.fn(() => true);
  const flushFollowerDeliveredAcks = vi.fn(async () => {});
  const markBrokerInboxIdsDelivered = vi.fn();
  const markSubtreeInboxIdsDelivered = vi.fn();
  let securityPrompt = "";
  let brokerRole: "broker" | "follower" | null = null;
  let followerClient = true;
  let idle = true;
  const followerDeliveryState = createFollowerDeliveryState();

  const deps: InboxDrainRuntimeDeps = {
    sendUserMessage,
    isIdle: () => idle,
    takeInboxMessages: (maxMessages) => inbox.splice(0, maxMessages ?? inbox.length),
    restoreInboxMessages: (messages) => {
      inbox.push(...messages);
    },
    updateBadge,
    reportStatus,
    userNames,
    getSecurityPrompt: () => securityPrompt,
    deliverTrackedSlackFollowUpMessage,
    getBrokerRole: () => brokerRole,
    hasFollowerClient: () => followerClient,
    flushFollowerDeliveredAcks,
    markBrokerInboxIdsDelivered,
    markSubtreeInboxIdsDelivered,
    getFollowerDeliveryState: () => followerDeliveryState,
    ...overrides,
  };

  const runtime = createInboxDrainRuntime(deps);

  return {
    runtime,
    inbox,
    sendUserMessage,
    updateBadge,
    reportStatus,
    userNames,
    deliverTrackedSlackFollowUpMessage,
    flushFollowerDeliveredAcks,
    markBrokerInboxIdsDelivered,
    markSubtreeInboxIdsDelivered,
    followerDeliveryState,
    setSecurityPrompt: (value: string) => {
      securityPrompt = value;
    },
    setBrokerRole: (value: "broker" | "follower" | null) => {
      brokerRole = value;
    },
    setFollowerClient: (value: boolean) => {
      followerClient = value;
    },
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}

describe("createInboxDrainRuntime", () => {
  it("delivers held follow-up messages only through the idle prompt path", () => {
    const { runtime, sendUserMessage } = createDeps();

    expect(runtime.deliverFollowUpMessage("steady note")).toBe(true);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith("steady note", { deliverAs: "followUp" });
  });

  it("does not inject follow-up messages while the agent is active", () => {
    const { runtime, sendUserMessage, setIdle } = createDeps();
    setIdle(false);

    expect(runtime.deliverFollowUpMessage("steady note")).toBe(false);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("returns false when idle prompt delivery fails", () => {
    const { runtime, sendUserMessage } = createDeps();
    sendUserMessage.mockImplementation(() => {
      throw new Error("send failed");
    });

    expect(runtime.deliverFollowUpMessage("steady note")).toBe(false);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith("steady note", { deliverAs: "followUp" });
  });

  it("formats pending inbox work, applies security guidance, and flushes follower acks", () => {
    const {
      runtime,
      inbox,
      updateBadge,
      reportStatus,
      userNames,
      deliverTrackedSlackFollowUpMessage,
      flushFollowerDeliveredAcks,
      followerDeliveryState,
      markBrokerInboxIdsDelivered,
      setSecurityPrompt,
      setBrokerRole,
    } = createDeps();
    const message = createMessage({ brokerInboxId: 42 });
    inbox.push(message);
    setSecurityPrompt("SECURITY FIRST");
    setBrokerRole("follower");

    runtime.drainInbox();

    expect(updateBadge).toHaveBeenCalledTimes(1);
    expect(reportStatus).toHaveBeenCalledWith("working");
    expect(deliverTrackedSlackFollowUpMessage).toHaveBeenCalledWith({
      prompt: `SECURITY FIRST\n\n${formatInboxMessages([message], userNames)}`,
      messages: [message],
    });
    expect(followerDeliveryState.deliveredAwaitingAckIds.has(42)).toBe(true);
    expect(flushFollowerDeliveredAcks).toHaveBeenCalledTimes(1);
    expect(markBrokerInboxIdsDelivered).not.toHaveBeenCalled();
    expect(inbox).toEqual([]);
  });

  it("marks broker inbox ids delivered after a successful broker-side drain", () => {
    const {
      runtime,
      inbox,
      markBrokerInboxIdsDelivered,
      setBrokerRole,
      flushFollowerDeliveredAcks,
    } = createDeps();
    inbox.push(createMessage({ brokerInboxId: 77 }));
    setBrokerRole("broker");

    runtime.drainInbox();

    expect(markBrokerInboxIdsDelivered).toHaveBeenCalledWith([77]);
    expect(flushFollowerDeliveredAcks).not.toHaveBeenCalled();
  });

  it("acknowledges subtree ids only through the subtree runtime", () => {
    const {
      runtime,
      inbox,
      markBrokerInboxIdsDelivered,
      markSubtreeInboxIdsDelivered,
      setBrokerRole,
    } = createDeps();
    inbox.push(
      createMessage({ brokerInboxId: 77 }),
      createMessage({ brokerInboxId: 78, brokerInboxOrigin: "subtree" }),
    );
    setBrokerRole("broker");

    runtime.drainInbox();

    expect(markBrokerInboxIdsDelivered).toHaveBeenCalledWith([77]);
    expect(markSubtreeInboxIdsDelivered).toHaveBeenCalledWith([78]);
  });

  it("does not drain inbox work while the agent is active", () => {
    const {
      runtime,
      inbox,
      updateBadge,
      reportStatus,
      deliverTrackedSlackFollowUpMessage,
      setIdle,
    } = createDeps();
    const message = createMessage({ brokerInboxId: 87 });
    inbox.push(message);
    setIdle(false);

    runtime.drainInbox();

    expect(updateBadge).not.toHaveBeenCalled();
    expect(reportStatus).not.toHaveBeenCalled();
    expect(deliverTrackedSlackFollowUpMessage).not.toHaveBeenCalled();
    expect(inbox).toEqual([message]);
  });

  it("requeues pending inbox work when the follow-up delivery is not accepted", () => {
    const { runtime, inbox, updateBadge, reportStatus, markSubtreeInboxIdsDelivered } = createDeps({
      deliverTrackedSlackFollowUpMessage: vi.fn(() => false),
    });
    const message = createMessage({
      brokerInboxId: 88,
      brokerInboxOrigin: "subtree",
    });
    inbox.push(message);

    runtime.drainInbox();

    expect(reportStatus).toHaveBeenCalledWith("working");
    expect(updateBadge).toHaveBeenCalledTimes(2);
    expect(markSubtreeInboxIdsDelivered).not.toHaveBeenCalled();
    expect(inbox).toEqual([message]);
  });

  it("limits each inbox drain batch and preserves remaining messages", () => {
    const { runtime, inbox, deliverTrackedSlackFollowUpMessage } = createDeps({
      maxMessagesPerDrain: 2,
    });
    const first = createMessage({ text: "first" });
    const second = createMessage({ text: "second" });
    const third = createMessage({ text: "third" });
    inbox.push(first, second, third);

    runtime.drainInbox();

    expect(deliverTrackedSlackFollowUpMessage).toHaveBeenCalledWith({
      prompt: formatInboxMessages([first, second], new Map<string, string>([["U123", "Ada"]])),
      messages: [first, second],
    });
    expect(inbox).toEqual([third]);
  });

  it("only flushes follower acks when follower delivery is still live", async () => {
    const { runtime, flushFollowerDeliveredAcks, setBrokerRole, setFollowerClient } = createDeps();

    await runtime.flushDeliveredFollowerAcks();
    expect(flushFollowerDeliveredAcks).not.toHaveBeenCalled();

    setBrokerRole("follower");
    setFollowerClient(false);
    await runtime.flushDeliveredFollowerAcks();
    expect(flushFollowerDeliveredAcks).not.toHaveBeenCalled();

    setFollowerClient(true);
    await runtime.flushDeliveredFollowerAcks();
    expect(flushFollowerDeliveredAcks).toHaveBeenCalledTimes(1);
  });
});
