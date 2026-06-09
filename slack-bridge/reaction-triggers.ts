export interface ReactionCommandTemplate {
  action: string;
  prompt: string;
}

export type ReactionCommandSetting =
  | string
  | {
      action?: string;
      prompt?: string;
    };

export type ReactionCommandSettings = Record<string, ReactionCommandSetting>;

const REACTION_ALIASES: Record<string, string> = {
  "📝": "memo",
  memo: "memo",
  "🐛": "bug",
  bug: "bug",
  "🔍": "mag",
  mag: "mag",
  mag_right: "mag_right",
  "📌": "pushpin",
  pushpin: "pushpin",
  "🌐": "globe_with_meridians",
  globe_with_meridians: "globe_with_meridians",
  "🔄": "repeat",
  repeat: "repeat",
  "👀": "eyes",
  eyes: "eyes",
  "✅": "white_check_mark",
  white_check_mark: "white_check_mark",
  "⬆️": "arrow_up",
  "⬆": "arrow_up",
  arrow_up: "arrow_up",
  "🛑": "octagonal_sign",
  octagonal_sign: "octagonal_sign",
};

const REACTION_DISPLAY: Record<string, string> = {
  memo: "📝",
  bug: "🐛",
  mag: "🔍",
  mag_right: "🔎",
  pushpin: "📌",
  globe_with_meridians: "🌐",
  repeat: "🔄",
  eyes: "👀",
  white_check_mark: "✅",
  arrow_up: "⬆️",
  octagonal_sign: "🛑",
};

export const REACTION_COMMAND_PRESETS: Record<string, ReactionCommandTemplate> = {
  memo: {
    action: "summarize",
    prompt:
      "Summarize the reacted-to message and the surrounding thread. Focus on key decisions, action items, and open questions.",
  },
  bug: {
    action: "file-issue",
    prompt:
      "Turn the reacted-to message or thread into a GitHub issue. Capture the problem, context, reproduction clues, and a sensible next step.",
  },
  eyes: {
    action: "review",
    prompt:
      "Review the referenced message, code, or work item and report what needs attention. If the context points to a PR or diff, review that artifact.",
  },
  white_check_mark: {
    action: "approve",
    prompt:
      "Evaluate whether the referenced work should be approved. If it looks good, say so clearly and note any final caveats.",
  },
  repeat: {
    action: "retry",
    prompt:
      "Retry or regenerate the requested work using the reacted message and surrounding thread as the source of truth.",
  },
  arrow_up: {
    action: "steer",
    prompt:
      "Treat the reacted-to message as steering. Read the durable message context, then prioritize it as an explicit operator instruction if it is relevant and safe.",
  },
  octagonal_sign: {
    action: "interrupt",
    prompt:
      "Interrupt the current owner process for the reacted Slack thread. Stop the active turn safely, then read the durable context before deciding whether more work is needed.",
  },
  mag: {
    action: "search",
    prompt:
      "Search the codebase for code related to the reacted message and report the most relevant files or findings.",
  },
  pushpin: {
    action: "track",
    prompt:
      "Treat the reacted message as something to preserve and track. Pin or record it in the most appropriate project artifact, such as a Slack canvas.",
  },
  globe_with_meridians: {
    action: "fetch-url",
    prompt:
      "If the reacted message contains a URL, fetch the linked page and summarize the important information for the user.",
  },
};

// Slack emoji reactions are deliberately no-op by default. Operators must opt in
// per reaction through settings.reactionCommands before any reaction can enqueue
// Pinet work, steering, reviews, or interrupt controls.
export const DEFAULT_REACTION_COMMANDS: Record<string, ReactionCommandTemplate> = {};

function normalizeReactionNameOrNull(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withoutColons = trimmed.replace(/^:+|:+$/g, "").toLowerCase();
  return (
    REACTION_ALIASES[trimmed] ??
    REACTION_ALIASES[withoutColons] ??
    (/^[a-z0-9_+-]+$/.test(withoutColons) ? withoutColons : null)
  );
}

export function normalizeReactionName(input: string): string {
  const normalized = normalizeReactionNameOrNull(input);
  if (!normalized) {
    throw new Error(
      `Unsupported reaction ${JSON.stringify(input)}. Use a Slack reaction name like "eyes" or a supported emoji such as 👀, ✅, 🔄, 📝, 🐛, ⬆️, or 🛑.`,
    );
  }
  return normalized;
}

function buildDefaultPromptForAction(action: string): string {
  switch (action) {
    case "summarize":
      return REACTION_COMMAND_PRESETS.memo.prompt;
    case "file-issue":
      return REACTION_COMMAND_PRESETS.bug.prompt;
    case "review":
      return REACTION_COMMAND_PRESETS.eyes.prompt;
    case "approve":
      return REACTION_COMMAND_PRESETS.white_check_mark.prompt;
    case "retry":
      return REACTION_COMMAND_PRESETS.repeat.prompt;
    case "steer":
      return REACTION_COMMAND_PRESETS.arrow_up.prompt;
    case "interrupt":
      return REACTION_COMMAND_PRESETS.octagonal_sign.prompt;
    case "search":
      return REACTION_COMMAND_PRESETS.mag.prompt;
    case "track":
      return REACTION_COMMAND_PRESETS.pushpin.prompt;
    case "fetch-url":
      return REACTION_COMMAND_PRESETS.globe_with_meridians.prompt;
    default:
      return `Carry out the "${action}" action for the reacted Slack message or thread, using the included context before you decide what to do.`;
  }
}

export function resolveReactionCommands(
  settings: ReactionCommandSettings | undefined,
): Map<string, ReactionCommandTemplate> {
  const resolved = new Map<string, ReactionCommandTemplate>(
    Object.entries(DEFAULT_REACTION_COMMANDS),
  );

  if (!settings) {
    return resolved;
  }

  for (const [rawReaction, config] of Object.entries(settings)) {
    const normalizedReaction = normalizeReactionNameOrNull(rawReaction);
    if (!normalizedReaction) continue;

    if (typeof config === "string") {
      resolved.set(normalizedReaction, {
        action: config,
        prompt: buildDefaultPromptForAction(config),
      });
      continue;
    }

    if (!config || typeof config !== "object") continue;

    const preset = REACTION_COMMAND_PRESETS[normalizedReaction];
    const configuredAction = config.action?.trim();
    const action =
      configuredAction ||
      resolved.get(normalizedReaction)?.action ||
      preset?.action ||
      normalizedReaction;
    const prompt =
      config.prompt?.trim() ||
      (configuredAction ? buildDefaultPromptForAction(action) : preset?.prompt) ||
      buildDefaultPromptForAction(action);
    resolved.set(normalizedReaction, { action, prompt });
  }

  return resolved;
}

export function formatReactionDisplay(reactionName: string): string {
  return `${REACTION_DISPLAY[reactionName] ?? `:${reactionName}:`} (:${reactionName}:)`;
}

export interface ReactionTriggerMessageInput {
  reactionName: string;
  command: ReactionCommandTemplate;
  reactorName: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  reactedMessageText: string;
  reactedMessageAuthor: string;
}

export function buildReactionTriggerMessage(input: ReactionTriggerMessageInput): string {
  const reactedMessageText = input.reactedMessageText.trim() || "(no text)";
  return [
    "Reaction trigger from Slack:",
    `- reaction: ${formatReactionDisplay(input.reactionName)}`,
    `- action: ${input.command.action}`,
    `- reactor: ${input.reactorName}`,
    `- channel: <#${input.channel}>`,
    `- thread_ts: ${input.threadTs}`,
    `- message_ts: ${input.messageTs}`,
    `- reacted_message_author: ${input.reactedMessageAuthor}`,
    `- reacted_message_text: ${reactedMessageText}`,
    "",
    `Requested action: ${input.command.prompt}`,
    "Treat this reaction as an explicit user request, but still verify context before acting.",
  ].join("\n");
}

export function buildReactionPromptGuidelines(): string[] {
  return [
    "Slack emoji reactions are ignored by default and should not be treated as work unless the extension has already delivered an explicit structured 'Reaction trigger from Slack:' inbox message from an authorized Pinet thread.",
    "If such an opt-in reaction-triggered request appears, treat it as an explicit user instruction tied to the referenced Slack message or thread; never infer work from a plain emoji reaction alone or from reactions in ordinary uninvoked Slack threads.",
  ];
}
