import type { InboxItem } from "./broker-client.js";

export interface TaskPromptOptions {
  agentName: string;
  workdir: string;
  isResume: boolean;
}

export function isAgentToAgentItem(item: InboxItem): boolean {
  const metadata = item.message.metadata ?? {};
  return (
    item.message.threadId.startsWith("a2a:") ||
    metadata.a2a === true ||
    metadata.scheduledWakeup === true
  );
}

export type PinetControlCommand = "exit" | "interrupt" | "reload";

/**
 * Extract a control command from an agent-to-agent inbox item. Mirrors the
 * broker convention: metadata `kind: "pinet_control"` with a `command`, or an
 * exact slash command in the body.
 */
export function extractControlCommand(item: InboxItem): PinetControlCommand | null {
  if (!isAgentToAgentItem(item)) return null;
  const metadata = item.message.metadata ?? {};
  if (metadata.scheduledWakeup === true) return null;

  const candidates: unknown[] = [
    metadata.kind === "pinet_control" ? metadata.command : null,
    /^\/(exit|interrupt|reload)\s*$/.exec(item.message.body?.trim() ?? "")?.[1],
  ];
  for (const candidate of candidates) {
    if (candidate === "exit" || candidate === "interrupt" || candidate === "reload") {
      return candidate;
    }
  }
  return null;
}

export function buildTaskPrompt(item: InboxItem, options: TaskPromptOptions): string {
  const { message } = item;
  const isA2a = isAgentToAgentItem(item);
  const scheduled = (message.metadata ?? {}).scheduledWakeup === true;

  const header = scheduled
    ? `Scheduled wake-up on thread ${message.threadId}:`
    : isA2a
      ? `Message from agent "${message.sender}" (agent-to-agent thread ${message.threadId}):`
      : `New message on thread ${message.threadId} (source: ${message.source}) from ${message.sender}:`;

  const body = message.body?.trim() || "(empty message)";

  if (options.isResume) {
    return `${header}\n\n${body}`;
  }

  const preamble = [
    `You are "${options.agentName}", a worker agent on the Pinet mesh — a broker-coordinated`,
    `multi-agent system where humans reach agents through Slack threads and agents message`,
    `each other directly. You are running as headless Claude Code.`,
    ``,
    `Operating rules:`,
    `- Your final response text is sent back verbatim to this thread via the mesh broker.`,
    `  Keep it concise and Slack-friendly (plain text or simple markdown, no giant headers).`,
    `- Do file/repo work under ${options.workdir} unless the task names another path.`,
    `- If a task is ambiguous, state your assumption and proceed rather than asking and stalling.`,
    `- Report failures honestly with the error and what you tried.`,
  ].join("\n");

  return `${preamble}\n\n${header}\n\n${body}`;
}
