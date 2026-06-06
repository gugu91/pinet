import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Broker } from "./broker/index.js";
import type { MessageRouter } from "./broker/router.js";
import type { InboundMessage, MessageAdapter, OutboundMessage } from "./broker/types.js";
import {
  buildPinetRuntimeAdapterBindings,
  connectPinetRuntimeAdapters,
} from "./pinet-runtime-composition.js";

class MemoryAdapter implements MessageAdapter {
  private inboundHandler: ((message: InboundMessage) => void) | null = null;
  connected = false;

  constructor(readonly name: string) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  onInbound(handler: (message: InboundMessage) => void): void {
    this.inboundHandler = handler;
  }

  async send(_message: OutboundMessage): Promise<void> {
    return undefined;
  }

  emit(message: InboundMessage): void {
    this.inboundHandler?.(message);
  }
}

describe("Pinet runtime composition", () => {
  it("builds adapter bindings from injected factories without Slack adapter assumptions", async () => {
    const matrixAdapter = new MemoryAdapter("matrix");
    const broker = {} as Broker;
    const router = {} as MessageRouter;
    const ctx = {} as ExtensionContext;

    const bindings = await buildPinetRuntimeAdapterBindings(
      [
        ({ broker: seenBroker, router: seenRouter, ctx: seenCtx, selfId }) => {
          expect(seenBroker).toBe(broker);
          expect(seenRouter).toBe(router);
          expect(seenCtx).toBe(ctx);
          expect(selfId).toBe("broker-self");
          return { adapter: matrixAdapter };
        },
      ],
      { broker, router, selfId: "broker-self", ctx },
    );

    expect(bindings).toEqual([{ adapter: matrixAdapter }]);
  });

  it("connects a non-Slack adapter at the Pinet core composition boundary", async () => {
    const matrixAdapter = new MemoryAdapter("matrix");
    const addAdapter = vi.fn();
    const inbound: InboundMessage[] = [];

    const result = await connectPinetRuntimeAdapters({
      broker: { addAdapter },
      bindings: [
        {
          adapter: matrixAdapter,
          getBotUserId: () => "matrix-bot",
        },
      ],
      onInbound: (message) => inbound.push(message),
    });

    const message: InboundMessage = {
      source: "matrix",
      threadId: "room-1/thread-1",
      channel: "room-1",
      userId: "user-1",
      text: "hello from another transport",
      timestamp: "2026-06-03T09:00:00.000Z",
    };
    matrixAdapter.emit(message);

    expect(addAdapter).toHaveBeenCalledWith(matrixAdapter);
    expect(matrixAdapter.connected).toBe(true);
    expect(inbound).toEqual([message]);
    expect(result.botUserId).toBe("matrix-bot");
  });
});
