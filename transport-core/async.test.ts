import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBackoffDelay,
  createAbortError,
  createTimeoutError,
  isAbortError,
  isTimeoutError,
  sleep,
  withTimeout,
} from "./async.ts";

test("createAbortError produces an Error recognized by isAbortError", () => {
  const error = createAbortError();
  assert.equal(error.name, "AbortError");
  assert.equal(error.message, "Operation aborted");
  assert.equal(isAbortError(error), true);
});

test("createAbortError accepts a custom message", () => {
  assert.equal(createAbortError("shutdown").message, "shutdown");
});

test("isAbortError rejects non-abort values", () => {
  assert.equal(isAbortError(new Error("nope")), false);
  assert.equal(isAbortError("AbortError"), false);
  assert.equal(isAbortError(undefined), false);
});

test("sleep resolves after the delay without a signal", async () => {
  await sleep(5);
});

test("sleep rejects immediately when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sleep(60_000, { signal: controller.signal }), isAbortError);
});

test("sleep rejects with an AbortError when aborted mid-flight", async () => {
  const controller = new AbortController();
  const pending = sleep(60_000, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, isAbortError);
});

test("sleep resolves normally when the signal never aborts", async () => {
  const controller = new AbortController();
  await sleep(5, { signal: controller.signal });
});

test("createTimeoutError produces an Error recognized by isTimeoutError", () => {
  const error = createTimeoutError(250);
  assert.equal(error.name, "TimeoutError");
  assert.equal(error.message, "Timed out after 250ms");
  assert.equal(isTimeoutError(error), true);
});

test("createTimeoutError prefixes an optional label", () => {
  assert.equal(createTimeoutError(250, "Heartbeat").message, "Heartbeat timed out after 250ms");
});

test("isTimeoutError rejects non-timeout values", () => {
  assert.equal(isTimeoutError(createAbortError()), false);
  assert.equal(isTimeoutError("TimeoutError"), false);
});

test("withTimeout resolves with the wrapped value when it settles in time", async () => {
  assert.equal(await withTimeout(Promise.resolve("ok"), 1_000), "ok");
});

test("withTimeout rejects with a TimeoutError when the promise is too slow", async () => {
  const slow = new Promise<void>((resolve) => {
    setTimeout(resolve, 60_000).unref?.();
  });
  await assert.rejects(withTimeout(slow, 5), {
    name: "TimeoutError",
    message: "Timed out after 5ms",
  });
});

test("withTimeout includes the label in the timeout message", async () => {
  const slow = new Promise<void>((resolve) => {
    setTimeout(resolve, 60_000).unref?.();
  });
  await assert.rejects(withTimeout(slow, 5, "Metadata provider"), {
    name: "TimeoutError",
    message: "Metadata provider timed out after 5ms",
  });
});

test("withTimeout passes through Error rejections from the wrapped promise", async () => {
  const failure = new Error("boom");
  await assert.rejects(withTimeout(Promise.reject(failure), 1_000), (error) => error === failure);
});

test("withTimeout normalizes non-Error rejections", async () => {
  await assert.rejects(
    withTimeout(Promise.reject("boom"), 1_000),
    (error) => error instanceof Error && error.message === "boom",
  );
});

test("computeBackoffDelay grows exponentially before the cap", () => {
  const options = { initialMs: 1_000, maxMs: 30_000, jitterRatio: 0, random: 0 };
  assert.equal(computeBackoffDelay(0, options), 1_000);
  assert.equal(computeBackoffDelay(1, options), 2_000);
  assert.equal(computeBackoffDelay(2, options), 4_000);
  assert.equal(computeBackoffDelay(3, options), 8_000);
});

test("computeBackoffDelay caps at maxMs", () => {
  const options = { initialMs: 1_000, maxMs: 30_000, jitterRatio: 0, random: 0 };
  assert.equal(computeBackoffDelay(10, options), 30_000);
  assert.equal(computeBackoffDelay(50, options), 30_000);
});

test("computeBackoffDelay treats negative attempts as attempt zero", () => {
  const options = { initialMs: 1_000, maxMs: 30_000, jitterRatio: 0, random: 0 };
  assert.equal(computeBackoffDelay(-3, options), 1_000);
});

test("computeBackoffDelay applies ±25% jitter by default", () => {
  const low = computeBackoffDelay(0, { initialMs: 1_000, maxMs: 30_000, random: 0 });
  const high = computeBackoffDelay(0, { initialMs: 1_000, maxMs: 30_000, random: 0.999999 });
  assert.equal(low, 750);
  assert.ok(high <= 1_250);
  assert.ok(high >= 1_249);
  assert.equal(computeBackoffDelay(0, { initialMs: 1_000, maxMs: 30_000, random: 0.5 }), 1_000);
});

test("computeBackoffDelay honors a custom growth factor", () => {
  const options = { initialMs: 100, maxMs: 100_000, factor: 3, jitterRatio: 0, random: 0 };
  assert.equal(computeBackoffDelay(2, options), 900);
});

test("computeBackoffDelay matches the historical reconnect-delay formula", () => {
  // Parity with slack-bridge computeReconnectDelay: capped * (0.75 + random * 0.5).
  for (const attempt of [0, 1, 3, 7]) {
    for (const random of [0, 0.25, 0.5, 0.99]) {
      const capped = Math.min(1_000 * Math.pow(2, attempt), 30_000);
      assert.equal(
        computeBackoffDelay(attempt, { initialMs: 1_000, maxMs: 30_000, random }),
        Math.round(capped * (0.75 + random * 0.5)),
      );
    }
  }
});
