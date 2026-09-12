import type { Agent, Channel, Message, RuntimeRequest } from "./domain.js";
import { MemoryChatStorage } from "./memory-storage.js";
import { createChatApp, type Credential } from "./server.js";

type DurableStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: string): Promise<void>;
};
type DurableState = {
  storage: DurableStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<void>): void;
};
type DurableStub = { fetch(request: Request): Promise<Response> };
type DurableNamespace = { idFromName(name: string): object; get(id: object): DurableStub };
export type ChatWorkerEnv = { CHAT: DurableNamespace; PINET_CHAT_CREDENTIALS: string };
type Snapshot = {
  channels: Channel[];
  agents: Agent[];
  memberships: Array<[string, string[]]>;
  messages: Message[];
  runtimes: RuntimeRequest[];
  cursor: number;
};

class DurableChatStorage extends MemoryChatStorage {
  constructor(private readonly state: DurableState) {
    super();
  }
  async load(): Promise<void> {
    const encoded = await this.state.storage.get<string>("snapshot");
    if (!encoded) return;
    const value = JSON.parse(encoded) as Snapshot;
    for (const row of value.channels) this.channelRows.set(row.id, row);
    for (const row of value.agents) this.agentRows.set(row.id, row);
    for (const [id, rows] of value.memberships) this.membershipRows.set(id, new Set(rows));
    this.messageRows.push(...value.messages);
    for (const row of value.runtimes) this.runtimeRows.set(row.id, row);
    this.cursor = value.cursor;
  }
  private save(): void {
    const value: Snapshot = {
      channels: [...this.channelRows.values()],
      agents: [...this.agentRows.values()],
      memberships: [...this.membershipRows].map(([id, rows]) => [id, [...rows]]),
      messages: this.messageRows,
      runtimes: [...this.runtimeRows.values()],
      cursor: this.cursor,
    };
    this.state.waitUntil(this.state.storage.put("snapshot", JSON.stringify(value)));
  }
  override createChannel(value: Channel): Channel {
    const result = super.createChannel(value);
    this.save();
    return result;
  }
  override updateChannel(
    id: string,
    value: { name?: string; topic?: string },
  ): Channel | undefined {
    const result = super.updateChannel(id, value);
    if (result) this.save();
    return result;
  }
  override deleteChannel(id: string): boolean {
    const result = super.deleteChannel(id);
    if (result) this.save();
    return result;
  }
  override join(channelId: string, agentId: string): void {
    super.join(channelId, agentId);
    this.save();
  }
  override leave(channelId: string, agentId: string): void {
    super.leave(channelId, agentId);
    this.save();
  }
  override putAgent(value: Agent): Agent {
    const result = super.putAgent(value);
    this.save();
    return result;
  }
  override insertMessage(value: Omit<Message, "cursor">): { message: Message; duplicate: boolean } {
    const result = super.insertMessage(value);
    if (!result.duplicate) this.save();
    return result;
  }
  override createRuntimeRequest(value: RuntimeRequest): RuntimeRequest {
    const result = super.createRuntimeRequest(value);
    this.save();
    return result;
  }
  override updateRuntimeRequest(
    id: string,
    value: Partial<RuntimeRequest>,
  ): RuntimeRequest | undefined {
    const result = super.updateRuntimeRequest(id, value);
    if (result) this.save();
    return result;
  }
}

export class ChatDurableObject {
  private readonly storage: DurableChatStorage;
  private credentials: Credential[] = [];
  constructor(private readonly state: DurableState) {
    this.storage = new DurableChatStorage(state);
    void state.blockConcurrencyWhile(() => this.storage.load());
  }
  async fetch(request: Request): Promise<Response> {
    if (this.credentials.length === 0) {
      const encoded = request.headers.get("x-pinet-internal-credentials");
      if (!encoded)
        return Response.json(
          { error: { code: "misconfigured", message: "Credentials unavailable" } },
          { status: 500 },
        );
      this.credentials = JSON.parse(encoded) as Credential[];
    }
    return createChatApp({ storage: this.storage, credentials: this.credentials }).fetch(request);
  }
}

export default {
  fetch(request: Request, env: ChatWorkerEnv): Promise<Response> {
    const workspace = request.headers.get("x-pinet-workspace") ?? "default";
    const forwarded = new Request(request);
    forwarded.headers.set("x-pinet-internal-credentials", env.PINET_CHAT_CREDENTIALS);
    return env.CHAT.get(env.CHAT.idFromName(workspace)).fetch(forwarded);
  },
};
