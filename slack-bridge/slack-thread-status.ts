import type { SlackCall } from "./slack-access.js";

export const SLACK_THREAD_STATUS_HEARTBEAT_MS = 90_000;

export const SLACK_THREAD_LOADING_MESSAGES = [
  "Schlepping...",
  "Combobulating...",
  "Vibing...",
  "Noodling...",
  "Percolating...",
  "Ruminating...",
  "Consulting the void...",
  "Asking the electrons...",
  "Reticulating splines...",
  "Consulting the rubber duck...",
] as const;

export const DEFAULT_SLACK_THREAD_STATUS = "is thinking…";
export const SLACK_THREAD_SAFE_STATUSES = [
  DEFAULT_SLACK_THREAD_STATUS,
  "Reading context…",
  "Calling tool…",
  "Drafting reply…",
  "Checking Slack…",
] as const;

export interface SlackThreadStatusInput {
  slack: SlackCall;
  token: string;
  channelId: string;
  threadTs: string;
  status: string;
  loadingMessages?: readonly string[];
}

export async function setSlackThreadStatus(input: SlackThreadStatusInput): Promise<void> {
  await input.slack("assistant.threads.setStatus", input.token, {
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    status: input.status,
    ...(input.status.length > 0
      ? { loading_messages: [...(input.loadingMessages ?? SLACK_THREAD_LOADING_MESSAGES)] }
      : {}),
  });
}

export interface SlackThreadStatusManagerDeps {
  slack: SlackCall;
  getBotToken: () => string;
  formatError: (error: unknown) => string;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  heartbeatMs?: number;
  logger?: Pick<Console, "error">;
  maxActiveThreads?: number;
  maxConsecutiveFailures?: number;
}

interface ActiveSlackThreadStatus {
  channelId: string;
  threadTs: string;
  status: string;
  timer: ReturnType<typeof setInterval> | null;
  heartbeatInFlight: boolean;
  consecutiveFailures: number;
}

function statusKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

export function normalizeSlackThreadStatus(status: string | undefined): string {
  const normalized = (status ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return DEFAULT_SLACK_THREAD_STATUS;
  return (
    SLACK_THREAD_SAFE_STATUSES.find((candidate) => candidate === normalized) ??
    DEFAULT_SLACK_THREAD_STATUS
  );
}

export class SlackThreadStatusManager {
  private readonly deps: Required<Pick<SlackThreadStatusManagerDeps, "formatError">> &
    SlackThreadStatusManagerDeps;
  private readonly active = new Map<string, ActiveSlackThreadStatus>();

  constructor(deps: SlackThreadStatusManagerDeps) {
    this.deps = deps;
  }

  async begin(
    channelId: string,
    threadTs: string,
    status = DEFAULT_SLACK_THREAD_STATUS,
  ): Promise<void> {
    await this.update(channelId, threadTs, status, { startHeartbeat: true });
  }

  async update(
    channelId: string,
    threadTs: string,
    status: string,
    options: { startHeartbeat?: boolean } = {},
  ): Promise<void> {
    const normalized = normalizeSlackThreadStatus(status);
    const key = statusKey(channelId, threadTs);
    let entry = this.active.get(key);
    if (!entry) {
      this.evictOldestIfNeeded();
      entry = {
        channelId,
        threadTs,
        status: normalized,
        timer: null,
        heartbeatInFlight: false,
        consecutiveFailures: 0,
      };
      this.active.set(key, entry);
    } else {
      entry.status = normalized;
    }

    if (options.startHeartbeat && !entry.timer) {
      const setIntervalFn = this.deps.setInterval ?? setInterval;
      entry.timer = setIntervalFn(() => {
        void this.heartbeat(entry!);
      }, this.deps.heartbeatMs ?? SLACK_THREAD_STATUS_HEARTBEAT_MS);
    }

    await this.trySet(entry, normalized);
  }

  async clear(channelId: string, threadTs: string): Promise<void> {
    const key = statusKey(channelId, threadTs);
    const entry = this.active.get(key);
    if (entry?.timer) {
      const clearIntervalFn = this.deps.clearInterval ?? clearInterval;
      clearIntervalFn(entry.timer);
    }
    this.active.delete(key);

    await this.trySet(
      {
        channelId,
        threadTs,
        status: "",
        timer: null,
        heartbeatInFlight: false,
        consecutiveFailures: 0,
      },
      "",
    );
  }

  async clearAll(): Promise<void> {
    const entries = [...this.active.values()];
    for (const entry of entries) {
      await this.clear(entry.channelId, entry.threadTs);
    }
  }

  private async heartbeat(entry: ActiveSlackThreadStatus): Promise<void> {
    if (entry.heartbeatInFlight) return;
    entry.heartbeatInFlight = true;
    try {
      await this.trySet(entry, entry.status);
    } finally {
      entry.heartbeatInFlight = false;
    }
  }

  private evictOldestIfNeeded(): void {
    const maxActiveThreads = this.deps.maxActiveThreads ?? 100;
    if (this.active.size < maxActiveThreads) return;
    const oldest = this.active.entries().next().value as
      | [string, ActiveSlackThreadStatus]
      | undefined;
    if (!oldest) return;
    const [key, entry] = oldest;
    if (entry.timer) {
      const clearIntervalFn = this.deps.clearInterval ?? clearInterval;
      clearIntervalFn(entry.timer);
    }
    this.active.delete(key);
  }

  private stopHeartbeat(entry: ActiveSlackThreadStatus): void {
    if (entry.timer) {
      const clearIntervalFn = this.deps.clearInterval ?? clearInterval;
      clearIntervalFn(entry.timer);
      entry.timer = null;
    }
    this.active.delete(statusKey(entry.channelId, entry.threadTs));
  }

  private async trySet(entry: ActiveSlackThreadStatus, status: string): Promise<void> {
    try {
      await setSlackThreadStatus({
        slack: this.deps.slack,
        token: this.deps.getBotToken(),
        channelId: entry.channelId,
        threadTs: entry.threadTs,
        status,
      });
      entry.consecutiveFailures = 0;
    } catch (error) {
      entry.consecutiveFailures += 1;
      (this.deps.logger ?? console).error(
        `[slack-bridge] Slack thread status update failed: ${this.deps.formatError(error)}`,
      );
      if (status && entry.consecutiveFailures >= (this.deps.maxConsecutiveFailures ?? 3)) {
        this.stopHeartbeat(entry);
      }
    }
  }
}
