import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBackoffDelay,
  createAbortError,
  createScope,
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("Scope.close aborts, waits for running work, then runs cleanups in reverse", async () => {
  const scope = createScope();
  const events: string[] = [];
  const release = deferred();
  scope.defer(() => {
    events.push("cleanup 1");
  });
  scope.defer(() => {
    events.push("cleanup 2");
  });
  const work = scope.run(async (signal) => {
    await release.promise;
    events.push(`work done, aborted=${signal.aborted}`);
  });

  const closing = scope.close();
  await sleep(5);
  assert.deepEqual(events, []);
  release.resolve();
  await closing;
  await work;
  assert.deepEqual(events, ["work done, aborted=true", "cleanup 2", "cleanup 1"]);
});

test("Scope refuses work once closed", async () => {
  const scope = createScope();
  await scope.close();
  await assert.rejects(
    scope.run(async () => undefined),
    (error) => isAbortError(error),
  );
  let ran = false;
  scope.defer(() => {
    ran = true;
  });
  await sleep(0);
  assert.equal(ran, true);
  await assert.rejects(scope.sleep(1000), (error) => isAbortError(error));
});

test("Scope.sleep rejects when the scope closes", async () => {
  const scope = createScope();
  const sleeping = scope.sleep(10_000);
  await scope.close();
  await assert.rejects(sleeping, (error) => isAbortError(error));
});

test("Scope.setInterval skips overlapping ticks and close waits for the running tick", async () => {
  const scope = createScope();
  const release = deferred();
  let started = 0;
  let finished = 0;
  scope.setInterval(async () => {
    started++;
    await release.promise;
    finished++;
  }, 2);

  await sleep(30);
  assert.equal(started, 1);
  const closing = scope.close();
  release.resolve();
  await closing;
  assert.equal(finished, 1);
  await sleep(20);
  assert.equal(started, 1);
});

test("Scope children close before the parent's cleanups", async () => {
  const parent = createScope();
  const child = parent.child();
  const events: string[] = [];
  parent.defer(() => {
    events.push("parent");
  });
  child.defer(() => {
    events.push("child");
  });
  await parent.close();
  assert.equal(child.signal.aborted, true);
  assert.deepEqual(events, ["child", "parent"]);
});

test("Scope runs every cleanup even when one throws", async () => {
  const scope = createScope();
  const child = scope.child();
  let ran = 0;
  scope.defer(() => {
    ran++;
  });
  scope.defer(() => {
    throw new Error("boom");
  });
  child.defer(() => {
    throw new Error("child boom");
  });
  await assert.rejects(scope.close(), (error) => error instanceof AggregateError);
  assert.equal(ran, 1);
});

/** Fails the test instead of hanging when `promise` never settles. */
async function within<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test("Scope.close called from its own task starts closing and runs cleanups once that task ends", async () => {
  const scope = createScope();
  const events: string[] = [];
  scope.defer(() => {
    events.push("cleanup");
  });
  await within(
    scope.run(async (signal) => {
      await scope.close();
      events.push(`task ends, aborted=${signal.aborted}`);
    }),
  );
  await within(scope.close());
  assert.deepEqual(events, ["task ends, aborted=true", "cleanup"]);
});

test("Scope.close called from a child scope's task, or work it spawned, does not hang", async () => {
  const scope = createScope();
  const child = scope.child();
  await within(
    child.run(async () => {
      // Not awaited by the task itself, as a status callback might fire it.
      await Promise.resolve().then(() => scope.close());
    }),
  );
  await within(scope.close());
});

test("a task that closes its scope after an outside close began does not hang either", async () => {
  const scope = createScope();
  void scope.run(async (signal) => {
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
    await scope.close();
  });
  await within(scope.close());
});

test("abort listeners see the scope as closed: no second shutdown, no new work", async () => {
  const scope = createScope();
  let cleanups = 0;
  scope.defer(() => {
    cleanups++;
  });
  let lateWork: Promise<void> | null = null;
  scope.signal.addEventListener("abort", () => {
    void scope.close();
    lateWork = scope.run(async () => undefined);
  });
  await scope.close();
  assert.equal(cleanups, 1);
  await assert.rejects(lateWork!, (error: Error) => isAbortError(error));
});

test("Scope.close from outside still waits for every task", async () => {
  const scope = createScope();
  let finished = false;
  void scope.run(async (signal) => {
    if (!signal.aborted) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    finished = true;
  });
  await scope.close();
  assert.equal(finished, true);
});
