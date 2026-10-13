export interface GoalProgressMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }>;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    totalTokens?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

const MAX_PROGRESS_MESSAGES = 40;
const MAX_PROGRESS_CHARACTERS = 40_000;

export function countGoalProgressTokens(messages: GoalProgressMessage[]): number {
  return messages.reduce((total, message) => {
    if (!message.usage) return total;
    if (Number.isFinite(message.usage.totalTokens)) return total + (message.usage.totalTokens ?? 0);
    return (
      total +
      (message.usage.input ?? 0) +
      (message.usage.output ?? 0) +
      (message.usage.cacheRead ?? 0) +
      (message.usage.cacheWrite ?? 0)
    );
  }, 0);
}

export function formatGoalProgress(messages: GoalProgressMessage[]): string {
  const text = messages
    .slice(-MAX_PROGRESS_MESSAGES)
    .map((message) => {
      const content =
        typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .filter(
                (part): part is { type: "text"; text: string } =>
                  part.type === "text" && typeof part.text === "string",
              )
              .map((part) => part.text)
              .join("\n");
      const label = message.toolName
        ? `${message.role}:${message.toolName}${message.isError ? ":error" : ""}`
        : message.role;
      return content ? `[${label}]\n${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return text.length > MAX_PROGRESS_CHARACTERS ? text.slice(-MAX_PROGRESS_CHARACTERS) : text;
}
