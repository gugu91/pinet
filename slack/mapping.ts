import { DatabaseSync } from "node:sqlite";
export type ChannelMapping = { slackChannelId: string; chatChannelId: string };
export type ThreadMapping = ChannelMapping & { slackThreadTs: string; chatParentId: string };
export interface MappingStore {
  bindChannel(value: ChannelMapping): void;
  channelBySlack(id: string): ChannelMapping | undefined;
  channelByChat(id: string): ChannelMapping | undefined;
  listChannels(): ChannelMapping[];
  bindThread(value: ThreadMapping): void;
  threadBySlack(channelId: string, threadTs: string): ThreadMapping | undefined;
  threadByChat(channelId: string, parentId: string): ThreadMapping | undefined;
  recordRelay(
    direction: "slack-to-chat" | "chat-to-slack",
    slackChannelId: string,
    slackTs: string,
    chatMessageId: string,
  ): void;
  hasSlackMessage(channelId: string, ts: string): boolean;
  hasChatMessage(id: string): boolean;
  close(): void;
}
export class MemoryMappingStore implements MappingStore {
  protected channels = new Map<string, ChannelMapping>();
  protected threads = new Map<string, ThreadMapping>();
  protected relays = new Set<string>();
  bindChannel(value: ChannelMapping) {
    const chatConflict = [...this.channels.values()].find(
      (row) =>
        row.chatChannelId === value.chatChannelId && row.slackChannelId !== value.slackChannelId,
    );
    if (chatConflict) throw new Error("chat channel is already mapped");
    const current = this.channels.get(value.slackChannelId);
    if (
      current &&
      current.chatChannelId !== value.chatChannelId &&
      [...this.threads.values()].some((row) => row.slackChannelId === value.slackChannelId)
    )
      throw new Error("cannot rebind a channel with mapped threads");
    this.channels.set(value.slackChannelId, value);
  }
  channelBySlack(id: string) {
    return this.channels.get(id);
  }
  channelByChat(id: string) {
    return [...this.channels.values()].find((row) => row.chatChannelId === id);
  }
  listChannels() {
    return [...this.channels.values()];
  }
  bindThread(value: ThreadMapping) {
    const key = `${value.slackChannelId}:${value.slackThreadTs}`;
    const conflict = [...this.threads.values()].find(
      (row) =>
        row.chatChannelId === value.chatChannelId &&
        row.chatParentId === value.chatParentId &&
        key !== `${row.slackChannelId}:${row.slackThreadTs}`,
    );
    if (conflict) throw new Error("chat thread is already mapped");
    this.threads.set(key, value);
  }
  threadBySlack(channelId: string, threadTs: string) {
    return this.threads.get(`${channelId}:${threadTs}`);
  }
  threadByChat(channelId: string, parentId: string) {
    return [...this.threads.values()].find(
      (row) => row.chatChannelId === channelId && row.chatParentId === parentId,
    );
  }
  recordRelay(
    direction: "slack-to-chat" | "chat-to-slack",
    slackChannelId: string,
    slackTs: string,
    chatMessageId: string,
  ) {
    this.relays.add(`${slackChannelId}:${slackTs}`);
    this.relays.add(`chat:${direction}:${chatMessageId}`);
    this.relays.add(`chat:${chatMessageId}`);
  }
  hasSlackMessage(channelId: string, ts: string) {
    return this.relays.has(`${channelId}:${ts}`);
  }
  hasChatMessage(id: string) {
    return this.relays.has(`chat:${id}`);
  }
  close() {}
}
type Snapshot = { channels: ChannelMapping[]; threads: ThreadMapping[]; relays: string[] };
export class SqliteMappingStore extends MemoryMappingStore {
  private db: DatabaseSync;
  private readonly owner = crypto.randomUUID();
  constructor(path: string) {
    super();
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS pinet_slack_state(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pinet_slack_owner(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,pid INTEGER NOT NULL)",
    );
    const lease = this.db.prepare("SELECT owner,pid FROM pinet_slack_owner WHERE id=1").get() as
      | { owner: string; pid: number }
      | undefined;
    if (lease) {
      let active = true;
      try {
        process.kill(lease.pid, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") active = false;
        else throw error;
      }
      if (active) {
        this.db.close();
        throw new Error("mapping database is already owned by another Slack bridge");
      }
    }
    this.db
      .prepare(
        "INSERT INTO pinet_slack_owner(id,owner,pid) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,pid=excluded.pid",
      )
      .run(this.owner, process.pid);
    const row = this.db.prepare("SELECT value FROM pinet_slack_state WHERE id=1").get() as
      | { value: string }
      | undefined;
    if (row) {
      const value = JSON.parse(row.value) as Snapshot;
      for (const item of value.channels) this.channels.set(item.slackChannelId, item);
      for (const item of value.threads)
        this.threads.set(`${item.slackChannelId}:${item.slackThreadTs}`, item);
      for (const item of value.relays) this.relays.add(item);
    }
  }
  private save() {
    this.db
      .prepare(
        "INSERT INTO pinet_slack_state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(
        JSON.stringify({
          channels: [...this.channels.values()],
          threads: [...this.threads.values()],
          relays: [...this.relays],
        }),
      );
  }
  override bindChannel(value: ChannelMapping) {
    super.bindChannel(value);
    this.save();
  }
  override bindThread(value: ThreadMapping) {
    super.bindThread(value);
    this.save();
  }
  override recordRelay(
    direction: "slack-to-chat" | "chat-to-slack",
    channel: string,
    ts: string,
    message: string,
  ) {
    super.recordRelay(direction, channel, ts, message);
    this.save();
  }
  override close() {
    this.db.prepare("DELETE FROM pinet_slack_owner WHERE owner=?").run(this.owner);
    this.db.close();
  }
}
