import {
  decodeSlackModalPrivateMetadata,
  type DecodedSlackModalPrivateMetadata,
} from "./slack-modals.js";

export type SlackBlock = Record<string, unknown>;

export interface SlackNormalizedBlockAction {
  actionId: string;
  blockId?: string;
  text?: string;
  type?: string;
  style?: string;
  url?: string;
  value?: string;
  parsedValue?: unknown;
  actionTs?: string;
}

export interface SlackSanitizedBlockAction extends Record<string, unknown> {
  actionId: string;
  blockId: string | null;
  text: string | null;
  type: string | null;
  style: string | null;
  value: string | null;
  parsedValue: SlackNormalizedBlockAction["parsedValue"];
  actionTs: string | null;
}

export interface SlackBlockActionMetadata extends Record<string, unknown> {
  kind: "slack_block_action";
  triggerId: string | null;
  viewId: string | null;
  callbackId: string | null;
  viewHash: string | null;
  blockId: string | null;
  actionId: string;
  value: string | null;
  parsedValue: SlackNormalizedBlockAction["parsedValue"];
  actionText: string | null;
  channel: string;
  threadTs: string;
  messageTs: string | null;
  modalPrivateMetadata: DecodedSlackModalPrivateMetadata["value"];
  actions: SlackSanitizedBlockAction[];
}

export type SlackViewSubmissionStateValue = SlackBlock;
export type SlackViewSubmissionStateValues = Record<
  string,
  Record<string, SlackViewSubmissionStateValue>
>;

export interface SlackViewSubmissionMetadata extends Record<string, unknown> {
  kind: "slack_view_submission";
  triggerId: string | null;
  callbackId: string | null;
  viewId: string;
  externalId: string | null;
  viewHash: string | null;
  channel: string;
  threadTs: string;
  privateMetadata: DecodedSlackModalPrivateMetadata["value"];
  stateValues: SlackViewSubmissionStateValues;
}

export interface SlackBlockActionInboxEvent {
  channel: string;
  threadTs: string;
  userId: string;
  text: string;
  timestamp: string;
  metadata: SlackBlockActionMetadata;
}

export interface SlackViewSubmissionInboxEvent {
  channel: string;
  threadTs: string;
  userId: string;
  text: string;
  timestamp: string;
  metadata: SlackViewSubmissionMetadata;
}

export type SlackInteractiveInboxEvent = SlackBlockActionInboxEvent | SlackViewSubmissionInboxEvent;

function isSlackBlockKitObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isSlackBlockKitObject(value) ? value : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !isSlackBlockKitObject(item))) {
    throw new Error("Slack blocks must be a JSON array of objects.");
  }
  return value as Record<string, unknown>[];
}

function tryParseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeViewStateValue(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (typeof value.type === "string") {
    result.type = value.type;
  }
  if (typeof value.value === "string") {
    result.value = value.value;
  }
  if (typeof value.selected_date === "string") {
    result.selectedDate = value.selected_date;
  }
  if (typeof value.selected_time === "string") {
    result.selectedTime = value.selected_time;
  }
  if (typeof value.selected_conversation === "string") {
    result.selectedConversation = value.selected_conversation;
  }
  if (typeof value.selected_channel === "string") {
    result.selectedChannel = value.selected_channel;
  }
  if (typeof value.selected_user === "string") {
    result.selectedUser = value.selected_user;
  }
  if (typeof value.selected_option === "object" && value.selected_option !== null) {
    result.selectedOption = value.selected_option;
  }
  if (Array.isArray(value.selected_options)) {
    result.selectedOptions = value.selected_options;
  }
  if (Array.isArray(value.selected_conversations)) {
    result.selectedConversations = value.selected_conversations;
  }
  if (Array.isArray(value.selected_channels)) {
    result.selectedChannels = value.selected_channels;
  }
  if (Array.isArray(value.selected_users)) {
    result.selectedUsers = value.selected_users;
  }

  return result;
}

function getActionText(action: Record<string, unknown>): string | undefined {
  const text = asRecord(action.text);
  return asString(text?.text);
}

function normalizeAction(action: Record<string, unknown>): SlackNormalizedBlockAction | null {
  const actionId = asString(action.action_id);
  if (!actionId) return null;

  const value = asString(action.value);
  return {
    actionId,
    blockId: asString(action.block_id),
    text: getActionText(action),
    type: asString(action.type),
    style: asString(action.style),
    value,
    parsedValue: tryParseJson(value),
    actionTs: asString(action.action_ts),
  };
}

function sanitizeNormalizedActions(
  actions: SlackNormalizedBlockAction[],
): SlackSanitizedBlockAction[] {
  return actions.map((action) => ({
    actionId: action.actionId,
    blockId: action.blockId ?? null,
    text: action.text ?? null,
    type: action.type ?? null,
    style: action.style ?? null,
    value: action.value ?? null,
    parsedValue: action.parsedValue ?? null,
    actionTs: action.actionTs ?? null,
  }));
}

export function normalizeSlackBlocksInput(blocks: unknown): SlackBlock[] {
  return asRecordArray(blocks).map((block) => ({ ...block }));
}

export function summarizeSlackBlocksForPolicy(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "0";
  return String(blocks.length);
}

export function encodeSlackBlockActionValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function extractSlackInteractivePayloadFromEnvelope(
  envelope: Record<string, unknown>,
): Record<string, unknown> | null {
  if (envelope.type !== "interactive") return null;

  const payloadValue = envelope.payload;
  let payload: unknown = payloadValue;
  if (typeof payloadValue === "string") {
    try {
      payload = JSON.parse(payloadValue) as unknown;
    } catch {
      return null;
    }
  }

  if (!isSlackBlockKitObject(payload)) return null;
  return payload;
}

export function extractSlackBlockActionsPayloadFromEnvelope(
  envelope: Record<string, unknown>,
): Record<string, unknown> | null {
  const payload = extractSlackInteractivePayloadFromEnvelope(envelope);
  return payload?.type === "block_actions" ? payload : null;
}

export function normalizeSlackBlockActionPayload(
  payload: Record<string, unknown>,
): SlackBlockActionInboxEvent | null {
  const user = asRecord(payload.user);
  const container = asRecord(payload.container);
  const channel = asRecord(payload.channel);
  const message = asRecord(payload.message);
  const view = asRecord(payload.view);
  const actions = Array.isArray(payload.actions)
    ? payload.actions
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];

  const normalizedActions = actions
    .map(normalizeAction)
    .filter((action): action is SlackNormalizedBlockAction => Boolean(action));
  if (normalizedActions.length === 0) return null;

  const modalMetadata = decodeSlackModalPrivateMetadata(asString(view?.private_metadata));
  const channelId =
    asString(container?.channel_id) ??
    asString(channel?.id) ??
    asString((message?.channel as Record<string, unknown> | undefined)?.id) ??
    modalMetadata.threadContext?.channel;
  const messageTs = asString(container?.message_ts) ?? asString(message?.ts);
  const threadTs =
    asString(container?.thread_ts) ??
    asString(message?.thread_ts) ??
    messageTs ??
    modalMetadata.threadContext?.threadTs;
  const userId = asString(user?.id);

  if (!channelId || !threadTs || !userId) return null;

  const primaryAction = normalizedActions[0];
  const label = primaryAction.text?.trim() ? `"${primaryAction.text.trim()}"` : "button";
  const timestamp =
    primaryAction.actionTs ??
    asString(payload.action_ts) ??
    asString(view?.hash) ??
    messageTs ??
    threadTs;

  return {
    channel: channelId,
    threadTs,
    userId,
    text: `Clicked Slack ${label} (action_id: ${primaryAction.actionId}).`,
    timestamp,
    metadata: {
      kind: "slack_block_action",
      triggerId: asString(payload.trigger_id) ?? null,
      viewId: asString(view?.id) ?? null,
      callbackId: asString(view?.callback_id) ?? null,
      viewHash: asString(view?.hash) ?? null,
      blockId: primaryAction.blockId ?? null,
      actionId: primaryAction.actionId,
      value: primaryAction.value ?? null,
      parsedValue: primaryAction.parsedValue ?? null,
      actionText: primaryAction.text ?? null,
      channel: channelId,
      threadTs,
      messageTs: messageTs ?? null,
      modalPrivateMetadata: modalMetadata.value ?? null,
      actions: sanitizeNormalizedActions(normalizedActions),
    },
  };
}

export function normalizeSlackViewSubmissionPayload(
  payload: Record<string, unknown>,
): SlackViewSubmissionInboxEvent | null {
  if (payload.type !== "view_submission") {
    return null;
  }

  const user = asRecord(payload.user);
  const view = asRecord(payload.view);
  const state = asRecord(view?.state);
  const stateValues = asRecord(state?.values);
  const userId = asString(user?.id);
  const viewId = asString(view?.id);
  const modalMetadata = decodeSlackModalPrivateMetadata(asString(view?.private_metadata));
  const threadTs = modalMetadata.threadContext?.threadTs;
  const channel = modalMetadata.threadContext?.channel;

  if (!userId || !threadTs || !channel || !viewId || !stateValues) {
    return null;
  }

  const normalizedValues: SlackViewSubmissionStateValues = {};
  for (const [blockId, rawActions] of Object.entries(stateValues)) {
    const actionMap = asRecord(rawActions);
    if (!actionMap) continue;
    normalizedValues[blockId] = Object.fromEntries(
      Object.entries(actionMap).map(([actionId, rawValue]) => [
        actionId,
        normalizeViewStateValue(asRecord(rawValue) ?? {}),
      ]),
    );
  }

  const callbackId = asString(view?.callback_id);
  const titleText = asString((asRecord(view?.title) ?? {}).text);
  const timestamp = asString(payload.hash) ?? viewId;

  return {
    channel,
    threadTs,
    userId,
    text: `Submitted Slack modal ${callbackId ? `(${callbackId}) ` : ""}${titleText ? `"${titleText}"` : `view ${viewId}`}.`,
    timestamp,
    metadata: {
      kind: "slack_view_submission",
      triggerId: asString(payload.trigger_id) ?? null,
      callbackId: callbackId ?? null,
      viewId,
      externalId: asString(view?.external_id) ?? null,
      viewHash: asString(view?.hash) ?? null,
      channel,
      threadTs,
      privateMetadata: modalMetadata.value ?? null,
      stateValues: normalizedValues,
    },
  };
}
