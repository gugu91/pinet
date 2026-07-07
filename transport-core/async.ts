// Shared async primitives for pi transports and bridges.
//
// These are the zero-dependency building blocks that were previously
// hand-rolled per package (abortable delays, promise timeouts, jittered
// exponential backoff). Retry *drivers* stay bespoke at call sites — this
// module only owns the primitives they compose.

/** Create an Error whose name is "AbortError", matching DOM abort semantics. */
export function createAbortError(message = "Operation aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** True when the value is an Error whose name is "AbortError". */
export function isAbortError<T>(error: T): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export interface SleepOptions {
  /** Optional signal that aborts the sleep early; the promise rejects with an AbortError. */
  signal?: AbortSignal;
}

/**
 * Resolve after `ms` milliseconds. When `options.signal` is provided and
 * aborts first, the timer is cleared and the promise rejects with an
 * AbortError (also when the signal is already aborted on entry).
 */
export function sleep(ms: number, options: SleepOptions = {}): Promise<void> {
  const { signal } = options;
  if (!signal) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  const abortSignal = signal;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    }

    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Create an Error whose name is "TimeoutError". */
export function createTimeoutError(timeoutMs: number, label?: string): Error {
  const error = new Error(
    label ? `${label} timed out after ${timeoutMs}ms` : `Timed out after ${timeoutMs}ms`,
  );
  error.name = "TimeoutError";
  return error;
}

/** True when the value is an Error whose name is "TimeoutError". */
export function isTimeoutError<T>(error: T): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Reject with a TimeoutError when the promise does not settle within
 * `timeoutMs`. The guard timer is unref'd so it never keeps the process
 * alive. Non-Error rejections from the wrapped promise are normalized to
 * Error instances.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(createTimeoutError(timeoutMs, label)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface BackoffOptions {
  /** Delay for attempt 0, before capping and jitter. */
  initialMs: number;
  /** Upper bound applied before jitter. */
  maxMs: number;
  /** Exponential growth factor per attempt. Default 2. */
  factor?: number;
  /** Jitter as a ratio of the capped delay (±ratio). Default 0.25; 0 disables jitter. */
  jitterRatio?: number;
  /** Random sample in [0, 1). Injectable for deterministic tests; defaults to Math.random(). */
  random?: number;
}

/**
 * Compute a capped, jittered exponential-backoff delay for a retry attempt.
 * Attempt numbers below zero are treated as zero. With the defaults the
 * result is `min(initialMs * 2^attempt, maxMs)` scaled by a random factor
 * in [0.75, 1.25), rounded to the nearest millisecond.
 */
export function computeBackoffDelay(attempt: number, options: BackoffOptions): number {
  const factor = options.factor ?? 2;
  const jitterRatio = options.jitterRatio ?? 0.25;
  const random = options.random ?? Math.random();
  const base = options.initialMs * Math.pow(factor, Math.max(0, attempt));
  const capped = Math.min(base, options.maxMs);
  const jittered = capped * (1 - jitterRatio + random * 2 * jitterRatio);
  return Math.round(jittered);
}
