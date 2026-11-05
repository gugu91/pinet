import { AsyncLocalStorage } from "node:async_hooks";

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

/**
 * Owns async work, timers and cleanups. `close()` aborts `signal`, closes
 * child scopes, waits for every task started with `run` (including interval
 * ticks), then runs cleanups in reverse order. A closed scope refuses new
 * work, so a late callback cannot start something nothing will stop.
 */
export interface Scope {
  readonly signal: AbortSignal;
  /**
   * Register a cleanup. Runs immediately if the scope is already closed.
   * Cleanups run after tasks finish, so work a task waits on must end on
   * `signal`, not here.
   */
  defer(cleanup: () => void | Promise<void>): void;
  /**
   * Track `work` so `close()` waits for it. Rejects with an AbortError once
   * closed.
   */
  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Repeat `tick` every `ms`, skipping a tick while the previous one is still running. */
  setInterval(tick: () => void | Promise<void>, ms: number): void;
  /** Like `sleep`, aborted when the scope closes. */
  sleep(ms: number): Promise<void>;
  /** A scope closed with (and before) this one. */
  child(): Scope;
  /**
   * Abort, close children, wait for tasks, then run cleanups in reverse.
   * Called from this scope's own work (or a child's), it only starts closing
   * and resolves at once: that work must end before cleanups can run.
   */
  close(): Promise<void>;
}

/** The scopes, with their ancestors, whose tasks the current code runs inside. */
const enclosingScopes = new AsyncLocalStorage<ReadonlySet<Scope>>();

export function createScope(): Scope {
  return openScope([]);
}

function openScope(ancestors: readonly Scope[]): Scope {
  const controller = new AbortController();
  const tasks = new Set<Promise<void>>();
  const children = new Set<Scope>();
  const cleanups: Array<() => void | Promise<void>> = [];
  let closing: Promise<void> | null = null;

  const scope: Scope = {
    signal: controller.signal,
    defer(cleanup) {
      if (closing) {
        void Promise.resolve().then(cleanup);
        return;
      }
      cleanups.push(cleanup);
    },
    run(work) {
      if (closing) return Promise.reject(createAbortError("Scope closed"));
      const inside = new Set(enclosingScopes.getStore());
      for (const owner of [...ancestors, scope]) inside.add(owner);
      const result = Promise.resolve().then(() =>
        enclosingScopes.run(inside, () => work(controller.signal)),
      );
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      tasks.add(settled);
      void settled.then(() => tasks.delete(settled));
      return result;
    },
    setInterval(tick, ms) {
      let running = false;
      const timer = setInterval(() => {
        if (running || closing) return;
        running = true;
        scope
          .run(async () => {
            await tick();
          })
          .catch((error) => {
            if (isAbortError(error)) return;
            console.error(
              `[scope] interval tick failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => {
            running = false;
          });
      }, ms);
      timer.unref();
      scope.defer(() => clearInterval(timer));
    },
    sleep(ms) {
      return sleep(ms, { signal: controller.signal });
    },
    child() {
      const child = openScope([...ancestors, scope]);
      if (closing) {
        void child.close();
        return child;
      }
      children.add(child);
      child.defer(() => {
        children.delete(child);
      });
      return child;
    },
    close() {
      if (!closing) {
        // Set before aborting, so abort listeners see the scope as closing.
        let finish!: { resolve: () => void; reject: (error: Error) => void };
        closing = new Promise<void>((resolve, reject) => {
          finish = { resolve, reject };
        });
        controller.abort(createAbortError("Scope closed"));
        void (async () => {
          const errors: Error[] = [];
          for (const result of await Promise.allSettled([...children].map((c) => c.close()))) {
            if (result.status === "rejected") errors.push(result.reason);
          }
          // No task can start once closing, so this set only shrinks.
          await Promise.all(tasks);
          for (const cleanup of cleanups.reverse()) {
            try {
              await cleanup();
            } catch (error) {
              errors.push(error instanceof Error ? error : new Error(String(error)));
            }
          }
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) throw new AggregateError(errors, "Scope cleanup failed");
        })().then(finish.resolve, finish.reject);
      }
      if (!enclosingScopes.getStore()?.has(scope)) return closing;
      // Called from this scope's own work, which shutdown waits for: waiting
      // here would never end, so only start it.
      closing.catch((error) => {
        console.error(
          `[scope] cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return Promise.resolve();
    },
  };
  return scope;
}
