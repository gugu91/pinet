import { createHash } from "node:crypto";
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
  setExtStatus: (ctx: ExtensionContext, state: "ok" | "reconnecting" | "error") => void;
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
  const existing = broker.db.getThread(threadTs);
  const existingMetadata = existing?.metadata ?? {};
  const scopeKey = context ? JSON.stringify(context.scope) : "workspace";
  const externalId = `${scopeKey}\0${channelId}\0${threadTs}`;
  const referenceExternalId = `${channelId}\0${threadTs}`;
  const aliasedDocument =
    broker.db.getDocumentByAlias("slack-thread-ref", referenceExternalId) ??
    broker.db.getDocumentByAlias("slack", externalId);
  const documentId =
    aliasedDocument?.documentId ??
    `doc:slack-thread:${createHash("sha256").update(externalId).digest("hex")}`;
  if (!aliasedDocument) {
    broker.db.upsertDocument({
      documentId,
      kind: "slack_thread",
      title: `Slack ${channelId}/${threadTs}`,
      ownerAgent: existing?.ownerAgent ?? null,
      ownerBinding: existing?.ownerBinding ?? null,
      metadata: {
        channelId,
        threadTs,
        ...(context ? { slackThreadContext: context } : {}),
      },
    });
  }
  broker.db.bindDocumentAlias("slack", externalId, documentId, {
    channelId,
    threadTs,
  });
  broker.db.bindDocumentAlias("slack-thread-ref", referenceExternalId, documentId, {
    channelId,
    threadTs,
  });
  broker.db.updateThread(threadTs, {
    source: "slack",
    channel: channelId,
    metadata: {
      ...existingMetadata,
      documentId,
      documentAliasExternalId: externalId,
      documentReferenceExternalId: referenceExternalId,
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
      ingressGuard: settings.ingressGuard,
      suggestedPrompts: settings.suggestedPrompts,
      reactionCommands: settings.reactionCommands as ReactionCommandSettings | undefined,
      lifecycleManagesThreadStatus: true,
      isKnownThread: (threadTs: string) =>
        shouldRouteKnownSlackThread(broker.db.getThread(threadTs)),
      getKnownThread: (threadTs: string) => getKnownSlackThread(broker, threadTs),
      rememberKnownThread: (threadTs: string, channelId: string, context) => {
        rememberKnownSlackThread(broker, threadTs, channelId, context);
      },
      isReactionThreadAuthorized: (threadTs: string, channelId: string) =>
        isAuthorizedReactionThread(broker, threadTs, channelId),
      isPinetOwnedThread: (threadTs: string, channelId: string) => {
        const thread = broker.db.getThread(threadTs);
        if (!thread || thread.source !== "slack" || thread.channel !== channelId) return false;
        return !!thread.ownerAgent || readStoredSlackThreadContext(thread.metadata) !== null;
      },
      onAppHomeOpened: async ({ userId }) => {
        await deps.onAppHomeOpened(userId, ctx);
      },
      onSocketOpen: () => deps.setExtStatus(ctx, "ok"),
      onSocketReconnectScheduled: () => deps.setExtStatus(ctx, "reconnecting"),
      onSocketError: (message, source) => {
        if (source === "connection") {
          deps.setExtStatus(ctx, "error");
        } else {
          ctx.ui.notify(`Slack event failed: ${message}`, "error");
        }
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
