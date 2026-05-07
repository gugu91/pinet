declare module "@earendil-works/pi-ai" {
  import type { TSchema } from "@sinclair/typebox";

  export function StringEnum(values: readonly string[], options?: Record<string, unknown>): TSchema;
}
