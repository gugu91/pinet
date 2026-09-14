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
  private generation = 0;
  private reconnectMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private appToken: string,
    private adapter: SlackAdapter,
    private transport: typeof fetch = fetch,
    private socketFactory: SocketFactory = (url) => new WebSocket(url) as SocketLike,
  ) {}
  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    const generation = ++this.generation;
    void this.adapter.drain().catch(() => {});
    await this.connect(generation).catch(() => this.scheduleReconnect(generation));
  }
  stop() {
    this.stopped = true;
    ++this.generation;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
  private async connect(generation: number) {
    const response = await this.transport("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { authorization: `Bearer ${this.appToken}` },
    });
    const body = (await response.json()) as { ok: boolean; url?: string; error?: string };
    if (this.stopped || generation !== this.generation) return;
    if (!response.ok || !body.ok || !body.url)
      throw new Error(`Slack Socket Mode connection failed: ${body.error ?? response.status}`);
    const socket = this.socketFactory(body.url);
    if (this.stopped || generation !== this.generation) {
      socket.close();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectMs = 1000;
      void this.adapter.drain().catch(() => {
        if (this.socket === socket) socket.close();
      });
    });
    socket.addEventListener("message", (event) => {
      void this.receive(socket, event.data).catch(() => {
        if (this.socket === socket) socket.close();
      });
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.scheduleReconnect(generation);
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) socket.close();
    });
  }
  private async receive(source: SocketLike, data: string | ArrayBuffer) {
    if (this.socket !== source) return;
    const encoded = typeof data === "string" ? data : new TextDecoder().decode(data);
    const envelope = JSON.parse(encoded) as Envelope;
    if (!envelope.envelope_id || !envelope.payload) return;
    const message = parseSlackMessage(envelope.payload);
    if (message) this.adapter.enqueue(message);
    source.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    if (message) await this.adapter.drain();
  }
  private scheduleReconnect(generation: number) {
    if (this.stopped || generation !== this.generation || this.reconnectTimer) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped && generation === this.generation)
        void this.connect(generation).catch(() => this.scheduleReconnect(generation));
    }, delay);
  }
}
