import { DatabaseSync } from "node:sqlite";
import type {
  Agent,
  Channel,
  ChatStorage,
  Message,
  RuntimeCredential,
  RuntimeRequest,
} from "./domain.js";
import { sameMessage } from "./domain.js";

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
export class SqliteChatStorage implements ChatStorage {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS pinet_channels(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,topic TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pinet_agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,home_channel_id TEXT REFERENCES pinet_channels(id) ON DELETE SET NULL,last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pinet_memberships(channel_id TEXT NOT NULL REFERENCES pinet_channels(id) ON DELETE CASCADE,agent_id TEXT NOT NULL,PRIMARY KEY(channel_id,agent_id));
      CREATE TABLE IF NOT EXISTS pinet_messages(id TEXT UNIQUE NOT NULL,client_id TEXT NOT NULL,channel_id TEXT NOT NULL REFERENCES pinet_channels(id) ON DELETE CASCADE,sender_id TEXT NOT NULL,markdown TEXT NOT NULL,mentions TEXT NOT NULL,parent_id TEXT REFERENCES pinet_messages(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,cursor INTEGER PRIMARY KEY AUTOINCREMENT,UNIQUE(sender_id,client_id));
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
      this.database
        .prepare("INSERT INTO pinet_channels VALUES(?,?,?,?)")
        .run(value.id, value.name, value.topic, value.createdAt);
    } catch {
      throw new Error("channel name already exists");
    }
    return value;
  }
  updateChannel(id: string, patch: { name?: string; topic?: string }): Channel | undefined {
    const current = this.getChannel(id);
    if (!current) return undefined;
    const value = { ...current, ...patch };
    this.database
      .prepare("UPDATE pinet_channels SET name=?,topic=? WHERE id=?")
      .run(value.name, value.topic, id);
    return value;
  }
  deleteChannel(id: string): boolean {
    return this.database.prepare("DELETE FROM pinet_channels WHERE id=?").run(id).changes > 0;
  }
  getChannel(id: string): Channel | undefined {
    return this.channel(
      this.database.prepare("SELECT * FROM pinet_channels WHERE id=?").get(id) as
        | ChannelRow
        | undefined,
    );
  }
  listChannels(limit: number, offset: number): Channel[] {
    return (
      this.database
        .prepare("SELECT * FROM pinet_channels ORDER BY created_at,id LIMIT ? OFFSET ?")
        .all(limit, offset) as ChannelRow[]
    ).map((row) => this.channel(row)!);
  }
  join(channelId: string, agentId: string): void {
    if (!this.getChannel(channelId)) throw new Error("channel not found");
    this.database
      .prepare("INSERT OR IGNORE INTO pinet_memberships VALUES(?,?)")
      .run(channelId, agentId);
  }
  leave(channelId: string, agentId: string): void {
    this.database
      .prepare("DELETE FROM pinet_memberships WHERE channel_id=? AND agent_id=?")
      .run(channelId, agentId);
  }
  members(channelId: string): string[] {
    return (
      this.database
        .prepare(
          "SELECT agent_id AS value FROM pinet_memberships WHERE channel_id=? ORDER BY agent_id",
        )
        .all(channelId) as ValueRow[]
    ).map((row) => row.value);
  }
  putAgent(value: Agent): Agent {
    this.database
      .prepare(
        "INSERT INTO pinet_agents VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,home_channel_id=excluded.home_channel_id,last_seen=excluded.last_seen",
      )
      .run(value.id, value.name, value.homeChannelId, value.lastSeen);
    return value;
  }
  getAgent(id: string): Agent | undefined {
    return this.agent(
      this.database.prepare("SELECT * FROM pinet_agents WHERE id=?").get(id) as
        | AgentRow
        | undefined,
    );
  }
  listAgents(): Agent[] {
    return (
      this.database.prepare("SELECT * FROM pinet_agents ORDER BY id").all() as AgentRow[]
    ).map((row) => this.agent(row)!);
  }
  insertMessage(input: Omit<Message, "cursor">): { message: Message; duplicate: boolean } {
    const existingRow = this.database
      .prepare("SELECT * FROM pinet_messages WHERE sender_id=? AND client_id=?")
      .get(input.senderId, input.clientId) as MessageRow | undefined;
    if (existingRow) {
      const existing = this.message(existingRow);
      if (!sameMessage(input, existing)) throw new Error("client id reused with different payload");
      return { message: existing, duplicate: true };
    }
    if (!this.getChannel(input.channelId)) throw new Error("channel not found");
    if (input.parentId) {
      const parent = this.database
        .prepare("SELECT channel_id AS value FROM pinet_messages WHERE id=?")
        .get(input.parentId) as ValueRow | undefined;
      if (!parent || parent.value !== input.channelId)
        throw new Error("thread parent not found in channel");
    }
    this.database
      .prepare(
        "INSERT INTO pinet_messages(id,client_id,channel_id,sender_id,markdown,mentions,parent_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
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
        this.database
          .prepare("SELECT * FROM pinet_messages WHERE id=?")
          .get(input.id) as MessageRow,
      ),
      duplicate: false,
    };
  }
  messages(channelId: string, after: number, limit: number): Message[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM pinet_messages WHERE channel_id=? AND cursor>? ORDER BY cursor LIMIT ?",
        )
        .all(channelId, after, limit) as MessageRow[]
    ).map((row) => this.message(row));
  }
  searchMessages(query: string, limit: number, after: number): Message[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM pinet_messages WHERE cursor>? AND instr(lower(markdown),lower(?))>0 ORDER BY cursor LIMIT ?",
        )
        .all(after, query, limit) as MessageRow[]
    ).map((row) => this.message(row));
  }
  mentions(agentId: string, after: number, limit: number): Message[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM pinet_messages WHERE cursor>? AND EXISTS(SELECT 1 FROM json_each(mentions) WHERE value=?) ORDER BY cursor LIMIT ?",
        )
        .all(after, agentId, limit) as MessageRow[]
    ).map((row) => this.message(row));
  }
  createRuntimeRequest(value: RuntimeRequest): RuntimeRequest {
    this.database
      .prepare("INSERT INTO pinet_runtimes VALUES(?,?,?,?)")
      .run(value.id, value.hostId, value.status, JSON.stringify(value));
    return value;
  }
  getRuntimeRequest(id: string): RuntimeRequest | undefined {
    const row = this.database.prepare("SELECT value FROM pinet_runtimes WHERE id=?").get(id) as
      | ValueRow
      | undefined;
    return row ? (JSON.parse(row.value) as RuntimeRequest) : undefined;
  }
  listRuntimeRequests(hostId: string, status?: RuntimeRequest["status"]): RuntimeRequest[] {
    const rows = status
      ? this.database
          .prepare("SELECT value FROM pinet_runtimes WHERE host_id=? AND status=? ORDER BY id")
          .all(hostId, status)
      : this.database
          .prepare("SELECT value FROM pinet_runtimes WHERE host_id=? ORDER BY id")
          .all(hostId);
    return (rows as ValueRow[]).map((row) => JSON.parse(row.value) as RuntimeRequest);
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
    this.database
      .prepare("UPDATE pinet_runtimes SET status=?,value=? WHERE id=?")
      .run(next.status, JSON.stringify(next), id);
    return next;
  }
  claimRuntimeRequest(id: string, hostId: string, updatedAt: number): RuntimeRequest | undefined {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getRuntimeRequest(id);
      if (!current || current.hostId !== hostId || current.status !== "pending") {
        this.database.exec("ROLLBACK");
        return undefined;
      }
      const next = this.updateRuntimeRequest(id, { status: "claimed", updatedAt })!;
      this.database.exec("COMMIT");
      return next;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  putRuntimeCredential(value: RuntimeCredential): void {
    this.database
      .prepare("INSERT OR REPLACE INTO pinet_runtime_credentials VALUES(?,?,?)")
      .run(value.requestId, value.agentId, value.tokenHash);
  }
  runtimeCredentialByHash(tokenHash: string): RuntimeCredential | undefined {
    const row = this.database
      .prepare(
        "SELECT request_id,agent_id,token_hash FROM pinet_runtime_credentials WHERE token_hash=?",
      )
      .get(tokenHash) as { request_id: string; agent_id: string; token_hash: string } | undefined;
    return row && { requestId: row.request_id, agentId: row.agent_id, tokenHash: row.token_hash };
  }
  deleteRuntimeCredential(requestId: string): void {
    this.database
      .prepare("DELETE FROM pinet_runtime_credentials WHERE request_id=?")
      .run(requestId);
  }
  close(): void {
    this.database.close();
  }
}
