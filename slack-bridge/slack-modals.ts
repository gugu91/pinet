export type SlackModalView = Record<string, unknown>;

const PI_SLACK_MODAL_CONTEXT_KEY = "__piSlackModalContext";

function isSlackModalObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function normalizeSlackModalViewInput(view: unknown): SlackModalView {
  if (!isSlackModalObject(view)) {
    throw new Error("Slack modal view must be a JSON object.");
  }
  const cloned = structuredClone(view) as SlackModalView;
  if ((cloned.type as string | undefined) !== "modal") {
    throw new Error('Slack modal view.type must be "modal".');
  }
  return cloned;
}

export interface SlackModalThreadContext {
  threadTs: string;
  channel: string;
}

export interface DecodedSlackModalPrivateMetadata {
  raw: string | null;
  value: unknown;
  threadContext: SlackModalThreadContext | null;
}

export function encodeSlackModalPrivateMetadata(
  privateMetadata: string | undefined,
  threadContext: SlackModalThreadContext | null,
): string | undefined {
  if (!threadContext) {
    return privateMetadata;
  }

  const raw = privateMetadata?.trim();
  let value: unknown = raw ?? null;
  if (raw) {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      value = raw;
    }
  }

  if (isSlackModalObject(value)) {
    return JSON.stringify({
      ...value,
      [PI_SLACK_MODAL_CONTEXT_KEY]: threadContext,
    });
  }

  return JSON.stringify({
    [PI_SLACK_MODAL_CONTEXT_KEY]: threadContext,
    value,
  });
}

export function decodeSlackModalPrivateMetadata(
  privateMetadata: string | undefined,
): DecodedSlackModalPrivateMetadata {
  const raw = asOptionalString(privateMetadata);
  if (!raw) {
    return { raw, value: null, threadContext: null };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isSlackModalObject(parsed)) {
      const context = parsed[PI_SLACK_MODAL_CONTEXT_KEY];
      const threadContext = isSlackModalObject(context)
        ? {
            threadTs: asString(context.threadTs) ?? "",
            channel: asString(context.channel) ?? "",
          }
        : null;
      const normalizedContext =
        threadContext && threadContext.threadTs && threadContext.channel ? threadContext : null;

      if (PI_SLACK_MODAL_CONTEXT_KEY in parsed) {
        const clone = { ...parsed };
        delete clone[PI_SLACK_MODAL_CONTEXT_KEY];
        const userValue = Object.keys(clone).length === 1 && "value" in clone ? clone.value : clone;
        return {
          raw,
          value: userValue,
          threadContext: normalizedContext,
        };
      }

      return { raw, value: parsed, threadContext: normalizedContext };
    }

    return { raw, value: parsed, threadContext: null };
  } catch {
    return { raw, value: raw, threadContext: null };
  }
}
