import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  Agent,
  Channel,
  ChatStorage,
  Message,
  RuntimeCredential,
  RuntimeRequest,
} from "./domain.js";
import { ChatConflictError, ChatNotFoundError, sameMessage } from "./domain.js";
import { createChatApp, parseCredentials, type Credential } from "./server.js";
type SqlStorage = {
  exec<T extends object>(query: string, ...bindings: Array<string | number | null>): Iterable<T>;
};
type DurableState = {
  storage: { sql: SqlStorage; transactionSync<T>(callback: () => T): T };
};
type DurableStub = { fetch(request: Request): Promise<Response> };
type DurableNamespace = { idFromName(name: string): object; get(id: object): DurableStub };
export type ChatWorkerEnv = { CHAT: DurableNamespace; PINET_CHAT_CREDENTIALS: string };
const INTERNAL_CREDENTIALS = "x-pinet-internal-credentials";
const INTERNAL_WORKSPACE = "x-pinet-internal-workspace";
type ChannelRow = { id: string; name: string; topic: string; created_at: number };
type AgentRow = { id: string; name: string; home_channel_id: string | null; last_seen: number };
type MessageRow = {
  id: string;
  client_id: string;
  channel_id: string;
  sender_id: string;
  markdown: string;
  mentions: string;
  parent_id: string | null;
  created_at: number;
  cursor: number;
};
type ValueRow = { value: string };
class DurableChatStorage implements ChatStorage {
  private readonly sql: SqlStorage;
  private readonly durableStorage: DurableState["storage"];
  constructor(state: DurableState) {
    this.sql = state.storage.sql;
    this.durableStorage = state.storage;
    this.sql.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS pinet_channels(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,topic TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pinet_agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,home_channel_id TEXT REFERENCES pinet_channels(id) ON DELETE SET NULL,last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pinet_memberships(channel_id TEXT NOT NULL REFERENCES pinet_channels(id) ON DELETE CASCADE,agent_id TEXT NOT NULL,PRIMARY KEY(channel_id,agent_id));
      CREATE TABLE IF NOT EXISTS pinet_messages(cursor INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,client_id TEXT NOT NULL,channel_id TEXT NOT NULL REFERENCES pinet_channels(id) ON DELETE CASCADE,sender_id TEXT NOT NULL,markdown TEXT NOT NULL,mentions TEXT NOT NULL,parent_id TEXT REFERENCES pinet_messages(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,UNIQUE(sender_id,client_id));
      CREATE INDEX IF NOT EXISTS pinet_messages_channel_cursor ON pinet_messages(channel_id,cursor);
      CREATE TABLE IF NOT EXISTS pinet_runtimes(id TEXT PRIMARY KEY,host_id TEXT NOT NULL,status TEXT NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS pinet_runtimes_host_status ON pinet_runtimes(host_id,status);
      CREATE TABLE IF NOT EXISTS pinet_runtime_credentials(request_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL);
    `);
  }
  private channel(row: ChannelRow | undefined): Channel | undefined {
    return row && { id: row.id, name: row.name, topic: row.topic, createdAt: row.created_at };
  }
  private agent(row: AgentRow | undefined): Agent | undefined {
    return (
      row && {
        id: row.id,
        name: row.name,
        homeChannelId: row.home_channel_id,
        lastSeen: row.last_seen,
      }
    );
  }
  private message(row: MessageRow): Message {
    return {
      id: row.id,
      clientId: row.client_id,
      channelId: row.channel_id,
      senderId: row.sender_id,
      markdown: row.markdown,
      mentions: JSON.parse(row.mentions) as string[],
      parentId: row.parent_id,
      createdAt: row.created_at,
      cursor: row.cursor,
    };
  }
  createChannel(value: Channel): Channel {
    try {
      this.sql.exec(
        "INSERT INTO pinet_channels VALUES(?,?,?,?)",
        value.id,
        value.name,
        value.topic,
        value.createdAt,
      );
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("UNIQUE constraint failed"))
        throw new ChatConflictError("channel name already exists");
      throw cause;
    }
    return value;
  }
  updateChannel(id: string, patch: { name?: string; topic?: string }): Channel | undefined {
    const current = this.getChannel(id);
    if (!current) return undefined;
    const value = { ...current, ...patch };
    this.sql.exec(
      "UPDATE pinet_channels SET name=?,topic=? WHERE id=?",
      value.name,
      value.topic,
      id,
    );
    return value;
  }
  deleteChannel(id: string): boolean {
    if (!this.getChannel(id)) return false;
    this.sql.exec("DELETE FROM pinet_channels WHERE id=?", id);
    return true;
  }
  getChannel(id: string): Channel | undefined {
    return this.channel(
      [...this.sql.exec<ChannelRow>("SELECT * FROM pinet_channels WHERE id=?", id)][0],
    );
  }
  listChannels(limit: number, offset: number): Channel[] {
    return [
      ...this.sql.exec<ChannelRow>(
        "SELECT * FROM pinet_channels ORDER BY created_at,id LIMIT ? OFFSET ?",
        limit,
        offset,
      ),
    ].map((row) => this.channel(row)!);
  }
  join(channelId: string, agentId: string): void {
    if (!this.getChannel(channelId)) throw new ChatNotFoundError("channel not found");
    this.sql.exec("INSERT OR IGNORE INTO pinet_memberships VALUES(?,?)", channelId, agentId);
  }
  leave(channelId: string, agentId: string): void {
    this.sql.exec(
      "DELETE FROM pinet_memberships WHERE channel_id=? AND agent_id=?",
      channelId,
      agentId,
    );
  }
  members(channelId: string): string[] {
    return [
      ...this.sql.exec<ValueRow>(
        "SELECT agent_id AS value FROM pinet_memberships WHERE channel_id=? ORDER BY agent_id",
        channelId,
      ),
    ].map((row) => row.value);
  }
  putAgent(value: Agent): Agent {
    this.sql.exec(
      "INSERT INTO pinet_agents VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,home_channel_id=excluded.home_channel_id,last_seen=excluded.last_seen",
      value.id,
      value.name,
      value.homeChannelId,
      value.lastSeen,
    );
    return value;
  }
  getAgent(id: string): Agent | undefined {
    return this.agent([...this.sql.exec<AgentRow>("SELECT * FROM pinet_agents WHERE id=?", id)][0]);
  }
  listAgents(): Agent[] {
    return [...this.sql.exec<AgentRow>("SELECT * FROM pinet_agents ORDER BY id")].map(
      (row) => this.agent(row)!,
    );
  }
  insertMessage(input: Omit<Message, "cursor">): { message: Message; duplicate: boolean } {
    const existingRow = [
      ...this.sql.exec<MessageRow>(
        "SELECT * FROM pinet_messages WHERE sender_id=? AND client_id=?",
        input.senderId,
        input.clientId,
      ),
    ][0];
    if (existingRow) {
      const existing = this.message(existingRow);
      if (!sameMessage(input, existing))
        throw new ChatConflictError("client id reused with different payload");
      return { message: existing, duplicate: true };
    }
    if (!this.getChannel(input.channelId)) throw new ChatNotFoundError("channel not found");
    if (input.parentId) {
      const parent = [
        ...this.sql.exec<ValueRow>(
          "SELECT channel_id AS value FROM pinet_messages WHERE id=?",
          input.parentId,
        ),
      ][0];
      if (!parent || parent.value !== input.channelId)
        throw new ChatNotFoundError("thread parent not found in channel");
    }
    this.sql.exec(
      "INSERT INTO pinet_messages(id,client_id,channel_id,sender_id,markdown,mentions,parent_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      input.id,
      input.clientId,
      input.channelId,
      input.senderId,
      input.markdown,
      JSON.stringify(input.mentions),
      input.parentId,
      input.createdAt,
    );
    return {
      message: this.message(
        [...this.sql.exec<MessageRow>("SELECT * FROM pinet_messages WHERE id=?", input.id)][0]!,
      ),
      duplicate: false,
    };
  }
  messages(channelId: string, after: number, limit: number): Message[] {
    return [
      ...this.sql.exec<MessageRow>(
        "SELECT * FROM pinet_messages WHERE channel_id=? AND cursor>? ORDER BY cursor LIMIT ?",
        channelId,
        after,
        limit,
      ),
    ].map((row) => this.message(row));
  }
  searchMessages(query: string, limit: number, after: number): Message[] {
    return [
      ...this.sql.exec<MessageRow>(
        "SELECT * FROM pinet_messages WHERE cursor>? AND instr(lower(markdown),lower(?))>0 ORDER BY cursor LIMIT ?",
        after,
        query,
        limit,
      ),
    ].map((row) => this.message(row));
  }
  mentions(agentId: string, after: number, limit: number): Message[] {
    return [
      ...this.sql.exec<MessageRow>(
        "SELECT * FROM pinet_messages WHERE cursor>? AND EXISTS(SELECT 1 FROM json_each(mentions) WHERE value=?) ORDER BY cursor LIMIT ?",
        after,
        agentId,
        limit,
      ),
    ].map((row) => this.message(row));
  }
  createRuntimeRequest(value: RuntimeRequest): RuntimeRequest {
    this.sql.exec(
      "INSERT INTO pinet_runtimes VALUES(?,?,?,?)",
      value.id,
      value.hostId,
      value.status,
      JSON.stringify(value),
    );
    return value;
  }
  getRuntimeRequest(id: string): RuntimeRequest | undefined {
    const row = [...this.sql.exec<ValueRow>("SELECT value FROM pinet_runtimes WHERE id=?", id)][0];
    return row ? (JSON.parse(row.value) as RuntimeRequest) : undefined;
  }
  listRuntimeRequests(hostId: string, status?: RuntimeRequest["status"]): RuntimeRequest[] {
    const rows = status
      ? this.sql.exec<ValueRow>(
          "SELECT value FROM pinet_runtimes WHERE host_id=? AND status=? ORDER BY id",
          hostId,
          status,
        )
      : this.sql.exec<ValueRow>(
          "SELECT value FROM pinet_runtimes WHERE host_id=? ORDER BY id",
          hostId,
        );
    return [...rows].map((row) => JSON.parse(row.value) as RuntimeRequest);
  }
  updateRuntimeRequest(id: string, patch: Partial<RuntimeRequest>): RuntimeRequest | undefined {
    const current = this.getRuntimeRequest(id);
    if (!current) return undefined;
    const next = {
      ...current,
      ...patch,
      id: current.id,
      hostId: current.hostId,
      requestedBy: current.requestedBy,
    };
    this.sql.exec(
      "UPDATE pinet_runtimes SET status=?,value=? WHERE id=?",
      next.status,
      JSON.stringify(next),
      id,
    );
    return next;
  }
  claimRuntimeRequest(id: string, hostId: string, updatedAt: number): RuntimeRequest | undefined {
    return this.durableStorage.transactionSync(() => {
      const current = this.getRuntimeRequest(id);
      if (!current || current.hostId !== hostId || current.status !== "pending") return undefined;
      return this.updateRuntimeRequest(id, { status: "claimed", updatedAt });
    });
  }
  putRuntimeCredential(value: RuntimeCredential): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO pinet_runtime_credentials VALUES(?,?,?)",
      value.requestId,
      value.agentId,
      value.tokenHash,
    );
  }
  runtimeCredentialByHash(tokenHash: string): RuntimeCredential | undefined {
    type Row = { request_id: string; agent_id: string; token_hash: string };
    const row = [
      ...this.sql.exec<Row>(
        "SELECT * FROM pinet_runtime_credentials WHERE token_hash=?",
        tokenHash,
      ),
    ][0];
    return row && { requestId: row.request_id, agentId: row.agent_id, tokenHash: row.token_hash };
  }
  deleteRuntimeCredential(requestId: string): void {
    this.sql.exec("DELETE FROM pinet_runtime_credentials WHERE request_id=?", requestId);
  }
  close(): void {}
}
function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function runtimeSignature(workspace: string, nonce: string, secret: string): string {
  return createHmac("sha256", secret).update(`${workspace}.${nonce}`).digest("base64url");
}

// agent-standards-ignore prefer-inline-single-use-helper: signed runtime credential issuance is a security boundary paired with validation below.
function issueRuntimeToken(workspace: string, secret: string): string {
  const nonce = crypto.randomUUID();
  return `rt.${Buffer.from(workspace).toString("base64url")}.${nonce}.${runtimeSignature(workspace, nonce, secret)}`;
}

// agent-standards-ignore prefer-inline-single-use-helper: signed runtime credential parsing authorizes routing before Durable Object selection.
function signedRuntimeWorkspace(token: string, secret: string): string | undefined {
  const [prefix, encodedWorkspace, nonce, signature, extra] = token.split(".");
  if (prefix !== "rt" || !encodedWorkspace || !nonce || !signature || extra !== undefined)
    return undefined;
  const workspace = Buffer.from(encodedWorkspace, "base64url").toString();
  if (!workspace || Buffer.from(workspace).toString("base64url") !== encodedWorkspace)
    return undefined;
  return secureEqual(signature, runtimeSignature(workspace, nonce, secret)) ? workspace : undefined;
}

export class ChatDurableObject {
  private readonly storage: DurableChatStorage;
  constructor(state: DurableState) {
    this.storage = new DurableChatStorage(state);
  }
  fetch(request: Request): Promise<Response> {
    try {
      const encoded = request.headers.get(INTERNAL_CREDENTIALS);
      const workspace = request.headers.get(INTERNAL_WORKSPACE);
      if (!encoded || !workspace) throw new Error("Internal authentication context unavailable");
      const credentials = parseCredentials(encoded).filter(
        (credential) => (credential.workspace ?? "default") === workspace,
      );
      return Promise.resolve(
        createChatApp({
          storage: this.storage,
          credentials,
          runtimeToken: () => issueRuntimeToken(workspace, encoded),
        }).fetch(request),
      );
    } catch (cause) {
      console.error("Chat Durable Object configuration failed", cause);
      return Promise.resolve(
        Response.json(
          { error: { code: "misconfigured", message: "Chat service is misconfigured" } },
          { status: 500 },
        ),
      );
    }
  }
}
export default {
  fetch(request: Request, env: ChatWorkerEnv): Promise<Response> {
    let credentials: Credential[];
    try {
      credentials = parseCredentials(env.PINET_CHAT_CREDENTIALS);
    } catch (cause) {
      console.error("Chat Worker credential configuration failed", cause);
      return Promise.resolve(
        Response.json(
          { error: { code: "misconfigured", message: "Chat service is misconfigured" } },
          { status: 500 },
        ),
      );
    }
    const authorization = request.headers.get("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const configured = token
      ? credentials.find((credential) => secureEqual(credential.token, token))
      : undefined;
    const workspace = configured
      ? (configured.workspace ?? "default")
      : token
        ? signedRuntimeWorkspace(token, env.PINET_CHAT_CREDENTIALS)
        : undefined;
    if (!workspace) {
      return Promise.resolve(
        Response.json(
          { error: { code: "unauthorized", message: "Valid Bearer credential required" } },
          { status: 401 },
        ),
      );
    }
    const forwarded = new Request(request);
    forwarded.headers.delete("x-pinet-workspace");
    forwarded.headers.delete(INTERNAL_CREDENTIALS);
    forwarded.headers.delete(INTERNAL_WORKSPACE);
    forwarded.headers.set(INTERNAL_CREDENTIALS, env.PINET_CHAT_CREDENTIALS);
    forwarded.headers.set(INTERNAL_WORKSPACE, workspace);
    return env.CHAT.get(env.CHAT.idFromName(workspace)).fetch(forwarded);
  },
};
