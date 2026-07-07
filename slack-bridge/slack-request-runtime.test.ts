import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackRequestRuntime, type SlackRequestBody } from "./slack-request-runtime.js";

const slackApiState = vi.hoisted(() => ({
  callSlackApi: vi.fn(),
}));

vi.mock("./slack-api.js", () => ({
  callSlackApi: slackApiState.callSlackApi,
}));

function createAbortError(message = "aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

describe("createSlackRequestRuntime", () => {
  beforeEach(() => {
    slackApiState.callSlackApi.mockReset();
  });

  it("passes top-level Slack calls through the tracked runtime signal", async () => {
    slackApiState.callSlackApi.mockResolvedValue({ ok: true, channel: { id: "C123" } });
    const runtime = createSlackRequestRuntime();

    await expect(
      runtime.slack("conversations.create", "xoxb-test", { name: "request-runtime" }),
    ).resolves.toEqual({ ok: true, channel: { id: "C123" } });

    expect(slackApiState.callSlackApi).toHaveBeenCalledWith(
      "conversations.create",
      "xoxb-test",
      { name: "request-runtime" },
      { signal: expect.any(AbortSignal) },
    );
    const options = slackApiState.callSlackApi.mock.calls[0]?.[3] as
      | { signal?: AbortSignal }
      | undefined;
    expect(options?.signal?.aborted).toBe(false);
  });

  it("aborts in-flight requests and keeps the current generation shut down until reset", async () => {
    slackApiState.callSlackApi.mockImplementation(
      async (
        _method: string,
        _token: string,
        _body?: SlackRequestBody,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise((_resolve, reject) => {
          const rejectAbort = () => reject(createAbortError());
          if (options?.signal?.aborted) {
            rejectAbort();
            return;
          }
          options?.signal?.addEventListener("abort", rejectAbort, { once: true });
        }),
    );
    const runtime = createSlackRequestRuntime();

    const pending = runtime.slack("conversations.list", "xoxb-test");
    await runtime.abortAndWait();

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "aborted" });
    await expect(runtime.slack("conversations.info", "xoxb-test")).rejects.toMatchObject({
      name: "AbortError",
      message: "Operation rejected: shutdown in progress",
    });
  });

  it("restores top-level Slack calls after reset", async () => {
    slackApiState.callSlackApi.mockResolvedValue({ ok: true, ts: "123.456" });
    const runtime = createSlackRequestRuntime();

    await runtime.abortAndWait();
    runtime.reset();

    await expect(
      runtime.slack("chat.postMessage", "xoxb-test", { channel: "C123", text: "hi" }),
    ).resolves.toEqual({ ok: true, ts: "123.456" });
    expect(slackApiState.callSlackApi).toHaveBeenCalledTimes(1);
  });
});
