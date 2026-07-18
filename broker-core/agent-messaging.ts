import { classifyPinetMail } from "./mail-classification.js";
import type { AgentInfo, BrokerMessage } from "./types.js";

type AgentMessageMetadataObject = Record<string, unknown>;

interface AgentCapabilities {
  repo?: string;
  role?: string;
  tools?: string[];
  tags?: string[];
}

export interface AgentMessageMetadata extends AgentMessageMetadataObject {
  senderAgent?: string;
  a2a?: boolean;
  broadcast?: boolean;
  broadcastChannel?: string;
  trustedBrokerAgentId?: string;
  emergency?: boolean;
  targetScope?: string;
  capabilities?: AgentCapabilities;
  repo?: string;
  role?: string;
  broadcastChannels?: string[];
  channels?: string[];
  topics?: string[];
}

function asRecord(value: unknown): AgentMessageMetadataObject | null {
  return typeof value === "object" && value !== null ? (value as AgentMessageMetadataObject) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractAgentCapabilities(
  metadata: AgentMessageMetadataObject | null | undefined,
): AgentCapabilities {
  const record = asRecord(metadata);
  const capabilitiesRecord = asRecord(record?.capabilities);

  return {
    repo: asString(capabilitiesRecord?.repo) ?? asString(record?.repo),
    role: asString(capabilitiesRecord?.role) ?? asString(record?.role),
    tools: asStringArray(capabilitiesRecord?.tools),
    tags: asStringArray(capabilitiesRecord?.tags),
  };
}

function buildAgentCapabilityTags(capabilities: AgentCapabilities): string[] {
  const tags = new Set<string>();

  if (capabilities.role) tags.add(`role:${capabilities.role}`);
  if (capabilities.repo) tags.add(`repo:${capabilities.repo}`);
  for (const tool of capabilities.tools ?? []) {
    tags.add(`tool:${tool}`);
  }
  for (const tag of capabilities.tags ?? []) {
    tags.add(tag);
  }

  return [...tags];
}

export interface AgentMessageStorage {
  getAgents(): AgentInfo[];
  /** Durable identities, including resumably disconnected agents. */
  getAllAgents?(): AgentInfo[];
  getThread(threadId: string): { threadId: string } | null;
  createThread(threadId: string, source: string, channel: string, ownerAgent: string | null): void;
  insertMessage(
    threadId: string,
    source: string,
    direction: "inbound" | "outbound",
    sender: string,
    body: string,
    targetAgentIds: string[],
    metadata?: AgentMessageMetadata,
  ): BrokerMessage;
  getMessageByExternalId?(source: string, externalId: string): BrokerMessage | null;
}

export interface AgentDispatchTarget {
  id: string;
  name: string;
}

export interface DirectAgentDispatchInput {
  senderAgentId: string;
  senderAgentName: string;
  target: string;
  body: string;
  metadata?: AgentMessageMetadata;
  trustedBrokerAgentId?: string;
}

export interface BroadcastAgentDispatchInput {
  senderAgentId: string;
  senderAgentName: string;
  channel: string;
  body: string;
  metadata?: AgentMessageMetadata;
}

export interface DirectAgentDispatchResult {
  target: AgentDispatchTarget;
  messageId: number;
  threadId: string;
}

export interface BroadcastAgentDispatchResult {
  channel: string;
  targets: AgentDispatchTarget[];
  messageIds: number[];
  threadIds: string[];
}

export type AgentDispatchCallback = (
  target: AgentDispatchTarget,
  message: BrokerMessage,
  metadata: AgentMessageMetadata,
) => void;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeChannelName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withoutHash = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  const normalized = withoutHash.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function addChannel(set: Set<string>, rawValue: string): void {
  const normalized = normalizeChannelName(rawValue);
  if (!normalized) return;
  set.add(normalized);

  if (normalized.startsWith("channel:") || normalized.startsWith("topic:")) {
    const derived = normalized.slice(normalized.indexOf(":") + 1).trim();
    if (derived) {
      set.add(derived);
    }
  }
}

function ensurePairThread(
  storage: AgentMessageStorage,
  senderAgentId: string,
  targetAgentId: string,
): string {
  const threadId = `a2a:${senderAgentId}:${targetAgentId}`;
  if (!storage.getThread(threadId)) {
    storage.createThread(threadId, "agent", "", senderAgentId);
  }
  return threadId;
}

function buildAgentMessageMetadata(
  senderAgentName: string,
  body: string,
  metadata?: AgentMessageMetadata,
  broadcastChannel?: string,
): AgentMessageMetadata {
  const baseMetadata: AgentMessageMetadata = {
    ...metadata,
    senderAgent: senderAgentName,
    a2a: true,
    ...(broadcastChannel ? { broadcast: true, broadcastChannel } : {}),
  };
  const classification = classifyPinetMail({ source: "agent", body, metadata: baseMetadata });

  return {
    ...baseMetadata,
    pinetMailClass: classification.class,
  };
}

function deliverAgentMessage(
  storage: AgentMessageStorage,
  senderAgentId: string,
  target: AgentDispatchTarget,
  body: string,
  metadata: AgentMessageMetadata,
  onDispatch?: AgentDispatchCallback,
): { threadId: string; messageId: number } {
  const threadId = ensurePairThread(storage, senderAgentId, target.id);
  const msg = storage.insertMessage(
    threadId,
    "agent",
    "inbound",
    senderAgentId,
    body,
    [target.id],
    metadata,
  );
  onDispatch?.(target, msg, metadata);
  return { threadId, messageId: msg.id };
}

export function isBroadcastChannelTarget(target: string): boolean {
  return target.trim().startsWith("#");
}

export function normalizeBroadcastChannel(channel: string): string | null {
  return normalizeChannelName(channel);
}

export function getAgentBroadcastChannels(agent: Pick<AgentInfo, "metadata">): string[] {
  const subscriptions = new Set<string>(["all"]);
  const metadata = asRecord(agent.metadata);
  const capabilities = extractAgentCapabilities(metadata);

  if (capabilities.repo) {
    addChannel(subscriptions, capabilities.repo);
  }

  const role = capabilities.role?.trim().toLowerCase();
  if (role) {
    addChannel(subscriptions, `role:${role}`);
  }

  if (role !== "broker") {
    addChannel(subscriptions, "standup");
  }

  for (const tag of buildAgentCapabilityTags(capabilities)) {
    addChannel(subscriptions, tag);
  }

  for (const channel of asStringArray(metadata?.broadcastChannels)) {
    addChannel(subscriptions, channel);
  }

  for (const channel of asStringArray(metadata?.channels)) {
    addChannel(subscriptions, channel);
  }

  for (const topic of asStringArray(metadata?.topics)) {
    addChannel(subscriptions, `topic:${topic}`);
  }

  return [...subscriptions].sort();
}

export function agentSubscribesToBroadcastChannel(
  agent: Pick<AgentInfo, "metadata">,
  channel: string,
): boolean {
  const normalized = normalizeBroadcastChannel(channel);
  if (!normalized) return false;
  return getAgentBroadcastChannels(agent).includes(normalized);
}

export function resolveDirectAgentTarget(agents: AgentInfo[], target: string): AgentInfo | null {
  return (
    agents.find((agent) => agent.id === target) ??
    agents.find((agent) => agent.name === target) ??
    null
  );
}

function isDescendantOf(agents: AgentInfo[], descendantId: string, ancestorId: string): boolean {
  let current = agents.find((agent) => agent.id === descendantId) ?? null;
  const seen = new Set<string>();
  while (current?.parentAgentId) {
    if (current.parentAgentId === ancestorId) return true;
    if (seen.has(current.parentAgentId)) return false;
    seen.add(current.parentAgentId);
    current = agents.find((agent) => agent.id === current?.parentAgentId) ?? null;
  }
  return false;
}

function canDispatchDirectAgentMessage(
  agents: AgentInfo[],
  sender: AgentInfo | null,
  target: AgentInfo,
  metadata?: AgentMessageMetadata,
): boolean {
  if (!sender) return false;
  if (
    !target.parentAgentId &&
    target.supervisionState !== "supervised" &&
    target.supervisionState !== "orphaned" &&
    target.supervisionState !== "stopping"
  ) {
    return true;
  }
  if (sender.id === metadata?.trustedBrokerAgentId) {
    return metadata.emergency === true || metadata.targetScope === "subtree";
  }
  if (target.parentAgentId === sender.id) return true;
  if (sender.parentAgentId === target.id) return true;
  if (isDescendantOf(agents, target.id, sender.id)) return true;
  if (isDescendantOf(agents, sender.id, target.id)) return true;
  return false;
}

export function resolveBroadcastTargets(
  agents: AgentInfo[],
  senderAgentId: string,
  channel: string,
): AgentInfo[] {
  return agents
    .filter((agent) => agent.id !== senderAgentId)
    .filter(
      (agent) =>
        !agent.parentAgentId &&
        agent.supervisionState !== "supervised" &&
        agent.supervisionState !== "orphaned" &&
        agent.supervisionState !== "stopping",
    )
    .filter((agent) => agentSubscribesToBroadcastChannel(agent, channel))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function dispatchDirectAgentMessage(
  storage: AgentMessageStorage,
  input: DirectAgentDispatchInput,
  onDispatch?: AgentDispatchCallback,
): DirectAgentDispatchResult {
  const agents = storage.getAllAgents?.() ?? storage.getAgents();
  const target = resolveDirectAgentTarget(agents, input.target);
  if (!target) {
    throw new Error(`Agent not found: ${input.target}`);
  }
  const sender = agents.find((agent) => agent.id === input.senderAgentId) ?? null;
  const policyMetadata: AgentMessageMetadata = { ...(input.metadata ?? {}) };
  delete policyMetadata.trustedBrokerAgentId;
  if (input.trustedBrokerAgentId) {
    policyMetadata.trustedBrokerAgentId = input.trustedBrokerAgentId;
  }
  if (!canDispatchDirectAgentMessage(agents, sender, target, policyMetadata)) {
    throw new Error(
      `Agent ${input.senderAgentId} cannot message supervised agent ${target.id} without parent/subtree visibility or an explicit broker emergency override.`,
    );
  }

  const resolvedTarget: AgentDispatchTarget = { id: target.id, name: target.name };
  const metadata = buildAgentMessageMetadata(input.senderAgentName, input.body, input.metadata);
  const expectedThreadId = `a2a:${input.senderAgentId}:${resolvedTarget.id}`;
  const rawExternalId = metadata.externalId ?? metadata.external_id;
  const externalId =
    typeof rawExternalId === "string" && rawExternalId.trim().length > 0
      ? rawExternalId.trim()
      : null;
  if (externalId && storage.getMessageByExternalId) {
    const committed = storage.getMessageByExternalId("agent", externalId);
    if (committed) {
      if (
        committed.threadId !== expectedThreadId ||
        committed.sender !== input.senderAgentId ||
        committed.body !== input.body
      ) {
        throw new Error('Idempotency key collision for transport source "agent".');
      }
      return { target: resolvedTarget, messageId: committed.id, threadId: expectedThreadId };
    }
  }
  const { threadId, messageId } = deliverAgentMessage(
    storage,
    input.senderAgentId,
    resolvedTarget,
    input.body,
    metadata,
    onDispatch,
  );

  return {
    target: resolvedTarget,
    messageId,
    threadId,
  };
}

export function dispatchBroadcastAgentMessage(
  storage: AgentMessageStorage,
  input: BroadcastAgentDispatchInput,
  onDispatch?: AgentDispatchCallback,
): BroadcastAgentDispatchResult {
  const normalizedChannel = normalizeBroadcastChannel(input.channel);
  if (!normalizedChannel) {
    throw new Error("Broadcast channel is required");
  }

  const agents = storage.getAgents();
  const targets = resolveBroadcastTargets(agents, input.senderAgentId, normalizedChannel).map(
    (agent) => ({ id: agent.id, name: agent.name }),
  );

  if (targets.length === 0) {
    throw new Error(`No agents subscribed to #${normalizedChannel} other than the sender.`);
  }

  const broadcastChannel = `#${normalizedChannel}`;
  const metadata = buildAgentMessageMetadata(
    input.senderAgentName,
    input.body,
    input.metadata,
    broadcastChannel,
  );

  const messageIds: number[] = [];
  const threadIds: string[] = [];

  for (const target of targets) {
    const delivery = deliverAgentMessage(
      storage,
      input.senderAgentId,
      target,
      input.body,
      metadata,
      onDispatch,
    );
    messageIds.push(delivery.messageId);
    threadIds.push(delivery.threadId);
  }

  return {
    channel: broadcastChannel,
    targets,
    messageIds,
    threadIds,
  };
}
