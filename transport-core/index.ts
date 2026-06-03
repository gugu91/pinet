export type RuntimeScopeSource = "explicit" | "compatibility";

export const DEFAULT_COMPATIBILITY_SCOPE_KEY = "default";

export interface WorkspaceInstallScopeCarrier {
  provider: string;
  source: RuntimeScopeSource;
  compatibilityKey?: string;
  workspaceId?: string;
  installId?: string;
  channelId?: string;
}

export interface InstanceScopeCarrier {
  source: RuntimeScopeSource;
  compatibilityKey?: string;
  instanceId?: string;
  instanceName?: string;
}

export interface RuntimeScopeCarrier {
  workspace?: WorkspaceInstallScopeCarrier;
  instance?: InstanceScopeCarrier;
}

function normalizeScopeValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function buildCompatibilityWorkspaceScope(options: {
  provider: string;
  workspaceId?: string | null;
  installId?: string | null;
  channelId?: string | null;
  compatibilityKey?: string | null;
}): WorkspaceInstallScopeCarrier {
  return {
    provider: options.provider,
    source: "compatibility",
    compatibilityKey:
      normalizeScopeValue(options.compatibilityKey) ?? DEFAULT_COMPATIBILITY_SCOPE_KEY,
    ...(normalizeScopeValue(options.workspaceId)
      ? { workspaceId: normalizeScopeValue(options.workspaceId) }
      : {}),
    ...(normalizeScopeValue(options.installId)
      ? { installId: normalizeScopeValue(options.installId) }
      : {}),
    ...(normalizeScopeValue(options.channelId)
      ? { channelId: normalizeScopeValue(options.channelId) }
      : {}),
  };
}

export function buildCompatibilityInstanceScope(
  options: {
    instanceId?: string | null;
    instanceName?: string | null;
    compatibilityKey?: string | null;
  } = {},
): InstanceScopeCarrier {
  return {
    source: "compatibility",
    compatibilityKey:
      normalizeScopeValue(options.compatibilityKey) ?? DEFAULT_COMPATIBILITY_SCOPE_KEY,
    ...(normalizeScopeValue(options.instanceId)
      ? { instanceId: normalizeScopeValue(options.instanceId) }
      : {}),
    ...(normalizeScopeValue(options.instanceName)
      ? { instanceName: normalizeScopeValue(options.instanceName) }
      : {}),
  };
}

export function buildRuntimeScopeCarrier(options: {
  workspace?: WorkspaceInstallScopeCarrier | null;
  instance?: InstanceScopeCarrier | null;
}): RuntimeScopeCarrier | undefined {
  const scope: RuntimeScopeCarrier = {};
  if (options.workspace) {
    scope.workspace = options.workspace;
  }
  if (options.instance) {
    scope.instance = options.instance;
  }
  return Object.keys(scope).length > 0 ? scope : undefined;
}

export interface InboundMessage {
  source: string;
  threadId: string;
  channel: string;
  userId: string;
  userName?: string;
  text: string;
  timestamp: string;
  isChannelMention?: boolean;
  metadata?: Record<string, unknown>;
  scope?: RuntimeScopeCarrier;
}

export interface NormalizedMessageContent {
  text: string;
  markdown?: string;
  slackBlocks?: ReadonlyArray<Record<string, unknown>>;
}

export interface OutboundMessage {
  threadId: string;
  channel: string;
  text: string;
  content?: NormalizedMessageContent;
  blocks?: ReadonlyArray<Record<string, unknown>>;
  agentName?: string;
  agentEmoji?: string;
  agentOwnerToken?: string;
  metadata?: Record<string, unknown>;
  scope?: RuntimeScopeCarrier;
}

export interface AdapterThreadClaimEffect {
  threadId: string;
  channel?: string;
}

export interface AdapterCapabilityEffects {
  claimThread?: AdapterThreadClaimEffect | ReadonlyArray<AdapterThreadClaimEffect>;
}

export interface AdapterCapabilityRequest {
  capability: string;
  params: Record<string, unknown>;
}

export interface AdapterCapabilityResult {
  result: Record<string, unknown>;
  effects?: AdapterCapabilityEffects;
}

export interface MessageAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onInbound(handler: (msg: InboundMessage) => void): void;
  send(msg: OutboundMessage): Promise<void>;
  invokeCapability?(request: AdapterCapabilityRequest): Promise<AdapterCapabilityResult>;
}
