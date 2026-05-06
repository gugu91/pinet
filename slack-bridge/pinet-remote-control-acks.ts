import type { PinetControlCommand } from "./helpers.js";

interface PinetRemoteControlAckBuckets {
  interrupt: Set<number>;
  reload: Set<number>;
  exit: Set<number>;
}

export interface PinetRemoteControlAcksDeps {
  queueBrokerInboxIds: (inboxIds: Iterable<number>) => void;
  isBrokerConnected: () => boolean;
  markBrokerInboxIdsDelivered: (inboxIds: number[]) => void;
  queueFollowerInboxIds: (inboxIds: Iterable<number>) => void;
  markFollowerInboxIdsDelivered: (inboxIds: Iterable<number>) => void;
  flushDeliveredFollowerAcks: () => void | Promise<void>;
}

export interface PinetRemoteControlAcks {
  resetPendingRemoteControlAcks: () => void;
  deferBrokerControlAck: (command: PinetControlCommand, inboxId: number) => void;
  deferFollowerControlAck: (command: PinetControlCommand, inboxId: number) => void;
  flushDeferredRemoteControlAcks: (command: PinetControlCommand) => void;
}

function createAckBuckets(): PinetRemoteControlAckBuckets {
  return {
    interrupt: new Set<number>(),
    reload: new Set<number>(),
    exit: new Set<number>(),
  };
}

export function createPinetRemoteControlAcks(
  deps: PinetRemoteControlAcksDeps,
): PinetRemoteControlAcks {
  const pendingBrokerControlInboxIds = createAckBuckets();
  const pendingFollowerControlInboxIds = createAckBuckets();

  function resetPendingRemoteControlAcks(): void {
    pendingBrokerControlInboxIds.interrupt.clear();
    pendingBrokerControlInboxIds.reload.clear();
    pendingBrokerControlInboxIds.exit.clear();
    pendingFollowerControlInboxIds.interrupt.clear();
    pendingFollowerControlInboxIds.reload.clear();
    pendingFollowerControlInboxIds.exit.clear();
  }

  function deferBrokerControlAck(command: PinetControlCommand, inboxId: number): void {
    pendingBrokerControlInboxIds[command].add(inboxId);
    deps.queueBrokerInboxIds([inboxId]);
  }

  function deferFollowerControlAck(command: PinetControlCommand, inboxId: number): void {
    pendingFollowerControlInboxIds[command].add(inboxId);
    deps.queueFollowerInboxIds([inboxId]);
  }

  function flushDeferredRemoteControlAcks(command: PinetControlCommand): void {
    const brokerIds = [...pendingBrokerControlInboxIds[command]];
    if (brokerIds.length > 0 && deps.isBrokerConnected()) {
      deps.markBrokerInboxIdsDelivered(brokerIds);
      pendingBrokerControlInboxIds[command].clear();
    }

    const followerIds = [...pendingFollowerControlInboxIds[command]];
    if (followerIds.length > 0) {
      deps.markFollowerInboxIdsDelivered(followerIds);
      pendingFollowerControlInboxIds[command].clear();
      void deps.flushDeliveredFollowerAcks();
    }
  }

  return {
    resetPendingRemoteControlAcks,
    deferBrokerControlAck,
    deferFollowerControlAck,
    flushDeferredRemoteControlAcks,
  };
}
