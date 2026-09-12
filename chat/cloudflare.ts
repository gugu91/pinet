import type { Agent, Channel, Message, RuntimeCredential, RuntimeRequest } from "./domain.js";
import { MemoryChatStorage } from "./memory-storage.js";
import { createChatApp, parseCredentials, type Credential } from "./server.js";

type SqlStorage = {
  exec<T extends object>(query: string, ...bindings: Array<string | number | null>): Iterable<T>;
};
type DurableState = { storage: { sql: SqlStorage } };
type DurableStub = { fetch(request: Request): Promise<Response> };
type DurableNamespace = { idFromName(name: string): object; get(id: object): DurableStub };
export type ChatWorkerEnv = { CHAT: DurableNamespace; PINET_CHAT_CREDENTIALS: string };
type StoredRow = { kind: string; id: string; value: string };

class DurableChatStorage extends MemoryChatStorage {
  private readonly sql: SqlStorage;
  constructor(state: DurableState) {
    super();
    this.sql = state.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS pinet_chat(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id))",
    );
    for (const row of this.sql.exec<StoredRow>("SELECT kind,id,value FROM pinet_chat")) {
      if (row.kind === "channel") this.channelRows.set(row.id, JSON.parse(row.value) as Channel);
      else if (row.kind === "agent") this.agentRows.set(row.id, JSON.parse(row.value) as Agent);
      else if (row.kind === "membership")
        this.membershipRows.set(row.id, new Set(JSON.parse(row.value) as string[]));
      else if (row.kind === "message") {
        const message = JSON.parse(row.value) as Message;
        this.messageRows.push(message);
        this.cursor = Math.max(this.cursor, message.cursor);
      } else if (row.kind === "runtime")
        this.runtimeRows.set(row.id, JSON.parse(row.value) as RuntimeRequest);
      else if (row.kind === "runtimeCredential")
        this.runtimeCredentialRows.set(row.id, JSON.parse(row.value) as RuntimeCredential);
    }
    this.messageRows.sort((left, right) => left.cursor - right.cursor);
  }
  private put(kind: string, id: string, value: object): void {
    this.sql.exec(
      "INSERT INTO pinet_chat(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",
      kind,
      id,
      JSON.stringify(value),
    );
  }
  override createChannel(value: Channel): Channel {
    const result = super.createChannel(value);
    this.put("channel", result.id, result);
    return result;
  }
  override updateChannel(
    id: string,
    value: { name?: string; topic?: string },
  ): Channel | undefined {
    const result = super.updateChannel(id, value);
    if (result) this.put("channel", id, result);
    return result;
  }
  override deleteChannel(id: string): boolean {
    const result = super.deleteChannel(id);
    if (result)
      this.sql.exec(
        "DELETE FROM pinet_chat WHERE (kind='channel' OR kind='membership') AND id=?",
        id,
      );
    return result;
  }
  override join(channelId: string, agentId: string): void {
    super.join(channelId, agentId);
    this.put("membership", channelId, [...(this.membershipRows.get(channelId) ?? [])]);
  }
  override leave(channelId: string, agentId: string): void {
    super.leave(channelId, agentId);
    this.put("membership", channelId, [...(this.membershipRows.get(channelId) ?? [])]);
  }
  override putAgent(value: Agent): Agent {
    const result = super.putAgent(value);
    this.put("agent", result.id, result);
    return result;
  }
  override insertMessage(value: Omit<Message, "cursor">): { message: Message; duplicate: boolean } {
    const result = super.insertMessage(value);
    if (!result.duplicate) this.put("message", result.message.id, result.message);
    return result;
  }
  override createRuntimeRequest(value: RuntimeRequest): RuntimeRequest {
    const result = super.createRuntimeRequest(value);
    this.put("runtime", result.id, result);
    return result;
  }
  override updateRuntimeRequest(
    id: string,
    value: Partial<RuntimeRequest>,
  ): RuntimeRequest | undefined {
    const result = super.updateRuntimeRequest(id, value);
    if (result) this.put("runtime", id, result);
    return result;
  }
  override putRuntimeCredential(value: RuntimeCredential): void {
    super.putRuntimeCredential(value);
    this.put("runtimeCredential", value.requestId, value);
  }
  override deleteRuntimeCredential(requestId: string): void {
    super.deleteRuntimeCredential(requestId);
    this.sql.exec("DELETE FROM pinet_chat WHERE kind='runtimeCredential' AND id=?", requestId);
  }
  override claimRuntimeRequest(
    id: string,
    hostId: string,
    updatedAt: number,
  ): RuntimeRequest | undefined {
    const result = super.claimRuntimeRequest(id, hostId, updatedAt);
    if (result) this.put("runtime", id, result);
    return result;
  }
}

export class ChatDurableObject {
  private readonly storage: DurableChatStorage;
  private credentials: Credential[] | undefined;
  constructor(state: DurableState) {
    this.storage = new DurableChatStorage(state);
  }
  fetch(request: Request): Promise<Response> {
    try {
      if (!this.credentials) {
        const encoded = request.headers.get("x-pinet-internal-credentials");
        if (!encoded) throw new Error("Credentials unavailable");
        this.credentials = parseCredentials(encoded);
      }
      return Promise.resolve(
        createChatApp({ storage: this.storage, credentials: this.credentials }).fetch(request),
      );
    } catch (error) {
      return Promise.resolve(
        Response.json(
          {
            error: {
              code: "misconfigured",
              message: error instanceof Error ? error.message : "Invalid credentials",
            },
          },
          { status: 500 },
        ),
      );
    }
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
