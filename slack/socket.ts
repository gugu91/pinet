import { parseSlackMessage, type SlackAdapter } from "./adapter.js";
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Envelope = { envelope_id?: string; payload?: JsonValue };
export interface SocketLike {
  send(value: string): void;
  close(): void;
  addEventListener(name: "open", listener: () => void): void;
  addEventListener(
    name: "message",
    listener: (event: { data: string | ArrayBuffer }) => void,
  ): void;
  addEventListener(name: "close", listener: () => void): void;
  addEventListener(name: "error", listener: () => void): void;
}
export type SocketFactory = (url: string) => SocketLike;
export class SlackSocketModeClient {
  private socket: SocketLike | undefined;
  private stopped = true;
  private reconnectMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private appToken: string,
    private adapter: SlackAdapter,
    private transport: typeof fetch = fetch,
    private socketFactory: SocketFactory = (url) => new WebSocket(url) as SocketLike,
  ) {}
  async start() {
    this.stopped = false;
    await this.connect().catch(() => this.scheduleReconnect());
  }
  stop() {
    this.stopped = true;
    this.socket?.close();
    this.socket = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
  private async connect() {
    const response = await this.transport("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { authorization: `Bearer ${this.appToken}` },
    });
    const body = (await response.json()) as { ok: boolean; url?: string; error?: string };
    if (!response.ok || !body.ok || !body.url)
      throw new Error(`Slack Socket Mode connection failed: ${body.error ?? response.status}`);
    const socket = this.socketFactory(body.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectMs = 1000;
    });
    socket.addEventListener("message", (event) => {
      void this.receive(event.data).catch(() => socket.close());
    });
    socket.addEventListener("close", () => this.scheduleReconnect());
    socket.addEventListener("error", () => socket.close());
  }
  private async receive(data: string | ArrayBuffer) {
    const encoded = typeof data === "string" ? data : new TextDecoder().decode(data);
    const envelope = JSON.parse(encoded) as Envelope;
    if (envelope.envelope_id)
      this.socket?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    if (envelope.payload) {
      const message = parseSlackMessage(envelope.payload);
      if (message) await this.adapter.receive(message);
    }
  }
  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }
}
