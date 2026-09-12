export type Principal = { kind: "agent" | "host" | "runtime"; id: string };
export type Channel = { id: string; name: string; topic: string; createdAt: number };
export type Agent = { id: string; name: string; homeChannelId: string | null; lastSeen: number };
export type Message = {
  id: string;
  clientId: string;
  channelId: string;
  senderId: string;
  markdown: string;
  mentions: string[];
  parentId: string | null;
  createdAt: number;
  cursor: number;
};
export type RuntimeRequest = {
  id: string;
  requestedBy: string;
  hostId: string;
  prompt: string;
  channelId: string | null;
  worktree: string | null;
  adapter: "process" | "tmux" | "herdr";
  status: "pending" | "claimed" | "running" | "stopped" | "failed" | "unknown";
  createdAt: number;
  updatedAt: number;
  sessionId: string | null;
  sessionPath: string | null;
  cwd: string | null;
  handle: string | null;
  identity: string | null;
  startedAt: number | null;
  lastSeen: number | null;
  stoppedAt: number | null;
};

export interface ChatStorage {
  createChannel(channel: Channel): Channel;
  updateChannel(id: string, patch: { name?: string; topic?: string }): Channel | undefined;
  deleteChannel(id: string): boolean;
  getChannel(id: string): Channel | undefined;
  listChannels(limit: number, offset: number): Channel[];
  join(channelId: string, agentId: string): void;
  leave(channelId: string, agentId: string): void;
  members(channelId: string): string[];
  putAgent(agent: Agent): Agent;
  getAgent(id: string): Agent | undefined;
  listAgents(): Agent[];
  insertMessage(message: Omit<Message, "cursor">): { message: Message; duplicate: boolean };
  messages(channelId: string, after: number, limit: number): Message[];
  searchMessages(query: string, limit: number, after: number): Message[];
  mentions(agentId: string, after: number, limit: number): Message[];
  createRuntimeRequest(request: RuntimeRequest): RuntimeRequest;
  getRuntimeRequest(id: string): RuntimeRequest | undefined;
  listRuntimeRequests(hostId: string, status?: RuntimeRequest["status"]): RuntimeRequest[];
  updateRuntimeRequest(id: string, patch: Partial<RuntimeRequest>): RuntimeRequest | undefined;
  claimRuntimeRequest(id: string, hostId: string, updatedAt: number): RuntimeRequest | undefined;
  close(): void;
}

export function sameMessage(left: Omit<Message, "cursor">, right: Message): boolean {
  return (
    left.clientId === right.clientId &&
    left.channelId === right.channelId &&
    left.senderId === right.senderId &&
    left.markdown === right.markdown &&
    left.parentId === right.parentId &&
    left.mentions.length === right.mentions.length &&
    left.mentions.every((mention, index) => mention === right.mentions[index])
  );
}
