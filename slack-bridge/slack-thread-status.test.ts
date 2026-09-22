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

  it("serializes a newer generation after an older delayed clear", async () => {
    let remoteStatus = "";
    let releaseClear: (() => void) | undefined;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    let reportClearStarted: (() => void) | undefined;
    const clearStarted = new Promise<void>((resolve) => {
      reportClearStarted = resolve;
    });
    const slack = vi.fn(async (_method: string, _token: string, body?: Record<string, unknown>) => {
      const status = typeof body?.status === "string" ? body.status : "";
      if (!status) {
        reportClearStarted?.();
        await clearGate;
      }
      remoteStatus = status;
      return {};
    });
    const manager = new SlackThreadStatusManager({
      slack,
      getBotToken: () => "xoxb-test",
      formatError: String,
    });

    await manager.begin("C123", "123.456", "is thinking…");
    const clearing = manager.clear("C123", "123.456");
    await clearStarted;

    const restarting = manager.begin("C123", "123.456", "Reading context…");
    await Promise.resolve();
    expect(slack).toHaveBeenCalledTimes(2);

    releaseClear?.();
    await Promise.all([clearing, restarting]);

    expect(slack.mock.calls.map(([, , body]) => body?.status)).toEqual([
      "is thinking…",
      "",
      "Reading context…",
    ]);
    expect(remoteStatus).toBe("Reading context…");
  });

  it("skips a queued clear after a newer generation begins", async () => {
    let releaseUpdate: (() => void) | undefined;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let reportUpdateStarted: (() => void) | undefined;
    const updateStarted = new Promise<void>((resolve) => {
      reportUpdateStarted = resolve;
    });
    let remoteStatus = "";
    const slack = vi.fn(async (_method: string, _token: string, body?: Record<string, unknown>) => {
      const status = typeof body?.status === "string" ? body.status : "";
      if (status === "Calling tool…") {
        reportUpdateStarted?.();
        await updateGate;
      }
      remoteStatus = status;
      return {};
    });
    const manager = new SlackThreadStatusManager({
      slack,
      getBotToken: () => "xoxb-test",
      formatError: String,
    });

    await manager.begin("C123", "123.456", "is thinking…");
    const updating = manager.update("C123", "123.456", "Calling tool…");
    await updateStarted;
    const clearing = manager.clear("C123", "123.456");
    const restarting = manager.begin("C123", "123.456", "Reading context…");

    releaseUpdate?.();
    await Promise.all([updating, clearing, restarting]);

    expect(slack.mock.calls.map(([, , body]) => body?.status)).toEqual([
      "is thinking…",
      "Calling tool…",
      "Reading context…",
    ]);
    expect(remoteStatus).toBe("Reading context…");
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
