export const STALE_SLACK_MESSAGE_MAX_AGE_MS = 15 * 60 * 1000;
// Slack message ts values are epoch seconds. Treat tiny test/sentinel values as
// ambiguous rather than stale so only plausible Slack-origin event timestamps
// are skipped.
const MIN_PLAUSIBLE_SLACK_TIMESTAMP_SECONDS = 1_000_000_000;

export interface SlackMessageStalenessInput {
  source: string;
  timestamp: string;
}

export interface SlackMessageStalenessOptions {
  nowMs?: number;
  maxAgeMs?: number;
}

export function parseSlackTimestampMs(timestamp: string): number | null {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds < MIN_PLAUSIBLE_SLACK_TIMESTAMP_SECONDS) {
    return null;
  }
  return Math.trunc(seconds * 1000);
}

export function getSlackMessageAgeMs(
  input: SlackMessageStalenessInput,
  options: SlackMessageStalenessOptions = {},
): number | null {
  if (input.source !== "slack") {
    return null;
  }

  const timestampMs = parseSlackTimestampMs(input.timestamp);
  if (timestampMs === null) {
    return null;
  }

  return (options.nowMs ?? Date.now()) - timestampMs;
}

export function isStaleSlackMessage(
  input: SlackMessageStalenessInput,
  options: SlackMessageStalenessOptions = {},
): boolean {
  const ageMs = getSlackMessageAgeMs(input, options);
  if (ageMs === null) {
    return false;
  }

  return ageMs > (options.maxAgeMs ?? STALE_SLACK_MESSAGE_MAX_AGE_MS);
}
