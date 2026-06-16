import os from "node:os";
import {
  buildCompactPinetReadDetails,
  formatPinetReadResultCompact,
  formatPinetReadResultFull,
  type PinetReadOptions,
  type PinetReadResult,
} from "@pinet/pinet-core/pinet-read-formatting";
import {
  normalizePinetOutputOptions,
  type PinetOutputOptions,
} from "@pinet/pinet-core/output-options";
import {
  parseScheduledWakeupDelay,
  resolveScheduledWakeupFireAt,
} from "@pinet/pinet-core/scheduled-wakeups";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  buildAgentDisplayInfo,
  filterAgentsForMeshVisibility,
  formatAgentList,
  rankAgentsForRouting,
  type AgentDisplayInfo,
} from "./helpers.js";
import { isBroadcastChannelTarget } from "./broker/agent-messaging.js";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from "./broker/socket-server.js";
import { HEARTBEAT_INTERVAL_MS } from "./broker/client.js";
import type { RalphSnoozeStatus } from "./ralph-loop.js";
import type {
  PortLeaseAcquireInput,
  PortLeaseInfo,
  PortLeaseListOptions,
  PortLeaseReleaseInput,
  PortLeaseRenewInput,
  PinetLaneInfo,
  PinetLaneListOptions,
  PinetLaneParticipantInfo,
  PinetLaneParticipantUpsertInput,
  PinetLaneRole,
  PinetLaneState,
  PinetLaneUpsertInput,
} from "./broker/types.js";

export interface PinetToolsAgentRecord {
  emoji: string;
  name: string;
  id: string;
  pid?: number;
  status: "working" | "idle";
  metadata: Record<string, unknown> | null;
  lastHeartbeat: string;
  lastSeen?: string;
  disconnectedAt?: string | null;
  resumableUntil?: string | null;
  outboundCount?: number;
  pendingInboxCount?: number;
  parentAgentId?: string | null;
  rootAgentId?: string | null;
  treeDepth?: number;
  supervisionState?: string;
  subtreeRole?: string | null;
  laneId?: string | null;
}

export interface PinetSubtreeSpawnInput {
  task: string;
  repo: string;
  role?: string;
  laneId?: string;
}

export interface PinetSubtreeSpawnResult {
  status: "started";
  launchId: string;
  sessionName: string;
  repoPath: string;
  role: string;
  laneId: string | null;
  agentId: string;
  agentName: string;
  messageId: number;
  threadId: string;
  monitorCommand: string;
  socketPath: string;
  dbPath: string;
  childLaunchEnv: Record<string, string>;
}

export interface RegisterPinetToolsDeps {
  pinetEnabled: () => boolean;
  brokerRole: () => "broker" | "follower" | null;
  requireToolPolicy: (toolName: string, threadTs: string | undefined, action: string) => void;
  sendPinetAgentMessage: (
    target: string,
    body: string,
    metadata?: Record<string, unknown>,
  ) => Promise<{
    messageId: number;
    target: string;
    transferredThreadId?: string;
    transferredThreadChannel?: string;
  }>;
  sendPinetBroadcastMessage: (
    channel: string,
    body: string,
  ) => {
    channel: string;
    messageIds: number[];
    recipients: string[];
  };
  signalAgentFree: (
    ctx: ExtensionContext | undefined,
    options: { requirePinet?: boolean },
  ) => Promise<{ queuedInboxCount: number; drainedQueuedInbox: boolean }>;
  scheduleBrokerWakeup: (
    fireAt: string,
    message: string,
  ) => Promise<{ id: number; fireAt: string }>;
  scheduleFollowerWakeup: (
    fireAt: string,
    message: string,
  ) => Promise<{ id: number; fireAt: string }>;
  readPinetInbox: (options: PinetReadOptions) => Promise<PinetReadResult>;
  listBrokerAgents: () => PinetToolsAgentRecord[];
  listFollowerAgents: (includeGhosts: boolean) => Promise<PinetToolsAgentRecord[]>;
  listSubtreeAgents?: (includeGhosts: boolean) => PinetToolsAgentRecord[] | null;
  getSubtreeSelfAgentId?: () => string | null;
  spawnSubtreeWorker?: (input: PinetSubtreeSpawnInput) => Promise<PinetSubtreeSpawnResult>;
  listPinetLanes: (options: PinetLaneListOptions) => Promise<PinetLaneInfo[]>;
  upsertPinetLane: (input: PinetLaneUpsertInput) => Promise<PinetLaneInfo>;
  setPinetLaneParticipant: (
    input: PinetLaneParticipantUpsertInput,
  ) => Promise<PinetLaneParticipantInfo>;
  acquirePortLease: (input: PortLeaseAcquireInput) => Promise<PortLeaseInfo>;
  renewPortLease: (input: PortLeaseRenewInput) => Promise<PortLeaseInfo>;
  releasePortLease: (input: PortLeaseReleaseInput) => Promise<PortLeaseInfo>;
  getPortLease: (leaseId: string) => Promise<PortLeaseInfo | null>;
  listPortLeases: (options: PortLeaseListOptions) => Promise<PortLeaseInfo[]>;
  expirePortLeases: () => Promise<PortLeaseInfo[]>;
  ralphSnoozeStatus?: () => RalphSnoozeStatus | null;
  snoozeRalphLoop?: (input: { durationMs: number; reason?: string | null }) => RalphSnoozeStatus;
  clearRalphSnooze?: () => RalphSnoozeStatus;
}

interface PinetAgentsRoutingHint {
  repo?: string;
  branch?: string;
  role?: string;
  requiredTools?: string[];
  task?: string;
  scope?: "visible" | "children" | "subtree" | "all";
}

type PinetDispatcherAction =
  | "send"
  | "read"
  | "free"
  | "snooze"
  | "schedule"
  | "agents"
  | "lanes"
  | "ports"
  | "spawn"
  | "reload"
  | "exit"
  | "help";
type PinetDispatcherErrorClass = "input" | "state" | "runtime" | "network";

type PinetDispatcherStatus = "succeeded" | "failed";

interface PinetToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  compactDetails?: unknown;
  fullDetails?: unknown;
  // Renderer-only, human-readable expanded body for the Pi TUI. Never sent to
  // the model and never part of the machine `data.details` contract. When set,
  // the expanded tool card shows this instead of JSON-dumping `data.details`.
  expandedText?: string;
  // Optional model/machine-safe text when the operator-facing content includes
  // previews that must stay out of `format=json` serialized envelopes.
  machineText?: string;
}

interface PinetActionDefinition {
  name: PinetDispatcherAction;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    output: PinetOutputOptions,
  ) => Promise<PinetToolResult>;
}

interface PinetDispatcherError {
  class: PinetDispatcherErrorClass;
  message: string;
  retryable: boolean;
  hint: string;
}

interface PinetDispatcherEnvelope {
  status: PinetDispatcherStatus;
  data: unknown;
  errors: PinetDispatcherError[];
  warnings: string[];
}

interface PinetRenderContentBlock {
  type: string;
  text?: string;
}

interface PinetRenderResultInput {
  content?: PinetRenderContentBlock[];
  details?: unknown;
  expandedText?: string;
  displayText?: string;
}

const PINET_DISPATCHER_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  send: [{ action: "send", args: { to: "@worker", message: "Please review PR #123" } }],
  read: [
    { action: "read", args: { thread_id: "a2a:<broker>:<worker>", limit: 20 } },
    { action: "read", args: { unread_only: false, mark_read: false, full: true } },
  ],
  free: [{ action: "free", args: { note: "Wrapped up <issue>" } }],
  snooze: [
    { action: "snooze", args: { op: "set", duration: "30m", reason: "no work available" } },
    { action: "snooze", args: { op: "clear" } },
  ],
  schedule: [{ action: "schedule", args: { delay: "30m", message: "Check queue state" } }],
  agents: [{ action: "agents", args: { repo: "<repo>", role: "worker" } }],
  spawn: [
    {
      action: "spawn",
      args: { task: "Review PR #123", repo: "extensions", role: "reviewer", lane_id: "issue-123" },
    },
  ],
  ports: [
    { action: "ports", args: { op: "acquire", purpose: "preview", ttl_ms: 600000 } },
    { action: "ports", args: { op: "renew", lease_id: "<lease-id>", ttl_ms: 600000 } },
    { action: "ports", args: { op: "list", include_inactive: true } },
  ],
  lanes: [
    { action: "lanes", args: { op: "list" } },
    {
      action: "lanes",
      args: {
        op: "upsert",
        lane_id: "issue-688",
        issue_number: 688,
        pm_mode: true,
        state: "active",
      },
    },
  ],
  reload: [{ action: "reload", args: { target: "@worker" } }],
  exit: [{ action: "exit", args: { target: "@worker" } }],
};

const PINET_OUTPUT_OPTION_PARAMETERS = {
  format: Type.Optional(
    Type.String({ description: 'Response presentation format: "cli" (default) or "json".' }),
  ),
  full: Type.Optional(
    Type.Boolean({
      description:
        "Include full verbose text/details. JSON format alone keeps data.details compact.",
    }),
  ),
};

const PINET_COMPACT_LIST_LIMIT = 10;

function getRecordString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDispatcherAction(value: unknown): PinetDispatcherAction {
  if (typeof value !== "string") {
    throw new Error("action is required");
  }

  const normalized = value
    .trim()
    .replace(/^pinet:/, "")
    .toLowerCase() as PinetDispatcherAction;

  if (!normalized) {
    throw new Error("action is required");
  }

  const allowed: PinetDispatcherAction[] = [
    "help",
    "send",
    "read",
    "free",
    "snooze",
    "schedule",
    "agents",
    "lanes",
    "ports",
    "spawn",
    "reload",
    "exit",
  ];
  if (!allowed.includes(normalized)) {
    throw new Error(`Unknown Pinet action: ${normalized}`);
  }

  return normalized;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function classifyPinetError(message: string): PinetDispatcherError {
  if (message.includes("requires confirmation for action")) {
    return {
      class: "state",
      message,
      retryable: false,
      hint: 'Call slack with action "confirm_action" first in the original thread.',
    };
  }

  if (message.includes("is not running") || message.includes("unexpected state")) {
    return {
      class: "state",
      message,
      retryable: false,
      hint: "Start or reattach Pinet, then retry.",
    };
  }

  if (
    message.includes("thread_id must be") ||
    message.includes("message is required") ||
    message.includes("target is required") ||
    message.includes("duration is required") ||
    message.includes("op must be") ||
    message.includes("lease_id") ||
    message.includes("ttl_ms") ||
    message.includes("purpose") ||
    message.includes("port") ||
    message.includes("spawn")
  ) {
    return {
      class: "input",
      message,
      retryable: false,
      hint: "Fix the action arguments and retry.",
    };
  }

  if (message.includes("ECONN") || message.includes("fetch") || message.includes("ENOTFOUND")) {
    return {
      class: "network",
      message,
      retryable: true,
      hint: "Retry when transport is reachable.",
    };
  }

  return {
    class: "runtime",
    message,
    retryable: false,
    hint: "Check inputs and runtime state, then retry.",
  };
}

function buildPinetDispatcherEnvelope(
  status: PinetDispatcherStatus,
  data: unknown,
  errors: PinetDispatcherError[] = [],
  warnings: string[] = [],
): PinetDispatcherEnvelope {
  return { status, data, errors, warnings };
}

function formatPinetHelpCliText(data: Record<string, unknown>): string | null {
  const actions = Array.isArray(data.actions)
    ? data.actions
        .map((action) =>
          isRecord(action) && typeof action.action === "string" ? action.action : null,
        )
        .filter((action): action is string => Boolean(action))
    : [];
  if (actions.length > 0) {
    const note = typeof data.note === "string" && data.note.trim() ? ` ${data.note.trim()}` : "";
    return `Pinet actions: ${actions.join(", ")}.${note}`;
  }

  if (typeof data.action === "string") {
    const description =
      typeof data.description === "string" && data.description.trim()
        ? ` — ${data.description.trim()}`
        : "";
    return `Pinet ${data.action}${description}. Use args.format="json" for the compact envelope, or args.full=true for verbose schema/debug details.`;
  }

  return null;
}

function getPinetEnvelopeCliText(envelope: PinetDispatcherEnvelope): string {
  if (envelope.status === "succeeded" && isRecord(envelope.data)) {
    const text = envelope.data.text;
    if (typeof text === "string" && text.length > 0) return text;

    const helpText = formatPinetHelpCliText(envelope.data);
    if (helpText) return helpText;

    const action = typeof envelope.data.action === "string" ? ` ${envelope.data.action}` : "";
    return `Pinet${action} succeeded. Use args.format="json" for the compact envelope, or args.full=true for verbose details.`;
  }

  const errors = envelope.errors.map((error) => error.message).filter(Boolean);
  const hints = Array.from(
    new Set(envelope.errors.map((error) => error.hint).filter((hint) => hint.length > 0)),
  );
  if (errors.length > 0) {
    return `Pinet ${envelope.status}: ${errors.join("; ")}${hints.length > 0 ? ` Hint: ${hints.join(" ")}` : ""}`;
  }

  return `Pinet ${envelope.status}. Use args.format="json" for the compact envelope, or args.full=true for verbose details.`;
}

function getTolerantPinetOutputOptions(value: unknown): PinetOutputOptions {
  if (!isRecord(value)) return { format: "cli", full: false };

  const rawFormat = value.format ?? value.f ?? value["-f"];
  const normalizedFormat = rawFormat == null ? "cli" : String(rawFormat).trim().toLowerCase();
  const format = normalizedFormat === "json" ? "json" : "cli";
  const rawFull = value.full ?? value["--full"];
  return { format, full: rawFull === true };
}

function getOptionalPinetOutputOptions(value: unknown): PinetOutputOptions {
  if (!isRecord(value)) return { format: "cli", full: false };
  try {
    return normalizePinetOutputOptions(value);
  } catch {
    return getTolerantPinetOutputOptions(value);
  }
}

function shouldRenderStructuredPinetEnvelope(
  envelope: PinetDispatcherEnvelope,
  output: PinetOutputOptions,
): boolean {
  if (output.format === "json") return true;
  if (!output.full) return false;
  if (envelope.status === "failed") return true;
  if (!isRecord(envelope.data)) return true;
  const text = envelope.data.text;
  return typeof text !== "string" || text.length === 0;
}

function wrapDispatcherEnvelope(
  envelope: PinetDispatcherEnvelope,
  output: PinetOutputOptions = { format: "cli", full: false },
  expandedText?: string,
  displayText?: string,
): {
  content: Array<{ type: "text"; text: string }>;
  details: PinetDispatcherEnvelope;
  expandedText?: string;
  displayText?: string;
} {
  return {
    content: [
      {
        type: "text",
        text: shouldRenderStructuredPinetEnvelope(envelope, output)
          ? JSON.stringify(envelope, null, output.full ? 2 : 0)
          : getPinetEnvelopeCliText(envelope),
      },
    ],
    details: envelope,
    ...(expandedText ? { expandedText } : {}),
    ...(displayText ? { displayText } : {}),
  };
}

function isPinetDispatcherEnvelope(value: unknown): value is PinetDispatcherEnvelope {
  if (!isRecord(value)) return false;
  if (value.status !== "succeeded" && value.status !== "failed") return false;
  return Array.isArray(value.errors) && Array.isArray(value.warnings);
}

function getFirstTextContent(result: PinetRenderResultInput): string {
  return (
    result.content?.find((block) => block.type === "text" && typeof block.text === "string")
      ?.text ?? ""
  );
}

function parsePinetDispatcherEnvelopeFromText(text: string): PinetDispatcherEnvelope | null {
  if (!text.trim().startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isPinetDispatcherEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function summarizeDetailValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const inline = entries
      .slice(0, 6)
      .map(([key, nested]) => {
        if (nested === null || ["string", "number", "boolean"].includes(typeof nested)) {
          return `${key}=${String(nested)}`;
        }
        return `${key}=…`;
      })
      .join(", ");
    return `{ ${inline}${entries.length > 6 ? ", …" : ""} }`;
  }
  return String(value);
}

// Renders `data.details` as compact key lines. Arrays and nested objects are
// summarized (count / inlined keys) so the expanded view never JSON-dumps a
// wall of structured data into the operator's TUI.
function formatPrimitiveDetails(details: Record<string, unknown>): string[] {
  return Object.entries(details).map(([key, value]) => `${key}: ${summarizeDetailValue(value)}`);
}

const PINET_SEND_PREVIEW_MAX = 80;
const PINET_SEND_BODY_MAX = 600;

// Single-line, whitespace-collapsed, length-capped preview of a sent message.
// Operator-facing only; kept short so model/CLI text stays compact.
function formatMessagePreview(message: string, maxLength = PINET_SEND_PREVIEW_MAX): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function countMessageLines(message: string): number {
  if (message.length === 0) return 0;
  return message.split(/\r?\n/).length;
}

// Capped multi-line body for the expanded TUI card. Preserves line breaks so the
// operator can see structure, but truncates very long bodies.
function capMessageBody(message: string, maxLength = PINET_SEND_BODY_MAX): string {
  if (message.length <= maxLength) return message;
  return `${message.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatSentMessageSuffix(message: string): string {
  const preview = formatMessagePreview(message);
  if (!preview) return "";
  const lines = countMessageLines(message);
  return ` · “${preview}”${lines > 1 ? ` (${lines} lines)` : ""}`;
}

function buildSentMessageExpandedText(
  fields: Array<[string, string | number | undefined]>,
  message: string,
): string {
  const lines = fields
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([label, value]) => `${label}: ${value}`);
  const chars = message.length;
  const lineCount = countMessageLines(message);
  lines.push(`message (${lineCount} line${lineCount === 1 ? "" : "s"}, ${chars} chars):`);
  lines.push(capMessageBody(message));
  return lines.join("\n");
}

function formatPinetEnvelopeExpandedText(
  envelope: PinetDispatcherEnvelope,
  expandedText?: string,
): string {
  const lines = [getPinetEnvelopeCliText(envelope)];

  if (envelope.status === "failed") {
    lines.push(`status: ${envelope.status}`);
    for (const error of envelope.errors) {
      lines.push(`error[${error.class}]: ${error.message}`);
      if (error.hint) lines.push(`hint: ${error.hint}`);
    }
  } else if (expandedText && expandedText.trim().length > 0) {
    lines.push(...expandedText.split("\n"));
  } else if (isRecord(envelope.data)) {
    lines.push(`status: ${envelope.status}`);
    const action = typeof envelope.data.action === "string" ? envelope.data.action : undefined;
    if (action) lines.push(`action: ${action}`);

    const details = envelope.data.details;
    if (isRecord(details)) {
      lines.push("details:");
      lines.push(...formatPrimitiveDetails(details).map((line) => `  ${line}`));
    }
  }

  for (const warning of envelope.warnings) {
    lines.push(`warning: ${warning}`);
  }

  return lines.join("\n");
}

export function formatPinetDispatcherResultForDisplay(
  result: PinetRenderResultInput,
  expanded: boolean,
): { status: PinetDispatcherStatus | "unknown"; text: string } {
  const firstText = getFirstTextContent(result);
  const envelope = isPinetDispatcherEnvelope(result.details)
    ? result.details
    : parsePinetDispatcherEnvelopeFromText(firstText);

  if (!envelope) {
    return { status: "unknown", text: firstText || "Pinet result." };
  }

  return {
    status: envelope.status,
    text: expanded
      ? formatPinetEnvelopeExpandedText(envelope, result.expandedText)
      : (result.displayText ?? getPinetEnvelopeCliText(envelope)),
  };
}

function selectPinetResultDetails(result: PinetToolResult, output: PinetOutputOptions): unknown {
  if (output.full) {
    return result.fullDetails ?? result.details ?? null;
  }
  if (result.compactDetails !== undefined) {
    return result.compactDetails;
  }
  return result.details ?? null;
}

function buildPinetDispatcherHelpEnvelope(
  args: Record<string, unknown>,
  actions: Map<string, PinetActionDefinition>,
  output: PinetOutputOptions,
): PinetDispatcherEnvelope {
  const topic =
    typeof args.topic === "string" && args.topic.trim()
      ? args.topic.trim().toLowerCase()
      : undefined;

  if (!topic) {
    const catalog = Array.from(actions.values())
      .filter((definition) => definition.name !== "help")
      .map((definition) => ({
        action: definition.name,
        description: definition.description,
        guardrail_tool: `pinet:${definition.name}`,
        ...(output.full
          ? {
              args_schema: definition.parameters,
              examples: PINET_DISPATCHER_EXAMPLES[definition.name] ?? [],
            }
          : {}),
      }))
      .sort((a, b) => a.action.localeCompare(b.action));

    return buildPinetDispatcherEnvelope("succeeded", {
      actions: catalog,
      note: output.full
        ? "Use args.topic to inspect a single action schema."
        : "Use args.topic to inspect a single action schema; add args.full=true for the full catalog schemas/examples.",
    });
  }

  const definition = actions.get(topic);
  if (!definition || definition.name === "help") {
    return buildPinetDispatcherEnvelope("failed", null, [
      {
        class: "input",
        message: `Unknown Pinet action: ${topic}`,
        retryable: false,
        hint: 'Use action="help" to inspect available actions.',
      },
    ]);
  }

  return buildPinetDispatcherEnvelope("succeeded", {
    action: definition.name,
    guardrail_tool: `pinet:${definition.name}`,
    description: definition.description,
    args_schema: definition.parameters,
    examples: PINET_DISPATCHER_EXAMPLES[definition.name] ?? [],
  });
}

function buildPinetAgentsHintText(hint: PinetAgentsRoutingHint): string {
  return `Agent routing hints: ${[
    hint.repo ? `repo=${hint.repo}` : null,
    hint.branch ? `branch=${hint.branch}` : null,
    hint.role ? `role=${hint.role}` : null,
    hint.requiredTools && hint.requiredTools.length > 0
      ? `tools=${hint.requiredTools.join(",")}`
      : null,
    hint.task ? `task=${hint.task}` : null,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" · ")}`;
}

function runPinetSendAction(
  params: Record<string, unknown>,
  deps: RegisterPinetToolsDeps,
  toolName: string,
  output: PinetOutputOptions,
): Promise<PinetToolResult> {
  return (async () => {
    const to = typeof params.to === "string" ? params.to.trim() : "";
    const message = typeof params.message === "string" ? params.message : "";
    const transferThreadId =
      typeof params.transfer_thread_id === "string" && params.transfer_thread_id.trim().length > 0
        ? params.transfer_thread_id.trim()
        : undefined;

    if (!to) {
      throw new Error("to is required");
    }
    if (!message) {
      throw new Error("message is required");
    }

    deps.requireToolPolicy(
      toolName,
      undefined,
      `to=${to} | message=${message}${transferThreadId ? ` | transfer_thread_id=${transferThreadId}` : ""}`,
    );

    if (transferThreadId && deps.brokerRole() !== "broker") {
      throw new Error("transfer_thread_id is broker-only and requires the broker role.");
    }

    if (transferThreadId && isBroadcastChannelTarget(to)) {
      throw new Error(
        "transfer_thread_id requires a direct agent target, not a broadcast channel.",
      );
    }

    const previewSuffix = formatSentMessageSuffix(message);

    if (deps.brokerRole() === "broker" && isBroadcastChannelTarget(to)) {
      const result = deps.sendPinetBroadcastMessage(to, message);
      const preview = result.recipients.slice(0, 5).join(", ");
      const suffix = result.recipients.length > 5 ? ", …" : "";
      const recipientList = result.recipients.join(", ");

      return {
        content: [
          {
            type: "text",
            text: output.full
              ? `Broadcast sent to ${result.channel} (${result.recipients.length} agents: ${preview}${suffix}).`
              : `Pinet broadcast sent to ${result.channel} (${result.recipients.length} recipients)${previewSuffix}.`,
          },
        ],
        details: {
          channel: result.channel,
          messageIds: result.messageIds,
          recipients: result.recipients,
        },
        compactDetails: {
          channel: result.channel,
          messageCount: result.messageIds.length,
          recipientCount: result.recipients.length,
          recipients: result.recipients.slice(0, PINET_COMPACT_LIST_LIMIT),
          recipientsTruncated: Math.max(0, result.recipients.length - PINET_COMPACT_LIST_LIMIT),
        },
        fullDetails: {
          channel: result.channel,
          messageIds: result.messageIds,
          recipients: result.recipients,
        },
        machineText: output.full
          ? `Broadcast sent to ${result.channel} (${result.recipients.length} agents: ${preview}${suffix}).`
          : `Pinet broadcast sent to ${result.channel} (${result.recipients.length} recipients).`,
        expandedText: buildSentMessageExpandedText(
          [
            ["to", result.channel],
            ["recipients", `${result.recipients.length} (${recipientList})`],
            ["message ids", result.messageIds.join(", ")],
          ],
          message,
        ),
      };
    }

    const result = transferThreadId
      ? await deps.sendPinetAgentMessage(to, message, {
          threadOwnershipTransfer: { mode: "transfer", threadId: transferThreadId },
        })
      : await deps.sendPinetAgentMessage(to, message);
    const transferSuffix = result.transferredThreadId
      ? ` (${result.transferredThreadChannel})`
      : "";
    return {
      content: [
        {
          type: "text",
          text: output.full
            ? `Message sent to ${result.target} (id: ${result.messageId})${result.transferredThreadId ? ` and transferred Slack thread ${result.transferredThreadId}${result.transferredThreadChannel ? ` (${result.transferredThreadChannel})` : ""}` : ""}.`
            : `Pinet message sent to ${result.target}${result.transferredThreadId ? `; transferred Slack thread ${result.transferredThreadId}` : ""}${previewSuffix}.`,
        },
      ],
      details: {
        messageId: result.messageId,
        target: result.target,
        ...(result.transferredThreadId ? { transferredThreadId: result.transferredThreadId } : {}),
        ...(result.transferredThreadChannel
          ? { transferredThreadChannel: result.transferredThreadChannel }
          : {}),
      },
      machineText: output.full
        ? `Message sent to ${result.target} (id: ${result.messageId})${result.transferredThreadId ? ` and transferred Slack thread ${result.transferredThreadId}${result.transferredThreadChannel ? ` (${result.transferredThreadChannel})` : ""}` : ""}.`
        : `Pinet message sent to ${result.target}${result.transferredThreadId ? `; transferred Slack thread ${result.transferredThreadId}` : ""}.`,
      expandedText: buildSentMessageExpandedText(
        [
          ["to", result.target],
          ["message id", result.messageId],
          result.transferredThreadId
            ? ["transferred thread", `${result.transferredThreadId}${transferSuffix}`]
            : ["transferred thread", undefined],
        ],
        message,
      ),
    };
  })();
}

function runPinetReadAction(
  params: Record<string, unknown>,
  deps: RegisterPinetToolsDeps,
  toolName: string,
  output: PinetOutputOptions,
): Promise<PinetToolResult> {
  return (async () => {
    deps.requireToolPolicy(
      toolName,
      undefined,
      `thread_id=${params.thread_id ?? ""} | limit=${params.limit ?? ""} | unread_only=${params.unread_only ?? ""} | mark_read=${params.mark_read ?? ""} | format=${output.format} | full=${output.full}`,
    );

    if (!deps.pinetEnabled()) {
      throw new Error("Pinet is not running. Use /pinet start or /pinet follow first.");
    }

    const options: PinetReadOptions = {
      ...(typeof params.thread_id === "string" ? { threadId: params.thread_id.trim() } : {}),
      ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
      ...(typeof params.unread_only === "boolean" ? { unreadOnly: params.unread_only } : {}),
      ...(typeof params.mark_read === "boolean" ? { markRead: params.mark_read } : {}),
    };

    if (options.threadId !== undefined && options.threadId.length === 0) {
      throw new Error("thread_id must be a non-empty string when provided.");
    }

    const result = await deps.readPinetInbox(options);
    const shouldRenderFull = output.full;
    return {
      content: [
        {
          type: "text",
          text: shouldRenderFull
            ? formatPinetReadResultFull(result, options)
            : formatPinetReadResultCompact(result, options),
        },
      ],
      details: result,
      compactDetails: buildCompactPinetReadDetails(result),
      fullDetails: result,
    };
  })();
}

function runPinetFreeAction(
  params: Record<string, unknown>,
  deps: RegisterPinetToolsDeps,
  toolName: string,
  output: PinetOutputOptions,
): Promise<PinetToolResult> {
  return (async () => {
    const note = typeof params.note === "string" ? params.note.trim() : "";

    deps.requireToolPolicy(toolName, undefined, `note=${note}`);

    const result = await deps.signalAgentFree(undefined, { requirePinet: true });
    const inboxSuffix =
      result.queuedInboxCount > 0
        ? ` ${result.queuedInboxCount} queued inbox item${result.queuedInboxCount === 1 ? " remains" : "s remain"}.`
        : "";
    const noteSuffix = note ? ` Note: ${note}.` : "";

    return {
      content: [
        {
          type: "text",
          text: output.full
            ? `Marked this Pinet agent idle/free for new work.${noteSuffix}${inboxSuffix}`
            : `Pinet free: idle${result.queuedInboxCount > 0 ? `; ${result.queuedInboxCount} queued` : ""}.`,
        },
      ],
      details: {
        status: "idle",
        note: note || null,
        queuedInboxCount: result.queuedInboxCount,
      },
    };
  })();
}

function formatRalphSnoozeResult(status: RalphSnoozeStatus | null): string {
  if (!status) {
    return "RALPH snooze unavailable outside broker mode.";
  }
  if (!status.active) {
    return `RALPH snooze off (${status.emptyCycleCount} empty cycle${status.emptyCycleCount === 1 ? "" : "s"}).`;
  }
  return `RALPH snoozed until ${status.until ?? "unknown"}${status.reason ? ` (${status.reason})` : ""}.`;
}

function runPinetSnoozeAction(
  params: Record<string, unknown>,
  deps: RegisterPinetToolsDeps,
  toolName: string,
): Promise<PinetToolResult> {
  return (async () => {
    const op = typeof params.op === "string" ? params.op.trim().toLowerCase() : "status";
    const duration = typeof params.duration === "string" ? params.duration.trim() : "";
    const reason = typeof params.reason === "string" ? params.reason.trim() : "";

    deps.requireToolPolicy(
      toolName,
      undefined,
      `op=${op} | duration=${duration} | reason=${reason}`,
    );

    if (deps.brokerRole() !== "broker") {
      throw new Error("RALPH snooze is only available while running as the Pinet broker.");
    }

    if (op === "status") {
      const status = deps.ralphSnoozeStatus?.() ?? null;
      return {
        content: [{ type: "text", text: formatRalphSnoozeResult(status) }],
        details: status,
      };
    }

    if (["clear", "off", "wake", "resume", "cancel"].includes(op)) {
      const status = deps.clearRalphSnooze?.();
      if (!status) throw new Error("RALPH snooze is unavailable in this runtime.");
      return {
        content: [{ type: "text", text: formatRalphSnoozeResult(status) }],
        details: status,
      };
    }

    if (!["set", "start", "on", "snooze"].includes(op)) {
      throw new Error("op must be status, set, or clear");
    }

    const durationMs = parseScheduledWakeupDelay(duration);
    if (durationMs == null) {
      throw new Error("duration is required for op=set; use values like 5m, 30s, 1h30m, or 1d");
    }

    const status = deps.snoozeRalphLoop?.({ durationMs, reason: reason || "tool action" });
    if (!status) throw new Error("RALPH snooze is unavailable in this runtime.");
    return { content: [{ type: "text", text: formatRalphSnoozeResult(status) }], details: status };
  })();
}

function runPinetSpawnAction(
  params: Record<string, unknown>,
  deps: RegisterPinetToolsDeps,
  toolName: string,
  output: PinetOutputOptions,
): Promise<PinetToolResult> {
  return (async () => {
    const task = getMaybeString(params, "task");
    const repo = getMaybeString(params, "repo");
    const role = getMaybeString(params, "role") ?? "subworker";
    const laneId = getMaybeString(params, "lane_id");
    deps.requireToolPolicy(
      toolName,
      undefined,
      `task=${task ?? ""} | repo=${repo ?? ""} | role=${role} | lane_id=${laneId ?? ""}`,
    );
    if (!deps.pinetEnabled()) {
      throw new Error("Pinet is not running. Use /pinet start or /pinet follow first.");
    }
    if (deps.brokerRole() !== "follower") {
      throw new Error(
        "spawn is worker-only; the broker should launch top-level followers, not own subtrees.",
      );
    }
    if (!task) throw new Error("spawn requires task");
    if (!repo) throw new Error("spawn requires repo");

    if (!deps.spawnSubtreeWorker) {
      throw new Error(
        "subtree worker launcher is unavailable in this runtime. Start a worker subtree with /pinet subtree start and retry.",
      );
    }

    const result = await deps.spawnSubtreeWorker({
      task,
      repo,
      role,
      ...(laneId ? { laneId } : {}),
    });
    return {
      content: [
        {
          type: "text",
          text: output.full
            ? `Pinet subtree worker started: ${result.agentName} (${result.agentId}) in tmux session ${result.sessionName}. Task message ${result.messageId} delivered. Monitor: ${result.monitorCommand}`
            : `Pinet subtree worker started: ${result.agentName} (${result.agentId}). Task message ${result.messageId} delivered.`,
        },
      ],
      details: result,
      compactDetails: {
        status: result.status,
        agentId: result.agentId,
        agentName: result.agentName,
        messageId: result.messageId,
        threadId: result.threadId,
      },
      fullDetails: result,
    };
  })();
}

function runPinetRemoteControlAction(
  params: Record<string, unknown>,
  deps: RegisterPinetToolsDeps,
  toolName: string,
  command: "/reload" | "/exit",
): Promise<PinetToolResult> {
  return (async () => {
    const target = typeof params.target === "string" ? params.target.trim() : "";
    if (!target) {
      throw new Error("target is required");
    }

    deps.requireToolPolicy(toolName, undefined, `target=${target}`);

    const result = await deps.sendPinetAgentMessage(target, command);
    return {
      content: [
        {
          type: "text",
          text: `Sent ${command} to ${result.target}.`,
        },
      ],
      details: { messageId: result.messageId, target: result.target, command },
    };
  })();
}

function runPinetScheduleAction(
  params: Record<string, unknown>,
  deps: RegisterPinetToolsDeps,
  toolName: string,
  output: PinetOutputOptions,
): Promise<PinetToolResult> {
  return (async () => {
    const delay = typeof params.delay === "string" ? params.delay : undefined;
    const at = typeof params.at === "string" ? params.at : undefined;
    const message = typeof params.message === "string" ? params.message.trim() : "";

    deps.requireToolPolicy(
      toolName,
      undefined,
      `delay=${delay ?? ""} | at=${at ?? ""} | message=${message}`,
    );

    if (!deps.pinetEnabled()) {
      throw new Error("Pinet is not running. Use /pinet start or /pinet follow first.");
    }
    if (!message) {
      throw new Error("message is required");
    }

    const fireAt = resolveScheduledWakeupFireAt({ delay, at });

    if (deps.brokerRole() === "broker") {
      const wakeup = await deps.scheduleBrokerWakeup(fireAt, message);
      return {
        content: [
          {
            type: "text",
            text: output.full
              ? `Wake-up scheduled for ${wakeup.fireAt} (id: ${wakeup.id}).`
              : `Pinet wake-up scheduled for ${wakeup.fireAt}.`,
          },
        ],
        details: wakeup,
      };
    }

    if (deps.brokerRole() === "follower") {
      const wakeup = await deps.scheduleFollowerWakeup(fireAt, message);
      return {
        content: [
          {
            type: "text",
            text: output.full
              ? `Wake-up scheduled for ${wakeup.fireAt} (id: ${wakeup.id}).`
              : `Pinet wake-up scheduled for ${wakeup.fireAt}.`,
          },
        ],
        details: wakeup,
      };
    }

    throw new Error("Pinet is in an unexpected state.");
  })();
}

function getAgentRepo(agent: AgentDisplayInfo): string | undefined {
  return getRecordString(agent.metadata, "repo");
}

function getAgentBranch(agent: AgentDisplayInfo): string | undefined {
  return getRecordString(agent.metadata, "branch");
}

function getAgentRole(agent: AgentDisplayInfo): string | undefined {
  return getRecordString(agent.metadata, "role");
}

function truncatePinetDetailText(value: string | null | undefined, maxLength = 160): string | null {
  if (!value) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function buildCompactAgentDetails(
  agents: AgentDisplayInfo[],
  hint: PinetAgentsRoutingHint,
): Record<string, unknown> {
  const shownAgents = agents.slice(0, PINET_COMPACT_LIST_LIMIT);
  return {
    count: agents.length,
    total: agents.length,
    shown: shownAgents.length,
    truncated: Math.max(0, agents.length - shownAgents.length),
    hint,
    agents: shownAgents.map((agent) => {
      const capabilityTags = agent.capabilityTags ?? [];
      return {
        id: agent.id,
        name: agent.name,
        emoji: agent.emoji,
        status: agent.status,
        health: agent.health ?? null,
        repo: getAgentRepo(agent) ?? null,
        branch: getAgentBranch(agent) ?? null,
        role: getAgentRole(agent) ?? null,
        brokerManaged: agent.metadata?.brokerManaged === true,
        parentAgentId: agent.metadata?.parentAgentId ?? null,
        treeDepth: agent.metadata?.treeDepth ?? 0,
        supervisionState: agent.metadata?.supervisionState ?? "root",
        subtreeRole: agent.metadata?.subtreeRole ?? null,
        laneId: agent.metadata?.laneId ?? null,
        routingScore: agent.routingScore ?? null,
        ...(agent.pendingInboxCount != null && agent.pendingInboxCount > 0
          ? { pendingInboxCount: agent.pendingInboxCount }
          : {}),
        capabilityTags: capabilityTags.slice(0, 4),
        capabilityCount: capabilityTags.length,
      };
    }),
  };
}

function filterAgentsForHierarchyScope(
  agents: PinetToolsAgentRecord[],
  scope: "visible" | "children" | "subtree" | "all",
  parentAgentId: string | undefined,
): PinetToolsAgentRecord[] {
  if (scope === "all" || scope === "visible") return agents;
  if (!parentAgentId) return [];
  if (scope === "children") {
    return agents.filter((agent) => agent.parentAgentId === parentAgentId);
  }

  const descendants: PinetToolsAgentRecord[] = [];
  const seen = new Set<string>();
  const queue = agents.filter((agent) => agent.parentAgentId === parentAgentId);
  while (queue.length > 0) {
    const child = queue.shift();
    if (!child || seen.has(child.id)) continue;
    seen.add(child.id);
    descendants.push(child);
    queue.push(...agents.filter((agent) => agent.parentAgentId === child.id));
  }
  return descendants;
}

function formatAgentStatusBreakdown(agents: AgentDisplayInfo[]): string {
  if (agents.length === 0) return "";
  const working = agents.filter((agent) => agent.status === "working").length;
  const idle = agents.length - working;
  const ghost = agents.filter((agent) => agent.health === "ghost").length;
  const stale = agents.filter((agent) => agent.health === "stale").length;
  const parts = [
    `${working} working`,
    `${idle} idle`,
    ghost > 0 ? `${ghost} ghost` : null,
    stale > 0 ? `${stale} stale` : null,
  ].filter((item): item is string => Boolean(item));
  return ` (${parts.join(", ")})`;
}

function formatCompactAgentList(agents: AgentDisplayInfo[], hint: PinetAgentsRoutingHint): string {
  const hintParts = [
    hint.repo ? `repo=${hint.repo}` : null,
    hint.branch ? `branch=${hint.branch}` : null,
    hint.role ? `role=${hint.role}` : null,
    hint.requiredTools && hint.requiredTools.length > 0
      ? `tools=${hint.requiredTools.join(",")}`
      : null,
  ].filter((item): item is string => Boolean(item));
  const hintSuffix = hintParts.length > 0 ? `; hints ${hintParts.join(" · ")}` : "";
  const scopeSuffix = hint.scope && hint.scope !== "visible" ? `; scope=${hint.scope}` : "";
  const breakdown = formatAgentStatusBreakdown(agents);
  return `Pinet agents: ${agents.length} visible${breakdown}${hintSuffix}${scopeSuffix}.`;
}

interface PinetAgentsExpandedRow {
  name: string;
  id: string;
  state: string;
  where: string;
  laneOrRole: string;
  inbox: string;
}

const PINET_AGENTS_EXPANDED_MAX_ROWS = 30;

// Compact, aligned per-agent rows for the expanded TUI card. Avoids JSON dumps;
// shows name/id/status-health/repo-branch/lane-or-role/pending-inbox + flags.
function formatPinetAgentsExpanded(agents: AgentDisplayInfo[]): string {
  if (agents.length === 0) return "(no agents connected)";

  const shown = agents.slice(0, PINET_AGENTS_EXPANDED_MAX_ROWS);
  const rows: PinetAgentsExpandedRow[] = shown.map((agent) => {
    const name = `${agent.emoji} ${agent.name}`;
    const id = agent.id.length > 8 ? agent.id.slice(0, 8) : agent.id;
    const healthSuffix = agent.health && agent.health !== "healthy" ? `/${agent.health}` : "";
    const stuckSuffix = agent.stuck ? " stuck" : "";
    const state = `${agent.status}${healthSuffix}${stuckSuffix}`;
    const repo = getAgentRepo(agent);
    const branch = getAgentBranch(agent);
    const where = repo ? `${repo}${branch ? `/${branch}` : ""}` : (branch ?? "—");
    const laneId = typeof agent.metadata?.laneId === "string" ? agent.metadata.laneId : undefined;
    const role = getAgentRole(agent);
    const laneOrRole = laneId ? `lane:${laneId}` : (role ?? "");
    const inbox =
      agent.pendingInboxCount != null && agent.pendingInboxCount > 0
        ? `inbox:${agent.pendingInboxCount}`
        : "";
    return { name, id, state, where, laneOrRole, inbox };
  });

  const clip = (value: string, width: number): string =>
    value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
  const pad = (value: string, width: number): string =>
    value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
  const colWidth = (pick: (row: PinetAgentsExpandedRow) => string, cap: number): number =>
    Math.min(
      cap,
      rows.reduce((max, row) => Math.max(max, pick(row).length), 0),
    );

  const nameW = colWidth((row) => row.name, 28);
  const idW = colWidth((row) => row.id, 8);
  const stateW = colWidth((row) => row.state, 20);
  const whereW = colWidth((row) => row.where, 30);
  const laneW = colWidth((row) => row.laneOrRole, 18);

  const lines = rows.map((row) =>
    [
      pad(clip(row.name, nameW), nameW),
      pad(row.id, idW),
      pad(clip(row.state, stateW), stateW),
      pad(clip(row.where, whereW), whereW),
      pad(clip(row.laneOrRole, laneW), laneW),
      row.inbox,
    ]
      .join("  ")
      .trimEnd(),
  );

  if (agents.length > shown.length) {
    lines.push(`… +${agents.length - shown.length} more`);
  }

  return lines.join("\n");
}

function formatPinetLaneSummary(lane: PinetLaneInfo): string {
  const refs = [
    lane.issueNumber != null ? `#${lane.issueNumber}` : null,
    lane.prNumber != null ? `PR #${lane.prNumber}` : null,
    lane.pmMode ? "PM" : null,
  ].filter((item): item is string => Boolean(item));
  const participants = lane.participants
    .slice(0, 4)
    .map((participant) => `${participant.agentId}:${participant.role}`)
    .join(", ");
  return [
    `- ${lane.laneId} [${lane.state}]${refs.length > 0 ? ` (${refs.join(" · ")})` : ""}`,
    lane.name ? ` — ${lane.name}` : "",
    lane.ownerAgentId ? ` owner=${lane.ownerAgentId}` : "",
    lane.implementationLeadAgentId ? ` lead=${lane.implementationLeadAgentId}` : "",
    participants ? ` participants=${participants}` : "",
    lane.summary ? ` — ${lane.summary}` : "",
  ].join("");
}

function formatPinetLanes(lanes: PinetLaneInfo[], full: boolean): string {
  if (lanes.length === 0) return "Pinet lanes: none tracked.";
  if (!full) return `Pinet lanes: ${lanes.length} tracked.`;
  return ["Pinet lanes:", ...lanes.map(formatPinetLaneSummary)].join("\n");
}

function getMaybeString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getMaybeBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

function getMaybeNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireNumber(params: Record<string, unknown>, key: string): number {
  const value = getMaybeNumber(params, key);
  if (value === undefined) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function hasParam(params: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(params, key);
}

function getNullableStringUpdate(
  params: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!hasParam(params, key)) return undefined;
  const value = params[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function getNullableNumberUpdate(
  params: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (!hasParam(params, key)) return undefined;
  const value = params[key];
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getMaybeMetadata(
  params: Record<string, unknown>,
): Record<string, unknown> | null | undefined {
  if (!hasParam(params, "metadata")) return undefined;
  const value = params.metadata;
  if (value === null) return null;
  return isRecord(value) ? value : undefined;
}

function buildCompactPortLeaseDetails(leases: PortLeaseInfo[]): Record<string, unknown> {
  const shownLeases = leases.slice(0, PINET_COMPACT_LIST_LIMIT);
  return {
    leaseCount: leases.length,
    total: leases.length,
    shown: shownLeases.length,
    truncated: Math.max(0, leases.length - shownLeases.length),
    leases: shownLeases.map((lease) => ({
      leaseId: lease.id,
      host: lease.host,
      port: lease.port,
      status: lease.status,
      purpose: lease.purpose,
      ownerAgentId: lease.ownerAgentId ?? null,
      expiresAt: lease.expiresAt,
    })),
  };
}

function buildCompactLaneDetails(lanes: PinetLaneInfo[]): Record<string, unknown> {
  const shownLanes = lanes.slice(0, PINET_COMPACT_LIST_LIMIT);
  return {
    laneCount: lanes.length,
    total: lanes.length,
    shown: shownLanes.length,
    truncated: Math.max(0, lanes.length - shownLanes.length),
    lanes: shownLanes.map((lane) => ({
      laneId: lane.laneId,
      state: lane.state,
      name: truncatePinetDetailText(lane.name),
      issueNumber: lane.issueNumber,
      prNumber: lane.prNumber,
      ownerAgentId: lane.ownerAgentId,
      implementationLeadAgentId: lane.implementationLeadAgentId,
      pmMode: lane.pmMode,
      participantCount: lane.participants.length,
      summary: truncatePinetDetailText(lane.summary),
      lastActivityAt: lane.lastActivityAt,
    })),
  };
}

function formatPortLeaseSummary(lease: PortLeaseInfo): string {
  return `${lease.host}:${lease.port} ${lease.status} lease=${lease.id} purpose=${lease.purpose} owner=${lease.ownerAgentId ?? "none"} expires=${lease.expiresAt}`;
}

function formatPortLeases(leases: PortLeaseInfo[], full: boolean): string {
  if (leases.length === 0) return "Pinet port leases: none.";
  if (!full) return `Pinet port leases: ${leases.length}.`;
  return [
    "Pinet port leases:",
    ...leases.map((lease) => `- ${formatPortLeaseSummary(lease)}`),
  ].join("\n");
}

function runPinetPortsAction(
  params: Record<string, unknown>,
  deps: RegisterPinetToolsDeps,
  toolName: string,
  output: PinetOutputOptions,
): Promise<PinetToolResult> {
  return (async () => {
    const op = getMaybeString(params, "op")?.toLowerCase() ?? "list";
    deps.requireToolPolicy(toolName, undefined, `op=${op} | format=${output.format}`);
    if (!deps.pinetEnabled()) {
      throw new Error("Pinet is not running. Use /pinet start or /pinet follow first.");
    }

    if (op === "acquire") {
      const purpose = getMaybeString(params, "purpose");
      if (!purpose) throw new Error("ports op=acquire requires purpose");
      const ttlMs = requireNumber(params, "ttl_ms");
      const lease = await deps.acquirePortLease({
        purpose,
        ttlMs,
        ...(getMaybeString(params, "host") ? { host: getMaybeString(params, "host") } : {}),
        ...(getMaybeNumber(params, "port") !== undefined
          ? { port: getMaybeNumber(params, "port") }
          : {}),
        ...(getMaybeNumber(params, "min_port") !== undefined
          ? { minPort: getMaybeNumber(params, "min_port") }
          : {}),
        ...(getMaybeNumber(params, "max_port") !== undefined
          ? { maxPort: getMaybeNumber(params, "max_port") }
          : {}),
        ...(getMaybeNumber(params, "pid") !== undefined
          ? { pid: getMaybeNumber(params, "pid") }
          : {}),
        ...(getMaybeMetadata(params) !== undefined ? { metadata: getMaybeMetadata(params) } : {}),
      });
      return {
        content: [
          { type: "text", text: `Pinet port lease acquired: ${formatPortLeaseSummary(lease)}.` },
        ],
        details: { lease },
        compactDetails: {
          leaseId: lease.id,
          host: lease.host,
          port: lease.port,
          expiresAt: lease.expiresAt,
        },
        fullDetails: { lease },
      };
    }

    if (op === "renew") {
      const leaseId = getMaybeString(params, "lease_id");
      if (!leaseId) throw new Error("ports op=renew requires lease_id");
      const lease = await deps.renewPortLease({
        leaseId,
        ttlMs: requireNumber(params, "ttl_ms"),
      });
      return {
        content: [
          { type: "text", text: `Pinet port lease renewed: ${formatPortLeaseSummary(lease)}.` },
        ],
        details: { lease },
        compactDetails: { leaseId: lease.id, expiresAt: lease.expiresAt },
        fullDetails: { lease },
      };
    }

    if (op === "release") {
      const leaseId = getMaybeString(params, "lease_id");
      if (!leaseId) throw new Error("ports op=release requires lease_id");
      const lease = await deps.releasePortLease({
        leaseId,
      });
      return {
        content: [
          { type: "text", text: `Pinet port lease released: ${formatPortLeaseSummary(lease)}.` },
        ],
        details: { lease },
        compactDetails: { leaseId: lease.id, status: lease.status },
        fullDetails: { lease },
      };
    }

    if (op === "status") {
      const leaseId = getMaybeString(params, "lease_id");
      if (!leaseId) throw new Error("ports op=status requires lease_id");
      const lease = await deps.getPortLease(leaseId);
      return {
        content: [
          {
            type: "text",
            text: lease
              ? `Pinet port lease: ${formatPortLeaseSummary(lease)}.`
              : "Pinet port lease: not found.",
          },
        ],
        details: { lease },
        compactDetails: lease ? { leaseId: lease.id, status: lease.status } : { lease: null },
        fullDetails: { lease },
      };
    }

    if (op === "expire") {
      const leases = await deps.expirePortLeases();
      return {
        content: [{ type: "text", text: `Pinet port leases expired: ${leases.length}.` }],
        details: { leases },
        compactDetails: buildCompactPortLeaseDetails(leases),
        fullDetails: { leases },
      };
    }

    if (op === "list") {
      const leases = await deps.listPortLeases({
        ...(getMaybeBoolean(params, "include_inactive") !== undefined
          ? { includeInactive: getMaybeBoolean(params, "include_inactive") }
          : {}),
        ...(getMaybeBoolean(params, "expired_only") !== undefined
          ? { expiredOnly: getMaybeBoolean(params, "expired_only") }
          : {}),
        ...(getMaybeString(params, "purpose")
          ? { purpose: getMaybeString(params, "purpose") }
          : {}),
        ...(getMaybeString(params, "host") ? { host: getMaybeString(params, "host") } : {}),
      });
      return {
        content: [{ type: "text", text: formatPortLeases(leases, output.full) }],
        details: { leases },
        compactDetails: buildCompactPortLeaseDetails(leases),
        fullDetails: { leases },
      };
    }

    throw new Error("ports op must be acquire, renew, release, status, list, or expire");
  })();
}

function runPinetLanesAction(
  params: Record<string, unknown>,
  deps: RegisterPinetToolsDeps,
  toolName: string,
  output: PinetOutputOptions,
): Promise<PinetToolResult> {
  return (async () => {
    const op = getMaybeString(params, "op")?.toLowerCase() ?? "list";
    deps.requireToolPolicy(toolName, undefined, `op=${op} | format=${output.format}`);
    if (!deps.pinetEnabled()) {
      throw new Error("Pinet is not running. Use /pinet start or /pinet follow first.");
    }

    if (op === "list") {
      const options: PinetLaneListOptions = {
        ...(getMaybeString(params, "state")
          ? { state: getMaybeString(params, "state") as PinetLaneState }
          : {}),
        ...(getMaybeString(params, "owner_agent")
          ? { ownerAgentId: getMaybeString(params, "owner_agent") }
          : {}),
        ...(getMaybeBoolean(params, "include_done") !== undefined
          ? { includeDone: getMaybeBoolean(params, "include_done") }
          : {}),
      };
      const lanes = await deps.listPinetLanes(options);
      return {
        content: [{ type: "text", text: formatPinetLanes(lanes, output.full) }],
        details: { lanes },
        compactDetails: buildCompactLaneDetails(lanes),
        fullDetails: { lanes },
      };
    }

    if (op === "upsert") {
      const laneId = getMaybeString(params, "lane_id");
      if (!laneId) throw new Error("lanes op=upsert requires lane_id");
      const lane = await deps.upsertPinetLane({
        laneId,
        ...(getNullableStringUpdate(params, "name") !== undefined
          ? { name: getNullableStringUpdate(params, "name") }
          : {}),
        ...(getNullableStringUpdate(params, "task") !== undefined
          ? { task: getNullableStringUpdate(params, "task") }
          : {}),
        ...(getNullableNumberUpdate(params, "issue_number") !== undefined
          ? { issueNumber: getNullableNumberUpdate(params, "issue_number") }
          : {}),
        ...(getNullableNumberUpdate(params, "pr_number") !== undefined
          ? { prNumber: getNullableNumberUpdate(params, "pr_number") }
          : {}),
        ...(getNullableStringUpdate(params, "thread_id") !== undefined
          ? { threadId: getNullableStringUpdate(params, "thread_id") }
          : {}),
        ...(getNullableStringUpdate(params, "owner_agent") !== undefined
          ? { ownerAgentId: getNullableStringUpdate(params, "owner_agent") }
          : {}),
        ...(getNullableStringUpdate(params, "implementation_lead") !== undefined
          ? { implementationLeadAgentId: getNullableStringUpdate(params, "implementation_lead") }
          : {}),
        ...(getMaybeBoolean(params, "pm_mode") !== undefined
          ? { pmMode: getMaybeBoolean(params, "pm_mode") }
          : {}),
        ...(getMaybeString(params, "state")
          ? { state: getMaybeString(params, "state") as PinetLaneState }
          : {}),
        ...(getNullableStringUpdate(params, "summary") !== undefined
          ? { summary: getNullableStringUpdate(params, "summary") }
          : {}),
        ...(getMaybeMetadata(params) !== undefined ? { metadata: getMaybeMetadata(params) } : {}),
      });
      return {
        content: [{ type: "text", text: `Pinet lane ${lane.laneId} saved (${lane.state}).` }],
        details: { lane },
        compactDetails: { laneId: lane.laneId, state: lane.state, pmMode: lane.pmMode },
        fullDetails: { lane },
      };
    }

    if (op === "participant") {
      const laneId = getMaybeString(params, "lane_id");
      if (!laneId) throw new Error("lanes op=participant requires lane_id");
      const agentId = getMaybeString(params, "agent_id") ?? "";
      const role = (getMaybeString(params, "lane_role") ??
        getMaybeString(params, "role") ??
        "observer") as PinetLaneRole;
      const participant = await deps.setPinetLaneParticipant({
        laneId,
        agentId,
        role,
        ...(getNullableStringUpdate(params, "status") !== undefined
          ? { status: getNullableStringUpdate(params, "status") }
          : {}),
        ...(getNullableStringUpdate(params, "summary") !== undefined
          ? { summary: getNullableStringUpdate(params, "summary") }
          : {}),
        ...(getMaybeMetadata(params) !== undefined ? { metadata: getMaybeMetadata(params) } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: `Pinet lane ${participant.laneId} participant ${participant.agentId} saved as ${participant.role}.`,
          },
        ],
        details: { participant },
        compactDetails: {
          laneId: participant.laneId,
          agentId: participant.agentId,
          role: participant.role,
        },
        fullDetails: { participant },
      };
    }

    throw new Error("lanes op must be list, upsert, or participant");
  })();
}

function runPinetAgentsAction(
  params: Record<string, unknown>,
  deps: RegisterPinetToolsDeps,
  toolName: string,
  output: PinetOutputOptions,
): Promise<PinetToolResult> {
  return (async () => {
    const scope =
      params.scope === "children" || params.scope === "subtree" || params.scope === "all"
        ? params.scope
        : "visible";
    const requestedParentAgentId =
      typeof params.parent_agent === "string" ? params.parent_agent : undefined;
    const subtreeSelfAgentId = deps.getSubtreeSelfAgentId?.() ?? undefined;
    const parentAgentId =
      requestedParentAgentId ??
      (deps.brokerRole() === "follower" && (scope === "children" || scope === "subtree")
        ? subtreeSelfAgentId
        : undefined);
    const hint: PinetAgentsRoutingHint = {
      repo: typeof params.repo === "string" ? params.repo : undefined,
      branch: typeof params.branch === "string" ? params.branch : undefined,
      role: typeof params.role === "string" ? params.role : undefined,
      ...(scope !== "visible" ? { scope } : {}),
      requiredTools:
        typeof params.required_tools === "string"
          ? params.required_tools
              .split(",")
              .map((tool: string) => tool.trim())
              .filter(Boolean)
          : undefined,
      task: typeof params.task === "string" ? params.task : undefined,
    };

    deps.requireToolPolicy(
      toolName,
      undefined,
      `repo=${hint.repo ?? ""} | branch=${hint.branch ?? ""} | role=${hint.role ?? ""} | scope=${scope} | parent_agent=${parentAgentId ?? ""} | required_tools=${params.required_tools ?? ""} | task=${hint.task ?? ""} | format=${output.format} | full=${output.full}`,
    );

    if (!deps.pinetEnabled()) {
      throw new Error("Pinet is not running. Use /pinet start or /pinet follow first.");
    }

    const includeGhosts = params.include_ghosts === true;
    const recentGhostWindowMs = DEFAULT_HEARTBEAT_TIMEOUT_MS * 2;
    const nowMs = Date.now();
    const hasHint = Boolean(
      hint.repo || hint.branch || hint.role || (hint.requiredTools?.length ?? 0) > 0 || hint.task,
    );
    const toDisplay = (agent: PinetToolsAgentRecord): AgentDisplayInfo =>
      buildAgentDisplayInfo(agent, {
        now: nowMs,
        heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      });

    let rawAgents: PinetToolsAgentRecord[];
    if (deps.brokerRole() === "broker") {
      rawAgents = deps.listBrokerAgents();
    } else if (deps.brokerRole() === "follower") {
      const wantsLocalSubtree = scope === "children" || scope === "subtree";
      const subtreeAgents = wantsLocalSubtree ? deps.listSubtreeAgents?.(includeGhosts) : null;
      if (wantsLocalSubtree && subtreeAgents) {
        rawAgents = subtreeAgents;
      } else if (wantsLocalSubtree && deps.listSubtreeAgents && !subtreeAgents) {
        throw new Error("No active worker-owned subtree broker. Run /pinet subtree start first.");
      } else {
        rawAgents = await deps.listFollowerAgents(includeGhosts);
      }
    } else {
      throw new Error("Pinet is in an unexpected state.");
    }

    const scopedRawAgents = filterAgentsForHierarchyScope(rawAgents, scope, parentAgentId);
    const visibleAgents = filterAgentsForMeshVisibility(scopedRawAgents, {
      now: nowMs,
      includeGhosts,
      recentDisconnectWindowMs: recentGhostWindowMs,
    }).map(toDisplay);
    const agents = rankAgentsForRouting(visibleAgents, hint);
    const header = hasHint && output.full ? `${buildPinetAgentsHintText(hint)}\n\n` : "";
    const text = `${header}${
      output.full ? formatAgentList(agents, os.homedir()) : formatCompactAgentList(agents, hint)
    }`;

    return {
      content: [{ type: "text", text }],
      details: { agents, hint },
      compactDetails: buildCompactAgentDetails(agents, hint),
      fullDetails: { agents, hint },
      expandedText: formatPinetAgentsExpanded(agents),
    };
  })();
}

export function registerPinetTools(pi: ExtensionAPI, deps: RegisterPinetToolsDeps): void {
  const actionDefinitions = new Map<string, PinetActionDefinition>();

  function registerAction(definition: PinetActionDefinition): void {
    actionDefinitions.set(definition.name, definition);
  }

  registerAction({
    name: "send",
    description: "Send a message to a connected Pinet agent or broker-only broadcast channel.",
    parameters: Type.Object({
      to: Type.String({
        description:
          "Target agent name/ID, or a broker-only broadcast channel like #extensions. Avoid #all for repo-specific issue/policy announcements.",
      }),
      message: Type.String({ description: "Message body" }),
      transfer_thread_id: Type.Optional(
        Type.String({
          description:
            "Broker-only: transfer ownership of this existing Slack thread to the direct recipient after delivery (for example a Slack thread_ts).",
        }),
      ),
      ...PINET_OUTPUT_OPTION_PARAMETERS,
    }),
    execute: (_id, params, output) => runPinetSendAction(params, deps, "pinet:send", output),
  });

  registerAction({
    name: "read",
    description:
      "Read this agent's durable SQLite-backed Pinet inbox context with unread/read semantics. Ordinary workers only see rows addressed to their own agent identity; broker coordination visibility is limited to broker-addressed inbox rows.",
    parameters: Type.Object({
      thread_id: Type.Optional(
        Type.String({
          description:
            "Optional Pinet/Slack broker thread ID to filter this agent's own inbox rows; it does not grant cross-agent thread access.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum messages to return (default 20, max 100)" }),
      ),
      unread_only: Type.Optional(
        Type.Boolean({ description: "Only return unread rows (default true)" }),
      ),
      mark_read: Type.Optional(
        Type.Boolean({ description: "Mark returned unread rows as read (default true)" }),
      ),
      ...PINET_OUTPUT_OPTION_PARAMETERS,
    }),
    execute: (_id, params, output) => runPinetReadAction(params, deps, "pinet:read", output),
  });

  registerAction({
    name: "free",
    description: "Mark this Pinet agent idle/free for new work.",
    parameters: Type.Object({
      note: Type.Optional(
        Type.String({ description: "Optional short note about what you just finished" }),
      ),
      ...PINET_OUTPUT_OPTION_PARAMETERS,
    }),
    execute: (_id, params, output) => runPinetFreeAction(params, deps, "pinet:free", output),
  });

  registerAction({
    name: "snooze",
    description:
      "Broker-only: inspect, set, or clear RALPH snooze so empty maintenance cycles stay quiet while urgent work still routes normally.",
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "Operation: status, set, or clear" })),
      duration: Type.Optional(
        Type.String({ description: "For op=set, relative duration like 30m" }),
      ),
      reason: Type.Optional(Type.String({ description: "Optional snooze reason" })),
      ...PINET_OUTPUT_OPTION_PARAMETERS,
    }),
    execute: (_id, params, _output) => runPinetSnoozeAction(params, deps, "pinet:snooze"),
  });

  registerAction({
    name: "spawn",
    description:
      "Worker-only: launch a tmux-backed child worker into this worker's active subtree broker and deliver the task over Pinet.",
    parameters: Type.Object({
      task: Type.String({ description: "Scoped task prompt for the child worker" }),
      repo: Type.String({ description: "Repo/workspace scope for the child worker" }),
      role: Type.Optional(Type.String({ description: "Child subtree role, e.g. reviewer" })),
      lane_id: Type.Optional(Type.String({ description: "Optional durable Pinet lane id" })),
      ...PINET_OUTPUT_OPTION_PARAMETERS,
    }),
    execute: (_id, params, output) => runPinetSpawnAction(params, deps, "pinet:spawn", output),
  });

  registerAction({
    name: "reload",
    description: "Ask another connected Pinet agent to reload itself.",
    parameters: Type.Object({
      target: Type.String({ description: "Target agent name or ID" }),
      ...PINET_OUTPUT_OPTION_PARAMETERS,
    }),
    execute: (_id, params, _output) =>
      runPinetRemoteControlAction(params, deps, "pinet:reload", "/reload"),
  });

  registerAction({
    name: "exit",
    description: "Ask another connected Pinet agent to exit gracefully.",
    parameters: Type.Object({
      target: Type.String({ description: "Target agent name or ID" }),
      ...PINET_OUTPUT_OPTION_PARAMETERS,
    }),
    execute: (_id, params, _output) =>
      runPinetRemoteControlAction(params, deps, "pinet:exit", "/exit"),
  });

  registerAction({
    name: "schedule",
    description: "Schedule a future wake-up for this Pinet agent.",
    parameters: Type.Object({
      delay: Type.Optional(
        Type.String({ description: "Relative delay like 5m, 30s, 1h30m, or 1d" }),
      ),
      at: Type.Optional(
        Type.String({ description: "Absolute ISO-8601 UTC time, e.g. 2026-04-02T14:30:00Z" }),
      ),
      message: Type.String({ description: "Reminder or wake-up message to deliver later" }),
      ...PINET_OUTPUT_OPTION_PARAMETERS,
    }),
    execute: (_id, params, output) =>
      runPinetScheduleAction(params, deps, "pinet:schedule", output),
  });

  registerAction({
    name: "agents",
    description: "List connected Pinet agents with status and capabilities.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Preferred repo name for routing" })),
      branch: Type.Optional(Type.String({ description: "Preferred branch for routing" })),
      role: Type.Optional(
        Type.String({ description: "Preferred agent role, e.g. broker or worker" }),
      ),
      required_tools: Type.Optional(
        Type.String({ description: "Comma-separated required capability/tool tags" }),
      ),
      task: Type.Optional(Type.String({ description: "Optional natural-language task hint" })),
      include_ghosts: Type.Optional(
        Type.Boolean({
          description:
            "Include recently disconnected/resumable agents. Defaults false so graceful exits do not look like actionable ghosts.",
        }),
      ),
      scope: Type.Optional(
        Type.String({
          description:
            "Hierarchy filter: visible (default), children, subtree, or all. children/subtree require parent_agent for explicit inspection.",
        }),
      ),
      parent_agent: Type.Optional(
        Type.String({ description: "Parent agent id for scope=children or scope=subtree" }),
      ),
      ...PINET_OUTPUT_OPTION_PARAMETERS,
    }),
    execute: (_id, params, output) => runPinetAgentsAction(params, deps, "pinet:agents", output),
  });

  registerAction({
    name: "ports",
    description:
      "Acquire, renew, release, inspect, list, or expire durable Pinet local port leases.",
    parameters: Type.Object({
      op: Type.Optional(
        Type.String({ description: "Operation: acquire, renew, release, status, list, or expire" }),
      ),
      purpose: Type.Optional(Type.String({ description: "Lease purpose for op=acquire" })),
      ttl_ms: Type.Optional(Type.Number({ description: "Lease TTL in milliseconds" })),
      lease_id: Type.Optional(Type.String({ description: "Lease id for renew/release/status" })),
      host: Type.Optional(Type.String({ description: "Host binding; default 127.0.0.1" })),
      port: Type.Optional(Type.Number({ description: "Requested port for op=acquire" })),
      min_port: Type.Optional(Type.Number({ description: "Minimum allocation port" })),
      max_port: Type.Optional(Type.Number({ description: "Maximum allocation port" })),
      pid: Type.Optional(
        Type.Number({ description: "Optional process id associated with the lease" }),
      ),
      include_inactive: Type.Optional(
        Type.Boolean({ description: "Include released/expired rows" }),
      ),
      expired_only: Type.Optional(Type.Boolean({ description: "List only expired rows" })),
      metadata: Type.Optional(
        Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
      ),
      ...PINET_OUTPUT_OPTION_PARAMETERS,
    }),
    execute: (_id, params, output) => runPinetPortsAction(params, deps, "pinet:ports", output),
  });

  registerAction({
    name: "lanes",
    description:
      "List or update durable Pinet lane metadata for PM-mode and complex coordination visibility.",
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "Operation: list, upsert, or participant" })),
      lane_id: Type.Optional(Type.String({ description: "Stable lane id, e.g. issue-688" })),
      name: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: "Human-readable lane name" }),
      ),
      task: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: "Short lane task description" }),
      ),
      issue_number: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], { description: "Linked GitHub issue number" }),
      ),
      pr_number: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], { description: "Linked GitHub PR number" }),
      ),
      thread_id: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: "Owning Pinet/Slack thread id" }),
      ),
      owner_agent: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: "Accountable follower/PM agent id",
        }),
      ),
      implementation_lead: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: "Implementation lead agent id" }),
      ),
      agent_id: Type.Optional(
        Type.String({ description: "Participant agent id for op=participant" }),
      ),
      lane_role: Type.Optional(
        Type.Union(
          [
            Type.Literal("broker"),
            Type.Literal("coordinator"),
            Type.Literal("pm"),
            Type.Literal("lead"),
            Type.Literal("implementer"),
            Type.Literal("reviewer"),
            Type.Literal("second_pass_reviewer"),
            Type.Literal("observer"),
          ],
          { description: "Participant role" },
        ),
      ),
      pm_mode: Type.Optional(Type.Boolean({ description: "Whether PM mode is enabled" })),
      state: Type.Optional(
        Type.Union(
          [
            Type.Literal("planned"),
            Type.Literal("active"),
            Type.Literal("blocked"),
            Type.Literal("review"),
            Type.Literal("ready"),
            Type.Literal("done"),
            Type.Literal("cancelled"),
            Type.Literal("detached"),
          ],
          { description: "Lane state" },
        ),
      ),
      status: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: "Participant status" }),
      ),
      summary: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: "Short lane or participant summary",
        }),
      ),
      metadata: Type.Optional(
        Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
      ),
      include_done: Type.Optional(
        Type.Boolean({ description: "Include done/cancelled/detached lanes in list output" }),
      ),
      ...PINET_OUTPUT_OPTION_PARAMETERS,
    }),
    execute: (_id, params, output) => runPinetLanesAction(params, deps, "pinet:lanes", output),
  });

  pi.registerTool({
    name: "pinet",
    label: "Pinet Dispatcher",
    description: "Dispatch Pinet operations by action with compact help and schema discovery.",
    promptSnippet:
      'Use this compact dispatcher for Pinet actions: send, read, free, snooze, schedule, agents, lanes, ports, reload, exit, spawn, and help. Use /pinet start, /pinet follow, /pinet unfollow, and /pinet subtree start for TUI lifecycle changes. Defaults to terse CLI text; pass args.format="json" for the compact envelope or args.full=true for verbose/debug detail.',
    parameters: Type.Object({
      action: Type.String({
        description:
          "Action name: help, send, read, free, snooze, schedule, agents, lanes, ports, reload, or exit. Also supports spawn for launching worker-owned subtree children.",
      }),
      args: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            'Action arguments. Add format="cli"|"json" (or f/"-f") for presentation, and full=true (or "--full": true) only for verbose/debug details. Default cli and non-full json keep data.details compact.',
        }),
      ),
    }),
    renderCall(args, theme) {
      const action =
        typeof args.action === "string" && args.action.trim() ? args.action.trim() : "?";
      let suffix = "";
      if (isRecord(args.args)) {
        const topic = typeof args.args.topic === "string" ? args.args.topic.trim() : "";
        const op = typeof args.args.op === "string" ? args.args.op.trim() : "";
        if (topic) suffix = ` ${theme.fg("dim", `topic=${topic}`)}`;
        else if (op) suffix = ` ${theme.fg("dim", `op=${op}`)}`;
      }
      return new Text(
        `${theme.fg("toolTitle", theme.bold("pinet"))} ${theme.fg("muted", action)}${suffix}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Pinet running…"), 0, 0);
      }

      const display = formatPinetDispatcherResultForDisplay(result, expanded);
      const color =
        display.status === "failed"
          ? "error"
          : display.status === "succeeded"
            ? "success"
            : "muted";
      const icon = display.status === "failed" ? "✗" : display.status === "succeeded" ? "✓" : "•";
      const lines = display.text.split("\n");
      const first = lines[0] ?? "Pinet result.";
      const rest = lines.slice(1).map((line) => theme.fg("dim", line));
      return new Text(
        [`${theme.fg(color, icon)} ${theme.fg(color, first)}`, ...rest].join("\n"),
        0,
        0,
      );
    },
    async execute(toolCallId, params) {
      let normalizedAction: PinetDispatcherAction;
      try {
        normalizedAction = normalizeDispatcherAction(params.action);
      } catch (error) {
        return wrapDispatcherEnvelope(
          buildPinetDispatcherEnvelope("failed", null, [
            {
              class: "input",
              message: getErrorMessage(error),
              retryable: false,
              hint: 'Use action="help" to inspect supported actions.',
            },
          ]),
          getOptionalPinetOutputOptions(params.args),
        );
      }

      if (normalizedAction === "help") {
        const args = isRecord(params.args) ? params.args : {};
        let output: PinetOutputOptions;
        try {
          output = normalizePinetOutputOptions(args);
        } catch (error) {
          return wrapDispatcherEnvelope(
            buildPinetDispatcherEnvelope("failed", null, [
              {
                class: "input",
                message: getErrorMessage(error),
                retryable: false,
                hint: 'Use format="cli" or format="json" and full as a boolean.',
              },
            ]),
            getTolerantPinetOutputOptions(args),
          );
        }
        return wrapDispatcherEnvelope(
          buildPinetDispatcherHelpEnvelope(args, actionDefinitions, output),
          output,
        );
      }

      const definition = actionDefinitions.get(normalizedAction);
      if (!definition) {
        return wrapDispatcherEnvelope(
          buildPinetDispatcherEnvelope("failed", null, [
            {
              class: "input",
              message: `Unknown Pinet action: ${normalizedAction}`,
              retryable: false,
              hint: 'Use action="help" to inspect supported actions.',
            },
          ]),
          getOptionalPinetOutputOptions(params.args),
        );
      }

      if (!isRecord(params.args)) {
        return wrapDispatcherEnvelope(
          buildPinetDispatcherEnvelope("failed", null, [
            {
              class: "input",
              message: "args must be an object for Pinet action execution.",
              retryable: false,
              hint: "Pass a JSON object as args.",
            },
          ]),
          getOptionalPinetOutputOptions(params.args),
        );
      }

      let output: PinetOutputOptions;
      try {
        output = normalizePinetOutputOptions(params.args);
      } catch (error) {
        return wrapDispatcherEnvelope(
          buildPinetDispatcherEnvelope("failed", null, [
            {
              class: "input",
              message: getErrorMessage(error),
              retryable: false,
              hint: 'Use format="cli" or format="json" and full as a boolean.',
            },
          ]),
          getTolerantPinetOutputOptions(params.args),
        );
      }

      try {
        const result = await definition.execute(toolCallId, params.args, output);
        const expandedText =
          typeof result.expandedText === "string" && result.expandedText.trim().length > 0
            ? result.expandedText
            : undefined;
        const displayText = result.content[0]?.text ?? "";
        return wrapDispatcherEnvelope(
          buildPinetDispatcherEnvelope("succeeded", {
            action: definition.name,
            text: output.format === "json" ? (result.machineText ?? displayText) : displayText,
            details: selectPinetResultDetails(result, output),
          }),
          output,
          expandedText,
          displayText,
        );
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        const message = getErrorMessage(error);
        return wrapDispatcherEnvelope(
          buildPinetDispatcherEnvelope("failed", null, [classifyPinetError(message)]),
          output,
        );
      }
    },
  });
}
