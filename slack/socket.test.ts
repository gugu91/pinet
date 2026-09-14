import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackSocketModeClient } from "./socket.js";

type Listener = (event?: { data: string }) => void;
class FakeSocket {
  readonly listeners = new Map<string, Listener>();
  readonly sent: string[] = [];
  closed = false;
  send(value: string): void {
    this.sent.push(value);
  }
  close(): void {
    this.closed = true;
    this.listeners.get("close")?.();
  }
  addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, listener);
  }
  emit(name: string, event?: { data: string }): void {
    this.listeners.get(name)?.(event);
  }
}
afterEach(() => vi.useRealTimers());

describe("Slack Socket Mode lifecycle", () => {
  it.each(["stop", "restart", "restart-rejection"])(
    "fences pending connections after %s",
    async (mode) => {
      vi.useFakeTimers();
      let resolve!: (response: Response) => void;
      let reject!: (cause: Error) => void;
      const pending = new Promise<Response>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      const transport = vi
        .fn()
        .mockReturnValueOnce(pending)
        .mockImplementation(async () => Response.json({ ok: true, url: "wss://current.test" }));
      const sockets: FakeSocket[] = [];
      const factory = vi.fn(() => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      });
      const adapter = { enqueue: vi.fn(), drain: vi.fn(async () => {}) };
      const client = new SlackSocketModeClient(
        "app-token",
        adapter as never,
        transport,
        factory as never,
      );
      const starting = client.start();
      client.stop();
      if (mode !== "stop") await client.start();
      if (mode === "restart-rejection") reject(new Error("stale connection failure"));
      else resolve(Response.json({ ok: true, url: "wss://stale.test" }));
      await starting;
      expect(factory).toHaveBeenCalledTimes(mode === "stop" ? 0 : 1);
      if (mode !== "stop") {
        expect(factory).toHaveBeenCalledWith("wss://current.test");
        expect(sockets[0]!.closed).toBe(false);
      }
      expect(vi.getTimerCount()).toBe(0);
      client.stop();
      expect(sockets.every((socket) => socket.closed)).toBe(true);
    },
  );
  it("retries initial failure, acknowledges messages, resets after open, and reconnects", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(Response.json({ ok: true, url: "wss://socket.test" }));
    const receive = vi.fn(async (_message?: object) => ({ status: "ignored" }));
    const queue: object[] = [];
    const adapter = {
      enqueue: (message: object) => queue.push(message),
      drain: vi.fn(async () => {
        while (queue.length) await receive(queue.shift());
      }),
    };
    const client = new SlackSocketModeClient("app-token", adapter as never, transport, (() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }) as never);
    await client.start();
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport).toHaveBeenCalledTimes(2);
    const socket = sockets[0]!;
    socket.emit("open");
    socket.emit("message", {
      data: JSON.stringify({
        envelope_id: "unsupported",
        payload: { event: { type: "app_mention", channel: "C", ts: "0", user: "U" } },
      }),
    });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(queue).toHaveLength(0);
    expect(receive).not.toHaveBeenCalled();
    socket.emit("message", {
      data: JSON.stringify({
        envelope_id: "envelope",
        payload: {
          event: { type: "message", channel: "C", ts: "1", text: "hello", user: "U" },
        },
      }),
    });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    expect(socket.sent).toEqual([
      JSON.stringify({ envelope_id: "unsupported" }),
      JSON.stringify({ envelope_id: "envelope" }),
    ]);
    socket.emit("close");
    await vi.advanceTimersByTimeAsync(999);
    expect(transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport).toHaveBeenCalledTimes(3);
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores stale socket callbacks and acknowledges only on the source generation", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const adapter = { enqueue: vi.fn(), drain: vi.fn(async () => {}) };
    const client = new SlackSocketModeClient(
      "app-token",
      adapter as never,
      vi.fn(async () => Response.json({ ok: true, url: "wss://socket.test" })),
      (() => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }) as never,
    );
    await client.start();
    const oldSocket = sockets[0]!;
    oldSocket.emit("open");
    oldSocket.emit("close");
    await vi.advanceTimersByTimeAsync(1000);
    const currentSocket = sockets[1]!;
    currentSocket.emit("open");
    const envelope = {
      data: JSON.stringify({
        envelope_id: "envelope",
        payload: {
          event: { type: "message", channel: "C", ts: "1", text: "hello", user: "U" },
        },
      }),
    };

    oldSocket.emit("message", envelope);
    oldSocket.emit("error");
    oldSocket.emit("close");
    await Promise.resolve();
    expect(oldSocket.sent).toEqual([]);
    expect(currentSocket.sent).toEqual([]);
    expect(adapter.enqueue).not.toHaveBeenCalled();
    expect(currentSocket.closed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    currentSocket.emit("message", envelope);
    await vi.waitFor(() => expect(adapter.enqueue).toHaveBeenCalledTimes(1));
    expect(oldSocket.sent).toEqual([]);
    expect(currentSocket.sent).toEqual([JSON.stringify({ envelope_id: "envelope" })]);
    client.stop();
  });

  it("closes and reconnects when message delivery rejects", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const adapter = {
      enqueue: vi.fn(),
      drain: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("delivery failed")),
    };
    const client = new SlackSocketModeClient(
      "app-token",
      adapter as never,
      vi.fn(async () => Response.json({ ok: true, url: "wss://socket.test" })),
      (() => socket) as never,
    );
    await client.start();
    socket.emit("open");
    socket.emit("message", {
      data: JSON.stringify({
        envelope_id: "envelope",
        payload: {
          event: { type: "message", channel: "C", ts: "1", text: "hello", user: "U" },
        },
      }),
    });
    await vi.waitFor(() => expect(socket.closed).toBe(true));
    client.stop();
  });
});
