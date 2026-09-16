declare module "@earendil-works/pi-ai" {
  import type { TSchema } from "@sinclair/typebox";

  export function StringEnum(values: readonly string[], options?: Record<string, unknown>): TSchema;

  /** Extract and join text from message content. Mirrors pi-ai's dist/utils/text signature. */
  export function contentText(
    content: string | readonly { type: string; text?: string }[],
    separator?: string,
  ): string;

  /** Time-ordered UUID used by pi-ai for provider routing IDs. */
  export function uuidv7(): string;

  export interface GoalEvaluatorModel {
    api: string;
    provider: string;
    id: string;
  }

  export interface GoalEvaluatorResponse {
    content: Array<{ type: string; text?: string }>;
    stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
    errorMessage?: string;
  }

  export function completeSimple(
    model: GoalEvaluatorModel,
    context: {
      messages: Array<{
        role: "user";
        content: Array<{ type: "text"; text: string }>;
        timestamp: number;
      }>;
    },
    options: {
      apiKey?: string;
      headers?: Record<string, string>;
      cacheRetention: "none";
      sessionId: string;
    },
  ): Promise<GoalEvaluatorResponse>;
}
