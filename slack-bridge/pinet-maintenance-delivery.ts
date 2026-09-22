export interface PinetMaintenanceDeliveryAgentRecord {
  id: string;
  name?: string;
  emoji?: string;
}

export interface PinetMaintenanceDeliveryBrokerDbPort {
  getAgentById: (agentId: string) => PinetMaintenanceDeliveryAgentRecord | null;
  getThread: (threadId: string) => unknown;
  createThread: (threadId: string, source: string, channel: string, owner: string) => void;
  insertMessage: (
    threadId: string,
    source: string,
    direction: "outbound" | "inbound",
    sender: string,
    body: string,
    recipients: string[],
    metadata?: Record<string, unknown>,
  ) => void;
}

export interface PinetMaintenanceDeliveryDeps {
  getActiveBrokerDb: () => PinetMaintenanceDeliveryBrokerDbPort | null;
  getActiveBrokerSelfId: () => string | null;
  isIdle: () => boolean;
  sendUserMessage: (body: string, options: { deliverAs: "followUp" }) => void;
}

export interface PinetMaintenanceDelivery {
  sendBrokerMaintenanceMessage: (targetAgentId: string, body: string) => void;
  trySendBrokerFollowUp: (body: string, onDelivered: () => void) => void;
}

function formatBrokerOnlyMaintenanceMessage(
  target: PinetMaintenanceDeliveryAgentRecord,
  body: string,
): string {
  const label = [target.emoji, target.name].filter(Boolean).join(" ") || target.id;
  return [
    `RALPH broker-only maintenance for ${label} (${target.id}):`,
    "",
    "Original worker-directed maintenance note (not delivered to the worker/follower Pi queue):",
    body,
  ].join("\n");
}

export function createPinetMaintenanceDelivery(
  deps: PinetMaintenanceDeliveryDeps,
): PinetMaintenanceDelivery {
  function sendBrokerMaintenanceMessage(targetAgentId: string, body: string): void {
    const db = deps.getActiveBrokerDb();
    const selfId = deps.getActiveBrokerSelfId();
    if (!db || !selfId) return;
    const target = db.getAgentById(targetAgentId);
    if (!target) return;

    const threadId = `a2a:${selfId}:${selfId}`;
    if (!db.getThread(threadId)) {
      db.createThread(threadId, "agent", "", selfId);
    }

    db.insertMessage(
      threadId,
      "agent",
      "outbound",
      selfId,
      formatBrokerOnlyMaintenanceMessage(target, body),
      [selfId],
      {
        kind: "ralph_loop_nudge",
        targetAgentId: target.id,
        brokerOnly: true,
      },
    );
  }

  function trySendBrokerFollowUp(body: string, onDelivered: () => void): void {
    if (!deps.isIdle()) {
      return;
    }

    try {
      deps.sendUserMessage(body, { deliverAs: "followUp" });
      onDelivered();
    } catch {
      /* best effort */
    }
  }

  return {
    sendBrokerMaintenanceMessage,
    trySendBrokerFollowUp,
  };
}
