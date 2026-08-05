/**
 * Pinet control/steering mail wire contract.
 *
 * These envelopes are the harness-neutral protocol every mesh worker (pi
 * followers, the Amp worker, future Codex/Claude adapters) uses to interpret
 * remote control ("interrupt"/"reload"/"exit") and steering messages delivered
 * through broker inboxes. Moved verbatim from slack-bridge/helpers.ts so
 * non-Slack workers can consume the contract without importing slack-bridge.
 */

// ─── Pinet control messages ─────────────────────────────

export type PinetControlCommand = "interrupt" | "reload" | "exit";

export type PinetControlMetadata = Record<string, unknown>;

export interface PinetControlEnvelope extends PinetControlMetadata {
  type: "pinet:control";
  action: PinetControlCommand;
}

export function parsePinetControlCommand(value: unknown): PinetControlCommand | null {
  return value === "interrupt" || value === "reload" || value === "exit" ? value : null;
}

function parsePinetControlEnvelope(value: unknown): PinetControlCommand | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as PinetControlMetadata;
  if (record.type !== "pinet:control") return null;
  return parsePinetControlCommand(record.action);
}

// agent-standards-ignore prefer-inline-single-use-helper: moved verbatim from slack-bridge/helpers.ts; keeps the structured-vs-legacy wire-format split explicit
function parseStructuredPinetControlCommandFromText(
  text: string | undefined,
): PinetControlCommand | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  try {
    return parsePinetControlEnvelope(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

// agent-standards-ignore prefer-inline-single-use-helper: moved verbatim from slack-bridge/helpers.ts; keeps the structured-vs-legacy wire-format split explicit
function parseLegacyPinetControlCommandFromText(
  text: string | undefined,
): PinetControlCommand | null {
  const trimmed = text?.trim();
  if (trimmed === "/interrupt") return "interrupt";
  if (trimmed === "/reload") return "reload";
  if (trimmed === "/exit") return "exit";
  return null;
}

export function getPinetControlCommandFromText(
  text: string | undefined,
): PinetControlCommand | null {
  return (
    parseStructuredPinetControlCommandFromText(text) ?? parseLegacyPinetControlCommandFromText(text)
  );
}

export function buildPinetControlMetadata(command: PinetControlCommand): PinetControlEnvelope {
  return { type: "pinet:control", action: command };
}

export function buildPinetControlMessage(command: PinetControlCommand): string {
  return JSON.stringify(buildPinetControlMetadata(command));
}

export function normalizeOutgoingPinetControlMessage(
  body: string,
  metadata?: PinetControlMetadata,
): { body: string; metadata: PinetControlMetadata } | null {
  const command = getPinetControlCommandFromText(body);
  if (!command) return null;

  return {
    body: buildPinetControlMessage(command),
    metadata: {
      ...(metadata ?? {}),
      ...buildPinetControlMetadata(command),
    },
  };
}

// ─── Pinet steering messages ────────────────────────────

export interface PinetSteeringEnvelope extends PinetControlMetadata {
  type: "pinet:steer";
  message: string;
}

function normalizePinetSteeringText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parsePinetSteeringEnvelope(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as PinetControlMetadata;
  if (record.type !== "pinet:steer") return null;
  return (
    normalizePinetSteeringText(record.message) ??
    normalizePinetSteeringText(record.text) ??
    normalizePinetSteeringText(record.body)
  );
}

// agent-standards-ignore prefer-inline-single-use-helper: moved verbatim from slack-bridge/helpers.ts; keeps the structured-vs-legacy wire-format split explicit
function parseStructuredPinetSteeringMessageFromText(text: string | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  try {
    return parsePinetSteeringEnvelope(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

// agent-standards-ignore prefer-inline-single-use-helper: moved verbatim from slack-bridge/helpers.ts; keeps the structured-vs-legacy wire-format split explicit
function parseLegacyPinetSteeringMessageFromText(text: string | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed?.startsWith("/steer")) return null;
  const nextChar = trimmed.charAt("/steer".length);
  if (nextChar && !/\s/.test(nextChar)) return null;
  return normalizePinetSteeringText(trimmed.slice("/steer".length));
}

export function getPinetSteeringMessageFromText(text: string | undefined): string | null {
  return (
    parseStructuredPinetSteeringMessageFromText(text) ??
    parseLegacyPinetSteeringMessageFromText(text)
  );
}

export function buildPinetSteeringMetadata(message: string): PinetSteeringEnvelope {
  return { type: "pinet:steer", message };
}

export function buildPinetSteeringMessage(message: string): string {
  return JSON.stringify(buildPinetSteeringMetadata(message));
}

export function normalizeOutgoingPinetSteeringMessage(
  body: string,
  metadata?: PinetControlMetadata,
): { body: string; metadata: PinetControlMetadata } | null {
  const message = getPinetSteeringMessageFromText(body);
  if (!message) return null;

  return {
    body: buildPinetSteeringMessage(message),
    metadata: {
      ...(metadata ?? {}),
      ...buildPinetSteeringMetadata(message),
      kind: "pinet_steer",
    },
  };
}

// ─── Inbound message classification ─────────────────────

export interface PinetControlCommandMessage {
  threadId?: string;
  body?: string;
  metadata?: PinetControlMetadata | null;
}

export function extractPinetControlCommand(
  message: PinetControlCommandMessage,
): PinetControlCommand | null {
  const metadata = message.metadata ?? {};
  if (metadata.scheduledWakeup === true) return null;

  const isAgentToAgent =
    metadata.a2a === true ||
    (typeof message.threadId === "string" && message.threadId.startsWith("a2a:"));
  const isSlackReactionInterrupt =
    metadata.slackReactionControl === true && metadata.reactionAction === "interrupt";

  const metadataCommand =
    parsePinetControlEnvelope(metadata) ??
    (metadata.kind === "pinet_control" ? parsePinetControlCommand(metadata.command) : null);

  if (isSlackReactionInterrupt) {
    return metadataCommand === "interrupt" ? "interrupt" : null;
  }

  if (!isAgentToAgent) return null;

  if (metadataCommand) return metadataCommand;

  // Backward-compatible fallback for structured JSON or exact slash commands sent over a2a flows.
  return getPinetControlCommandFromText(message.body);
}

export function extractPinetSteeringMessage(message: {
  threadId?: string;
  body?: string;
  metadata?: PinetControlMetadata | null;
}): string | null {
  const metadata = message.metadata ?? {};
  if (metadata.scheduledWakeup === true) return null;

  const metadataMessage =
    parsePinetSteeringEnvelope(metadata) ??
    (metadata.kind === "pinet_steer" || metadata.kind === "pinet_steering"
      ? (normalizePinetSteeringText(metadata.message) ??
        normalizePinetSteeringText(metadata.text) ??
        normalizePinetSteeringText(metadata.body))
      : null);

  if (metadataMessage) return metadataMessage;

  if (metadata.reactionTrigger === true && metadata.reactionAction === "steer") {
    return normalizePinetSteeringText(message.body);
  }

  return getPinetSteeringMessageFromText(message.body);
}
