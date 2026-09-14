import type {
  Agent,
  Channel,
  ChatStorage,
  Message,
  RuntimeCredential,
  RuntimeRequest,
} from "./domain.js";
import { ChatConflictError, ChatNotFoundError, sameMessage } from "./domain.js";

export class MemoryChatStorage implements ChatStorage {
  protected readonly channelRows = new Map<string, Channel>();
  protected readonly agentRows = new Map<string, Agent>();
  protected readonly membershipRows = new Map<string, Set<string>>();
  protected readonly messageRows: Message[] = [];
  protected readonly runtimeRows = new Map<string, RuntimeRequest>();
  protected readonly runtimeCredentialRows = new Map<string, RuntimeCredential>();
  protected cursor = 0;

  createChannel(channel: Channel): Channel {
    if ([...this.channelRows.values()].some((row) => row.name === channel.name))
      throw new ChatConflictError("channel name already exists");
    this.channelRows.set(channel.id, channel);
    return channel;
  }
  updateChannel(id: string, patch: { name?: string; topic?: string }): Channel | undefined {
    const current = this.channelRows.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    if ([...this.channelRows.values()].some((row) => row.id !== id && row.name === next.name))
      throw new ChatConflictError("channel name already exists");
    this.channelRows.set(id, next);
    return next;
  }
  deleteChannel(id: string): boolean {
    if (!this.channelRows.delete(id)) return false;
    this.membershipRows.delete(id);
    for (const [agentId, agent] of this.agentRows)
      if (agent.homeChannelId === id)
        this.agentRows.set(agentId, { ...agent, homeChannelId: null });
    for (let index = this.messageRows.length - 1; index >= 0; index--)
      if (this.messageRows[index]!.channelId === id) this.messageRows.splice(index, 1);
    return true;
  }
  getChannel(id: string): Channel | undefined {
    return this.channelRows.get(id);
  }
  listChannels(limit: number, offset: number): Channel[] {
    return [...this.channelRows.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(offset, offset + limit);
  }
  join(channelId: string, agentId: string): void {
    if (!this.channelRows.has(channelId)) throw new ChatNotFoundError("channel not found");
    const members = this.membershipRows.get(channelId) ?? new Set<string>();
    members.add(agentId);
    this.membershipRows.set(channelId, members);
  }
  leave(channelId: string, agentId: string): void {
    this.membershipRows.get(channelId)?.delete(agentId);
  }
  members(channelId: string): string[] {
    return [...(this.membershipRows.get(channelId) ?? [])].sort();
  }
  putAgent(agent: Agent): Agent {
    this.agentRows.set(agent.id, agent);
    return agent;
  }
  getAgent(id: string): Agent | undefined {
    return this.agentRows.get(id);
  }
  listAgents(): Agent[] {
    return [...this.agentRows.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  insertMessage(input: Omit<Message, "cursor">): { message: Message; duplicate: boolean } {
    const existing = this.messageRows.find(
      (row) => row.senderId === input.senderId && row.clientId === input.clientId,
    );
    if (existing) {
      if (!sameMessage(input, existing))
        throw new ChatConflictError("client id reused with different payload");
      return { message: existing, duplicate: true };
    }
    if (!this.channelRows.has(input.channelId)) throw new ChatNotFoundError("channel not found");
    if (input.parentId) {
      const parent = this.messageRows.find((row) => row.id === input.parentId);
      if (!parent || parent.channelId !== input.channelId)
        throw new ChatNotFoundError("thread parent not found in channel");
    }
    const message = { ...input, cursor: ++this.cursor };
    this.messageRows.push(message);
    return { message, duplicate: false };
  }
  messages(channelId: string, after: number, limit: number): Message[] {
    return this.messageRows
      .filter((row) => row.channelId === channelId && row.cursor > after)
      .slice(0, limit);
  }
  searchMessages(query: string, limit: number, after: number): Message[] {
    const needle = query.toLowerCase();
    return this.messageRows
      .filter((row) => row.cursor > after && row.markdown.toLowerCase().includes(needle))
      .slice(0, limit);
  }
  mentions(agentId: string, after: number, limit: number): Message[] {
    return this.messageRows
      .filter((row) => row.cursor > after && row.mentions.includes(agentId))
      .slice(0, limit);
  }
  createRuntimeRequest(request: RuntimeRequest): RuntimeRequest {
    this.runtimeRows.set(request.id, request);
    return request;
  }
  getRuntimeRequest(id: string): RuntimeRequest | undefined {
    return this.runtimeRows.get(id);
  }
  listRuntimeRequests(hostId: string, status?: RuntimeRequest["status"]): RuntimeRequest[] {
    return [...this.runtimeRows.values()].filter(
      (row) => row.hostId === hostId && (!status || row.status === status),
    );
  }
  updateRuntimeRequest(id: string, patch: Partial<RuntimeRequest>): RuntimeRequest | undefined {
    const current = this.runtimeRows.get(id);
    if (!current) return undefined;
    const next = {
      ...current,
      ...patch,
      id: current.id,
      hostId: current.hostId,
      requestedBy: current.requestedBy,
    };
    this.runtimeRows.set(id, next);
    return next;
  }
  claimRuntimeRequest(id: string, hostId: string, updatedAt: number): RuntimeRequest | undefined {
    const current = this.runtimeRows.get(id);
    if (!current || current.hostId !== hostId || current.status !== "pending") return undefined;
    return this.updateRuntimeRequest(id, { status: "claimed", updatedAt });
  }
  putRuntimeCredential(value: RuntimeCredential): void {
    this.runtimeCredentialRows.set(value.requestId, value);
  }
  runtimeCredentialByHash(tokenHash: string): RuntimeCredential | undefined {
    return [...this.runtimeCredentialRows.values()].find((row) => row.tokenHash === tokenHash);
  }
  deleteRuntimeCredential(requestId: string): void {
    this.runtimeCredentialRows.delete(requestId);
  }
  close(): void {}
}
