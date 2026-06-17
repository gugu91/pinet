import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SlackAdapter } from "./broker/adapters/slack.js";
import type { Broker, ThreadInfo } from "./broker/index.js";
import type { PinetRuntimeAdapterFactory } from "./pinet-runtime-composition.js";
import type { ReactionCommandSettings } from "./reaction-triggers.js";
import type {
  ParsedSlashCommand,
  ParsedThreadStarted,
  SlackThreadContext,
} from "./slack-access.js";
import type { SlackBridgeSettings } from "./helpers.js";

export function readStoredSlackThreadContext(
  metadata: Record<string, unknown> | null | undefined,
): SlackThreadContext | null {
  const value = metadata?.slackThreadContext;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (typeof record.channelId !== "string" || record.channelId.length === 0) return null;
  if (typeof record.scope !== "object" || record.scope === null || Array.isArray(record.scope)) {
    return null;
  }

  return {
    channelId: record.channelId,
    ...(typeof record.teamId === "string" && record.teamId.length > 0
      ? { teamId: record.teamId }
      : {}),
    scope: record.scope as SlackThreadContext["scope"],
  };
}

export function shouldRouteKnownSlackThread(
  thread: Pick<ThreadInfo, "source" | "channel" | "metadata"> | null,
): boolean {
  if (!thread || thread.source !== "slack") return false;
  if (!thread.channel.startsWith("D")) return true;
  return readStoredSlackThreadContext(thread.metadata) !== null;
}

export interface SlackPinetRuntimeAdapterDeps {
  getSettings: () => SlackBridgeSettings;
  getBotToken: () => string;
  getAppToken: () => string;
  getAllowedUsers: () => Set<string> | null;
  shouldAllowAllWorkspaceUsers: () => boolean;
  onAppHomeOpened: (userId: string, ctx: ExtensionContext) => Promise<void> | void;
  onSlashCommand?: (
    event: ParsedSlashCommand,
    ctx: ExtensionContext,
  ) => Promise<string | null> | string | null;
}

function getKnownSlackThread(
  broker: Broker,
  threadTs: string,
): { channelId: string; context?: ParsedThreadStarted["context"] | null } | null {
  const thread = broker.db.getThread(threadTs);
  if (!thread || thread.source !== "slack") return null;
  return {
    channelId: thread.channel,
    context: readStoredSlackThreadContext(thread.metadata),
  };
}

function rememberKnownSlackThread(
  broker: Broker,
  threadTs: string,
  channelId: string,
  context?: ParsedThreadStarted["context"] | null,
): void {
  const existingMetadata = broker.db.getThread(threadTs)?.metadata ?? {};
  broker.db.updateThread(threadTs, {
    source: "slack",
    channel: channelId,
    metadata: {
      ...existingMetadata,
      ...(context ? { slackThreadContext: context } : {}),
    },
  });
}

export function isAuthorizedReactionThread(
  broker: Broker,
  threadTs: string,
  channelId: string,
): boolean {
  const thread = broker.db.getThread(threadTs);
  if (!thread || thread.source !== "slack" || thread.channel !== channelId) return false;
  if (thread.ownerAgent) return true;
  return readStoredSlackThreadContext(thread.metadata) !== null;
}

export function createSlackPinetRuntimeAdapterFactory(
  deps: SlackPinetRuntimeAdapterDeps,
): PinetRuntimeAdapterFactory {
  return ({ broker, ctx }) => {
    const settings = deps.getSettings();
    const allowedUsers = deps.getAllowedUsers();
    const adapter = new SlackAdapter({
      botToken: deps.getBotToken(),
      appToken: deps.getAppToken(),
      allowedUsers: allowedUsers ? [...allowedUsers] : undefined,
      allowAllWorkspaceUsers: deps.shouldAllowAllWorkspaceUsers(),
      suggestedPrompts: settings.suggestedPrompts,
      reactionCommands: settings.reactionCommands as ReactionCommandSettings | undefined,
      isKnownThread: (threadTs: string) =>
        shouldRouteKnownSlackThread(broker.db.getThread(threadTs)),
      getKnownThread: (threadTs: string) => getKnownSlackThread(broker, threadTs),
      rememberKnownThread: (threadTs: string, channelId: string, context) => {
        rememberKnownSlackThread(broker, threadTs, channelId, context);
      },
      isReactionThreadAuthorized: (threadTs: string, channelId: string) =>
        isAuthorizedReactionThread(broker, threadTs, channelId),
      onAppHomeOpened: async ({ userId }) => {
        await deps.onAppHomeOpened(userId, ctx);
      },
      onSlashCommand: deps.onSlashCommand
        ? (event) => deps.onSlashCommand?.(event, ctx) ?? null
        : undefined,
    });

    return {
      adapter,
      getBotUserId: () => adapter.getBotUserId(),
    };
  };
}
