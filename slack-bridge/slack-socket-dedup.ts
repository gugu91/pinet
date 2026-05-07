import { extractSlackInteractivePayloadFromEnvelope } from "./slack-block-kit.js";

export const SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS = 10 * 60 * 1000;
export const SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE = 10_000;

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function buildSlackMessageDedupKey(evt: Record<string, unknown>): string | null {
  const channel = asNonEmptyString(evt.channel);
  const ts = asNonEmptyString(evt.ts);
  if (!channel || !ts) {
    return null;
  }

  return [
    "message",
    channel,
    asNonEmptyString(evt.thread_ts) ?? "",
    ts,
    asNonEmptyString(evt.user) ?? asNonEmptyString(evt.bot_id) ?? "",
    asNonEmptyString(evt.subtype) ?? "",
  ].join(":");
}

function buildSlackReactionDedupKey(evt: Record<string, unknown>): string | null {
  const item = evt.item as { type?: string; channel?: string; ts?: string } | undefined;
  if (!item || item.type !== "message" || !item.channel || !item.ts) {
    return null;
  }

  return [
    "reaction_added",
    item.channel,
    item.ts,
    asNonEmptyString(evt.user) ?? "",
    asNonEmptyString(evt.reaction) ?? "",
    asNonEmptyString(evt.event_ts) ?? "",
  ].join(":");
}

function buildSlackAssistantThreadDedupKey(
  kind: "assistant_thread_started" | "assistant_thread_context_changed",
  evt: Record<string, unknown>,
): string | null {
  const thread = evt.assistant_thread as
    | { channel_id?: string; thread_ts?: string; user_id?: string }
    | undefined;
  if (!thread?.channel_id || !thread.thread_ts) {
    return null;
  }

  return [kind, thread.channel_id, thread.thread_ts, thread.user_id ?? ""].join(":");
}

function buildMemberJoinedDedupKey(evt: Record<string, unknown>): string | null {
  const channel = asNonEmptyString(evt.channel);
  const user = asNonEmptyString(evt.user);
  if (!channel || !user) {
    return null;
  }

  return ["member_joined_channel", channel, user, asNonEmptyString(evt.event_ts) ?? ""].join(":");
}

export function extractSlackEventDedupKey(evt: Record<string, unknown>): string | null {
  const type = asNonEmptyString(evt.type);
  if (!type) {
    return null;
  }

  switch (type) {
    case "message":
      return buildSlackMessageDedupKey(evt);
    case "reaction_added":
      return buildSlackReactionDedupKey(evt);
    case "assistant_thread_started":
      return buildSlackAssistantThreadDedupKey("assistant_thread_started", evt);
    case "assistant_thread_context_changed":
      return buildSlackAssistantThreadDedupKey("assistant_thread_context_changed", evt);
    case "member_joined_channel":
      return buildMemberJoinedDedupKey(evt);
    default: {
      const eventTs = asNonEmptyString(evt.event_ts);
      return eventTs ? [type, eventTs].join(":") : null;
    }
  }
}

export function extractSlackBlockActionDedupKey(payload: Record<string, unknown>): string | null {
  if (payload.type !== "block_actions") {
    return null;
  }

  const user = payload.user as { id?: string } | undefined;
  const channel = payload.channel as { id?: string } | undefined;
  const container = payload.container as
    | { channel_id?: string; message_ts?: string; thread_ts?: string }
    | undefined;
  const view = payload.view as { id?: string; hash?: string } | undefined;
  const actions = Array.isArray(payload.actions)
    ? payload.actions.filter(
        (action): action is { action_id?: string; action_ts?: string } =>
          typeof action === "object" && action !== null,
      )
    : [];

  const actionSignature = actions
    .map((action) => `${action.action_id ?? ""}@${action.action_ts ?? ""}`)
    .sort()
    .join(",");
  if (!actionSignature) {
    return null;
  }

  const parts = [
    "block_actions",
    user?.id ?? "",
    channel?.id ?? container?.channel_id ?? "",
    container?.thread_ts ?? "",
    container?.message_ts ?? "",
  ];
  if (view?.id || view?.hash) {
    parts.push(view?.id ?? "", view?.hash ?? "");
  }
  parts.push(actionSignature);
  return parts.join(":");
}

export function extractSlackViewSubmissionDedupKey(
  payload: Record<string, unknown>,
): string | null {
  if (payload.type !== "view_submission") {
    return null;
  }

  const user = payload.user as { id?: string } | undefined;
  const view = payload.view as { id?: string; hash?: string; callback_id?: string } | undefined;
  if (!view?.id) {
    return null;
  }

  return ["view_submission", user?.id ?? "", view.id, view.hash ?? "", view.callback_id ?? ""].join(
    ":",
  );
}

export function extractSlackInteractiveDedupKey(payload: Record<string, unknown>): string | null {
  if (payload.type === "block_actions") {
    return extractSlackBlockActionDedupKey(payload);
  }
  if (payload.type === "view_submission") {
    return extractSlackViewSubmissionDedupKey(payload);
  }
  return null;
}

export function extractSlackSocketDedupKey(frame: Record<string, unknown>): string | null {
  if (frame.type === "events_api") {
    const payload = frame.payload as
      | { event_id?: string; event?: Record<string, unknown> }
      | undefined;
    const eventId = asNonEmptyString(payload?.event_id);
    if (eventId) {
      return `event:${eventId}`;
    }

    return payload?.event ? extractSlackEventDedupKey(payload.event) : null;
  }

  if (frame.type === "slash_commands") {
    const payload = frame.payload as Record<string, unknown> | undefined;
    const triggerId = asNonEmptyString(payload?.trigger_id);
    const command = asNonEmptyString(payload?.command);
    const userId = asNonEmptyString(payload?.user_id);
    return triggerId && command
      ? ["slash_commands", command, userId ?? "", triggerId].join(":")
      : null;
  }

  const interactivePayload = extractSlackInteractivePayloadFromEnvelope(frame);
  return interactivePayload ? extractSlackInteractiveDedupKey(interactivePayload) : null;
}
