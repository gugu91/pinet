import { extractSlackInteractivePayloadFromEnvelope } from "./slack-block-kit.js";

export const SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS = 10 * 60 * 1000;
export const SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE = 10_000;

export type SlackDedupEventPayload = Record<string, unknown>;
export type SlackInteractiveDedupPayload = Record<string, unknown>;
export type SlackSocketDedupFrame = Record<string, unknown>;

interface SlackReactionItemPayload {
  type?: string;
  channel?: string;
  ts?: string;
}

interface SlackAssistantThreadPayload {
  channel_id?: string;
  thread_ts?: string;
  user_id?: string;
}

interface SlackBlockActionActorPayload {
  id?: string;
}

interface SlackBlockActionContainerPayload {
  channel_id?: string;
  message_ts?: string;
  thread_ts?: string;
}

interface SlackBlockActionViewPayload {
  id?: string;
  hash?: string;
  callback_id?: string;
}

interface SlackBlockActionPayload {
  action_id?: string;
  action_ts?: string;
}

interface SlackEventsApiPayload {
  event_id?: string;
  event?: SlackDedupEventPayload;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function buildSlackMessageDedupKey(evt: SlackDedupEventPayload): string | null {
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

function buildSlackReactionDedupKey(evt: SlackDedupEventPayload): string | null {
  const item = evt.item as SlackReactionItemPayload | undefined;
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
  evt: SlackDedupEventPayload,
): string | null {
  const thread = evt.assistant_thread as SlackAssistantThreadPayload | undefined;
  if (!thread?.channel_id || !thread.thread_ts) {
    return null;
  }

  return [kind, thread.channel_id, thread.thread_ts, thread.user_id ?? ""].join(":");
}

function buildMemberJoinedDedupKey(evt: SlackDedupEventPayload): string | null {
  const channel = asNonEmptyString(evt.channel);
  const user = asNonEmptyString(evt.user);
  if (!channel || !user) {
    return null;
  }

  return ["member_joined_channel", channel, user, asNonEmptyString(evt.event_ts) ?? ""].join(":");
}

export function extractSlackEventDedupKey(evt: SlackDedupEventPayload): string | null {
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

export function extractSlackBlockActionDedupKey(
  payload: SlackInteractiveDedupPayload,
): string | null {
  if (payload.type !== "block_actions") {
    return null;
  }

  const user = payload.user as SlackBlockActionActorPayload | undefined;
  const channel = payload.channel as SlackBlockActionActorPayload | undefined;
  const container = payload.container as SlackBlockActionContainerPayload | undefined;
  const view = payload.view as SlackBlockActionViewPayload | undefined;
  const actions = Array.isArray(payload.actions)
    ? payload.actions.filter(
        (action): action is SlackBlockActionPayload =>
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
  payload: SlackInteractiveDedupPayload,
): string | null {
  if (payload.type !== "view_submission") {
    return null;
  }

  const user = payload.user as SlackBlockActionActorPayload | undefined;
  const view = payload.view as SlackBlockActionViewPayload | undefined;
  if (!view?.id) {
    return null;
  }

  return ["view_submission", user?.id ?? "", view.id, view.hash ?? "", view.callback_id ?? ""].join(
    ":",
  );
}

export function extractSlackInteractiveDedupKey(
  payload: SlackInteractiveDedupPayload,
): string | null {
  if (payload.type === "block_actions") {
    return extractSlackBlockActionDedupKey(payload);
  }
  if (payload.type === "view_submission") {
    return extractSlackViewSubmissionDedupKey(payload);
  }
  return null;
}

export function extractSlackSocketDedupKey(frame: SlackSocketDedupFrame): string | null {
  if (frame.type === "events_api") {
    const payload = frame.payload as SlackEventsApiPayload | undefined;
    const eventId = asNonEmptyString(payload?.event_id);
    if (eventId) {
      return `event:${eventId}`;
    }

    return payload?.event ? extractSlackEventDedupKey(payload.event) : null;
  }

  const interactivePayload = extractSlackInteractivePayloadFromEnvelope(frame);
  return interactivePayload ? extractSlackInteractiveDedupKey(interactivePayload) : null;
}
