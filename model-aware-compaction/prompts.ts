// Verbatim compaction prompts from the pinned Pi SDK. None of them are reachable through
// @earendil-works/pi-coding-agent's exports map, so they are copied here with per-constant
// source attribution. prompts.test.ts re-reads the installed SDK files and fails on drift;
// re-check it whenever this version anchor or the Pi peer floor moves.
export const PI_COMPACTION_PROMPT_VERSION = "0.87.1";

/** Verbatim from pi-coding-agent 0.87.1 dist/core/compaction/utils.js. */
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/** Verbatim from pi-coding-agent 0.87.1 dist/core/compaction/compaction.js. */
export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Verbatim from pi-coding-agent 0.87.1 dist/core/compaction/compaction.js. */
export const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Verbatim from pi-coding-agent 0.87.1 dist/core/compaction/compaction.js. */
export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

/** Verbatim from pi-coding-agent 0.87.1 dist/core/compaction/compaction.js. */
export const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

/** Mirrors generateSummaryWithUsage() request assembly in Pi 0.87.1 compaction.js. */
export function buildHistoryPrompt(
  serializedConversation: string,
  customInstructions?: string,
  previousSummary?: string,
): string {
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;

  let promptText = `<conversation>\n${serializedConversation}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  return promptText + basePrompt;
}

/** Mirrors generateTurnPrefixSummary() request assembly in Pi 0.87.1 compaction.js. */
export function buildTurnPrefixPrompt(serializedConversation: string): string {
  return `# Conversation\n${serializedConversation}\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
}
