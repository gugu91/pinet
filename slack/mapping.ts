import { DatabaseSync } from "node:sqlite";
import type { SlackInboundMessage } from "./adapter.js";
export type ChannelMapping = { slackChannelId: string; chatChannelId: string };
export type ThreadMapping = ChannelMapping & { slackThreadTs: string; chatParentId: string };
export type InboundRow = { id: string; message: SlackInboundMessage };
export type OutboundState = "new" | "sending" | "complete";
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
  enqueueInbound(message: SlackInboundMessage): void;
  pendingInbound(): InboundRow[];
  removeInbound(id: string): void;
  completeInbound(id: string, message: SlackInboundMessage, chatMessageId: string): void;
  getCursor(channelId: string): number;
  advanceCursor(channelId: string, cursor: number): void;
  beginOutbound(messageId: string): OutboundState;
  completeOutbound(value: {
    messageId: string;
    chatChannelId: string;
    cursor: number;
    slackChannelId: string;
    slackTs: string;
    thread?: ThreadMapping;
  }): void;
  listAmbiguousOutbound(): string[];
  retryOutbound(messageId: string): boolean;
  close(): void;
}
export class MemoryMappingStore implements MappingStore {
  protected channels = new Map<string, ChannelMapping>();
  protected threads = new Map<string, ThreadMapping>();
  protected relays = new Set<string>();
  protected inbox = new Map<string, SlackInboundMessage>();
  protected cursors = new Map<string, number>();
  protected outbound = new Map<string, "sending" | "complete">();
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
    const channel = this.channels.get(value.slackChannelId);
    if (!channel || channel.chatChannelId !== value.chatChannelId)
      throw new Error("thread mapping must match its channel mapping");
    const key = `${value.slackChannelId}:${value.slackThreadTs}`;
    const current = this.threads.get(key);
    if (current && JSON.stringify(current) !== JSON.stringify(value))
      throw new Error("slack thread is already mapped");
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
  enqueueInbound(message: SlackInboundMessage): void {
    this.inbox.set(`${message.channel}:${message.ts}`, message);
  }
  pendingInbound(): InboundRow[] {
    return [...this.inbox].map(([id, message]) => ({ id, message }));
  }
  removeInbound(id: string): void {
    this.inbox.delete(id);
  }
  completeInbound(id: string, message: SlackInboundMessage, chatMessageId: string): void {
    this.recordRelay("slack-to-chat", message.channel, message.ts, chatMessageId);
    if (!message.threadTs || message.threadTs === message.ts) {
      const channel = this.channelBySlack(message.channel)!;
      this.bindThread({ ...channel, slackThreadTs: message.ts, chatParentId: chatMessageId });
    }
    this.removeInbound(id);
  }
  getCursor(channelId: string): number {
    return this.cursors.get(channelId) ?? 0;
  }
  advanceCursor(channelId: string, cursor: number): void {
    this.cursors.set(channelId, Math.max(cursor, this.getCursor(channelId)));
  }
  beginOutbound(messageId: string): OutboundState {
    const current = this.outbound.get(messageId);
    if (current) return current;
    this.outbound.set(messageId, "sending");
    return "new";
  }
  completeOutbound(value: {
    messageId: string;
    chatChannelId: string;
    cursor: number;
    slackChannelId: string;
    slackTs: string;
    thread?: ThreadMapping;
  }): void {
    this.recordRelay("chat-to-slack", value.slackChannelId, value.slackTs, value.messageId);
    if (value.thread) this.bindThread(value.thread);
    this.outbound.set(value.messageId, "complete");
    this.advanceCursor(value.chatChannelId, value.cursor);
  }
  listAmbiguousOutbound(): string[] {
    return [...this.outbound].filter(([, status]) => status === "sending").map(([id]) => id);
  }
  retryOutbound(messageId: string): boolean {
    return this.outbound.delete(messageId);
  }
  close() {}
}

type ChannelRow = { slack_channel_id: string; chat_channel_id: string };
type ThreadRow = ChannelRow & { slack_thread_ts: string; chat_parent_id: string };
type ValueRow = { value: string };
type InboxRow = { id: string; value: string };
export class SqliteMappingStore implements MappingStore {
  private readonly db: DatabaseSync;
  private readonly owner = crypto.randomUUID();
  constructor(
    path: string,
    private readonly beforeCompletionCommit?: () => void,
    private readonly relayRetention = 30000,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pinet_slack_owner(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pinet_slack_channels(slack_channel_id TEXT PRIMARY KEY,chat_channel_id TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS pinet_slack_threads(slack_channel_id TEXT NOT NULL,slack_thread_ts TEXT NOT NULL,chat_channel_id TEXT NOT NULL,chat_parent_id TEXT NOT NULL,PRIMARY KEY(slack_channel_id,slack_thread_ts),UNIQUE(chat_channel_id,chat_parent_id));
      CREATE TABLE IF NOT EXISTS pinet_slack_relays(id INTEGER PRIMARY KEY AUTOINCREMENT,relay_key TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS pinet_slack_inbox(id TEXT PRIMARY KEY,value TEXT NOT NULL,sequence INTEGER UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS pinet_slack_cursors(chat_channel_id TEXT PRIMARY KEY,cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pinet_slack_outbound(message_id TEXT PRIMARY KEY,status TEXT NOT NULL CHECK(status IN ('sending','complete')),chat_channel_id TEXT);
    `);
    const lease = this.db.prepare("SELECT owner,pid FROM pinet_slack_owner WHERE id=1").get() as
      | { owner: string; pid: number }
      | undefined;
    if (lease) {
      try {
        process.kill(lease.pid, 0);
        this.db.close();
        throw new Error("mapping database is already owned by another Slack bridge");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    this.db
      .prepare("INSERT OR REPLACE INTO pinet_slack_owner(id,owner,pid) VALUES(1,?,?)")
      .run(this.owner, process.pid);
  }
  bindChannel(value: ChannelMapping): void {
    const current = this.channelBySlack(value.slackChannelId);
    if (current && current.chatChannelId !== value.chatChannelId) {
      const thread = this.db
        .prepare("SELECT 1 AS value FROM pinet_slack_threads WHERE slack_channel_id=? LIMIT 1")
        .get(value.slackChannelId);
      if (thread) throw new Error("cannot rebind a channel with mapped threads");
    }
    try {
      this.db
        .prepare(
          "INSERT INTO pinet_slack_channels VALUES(?,?) ON CONFLICT(slack_channel_id) DO UPDATE SET chat_channel_id=excluded.chat_channel_id",
        )
        .run(value.slackChannelId, value.chatChannelId);
    } catch {
      throw new Error("chat channel is already mapped");
    }
  }
  channelBySlack(id: string): ChannelMapping | undefined {
    const row = this.db
      .prepare("SELECT * FROM pinet_slack_channels WHERE slack_channel_id=?")
      .get(id) as ChannelRow | undefined;
    return row && { slackChannelId: row.slack_channel_id, chatChannelId: row.chat_channel_id };
  }
  channelByChat(id: string): ChannelMapping | undefined {
    const row = this.db
      .prepare("SELECT * FROM pinet_slack_channels WHERE chat_channel_id=?")
      .get(id) as ChannelRow | undefined;
    return row && { slackChannelId: row.slack_channel_id, chatChannelId: row.chat_channel_id };
  }
  listChannels(): ChannelMapping[] {
    return (
      this.db
        .prepare("SELECT * FROM pinet_slack_channels ORDER BY slack_channel_id")
        .all() as ChannelRow[]
    ).map((row) => ({ slackChannelId: row.slack_channel_id, chatChannelId: row.chat_channel_id }));
  }
  bindThread(value: ThreadMapping): void {
    const channel = this.channelBySlack(value.slackChannelId);
    if (!channel || channel.chatChannelId !== value.chatChannelId)
      throw new Error("thread mapping must match its channel mapping");
    const current = this.threadBySlack(value.slackChannelId, value.slackThreadTs);
    if (current) {
      if (JSON.stringify(current) !== JSON.stringify(value))
        throw new Error("slack thread is already mapped");
      return;
    }
    try {
      this.db
        .prepare("INSERT INTO pinet_slack_threads VALUES(?,?,?,?)")
        .run(value.slackChannelId, value.slackThreadTs, value.chatChannelId, value.chatParentId);
    } catch {
      throw new Error("chat thread is already mapped");
    }
  }
  private thread(row: ThreadRow | undefined): ThreadMapping | undefined {
    return (
      row && {
        slackChannelId: row.slack_channel_id,
        slackThreadTs: row.slack_thread_ts,
        chatChannelId: row.chat_channel_id,
        chatParentId: row.chat_parent_id,
      }
    );
  }
  threadBySlack(channelId: string, threadTs: string): ThreadMapping | undefined {
    return this.thread(
      this.db
        .prepare("SELECT * FROM pinet_slack_threads WHERE slack_channel_id=? AND slack_thread_ts=?")
        .get(channelId, threadTs) as ThreadRow | undefined,
    );
  }
  threadByChat(channelId: string, parentId: string): ThreadMapping | undefined {
    return this.thread(
      this.db
        .prepare("SELECT * FROM pinet_slack_threads WHERE chat_channel_id=? AND chat_parent_id=?")
        .get(channelId, parentId) as ThreadRow | undefined,
    );
  }
  recordRelay(
    direction: "slack-to-chat" | "chat-to-slack",
    channelId: string,
    ts: string,
    messageId: string,
  ): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO pinet_slack_relays(relay_key) VALUES(?)");
    this.db.exec("BEGIN");
    try {
      insert.run(`${channelId}:${ts}`);
      insert.run(`chat:${direction}:${messageId}`);
      insert.run(`chat:${messageId}`);
      this.pruneRelays();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private pruneRelays(): void {
    this.db
      .prepare(
        "DELETE FROM pinet_slack_relays WHERE id NOT IN (SELECT id FROM pinet_slack_relays ORDER BY id DESC LIMIT ?)",
      )
      .run(this.relayRetention);
  }
  hasSlackMessage(channelId: string, ts: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 AS value FROM pinet_slack_relays WHERE relay_key=?")
        .get(`${channelId}:${ts}`) as ValueRow | undefined,
    );
  }
  hasChatMessage(id: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 AS value FROM pinet_slack_relays WHERE relay_key=?")
        .get(`chat:${id}`) as ValueRow | undefined,
    );
  }
  enqueueInbound(message: SlackInboundMessage): void {
    const sequence = (
      this.db
        .prepare("SELECT COALESCE(MAX(sequence),0)+1 AS value FROM pinet_slack_inbox")
        .get() as { value: number }
    ).value;
    this.db
      .prepare("INSERT OR IGNORE INTO pinet_slack_inbox(id,value,sequence) VALUES(?,?,?)")
      .run(`${message.channel}:${message.ts}`, JSON.stringify(message), sequence);
  }
  pendingInbound(): InboundRow[] {
    return (
      this.db
        .prepare("SELECT id,value FROM pinet_slack_inbox ORDER BY sequence")
        .all() as InboxRow[]
    ).map((row) => ({ id: row.id, message: JSON.parse(row.value) as SlackInboundMessage }));
  }
  removeInbound(id: string): void {
    this.db.prepare("DELETE FROM pinet_slack_inbox WHERE id=?").run(id);
  }
  completeInbound(id: string, message: SlackInboundMessage, chatMessageId: string): void {
    this.db.exec("BEGIN");
    try {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO pinet_slack_relays(relay_key) VALUES(?)",
      );
      insert.run(`${message.channel}:${message.ts}`);
      insert.run(`chat:slack-to-chat:${chatMessageId}`);
      insert.run(`chat:${chatMessageId}`);
      this.pruneRelays();
      if (!message.threadTs || message.threadTs === message.ts) {
        const channel = this.channelBySlack(message.channel);
        if (!channel) throw new Error("inbound channel mapping disappeared");
        this.db
          .prepare("INSERT INTO pinet_slack_threads VALUES(?,?,?,?)")
          .run(message.channel, message.ts, channel.chatChannelId, chatMessageId);
      }
      this.db.prepare("DELETE FROM pinet_slack_inbox WHERE id=?").run(id);
      this.beforeCompletionCommit?.();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  getCursor(channelId: string): number {
    return (
      (
        this.db
          .prepare("SELECT cursor FROM pinet_slack_cursors WHERE chat_channel_id=?")
          .get(channelId) as { cursor: number } | undefined
      )?.cursor ?? 0
    );
  }
  advanceCursor(channelId: string, cursor: number): void {
    this.db
      .prepare(
        "INSERT INTO pinet_slack_cursors VALUES(?,?) ON CONFLICT(chat_channel_id) DO UPDATE SET cursor=max(cursor,excluded.cursor)",
      )
      .run(channelId, cursor);
  }
  beginOutbound(messageId: string): OutboundState {
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO pinet_slack_outbound VALUES(?,'sending',NULL)")
      .run(messageId).changes;
    if (inserted) return "new";
    return (
      this.db
        .prepare("SELECT status FROM pinet_slack_outbound WHERE message_id=?")
        .get(messageId) as {
        status: "sending" | "complete";
      }
    ).status;
  }
  completeOutbound(value: {
    messageId: string;
    chatChannelId: string;
    cursor: number;
    slackChannelId: string;
    slackTs: string;
    thread?: ThreadMapping;
  }): void {
    this.db.exec("BEGIN");
    try {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO pinet_slack_relays(relay_key) VALUES(?)",
      );
      insert.run(`${value.slackChannelId}:${value.slackTs}`);
      insert.run(`chat:chat-to-slack:${value.messageId}`);
      insert.run(`chat:${value.messageId}`);
      this.pruneRelays();
      if (value.thread)
        this.db
          .prepare("INSERT INTO pinet_slack_threads VALUES(?,?,?,?)")
          .run(
            value.thread.slackChannelId,
            value.thread.slackThreadTs,
            value.thread.chatChannelId,
            value.thread.chatParentId,
          );
      this.db
        .prepare(
          "UPDATE pinet_slack_outbound SET status='complete',chat_channel_id=? WHERE message_id=?",
        )
        .run(value.chatChannelId, value.messageId);
      this.advanceCursor(value.chatChannelId, value.cursor);
      this.db
        .prepare(
          "DELETE FROM pinet_slack_outbound WHERE status='complete' AND chat_channel_id=? AND message_id<>?",
        )
        .run(value.chatChannelId, value.messageId);
      this.beforeCompletionCommit?.();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  listAmbiguousOutbound(): string[] {
    return (
      this.db
        .prepare(
          "SELECT message_id AS value FROM pinet_slack_outbound WHERE status='sending' ORDER BY message_id",
        )
        .all() as ValueRow[]
    ).map((row) => row.value);
  }
  retryOutbound(messageId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM pinet_slack_outbound WHERE message_id=? AND status='sending'")
        .run(messageId).changes > 0
    );
  }
  close(): void {
    this.db.prepare("DELETE FROM pinet_slack_owner WHERE owner=?").run(this.owner);
    this.db.close();
  }
}
