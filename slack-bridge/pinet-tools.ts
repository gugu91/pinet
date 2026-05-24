import os from "node:os";
import {
  buildCompactPinetReadDetails,
  formatPinetReadResultCompact,
  formatPinetReadResultFull,
  type PinetReadOptions,
  type PinetReadResult,
} from "@gugu910/pi-pinet-core/pinet-read-formatting";
import {
  normalizePinetOutputOptions,
  type PinetOutputOptions,
} from "@gugu910/pi-pinet-core/output-options";
import { resolveScheduledWakeupFireAt } from "@gugu910/pi-pinet-core/scheduled-wakeups";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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
}

export interface RegisterPinetToolsDeps {
  pinetEnabled: () => boolean;
  brokerRole: () => "broker" | "follower" | null;
  requireToolPolicy: (toolName: string, threadTs: string | undefined, action: string) => void;
  sendPinetAgentMessage: (
    target: string,
    body: string,
  ) => Promise<{ messageId: number; target: string }>;
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
}

interface PinetAgentsRoutingHint {
  repo?: string;
  branch?: string;
  role?: string;
  requiredTools?: string[];
  task?: string;
}

type PinetDispatcherAction = "send" | "read" | "free" | "schedule" | "agents" | "help";
type PinetDispatcherErrorClass = "input" | "state" | "runtime" | "network";

type PinetDispatcherStatus = "succeeded" | "failed";

interface PinetToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  compactDetails?: unknown;
  fullDetails?: unknown;
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

const PINET_DISPATCHER_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  send: [{ action: "send", args: { to: "@worker", message: "Please review PR #123" } }],
  read: [
    { action: "read", args: { thread_id: "a2a:<broker>:<worker>", limit: 20 } },
    { action: "read", args: { unread_only: false, mark_read: false, full: true } },
  ],
  free: [{ action: "free", args: { note: "Wrapped up <issue>" } }],
  schedule: [{ action: "schedule", args: { delay: "30m", message: "Check queue state" } }],
  agents: [{ action: "agents", args: { repo: "<repo>", role: "worker", full: true } }],
};

const PINET_OUTPUT_OPTION_PARAMETERS = {
  format: Type.Optional(
    Type.String({ description: 'Response presentation format: "cli" (default) or "json".' }),
  ),
  full: Type.Optional(
    Type.Boolean({
      description:
        "Include full verbose text/details; default cli output keeps data.details compact.",
    }),
  ),
};

const PINET_TOOL_RESULT_PREVIEW_MAX_LENGTH = 240;

interface PinetToolRenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
}

interface PinetToolResultComponent {
  render(width: number): string[];
  invalidate(): void;
}

class PinetToolResultCardComponent implements PinetToolResultComponent {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    return this.text.split("\n").map((line) => truncateLineToWidth(line, width));
  }

  invalidate(): void {
    // Stateless component.
  }
}

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

  const allowed: PinetDispatcherAction[] = ["help", "send", "read", "free", "schedule", "agents"];
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

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function truncateLineToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}

function getTextContent(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  return result.content
    .filter((block): block is { type: string; text: string } => {
      if (!isRecord(block)) return false;
      return block.type === "text" && typeof block.text === "string";
    })
    .map((block) => block.text)
    .join("\n");
}

function readDispatcherEnvelope(value: unknown): PinetDispatcherEnvelope | null {
  if (!isRecord(value)) return null;
  const { status, data, errors, warnings } = value;
  if (status !== "succeeded" && status !== "failed") return null;
  if (!Array.isArray(errors) || !Array.isArray(warnings)) return null;
  return { status, data, errors: [], warnings: [] };
}

function getEnvelopeDataText(envelope: PinetDispatcherEnvelope): string | null {
  if (!isRecord(envelope.data)) return null;
  return typeof envelope.data.text === "string" && envelope.data.text.trim()
    ? envelope.data.text
    : null;
}

function getEnvelopeAction(envelope: PinetDispatcherEnvelope): string | null {
  if (!isRecord(envelope.data)) return null;
  return typeof envelope.data.action === "string" && envelope.data.action.trim()
    ? envelope.data.action
    : null;
}

function getPinetToolResultTitle(envelope: PinetDispatcherEnvelope | null): string {
  if (!envelope) return "[Pinet] Tool result";
  const status = envelope.status === "succeeded" ? "✓" : "✗";
  const action = getEnvelopeAction(envelope);
  return action ? `[Pinet] ${status} ${action}` : `[Pinet] ${status} result`;
}

function renderPinetToolResult(
  result: unknown,
  options: PinetToolRenderOptions,
): PinetToolResultComponent {
  const envelope = isRecord(result) ? readDispatcherEnvelope(result.details) : null;
  const fullText = getTextContent(result) || (envelope ? JSON.stringify(envelope, null, 2) : "");
  const title = getPinetToolResultTitle(envelope);

  if (options.expanded) {
    return new PinetToolResultCardComponent(`${title}\n\n${fullText}`.trimEnd());
  }

  const previewSource = envelope ? (getEnvelopeDataText(envelope) ?? fullText) : fullText;
  const preview = truncateText(
    previewSource || "(no output)",
    PINET_TOOL_RESULT_PREVIEW_MAX_LENGTH,
  );
  const lineCount = fullText.length === 0 ? 0 : fullText.split("\n").length;
  const stats =
    lineCount > 1 || fullText.length > PINET_TOOL_RESULT_PREVIEW_MAX_LENGTH
      ? ` (${lineCount} lines, ${fullText.length} chars)`
      : "";
  const partial = options.isPartial ? "Running…\n" : "";
  return new PinetToolResultCardComponent(
    `${partial}${title}${stats}\n${preview}\nCtrl+O to expand full Pinet tool result`,
  );
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

  if (message.includes("thread_id must be") || message.includes("message is required")) {
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

function getPinetEnvelopeCliText(envelope: PinetDispatcherEnvelope): string {
  if (envelope.status === "succeeded" && isRecord(envelope.data)) {
    const text = envelope.data.text;
    if (typeof text === "string" && text.length > 0) return text;
  }
  return JSON.stringify(envelope, null, 2);
}

function wrapDispatcherEnvelope(
  envelope: PinetDispatcherEnvelope,
  output: PinetOutputOptions = { format: "json", full: true },
): {
  content: Array<{ type: "text"; text: string }>;
  details: PinetDispatcherEnvelope;
} {
  return {
    content: [
      {
        type: "text",
        text:
          output.format === "json"
            ? JSON.stringify(envelope, null, 2)
            : getPinetEnvelopeCliText(envelope),
      },
    ],
    details: envelope,
  };
}

function selectPinetResultDetails(result: PinetToolResult, output: PinetOutputOptions): unknown {
  if (output.format === "json" || output.full) {
    return result.details ?? null;
  }
  if (result.compactDetails !== undefined) {
    return result.compactDetails;
  }
  return result.details ?? null;
}

function buildPinetDispatcherHelpEnvelope(
  args: Record<string, unknown>,
  actions: Map<string, PinetActionDefinition>,
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
        args_schema: definition.parameters,
        examples: PINET_DISPATCHER_EXAMPLES[definition.name] ?? [],
      }))
      .sort((a, b) => a.action.localeCompare(b.action));

    return buildPinetDispatcherEnvelope("succeeded", {
      actions: catalog,
      note: "Use args.topic to inspect a single action schema.",
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

    if (!to) {
      throw new Error("to is required");
    }
    if (!message) {
      throw new Error("message is required");
    }

    deps.requireToolPolicy(toolName, undefined, `to=${to} | message=${message}`);

    if (deps.brokerRole() === "broker" && isBroadcastChannelTarget(to)) {
      const result = deps.sendPinetBroadcastMessage(to, message);
      const preview = result.recipients.slice(0, 5).join(", ");
      const suffix = result.recipients.length > 5 ? ", …" : "";

      return {
        content: [
          {
            type: "text",
            text: output.full
              ? `Broadcast sent to ${result.channel} (${result.recipients.length} agents: ${preview}${suffix}).`
              : `Pinet broadcast sent to ${result.channel} (${result.recipients.length} recipients).`,
          },
        ],
        details: {
          channel: result.channel,
          messageIds: result.messageIds,
          recipients: result.recipients,
        },
      };
    }

    const result = await deps.sendPinetAgentMessage(to, message);
    return {
      content: [
        {
          type: "text",
          text: output.full
            ? `Message sent to ${result.target} (id: ${result.messageId}).`
            : `Pinet message sent to ${result.target}.`,
        },
      ],
      details: { messageId: result.messageId, target: result.target },
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
      throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
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
    return {
      content: [
        {
          type: "text",
          text: output.full
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
      throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
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

function buildCompactAgentDetails(
  agents: AgentDisplayInfo[],
  hint: PinetAgentsRoutingHint,
): Record<string, unknown> {
  return {
    count: agents.length,
    hint,
    agents: agents.map((agent) => {
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
        routingScore: agent.routingScore ?? null,
        capabilityTags: capabilityTags.slice(0, 4),
        capabilityCount: capabilityTags.length,
      };
    }),
  };
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
  return `Pinet agents: ${agents.length} visible${hintSuffix}.`;
}

function runPinetAgentsAction(
  params: Record<string, unknown>,
  deps: RegisterPinetToolsDeps,
  toolName: string,
  output: PinetOutputOptions,
): Promise<PinetToolResult> {
  return (async () => {
    const hint: PinetAgentsRoutingHint = {
      repo: typeof params.repo === "string" ? params.repo : undefined,
      branch: typeof params.branch === "string" ? params.branch : undefined,
      role: typeof params.role === "string" ? params.role : undefined,
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
      `repo=${hint.repo ?? ""} | branch=${hint.branch ?? ""} | role=${hint.role ?? ""} | required_tools=${params.required_tools ?? ""} | task=${hint.task ?? ""} | format=${output.format} | full=${output.full}`,
    );

    if (!deps.pinetEnabled()) {
      throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
    }

    const includeGhosts = true;
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
      rawAgents = await deps.listFollowerAgents(includeGhosts);
    } else {
      throw new Error("Pinet is in an unexpected state.");
    }

    const visibleAgents = filterAgentsForMeshVisibility(rawAgents, {
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
      ...PINET_OUTPUT_OPTION_PARAMETERS,
    }),
    execute: (_id, params, output) => runPinetAgentsAction(params, deps, "pinet:agents", output),
  });

  pi.registerTool({
    name: "pinet",
    label: "Pinet Dispatcher",
    description:
      "Dispatch Pinet worker operations by action with compact help and schema discovery.",
    promptSnippet:
      'Use this compact dispatcher for Pinet actions: send, read, free, schedule, agents, and help. Defaults to terse CLI text; pass args.format="json" or args.full=true for explicit detail.',
    parameters: Type.Object({
      action: Type.String({
        description: "Action name: help, send, read, free, schedule, or agents.",
      }),
      args: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            'Action arguments. Add format="cli"|"json" (or f/"-f") and full=true (or "--full": true) for explicit presentation control. Default cli keeps data.details compact; format="json" or full=true exposes full structured details.',
        }),
      ),
    }),
    renderResult(result: unknown, options: PinetToolRenderOptions) {
      return renderPinetToolResult(result, options);
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
          );
        }
        return wrapDispatcherEnvelope(
          buildPinetDispatcherHelpEnvelope(args, actionDefinitions),
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
        );
      }

      try {
        const result = await definition.execute(toolCallId, params.args, output);
        return wrapDispatcherEnvelope(
          buildPinetDispatcherEnvelope("succeeded", {
            action: definition.name,
            text: result.content[0]?.text ?? "",
            details: selectPinetResultDetails(result, output),
          }),
          output,
        );
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        const message = getErrorMessage(error);
        return wrapDispatcherEnvelope(
          buildPinetDispatcherEnvelope("failed", null, [classifyPinetError(message)]),
        );
      }
    },
  });
}
