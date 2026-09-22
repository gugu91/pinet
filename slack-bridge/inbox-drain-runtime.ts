import { getBrokerInboxIds, getSubtreeInboxIds } from "./broker-delivery.js";
import { markFollowerInboxIdsDelivered, type FollowerDeliveryState } from "./follower-delivery.js";
import { formatInboxMessages, type InboxMessage } from "./helpers.js";

const DEFAULT_MAX_MESSAGES_PER_DRAIN = 5;

export interface InboxDrainRuntimeDeps {
  sendUserMessage: (text: string, options: { deliverAs: "followUp" }) => void;
  isIdle: () => boolean;
  takeInboxMessages: (maxMessages?: number) => InboxMessage[];
  restoreInboxMessages: (messages: InboxMessage[]) => void;
  updateBadge: () => void;
  reportStatus: (status: "working" | "idle") => Promise<void>;
  userNames: { get: (key: string) => string | undefined };
  getSecurityPrompt: () => string;
  deliverTrackedSlackFollowUpMessage: (options: {
    prompt: string;
    messages: Pick<InboxMessage, "threadTs">[];
    fromSettle?: boolean;
  }) => boolean;
  getBrokerRole: () => "broker" | "follower" | null;
  hasFollowerClient: () => boolean;
  flushFollowerDeliveredAcks: () => Promise<void>;
  markBrokerInboxIdsDelivered: (inboxIds: number[]) => void;
  markSubtreeInboxIdsDelivered: (inboxIds: number[]) => void;
  getFollowerDeliveryState: () => FollowerDeliveryState;
  maxMessagesPerDrain?: number;
}

export interface InboxDrainRuntime {
  deliverFollowUpMessage: (text: string, options?: { fromSettle?: boolean }) => boolean;
  flushDeliveredFollowerAcks: () => Promise<void>;
  drainInbox: (options?: { fromSettle?: boolean }) => void;
}

export function createInboxDrainRuntime(deps: InboxDrainRuntimeDeps): InboxDrainRuntime {
  function deliverFollowUpMessage(text: string, options: { fromSettle?: boolean } = {}): boolean {
    if (!options.fromSettle && !deps.isIdle()) {
      return false;
    }

    try {
      deps.sendUserMessage(text, { deliverAs: "followUp" });
      return true;
    } catch {
      return false;
    }
  }

  async function flushDeliveredFollowerAcks(): Promise<void> {
    if (deps.getBrokerRole() !== "follower" || !deps.hasFollowerClient()) {
      return;
    }

    await deps.flushFollowerDeliveredAcks();
  }

  function drainInbox(options: { fromSettle?: boolean } = {}): void {
    if (!options.fromSettle && !deps.isIdle()) {
      return;
    }

    const maxMessages = deps.maxMessagesPerDrain ?? DEFAULT_MAX_MESSAGES_PER_DRAIN;
    const pending = deps.takeInboxMessages(maxMessages);
    if (pending.length === 0) {
      return;
    }

    const brokerInboxIds = getBrokerInboxIds(pending);
    const subtreeInboxIds = getSubtreeInboxIds(pending);
    deps.updateBadge();
    void deps.reportStatus("working").catch(() => {
      /* best effort */
    });

    let prompt = formatInboxMessages(pending, deps.userNames);
    const securityPrompt = deps.getSecurityPrompt();
    if (securityPrompt) {
      prompt = `${securityPrompt}\n\n${prompt}`;
    }

    if (
      deps.deliverTrackedSlackFollowUpMessage({
        prompt,
        messages: pending,
        ...(options.fromSettle ? { fromSettle: true } : {}),
      })
    ) {
      if (brokerInboxIds.length > 0) {
        if (deps.getBrokerRole() === "follower") {
          markFollowerInboxIdsDelivered(deps.getFollowerDeliveryState(), brokerInboxIds);
          void flushDeliveredFollowerAcks();
        } else if (deps.getBrokerRole() === "broker") {
          try {
            deps.markBrokerInboxIdsDelivered(brokerInboxIds);
          } catch {
            /* best effort */
          }
        }
      }
      if (subtreeInboxIds.length > 0) {
        deps.markSubtreeInboxIdsDelivered(subtreeInboxIds);
      }
      return;
    }

    deps.restoreInboxMessages(pending);
    deps.updateBadge();
  }

  return {
    deliverFollowUpMessage,
    flushDeliveredFollowerAcks,
    drainInbox,
  };
}
