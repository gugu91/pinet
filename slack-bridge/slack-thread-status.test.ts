import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SLACK_THREAD_STATUS,
  setSlackThreadStatus,
  SlackThreadStatusManager,
  SLACK_THREAD_LOADING_MESSAGES,
} from "./slack-thread-status.js";
import type { SlackCall } from "./slack-access.js";

describe("setSlackThreadStatus", () => {
  it("sets status with controlled whimsical loading copy", async () => {
    const slack = vi.fn(async () => ({}));

    await setSlackThreadStatus({
      slack,
      token: "xoxb-test",
      channelId: "C123",
      threadTs: "123.456",
      status: DEFAULT_SLACK_THREAD_STATUS,
    });

    expect(slack).toHaveBeenCalledWith("assistant.threads.setStatus", "xoxb-test", {
      channel_id: "C123",
      thread_ts: "123.456",
      status: DEFAULT_SLACK_THREAD_STATUS,
      loading_messages: [...SLACK_THREAD_LOADING_MESSAGES],
    });
  });

  it("clears status without loading messages", async () => {
    const slack = vi.fn(async () => ({}));

    await setSlackThreadStatus({
      slack,
      token: "xoxb-test",
      channelId: "C123",
      threadTs: "123.456",
      status: "",
    });

    expect(slack).toHaveBeenCalledWith("assistant.threads.setStatus", "xoxb-test", {
      channel_id: "C123",
      thread_ts: "123.456",
      status: "",
    });
  });
});

describe("SlackThreadStatusManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("heartbeats latest status without overlapping refreshes", async () => {
    let resolveSecondCall: (() => void) | undefined;
    const slack: SlackCall = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockImplementationOnce(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            resolveSecondCall = () => resolve({});
          }),
      )
      .mockResolvedValue({});
    const manager = new SlackThreadStatusManager({
      slack,
      getBotToken: () => "xoxb-test",
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
      heartbeatMs: 90_000,
    });

    await manager.begin("C123", "123.456", "Reading context…");
    await vi.advanceTimersByTimeAsync(90_000);
    await vi.advanceTimersByTimeAsync(90_000);

    expect(slack).toHaveBeenCalledTimes(2);
    expect(slack).toHaveBeenLastCalledWith("assistant.threads.setStatus", "xoxb-test", {
      channel_id: "C123",
      thread_ts: "123.456",
      status: "Reading context…",
      loading_messages: [...SLACK_THREAD_LOADING_MESSAGES],
    });

    resolveSecondCall?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(slack).toHaveBeenCalledTimes(3);
  });

  it("logs status failures instead of throwing", async () => {
    const logger = { error: vi.fn() };
    const manager = new SlackThreadStatusManager({
      slack: vi.fn(async () => {
        throw new Error("rate_limited");
      }),
      getBotToken: () => "xoxb-test",
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
      logger,
    });

    await expect(manager.begin("C123", "123.456")).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "[slack-bridge] Slack thread status update failed: rate_limited",
    );
  });
});
