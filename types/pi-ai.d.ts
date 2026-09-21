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
}
