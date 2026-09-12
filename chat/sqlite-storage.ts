import { DatabaseSync } from "node:sqlite";
import type { Agent, Channel, Message, RuntimeRequest } from "./domain.js";
import { MemoryChatStorage } from "./memory-storage.js";

type Snapshot = {
  channels: Channel[];
  agents: Agent[];
  memberships: Array<[string, string[]]>;
  messages: Message[];
  runtimes: RuntimeRequest[];
  cursor: number;
};

export class SqliteChatStorage extends MemoryChatStorage {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    super();
    this.database = new DatabaseSync(path);
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS pinet_chat_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
    );
    const row = this.database.prepare("SELECT value FROM pinet_chat_state WHERE id=1").get() as
      | { value: string }
      | undefined;
    if (!row) return;
    const snapshot = JSON.parse(row.value) as Snapshot;
    for (const channel of snapshot.channels) this.channelRows.set(channel.id, channel);
    for (const agent of snapshot.agents) this.agentRows.set(agent.id, agent);
    for (const [channelId, members] of snapshot.memberships)
      this.membershipRows.set(channelId, new Set(members));
    this.messageRows.push(...snapshot.messages);
    for (const runtime of snapshot.runtimes) this.runtimeRows.set(runtime.id, runtime);
    this.cursor = snapshot.cursor;
  }
  private save(): void {
    const snapshot: Snapshot = {
      channels: [...this.channelRows.values()],
      agents: [...this.agentRows.values()],
      memberships: [...this.membershipRows].map(([id, members]) => [id, [...members]]),
      messages: this.messageRows,
      runtimes: [...this.runtimeRows.values()],
      cursor: this.cursor,
    };
    this.database
      .prepare(
        "INSERT INTO pinet_chat_state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(snapshot));
  }
  override createChannel(channel: Channel): Channel {
    const value = super.createChannel(channel);
    this.save();
    return value;
  }
  override updateChannel(
    id: string,
    patch: { name?: string; topic?: string },
  ): Channel | undefined {
    const value = super.updateChannel(id, patch);
    if (value) this.save();
    return value;
  }
  override deleteChannel(id: string): boolean {
    const value = super.deleteChannel(id);
    if (value) this.save();
    return value;
  }
  override join(channelId: string, agentId: string): void {
    super.join(channelId, agentId);
    this.save();
  }
  override leave(channelId: string, agentId: string): void {
    super.leave(channelId, agentId);
    this.save();
  }
  override putAgent(agent: Agent): Agent {
    const value = super.putAgent(agent);
    this.save();
    return value;
  }
  override insertMessage(message: Omit<Message, "cursor">): {
    message: Message;
    duplicate: boolean;
  } {
    const value = super.insertMessage(message);
    if (!value.duplicate) this.save();
    return value;
  }
  override createRuntimeRequest(request: RuntimeRequest): RuntimeRequest {
    const value = super.createRuntimeRequest(request);
    this.save();
    return value;
  }
  override updateRuntimeRequest(
    id: string,
    patch: Partial<RuntimeRequest>,
  ): RuntimeRequest | undefined {
    const value = super.updateRuntimeRequest(id, patch);
    if (value) this.save();
    return value;
  }
  override close(): void {
    this.database.close();
  }
}
