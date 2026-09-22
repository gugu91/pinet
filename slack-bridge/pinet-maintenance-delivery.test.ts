import { describe, expect, it, vi } from "vitest";
import {
  createPinetMaintenanceDelivery,
  type PinetMaintenanceDeliveryAgentRecord,
  type PinetMaintenanceDeliveryBrokerDbPort,
  type PinetMaintenanceDeliveryDeps,
} from "./pinet-maintenance-delivery.js";

function createDeps(overrides: Partial<PinetMaintenanceDeliveryDeps> = {}) {
  const agents = new Map<string, PinetMaintenanceDeliveryAgentRecord>([
    ["worker-1", { id: "worker-1", name: "Worker Heron", emoji: "🪶" }],
  ]);
  const threads = new Map<string, { id: string }>();
  const createThread = vi.fn((threadId: string) => {
    threads.set(threadId, { id: threadId });
  });
  const insertMessage = vi.fn();
  const sendUserMessage = vi.fn();
  let idle = true;

  const db: PinetMaintenanceDeliveryBrokerDbPort = {
    getAgentById: (agentId) => agents.get(agentId) ?? null,
    getThread: (threadId) => threads.get(threadId) ?? null,
    createThread,
    insertMessage,
  };

  const deps: PinetMaintenanceDeliveryDeps = {
    getActiveBrokerDb: () => db,
    getActiveBrokerSelfId: () => "broker-1",
    isIdle: () => idle,
    sendUserMessage,
    ...overrides,
  };

  return {
    deps,
    db,
    agents,
    threads,
    createThread,
    insertMessage,
    sendUserMessage,
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}

describe("createPinetMaintenanceDelivery", () => {
  it("creates a broker thread when needed and inserts a maintenance nudge", () => {
    const { deps, createThread, insertMessage, threads } = createDeps();
    const pinetMaintenanceDelivery = createPinetMaintenanceDelivery(deps);

    pinetMaintenanceDelivery.sendBrokerMaintenanceMessage("worker-1", "Heads up");

    expect(createThread).toHaveBeenCalledWith("a2a:broker-1:broker-1", "agent", "", "broker-1");
    expect(threads.has("a2a:broker-1:broker-1")).toBe(true);
    expect(insertMessage).toHaveBeenCalledWith(
      "a2a:broker-1:broker-1",
      "agent",
      "outbound",
      "broker-1",
      [
        "RALPH broker-only maintenance for 🪶 Worker Heron (worker-1):",
        "",
        "Original worker-directed maintenance note (not delivered to the worker/follower Pi queue):",
        "Heads up",
      ].join("\n"),
      ["broker-1"],
      {
        kind: "ralph_loop_nudge",
        targetAgentId: "worker-1",
        brokerOnly: true,
      },
    );
  });

  it("reuses the broker-only maintenance thread and skips unknown targets", () => {
    const { deps, createThread, insertMessage, threads } = createDeps();
    threads.set("a2a:broker-1:broker-1", { id: "a2a:broker-1:broker-1" });
    const pinetMaintenanceDelivery = createPinetMaintenanceDelivery(deps);

    pinetMaintenanceDelivery.sendBrokerMaintenanceMessage("worker-1", "Follow up");
    pinetMaintenanceDelivery.sendBrokerMaintenanceMessage("missing-worker", "Ignored");

    expect(createThread).not.toHaveBeenCalled();
    expect(insertMessage).toHaveBeenCalledTimes(1);
    expect(insertMessage).toHaveBeenCalledWith(
      "a2a:broker-1:broker-1",
      "agent",
      "outbound",
      "broker-1",
      [
        "RALPH broker-only maintenance for 🪶 Worker Heron (worker-1):",
        "",
        "Original worker-directed maintenance note (not delivered to the worker/follower Pi queue):",
        "Follow up",
      ].join("\n"),
      ["broker-1"],
      {
        kind: "ralph_loop_nudge",
        targetAgentId: "worker-1",
        brokerOnly: true,
      },
    );
  });

  it("delivers broker follow-ups only through the idle prompt path", () => {
    const { deps, sendUserMessage } = createDeps();
    const onDelivered = vi.fn();
    const pinetMaintenanceDelivery = createPinetMaintenanceDelivery(deps);

    pinetMaintenanceDelivery.trySendBrokerFollowUp("Maintenance report", onDelivered);

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith("Maintenance report", {
      deliverAs: "followUp",
    });
    expect(onDelivered).toHaveBeenCalledTimes(1);
  });

  it("does not mark broker follow-ups delivered while the agent is active", () => {
    const { deps, sendUserMessage, setIdle } = createDeps();
    const onDelivered = vi.fn();
    const pinetMaintenanceDelivery = createPinetMaintenanceDelivery(deps);
    setIdle(false);

    pinetMaintenanceDelivery.trySendBrokerFollowUp("Maintenance report", onDelivered);

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(onDelivered).not.toHaveBeenCalled();
  });

  it("keeps follow-up delivery best effort when idle delivery fails", () => {
    const { deps, sendUserMessage } = createDeps();
    sendUserMessage.mockImplementation(() => {
      throw new Error("delivery failed");
    });
    const onDelivered = vi.fn();
    const pinetMaintenanceDelivery = createPinetMaintenanceDelivery(deps);

    expect(() =>
      pinetMaintenanceDelivery.trySendBrokerFollowUp("Maintenance report", onDelivered),
    ).not.toThrow();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith("Maintenance report", {
      deliverAs: "followUp",
    });
    expect(onDelivered).not.toHaveBeenCalled();
  });
});
